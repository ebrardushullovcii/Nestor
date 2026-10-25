import type { BrowserContext, Page } from "playwright";

/** A fresh read-only tab. It never reuses a person's page or a prepared form. */
export async function readRenderedPageHtml(
  context: BrowserContext,
  url: string,
  options: {
    signal?: AbortSignal | undefined;
    onPage?: (page: Page) => void | Promise<void>;
    ready?: (html: string) => boolean;
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
    let html = await page.content();
    const deadline = Date.now() + 12_000;
    while (options.ready && !options.ready(html) && Date.now() < deadline) {
      options.signal?.throwIfAborted();
      await page.waitForTimeout(200);
      html = await page.content().catch(() => html);
    }
    return { html, finalUrl: page.url() };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await page.close().catch(() => undefined);
  }
}
