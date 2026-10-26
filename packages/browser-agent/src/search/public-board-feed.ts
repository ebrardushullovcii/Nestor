import type {
  ListingCard,
  ListingSearchReader,
  SourceInventory,
} from "@nestor/contracts";
import { htmlToPlainText } from "./listing-detail-extraction";
import { collectAtsFeed } from "./ats-public-feed";
import { fingerprint } from "./listing-html";

/** Provider protocols live here; orchestration never contains individual board rules. */
const SOURCE_CAPABILITY_RULES = [
  {
    provider: "greenhouse",
    hosts: ["boards.greenhouse.io", "job-boards.greenhouse.io"],
    endpoint:
      "https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true",
    metadata: "https://boards-api.greenhouse.io/v1/boards/{board}",
    items: "jobs",
    pageSize: 0,
  },
  {
    provider: "lever",
    hosts: ["jobs.lever.co"],
    endpoint:
      "https://api.lever.co/v0/postings/{board}?mode=json&limit=250&skip=0",
    metadata: null,
    items: null,
    pageSize: 250,
  },
  {
    provider: "lever",
    hosts: ["jobs.eu.lever.co"],
    endpoint:
      "https://api.eu.lever.co/v0/postings/{board}?mode=json&limit=250&skip=0",
    metadata: null,
    items: null,
    pageSize: 250,
  },
  {
    provider: "ashby",
    hosts: ["jobs.ashbyhq.com"],
    endpoint:
      "https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true",
    metadata: null,
    items: "jobs",
    pageSize: 0,
  },
];

export function publicBoardFeed(url: string) {
  const parsed = new URL(url),
    parts = parsed.pathname.split("/").filter(Boolean),
    token = parts[0];
  if (parts.length !== 1) return null;
  const adapter = SOURCE_CAPABILITY_RULES.find((rule) =>
    rule.hosts.includes(parsed.hostname),
  );
  if (!token || !adapter) return null;
  return {
    ...adapter,
    url: adapter.endpoint.replace("{board}", encodeURIComponent(token)),
    metadata:
      adapter.metadata?.replace("{board}", encodeURIComponent(token)) ?? null,
  };
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";

export async function collectPublicFeed(
  input: ListingSearchReader & {
    source: { id: string; label: string; url: string };
    onPage?: (cards: ListingCard[]) => Promise<void> | void;
  },
): Promise<SourceInventory | null> {
  const ats = await collectAtsFeed(input);
  if (ats) return ats;
  const feed = publicBoardFeed(input.source.url);
  if (!feed) return null;
  const rows: unknown[] = [];
  let pagesRead = 0;
  let next: string | null = feed.url;
  while (next) {
    const page = await input.readPage(next, { signal: input.signal });
    pagesRead++;
    const payload: unknown = JSON.parse(page.html),
      root = object(payload);
    const items: unknown = feed.items ? root[feed.items] : payload;
    if (!Array.isArray(items))
      throw new Error("Provider feed did not return a jobs array.");
    rows.push(...(items as unknown[]));
    if (feed.pageSize && items.length === feed.pageSize) {
      const pageUrl: URL = new URL(next);
      pageUrl.searchParams.set("skip", String(rows.length));
      next = pageUrl.href;
    } else next = null;
  }
  const companyEvidence = feed.metadata
    ? (await input.readPage(feed.metadata, { signal: input.signal })).html
    : ((
        await input.readPage(input.source.url, { signal: input.signal })
      ).html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? "");
  const company = feed.metadata
    ? string(object(JSON.parse(companyEvidence)).name)
    : htmlToPlainText(companyEvidence)
        .split("\n")[0]
        ?.replace(/\s*(?:[|–-]\s*)?(?:Jobs|Careers)\s*$/iu, "")
        .trim();
  pagesRead++;
  const cards = rows
    .filter((row) => object(row).isListed !== false)
    .map((row) => {
      const job = object(row),
        categories = object(job.categories),
        location = object(job.location);
      const title = string(job.title) || string(job.text);
      const url =
        string(job.absolute_url) || string(job.hostedUrl) || string(job.jobUrl);
      const sections = Array.isArray(job.lists)
        ? job.lists
            .map((value) => {
              const section = object(value);
              return `${string(section.text)}\n${htmlToPlainText(string(section.content))}`;
            })
            .join("\n\n")
        : "";
      const body = htmlToPlainText(
        string(job.content) ||
          string(job.descriptionHtml) ||
          string(job.descriptionPlain) ||
          string(job.description),
      );
      const listingText = [
        title,
        string(location.name) ||
          string(job.location) ||
          string(categories.location),
        body,
        sections,
        htmlToPlainText(string(job.additionalPlain) || string(job.additional)),
      ]
        .filter(Boolean)
        .join("\n\n");
      if (!title || !url || !/^https?:/u.test(url))
        throw new Error("Provider returned an invalid listing URL or title.");
      const text = JSON.stringify({
        id: job.id,
        title,
        location: job.location,
        categories,
        workplaceType: job.workplaceType,
        employmentType: job.employmentType,
        compensation: job.compensation,
        companyEvidence,
      });
      return {
        url,
        title,
        text,
        listingText,
        cardFingerprint: fingerprint(title.trim().toLowerCase()),
        ...(company && !/^(?:greenhouse|lever|ashby)$/iu.test(company)
          ? {
              providerFacts: {
                company,
                location:
                  string(location.name) ||
                  string(job.location) ||
                  string(categories.location),
                workModes:
                  /remote/iu.test(string(job.workplaceType)) ||
                  job.isRemote === true
                    ? ["remote" as const]
                    : /hybrid/iu.test(string(job.workplaceType))
                      ? ["hybrid" as const]
                      : [],
                employmentType:
                  string(job.employmentType) ||
                  string(categories.commitment) ||
                  null,
                salaryText:
                  htmlToPlainText(
                    string(object(job.salaryRange).description),
                  ) || null,
                applyUrl: string(job.applyUrl) || null,
                postedAt:
                  string(job.publishedAt) ||
                  (typeof job.createdAt === "number"
                    ? new Date(job.createdAt).toISOString()
                    : null),
              },
            }
          : {}),
        sourceId: input.source.id,
        sourceLabel: input.source.label,
        ...(typeof job.id === "string" || typeof job.id === "number"
          ? { sourceJobId: String(job.id) }
          : {}),
      };
    });
  await input.onPage?.(cards);
  return {
    cards,
    lane: "http",
    provider: feed.provider,
    pagesRead,
    complete: cards.length > 0,
    notes: [
      `${cards.length} listings collected from the public provider feed; ${cards.length ? "all reported listings covered" : "coverage incomplete: no listings were read"}.`,
    ],
  };
}
