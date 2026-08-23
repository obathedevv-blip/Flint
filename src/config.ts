import "dotenv/config";
import path from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name} (see .env.example)`);
  }
  return value;
}

const dataDir = process.env.DATA_DIR ?? "./data";

export const config = {
  openrouterApiKey: required("OPENROUTER_API_KEY"),
  openrouterModel: process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-5",
  defaultAssistantName: process.env.DEFAULT_ASSISTANT_NAME ?? "Flint",

  groqApiKey: process.env.GROQ_API_KEY ?? "",
  groqSttModel: process.env.GROQ_STT_MODEL ?? "whisper-large-v3-turbo",

  edgeTtsVoice: process.env.EDGE_TTS_VOICE ?? "en-US-AndrewMultilingualNeural",

  dailyCostCapUsd: Number(process.env.DAILY_COST_CAP_USD ?? "2.00"),

  dataDir,
  dbPath: path.join(dataDir, "assistant.db"),
  authDir: path.join(dataDir, "baileys-auth"),
};
