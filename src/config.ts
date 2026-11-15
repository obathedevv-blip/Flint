import "dotenv/config";
import path from "node:path";

export function getEnv(name: string): string | undefined {
  if (process.env[name]?.trim()) return process.env[name]!.trim();
  // Fallback for trailing/leading whitespace in variable names or case mismatch
  const match = Object.keys(process.env).find(
    (k) => k.trim().toUpperCase() === name.toUpperCase()
  );
  if (match && process.env[match]?.trim()) {
    return process.env[match]!.trim();
  }
  return undefined;
}

function required(name: string): string {
  const value = getEnv(name);
  if (!value) {
    const visibleKeys = Object.keys(process.env).filter(
      (k) => !k.startsWith("npm_") && !k.startsWith("NODE_")
    );
    console.error(
      `[Config Error] Missing required env var: ${name}. Keys visible in container:`,
      visibleKeys
    );
    throw new Error(`Missing required env var: ${name} (see .env.example)`);
  }
  return value;
}

const dataDir = getEnv("DATA_DIR") ?? "./data";

export const config = {
  openrouterApiKey: required("OPENROUTER_API_KEY"),
  openrouterModel: getEnv("OPENROUTER_MODEL") ?? "anthropic/claude-sonnet-5",
  defaultAssistantName: getEnv("DEFAULT_ASSISTANT_NAME") ?? "Flint",

  groqApiKey: getEnv("GROQ_API_KEY") ?? "",
  groqSttModel: getEnv("GROQ_STT_MODEL") ?? "whisper-large-v3-turbo",

  edgeTtsVoice: getEnv("EDGE_TTS_VOICE") ?? "en-US-AndrewMultilingualNeural",

  dailyCostCapUsd: Number(getEnv("DAILY_COST_CAP_USD") ?? "2.00"),

  dataDir,
  dbPath: path.join(dataDir, "assistant.db"),
  authDir: path.join(dataDir, "baileys-auth"),
};
