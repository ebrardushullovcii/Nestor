import { traceEvent } from "@nestor/core/run-trace";
import { createConnectionIdleTimeout } from "@nestor/core";
import { DiscoveryPageReadError } from "@nestor/contracts";
import type { BrowserContext, Page } from "playwright";

/** Capture a page in its own tab. Readiness and further interaction belong to the caller. */
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
  const idle = createConnectionIdleTimeout(15_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, idle.signal])
    : idle.signal;
  const progress = () => idle.progress();
  const abort = () => {
    void page.close().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  page.on("response", progress);
  page.on("requestfinished", progress);
  page.on("domcontentloaded", progress);
  try {
    await options.onPage?.(page);
    signal.throwIfAborted();
    // Active navigation can outlast any wall clock. Only connection silence
    // or the person's Stop interrupts it. Never wait for semantic markup or
    // networkidle here: ads/animation can keep either changing indefinitely.
    traceEvent("search_page_started", { url, rendered: true });
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 0,
    });
    signal.throwIfAborted();
    traceEvent("search_page_fetched", {
      url,
      finalUrl: page.url(),
      rendered: true,
      status: response?.status() ?? null,
    });
    if (response && response.status() >= 400)
      throw new DiscoveryPageReadError(response.status());
    return { html: await page.content(), finalUrl: page.url() };
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    idle.cleanup();
    signal.removeEventListener("abort", abort);
    page.off("response", progress);
    page.off("requestfinished", progress);
    page.off("domcontentloaded", progress);
    await page.close().catch(() => undefined);
  }
}
