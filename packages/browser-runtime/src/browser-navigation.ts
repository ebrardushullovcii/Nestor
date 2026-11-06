import { createConnectionIdleTimeout } from "@nestor/core";
import type { Page } from "playwright";

/** Navigation has no total deadline. A silent connection returns its cause to the caller. */
export async function withNavigationLiveness<T>(
  page: Page,
  navigate: () => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  parent?.throwIfAborted();
  const idle = createConnectionIdleTimeout(15_000);
  const signal = parent ? AbortSignal.any([parent, idle.signal]) : idle.signal;
  const progress = () => idle.progress();
  let rejectNavigation!: (reason: unknown) => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectNavigation = reject;
  });
  const abort = () => {
    rejectNavigation(signal.reason);
    // Keep the page available for inspection and a new model decision.
    void page.evaluate(() => window.stop()).catch(() => undefined);
  };
  page.on?.("response", progress);
  page.on?.("requestfinished", progress);
  page.on?.("domcontentloaded", progress);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([navigate(), stopped]);
  } finally {
    idle.cleanup();
    signal.removeEventListener("abort", abort);
    page.off?.("response", progress);
    page.off?.("requestfinished", progress);
    page.off?.("domcontentloaded", progress);
  }
}
