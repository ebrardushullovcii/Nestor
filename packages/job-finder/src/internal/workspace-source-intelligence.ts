import { yieldToEventLoop } from "@nestor/core";
import { isDeepStrictEqual } from "node:util";
import {
  readDiscoveryPreparation,
  readPreparedMatchAssessmentPostingFingerprint,
  computeMatchAssessmentPostingFingerprint,
  JobPostingSchema,
  SourceIntelligenceArtifactSchema,
  type SourceIntelligenceArtifact,
  type JobDiscoveryCollectionMethod,
  type JobDiscoveryTarget,
  type JobPosting,
  type JobSource,
  type SourceDebugWorkerAttempt,
  type SourceInstructionArtifact,
} from "@nestor/contracts";
import { isExplicitSearchProbeDisproof } from "./source-instruction-evidence";
import { normalizeText, uniqueStrings } from "./shared";
import {
  DISCOVERY_READER_LOST_ERROR,
  type DiscoveryFeedTask,
  type DiscoveryFeedResult,
} from "@nestor/contracts";
import {
  getDiscoveryFeedExecutor,
  rememberPreparedDiscoveryPosting,
} from "./discovery-feed-executor";
import { toProviderAwarePosting } from "./discovery-posting-normalization";
import {
  rememberPreparedListingContent,
  prepareJobIdentity,
  rememberPreparedJobIdentity,
} from "./job-identity";
import {
  prepareDiscoveryPosting,
  prepareBodySalaryRange,
  rememberPreparedBodySalaryRange,
} from "./discovery-posting-preparation";
import {
  createDiscoveryListingFingerprints,
  rememberDiscoveryListingFingerprints,
} from "./workspace-discovery-ledger";

type PublicApiFieldPath = readonly string[];
type PublicApiFieldSelector = readonly PublicApiFieldPath[];
type PublicApiResponseAdapter = {
  itemsPath: PublicApiFieldPath | null;
  itemsShape?: "array" | "single";
  invalidPayloadMessage: string;
  fields: {
    sourceJobId: PublicApiFieldSelector;
    title: PublicApiFieldSelector;
    canonicalUrl: PublicApiFieldSelector;
    applicationUrl?: PublicApiFieldSelector;
    location?: PublicApiFieldSelector;
    description?: PublicApiFieldSelector;
    additionalDescription?: PublicApiFieldSelector;
    descriptionSections?: PublicApiFieldPath;
    postedAt?: PublicApiFieldSelector;
    updatedAt?: PublicApiFieldSelector;
    workplaceType?: PublicApiFieldSelector;
    employmentType?: PublicApiFieldSelector;
    department?: PublicApiFieldSelector;
    team?: PublicApiFieldSelector;
  };
};

type NormalizedPublicApiJobRecord = {
  sourceJobId: string | null;
  title: string | null;
  canonicalUrl: string | null;
  applicationUrl: string | null;
  location: string | null;
  description: string | null;
  workplaceType: string | null;
  postedAtValue: string | number | null;
  providerUpdatedAtValue: string | number | null;
  employmentType: string | null;
  department: string | null;
  team: string | null;
};

type ResolvedSourceCapability = {
  key: "greenhouse" | "lever" | "linkedin" | "ashby" | "workday" | "icims";
  label: string;
  confidence: number;
  apiAvailability: "available" | "not_supported" | "unconfirmed";
  publicApiUrlTemplate: string | null;
  boardToken: string | null;
  boardSlug: string | null;
  providerIdentifier: string;
};

type SourceCapabilityRule = {
  key: ResolvedSourceCapability["key"];
  label: ResolvedSourceCapability["label"];
  confidence: ResolvedSourceCapability["confidence"];
  apiAvailability: ResolvedSourceCapability["apiAvailability"];
  hostnames: {
    exact?: readonly string[];
    suffixes?: readonly string[];
    contains?: readonly string[];
  };
  resolve: (url: URL) =>
    | (Omit<
        ResolvedSourceCapability,
        "key" | "label" | "confidence" | "apiAvailability"
      > & {
        apiAvailability?: ResolvedSourceCapability["apiAvailability"];
      })
    | null;
};

const PUBLIC_API_RESPONSE_ADAPTERS = {
  greenhouse: {
    itemsPath: ["jobs"],
    invalidPayloadMessage: "Public provider API returned an invalid payload.",
    fields: {
      sourceJobId: [["id"]],
      title: [["title"]],
      canonicalUrl: [["absolute_url"]],
      applicationUrl: [["absolute_url"]],
      location: [["location", "name"]],
      description: [["content"]],
      // Greenhouse board feeds only expose `updated_at` (last provider touch),
      // never the original first-published date, so it maps to
      // `providerUpdatedAt` and `postedAt` stays null instead of mislabeling
      // an update time as a posting date.
      updatedAt: [["updated_at"]],
    },
  },
  lever: {
    itemsPath: null,
    invalidPayloadMessage: "Public provider API returned an invalid payload.",
    fields: {
      sourceJobId: [["id"]],
      title: [["text"]],
      canonicalUrl: [["hostedUrl"]],
      applicationUrl: [["applyUrl"], ["hostedUrl"]],
      location: [["categories", "location"]],
      description: [["descriptionPlain"], ["description"]],
      additionalDescription: [["additionalPlain"], ["additional"]],
      descriptionSections: ["lists"],
      postedAt: [["createdAt"]],
      workplaceType: [["workplaceType"]],
      employmentType: [["categories", "commitment"]],
      department: [["categories", "department"]],
      team: [["categories", "team"]],
    },
  },
  ashby: {
    itemsPath: ["jobs"],
    invalidPayloadMessage: "Public provider API returned an invalid payload.",
    fields: {
      sourceJobId: [["id"]],
      title: [["title"]],
      canonicalUrl: [["jobUrl"]],
      applicationUrl: [["applyUrl"], ["jobUrl"]],
      location: [["location"]],
      description: [["descriptionPlain"], ["descriptionHtml"]],
      postedAt: [["publishedAt"]],
      workplaceType: [["workplaceType"]],
      employmentType: [["employmentType"]],
      department: [["department"]],
      team: [["team"]],
    },
  },
  workday: {
    itemsPath: ["jobPostingInfo"],
    itemsShape: "single",
    invalidPayloadMessage: "Public provider API returned an invalid payload.",
    fields: {
      sourceJobId: [["jobReqId"]],
      title: [["title"]],
      canonicalUrl: [["externalUrl"]],
      applicationUrl: [["applyUrl"], ["externalUrl"]],
      location: [["location"]],
      description: [["jobDescription"]],
      postedAt: [["startDate"]],
      employmentType: [["timeType"]],
    },
  },
} satisfies Record<string, PublicApiResponseAdapter>;

const SOURCE_CAPABILITY_RULES = [
  {
    key: "greenhouse",
    label: "Greenhouse",
    confidence: 0.95,
    apiAvailability: "available",
    hostnames: {
      exact: ["boards.greenhouse.io", "job-boards.greenhouse.io"],
    },
    resolve(url: URL) {
      const boardKey = url.pathname.split("/").filter(Boolean)[0] ?? null;
      if (!boardKey) {
        return null;
      }

      return {
        publicApiUrlTemplate: `https://boards-api.greenhouse.io/v1/boards/${boardKey}/jobs?content=true`,
        boardToken: boardKey,
        boardSlug: null,
        providerIdentifier: boardKey,
      };
    },
  },
  {
    key: "lever",
    label: "Lever",
    confidence: 0.95,
    apiAvailability: "available",
    hostnames: {
      suffixes: ["lever.co"],
    },
    resolve(url: URL) {
      const boardKey = url.pathname.split("/").filter(Boolean)[0] ?? null;
      if (!boardKey) {
        return null;
      }
      const apiHostname = url.hostname
        .toLocaleLowerCase()
        .endsWith(".eu.lever.co")
        ? "api.eu.lever.co"
        : "api.lever.co";

      return {
        publicApiUrlTemplate: `https://${apiHostname}/v0/postings/${boardKey}?mode=json`,
        boardToken: null,
        boardSlug: boardKey,
        providerIdentifier: boardKey,
      };
    },
  },
  {
    key: "linkedin",
    label: "LinkedIn Jobs",
    confidence: 0.98,
    apiAvailability: "not_supported",
    hostnames: {
      suffixes: ["linkedin.com"],
    },
    resolve() {
      return {
        publicApiUrlTemplate: null,
        boardToken: null,
        boardSlug: null,
        providerIdentifier: "linkedin_jobs",
      };
    },
  },
  {
    key: "ashby",
    label: "Ashby",
    confidence: 0.85,
    apiAvailability: "available",
    hostnames: {
      suffixes: ["ashbyhq.com"],
    },
    resolve(url: URL) {
      const boardSlug = url.pathname.split("/").filter(Boolean)[0] ?? null;
      if (!boardSlug) {
        return null;
      }
      return {
        publicApiUrlTemplate: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(boardSlug)}`,
        boardToken: null,
        boardSlug,
        providerIdentifier: boardSlug,
      };
    },
  },
  {
    key: "workday",
    label: "Workday",
    confidence: 0.84,
    apiAvailability: "unconfirmed",
    hostnames: {
      suffixes: ["myworkdayjobs.com"],
    },
    resolve(url: URL) {
      const hostname = url.hostname.toLowerCase();
      const pathSegments = url.pathname.split("/").filter(Boolean);
      const jobSegmentIndex = pathSegments.findIndex(
        (segment) => segment.toLowerCase() === "job",
      );
      const siteId =
        jobSegmentIndex > 0
          ? (pathSegments[jobSegmentIndex - 1] ?? null)
          : null;
      const jobPath =
        jobSegmentIndex >= 0
          ? pathSegments.slice(jobSegmentIndex + 1).join("/")
          : "";
      const tenant = hostname.split(".")[0] ?? null;
      const hasExactJobApi = Boolean(tenant && siteId && jobPath);
      return {
        apiAvailability: hasExactJobApi ? "available" : "unconfirmed",
        publicApiUrlTemplate: hasExactJobApi
          ? `https://${hostname}/wday/cxs/${encodeURIComponent(tenant!)}/${encodeURIComponent(siteId!)}/job/${jobPath.split("/").map(encodeUrlPathSegment).join("/")}`
          : null,
        boardToken: null,
        boardSlug: siteId,
        providerIdentifier: hostname,
      };
    },
  },
  {
    key: "icims",
    label: "iCIMS",
    confidence: 0.82,
    apiAvailability: "not_supported",
    hostnames: {
      suffixes: ["icims.com", "icims.eu"],
    },
    resolve(url: URL) {
      const hostname = url.hostname.toLowerCase();
      return {
        publicApiUrlTemplate: null,
        boardToken: null,
        boardSlug: null,
        providerIdentifier: hostname,
      };
    },
  },
] satisfies readonly SourceCapabilityRule[];

function matchesSourceCapabilityHostname(
  hostname: string,
  rule: SourceCapabilityRule,
): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return Boolean(
    rule.hostnames.exact?.includes(normalizedHostname) ||
    rule.hostnames.suffixes?.some(
      (suffix) =>
        normalizedHostname === suffix ||
        normalizedHostname.endsWith(`.${suffix}`),
    ) ||
    rule.hostnames.contains?.some((fragment) =>
      normalizedHostname.includes(fragment),
    ),
  );
}

export type ReusableRouteKind =
  SourceIntelligenceArtifact["collection"]["startingRoutes"][number]["kind"];

const LISTING_ROUTE_KEYWORDS = [
  "job",
  "jobs",
  "career",
  "careers",
  "opening",
  "openings",
  "position",
  "positions",
  "vacancy",
  "vacancies",
  "konkurs",
  "pune",
  "pozit",
  "karriere",
  "apliko",
];

function parseOptionalString(value: unknown): { value: string } | null {
  return typeof value === "string" ? { value } : null;
}

function parseNullableString(value: unknown): { value: string | null } | null {
  if (value == null) {
    return { value: null };
  }

  return typeof value === "string" ? { value } : null;
}

function parseNullableStringOrNumber(
  value: unknown,
): { value: string | number | null } | null {
  if (value == null) {
    return { value: null };
  }

  if (typeof value === "string") {
    return { value };
  }

  return typeof value === "number" && Number.isFinite(value) ? { value } : null;
}

function getValueAtPath(
  value: unknown,
  path: readonly string[] | null,
): unknown {
  if (path == null) {
    return value;
  }

  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function getFirstValueAtPaths(
  record: Record<string, unknown>,
  selectors: PublicApiFieldSelector | undefined,
): unknown {
  if (!selectors) {
    return undefined;
  }

  for (const path of selectors) {
    const value = getValueAtPath(record, path);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

type ParsedPublicApiRecordArray = {
  records: Record<string, unknown>[];
  skippedMalformedCount: number;
};

/**
 * Parses the provider item collection one entry at a time: isolated malformed
 * records are skipped and counted so a single bad entry cannot hide an entire
 * board, while a wrong payload shape (or a payload where nothing usable
 * remains) still fails loudly. No partial-skip threshold is applied beyond
 * that; any number of usable records is worth returning.
 */
function parsePublicApiRecordArray(
  value: unknown,
  adapter: PublicApiResponseAdapter,
): ParsedPublicApiRecordArray {
  const itemsValue = getValueAtPath(value, adapter.itemsPath);
  if (itemsValue == null) {
    return { records: [], skippedMalformedCount: 0 };
  }

  if (adapter.itemsShape === "single") {
    if (
      !itemsValue ||
      typeof itemsValue !== "object" ||
      Array.isArray(itemsValue)
    ) {
      throw new Error(adapter.invalidPayloadMessage);
    }
    return {
      records: [itemsValue as Record<string, unknown>],
      skippedMalformedCount: 0,
    };
  }

  if (!Array.isArray(itemsValue)) {
    throw new Error(adapter.invalidPayloadMessage);
  }

  const records: Record<string, unknown>[] = [];
  let skippedMalformedCount = 0;
  for (const item of itemsValue) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      skippedMalformedCount += 1;
      continue;
    }

    records.push(item as Record<string, unknown>);
  }

  if (records.length === 0 && skippedMalformedCount > 0) {
    throw new Error(adapter.invalidPayloadMessage);
  }

  return { records, skippedMalformedCount };
}

function parsePublicApiJobRecords(
  value: unknown,
  adapter: PublicApiResponseAdapter,
): {
  records: NormalizedPublicApiJobRecord[];
  skippedMalformedCount: number;
} {
  const { records, skippedMalformedCount } = parsePublicApiRecordArray(
    value,
    adapter,
  );

  return {
    records: records.map((record) => {
      const sourceJobIdValue = getFirstValueAtPaths(
        record,
        adapter.fields.sourceJobId,
      );
      const sourceJobId =
        typeof sourceJobIdValue === "string" ||
        typeof sourceJobIdValue === "number"
          ? String(sourceJobIdValue)
          : null;

      const descriptionParts = [
        parseNullableString(
          getFirstValueAtPaths(record, adapter.fields.description),
        )?.value ?? null,
        parseNullableString(
          getFirstValueAtPaths(record, adapter.fields.additionalDescription),
        )?.value ?? null,
        ...parsePublicApiDescriptionSections(
          getValueAtPath(record, adapter.fields.descriptionSections ?? null),
        ),
      ].filter((part): part is string => Boolean(part?.trim()));

      return {
        sourceJobId,
        title:
          parseOptionalString(
            getFirstValueAtPaths(record, adapter.fields.title),
          )?.value ?? null,
        canonicalUrl:
          parseOptionalString(
            getFirstValueAtPaths(record, adapter.fields.canonicalUrl),
          )?.value ?? null,
        applicationUrl:
          parseNullableString(
            getFirstValueAtPaths(record, adapter.fields.applicationUrl),
          )?.value ?? null,
        location:
          parseNullableString(
            getFirstValueAtPaths(record, adapter.fields.location),
          )?.value ?? null,
        description: descriptionParts.join("\n\n") || null,
        workplaceType:
          parseNullableString(
            getFirstValueAtPaths(record, adapter.fields.workplaceType),
          )?.value ?? null,
        postedAtValue:
          parseNullableStringOrNumber(
            getFirstValueAtPaths(record, adapter.fields.postedAt),
          )?.value ?? null,
        providerUpdatedAtValue:
          parseNullableStringOrNumber(
            getFirstValueAtPaths(record, adapter.fields.updatedAt),
          )?.value ?? null,
        employmentType:
          parseNullableString(
            getFirstValueAtPaths(record, adapter.fields.employmentType),
          )?.value ?? null,
        department:
          parseNullableString(
            getFirstValueAtPaths(record, adapter.fields.department),
          )?.value ?? null,
        team:
          parseNullableString(getFirstValueAtPaths(record, adapter.fields.team))
            ?.value ?? null,
      };
    }),
    skippedMalformedCount,
  };
}

function parsePublicApiDescriptionSections(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const heading = typeof record.text === "string" ? record.text.trim() : "";
    const contentValue =
      typeof record.contentPlain === "string"
        ? record.contentPlain
        : typeof record.content === "string"
          ? record.content
          : "";
    const content = contentValue.trim();
    if (!heading && !content) {
      return [];
    }

    return [[heading, content].filter(Boolean).join("\n")];
  });
}

function tryParseUrl(value: string | null | undefined): URL | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function extractUrlsFromText(text: string): string[] {
  return (text.match(/https?:\/\/[^\s)\]>",]+/gi) ?? []).map((match) =>
    match.replace(/[.,;:!?)\]>"]+$/g, ""),
  );
}

function extractSameHostUrls(
  target: JobDiscoveryTarget,
  lines: readonly string[],
) {
  const anchorUrl = tryParseUrl(target.startingUrl);
  if (!anchorUrl) {
    return [] as string[];
  }

  const values = lines.flatMap((line) =>
    extractUrlsFromText(line).flatMap((candidate) => {
      const parsed = tryParseUrl(candidate);
      if (!parsed || parsed.hostname !== anchorUrl.hostname) {
        return [];
      }

      parsed.hash = "";
      return [parsed.toString()];
    }),
  );

  return uniqueStrings(values);
}

function detectProvider(target: JobDiscoveryTarget, urls: readonly string[]) {
  const parsedUrls = [target.startingUrl, ...urls].flatMap((value) => {
    const parsed = tryParseUrl(value);
    return parsed ? [parsed] : [];
  });

  for (const parsedUrl of parsedUrls) {
    for (const rule of SOURCE_CAPABILITY_RULES) {
      if (!matchesSourceCapabilityHostname(parsedUrl.hostname, rule)) {
        continue;
      }

      const resolved = rule.resolve(parsedUrl);
      if (!resolved) {
        continue;
      }

      return {
        key: rule.key,
        label: rule.label,
        confidence: rule.confidence,
        apiAvailability: rule.apiAvailability,
        ...resolved,
      };
    }
  }

  return null;
}

function encodeUrlPathSegment(value: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(value));
  } catch {
    return encodeURIComponent(value);
  }
}

function decodeRoutePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname).toLowerCase();
  } catch {
    return pathname.toLowerCase();
  }
}

function isBrokenOrTemplatedRoutePath(
  pathname: string,
  search: string,
): boolean {
  const routeText = `${pathname}${search}`;
  return (
    /(^|\/)404($|\/)/.test(pathname) ||
    routeText.includes("not-found") ||
    /(^|\/)\{[^/]+\}($|\/)/.test(pathname) ||
    /(^|\/):[a-z0-9_-]+($|\/)/i.test(pathname) ||
    // A query placeholder ("?keywords=:keyword", "?q={query}") is a template.
    /[?&][^=&]+=(?::|%3a|\{|%7b)/i.test(search)
  );
}

function inferRouteKind(url: string): ReusableRouteKind {
  const parsed = tryParseUrl(url);
  const pathname = decodeRoutePathname(parsed?.pathname ?? "");
  const search = (parsed?.search ?? "").toLowerCase();
  const normalized = normalizeText(`${pathname} ${search}`);
  const pathSegments = pathname.split("/").filter(Boolean);
  const leafSegment = pathSegments[pathSegments.length - 1] ?? "";
  const parentSegment = pathSegments[pathSegments.length - 2] ?? "";

  if (isBrokenOrTemplatedRoutePath(pathname, search)) {
    return "detail";
  }

  if (
    pathname.includes("search") ||
    pathname.includes("filter") ||
    search.includes("search")
  ) {
    return "search";
  }

  if (
    pathname.includes("collection") ||
    pathname.includes("recommended") ||
    pathname.includes("recommendation")
  ) {
    return "collection";
  }

  if (pathname.includes("apply")) {
    return "apply";
  }

  if (
    pathname.includes("/view/") ||
    ([
      "job",
      "jobs",
      "opening",
      "openings",
      "position",
      "positions",
      "role",
      "roles",
    ].includes(parentSegment) &&
      ![
        "search",
        "filter",
        "filters",
        "results",
        "recommended",
        "recommendations",
        "collection",
        "collections",
        "curated",
        "all",
        "list",
        "listing",
        "listings",
        "careers",
        "jobs",
        "openings",
        "positions",
        "roles",
      ].includes(leafSegment))
  ) {
    return "detail";
  }

  if (LISTING_ROUTE_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return "listing";
  }

  return "anchor";
}

/**
 * The kind the model gave a route stands (ADR 0041); the address only fills in
 * when nothing said what the route is.
 */
export function resolveRouteKindForReuse(
  url: string,
  preferredKind: ReusableRouteKind | null = null,
): ReusableRouteKind {
  return preferredKind ?? inferRouteKind(url);
}

export function canonicalizeRouteForReuse(
  value: string,
  anchorUrl: URL | null,
): string | null {
  const parsed = tryParseUrl(value);
  if (!parsed) {
    return null;
  }

  if (anchorUrl && parsed.hostname !== anchorUrl.hostname) {
    return null;
  }

  for (const key of [
    "currentJobId",
    "selectedJobId",
    "jobId",
    "trk",
    "trackingId",
  ]) {
    parsed.searchParams.delete(key);
  }

  parsed.hash = "";

  const pathname = decodeRoutePathname(parsed.pathname);
  const search = parsed.search.toLowerCase();
  if (isBrokenOrTemplatedRoutePath(pathname, search)) {
    return null;
  }

  return parsed.toString();
}

export function shouldKeepRouteForReuse(input: {
  url: string;
  kind: ReturnType<typeof inferRouteKind>;
  targetStartingUrl: string;
}): boolean {
  if (input.url === input.targetStartingUrl) {
    return true;
  }

  return (
    input.kind === "search" ||
    input.kind === "collection" ||
    input.kind === "listing"
  );
}

function uniqueRoutes(
  routes: Array<{
    url: string;
    label: string;
    kind: "anchor" | "listing" | "search" | "detail" | "apply" | "collection";
    confidence: number;
  }>,
) {
  const seen = new Set<string>();

  return routes.flatMap((route) => {
    if (seen.has(route.url)) {
      return [];
    }

    seen.add(route.url);
    return [route];
  });
}

function inferPreferredCollectionMethod(
  provider: SourceIntelligenceArtifact["provider"],
  routes: readonly { kind: string }[],
  existing: SourceInstructionArtifact | null,
): JobDiscoveryCollectionMethod {
  const forced = existing?.intelligence.overrides.forceMethod ?? null;
  if (forced) {
    return forced;
  }

  if (provider?.apiAvailability === "available") {
    return "api";
  }

  if (routes.some((route) => route.kind === "search")) {
    return "listing_route";
  }

  if (
    routes.some(
      (route) => route.kind === "listing" || route.kind === "collection",
    )
  ) {
    return "careers_page";
  }

  return "fallback_search";
}

function inferApplyPath(
  attempts: readonly SourceDebugWorkerAttempt[],
  existing: SourceInstructionArtifact | null,
) {
  const combinedText = normalizeText(
    [
      ...(existing?.applyGuidance ?? []),
      ...attempts.flatMap((attempt) => attempt.confirmedFacts),
    ].join(" "),
  );

  if (
    combinedText.includes("easy apply") ||
    combinedText.includes("inline apply")
  ) {
    return "easy_apply" as const;
  }

  if (
    combinedText.includes("redirect") ||
    combinedText.includes("company site")
  ) {
    return "external_redirect" as const;
  }

  return "unknown" as const;
}

export function buildSourceIntelligenceArtifact(input: {
  target: JobDiscoveryTarget;
  attempts: readonly SourceDebugWorkerAttempt[];
  currentArtifact: SourceInstructionArtifact | null;
}) {
  const routeLines = input.attempts.flatMap((attempt) => [
    ...attempt.confirmedFacts,
    ...(attempt.phaseEvidence?.routeSignals ?? []),
  ]);
  const discoveredUrls = extractSameHostUrls(input.target, routeLines);
  const anchorUrl = tryParseUrl(input.target.startingUrl);
  const provider =
    input.currentArtifact?.intelligence.provider ??
    detectProvider(input.target, discoveredUrls);
  const startingRoutes = uniqueRoutes([
    {
      url: input.target.startingUrl,
      label: "Starting URL",
      kind: inferRouteKind(input.target.startingUrl),
      confidence: 0.6,
    },
    ...(
      input.currentArtifact?.intelligence.collection.startingRoutes ?? []
    ).flatMap((route) => {
      const normalizedUrl = canonicalizeRouteForReuse(route.url, anchorUrl);
      if (!normalizedUrl) {
        return [];
      }

      const normalizedKind = resolveRouteKindForReuse(
        normalizedUrl,
        route.kind,
      );
      return shouldKeepRouteForReuse({
        url: normalizedUrl,
        kind: normalizedKind,
        targetStartingUrl: input.target.startingUrl,
      })
        ? [{ ...route, url: normalizedUrl, kind: normalizedKind }]
        : [];
    }),
    ...discoveredUrls.flatMap((url) => {
      const normalizedUrl = canonicalizeRouteForReuse(url, anchorUrl);
      if (!normalizedUrl) {
        return [];
      }

      const kind = inferRouteKind(normalizedUrl);
      return shouldKeepRouteForReuse({
        url: normalizedUrl,
        kind,
        targetStartingUrl: input.target.startingUrl,
      })
        ? [
            {
              url: normalizedUrl,
              label: "Observed route",
              kind,
              confidence: 0.84,
            },
          ]
        : [];
    }),
  ]);
  const searchRouteTemplates = uniqueRoutes(
    startingRoutes.filter((route) => route.kind === "search"),
  );
  const preferredMethod = inferPreferredCollectionMethod(
    provider,
    startingRoutes,
    input.currentArtifact,
  );
  const stableControlNames = uniqueStrings(
    input.attempts.flatMap(
      (attempt) => attempt.phaseEvidence?.visibleControls ?? [],
    ),
  );
  const warnings = uniqueStrings(
    input.attempts.flatMap((attempt) => [
      ...(attempt.phaseEvidence?.warnings ?? []),
      ...(attempt.blockerSummary ? [attempt.blockerSummary] : []),
    ]),
  );

  return SourceIntelligenceArtifactSchema.parse({
    provider,
    collection: {
      preferredMethod,
      rankedMethods: uniqueStrings(
        [
          input.currentArtifact?.intelligence.overrides.forceMethod ?? null,
          preferredMethod,
          provider?.apiAvailability === "available" ? "api" : null,
          searchRouteTemplates.length > 0 ? "listing_route" : null,
          startingRoutes.some(
            (route) => route.kind === "listing" || route.kind === "collection",
          )
            ? "careers_page"
            : null,
          "fallback_search",
        ].filter(
          (value): value is JobDiscoveryCollectionMethod => value !== null,
        ),
      ),
      startingRoutes,
      searchRouteTemplates,
      detailRoutePatterns:
        input.currentArtifact?.intelligence.collection.detailRoutePatterns ??
        [],
      listingMarkers: uniqueStrings([
        ...stableControlNames.filter((value) =>
          /job|listing|result|card/i.test(value),
        ),
        ...(input.currentArtifact?.intelligence.collection.listingMarkers ??
          []),
      ]),
    },
    apply: {
      applyPath: inferApplyPath(input.attempts, input.currentArtifact),
      authMarkers: uniqueStrings(
        input.attempts.flatMap((attempt) =>
          attempt.outcome === "blocked_auth" ? [attempt.resultSummary] : [],
        ),
      ),
      consentMarkers: uniqueStrings(
        warnings.filter((warning) => /consent/i.test(warning)),
      ),
      questionSurfaceHints: uniqueStrings(
        input.attempts.flatMap((attempt) =>
          attempt.confirmedFacts.filter((fact) =>
            /question|screening/i.test(fact),
          ),
        ),
      ),
      resumeUploadHints: uniqueStrings(
        input.attempts.flatMap((attempt) =>
          attempt.confirmedFacts.filter((fact) => /resume upload/i.test(fact)),
        ),
      ),
    },
    reliability: {
      selectorFingerprints: stableControlNames,
      stableControlNames,
      failureFingerprints: warnings,
      verifiedAt: input.currentArtifact?.verification?.verifiedAt ?? null,
      freshnessNotes: uniqueStrings([
        ...(input.currentArtifact?.verification?.outcome === "passed"
          ? ["Replay verification succeeded."]
          : []),
        ...(input.currentArtifact?.intelligence.reliability.freshnessNotes ??
          []),
      ]),
    },
    overrides: input.currentArtifact?.intelligence.overrides ?? {
      forceMethod: null,
      deniedRoutePatterns: [],
      extraStartingRoutes: [],
    },
  });
}

export function inferSourceIntelligenceFromTarget(input: {
  target: JobDiscoveryTarget;
  currentArtifact: SourceInstructionArtifact | null;
}): SourceIntelligenceArtifact {
  if (input.currentArtifact?.intelligence) {
    return SourceIntelligenceArtifactSchema.parse(
      input.currentArtifact.intelligence,
    );
  }

  const provider = detectProvider(input.target, []);
  const startingRoute = {
    url: input.target.startingUrl,
    label: "Starting URL",
    kind: inferRouteKind(input.target.startingUrl),
    confidence: 0.72,
  };

  return SourceIntelligenceArtifactSchema.parse({
    provider,
    collection: {
      preferredMethod: inferPreferredCollectionMethod(
        provider,
        [startingRoute],
        input.currentArtifact,
      ),
      rankedMethods: uniqueStrings(
        [
          provider?.apiAvailability === "available" ? "api" : null,
          startingRoute.kind === "search" ? "listing_route" : null,
          startingRoute.kind === "listing" ||
          startingRoute.kind === "collection"
            ? "careers_page"
            : null,
          "careers_page",
          "fallback_search",
        ].filter(
          (value): value is JobDiscoveryCollectionMethod => value !== null,
        ),
      ),
      startingRoutes: [startingRoute],
      searchRouteTemplates:
        startingRoute.kind === "search" ? [startingRoute] : [],
      detailRoutePatterns: [],
      listingMarkers: [],
    },
    apply: {
      applyPath: "unknown",
      authMarkers: [],
      consentMarkers: [],
      questionSurfaceHints: [],
      resumeUploadHints: [],
    },
    reliability: {
      selectorFingerprints: [],
      stableControlNames: [],
      failureFingerprints: [],
      verifiedAt: null,
      freshnessNotes: [
        "Derived from the current target URL before source-debug validation.",
      ],
    },
    overrides: {
      forceMethod: null,
      deniedRoutePatterns: [],
      extraStartingRoutes: [],
    },
  });
}

export function buildDiscoveryStartingUrls(
  target: JobDiscoveryTarget,
  artifact: SourceInstructionArtifact | null,
): string[] {
  if (!artifact) {
    return [target.startingUrl];
  }

  const anchorUrl = tryParseUrl(target.startingUrl);
  const normalizeRoute = (url: string) =>
    canonicalizeRouteForReuse(url, anchorUrl);
  const deniedRoutes = resolveDeniedDiscoveryRoutes(artifact, anchorUrl);
  const isDeniedRoute = (url: string | null) =>
    url != null && deniedRoutes.some((deniedRoute) => deniedRoute === url);
  const overrideRoutes = (
    artifact.intelligence.overrides.extraStartingRoutes ?? []
  ).flatMap((route) => {
    const normalized = normalizeRoute(route);
    const kind = normalized ? inferRouteKind(normalized) : null;
    return normalized &&
      kind &&
      shouldKeepRouteForReuse({
        url: normalized,
        kind,
        targetStartingUrl: target.startingUrl,
      }) &&
      !isDeniedRoute(normalized)
      ? [normalized]
      : [];
  });
  const searchRoutes =
    artifact.intelligence.collection.searchRouteTemplates.flatMap((route) => {
      const normalized = normalizeRoute(route.url);
      const kind = normalized
        ? resolveRouteKindForReuse(normalized, route.kind)
        : null;
      return normalized &&
        kind &&
        shouldKeepRouteForReuse({
          url: normalized,
          kind,
          targetStartingUrl: target.startingUrl,
        }) &&
        !isDeniedRoute(normalized)
        ? [normalized]
        : [];
    });
  const learnedStartingRoutes =
    artifact.intelligence.collection.startingRoutes.flatMap((route) => {
      const normalized = normalizeRoute(route.url);
      const kind = normalized
        ? resolveRouteKindForReuse(normalized, route.kind)
        : null;
      return normalized &&
        kind &&
        shouldKeepRouteForReuse({
          url: normalized,
          kind,
          targetStartingUrl: target.startingUrl,
        }) &&
        !isDeniedRoute(normalized) &&
        normalized !== target.startingUrl
        ? [normalized]
        : [];
    });
  const preferredMethod =
    artifact.intelligence.overrides.forceMethod ??
    artifact.intelligence.collection.preferredMethod;
  const normalizedStartingUrl = normalizeRoute(target.startingUrl);
  const startingUrlRoute =
    normalizedStartingUrl && !isDeniedRoute(normalizedStartingUrl)
      ? [target.startingUrl]
      : [];

  // The search agent types the person's search into the site itself; no
  // rule picks a keyword for it (ADR 0041).
  const routes = uniqueStrings(
    (preferredMethod === "careers_page"
      ? [
          ...overrideRoutes,
          ...learnedStartingRoutes,
          ...searchRoutes,
          ...startingUrlRoute,
        ]
      : [
          ...overrideRoutes,
          ...searchRoutes,
          ...learnedStartingRoutes,
          ...startingUrlRoute,
        ]
    ).filter((value): value is string => Boolean(value)),
  );

  if (routes.length > 0) {
    return routes;
  }

  return startingUrlRoute;
}

function resolveDeniedDiscoveryRoutes(
  artifact: SourceInstructionArtifact,
  anchorUrl: URL | null,
): string[] {
  const normalizeDeniedRoute = (value: string): string | null => {
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      return null;
    }

    if (normalizedValue.startsWith("/") && anchorUrl) {
      return canonicalizeRouteForReuse(
        new URL(normalizedValue, anchorUrl).toString(),
        anchorUrl,
      );
    }

    return canonicalizeRouteForReuse(normalizedValue, anchorUrl);
  };
  const deniedRouteOverrides = (
    artifact.intelligence.overrides.deniedRoutePatterns ?? []
  ).flatMap((pattern) => {
    const normalized = normalizeDeniedRoute(pattern);
    return normalized ? [normalized] : [];
  });
  const deniedRouteHints = [
    ...artifact.searchGuidance,
    ...artifact.navigationGuidance,
    ...artifact.warnings,
  ].flatMap((line) => {
    const normalizedLine = normalizeText(line);
    const lineDisprovesRoute =
      isExplicitSearchProbeDisproof(line) ||
      normalizedLine.includes("returns 404") ||
      normalizedLine.includes("not a working search endpoint") ||
      normalizedLine.includes("broken route");

    if (!lineDisprovesRoute) {
      return [] as string[];
    }

    const implicitDeniedRoutes = [
      normalizedLine.includes("search route") ||
      normalizedLine.includes("search endpoint")
        ? normalizeDeniedRoute("/search")
        : null,
    ].filter((value): value is string => value !== null);

    const absoluteUrlMatches = line.match(/https?:\/\/[^\s)\]>",]+/gi) ?? [];
    const relativePathMatches =
      line.match(
        /(?:^|[\s(])((?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)+(?:\/)?(?:\?[^\s)\]>",]+)?)/g,
      ) ?? [];

    return uniqueStrings([
      ...implicitDeniedRoutes,
      ...absoluteUrlMatches,
      ...relativePathMatches.map((match) => {
        const trimmedMatch = match.trim();
        return trimmedMatch.startsWith("/")
          ? trimmedMatch
          : trimmedMatch.slice(trimmedMatch.indexOf("/"));
      }),
    ])
      .map((value) => value.replace(/[.,;:!?]+$/g, ""))
      .flatMap((value) => {
        const normalized = normalizeDeniedRoute(value);
        return normalized ? [normalized] : [];
      });
  });

  return uniqueStrings([...deniedRouteOverrides, ...deniedRouteHints]);
}

function htmlToText(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  // Public providers can return escaped HTML. Decode it before removing
  // markup and before truncating summaries, or a summary contains only tags.
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    decoded = decoded
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&apos;|&#39;/gi, "'")
      .replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, code: string) => {
        const point = code.toLowerCase().startsWith("x")
          ? Number.parseInt(code.slice(1), 16)
          : Number.parseInt(code, 10);
        return point > 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : entity;
      });
  }

  return decoded
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|ul|ol|h[1-6])\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeProviderDateTime(
  value: string | number | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }

    const numericDate = new Date(value);
    return Number.isNaN(numericDate.getTime())
      ? null
      : numericDate.toISOString();
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (/^-?\d+$/.test(trimmed)) {
    const numericValue = Number(trimmed);
    if (!Number.isFinite(numericValue)) {
      return null;
    }

    const numericDate = new Date(numericValue);
    return Number.isNaN(numericDate.getTime())
      ? null
      : numericDate.toISOString();
  }

  const parsedAt = Date.parse(trimmed);
  if (Number.isNaN(parsedAt)) {
    return null;
  }

  const parsedDate = new Date(parsedAt);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString();
}

function inferWorkModes(
  location: string | null | undefined,
): JobPosting["workMode"] {
  const normalized = normalizeText(location ?? "");
  if (!normalized) {
    return [];
  }
  if (normalized.includes("remote")) {
    return ["remote"];
  }
  if (normalized.includes("hybrid")) {
    return ["hybrid"];
  }
  if (
    /\bon[\s-]?site\b/u.test(normalized) &&
    !/\b(?:not|no|without)\s+(?:an?\s+)?on[\s-]?site\b/u.test(normalized)
  ) {
    return ["onsite"];
  }
  return [];
}

/** Silence (no answer, no bytes) that ends a feed request. */
const PROVIDER_API_TIMEOUT_MS = 30_000;
/** The longest a feed may take even while bytes keep arriving. */
const PROVIDER_API_TOTAL_TIMEOUT_MS = 3 * 60_000;
/**
 * Waits before asking a provider again after a failure that passes: the
 * connection dropped, or the provider asked to slow down. A computer waking
 * from sleep takes a few seconds to get its network back. A timed-out
 * request is asked once more; a slow feed asked again and again would hold
 * a download slot for minutes.
 */
const PROVIDER_API_RETRY_DELAYS_MS: readonly number[] = [2_000, 10_000, 30_000];
const PROVIDER_API_MAX_RETRY_AFTER_MS = 60_000;
/** Feed jobs converted between turns of the event loop. */
const PROVIDER_API_JOBS_PER_TURN = 25;
const SUMMARY_MAX_LENGTH = 280;

class ProviderApiStatusError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(`Public provider API returned ${status}.`);
    this.name = "ProviderApiStatusError";
  }
}

function readRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * Whether asking again could work: a network error, a first timeout, or a
 * provider asking to slow down. A 404, a provider error or a malformed feed
 * is reported as it is.
 */
function isPassingProviderFailure(error: unknown, attempt: number): boolean {
  if (error instanceof ProviderApiStatusError) return error.status === 429;
  if (isAbortError(error)) return attempt === 0;
  // undici reports every connection failure as a TypeError "fetch failed"
  // with the cause attached.
  return error instanceof TypeError;
}

/**
 * What the person reads when a board's feed could not be collected. A
 * failure that passes (the network, a slow or busy board) says it is tried
 * again; `source-health` keeps those out of a source's health. A missing
 * list points at the address, which only the person can fix.
 */
function describeProviderFailure(error: unknown): string {
  if (error instanceof ProviderApiStatusError) {
    if (error.status === 404 || error.status === 410) {
      return `No job list was found at this board's address (HTTP ${error.status}). Check the address with Edit.`;
    }
    if (error.status === 429 || error.status >= 500) {
      return `The job board answered with an error (HTTP ${error.status}); it is tried again on the next search.`;
    }
    return `The job board refused to share its job list (HTTP ${error.status}).`;
  }
  if (isAbortError(error)) {
    return "The job board did not answer in time; it is tried again on the next search.";
  }
  if (error instanceof TypeError) {
    return "The job board could not be reached; it is tried again on the next search.";
  }
  return "The job board's job list could not be read.";
}

function waitBeforeRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function resolveProviderCompanyLabel(input: {
  targetLabel: string;
  targetStartingUrl: string;
  providerLabel: string;
  providerIdentifier: string | null;
}): string {
  // A source's URL or hostname identifies its host, not the employer. Check
  // before stripping provider/jobs words, which can leave a plausible-looking
  // fragment of an ATS domain in the company field.
  const targetUrl = tryParseUrl(input.targetStartingUrl);
  const normalizeAddress = (value: string) =>
    value.trim().replace(/\/+$/u, "").toLocaleLowerCase();
  const isSourceAddressLabel =
    targetUrl !== null &&
    [
      targetUrl.hostname,
      targetUrl.host,
      `${targetUrl.host}${targetUrl.pathname}`,
      input.targetStartingUrl,
    ].some(
      (address) =>
        normalizeAddress(address) === normalizeAddress(input.targetLabel),
    );
  const providerPattern = new RegExp(
    `\\b${escapeRegularExpression(input.providerLabel)}\\b`,
    "giu",
  );
  const cleanedTargetLabel = input.targetLabel
    .replace(providerPattern, " ")
    .replace(/\b(?:job board|jobs|careers)\b/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  const normalizedTargetLabel = normalizeText(cleanedTargetLabel);
  const isGenericTargetLabel = [
    "primary target",
    "target site",
    "job source",
    "careers source",
  ].includes(normalizedTargetLabel);
  if (cleanedTargetLabel && !isGenericTargetLabel && !isSourceAddressLabel) {
    return cleanedTargetLabel;
  }

  const providerCompany = (input.providerIdentifier ?? input.targetLabel)
    .replace(/[._-]+/gu, " ")
    .replace(/\bjobs?\b/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return providerCompany.replace(/\b\p{L}/gu, (character) =>
    character.toLocaleUpperCase(),
  );
}

/**
 * Ends a feed request that went quiet: no answer and no body bytes for
 * `quietMs`, or still unfinished after `totalMs`. Time the main process
 * spent on other work does not count as quiet: when the timer comes due it
 * first lets the network events waiting behind that work run (one turn of
 * the event loop) and ends the request only if none of them moved it. A busy
 * search used to time out feeds whose bytes had already arrived.
 */
function createProviderApiQuietTimeout(quietMs: number, totalMs: number) {
  const controller = new AbortController();
  let lastProgressAt = Date.now();
  let finished = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  const end = () => {
    if (!finished) controller.abort();
  };
  const totalTimer = setTimeout(end, totalMs);
  const arm = (delay: number) => {
    quietTimer = setTimeout(check, delay);
  };
  const check = () => {
    quietTimer = null;
    if (finished) return;
    const quietFor = Date.now() - lastProgressAt;
    if (quietFor < quietMs) {
      arm(quietMs - quietFor);
      return;
    }
    const progressBefore = lastProgressAt;
    setImmediate(() => {
      if (finished) return;
      if (lastProgressAt !== progressBefore) arm(quietMs);
      else end();
    });
  };
  arm(quietMs);
  return {
    signal: controller.signal,
    progress: () => {
      lastProgressAt = Date.now();
    },
    cleanup: () => {
      finished = true;
      clearTimeout(totalTimer);
      if (quietTimer) clearTimeout(quietTimer);
    },
  };
}

/** The feed's JSON, read chunk by chunk so each chunk counts as progress. */
async function readFeedBytes(
  response: Response,
  onProgress: () => void,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader)
    return typeof response.arrayBuffer === "function"
      ? new Uint8Array(await response.arrayBuffer())
      : new TextEncoder().encode(JSON.stringify(await response.json()));
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onProgress();
    chunks.push(value);
    length += value.byteLength;
  }
  const payload = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return payload;
}

function composeAbortSignals(
  timeoutSignal: AbortSignal,
  signal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  if (!signal) {
    return {
      signal: timeoutSignal,
      cleanup: () => undefined,
    };
  }

  if (signal.aborted || timeoutSignal.aborted) {
    const controller = new AbortController();
    controller.abort();
    return {
      signal: controller.signal,
      cleanup: () => undefined,
    };
  }

  const controller = new AbortController();
  const cleanup = () => {
    signal.removeEventListener("abort", abort);
    timeoutSignal.removeEventListener("abort", abort);
  };
  const abort = () => {
    cleanup();
    controller.abort();
  };
  signal.addEventListener("abort", abort, { once: true });
  timeoutSignal.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function normalizeProviderJobUrl(
  value: string | null | undefined,
): string | null {
  const parsed = tryParseUrl(value ?? "");
  if (!parsed) {
    return null;
  }

  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
  return parsed.toString();
}

function isExactProviderJobTarget(
  job: {
    sourceJobId: string | null;
    canonicalUrl: string | null;
    applicationUrl: string | null;
  },
  targetUrl: string,
): boolean {
  const normalizedTarget = normalizeProviderJobUrl(targetUrl);
  if (!normalizedTarget) {
    return false;
  }

  if (
    [job.canonicalUrl, job.applicationUrl]
      .map(normalizeProviderJobUrl)
      .some((url) => url === normalizedTarget)
  ) {
    return true;
  }

  const sourceJobId = job.sourceJobId?.trim().toLowerCase();
  if (!sourceJobId) {
    return false;
  }

  const target = tryParseUrl(normalizedTarget);
  return Boolean(
    target?.pathname
      .split("/")
      .filter(Boolean)
      .some((segment) => {
        const normalizedSegment = segment.toLowerCase();
        return (
          normalizedSegment === sourceJobId ||
          normalizedSegment.endsWith(`_${sourceJobId}`) ||
          normalizedSegment.endsWith(`-${sourceJobId}`)
        );
      }),
  );
}

function toProviderJobPosting(
  job: NormalizedPublicApiJobRecord,
  input: {
    target: JobDiscoveryTarget;
    artifact: Pick<SourceInstructionArtifact, "intelligence">;
    source: JobSource;
    provider: NonNullable<SourceIntelligenceArtifact["provider"]>;
  },
): JobPosting | null {
  const { provider } = input;
  if (!job.sourceJobId || !job.title || !job.canonicalUrl) {
    return null;
  }

  const description = htmlToText(job.description);
  const summaryText = description.replace(/\s+/g, " ").trim();
  const summary =
    summaryText.length > SUMMARY_MAX_LENGTH
      ? `${summaryText.slice(0, SUMMARY_MAX_LENGTH).replace(/\s+\S*$/, "")}…`
      : summaryText;
  const applicationUrl = job.applicationUrl ?? job.canonicalUrl;
  const canonicalUrl = isExactProviderJobTarget(job, input.target.startingUrl)
    ? input.target.startingUrl
    : job.canonicalUrl;
  const location = job.location?.trim() || "Unknown";
  return JobPostingSchema.parse({
    source: input.source,
    sourceJobId: job.sourceJobId,
    discoveryMethod: "public_api",
    collectionMethod: "api",
    canonicalUrl,
    applicationUrl,
    title: job.title,
    company: resolveProviderCompanyLabel({
      targetLabel: input.target.label,
      targetStartingUrl: input.target.startingUrl,
      providerLabel: provider.label,
      providerIdentifier: provider.providerIdentifier,
    }),
    location,
    workMode: inferWorkModes(`${location} ${job.workplaceType ?? ""}`),
    applyPath: "external_redirect",
    easyApplyEligible: false,
    postedAt: normalizeProviderDateTime(job.postedAtValue),
    postedAtText: null,
    providerUpdatedAt: normalizeProviderDateTime(job.providerUpdatedAtValue),
    discoveredAt: new Date().toISOString(),
    salaryText: null,
    summary: summary || null,
    description: description || job.title,
    keySkills: [],
    responsibilities: [],
    minimumQualifications: [],
    preferredQualifications: [],
    seniority: null,
    employmentType: job.employmentType,
    department: job.department,
    team: job.team,
    employerWebsiteUrl: null,
    // Provider listing URLs identify the source/ATS, not the employer.
    // This adapter has no independently employer-owned domain field.
    employerDomain: null,
    atsProvider: provider.label,
    providerKey: provider.key,
    providerBoardToken: provider.boardToken,
    providerIdentifier: provider.providerIdentifier,
    titleTriageOutcome: "pass",
    sourceIntelligence: input.artifact.intelligence,
    screeningHints: {},
    keywordSignals: [],
    benefits: [],
  });
}

/** The exact same reader runs in a worker in Electron and locally in other hosts. */
export async function preparePublicProviderFeed(
  task: DiscoveryFeedTask,
): Promise<DiscoveryFeedResult> {
  const provider = task.intelligence.provider;
  const adapter =
    provider &&
    PUBLIC_API_RESPONSE_ADAPTERS[
      provider.key as keyof typeof PUBLIC_API_RESPONSE_ADAPTERS
    ];
  if (!provider || !adapter)
    throw new Error("No public provider reader is configured.");
  const parsed = parsePublicApiJobRecords(
    JSON.parse(
      typeof task.payload === "string"
        ? task.payload
        : new TextDecoder().decode(task.payload),
    ) as unknown,
    adapter,
  );
  const records = parsed.records.sort(
    (left, right) =>
      Number(isExactProviderJobTarget(right, task.target.startingUrl)) -
      Number(isExactProviderJobTarget(left, task.target.startingUrl)),
  );
  const jobs: JobPosting[] = [];
  const preparations: DiscoveryFeedResult["preparations"] = [];
  for (const [position, record] of records.entries()) {
    if (position % PROVIDER_API_JOBS_PER_TURN === 0) await yieldToEventLoop();
    const raw = toProviderJobPosting(record, {
      target: task.target,
      source: task.source,
      provider,
      artifact: { intelligence: task.intelligence },
    });
    if (!raw) continue;
    if (task.prepareForDiscovery) prepareDiscoveryPosting(raw);
    const posting = task.prepareForDiscovery
      ? toProviderAwarePosting({
          posting: raw,
          target: task.target,
          collectionMethod: "api",
          discoveryMethod: "public_api",
          intelligence: task.intelligence,
          adapterKind: task.source,
        })
      : raw;
    jobs.push(raw);
    if (task.prepareForDiscovery) {
      const preparedContent = readDiscoveryPreparation(posting)!.content!.value;
      const content = preparedContent
        ? { digest: preparedContent.digest, packed: preparedContent.packed! }
        : null;
      const keys = prepareJobIdentity(posting);
      const fingerprints = createDiscoveryListingFingerprints(posting);
      const rawContent = readDiscoveryPreparation(raw)!.content!.value;
      const screeningContent = rawContent
        ? { digest: rawContent.digest, packed: rawContent.packed! }
        : null;
      const normalized: Partial<JobPosting> = {};
      for (const field of Object.keys(posting) as Array<keyof JobPosting>) {
        if (!isDeepStrictEqual(raw[field], posting[field]))
          Object.assign(normalized, { [field]: posting[field] });
      }
      preparations.push({
        normalized,
        fingerprints,
        keys,
        screeningKeys: prepareJobIdentity(raw),
        screeningFingerprints: createDiscoveryListingFingerprints(raw),
        content,
        screeningContent,
        bodySalaryRange: prepareBodySalaryRange(posting),
        screeningBodySalaryRange: prepareBodySalaryRange(raw),
        matchAssessmentPostingFingerprint:
          readPreparedMatchAssessmentPostingFingerprint(posting) ??
          computeMatchAssessmentPostingFingerprint(posting),
        screeningMatchAssessmentPostingFingerprint:
          readPreparedMatchAssessmentPostingFingerprint(raw) ??
          computeMatchAssessmentPostingFingerprint(raw),
      });
    }
  }
  return {
    jobs,
    skippedMalformedCount: parsed.skippedMalformedCount,
    preparations,
  };
}

export async function collectPublicProviderJobs(input: {
  target: JobDiscoveryTarget;
  artifact: Pick<SourceInstructionArtifact, "intelligence">;
  source: JobSource;
  signal?: AbortSignal;
  /** Waits before each repeat request; the default suits real networks. */
  retryDelaysMs?: readonly number[];
  /** Silence that ends a request; the default suits real networks. */
  timeoutMs?: number;
  /** Discovery can consume the worker's normalized postings without a second pass. */
  prepareForDiscovery?: boolean;
}): Promise<{
  jobs: JobPosting[];
  warning: string | null;
  pagesCovered?: number;
}> {
  const provider = input.artifact.intelligence.provider;
  const retryDelaysMs = input.retryDelaysMs ?? PROVIDER_API_RETRY_DELAYS_MS;
  if (!provider || provider.apiAvailability !== "available") {
    return {
      jobs: [],
      warning: "No public provider API is configured for this source.",
      pagesCovered: 0,
    };
  }

  let pagesCovered = 0;
  try {
    const responseAdapter =
      PUBLIC_API_RESPONSE_ADAPTERS[
        provider.key as keyof typeof PUBLIC_API_RESPONSE_ADAPTERS
      ];
    if (responseAdapter && provider.publicApiUrlTemplate) {
      const publicApiUrl = provider.publicApiUrlTemplate;
      // One request with its own time limit; the body is read inside it.
      const requestFeed = async (): Promise<Uint8Array> => {
        const timeout = createProviderApiQuietTimeout(
          input.timeoutMs ?? PROVIDER_API_TIMEOUT_MS,
          PROVIDER_API_TOTAL_TIMEOUT_MS,
        );
        const composedSignal = composeAbortSignals(
          timeout.signal,
          input.signal,
        );
        try {
          const response = await fetch(publicApiUrl, {
            signal: composedSignal.signal,
          });
          timeout.progress();
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new ProviderApiStatusError(
              response.status,
              response.status === 429
                ? readRetryAfterMs(response.headers.get("retry-after"))
                : null,
            );
          }
          return await readFeedBytes(response, timeout.progress);
        } finally {
          composedSignal.cleanup();
          timeout.cleanup();
        }
      };

      pagesCovered += 1;
      let payload: Uint8Array;
      for (let attempt = 0; ; attempt += 1) {
        try {
          payload = await requestFeed();
          break;
        } catch (error) {
          const delay = retryDelaysMs[attempt];
          if (
            input.signal?.aborted ||
            delay === undefined ||
            !isPassingProviderFailure(error, attempt)
          ) {
            throw error;
          }
          const retryAfter =
            error instanceof ProviderApiStatusError ? error.retryAfterMs : null;
          await waitBeforeRetry(
            Math.min(
              Math.max(delay, retryAfter ?? 0),
              PROVIDER_API_MAX_RETRY_AFTER_MS,
            ),
            input.signal,
          );
        }
      }

      const execute = getDiscoveryFeedExecutor() ?? preparePublicProviderFeed;
      const feed = {
        target: input.target,
        intelligence: input.artifact.intelligence,
        source: input.source,
        prepareForDiscovery: input.prepareForDiscovery ?? false,
      };
      const parsing = execute({ ...feed, payload }, input.signal);
      payload = new Uint8Array(0);
      let parsedPublicApiRecords: DiscoveryFeedResult;
      try {
        parsedPublicApiRecords = await parsing;
      } catch (error) {
        if (
          input.signal?.aborted ||
          !(error instanceof Error) ||
          error.name !== DISCOVERY_READER_LOST_ERROR
        )
          throw error;
        // The lost reader took the transferred bytes; read this feed here.
        parsedPublicApiRecords = await preparePublicProviderFeed({
          ...feed,
          payload: await requestFeed(),
        });
      }
      input.signal?.throwIfAborted();
      const { jobs, preparations } = parsedPublicApiRecords;
      for (const [position, preparation] of preparations.entries()) {
        const raw = jobs[position]!;
        const job = { ...raw, ...preparation.normalized };
        rememberPreparedDiscoveryPosting(raw, job);
        rememberPreparedListingContent(job, preparation.content);
        rememberPreparedListingContent(raw, preparation.screeningContent);
        rememberPreparedJobIdentity(job, preparation.keys);
        rememberPreparedJobIdentity(raw, preparation.screeningKeys);
        rememberPreparedBodySalaryRange(job, preparation.bodySalaryRange);
        rememberPreparedBodySalaryRange(
          raw,
          preparation.screeningBodySalaryRange,
        );
        rememberDiscoveryListingFingerprints(
          job,
          preparation.fingerprints,
          preparation.matchAssessmentPostingFingerprint,
        );
        rememberDiscoveryListingFingerprints(
          raw,
          preparation.screeningFingerprints,
          preparation.screeningMatchAssessmentPostingFingerprint,
        );
      }

      return {
        pagesCovered,
        jobs,
        warning:
          parsedPublicApiRecords.skippedMalformedCount > 0
            ? `${parsedPublicApiRecords.skippedMalformedCount} ${parsedPublicApiRecords.skippedMalformedCount === 1 ? "job" : "jobs"} in this board's list could not be read and ${parsedPublicApiRecords.skippedMalformedCount === 1 ? "was" : "were"} skipped.`
            : null,
      };
    }

    return {
      jobs: [],
      warning: `${provider.label} API collection is not implemented yet for this provider.`,
      pagesCovered,
    };
  } catch (error) {
    if (input.signal?.aborted) {
      throw error;
    }

    return {
      jobs: [],
      pagesCovered,
      warning: describeProviderFailure(error),
    };
  }
}
