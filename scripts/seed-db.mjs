import fs from "node:fs";
import path from "node:path";

const dataDir = process.env.DATA_DIR || "./data";
const dbPath = path.join(dataDir, "assistant.db");

function assembleSeed() {
  const count = Number(process.env.SEED_DB_PART_COUNT || "0");
  if (count <= 0) return process.env.SEED_DB_BASE64 || null;
  let combined = "";
  for (let i = 1; i <= count; i++) {
    const part = process.env[`SEED_DB_PART_${i}`];
    if (!part) {
      console.error(`Missing SEED_DB_PART_${i}, aborting seed.`);
      return null;
    }
    combined += part;
  }
  return combined;
}

if (!fs.existsSync(dbPath)) {
  const seed = assembleSeed();
  if (seed) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(dbPath, Buffer.from(seed, "base64"));
    console.log("Seeded database from seed variable(s).");
  } else {
    console.log("No seed data provided, starting with a fresh database.");
  }
} else {
  console.log("Database already exists on the volume, skipping seed.");
}
