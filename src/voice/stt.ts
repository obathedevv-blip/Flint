import { config } from "../config.js";
import { withRetry } from "../utils/retry.js";

const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/** Transcribes a WhatsApp voice note (ogg/opus buffer) via Groq's hosted Whisper. */
export async function transcribeAudio(oggOpusBuffer: Buffer): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(oggOpusBuffer)]), "voice-note.ogg");
  form.append("model", config.groqSttModel);

  const res = await withRetry(() =>
    fetch(GROQ_TRANSCRIPTION_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.groqApiKey}` },
      body: form,
    })
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq transcription failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { text: string };
  return data.text.trim();
}
