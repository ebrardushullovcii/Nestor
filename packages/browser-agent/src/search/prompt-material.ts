/**
 * Page material for one-shot model reads, without the copies a page carries
 * of itself. Nothing here decides what a page says: each function drops only
 * text the same request already holds verbatim, so the model receives the
 * same facts in fewer tokens, and the stable instructions and the person's
 * facts stay a larger share of every request the provider can serve from its
 * prompt cache.
 */

/** Letters and digits only, lowercased: line breaks and spacing differ between two renderings of one page. */
function letters(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * True when every line of `text` already appears in `container`, ignoring
 * spacing, punctuation and where the lines break. A body extracted from a
 * page is then a copy of that page's text and adds nothing to it.
 */
export function textCoveredBy(text: string, container: string): boolean {
  if (!container.trim()) return false;
  const haystack = letters(container);
  return text
    .split("\n")
    .map(letters)
    .every((line) => !line || haystack.includes(line));
}

/** The shortest repeated block worth removing: three lines and a paragraph's length. */
const BLOCK_MIN_LINES = 3;
const BLOCK_MIN_CHARS = 200;

/**
 * The text with each block the page repeated verbatim kept once. A block is
 * three or more consecutive lines, together at least a paragraph long, that
 * already appeared in the same order earlier in this text (a page that
 * renders its body twice, a description pasted after itself). Single repeated
 * lines stay: a requirement listed under two headings says something about
 * each heading.
 */
export function withoutRepeatedBlocks(text: string): string {
  const lines = text.split("\n");
  const content = lines.flatMap((line, index) =>
    line.trim() ? [{ index, key: line.trim() }] : [],
  );
  if (content.length < BLOCK_MIN_LINES * 2) return text;
  const starts = new Map<string, number[]>();
  const removed = new Set<number>();
  for (let at = 0; at < content.length; ) {
    const key = content.at(at)?.key ?? "";
    let best = 0;
    for (const earlier of starts.get(key) ?? []) {
      let length = 0;
      while (
        at + length < content.length &&
        earlier + length < at &&
        content.at(at + length)?.key === content.at(earlier + length)?.key
      )
        length++;
      best = Math.max(best, length);
    }
    const chars = content
      .slice(at, at + best)
      .reduce((total, line) => total + line.key.length, 0);
    if (best >= BLOCK_MIN_LINES && chars >= BLOCK_MIN_CHARS) {
      const first = content.at(at)?.index ?? 0;
      const last = content.at(at + best - 1)?.index ?? first;
      for (let index = first; index <= last; index++) removed.add(index);
      at += best;
      continue;
    }
    if (key.length >= 20) starts.set(key, [...(starts.get(key) ?? []), at]);
    at++;
  }
  if (!removed.size) return text;
  return lines
    .filter((_, index) => !removed.has(index))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n");
}

/**
 * Links present on every page of a batch, in the first page's order, and
 * each page's remaining links. Site navigation then appears once per request
 * instead of once per page; a link on only some pages stays with them.
 */
export function splitLinksOnEveryPage<
  Link extends { label: string; url: string },
>(pages: readonly (readonly Link[])[]): { shared: Link[]; own: Link[][] } {
  const key = (link: Link) => `${link.label}\n${link.url}`;
  if (pages.length < 2)
    return { shared: [], own: pages.map((page) => [...page]) };
  const onEvery = pages.slice(1).reduce(
    (common, page) => {
      const present = new Set(page.map(key));
      return new Set([...common].filter((link) => present.has(link)));
    },
    new Set((pages.at(0) ?? []).map(key)),
  );
  const shared = (pages.at(0) ?? []).filter((link) => onEvery.has(key(link)));
  return {
    shared,
    own: pages.map((page) => page.filter((link) => !onEvery.has(key(link)))),
  };
}
