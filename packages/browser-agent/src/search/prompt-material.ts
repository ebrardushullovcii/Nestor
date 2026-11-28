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

/** Keep each distinct body inline and send verbatim repeated endings once. */
export function shareDescriptionEndings<
  T extends { id: number; description: string },
>(
  listings: readonly T[],
): {
  descriptionEndings: { ids: number[]; text: string }[];
  listings: T[];
} {
  const encoded = [...listings];
  const descriptionEndings: { ids: number[]; text: string }[] = [];
  const groups = new Map<string, { index: number; listing: T }[]>();
  for (const [index, listing] of listings.entries()) {
    const { description } = listing;
    const lastLine = description.slice(
      description.lastIndexOf("\n", description.trimEnd().length - 1) + 1,
    );
    const group = groups.get(lastLine);
    if (group) group.push({ index, listing });
    else groups.set(lastLine, [{ index, listing }]);
  }
  for (const group of groups.values()) {
    const [head, ...rest] = group;
    if (!head || !rest.length) continue;
    const first = head.listing.description;
    let common = first.length;
    for (const {
      listing: { description },
    } of rest) {
      common = Math.min(common, description.length);
      let length = 0;
      while (
        length < common &&
        first[first.length - length - 1] ===
          description[description.length - length - 1]
      )
        length++;
      common = length;
    }
    // Only move whole lines and leave the first line inline with its listing.
    const start = first.indexOf("\n", first.length - common);
    if (start < 0) continue;
    const text = first.slice(start);
    const ending = { ids: group.map(({ listing }) => listing.id), text };
    // Only use the representation when it pays for its own JSON fields.
    if (
      (JSON.stringify(text).length - 2) * group.length <=
      JSON.stringify({ descriptionEndings: [ending] }).length
    )
      continue;
    descriptionEndings.push(ending);
    for (const { index, listing } of group)
      encoded[index] = {
        ...listing,
        description: listing.description.slice(0, -text.length),
      };
  }
  return { descriptionEndings, listings: encoded };
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

/** Store verbatim runs of lines present on every page once, in page order. */
export function sharePageText(texts: readonly string[]): {
  shared: string[];
  pages: Array<string | Array<string | number>>;
} {
  const [first, ...rest] = texts;
  if (first === undefined || !rest.length)
    return { shared: [], pages: [...texts] };
  const linesOf = (text: string) => text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const leader = linesOf(first);
  const others = rest.map((text) => {
    const lines = linesOf(text);
    const positions = new Map<string, number[]>();
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      const found = positions.get(line);
      if (found) found.push(index);
      else positions.set(line, [index]);
    }
    return { lines, positions };
  });
  const shared: string[] = [];
  const byFirstLine = new Map<string, { id: number; count: number }>();
  for (let start = 0; start < leader.length; ) {
    const line = leader[start] ?? "";
    let count = leader.length - start;
    for (const { lines, positions } of others) {
      let longest = 0;
      for (const position of positions.get(line) ?? []) {
        let matched = 0;
        while (
          matched < count &&
          lines[position + matched] === leader[start + matched]
        )
          matched++;
        longest = Math.max(longest, matched);
      }
      count = longest;
      if (count < 2) break;
    }
    if (count < 2 || byFirstLine.has(line)) {
      start++;
      continue;
    }
    byFirstLine.set(line, { id: shared.length, count });
    shared.push(leader.slice(start, start + count).join(""));
    start += count;
  }
  const encode = (text: string) => {
    const lines = linesOf(text);
    const parts: Array<string | number> = [];
    let start = 0;
    for (let index = 0; index < lines.length; ) {
      const block = byFirstLine.get(lines[index] ?? "");
      if (
        !block ||
        lines.slice(index, index + block.count).join("") !== shared[block.id]
      ) {
        index++;
        continue;
      }
      if (index > start) parts.push(lines.slice(start, index).join(""));
      parts.push(block.id);
      index += block.count;
      start = index;
    }
    if (!parts.length) return text;
    if (start < lines.length) parts.push(lines.slice(start).join(""));
    return parts;
  };
  return { shared, pages: texts.map(encode) };
}
