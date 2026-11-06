import type { ListingCard, SourceInventory } from "@nestor/contracts";
import type { Page } from "playwright";
import type { ApplyPageHands } from "../apply/types";
import { readInventoryHtml } from "./listing-html";

/** The same observed pagination labels used by the HTTP inventory reader. */
export const moreListingsLabel = (label: string): boolean =>
  /^(?:(?:load|show|view|see)\s+(?:\d+\s+)?more(?:\s+(?:jobs|roles|positions|vacancies|opportunities|results))?|more\s+(?:jobs|roles|positions|vacancies|opportunities|results)|next(?:\s+(?:page|results|jobs|positions|vacancies))?)(?:\s*[→›»]+)?$/iu.test(
    label.replace(/\s+/gu, " ").trim(),
  );

/** Collect semantic cards as each rendered batch arrives, before model work.
 * Ambiguous pages still go to the browser agent; no board routes are guessed.
 */
export async function collectRenderedInventory(input: {
  page: Pick<Page, "content" | "url">;
  hands: ApplyPageHands;
  source: { id: string; label: string };
  signal?: AbortSignal;
  allowUrl(url: string): boolean;
  onPage(cards: ListingCard[]): Promise<void>;
}): Promise<SourceInventory | null> {
  const cards = new Map<string, ListingCard>();
  const visited = new Set<string>();
  const pending = new Set<string>();
  let pagesRead = 0;
  const partial = (reason: string): SourceInventory => ({
    cards: [...cards.values()],
    lane: "browser",
    pagesRead,
    complete: false,
    notes: [
      reason +
        " Saved listings are kept; Continue unfinished sites checks remaining results.",
    ],
  });
  while (true) {
    input.signal?.throwIfAborted();
    const observation = await input.hands.observe();
    const url = input.page.url();
    const html = await input.page.content();
    const inventory = readInventoryHtml(html, url, input.source);
    if (observation.blocker || observation.loading)
      return cards.size ? partial("The next batch is not readable yet.") : null;
    if (!inventory.cards.length)
      return cards.size
        ? partial("The next page has no readable vacancy cards.")
        : null;
    pagesRead++;
    visited.add(url);
    pending.delete(url);
    for (const next of inventory.next)
      if (!visited.has(next) && input.allowUrl(next)) pending.add(next);
    const fresh = inventory.cards.filter((card) => !cards.has(card.url));
    for (const card of inventory.cards) cards.set(card.url, card);
    // The callback persists through the ordinary screen/read pipeline on its
    // own search signal. A later browser deadline cannot erase this batch.
    if (fresh.length) await input.onPage(fresh);
    if (inventory.needsInteraction) {
      const action = observation.actions.find(
        (action) =>
          action.visible && !action.disabled && moreListingsLabel(action.label),
      );
      if (!action)
        return partial(
          observation.actions.some(
            (action) =>
              action.visible &&
              action.disabled &&
              moreListingsLabel(action.label),
          )
            ? `${cards.size} listings; More is disabled and no loading indicator is present.`
            : "The remaining results control could not be resolved.",
        );
      input.signal?.throwIfAborted();
      const outcome = await input.hands.clickElement(action.ref);
      if (!outcome.ok)
        return partial("The remaining results control did not open its batch.");
      const before = JSON.stringify(
        inventory.cards.map(({ url, text }) => [url, text]),
      );
      let changed = false;
      while (true) {
        input.signal?.throwIfAborted();
        const next = readInventoryHtml(
          await input.page.content(),
          input.page.url(),
          input.source,
        );
        const view = await input.hands.observe();
        const moreStillPresent = view.actions.some(
          (action) => action.visible && moreListingsLabel(action.label),
        );
        if (
          (!next.needsInteraction && !moreStillPresent) ||
          JSON.stringify(next.cards.map(({ url, text }) => [url, text])) !==
            before
        ) {
          changed = true;
          break;
        }
        if (!view.loading) {
          if (
            view.actions.some(
              (action) =>
                action.visible &&
                action.disabled &&
                moreListingsLabel(action.label),
            )
          )
            return partial(
              `${cards.size} listings; More is disabled and no loading indicator is present.`,
            );
          break;
        }
        await input.hands.wait(500);
      }
      if (!changed) {
        return partial(
          "The site showed no new cards after the remaining-results control was clicked.",
        );
      }
      continue;
    }
    const next = pending.values().next().value;
    if (next) {
      input.signal?.throwIfAborted();
      const outcome = await input.hands.navigate(next);
      if (!outcome.ok)
        return partial("The observed next page could not be opened.");
      continue;
    }
    return {
      cards: [...cards.values()],
      lane: "browser",
      pagesRead,
      complete: true,
      notes: [
        `${cards.size} listings collected from ${pagesRead} rendered batches; every observed forward control is exhausted.`,
      ],
    };
  }
}
