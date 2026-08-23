import { spawn } from "node:child_process";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";

/** Converts an arbitrary audio buffer (e.g. mp3 from TTS) into ogg/opus, the format WhatsApp expects for voice notes. */
export function convertToOggOpus(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath.path, [
      "-i", "pipe:0",
      "-c:a", "libopus",
      "-b:a", "32k",
      "-vbr", "on",
      "-f", "ogg",
      "pipe:1",
    ]);

    const chunks: Buffer[] = [];
    let stderr = "";

    proc.stdout.on("data", (chunk) => chunks.push(chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}
