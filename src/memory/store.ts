import { db } from "./db.js";

export interface User {
  jid: string;
  name: string | null;
  nickname: string | null;
  assistantName: string | null;
  timezone: string | null;
  approved: boolean;
  onboarded: boolean;
  isAdmin: boolean;
  denied: boolean;
  personaNote: string | null;
  morningBriefTime: string;
  eveningCheckinTime: string;
  lastMorningBriefDate: string | null;
  lastEveningCheckinDate: string | null;
}

export interface Fact {
  key: string;
  value: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Task {
  id: number;
  description: string;
  remindAt: number | null;
  status: "open" | "done" | "cancelled";
}

const MAX_RECENT_MESSAGES = 20;

interface UserRow {
  jid: string;
  name: string | null;
  nickname: string | null;
  assistant_name: string | null;
  timezone: string | null;
  approved: number;
  onboarded: number;
  is_admin: number;
  denied: number;
  persona_note: string | null;
  morning_brief_time: string;
  evening_checkin_time: string;
  last_morning_brief_date: string | null;
  last_evening_checkin_date: string | null;
}

const USER_COLUMNS = `jid, name, nickname, assistant_name, timezone, approved, onboarded, is_admin, denied, persona_note,
       morning_brief_time, evening_checkin_time, last_morning_brief_date, last_evening_checkin_date`;

function rowToUser(row: UserRow): User {
  return {
    jid: row.jid,
    name: row.name,
    nickname: row.nickname,
    assistantName: row.assistant_name,
    timezone: row.timezone,
    approved: !!row.approved,
    onboarded: !!row.onboarded,
    isAdmin: !!row.is_admin,
    denied: !!row.denied,
    personaNote: row.persona_note,
    morningBriefTime: row.morning_brief_time,
    eveningCheckinTime: row.evening_checkin_time,
    lastMorningBriefDate: row.last_morning_brief_date,
    lastEveningCheckinDate: row.last_evening_checkin_date,
  };
}

export function getUser(jid: string): User | undefined {
  const row = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE jid = ?`).get(jid) as UserRow | undefined;
  return row ? rowToUser(row) : undefined;
}

export function getApprovedUsers(): User[] {
  const rows = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE approved = 1`).all() as UserRow[];
  return rows.map(rowToUser);
}

export function getAdmins(): User[] {
  const rows = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE is_admin = 1`).all() as UserRow[];
  return rows.map(rowToUser);
}

export function getPendingUsers(): User[] {
  const rows = db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE approved = 0 AND denied = 0 ORDER BY created_at ASC`)
    .all() as UserRow[];
  return rows.map(rowToUser);
}

/** Matches a pending/approved user by the digits of their phone number (the part of the JID before '@'). */
export function findUserByPhone(phoneDigits: string): User | undefined {
  const row = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE jid LIKE ?`).get(`${phoneDigits}@%`) as
    | UserRow
    | undefined;
  return row ? rowToUser(row) : undefined;
}

export function anyUserExists(): boolean {
  return (db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number }).c > 0;
}

export function upsertUser(jid: string, fields: Partial<Omit<User, "jid">> = {}): User {
  const existing = getUser(jid);
  if (!existing) {
    db.prepare(
      `INSERT INTO users (jid, name, nickname, assistant_name, timezone, approved, onboarded, is_admin, denied, persona_note, morning_brief_time, evening_checkin_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      jid,
      fields.name ?? null,
      fields.nickname ?? null,
      fields.assistantName ?? null,
      fields.timezone ?? null,
      fields.approved ? 1 : 0,
      fields.onboarded ? 1 : 0,
      fields.isAdmin ? 1 : 0,
      fields.denied ? 1 : 0,
      fields.personaNote ?? null,
      fields.morningBriefTime ?? "08:00",
      fields.eveningCheckinTime ?? "21:00"
    );
  } else {
    db.prepare(
      `UPDATE users SET name = ?, nickname = ?, assistant_name = ?, timezone = ?, approved = ?, onboarded = ?, is_admin = ?, denied = ?, persona_note = ?,
              morning_brief_time = ?, evening_checkin_time = ?, last_morning_brief_date = ?, last_evening_checkin_date = ?
       WHERE jid = ?`
    ).run(
      fields.name ?? existing.name,
      fields.nickname ?? existing.nickname,
      fields.assistantName ?? existing.assistantName,
      fields.timezone ?? existing.timezone,
      fields.approved !== undefined ? (fields.approved ? 1 : 0) : (existing.approved ? 1 : 0),
      fields.onboarded !== undefined ? (fields.onboarded ? 1 : 0) : (existing.onboarded ? 1 : 0),
      fields.isAdmin !== undefined ? (fields.isAdmin ? 1 : 0) : (existing.isAdmin ? 1 : 0),
      fields.denied !== undefined ? (fields.denied ? 1 : 0) : (existing.denied ? 1 : 0),
      fields.personaNote ?? existing.personaNote,
      fields.morningBriefTime ?? existing.morningBriefTime,
      fields.eveningCheckinTime ?? existing.eveningCheckinTime,
      fields.lastMorningBriefDate ?? existing.lastMorningBriefDate,
      fields.lastEveningCheckinDate ?? existing.lastEveningCheckinDate,
      jid
    );
  }
  return getUser(jid)!;
}

export function setFact(jid: string, key: string, value: string): void {
  db.prepare(
    `INSERT INTO facts (user_jid, key, value, updated_at) VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(user_jid, key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`
  ).run(jid, key, value);
}

export function getFacts(jid: string): Fact[] {
  return db.prepare("SELECT key, value FROM facts WHERE user_jid = ? ORDER BY updated_at DESC").all(jid) as Fact[];
}

export function deleteFact(jid: string, key: string): void {
  db.prepare("DELETE FROM facts WHERE user_jid = ? AND key = ?").run(jid, key);
}

export function getSummary(jid: string): string {
  const row = db.prepare("SELECT summary FROM summaries WHERE user_jid = ?").get(jid) as
    | { summary: string }
    | undefined;
  return row?.summary ?? "";
}

export function setSummary(jid: string, summary: string): void {
  db.prepare(
    `INSERT INTO summaries (user_jid, summary, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(user_jid) DO UPDATE SET summary = excluded.summary, updated_at = unixepoch()`
  ).run(jid, summary);
}

export function addMessage(jid: string, role: ChatMessage["role"], content: string): void {
  db.prepare("INSERT INTO messages (user_jid, role, content) VALUES (?, ?, ?)").run(jid, role, content);
}

export function getRecentMessages(jid: string, limit = MAX_RECENT_MESSAGES): ChatMessage[] {
  const rows = db
    .prepare("SELECT role, content FROM messages WHERE user_jid = ? ORDER BY id DESC LIMIT ?")
    .all(jid, limit) as ChatMessage[];
  return rows.reverse();
}

export function createTask(jid: string, description: string, remindAt: number | null): number {
  const result = db
    .prepare("INSERT INTO tasks (user_jid, description, remind_at) VALUES (?, ?, ?)")
    .run(jid, description, remindAt);
  return Number(result.lastInsertRowid);
}

export function getOpenTasks(jid: string): Task[] {
  return db
    .prepare("SELECT id, description, remind_at as remindAt, status FROM tasks WHERE user_jid = ? AND status = 'open' ORDER BY (remind_at IS NULL), remind_at ASC")
    .all(jid) as Task[];
}

export function getDueTasks(jid: string, nowUnix: number): Task[] {
  return db
    .prepare(
      "SELECT id, description, remind_at as remindAt, status FROM tasks WHERE user_jid = ? AND status = 'open' AND reminded = 0 AND remind_at IS NOT NULL AND remind_at <= ?"
    )
    .all(jid, nowUnix) as Task[];
}

export function markTaskReminded(id: number): void {
  db.prepare("UPDATE tasks SET reminded = 1 WHERE id = ?").run(id);
}

/** Marks the most recent open task whose description contains the given text as done. Returns whether one was found. */
export function completeTaskByDescription(jid: string, descriptionLike: string): boolean {
  const row = db
    .prepare(
      "SELECT id FROM tasks WHERE user_jid = ? AND status = 'open' AND description LIKE ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(jid, `%${descriptionLike}%`) as { id: number } | undefined;
  if (!row) return false;
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(row.id);
  return true;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function recordUsage(jid: string, promptTokens: number, completionTokens: number, costUsd: number): void {
  const date = todayUtc();
  db.prepare(
    `INSERT INTO usage (user_jid, date, prompt_tokens, completion_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_jid, date) DO UPDATE SET
       prompt_tokens = prompt_tokens + excluded.prompt_tokens,
       completion_tokens = completion_tokens + excluded.completion_tokens,
       cost_usd = cost_usd + excluded.cost_usd`
  ).run(jid, date, promptTokens, completionTokens, costUsd);
}

export function getTodayCostUsd(jid: string): number {
  const row = db.prepare("SELECT cost_usd FROM usage WHERE user_jid = ? AND date = ?").get(jid, todayUtc()) as
    | { cost_usd: number }
    | undefined;
  return row?.cost_usd ?? 0;
}
