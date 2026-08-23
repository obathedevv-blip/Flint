import { config } from "./config.js";
import { BaileysAdapter } from "./whatsapp/baileys-adapter.js";
import type { WhatsAppAdapter } from "./whatsapp/types.js";
import { runAgentTurn, runProactiveTurn } from "./llm/agent.js";
import {
  getUser,
  upsertUser,
  anyUserExists,
  getAdmins,
  getPendingUsers,
  findUserByPhone,
} from "./memory/store.js";
import { transcribeAudio } from "./voice/stt.js";
import { synthesizeSpeech } from "./voice/tts.js";
import { startScheduler } from "./scheduler/index.js";

/** Resolves a command argument to a pending user, accepting either a phone number or a 1-based index from the last /pending list. */
function resolvePendingTarget(arg: string) {
  const digits = arg.replace(/\D/g, "");
  if (/^\d{1,2}$/.test(arg.trim())) {
    const index = Number(arg.trim()) - 1;
    const pending = getPendingUsers();
    if (index >= 0 && index < pending.length) return pending[index];
  }
  return digits ? findUserByPhone(digits) : undefined;
}

async function handleAdminCommand(adapter: WhatsAppAdapter, adminJid: string, text: string): Promise<void> {
  const [cmd, argRaw] = text.trim().split(/\s+/, 2);
  const arg = argRaw ?? "";

  if (cmd === "/pending") {
    const pending = getPendingUsers();
    const reply =
      pending.length === 0
        ? "No pending requests."
        : pending
            .map((u, i) => `${i + 1}. ${u.name ?? "(no name given yet)"} (${u.jid.split("@")[0]})`)
            .join("\n") + "\n\nReply /approve <number or index> or /deny <number or index>, e.g. \"/approve 1\".";
    await adapter.sendMessage(adminJid, reply);
    return;
  }

  if (cmd === "/approve") {
    const target = resolvePendingTarget(arg);
    if (!target) {
      await adapter.sendMessage(adminJid, `No pending request matching "${arg}". Try /pending to see the list.`);
      return;
    }
    const approved = upsertUser(target.jid, { approved: true });
    await adapter.sendMessage(adminJid, `Approved ${target.jid.split("@")[0]}.`);
    const welcome = await runProactiveTurn(
      approved,
      "They've just been approved by the admin to use you. Send a short, warm welcome message and kick off onboarding by asking their name."
    );
    await adapter.sendMessage(target.jid, welcome);
    return;
  }

  if (cmd === "/deny") {
    const target = resolvePendingTarget(arg);
    if (!target) {
      await adapter.sendMessage(adminJid, `No pending request matching "${arg}". Try /pending to see the list.`);
      return;
    }
    upsertUser(target.jid, { denied: true });
    await adapter.sendMessage(adminJid, `Denied ${target.jid.split("@")[0]}.`);
    return;
  }

  await adapter.sendMessage(adminJid, "Unknown command. Try /pending, /approve <number or index>, /deny <number or index>.");
}

async function main() {
  const adapter = new BaileysAdapter(config.authDir);

  adapter.onMessage(async (msg) => {
    let user: ReturnType<typeof getUser>;
    try {
      const phoneDigits = msg.jid.split("@")[0];
      user = getUser(msg.jid);

      if (!user) {
        if (!anyUserExists()) {
          user = upsertUser(msg.jid, { approved: true, isAdmin: true, assistantName: config.defaultAssistantName });
          console.log(`Bootstrapped admin: ${msg.jid}`);
        } else {
          user = upsertUser(msg.jid, { assistantName: config.defaultAssistantName });
          console.log(`New access request: ${msg.jid}, asking for their name`);
          await adapter.sendMessage(msg.jid, "Hey! Before I can let you in, my admin needs to know who's asking. What's your name?");
          return;
        }
      }

      if (user.denied) {
        await adapter.sendMessage(msg.jid, "You don't currently have access to this assistant.");
        return;
      }

      if (!user.approved) {
        if (!user.name && msg.text) {
          const name = msg.text.trim().slice(0, 100);
          user = upsertUser(msg.jid, { name });
          for (const admin of getAdmins()) {
            await adapter.sendMessage(admin.jid, `New access request from ${name} (${phoneDigits}).\nApprove: /approve ${phoneDigits}\nDeny: /deny ${phoneDigits}`);
          }
          await adapter.sendMessage(msg.jid, `Thanks, ${name}! I've let my admin know, hang tight.`);
        } else {
          await adapter.sendMessage(msg.jid, "Still waiting on my admin to approve you, hang tight!");
        }
        return;
      }

      if (user.isAdmin && msg.text?.startsWith("/")) {
        await handleAdminCommand(adapter, msg.jid, msg.text);
        return;
      }

      let text = msg.text;
      const isVoiceInput = !!msg.audio;

      if (msg.audio) {
        if (!config.groqApiKey) {
          await adapter.sendMessage(msg.jid, "Got your voice note, but voice transcription isn't set up yet. Text me for now?");
          return;
        }
        text = await transcribeAudio(msg.audio);
        if (!text) {
          await adapter.sendMessage(msg.jid, "Couldn't make out anything in that voice note, try again?");
          return;
        }
      }

      if (!text) return;

      await adapter.setPresence(msg.jid, isVoiceInput ? "recording" : "composing");

      const reply = await runAgentTurn(user, text);

      if (isVoiceInput) {
        try {
          const voiceNote = await synthesizeSpeech(reply);
          await adapter.sendVoiceNote(msg.jid, voiceNote);
          return;
        } catch (err) {
          console.error("TTS failed, falling back to text:", err);
        }
      }

      await adapter.sendMessage(msg.jid, reply);
    } catch (err) {
      console.error("Error handling message:", err);
      const fallback = user?.isAdmin
        ? "Something broke on my end, check the logs."
        : "Having trouble reaching my brain right now, try again in a bit.";
      await adapter.sendMessage(msg.jid, fallback).catch(() => {});
    }
  });

  await adapter.connect();
  startScheduler(adapter);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
