import { listingClosedReason } from "./listing-status";
import {
  parse,
  serializeOuter,
  type DefaultTreeAdapterTypes as Tree,
} from "parse5";
import type { ListingCard } from "@nestor/contracts";
import { createHash } from "node:crypto";
import { htmlToPlainText } from "./listing-detail-extraction";

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
function excluded(node: Element, excludeForms = true): boolean {
  for (
    let parent: Node | undefined = node;
    parent;
    parent =
      "parentNode" in parent ? (parent.parentNode ?? undefined) : undefined
  ) {
    if (
      element(parent) &&
      ((ignored.has(parent.tagName) &&
        (parent.tagName !== "form" || excludeForms)) ||
        attr(parent, "role") === "navigation" ||
        parent.attrs.some((a) => a.name === "hidden") ||
        attr(parent, "aria-hidden") === "true")
    )
      return true;
  }
  return false;
}

/** A login widget or script on a public page is not an access wall. */
export function listingSignInRequired(html: string): boolean {
  const nodes = descendants(parse(html));
  if (
    !nodes.some(
      (node) =>
        node.tagName === "input" &&
        attr(node, "type") === "password" &&
        !excluded(node, false),
    )
  )
    return false;
  const heading = nodes.find((node) => node.tagName === "h1");
  const body =
    nodes.find((node) => node.tagName === "main") ??
    nodes.find((node) => node.tagName === "body");
  return (
    /^(?:sign in|log in|login|authenticate|verify your)/iu.test(
      heading ? text(heading) : "",
    ) || Boolean(body && text(body).length < 1800)
  );
}

/** Read literal JSON arrays, never execute a site's JavaScript. */
function embeddedJobs(script: string): Record<string, unknown>[] {
  const jobs: Record<string, unknown>[] = [];
  for (const match of script.matchAll(
    /\b(?:const|var|let)\s+[\w$]+\s*=\s*(?=\[)/gu,
  )) {
    const start = match.index + match[0].length;
    let depth = 0,
      quoted = false,
      escaped = false;
    for (let at = start; at < script.length; at++) {
      const c = script[at];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "[") depth++;
      else if (c === "]" && --depth === 0) {
        try {
          const rows: unknown = JSON.parse(script.slice(start, at + 1));
          if (Array.isArray(rows))
            for (const row of rows)
              if (
                row &&
                typeof row === "object" &&
                "title" in row &&
                ("internal_job_id" in row ||
                  "employmentType" in row ||
                  "openings" in row)
              )
                jobs.push(row as Record<string, unknown>);
        } catch {
          /* Non-JSON application code needs the browser. */
        }
        break;
      }
    }
  }
  return jobs;
}
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
  portals: string[];
  needsInteraction: boolean;
} {
  const doc = parse(html);
  const nodes = descendants(doc);
  const cards = new Map<string, ListingCard>();
  const published: Record<string, unknown>[] = [];
  for (const script of nodes.filter((node) => node.tagName === "script")) {
    for (const job of embeddedJobs(
      script.childNodes
        .map((child) =>
          child.nodeName === "#text" ? (child as Tree.TextNode).value : "",
        )
        .join(""),
    )) {
      const address =
        job.absolute_url ?? job.jobUrl ?? job.hostedUrl ?? job.href;
      if (typeof job.title !== "string" || typeof address !== "string")
        continue;
      let href: string;
      try {
        href = new URL(address, url).href;
      } catch {
        continue;
      }
      if (!/^https?:/u.test(href)) continue;
      const listingText = htmlToPlainText(
        typeof job.content === "string"
          ? job.content
          : typeof job.description === "string"
            ? job.description
            : "",
      );
      if (!listingText) continue;
      cards.set(href, {
        url: href,
        title: job.title,
        text: job.title,
        listingText,
        sourceId: source.id,
        sourceLabel: source.label,
        cardFingerprint: fingerprint(job.title.trim().toLowerCase()),
        sourceJobId:
          typeof job.id === "string" || typeof job.id === "number"
            ? String(job.id)
            : href,
      });
    }
  }
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
    const identifier =
      job.identifier && typeof job.identifier === "object"
        ? (job.identifier as Record<string, unknown>).value
        : job.identifier;
    cards.set(href, {
      url: href,
      title: job.title,
      text: body,
      ...(listingClosedReason(
        "",
        typeof job.validThrough === "string" ? job.validThrough : null,
      )
        ? { closed: true }
        : {}),
      cardFingerprint: fingerprint(job.title.trim().toLowerCase()),
      sourceId: source.id,
      sourceLabel: source.label,
      ...(typeof identifier === "string" || typeof identifier === "number"
        ? { sourceJobId: String(identifier) }
        : {}),
      ...(published.length === 1 &&
      (href === url || readListingHtml(html, job.title).detailHeading)
        ? { listingPage: { html, finalUrl: url } }
        : {}),
    });
  }
  for (const node of nodes) {
    if (excluded(node)) continue;
    if (
      !(
        node.tagName === "article" ||
        node.tagName === "li" ||
        node.tagName === "a" ||
        attr(node, "role") === "listitem"
      )
    )
      continue;
    const children = descendants(node);
    const heading = children.find((child) => /^h[1-6]$/u.test(child.tagName));
    if (!heading) continue;
    const anchor =
      node.tagName === "a"
        ? node
        : descendants(heading).find((child) => child.tagName === "a");
    if (!anchor) continue;
    const href = link(anchor, url),
      title = text(heading),
      body = text(node);
    if (!href || !title || body === title) continue;
    // Editorial/product cards use the same article/heading markup. Require
    // observed vacancy semantics, never just a heading inside navigation.
    if (
      !/(?:job|position|vacanc|opening|posting)/iu.test(
        [href, attr(node, "class"), attr(node, "data-testid")].join(" "),
      ) &&
      !children.some((child) =>
        /(?:company|employer|location|job-location)/iu.test(
          attr(child, "class"),
        ),
      ) &&
      !/\b(?:remote|hybrid|on.?site|full.time|part.time|contract)\b/iu.test(
        body,
      )
    )
      continue;
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
    const publishedTime = children.find(
      (child) => child.tagName === "time" && attr(child, "datetime"),
    );
    let postedAt = publishedTime ? attr(publishedTime, "datetime") : "";
    if (!postedAt) {
      const ageNode = children.find((child) =>
        /(?:^|[-_\s])(?:age|posted|date-posted)(?:$|[-_\s])/iu.test(
          attr(child, "class"),
        ),
      );
      const age = ageNode ? text(ageNode).trim().toLowerCase() : "";
      const relative = age.match(
        /^(\d+)\s*(days?|d|weeks?|w|hours?|h|minutes?)\s*(?:ago)?$/iu,
      );
      if (relative) {
        const unit = relative[2] ?? "";
        const duration = /^w/iu.test(unit)
          ? 7 * 86400000
          : /^d/iu.test(unit)
            ? 86400000
            : /^h/iu.test(unit)
              ? 3600000
              : 60000;
        const timestamp = Date.now() - Number(relative[1]) * duration;
        if (
          Number.isFinite(timestamp) &&
          Math.abs(timestamp) <= 8640000000000000
        )
          postedAt = new Date(timestamp).toISOString();
      } else if (age === "today" || age === "yesterday")
        postedAt = new Date(
          Date.now() - (age === "yesterday" ? 86400000 : 0),
        ).toISOString();
    }
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
      ...(postedAt && Number.isFinite(Date.parse(postedAt))
        ? { postedAt: new Date(postedAt).toISOString() }
        : {}),
      // Profession screening reads the title, so an age or sponsored badge is not a new decision.
      cardFingerprint: fingerprint(title.trim().toLowerCase()),
      ...(/(?:^|[·|\n])\s*closed(?:\s|$)/iu.test(body) ||
      listingClosedReason(body)
        ? { closed: true }
        : {}),
    });
  }
  // A source can point at a vacancy itself, with no linked title/card around it.
  if (!cards.size) {
    const root =
      nodes.find(
        (node) => node.tagName === "main" || attr(node, "role") === "main",
      ) ?? nodes.find((node) => node.tagName === "body");
    const content = root ? descendants(root) : nodes;
    const headings = content.filter(
      (node) => node.tagName === "h1" && text(node),
    );
    const hasJobSections = content.some(
      (node) =>
        /^h[2-4]$/u.test(node.tagName) &&
        /(?:about (?:the |this )?(?:role|job|position)|job description|responsibilities|requirements|qualifications|what you|aufgaben|anforderungen|vos missions|profil recherch)/iu.test(
          text(node),
        ),
    );
    const hasApplyAction = content.some(
      (node) =>
        (node.tagName === "a" || node.tagName === "button") &&
        /^(?:apply(?: now| for (?:this |the )?(?:job|role|position))?|bewerben|jetzt bewerben|postuler|solicitar|応募する)$/iu.test(
          text(node).trim(),
        ),
    );
    const heading = headings.length === 1 ? headings[0] : undefined;
    if (heading && hasJobSections && hasApplyAction) {
      const title = text(heading),
        body = root ? text(root) : "";
      const field = (name: RegExp) =>
        content.find(
          (node) =>
            !excluded(node) &&
            name.test(
              [attr(node, "class"), attr(node, "itemprop")].join(" "),
            ) &&
            text(node).length < 180,
        );
      const siblings = heading.parentNode?.childNodes ?? [];
      const preceding = siblings
        .slice(0, siblings.indexOf(heading))
        .filter(element)
        .at(-1);
      // Many vacancies put employer and location together immediately above the title.
      // Read that observed byline, never the site's header or branding.
      const byline =
        preceding?.tagName === "p" ? text(preceding).split(/\s+[·|]\s+/u) : [];
      const employer = field(
        /(?:^|[\s_-])(?:company|employer|hiringOrganization)(?:$|[\s_-])/iu,
      );
      const place = field(/(?:^|[\s_-])(?:location|jobLocation)(?:$|[\s_-])/iu);
      const bylineEmployer = byline[0];
      const hasEmployerByline =
        byline.length >= 2 &&
        bylineEmployer &&
        bylineEmployer.toLowerCase() !== title.toLowerCase() &&
        !/^(?:home|careers|jobs|opportunities|remote|hybrid|on[ -]?site)$/iu.test(
          bylineEmployer,
        );
      const companyHint = employer
        ? text(employer)
        : hasEmployerByline
          ? bylineEmployer
          : undefined;
      const locationHint = place
        ? text(place)
        : hasEmployerByline
          ? byline[1]
          : undefined;
      if (
        body.length > title.length + 80 &&
        !/^(?:apply|sign in|log in|create (?:an )?account)\b/iu.test(title)
      )
        cards.set(url, {
          url,
          title,
          text: body,
          ...(companyHint ? { companyHint } : {}),
          ...(locationHint ? { locationHint } : {}),
          sourceId: source.id,
          sourceLabel: source.label,
          cardFingerprint: fingerprint(title.trim().toLowerCase()),
          listingPage: { html, finalUrl: url },
          ...(listingClosedReason(body) ? { closed: true } : {}),
        });
    }
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
  const portals = nodes
    .filter(
      (node) =>
        node.tagName === "a" &&
        /^(?:(?:view|see|explore|browse|search|find|check out)\s+)?(?:(?:all|our|current|available|open)\s+)*(?:open\s+)?(?:jobs|roles|positions|opportunities|vacancies)(?:\s+(?:here|now|at\b.*))?$/iu.test(
          text(node).trim(),
        ),
    )
    .flatMap((node) => {
      const href = link(node, url);
      return href && href !== url ? [href] : [];
    });
  if (!cards.size) {
    for (const heading of nodes.filter(
      (node) =>
        /^h[1-6]$/u.test(node.tagName) &&
        !excluded(node) &&
        /^(?:openings|jobs|positions|vacancies|opportunities)(?: by| in| across)\b/iu.test(
          text(node),
        ),
    )) {
      const parent = heading.parentNode;
      if (!parent || !("childNodes" in parent)) continue;
      const siblings = parent.childNodes;
      for (const sibling of siblings.slice(siblings.indexOf(heading) + 1)) {
        if (!element(sibling)) continue;
        if (!["ul", "ol"].includes(sibling.tagName)) break;
        const anchors = descendants(sibling).filter(
          (node) => node.tagName === "a" && !excluded(node),
        );
        // Counts distinguish opening directories from ordinary editorial lists.
        if (
          anchors.length < 2 ||
          !anchors.every((node) => /\d+\)?\s*$/u.test(text(node)))
        )
          break;
        for (const anchor of anchors) {
          const href = link(anchor, url);
          if (
            href &&
            href !== url &&
            new URL(href).origin === new URL(url).origin
          )
            portals.push(href);
        }
        break;
      }
    }
  }
  return {
    cards: [...cards.values()],
    next: [...next],
    portals: [...new Set(portals)],
    needsInteraction,
  };
}

/** Preserve the whole semantic listing, including requirements outside JSON-LD. */
export function readListingHtml(
  html: string,
  expectedTitle: string,
): {
  text: string;
  html: string;
  detailHeading: boolean;
  renderSuggested: boolean;
} {
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
  const detailHeading = descendants(root).some(
    (node) =>
      node.tagName === "h1" &&
      text(node).toLowerCase() === expectedTitle.toLowerCase(),
  );
  return {
    text: text(root),
    html: element(root) ? serializeOuter(root) : html,
    detailHeading,
    renderSuggested:
      !detailHeading &&
      nodes.some(
        (node) =>
          node.tagName === "script" &&
          attr(node, "type") !== "application/ld+json",
      ),
  };
}
