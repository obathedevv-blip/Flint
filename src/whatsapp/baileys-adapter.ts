import makeWASocket, {
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import type { IncomingMessage, IncomingMessageHandler, WhatsAppAdapter } from "./types.js";

const logger = pino({ level: "silent" });

export class BaileysAdapter implements WhatsAppAdapter {
  private sock: WASocket | null = null;
  private handlers: IncomingMessageHandler[] = [];

  constructor(private authDir: string) {}

  async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    const sock = makeWASocket({
      auth: state,
      logger,
      syncFullHistory: false,
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("\nScan this QR code with the WhatsApp account you want to use as the bot:\n");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("Logged out, delete the auth folder and re-scan to relink.");
          return;
        }

        if (statusCode === DisconnectReason.connectionReplaced) {
          console.log("Connection replaced by another active session. NOT auto-reconnecting, this usually means two copies of the bot are running at once against the same auth folder, or the account got linked elsewhere. Stop any other running instance, then restart this one.");
          return;
        }

        console.log(`Connection closed (status ${statusCode ?? "unknown"}). Reconnecting in 3s...`);
        setTimeout(() => void this.connect(), 3000);
      } else if (connection === "open") {
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
    if (!this.sock) throw new Error("WhatsApp socket not connected yet");
    await this.sock.sendMessage(jid, { text });
  }

  async sendVoiceNote(jid: string, oggOpusBuffer: Buffer): Promise<void> {
    if (!this.sock) throw new Error("WhatsApp socket not connected yet");
    await this.sock.sendMessage(jid, {
      audio: oggOpusBuffer,
      mimetype: "audio/ogg; codecs=opus",
      ptt: true,
    });
  }

  async setPresence(jid: string, type: "composing" | "recording"): Promise<void> {
    if (!this.sock) return;
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
