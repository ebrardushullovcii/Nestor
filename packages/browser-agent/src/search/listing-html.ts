import {
  parse,
  serializeOuter,
  type DefaultTreeAdapterTypes as Tree,
} from "parse5";
import type { ListingCard } from "@nestor/contracts";
import { createHash } from "node:crypto";

type Node = Tree.Node;
type Element = Tree.Element;
const ignored = new Set([
  "script",
  "style",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "dialog",
  "template",
]);
const blocks = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "li",
  "ul",
  "ol",
  "h1",
  "h2",
  "h3",
  "h4",
  "br",
]);

export const fingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
const element = (node: Node): node is Element => "tagName" in node;
const attr = (node: Element, key: string): string =>
  node.attrs.find((a) => a.name === key)?.value ?? "";
function descendants(node: Node): Element[] {
  if (!("childNodes" in node)) return [];
  return node.childNodes.flatMap((child) =>
    element(child) ? [child, ...descendants(child)] : [],
  );
}
function textOf(node: Node): string {
  if (node.nodeName === "#text") return (node as Tree.TextNode).value;
  if (!element(node) && !("childNodes" in node)) return "";
  if (
    element(node) &&
    (ignored.has(node.tagName) ||
      node.attrs.some((a) => a.name === "hidden") ||
      attr(node, "aria-hidden") === "true")
  )
    return "";
  if (element(node) && node.tagName === "img") return attr(node, "alt");
  const text = "childNodes" in node ? node.childNodes.map(textOf).join("") : "";
  return element(node) && blocks.has(node.tagName) ? `\n${text}\n` : text;
}
const clean = (value: string): string =>
  value
    .replace(/[\t \f\r]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
const text = (node: Node): string => clean(textOf(node));
function link(node: Element, base: string): string | null {
  try {
    const url = new URL(attr(node, "href"), base);
    return /^https?:$/u.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Standard HTML semantics only; observed links, never synthesized board routes. */
export function readInventoryHtml(
  html: string,
  url: string,
  source: { id: string; label: string },
): {
  cards: ListingCard[];
  next: string[];
  needsInteraction: boolean;
} {
  const doc = parse(html);
  const nodes = descendants(doc);
  const cards = new Map<string, ListingCard>();
  const published: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if ([record["@type"]].flat().includes("JobPosting")) published.push(record);
    Object.values(record).forEach(visit);
  };
  for (const script of nodes.filter(
    (node) =>
      node.tagName === "script" && attr(node, "type") === "application/ld+json",
  )) {
    try {
      visit(
        JSON.parse(
          script.childNodes
            .map((child) =>
              child.nodeName === "#text" ? (child as Tree.TextNode).value : "",
            )
            .join(""),
        ),
      );
    } catch {
      /* Malformed published data does not prevent visible-card reading. */
    }
  }
  for (const job of published) {
    if (typeof job.title !== "string") continue;
    let href: string;
    try {
      href = new URL(typeof job.url === "string" ? job.url : url, url).href;
    } catch {
      continue;
    }
    if (!/^https?:/u.test(href)) continue;
    const body = JSON.stringify(job);
    cards.set(href, {
      url: href,
      title: job.title,
      text: body,
      cardFingerprint: fingerprint(body),
      sourceId: source.id,
      sourceLabel: source.label,
    });
  }
  for (const node of nodes) {
    if (
      !(
        node.tagName === "article" ||
        node.tagName === "li" ||
        attr(node, "role") === "listitem"
      )
    )
      continue;
    const children = descendants(node);
    const heading = children.find((child) => /^h[1-6]$/u.test(child.tagName));
    const anchor =
      heading &&
      (heading.tagName === "a"
        ? heading
        : descendants(heading).find((child) => child.tagName === "a"));
    if (!anchor) continue;
    const href = link(anchor, url),
      title = text(heading),
      body = text(node);
    if (!href || !title || body === title || body.length > 12000) continue;
    const paragraphs = children.filter((child) => child.tagName === "p");
    const companyNode =
      paragraphs.find((child) =>
        /(?:^|[-_\s])(?:company|employer)(?:$|[-_\s])/iu.test(
          attr(child, "class"),
        ),
      ) ??
      paragraphs.find(
        (child) => children.indexOf(child) < children.indexOf(heading),
      );
    const companyHint = companyNode ? text(companyNode) : "";
    const locationNode =
      paragraphs.find((child) =>
        /(?:^|[-_\s])(?:location|job-location)(?:$|[-_\s])/iu.test(
          attr(child, "class"),
        ),
      ) ??
      paragraphs.find(
        (child) => children.indexOf(child) > children.indexOf(heading),
      );
    cards.set(href, {
      url: href,
      title,
      text: body,
      sourceId: source.id,
      sourceLabel: source.label,
      ...(companyHint && companyHint.length < 180 ? { companyHint } : {}),
      ...(locationNode ? { locationHint: text(locationNode) } : {}),
      ...(attr(anchor, "data-job-id")
        ? { sourceJobId: attr(anchor, "data-job-id") }
        : {}),
      cardFingerprint: fingerprint([
        title,
        body.replace(/\b(?:\d+ days? ago|Today|Sponsored)\b/giu, ""),
      ]),
    });
  }
  const next = new Set<string>();
  for (const node of nodes.filter((node) => node.tagName === "a")) {
    const label = text(node).toLowerCase();
    let parent = node.parentNode;
    let inNavigation = false;
    while (parent && element(parent)) {
      if (parent.tagName === "nav" || attr(parent, "role") === "navigation") {
        inNavigation = true;
        break;
      }
      parent = parent.parentNode;
    }
    if (
      !attr(node, "rel").split(/\s/u).includes("next") &&
      !/^(?:next(?: page)?|load more|show more|more jobs)$/iu.test(label) &&
      !(inNavigation && /^\d+$/u.test(label))
    )
      continue;
    const href = link(node, url);
    if (href && new URL(href).origin === new URL(url).origin) next.add(href);
  }
  const needsInteraction = nodes.some(
    (node) =>
      (node.tagName === "button" || attr(node, "role") === "button") &&
      /^(?:load more|show more|more jobs|next(?: page)?)$/iu.test(text(node)),
  );
  return { cards: [...cards.values()], next: [...next], needsInteraction };
}

/** Preserve the whole semantic listing, including requirements outside JSON-LD. */
export function readListingHtml(
  html: string,
  expectedTitle: string,
): { text: string; html: string } {
  const doc = parse(html),
    nodes = descendants(doc);
  const articles = nodes.filter((node) => node.tagName === "article");
  const article = articles.find((node) =>
    descendants(node).some(
      (child) =>
        child.tagName === "h1" &&
        text(child).toLowerCase() === expectedTitle.toLowerCase(),
    ),
  );
  const root =
    article ??
    nodes.find(
      (node) => node.tagName === "main" || attr(node, "role") === "main",
    ) ??
    nodes.find((node) => node.tagName === "body") ??
    doc;
  return {
    text: text(root),
    html: element(root) ? serializeOuter(root) : html,
  };
}
