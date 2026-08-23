function isRetryableError(err: unknown): boolean {
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return true;
  const cause = (err as { cause?: unknown } | undefined)?.cause as { code?: string } | undefined;
  const code = cause?.code;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "EAI_AGAIN";
}

/** Retries a network call a couple of times on transient connection errors (reset, timeout, DNS blip), not on real API errors like bad auth or bad input. */
export async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 500): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryableError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
}
