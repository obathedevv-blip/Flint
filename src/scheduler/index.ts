import cron from "node-cron";
import type { WhatsAppAdapter } from "../whatsapp/types.js";
import { runProactiveTurn } from "../llm/agent.js";
import { getApprovedUsers, getDueTasks, markTaskReminded, upsertUser } from "../memory/store.js";

function localParts(date: Date, timeZone: string): { hhmm: string; dateStr: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { hhmm: `${parts.hour}:${parts.minute}`, dateStr: `${parts.year}-${parts.month}-${parts.day}` };
}

async function tick(adapter: WhatsAppAdapter): Promise<void> {
  const now = new Date();
  const nowUnix = Math.floor(now.getTime() / 1000);

  for (const user of getApprovedUsers()) {
    try {
      // Due reminders fire regardless of timezone knowledge, they're already an absolute UTC timestamp.
      const due = getDueTasks(user.jid, nowUnix);
      for (const task of due) {
        const reply = await runProactiveTurn(user, `Time to remind them about: "${task.description}". Send a short, natural nudge in your voice.`);
        await adapter.sendMessage(user.jid, reply);
        markTaskReminded(task.id);
      }

      if (!user.timezone) continue;
      const { hhmm, dateStr } = localParts(now, user.timezone);

      if (hhmm === user.morningBriefTime && user.lastMorningBriefDate !== dateStr) {
        const reply = await runProactiveTurn(
          user,
          "It's time for their scheduled morning brief. Greet them, mention anything relevant from memory or open tasks, and set a good tone for the day. Keep it short."
        );
        await adapter.sendMessage(user.jid, reply);
        upsertUser(user.jid, { lastMorningBriefDate: dateStr });
      }

      if (hhmm === user.eveningCheckinTime && user.lastEveningCheckinDate !== dateStr) {
        const reply = await runProactiveTurn(
          user,
          "It's time for their scheduled evening check-in. Ask how the day went, or note anything they were supposed to get done today. Keep it short."
        );
        await adapter.sendMessage(user.jid, reply);
        upsertUser(user.jid, { lastEveningCheckinDate: dateStr });
      }
    } catch (err) {
      console.error(`Scheduler error for ${user.jid}:`, err);
    }
  }
}

export function startScheduler(adapter: WhatsAppAdapter): void {
  cron.schedule("* * * * *", () => {
    void tick(adapter);
  });
  console.log("Scheduler started (checks every minute for reminders, morning briefs, evening check-ins).");
}
