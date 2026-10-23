import cron from "node-cron";
import type { WhatsAppAdapter } from "../whatsapp/types.js";
import { runProactiveTurn } from "../llm/agent.js";
import {
  getApprovedUsers,
  getDueTasks,
  markTaskReminded,
  upsertUser,
  addMessage,
  type Task,
  type User,
} from "../memory/store.js";

const MISSED_REMINDER_GRACE_MINUTES = 30; // Reminders overdue by more than 30 mins are considered missed due to downtime

export function safeLocalParts(date: Date, timeZone?: string | null): { hhmm: string; dateStr: string } {
  const tz = timeZone?.trim() || "UTC";
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
    return { hhmm: `${parts.hour}:${parts.minute}`, dateStr: `${parts.year}-${parts.month}-${parts.day}` };
  } catch {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
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
}

export function parseHHMM(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function isWithinMorningWindow(currentHhmm: string, scheduledHhmm: string): boolean {
  const current = parseHHMM(currentHhmm);
  const scheduled = parseHHMM(scheduledHhmm);
  const diff = current - scheduled;
  // Must be at/after scheduled time, within 2 hours, and before noon (unless scheduled >= 12:00, then within 1 hour)
  if (diff < 0) return false;
  if (scheduled < 12 * 60) {
    return diff <= 120 && current < 12 * 60;
  }
  return diff <= 60;
}

export function isWithinEveningWindow(currentHhmm: string, scheduledHhmm: string): boolean {
  const current = parseHHMM(currentHhmm);
  const scheduled = parseHHMM(scheduledHhmm);
  const diff = current - scheduled;
  // Must be at/after scheduled time, within 2 hours, and before 23:30 (don't disturb late at night)
  return diff >= 0 && diff <= 120 && current < 23 * 60 + 30;
}

export async function handleReminders(
  adapter: WhatsAppAdapter,
  user: User,
  nowUnix: number,
  todayDateStr: string
): Promise<void> {
  const due = getDueTasks(user.jid, nowUnix);
  if (due.length === 0) return;

  const missedTasks: Task[] = [];
  const timelyTasks: Task[] = [];

  for (const task of due) {
    if (!task.remindAt) {
      timelyTasks.push(task);
      continue;
    }

    const taskDate = new Date(task.remindAt * 1000);
    const { dateStr: taskDateStr } = safeLocalParts(taskDate, user.timezone);
    const delayMinutes = (nowUnix - task.remindAt) / 60;

    const datePassed = taskDateStr < todayDateStr;
    const significantlyOverdue = delayMinutes > MISSED_REMINDER_GRACE_MINUTES;

    if (datePassed || significantlyOverdue) {
      missedTasks.push(task);
    } else {
      timelyTasks.push(task);
    }
  }

  // Handle missed reminders in one consolidated apology & summary turn
  if (missedTasks.length > 0) {
    const missedList = missedTasks
      .map((t) => {
        const taskDate = new Date(t.remindAt! * 1000);
        const { dateStr, hhmm } = safeLocalParts(taskDate, user.timezone);
        return `- "${t.description}" (scheduled for ${dateStr} at ${hhmm})`;
      })
      .join("\n");

    const prompt = `System notice: The assistant deployment/system was temporarily down or offline, and because of this, the following scheduled reminder(s) were missed and could not be delivered on time:
${missedList}

Please send a single, natural message to the user:
1. Apologize sincerely for missing the reminder(s).
2. Explain the reason: the system was temporarily down / experienced downtime.
3. Provide a clear, summarized follow-up listing the reminder(s) that were missed (what they were and when they were originally scheduled for).
4. Ask if they still need help or would like to reschedule any of them.
Keep it warm, polite, and concise in your voice. Do NOT send separate messages for each reminder.`;

    try {
      let reply: string;
      try {
        reply = await runProactiveTurn(user, prompt);
      } catch (err) {
        console.error(`Error running proactive turn for missed reminders for ${user.jid}:`, err);
        reply =
          `I'm really sorry! Due to temporary system downtime, I was unable to send your scheduled reminder(s) on time:\n\n` +
          missedTasks
            .map((t) => {
              const taskDate = new Date(t.remindAt! * 1000);
              const { dateStr, hhmm } = safeLocalParts(taskDate, user.timezone);
              return `• ${t.description} (scheduled for ${dateStr} at ${hhmm})`;
            })
            .join("\n") +
          `\n\nPlease let me know if you would like me to reschedule any of them!`;
        addMessage(user.jid, "assistant", reply);
      }
      await adapter.sendMessage(user.jid, reply);
    } finally {
      // Always mark all missed tasks as reminded so they are never re-sent
      for (const task of missedTasks) {
        markTaskReminded(task.id);
      }
    }
  }

  // Handle timely reminders individually
  for (const task of timelyTasks) {
    try {
      let reply: string;
      try {
        reply = await runProactiveTurn(
          user,
          `Time to remind them about: "${task.description}". Send a short, natural nudge in your voice.`
        );
      } catch (err) {
        console.error(`Error running proactive turn for timely reminder ${task.id}:`, err);
        reply = `Reminder: ${task.description}`;
        addMessage(user.jid, "assistant", reply);
      }
      await adapter.sendMessage(user.jid, reply);
    } finally {
      markTaskReminded(task.id);
    }
  }
}

export async function handleGreetingsAndCheckups(
  adapter: WhatsAppAdapter,
  user: User,
  now: Date
): Promise<void> {
  if (!user.timezone) return;
  const { hhmm, dateStr } = safeLocalParts(now, user.timezone);

  // Morning brief check
  if (user.lastMorningBriefDate !== dateStr) {
    const scheduled = parseHHMM(user.morningBriefTime);
    const current = parseHHMM(hhmm);

    if (current >= scheduled) {
      if (isWithinMorningWindow(hhmm, user.morningBriefTime)) {
        try {
          const reply = await runProactiveTurn(
            user,
            "It's time for their scheduled morning brief. Greet them, mention anything relevant from memory or open tasks, and set a good tone for the day. Keep it short."
          );
          await adapter.sendMessage(user.jid, reply);
        } catch (err) {
          console.error(`Error sending morning brief for ${user.jid}:`, err);
        }
      } else {
        console.log(
          `Skipping missed morning brief for ${user.jid}: scheduled for ${user.morningBriefTime}, current time is ${hhmm} (window passed).`
        );
      }
      // In either case (sent or skipped because window passed), mark today as done
      upsertUser(user.jid, { lastMorningBriefDate: dateStr });
    }
  }

  // Evening check-in check
  if (user.lastEveningCheckinDate !== dateStr) {
    const scheduled = parseHHMM(user.eveningCheckinTime);
    const current = parseHHMM(hhmm);

    if (current >= scheduled) {
      if (isWithinEveningWindow(hhmm, user.eveningCheckinTime)) {
        try {
          const reply = await runProactiveTurn(
            user,
            "It's time for their scheduled evening check-in. Ask how the day went, or note anything they were supposed to get done today. Keep it short."
          );
          await adapter.sendMessage(user.jid, reply);
        } catch (err) {
          console.error(`Error sending evening check-in for ${user.jid}:`, err);
        }
      } else {
        console.log(
          `Skipping missed evening check-in for ${user.jid}: scheduled for ${user.eveningCheckinTime}, current time is ${hhmm} (window passed).`
        );
      }
      // In either case (sent or skipped because window passed), mark today as done
      upsertUser(user.jid, { lastEveningCheckinDate: dateStr });
    }
  }
}

let isTicking = false;

async function tick(adapter: WhatsAppAdapter): Promise<void> {
  if (isTicking) return;
  isTicking = true;

  try {
    const now = new Date();
    const nowUnix = Math.floor(now.getTime() / 1000);

    for (const user of getApprovedUsers()) {
      try {
        const { dateStr: todayDateStr } = safeLocalParts(now, user.timezone);
        await handleReminders(adapter, user, nowUnix, todayDateStr);
        await handleGreetingsAndCheckups(adapter, user, now);
      } catch (err) {
        console.error(`Scheduler error for ${user.jid}:`, err);
      }
    }
  } finally {
    isTicking = false;
  }
}

export function startScheduler(adapter: WhatsAppAdapter): void {
  cron.schedule("* * * * *", () => {
    void tick(adapter);
  });
  console.log("Scheduler started (checks every minute for reminders, morning briefs, evening check-ins).");
}
