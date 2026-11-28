import { traceEvent } from "@nestor/core/run-trace";
import { DiscoveryPageReadError } from "@nestor/contracts";
import type { BrowserContext, Page } from "playwright";
import { readPageLinkedText } from "./page-linked-text";
import { withPageConnectionLiveness } from "./browser-navigation";
import { withBrowserReadLiveness } from "./browser-read-liveness";

/** Capture a page in its own tab. Readiness and further interaction belong to the caller. */
export async function readRenderedPageHtml(
  context: BrowserContext,
  url: string,
  options: {
    signal?: AbortSignal | undefined;
    onPage?: (page: Page) => void | Promise<void>;
    ready?: (html: string) => boolean;
  } = {},
): Promise<{ html: string; finalUrl: string; visibleText: string }> {
  const address = new URL(url);
  if (
    !["http:", "https:"].includes(address.protocol) ||
    address.username ||
    address.password
  )
    throw new Error("Only website pages can be read.");
  options.signal?.throwIfAborted();
  const page = await context.newPage();
  try {
    await options.onPage?.(page);
    // Active navigation can outlast any wall clock. Only connection silence
    // or the person's Stop interrupts it. Never wait for semantic markup or
    // networkidle here: ads/animation can keep either changing indefinitely.
    traceEvent("search_page_started", { url, rendered: true });
    const response = await withPageConnectionLiveness(
      page,
      () => page.goto(url, { waitUntil: "domcontentloaded", timeout: 0 }),
      options.signal,
    );
    traceEvent("search_page_fetched", {
      url,
      finalUrl: page.url(),
      rendered: true,
      status: response?.status() ?? null,
    });
    if (response && response.status() >= 400)
      throw new DiscoveryPageReadError(response.status());
    return await withBrowserReadLiveness(
      page,
      async () => ({
        html: await page.content(),
        finalUrl: page.url(),
        visibleText: await readPageLinkedText(page),
      }),
      options.signal,
    );
  } finally {
    await page.close().catch(() => undefined);
  }
}
