import { createConnectionIdleTimeout } from "@nestor/core";
import type { CDPSession, Page } from "playwright";

const trafficSessions = new WeakMap<Page, Promise<CDPSession | null>>();

function trafficSession(page: Page): Promise<CDPSession | null> {
  const existing = trafficSessions.get(page);
  if (existing) return existing;
  const pending = (async () => {
    const context = page.context?.();
    if (!context?.newCDPSession) return null;
    let session: CDPSession | undefined;
    try {
      session = await context.newCDPSession(page);
      await session.send("Network.enable");
      return session;
    } catch {
      await session?.detach().catch(() => undefined);
      return null;
    }
  })();
  trafficSessions.set(page, pending);
  return pending;
}

/** Navigation has no total deadline. A silent connection returns its cause to the caller. */
export async function withNavigationLiveness<T>(
  page: Page,
  navigate: () => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  return withPageConnectionLiveness(page, navigate, parent, () => {
    // Keep the page available for inspection and a new model decision.
    void page.evaluate(() => window.stop()).catch(() => undefined);
  });
}

/** Wait for a browser operation while its actual connection reports activity. */
export async function withPageConnectionLiveness<T>(
  page: Page,
  work: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
  onStop?: () => void,
): Promise<T> {
  parent?.throwIfAborted();
  const idle = createConnectionIdleTimeout(15_000);
  const signal = parent ? AbortSignal.any([parent, idle.signal]) : idle.signal;
  const progress = () => idle.progress();
  let rejectWork!: (reason: unknown) => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectWork = reject;
  });
  const abort = () => {
    rejectWork(signal.reason);
    onStop?.();
  };
  const closed = () =>
    rejectWork(
      new Error("The browser page closed. Reopen it and observe again."),
    );
  const crashed = () =>
    rejectWork(
      new Error("The browser page crashed. Reopen it and observe again."),
    );
  let session: CDPSession | null = null;
  let finished = false;
  void trafficSession(page)
    .then((connected) => {
      if (finished || !connected) return;
      session = connected;
      session.on("Network.dataReceived", progress);
    })
    .catch(() => undefined);
  page.on?.("response", progress);
  page.on?.("requestfinished", progress);
  page.on?.("framenavigated", progress);
  page.on?.("domcontentloaded", progress);
  page.on?.("close", closed);
  page.on?.("crash", crashed);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([work(signal), stopped]);
  } finally {
    finished = true;
    idle.cleanup();
    signal.removeEventListener("abort", abort);
    page.off?.("response", progress);
    page.off?.("requestfinished", progress);
    page.off?.("framenavigated", progress);
    page.off?.("domcontentloaded", progress);
    page.off?.("close", closed);
    page.off?.("crash", crashed);
    (session as CDPSession | null)?.off("Network.dataReceived", progress);
  }
}
