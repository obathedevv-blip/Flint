import type { ToolSpec } from "./openrouter.js";
import { setFact, deleteFact, upsertUser, createTask, completeTaskByDescription } from "../memory/store.js";

export interface ToolContext {
  jid: string;
}

export interface ToolDefinition {
  spec: ToolSpec;
  handler: (args: Record<string, any>, ctx: ToolContext) => string;
}

const remember: ToolDefinition = {
  spec: {
    type: "function",
    function: {
      name: "remember_fact",
      description:
        "Save a durable fact about the user for future conversations (a preference, ongoing project, recurring context, inside joke, etc). Overwrites any existing fact with the same key.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Short identifier for the fact, e.g. 'favorite_coffee_order'" },
          value: { type: "string", description: "The fact itself, in plain language" },
        },
        required: ["key", "value"],
      },
    },
  },
  handler: (args, ctx) => {
    setFact(ctx.jid, String(args.key), String(args.value));
    return `Saved.`;
  },
};

const forget: ToolDefinition = {
  spec: {
    type: "function",
    function: {
      name: "forget_fact",
      description: "Delete a previously saved fact about the user, e.g. because it's no longer true.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "The key of the fact to delete" },
        },
        required: ["key"],
      },
    },
  },
  handler: (args, ctx) => {
    deleteFact(ctx.jid, String(args.key));
    return `Forgotten.`;
  },
};

const setAssistantName: ToolDefinition = {
  spec: {
    type: "function",
    function: {
      name: "set_assistant_name",
      description: "Change what you (the assistant) are called for this user. Use this when they ask to rename you or give you a nickname for yourself.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The new name to go by" },
        },
        required: ["name"],
      },
    },
  },
  handler: (args, ctx) => {
    upsertUser(ctx.jid, { assistantName: String(args.name) });
    return `Now going by ${args.name}.`;
  },
};

const createReminder: ToolDefinition = {
  spec: {
    type: "function",
    function: {
      name: "create_reminder",
      description:
        "Create a reminder that will proactively message the user at a specific future time. Use this whenever they ask to be reminded/pinged/nudged about something at a given time. Compute the exact UTC timestamp yourself from the current date/time and their timezone given in your system prompt.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "What to remind them about, e.g. '7pm meeting'" },
          remind_at_iso: { type: "string", description: "ISO 8601 UTC timestamp, e.g. '2026-08-23T18:00:00Z'" },
        },
        required: ["description", "remind_at_iso"],
      },
    },
  },
  handler: (args, ctx) => {
    const timestamp = new Date(String(args.remind_at_iso)).getTime();
    if (Number.isNaN(timestamp)) {
      return `Invalid remind_at_iso: "${args.remind_at_iso}". Retry with a valid ISO 8601 timestamp.`;
    }
    if (timestamp <= Date.now()) {
      return `That time is in the past. Double check the date/time math and retry.`;
    }
    createTask(ctx.jid, String(args.description), Math.floor(timestamp / 1000));
    return `Reminder set.`;
  },
};

const completeTask: ToolDefinition = {
  spec: {
    type: "function",
    function: {
      name: "complete_task",
      description: "Mark an open task/reminder as done, e.g. because the user said they finished it or it no longer applies.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "Text that identifies which task, matched against its description" },
        },
        required: ["description"],
      },
    },
  },
  handler: (args, ctx) => {
    const found = completeTaskByDescription(ctx.jid, String(args.description));
    return found ? "Marked done." : "Couldn't find an open task matching that description.";
  },
};

const setTimezone: ToolDefinition = {
  spec: {
    type: "function",
    function: {
      name: "set_timezone",
      description: "Set the user's IANA timezone (e.g. 'Africa/Lagos', 'America/New_York'). Use this as soon as you learn where they're based, it's required for reminders and daily briefs to fire at the right local time.",
      parameters: {
        type: "object",
        properties: {
          timezone: { type: "string", description: "IANA timezone name" },
        },
        required: ["timezone"],
      },
    },
  },
  handler: (args, ctx) => {
    const tz = String(args.timezone);
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: tz });
    } catch {
      return `"${tz}" isn't a valid IANA timezone name. Retry with the correct one, e.g. "Africa/Lagos".`;
    }
    upsertUser(ctx.jid, { timezone: tz });
    return `Timezone set to ${tz}.`;
  },
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const setDailySchedule: ToolDefinition = {
  spec: {
    type: "function",
    function: {
      name: "set_daily_schedule",
      description: "Change what local time the morning brief and/or evening check-in fire at. Only pass the one(s) they want changed.",
      parameters: {
        type: "object",
        properties: {
          morning_brief_time: { type: "string", description: "24h HH:MM in their local timezone, e.g. '07:30'" },
          evening_checkin_time: { type: "string", description: "24h HH:MM in their local timezone, e.g. '21:30'" },
        },
      },
    },
  },
  handler: (args, ctx) => {
    const fields: { morningBriefTime?: string; eveningCheckinTime?: string } = {};
    if (args.morning_brief_time !== undefined) {
      if (!HHMM.test(String(args.morning_brief_time))) return `Invalid morning_brief_time, use 24h HH:MM.`;
      fields.morningBriefTime = String(args.morning_brief_time);
    }
    if (args.evening_checkin_time !== undefined) {
      if (!HHMM.test(String(args.evening_checkin_time))) return `Invalid evening_checkin_time, use 24h HH:MM.`;
      fields.eveningCheckinTime = String(args.evening_checkin_time);
    }
    if (Object.keys(fields).length === 0) return `Nothing to update.`;
    upsertUser(ctx.jid, fields);
    return `Schedule updated.`;
  },
};

const completeOnboarding: ToolDefinition = {
  spec: {
    type: "function",
    function: {
      name: "complete_onboarding",
      description: "Call this once you've learned the new user's name, preferred nickname, and IANA timezone. Finishes onboarding and unlocks normal conversation.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Their name" },
          nickname: { type: "string", description: "What they'd like to be called, can be the same as name" },
          timezone: { type: "string", description: "IANA timezone name, e.g. 'Africa/Lagos'" },
        },
        required: ["name", "nickname", "timezone"],
      },
    },
  },
  handler: (args, ctx) => {
    const tz = String(args.timezone);
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: tz });
    } catch {
      return `"${tz}" isn't a valid IANA timezone name. Ask them again and retry with the correct one.`;
    }
    upsertUser(ctx.jid, {
      name: String(args.name),
      nickname: String(args.nickname),
      timezone: tz,
      onboarded: true,
    });
    return `Onboarding complete.`;
  },
};

const setRelationshipStyle: ToolDefinition = {
  spec: {
    type: "function",
    function: {
      name: "set_relationship_style",
      description:
        "Set how this specific user wants you to relate to them (e.g. warm companion, girlfriend-style affection, purely professional, etc). Only affects your voice with this one user, nobody else. Use it when they ask you to be more than a plain assistant to them.",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "Free-form description of the relationship/style they want, in their own words or yours, e.g. 'wants me to act like his girlfriend, warm and affectionate, checks in like a partner would'",
          },
        },
        required: ["description"],
      },
    },
  },
  handler: (args, ctx) => {
    upsertUser(ctx.jid, { personaNote: String(args.description) });
    return `Got it.`;
  },
};

export const tools: ToolDefinition[] = [
  remember,
  forget,
  setAssistantName,
  createReminder,
  completeTask,
  setTimezone,
  setDailySchedule,
  completeOnboarding,
  setRelationshipStyle,
];

export const toolSpecs: ToolSpec[] = tools.map((t) => t.spec);

export function runTool(name: string, args: Record<string, any>, ctx: ToolContext): string {
  const tool = tools.find((t) => t.spec.function.name === name);
  if (!tool) return `Unknown tool: ${name}`;
  try {
    return tool.handler(args, ctx);
  } catch (err) {
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
