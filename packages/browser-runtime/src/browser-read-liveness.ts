import type { Page, Frame } from "playwright";
import { withNavigationLiveness } from "./browser-navigation";

/** A navigating page is responding. Read its new document without replaying the action. */
export async function withBrowserReadLiveness<T>(
  page: Page,
  read: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withNavigationLiveness(
    page,
    async () => {
      let navigated = false;
      for (;;) {
        signal?.throwIfAborted();
        if (page.isClosed?.())
          throw new Error("The browser page closed during the read.");
        let changed = false;
        let navigate!: () => void, rejectClosed!: (error: Error) => void;
        const moved = new Promise<{ moved: true }>((resolve) => {
          navigate = () => resolve({ moved: true });
        });
        const closed = new Promise<never>((_, reject) => {
          rejectClosed = reject;
        });
        const onNavigation = (frame: Frame) => {
          if (!frame || frame === page.mainFrame()) {
            navigated = true;
            changed = true;
            navigate();
          }
        };
        const onClose = () =>
          rejectClosed(new Error("The browser page closed during the read."));
        page.on?.("framenavigated", onNavigation);
        page.on?.("close", onClose);
        try {
          const result = await Promise.race([
            Promise.resolve()
              .then(read)
              .then((value) => ({ value })),
            moved,
            closed,
          ]);
          if ("value" in result) {
            const value = result.value;
            return navigated && value && typeof value === "object"
              ? {
                  ...value,
                  navigationNote: `The page navigated to ${page.url()}.`,
                }
              : value;
          }
        } catch (error) {
          if (
            !changed &&
            !(
              error instanceof Error &&
              /execution context was destroyed|cannot find context|frame was detached/iu.test(
                error.message,
              )
            )
          )
            throw error;
        } finally {
          page.off?.("framenavigated", onNavigation);
          page.off?.("close", onClose);
        }
        navigated = true;
        await page.waitForLoadState("domcontentloaded", { timeout: 0 });
      }
    },
    signal,
  );
}
