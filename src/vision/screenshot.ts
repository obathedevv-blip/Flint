import { chromium, type Page } from "playwright";
import { isSafeUrl } from "../utils/url.js";

export interface CapturedScreenshots {
  /** Right after the page's initial load settles. */
  initial: Buffer;
  /** ~20s later, once slow-loading content/animations have had time to finish. */
  settled: Buffer;
  /** Best-effort: after clicking into a nav/menu link, if one could be found. */
  afterNavigation?: Buffer;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
}

/** Finds a real nav/menu link (not the logo, not a "#" anchor) and clicks it. Returns whether it succeeded. */
async function clickAMenuLink(page: Page): Promise<boolean> {
  const links = page.locator("nav a[href], header a[href]");
  const count = await links.count();
  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    const href = await link.getAttribute("href").catch(() => null);
    const text = (await link.innerText().catch(() => "")).trim();
    if (!href || href.startsWith("#") || href === "/" || !text) continue;
    try {
      await link.click({ timeout: 5000 });
      return true;
    } catch {
      // try the next candidate link
    }
  }
  return false;
}

async function attempt(url: string): Promise<CapturedScreenshots> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await settle(page);
    const initial = await page.screenshot({ type: "png" });

    await page.waitForTimeout(20000);
    const settledShot = await page.screenshot({ type: "png" });

    let afterNavigation: Buffer | undefined;
    try {
      if (await clickAMenuLink(page)) {
        await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
        await settle(page);
        afterNavigation = await page.screenshot({ type: "png" });
      }
    } catch (err) {
      console.error("Menu navigation screenshot failed (non-fatal):", err);
    }

    return { initial, settled: settledShot, afterNavigation };
  } finally {
    await browser.close();
  }
}

/** Renders a URL in a headless browser and captures it at three points: initial load, ~20s settled, and after clicking into a menu (best-effort). Retries once on a transient failure. */
export async function captureScreenshots(url: string): Promise<CapturedScreenshots> {
  if (!(await isSafeUrl(url))) {
    throw new Error("That URL can't be loaded (unsupported scheme or points at a private/internal address).");
  }

  try {
    return await attempt(url);
  } catch {
    return await attempt(url);
  }
}
