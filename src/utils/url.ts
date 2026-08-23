import dns from "node:dns/promises";
import net from "node:net";

const URL_REGEX = /https?:\/\/[^\s]+/i;

export function extractFirstUrl(text: string): string | undefined {
  return text.match(URL_REGEX)?.[0];
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

/** Blocks non-http(s) schemes and anything resolving to a private/loopback/link-local address, to stop the screenshot tool being used to probe internal network services. */
export async function isSafeUrl(urlStr: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.hostname === "localhost") return false;

  try {
    const { address } = await dns.lookup(parsed.hostname);
    return !isPrivateIp(address);
  } catch {
    return false;
  }
}
