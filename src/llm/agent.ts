import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chatCompletion, type ChatMessage, type ContentPart } from "./openrouter.js";
import { toolSpecs, runTool } from "./tools.js";
import {
  getFacts,
  getSummary,
  getRecentMessages,
  getOpenTasks,
  addMessage,
  recordUsage,
  getTodayCostUsd,
} from "../memory/store.js";
import type { User } from "../memory/store.js";
import { config } from "../config.js";
import { extractFirstUrl } from "../utils/url.js";
import { captureScreenshots } from "../vision/screenshot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSONALITY_PATH = path.join(__dirname, "..", "personality", "system-prompt.md");
const personalityPrompt = fs.readFileSync(PERSONALITY_PATH, "utf-8");

const MAX_TOOL_ROUNDS = 4;

function buildSystemPrompt(user: User): string {
  const facts = getFacts(user.jid);
  const summary = getSummary(user.jid);
  const tasks = getOpenTasks(user.jid);

  const parts = [personalityPrompt];

  if (!user.onboarded) {
    parts.push(
      `\n## Onboarding\nThis is a new user you haven't met yet. Your only job right now is a short, warm, natural conversation to learn: their name, what they'd like to be called (a nickname is fine, or just their name again), and their IANA timezone (ask what city they're in and infer it, or ask directly if unsure). Don't interrogate them with a rigid form, one or two questions at a time is fine. Once you have all three, call the complete_onboarding tool. Stay warm and welcoming, save the roast mode for later once you actually know them.`
    );
    return parts.join("\n");
  }

  parts.push(
    `\n## Your identity\nYour name is ${user.assistantName ?? "unset, pick something and call the set_assistant_name tool"}. If they ask to rename you, use the set_assistant_name tool, don't just agree in words.`
  );

  parts.push(
    `\n## Right now\nCurrent UTC date/time: ${new Date().toISOString()}. Use this plus their timezone to compute exact times for reminders.`
  );

  parts.push(
    `\n## Who you're talking to\nName: ${user.name ?? "unknown"}\nPreferred nickname: ${user.nickname ?? "none set yet"}\nTimezone: ${user.timezone ?? "unknown, ask if you need it for a reminder or brief"}\nMorning brief fires at: ${user.morningBriefTime} local\nEvening check-in fires at: ${user.eveningCheckinTime} local\n(use set_daily_schedule if they want either changed)`
  );

  if (user.personaNote) {
    parts.push(
      `\n## How this specific user wants you to relate to them\n${user.personaNote}\nThis is unique to them, nobody else gets this. Blend it into your voice naturally. You can update it anytime with set_relationship_style if they ask for something different. Still be honest if directly asked whether you're an AI, that doesn't have to break the warmth.`
    );
  }

  if (summary) {
    parts.push(`\n## Running summary of your history together\n${summary}`);
  }

  if (facts.length > 0) {
    parts.push(
      `\n## Known facts about them\n${facts.map((f) => `- ${f.key}: ${f.value}`).join("\n")}`
    );
  }

  if (tasks.length > 0) {
    parts.push(
      `\n## Open tasks/reminders\n${tasks
        .map((t) => `- [#${t.id}] ${t.description}${t.remindAt ? ` (reminder at ${new Date(t.remindAt * 1000).toISOString()})` : ""}`)
        .join("\n")}`
    );
  }

  return parts.join("\n");
}

/** Runs the LLM + tool-calling loop against a fixed message list, records token usage/cost per call, and returns the final text. */
async function converse(messages: ChatMessage[], jid: string): Promise<string> {
  let finalText = "";
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { message, usage } = await chatCompletion(messages, toolSpecs);

    if (usage) {
      recordUsage(jid, usage.prompt_tokens, usage.completion_tokens, usage.cost ?? 0);
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      messages.push(message);
      for (const call of message.tool_calls) {
        let args: Record<string, any> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          // leave args empty if the model produced malformed JSON
        }
        const result = runTool(call.function.name, args, { jid });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: result,
        });
      }
      continue;
    }

    finalText = typeof message.content === "string" ? message.content : "";
    break;
  }

  return finalText || "Sorry, I lost my train of thought there, try that again?";
}

/**
 * Runs one full turn in reply to something the user said: builds context,
 * calls the LLM, executes any tool calls, persists the exchange, and returns
 * the assistant's final text reply. Non-admins are blocked once they hit
 * their daily cost cap, without spending any tokens on that turn.
 */
export async function runAgentTurn(user: User, userText: string): Promise<string> {
  addMessage(user.jid, "user", userText);

  if (!user.isAdmin && getTodayCostUsd(user.jid) >= config.dailyCostCapUsd) {
    const reply = "You've hit today's usage limit, come back tomorrow!";
    addMessage(user.jid, "assistant", reply);
    return reply;
  }

  const systemPrompt = buildSystemPrompt(user);
  const history = getRecentMessages(user.jid);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m): ChatMessage => ({ role: m.role, content: m.content })),
  ];

  const url = extractFirstUrl(userText);
  if (url) {
    const lastMessage = messages[messages.length - 1];
    try {
      const shots = await captureScreenshots(url);
      const toImagePart = (buf: Buffer): ContentPart => ({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${buf.toString("base64")}` },
      });

      const content: ContentPart[] = [
        { type: "text", text: userText },
        { type: "text", text: "Screenshot 1, right after initial page load:" },
        toImagePart(shots.initial),
        { type: "text", text: "Screenshot 2, ~20s later once slower content/animations had time to settle:" },
        toImagePart(shots.settled),
      ];
      if (shots.afterNavigation) {
        content.push(
          { type: "text", text: "Screenshot 3, after clicking into one of the site's nav/menu links:" },
          toImagePart(shots.afterNavigation)
        );
      }
      lastMessage.content = content;
    } catch (err) {
      console.error("Screenshot capture failed:", err);
      lastMessage.content = `${userText}\n\n[System note: the screenshot tool failed on our infrastructure, not the user's device or anything they did. Don't guess at or invent a technical reason. Just say you couldn't see the link this time, it's on your end, and ask if they want to retry later or just paste text/describe it instead.]`;
    }
  }

  const finalText = await converse(messages, user.jid);

  addMessage(user.jid, "assistant", finalText);
  return finalText;
}

/**
 * Runs a turn the assistant initiates on its own (morning brief, evening
 * check-in, a reminder firing), not in reply to a user message. Only the
 * resulting assistant message is persisted, there's no user turn to log.
 */
export async function runProactiveTurn(user: User, instruction: string): Promise<string> {
  const systemPrompt = buildSystemPrompt(user);
  const history = getRecentMessages(user.jid);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m): ChatMessage => ({ role: m.role, content: m.content })),
    { role: "user", content: `[System trigger, not sent by the user: ${instruction}]` },
  ];

  const finalText = await converse(messages, user.jid);

  addMessage(user.jid, "assistant", finalText);
  return finalText;
}
