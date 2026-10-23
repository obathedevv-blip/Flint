import makeWASocket, {
  useMultiFileAuthState,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import path from "node:path";
import { rmSync, createReadStream, existsSync } from "node:fs";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, IncomingMessageHandler, WhatsAppAdapter } from "./types.js";

const logger = pino({ level: "silent" });

export class BaileysAdapter implements WhatsAppAdapter {
  private sock: WASocket | null = null;
  private connected = false;
  private handlers: IncomingMessageHandler[] = [];
  private qrToken = randomUUID();
  private qrServerStarted = false;

  constructor(private authDir: string) {}

  private startQrServer(qrImagePath: string): void {
    if (this.qrServerStarted) return;
    this.qrServerStarted = true;

    const port = Number(process.env.PORT ?? 8080);
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/qr" && url.searchParams.get("token") === this.qrToken) {
        if (!existsSync(qrImagePath)) {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("No QR code available right now (already connected, or not generated yet). Refresh in a few seconds.");
          return;
        }
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
        createReadStream(qrImagePath).pipe(res);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(port, () => {
      console.log(`QR viewer listening. Open: /qr?token=${this.qrToken} on your Railway domain to scan.`);
    });
  }

  async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: state,
      logger,
      version,
      browser: Browsers.macOS("Desktop"),
      syncFullHistory: false,
    });
    this.sock = sock;
    this.connected = false;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("\nScan this QR code with the WhatsApp account you want to use as the bot:\n");
        qrcodeTerminal.generate(qr, { small: true });
        const qrImagePath = path.join(this.authDir, "..", "qr.png");
        QRCode.toFile(qrImagePath, qr, { width: 500 }).catch((err) => console.error("Failed to write QR image file:", err));
        console.log(`QR also saved as an image at ${qrImagePath}`);
        console.log(`QR_RAW_DATA_START${qr}QR_RAW_DATA_END`);
        this.startQrServer(qrImagePath);
      }

      if (connection === "close") {
        this.connected = false;
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("Logged out by WhatsApp. Clearing auth and generating a fresh QR to relink...");
          this.sock = null;
          rmSync(this.authDir, { recursive: true, force: true });
          setTimeout(() => void this.connect(), 1000);
          return;
        }

        if (statusCode === DisconnectReason.connectionReplaced) {
          console.log("Connection replaced by another active session. NOT auto-reconnecting, this usually means two copies of the bot are running at once against the same auth folder, or the account got linked elsewhere. Stop any other running instance, then restart this one.");
          return;
        }

        console.log(`Connection closed (status ${statusCode ?? "unknown"}). Reconnecting in 3s...`);
        setTimeout(() => void this.connect(), 3000);
      } else if (connection === "open") {
        this.connected = true;
        console.log("Connected to WhatsApp.");
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        await this.handleIncoming(msg);
      }
    });
  }

  private async handleIncoming(msg: WAMessage): Promise<void> {
    if (!msg.message || msg.key.fromMe) return;
    const jid = msg.key.remoteJid;
    if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") return;

    const content = msg.message;
    const text =
      content.conversation ??
      content.extendedTextMessage?.text ??
      undefined;

    const audioMessage = content.audioMessage;

    let audio: Buffer | undefined;
    if (audioMessage) {
      try {
        const buffer = await downloadMediaMessage(msg, "buffer", {});
        audio = buffer;
      } catch (err) {
        console.error("Failed to download voice note:", err);
      }
    }

    if (!text && !audio) return;

    const incoming: IncomingMessage = {
      jid,
      text,
      audio,
      timestamp: Number(msg.messageTimestamp ?? Date.now() / 1000) * 1000,
    };

    for (const handler of this.handlers) {
      await handler(incoming);
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.sock || !this.connected) throw new Error("WhatsApp socket not connected yet");
    await this.sock.sendMessage(jid, { text });
  }

  async sendVoiceNote(jid: string, oggOpusBuffer: Buffer): Promise<void> {
    if (!this.sock || !this.connected) throw new Error("WhatsApp socket not connected yet");
    await this.sock.sendMessage(jid, {
      audio: oggOpusBuffer,
      mimetype: "audio/ogg; codecs=opus",
      ptt: true,
    });
  }

  async setPresence(jid: string, type: "composing" | "recording"): Promise<void> {
    if (!this.sock || !this.connected) return;
    try {
      await this.sock.sendPresenceUpdate(type, jid);
    } catch (err) {
      console.error("Failed to set presence:", err);
    }
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }
}
