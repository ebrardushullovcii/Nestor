import type { BrowserContext, Page } from "playwright";

/** A fresh read-only tab. It never reuses a person's page or a prepared form. */
export async function readRenderedPageHtml(
  context: BrowserContext,
  url: string,
  options: {
    signal?: AbortSignal;
    onPage?: (page: Page) => void | Promise<void>;
  } = {},
): Promise<{ html: string; finalUrl: string }> {
  const address = new URL(url);
  if (
    !["http:", "https:"].includes(address.protocol) ||
    address.username ||
    address.password
  )
    throw new Error("Only website pages can be read.");
  options.signal?.throwIfAborted();
  const page = await context.newPage();
  const abort = () => {
    void page.close().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    await options.onPage?.(page);
    options.signal?.throwIfAborted();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    // Let script-loaded content finish. Busy sites still get a bounded read.
    await page
      .waitForLoadState("networkidle", { timeout: 8_000 })
      .catch(() => undefined);
    options.signal?.throwIfAborted();
    return { html: await page.content(), finalUrl: page.url() };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await page.close().catch(() => undefined);
  }
}
