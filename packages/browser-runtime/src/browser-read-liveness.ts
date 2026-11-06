import type { Page } from "playwright";
import { withNavigationLiveness } from "./browser-navigation";

/** A page read has no total budget: navigation or a silent connection returns
 * the failure to the model, while real browser progress keeps the read alive. */
export async function withBrowserReadLiveness<T>(
  page: Page,
  read: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  let rejectRead!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectRead = reject;
  });
  const navigation = () =>
    rejectRead(new Error("The page navigated during the read; observe again."));
  const closed = () =>
    rejectRead(new Error("The browser page closed during the read."));
  page.on?.("framenavigated", navigation);
  page.on?.("close", closed);
  try {
    return await withNavigationLiveness(
      page,
      () => Promise.race([Promise.resolve().then(read), interrupted]),
      signal,
    );
  } finally {
    page.off?.("framenavigated", navigation);
    page.off?.("close", closed);
  }
}
