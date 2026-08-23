import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    jid TEXT PRIMARY KEY,
    name TEXT,
    nickname TEXT,
    assistant_name TEXT,
    timezone TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    approved INTEGER NOT NULL DEFAULT 0,
    onboarded INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_jid TEXT NOT NULL REFERENCES users(jid),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(user_jid, key)
  );

  CREATE TABLE IF NOT EXISTS summaries (
    user_jid TEXT PRIMARY KEY REFERENCES users(jid),
    summary TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_jid TEXT NOT NULL REFERENCES users(jid),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_jid TEXT NOT NULL REFERENCES users(jid),
    description TEXT NOT NULL,
    remind_at INTEGER,
    reminded INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS usage (
    user_jid TEXT NOT NULL REFERENCES users(jid),
    date TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (user_jid, date)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_jid, created_at);
  CREATE INDEX IF NOT EXISTS idx_facts_user ON facts(user_jid);
  CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_jid, status);
`);

function addColumnIfMissing(table: string, column: string, ddl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

addColumnIfMissing("users", "assistant_name", "assistant_name TEXT");
addColumnIfMissing("users", "morning_brief_time", "morning_brief_time TEXT NOT NULL DEFAULT '08:00'");
addColumnIfMissing("users", "evening_checkin_time", "evening_checkin_time TEXT NOT NULL DEFAULT '21:00'");
addColumnIfMissing("users", "last_morning_brief_date", "last_morning_brief_date TEXT");
addColumnIfMissing("users", "last_evening_checkin_date", "last_evening_checkin_date TEXT");
addColumnIfMissing("users", "denied", "denied INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "persona_note", "persona_note TEXT");

const userColumnsForAdminMigration = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
const hasIsOwner = userColumnsForAdminMigration.some((c) => c.name === "is_owner");
const hasIsAdmin = userColumnsForAdminMigration.some((c) => c.name === "is_admin");
if (hasIsOwner && !hasIsAdmin) {
  db.exec("ALTER TABLE users RENAME COLUMN is_owner TO is_admin");
} else if (!hasIsAdmin) {
  db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
}

// One-time bootstrap: if no admin exists yet but there's exactly one pre-existing
// user (from before multi-user support), promote them to admin automatically.
const adminCount = (db.prepare("SELECT COUNT(*) as c FROM users WHERE is_admin = 1").get() as { c: number }).c;
if (adminCount === 0) {
  const existing = db.prepare("SELECT jid FROM users ORDER BY created_at ASC LIMIT 1").get() as { jid: string } | undefined;
  if (existing) {
    db.prepare("UPDATE users SET is_admin = 1, approved = 1 WHERE jid = ?").run(existing.jid);
  }
}
