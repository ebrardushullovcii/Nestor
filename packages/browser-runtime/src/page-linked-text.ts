import { withBrowserReadLiveness } from "./browser-read-liveness";
import type { Page } from "playwright";
import { isVisibleFrame, readVisibleText } from "./visible-page-text";
import { pageClickReferences } from "./page-control-refs";

/** Rendered words, link destinations and item boundaries, in document/frame order. */
export async function readPageLinkedText(page: Page): Promise<string> {
  return withBrowserReadLiveness(page, async () => {
    const refs = pageClickReferences(page);
    const root = await readVisibleText(page.locator("body"), true, refs);
    const children = await Promise.all(
      page
        .frames()
        .filter((frame) => frame !== page.mainFrame())
        .map(async (frame) => {
          try {
            return (await isVisibleFrame(frame))
              ? await readVisibleText(frame.locator("body"), true, refs)
              : "";
          } catch {
            return "[A child frame could not be read.]";
          }
        }),
    );
    return [root, ...children].filter(Boolean).join("\n\n");
  });
}
