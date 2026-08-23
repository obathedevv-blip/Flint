import { config } from "../config.js";
import { withRetry } from "../utils/retry.js";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionResult {
  message: ChatMessage;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost?: number };
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export async function chatCompletion(
  messages: ChatMessage[],
  tools?: ToolSpec[]
): Promise<ChatCompletionResult> {
  const res = await withRetry(() =>
    fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openrouterApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.openrouterModel,
        messages,
        ...(tools && tools.length > 0 ? { tools } : {}),
      }),
    })
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    choices: { message: ChatMessage }[];
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost?: number };
  };

  const choice = data.choices[0];
  if (!choice) {
    throw new Error("OpenRouter returned no choices");
  }

  return { message: choice.message, usage: data.usage };
}
