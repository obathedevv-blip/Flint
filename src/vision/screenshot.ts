import { chromium } from "playwright";
import { isSafeUrl } from "../utils/url.js";

async function attempt(url: string): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(1000);
    return await page.screenshot({ type: "png" });
  } finally {
    await browser.close();
  }
}

/** Renders a URL in a headless browser and returns a viewport screenshot as PNG bytes. Retries once on a transient failure. */
export async function captureScreenshot(url: string): Promise<Buffer> {
  if (!(await isSafeUrl(url))) {
    throw new Error("That URL can't be loaded (unsupported scheme or points at a private/internal address).");
  }

  try {
    return await attempt(url);
  } catch {
    return await attempt(url);
  }
}
