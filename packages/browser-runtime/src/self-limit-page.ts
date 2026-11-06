import { forwardPageSelfLimitHit } from "@nestor/core";
import type { Page } from "playwright";

const watched = new WeakSet<Page>();
/** Includes messages from child frames; observing a page never changes it. */
export function watchPageSelfLimits(page: Page): void {
  if (watched.has(page) || typeof page.on !== "function") return;
  watched.add(page);
  page.on("console", (message) => forwardPageSelfLimitHit(message.text()));
}
