export interface IncomingMessage {
  /** Sender JID, e.g. "15551234567@s.whatsapp.net" */
  jid: string;
  text?: string;
  /** Raw .ogg/opus bytes, present when the message was a voice note */
  audio?: Buffer;
  timestamp: number;
}

export type IncomingMessageHandler = (msg: IncomingMessage) => void | Promise<void>;

/**
 * Transport-agnostic contract for the WhatsApp layer. The rest of the app talks
 * to this interface only, so the Baileys implementation can be swapped for the
 * official Meta Cloud API later without touching anything upstream.
 */
export interface WhatsAppAdapter {
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  sendVoiceNote(jid: string, oggOpusBuffer: Buffer): Promise<void>;
  /** Shows the "typing..." or "recording audio..." indicator in the chat. */
  setPresence(jid: string, type: "composing" | "recording"): Promise<void>;
  onMessage(handler: IncomingMessageHandler): void;
}
