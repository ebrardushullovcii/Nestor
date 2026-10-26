import type {
  ListingCard,
  ListingSearchReader,
  SourceInventory,
} from "@nestor/contracts";
import { fingerprint } from "./listing-html";
import { htmlToPlainText } from "./listing-detail-extraction";
type Data = Record<string, unknown>;
export const ATS_FEED_PAGE_LIMIT = 250;
type Address = { board: string; endpoint: string; detail: string | null };
type Detail = {
  title: string;
  company: string;
  location: string;
  description: string;
  employmentType: string | null;
  postedAt: string | null;
  closed: boolean;
  remote?: boolean;
  hybrid?: boolean;
  sourceJobId?: string;
};
interface Adapter {
  provider: string;
  match(url: URL): Address | null;
  rows: string;
  total(data: Data): number | null;
  query?(offset: number): Record<string, unknown>;
  listUrl(address: Address): string;
  card(
    data: Data,
    row: Data,
    address: Address,
  ): {
    url: string;
    location: string;
    company?: string;
    id?: string;
    extra?: string;
  };
  detailUrl(address: Address): string;
  detail(data: Data, card: ListingCard): Detail;
}
const object = (value: unknown): Data =>
  value && typeof value === "object" ? (value as Data) : {};
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
const locations = (values: unknown): string =>
  [
    ...new Set(
      (Array.isArray(values) ? values : [values])
        .map((value) => {
          const row = object(value);
          return [string(row.city), string(row.region), string(row.country)]
            .filter(Boolean)
            .join(", ");
        })
        .filter(Boolean),
    ),
  ].join("; ");
const bodyText = (...sections: unknown[]): string =>
  sections
    .map((section) => htmlToPlainText(string(section)))
    .filter(Boolean)
    .join("\n\n");

/** Provider protocols, never employer-specific policy. */
const SOURCE_CAPABILITY_RULES: readonly Adapter[] = [
  {
    provider: "workday",
    match(url) {
      if (!/(?:^|\.)myworkdayjobs\.com$/iu.test(url.hostname)) return null;
      const parts = url.pathname.split("/").filter(Boolean),
        locale = /^[a-z]{2}-[A-Z]{2}$/u.test(parts[0] ?? "")
          ? parts.shift()
          : null,
        site = parts.shift();
      if (!site || (parts.length && parts[0] !== "job")) return null;
      return {
        board: new URL(`${locale ? `/${locale}` : ""}/${site}`, url).href,
        endpoint: new URL(
          `/wday/cxs/${encodeURIComponent(url.hostname.split(".")[0] ?? "")}/${encodeURIComponent(site)}`,
          url,
        ).href,
        detail: parts.length ? "/" + parts.join("/") : null,
      };
    },
    rows: "jobPostings",
    total(data) {
      if (
        typeof data.total !== "number" ||
        !Number.isSafeInteger(data.total) ||
        data.total < 0
      )
        throw new Error(
          "The public provider feed did not report its listing total.",
        );
      return data.total;
    },
    query: (offset) => ({
      appliedFacets: {},
      limit: 20,
      offset,
      searchText: "",
    }),
    listUrl: (address) => address.endpoint + "/jobs",
    card: (_data, row, address) => ({
      url: address.board + string(row.externalPath),
      location: string(row.locationsText),
      id: Array.isArray(row.bulletFields) ? string(row.bulletFields[0]) : "",
    }),
    detailUrl: (address) => address.endpoint + address.detail,
    detail(data) {
      const job = object(data.jobPostingInfo);
      return {
        title: string(job.title),
        company: string(object(data.hiringOrganization).name),
        location: string(job.location),
        description: bodyText(job.jobDescription),
        employmentType: string(job.timeType) || null,
        postedAt: string(job.startDate) || null,
        closed: job.canApply === false || job.posted === false,
        sourceJobId: string(job.jobReqId),
      };
    },
  },
  {
    provider: "workable",
    match(url) {
      if (url.hostname !== "apply.workable.com") return null;
      const parts = url.pathname.split("/").filter(Boolean);
      if (
        !parts[0] ||
        parts[0] === "api" ||
        (parts.length !== 1 && !(parts.length === 3 && parts[1] === "j"))
      )
        return null;
      return {
        board: new URL("/" + parts[0], url).href,
        endpoint: new URL(
          "/api/v1/widget/accounts/" + encodeURIComponent(parts[0]),
          url,
        ).href,
        detail: parts[2] ?? null,
      };
    },
    rows: "jobs",
    total: () => null,
    listUrl: (address) => address.endpoint,
    card: (data, row, address) => ({
      url: string(row.shortcode)
        ? address.board + "/j/" + encodeURIComponent(string(row.shortcode))
        : string(row.url),
      location:
        locations(row.locations) ||
        [row.city, row.country].map(string).filter(Boolean).join(", "),
      company: string(data.name),
      id: string(row.shortcode),
      extra: [
        string(row.employment_type),
        row.telecommuting === true ? "Remote" : "",
      ]
        .filter(Boolean)
        .join("\n"),
    }),
    detailUrl: (address) =>
      new URL(
        `/api/v2/accounts/${encodeURIComponent(new URL(address.board).pathname.slice(1))}/jobs/${encodeURIComponent(address.detail!)}`,
        address.board,
      ).href,
    detail(job, card) {
      return {
        title: string(job.title),
        company: card.companyHint ?? "",
        location: locations(job.locations) || locations(job.location),
        description: bodyText(job.description, job.requirements, job.benefits),
        remote: job.remote === true || job.workplace === "remote",
        hybrid: job.workplace === "hybrid",
        employmentType:
          (
            {
              full: "Full-time",
              part: "Part-time",
              contract: "Contract",
              temporary: "Temporary",
              internship: "Internship",
            } as Record<string, string>
          )[string(job.type)] ??
          (string(job.type) || null),
        postedAt: string(job.published) || null,
        closed: Boolean(job.state && job.state !== "published"),
      };
    },
  },
];
const boardOf = (url: string) => {
  for (const adapter of SOURCE_CAPABILITY_RULES) {
    const address = adapter.match(new URL(url));
    if (address) return { ...address, adapter };
  }
  return null;
};

export async function collectAtsFeed(
  input: ListingSearchReader & {
    source: { id: string; label: string; url: string };
    onPage?: (cards: ListingCard[]) => Promise<void> | void;
  },
): Promise<SourceInventory | null> {
  const board = boardOf(input.source.url);
  if (!board || board.detail) return null;
  const cards = new Map<string, ListingCard>();
  let pagesRead = 0,
    total: number | null = null;
  const issues = new Set<string>();
  for (let offset = 0; pagesRead < ATS_FEED_PAGE_LIMIT; ) {
    input.signal?.throwIfAborted();
    const jsonQuery = board.adapter.query?.(offset),
      page = await input.readPage(board.adapter.listUrl(board), {
        signal: input.signal,
        ...(jsonQuery ? { jsonQuery } : {}),
      });
    pagesRead++;
    const data = object(JSON.parse(page.html)),
      rows = data[board.adapter.rows];
    if (!Array.isArray(rows))
      throw new Error("The public provider feed did not return its listings.");
    const reported = board.adapter.total(data);
    if (reported !== null && total !== null && reported < total)
      issues.add("The reported total shrank during pagination.");
    total = reported === null ? null : Math.max(total ?? 0, reported);
    const fresh: ListingCard[] = [];
    for (const value of rows as unknown[]) {
      const row = object(value),
        title = string(row.title);
      let facts: ReturnType<Adapter["card"]>;
      try {
        facts = board.adapter.card(data, row, board);
        const url = new URL(facts.url);
        if (
          !title.trim() ||
          !board.adapter.match(url)?.detail ||
          url.origin !== new URL(board.board).origin
        )
          throw new Error("Invalid listing title or URL.");
      } catch {
        issues.add("A malformed listing was skipped.");
        continue;
      }
      const previous = cards.get(facts.url),
        location =
          previous?.locationHint && previous.locationHint !== facts.location
            ? [...new Set([previous.locationHint, facts.location])].join("; ")
            : facts.location;
      const card: ListingCard = {
        url: facts.url,
        title,
        text: [title, location, facts.extra].filter(Boolean).join("\n"),
        cardFingerprint: fingerprint(title.trim().toLowerCase()),
        sourceId: input.source.id,
        sourceLabel: input.source.label,
        locationHint: location,
        ...(facts.company ? { companyHint: facts.company } : {}),
        ...(facts.id ? { sourceJobId: facts.id } : {}),
      };
      cards.set(card.url, card);
      if (!previous) fresh.push(card);
    }
    await input.onPage?.(fresh);
    offset += rows.length;
    if (total === null || offset >= total || !rows.length || !fresh.length)
      break;
    if (pagesRead === ATS_FEED_PAGE_LIMIT)
      issues.add(
        `Pagination stopped at the ${ATS_FEED_PAGE_LIMIT}-page limit.`,
      );
  }
  if (total === null)
    issues.add(
      "The provider did not report a total; this page cannot prove complete coverage.",
    );
  const complete =
    cards.size > 0 &&
    total !== null &&
    cards.size >= total &&
    issues.size === 0;
  return {
    cards: [...cards.values()],
    lane: "http",
    provider: board.adapter.provider,
    pagesRead,
    complete,
    requiresBrowser: !complete,
    notes: [
      `${cards.size} distinct listings collected from ${pagesRead} public provider pages${total !== null ? `; ${total} reported by the site` : ""}; ${complete ? "all reported listings covered" : "coverage incomplete"}.`,
      ...issues,
    ],
  };
}

/** Only plausible cards need a full-body request. Provider facts avoid another model assessment. */
export async function readAtsListing(
  input: ListingSearchReader,
  card: ListingCard,
): Promise<ListingCard | null> {
  const board = boardOf(card.url);
  if (!board?.detail) return null;
  try {
    const page = await input.readPage(board.adapter.detailUrl(board), {
        signal: input.signal,
      }),
      data = object(JSON.parse(page.html)),
      facts = board.adapter.detail(data, card);
    if (
      !facts.title ||
      !facts.company ||
      !facts.description ||
      !compatibleTitles(facts.title, card.title)
    )
      return null;
    return {
      ...card,
      title: facts.title,
      listingText: [
        facts.title,
        facts.company,
        facts.location,
        facts.description,
      ]
        .filter(Boolean)
        .join("\n\n"),
      closed: facts.closed,
      ...(facts.sourceJobId ? { sourceJobId: facts.sourceJobId } : {}),
      providerFacts: {
        company: facts.company,
        location: facts.location,
        workModes: facts.remote ? ["remote"] : facts.hybrid ? ["hybrid"] : [],
        employmentType: facts.employmentType,
        salaryText: null,
        applyUrl: card.url,
        postedAt: facts.postedAt,
      },
    };
  } catch {
    input.signal?.throwIfAborted();
    return null;
  }
}

function compatibleTitles(a: string, b: string): boolean {
  const words = (value: string) =>
    new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const left = words(a),
    right = words(b);
  return (
    left.size > 0 &&
    right.size > 0 &&
    ([...left].every((word) => right.has(word)) ||
      [...right].every((word) => left.has(word)))
  );
}
