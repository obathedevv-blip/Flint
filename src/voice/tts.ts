import { EdgeTTS } from "edge-tts-universal";
import { config } from "../config.js";
import { convertToOggOpus } from "./ffmpeg.js";

/**
 * Synthesizes speech via Microsoft Edge's free neural TTS service and returns
 * ogg/opus bytes ready for a WhatsApp voice note. Unofficial API (no key, no
 * SLA) - swap for a paid provider like ElevenLabs here if it ever breaks.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const tts = new EdgeTTS(text, config.edgeTtsVoice);
  const result = await tts.synthesize();
  const mp3 = Buffer.from(await result.audio.arrayBuffer());
  return convertToOggOpus(mp3);
}
