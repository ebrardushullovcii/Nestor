import { describeObservation } from "../apply/apply-prompts";
import type { ApplyFormObservation } from "../apply/types";

/**
 * How a search turn sees the page.
 *
 * The same page view as everywhere else, with the repeats taken out: a link
 * is listed once however many cards point at it, a link to a spot on the same
 * page is left out, and a heading or link label that holds a whole card is
 * cut to its first line (the card's text is in the page text already). Room
 * saved goes to more links, so every posting on a long results page has its
 * handle in view. Nothing is chosen by what it says, only by repetition and
 * address.
 */

const LINK_LIMIT = 150;
const LABEL_CHARS = 100;
const HEADING_CHARS = 120;

function firstLine(text: string, max: number): string {
  const line =
    text
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The address without its fragment, or null when it is not a web address. */
function withoutFragment(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

export function compactSearchObservation(
  observation: ApplyFormObservation,
): ApplyFormObservation {
  const page = observation.url ? withoutFragment(observation.url) : null;
  const seenHrefs = new Set<string>();
  const links = observation.links.flatMap((link) => {
    if (!link.visible) return [];
    const label = firstLine(link.label, LABEL_CHARS);
    if (!label) return [];
    // "Skip to content", "#" and other jumps within this same page.
    if (
      page &&
      link.href.includes("#") &&
      withoutFragment(link.href) === page
    )
      return [];
    if (seenHrefs.has(link.href)) return [];
    seenHrefs.add(link.href);
    return [{ ...link, label }];
  });
  const seenHeadings = new Set<string>();
  const headings = observation.headings.flatMap((heading) => {
    const text = firstLine(heading.text, HEADING_CHARS);
    if (!text || seenHeadings.has(text)) return [];
    seenHeadings.add(text);
    return [{ ...heading, text }];
  });
  const seenClickables = new Set<string>();
  const clickables = observation.clickables.flatMap((entry) => {
    if (!entry.visible) return [];
    const label = firstLine(entry.label, LABEL_CHARS);
    if (!label || seenClickables.has(label)) return [];
    seenClickables.add(label);
    return [{ ...entry, label }];
  });
  const actions = observation.actions.map((action) => ({
    ...action,
    label: firstLine(action.label, LABEL_CHARS),
  }));
  return { ...observation, links, headings, clickables, actions };
}

export function describeSearchObservation(
  observation: ApplyFormObservation,
): string {
  return describeObservation(compactSearchObservation(observation), {
    linkLimit: LINK_LIMIT,
  });
}

/**
 * Old tool answers are shortened once they are no longer among the newest
 * few. The search loop keeps its newest three answers whole
 * (SEARCH_KEEP_WHOLE_ANSWERS), so a view among the last two answers before
 * this one is still word for word in front of the model and is not sent
 * again.
 */
export const SEARCH_KEEP_WHOLE_ANSWERS = 3;
const UNCHANGED_VIEW_MAX_AGE = SEARCH_KEEP_WHOLE_ANSWERS - 1;

export const UNCHANGED_VIEW_NOTE =
  "The page is exactly as in your last look at it: same address, links and text. Use the handles from that view.";

/**
 * A describer that says "unchanged" instead of repeating a view the model
 * already has in full. `answersSoFar` counts the tool answers already given in
 * this run; `pinView` marks a view that is never shortened (the opening one).
 */
export function createSearchViewDescriber(answersSoFar: () => number) {
  let last: { text: string; at: number | null } | null = null;
  return {
    describe(observation: ApplyFormObservation): string {
      const text = describeSearchObservation(observation);
      if (
        last &&
        last.text === text &&
        (last.at === null || answersSoFar() - last.at <= UNCHANGED_VIEW_MAX_AGE)
      ) {
        return UNCHANGED_VIEW_NOTE;
      }
      last = { text, at: answersSoFar() };
      return text;
    },
    pinView(observation: ApplyFormObservation): string {
      const text = describeSearchObservation(observation);
      last = { text, at: null };
      return text;
    },
  };
}
