import type { Page, Response } from "playwright";
import {
  applicationSiteKey,
  type ApplicationPreparationLease,
  type ApplicationPreparationScheduler,
} from "./application-preparation-scheduler";

/** Rate-limit recovery never repeats a write, a form action, or a send. */
export function createApplicationSitePacing(
  scheduler: ApplicationPreparationScheduler,
) {
  const pages = new WeakMap<Page, { reloadUrl: string | null }>();

  function observe(page: Page): void {
    if (pages.has(page)) return;
    const state = { reloadUrl: null as string | null };
    pages.set(page, state);
    page.on("response", (response: Response) => {
      const request = response.request();
      const document =
        request.isNavigationRequest() && response.frame() === page.mainFrame();
      if (!document && !["xhr", "fetch"].includes(request.resourceType()))
        return;
      if (
        !document &&
        applicationSiteKey(response.url()) !== applicationSiteKey(page.url())
      )
        return;
      const until = scheduler.recordResponse(
        response.url(),
        response.status(),
        response.headers()["retry-after"] ?? null,
      );
      if (document) {
        // A POST that received a response may already have reached the server.
        // Its result goes through the existing send guards, never a reload.
        state.reloadUrl =
          until !== null && request.method() === "GET" ? response.url() : null;
      }
    });
  }

  async function waitForReady(
    page: Page,
    lease: ApplicationPreparationLease,
    signal?: AbortSignal,
  ): Promise<void> {
    observe(page);
    while (true) {
      signal?.throwIfAborted();
      if (page.isClosed()) throw new Error("The application page was closed.");
      await lease.moveTo(page.url());
      signal?.throwIfAborted();
      const state = pages.get(page)!;
      if (!state.reloadUrl || page.url() !== state.reloadUrl) return;
      state.reloadUrl = null;
      // Reload only the main document's rejected GET after its site's wait.
      // Repeated limits stay in the background without spending model turns.
      await page.reload({ waitUntil: "domcontentloaded" });
    }
  }

  return { observe, waitForReady };
}
