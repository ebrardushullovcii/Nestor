import { createConnectionIdleTimeout } from "@nestor/core";
import type { Page } from "playwright";

/** A page read has no total budget: navigation or a silent connection returns
 * the failure to the model, while real browser progress keeps the read alive. */
export async function withBrowserReadLiveness<T>(
  page: Page,
  read: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const idle = createConnectionIdleTimeout(15_000);
  let rejectRead!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectRead = reject;
  });
  const navigation = () => rejectRead(new Error("The page navigated during the read; observe again."));
  const closed = () => rejectRead(new Error("The browser page closed during the read."));
  const silent = () => rejectRead(new Error("The browser connection stopped responding during the read; observe again or reconnect."));
  const stopped = () => rejectRead(new Error("The browser read was stopped."));
  page.on("response", idle.progress);
  page.on("framenavigated", navigation);
  page.on("close", closed);
  idle.signal.addEventListener("abort", silent, { once: true });
  signal?.addEventListener("abort", stopped, { once: true });
  try {
    return await Promise.race([Promise.resolve().then(read), interrupted]);
  } finally {
    idle.cleanup();
    page.off("response", idle.progress);
    page.off("framenavigated", navigation);
    page.off("close", closed);
    idle.signal.removeEventListener("abort", silent);
    signal?.removeEventListener("abort", stopped);
  }
}
