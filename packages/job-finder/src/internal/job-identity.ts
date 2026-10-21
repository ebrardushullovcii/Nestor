import { createHash } from "node:crypto";

import { normalizeText } from "./shared";

const TRACKING_QUERY_PARAMETERS = new Set([
  "gh_src",
  "lever-source",
  "ref",
  "referrer",
  "source",
  "sourceid",
  "trackingid",
  "trk",
]);

export type JobIdentityInput = {
  source: string | null;
  sourceJobId: string | null;
  canonicalUrl: string | null;
  applicationUrl?: string | null;
  providerKey?: string | null;
  providerBoardToken?: string | null;
  providerIdentifier?: string | null;
  title?: string | null;
  seniority?: string | null;
  company?: string | null;
  location?: string | null;
  description?: string | null;
  postedAt?: string | null;
  postedAtText?: string | null;
  /**
   * Listing links the same job has on its other sources (ADR 0030). Passed
   * only when matching new sightings to saved jobs, so a job that now shows
   * one source's listing still recognises another source's link.
   */
  alternateListingUrls?: readonly string[] | null;
  /**
   * Match on title, employer and place between different sites (ADR 0030).
   * Only discovery's merge asks for it; other indexes (the ledger, company
   * duplicates) keep to link and content identity.
   */
  matchAcrossSources?: boolean;
};

/**
 * Beyond this many saved jobs sharing one title, employer and place, the
 * facts identify nothing: the match is skipped rather than scanned.
 */
const MAX_CROSS_SOURCE_CANDIDATES = 8;

export type JobIdentityAliasKind =
  | "provider_posting_id"
  | "source_posting_id"
  | "employer_application_url"
  | "canonical_listing_url"
  | "exact_listing_content"
  | "cross_source_listing_facts"
  | "corroborated_listing_facts";

export type JobIdentityAlias = {
  key: string;
  kind: JobIdentityAliasKind;
  confidence: "strong" | "corroborating" | "possible";
  priority: number;
};

export type JobIdentityResolution<T> =
  | {
      status: "matched";
      value: T;
      matchedAliases: readonly JobIdentityAlias[];
    }
  | {
      status: "possible" | "ambiguous" | "conflict";
      candidates: readonly T[];
      matchedAliases: readonly JobIdentityAlias[];
    }
  | {
      status: "none";
      candidates: readonly [];
      matchedAliases: readonly [];
    };

export type JobIdentityIndex<T extends object> = {
  add(value: T): void;
  remove(value: T): void;
  replace(previous: T, next: T): void;
  resolve(identity: JobIdentityInput): JobIdentityResolution<T>;
  find(identity: JobIdentityInput): T | null;
};

function normalizeIdentifier(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function normalizeSourceScope(
  canonicalHostname: string | null,
  companyValue: string | null | undefined,
): string | null {
  if (!canonicalHostname || !companyValue) {
    return null;
  }
  const company = normalizeText(companyValue);
  return company ? `${canonicalHostname}:${company}` : null;
}

function normalizeJobIdentityUrlParts(value: string): {
  url: string;
  hostname: string | null;
} {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";

    for (const key of [...parsed.searchParams.keys()]) {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey.startsWith("utm_") ||
        TRACKING_QUERY_PARAMETERS.has(normalizedKey)
      ) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.searchParams.sort();

    return { url: parsed.toString(), hostname: parsed.hostname };
  } catch {
    return { url: value.trim(), hostname: null };
  }
}

export function normalizeJobIdentityUrl(value: string): string {
  return normalizeJobIdentityUrlParts(value).url;
}

function normalizePostedDate(input: JobIdentityInput): string | null {
  if (input.postedAt) {
    const parsedTimestamp = Date.parse(input.postedAt);
    if (Number.isFinite(parsedTimestamp)) {
      return new Date(parsedTimestamp).toISOString().slice(0, 10);
    }
  }

  const postedAtText = input.postedAtText?.trim() ?? "";
  if (
    !postedAtText ||
    /\b(?:ago|hour|hours|today|yesterday|day|days|week|weeks|month|months)\b/iu.test(
      postedAtText,
    )
  ) {
    return null;
  }
  const parsedText = Date.parse(postedAtText);
  return Number.isFinite(parsedText)
    ? new Date(parsedText).toISOString().slice(0, 10)
    : null;
}

const MIN_EXACT_CONTENT_IDENTITY_CHARACTERS = 200;
const MIN_EXACT_CONTENT_IDENTITY_WORDS = 40;
/**
 * Normalized descriptions by description text. Every identity lookup builds
 * the content alias of the job it looks for, and a search looks each posting
 * up several times (ledger, saved jobs, merge, landing); normalizing a whole
 * description each time was most of a big board's main-process time.
 */
const listingContentIdentityMemo = new Map<string, string | null>();
const LISTING_CONTENT_IDENTITY_MEMO_LIMIT = 500;

function normalizeListingContentIdentity(
  description: string | null | undefined,
): string | null {
  if (!description) {
    return null;
  }
  const remembered = listingContentIdentityMemo.get(description);
  if (remembered !== undefined) return remembered;
  const normalized = computeListingContentIdentity(description);
  if (listingContentIdentityMemo.size >= LISTING_CONTENT_IDENTITY_MEMO_LIMIT)
    listingContentIdentityMemo.clear();
  listingContentIdentityMemo.set(description, normalized);
  return normalized;
}

function digestListingContent(content: string): string {
  return createHash("sha256").update(content).digest("base64url");
}

function computeListingContentIdentity(description: string): string | null {
  const normalized = normalizeText(description)
    // A source may label the same final link "Apply" or "Apply now". That
    // call to action is page chrome, not listing identity.
    .replace(/\bapply(?: now)?$/u, "")
    .trim();
  if (
    normalized.length < MIN_EXACT_CONTENT_IDENTITY_CHARACTERS ||
    normalized.split(/\s+/u).length < MIN_EXACT_CONTENT_IDENTITY_WORDS
  ) {
    return null;
  }
  return normalized;
}

function readCompatibleTitleShape(title: string | null | undefined): {
  full: string;
  stem: string;
  hasExplicitQualifier: boolean;
} | null {
  if (!title) {
    return null;
  }
  const full = normalizeText(title);
  if (!full) {
    return null;
  }
  const qualifierMatch = /,|\s[|–—]\s/u.exec(title);
  if (!qualifierMatch || qualifierMatch.index <= 0) {
    return { full, stem: full, hasExplicitQualifier: false };
  }
  const stem = normalizeText(title.slice(0, qualifierMatch.index));
  const qualifier = normalizeText(
    title.slice(qualifierMatch.index + qualifierMatch[0].length),
  );
  return {
    full,
    stem: stem || full,
    // A trailing comma is extraction damage, not an explicit qualifier.
    hasExplicitQualifier: qualifier.length > 0,
  };
}

/**
 * The same title, or the same title where one source drops a comma-delimited
 * team/product qualifier ("Data Engineer, Payments" and "Data Engineer").
 * Different roles or levels never pass.
 */
function hasCompatibleTitles(
  left: JobIdentityInput,
  right: JobIdentityInput,
): boolean {
  const leftTitle = readCompatibleTitleShape(left.title);
  const rightTitle = readCompatibleTitleShape(right.title);
  if (!leftTitle || !rightTitle) {
    return false;
  }
  return (
    leftTitle.full === rightTitle.full ||
    ((!leftTitle.hasExplicitQualifier || !rightTitle.hasExplicitQualifier) &&
      (leftTitle.hasExplicitQualifier
        ? leftTitle.stem === rightTitle.full
        : rightTitle.stem === leftTitle.full))
  );
}

/**
 * Strong content identity is deliberately narrow. It only accepts a complete
 * body, exact employer and location, a compatible title (including a source
 * that drops a comma-delimited team/product qualifier) and compatible
 * seniority.
 */
export function hasEquivalentListingContentIdentity(
  left: JobIdentityInput,
  right: JobIdentityInput,
): boolean {
  if (!hasCompatibleSeniority(left, right)) return false;
  const leftContent = normalizeListingContentIdentity(left.description);
  const rightContent = normalizeListingContentIdentity(right.description);
  if (!leftContent || leftContent !== rightContent) {
    return false;
  }
  const leftCompany = normalizeText(left.company ?? "");
  const rightCompany = normalizeText(right.company ?? "");
  const leftLocation = normalizeText(left.location ?? "");
  const rightLocation = normalizeText(right.location ?? "");
  if (
    !leftCompany ||
    leftCompany !== rightCompany ||
    !leftLocation ||
    leftLocation !== rightLocation
  ) {
    return false;
  }
  return hasCompatibleTitles(left, right);
}

export function buildJobIdentityAliases(
  input: JobIdentityInput,
): JobIdentityAlias[] {
  const source = normalizeIdentifier(input.source);
  const sourceJobId = normalizeIdentifier(input.sourceJobId);
  const providerKey = normalizeIdentifier(input.providerKey);
  const providerIdentifier = normalizeIdentifier(input.providerIdentifier);
  const providerBoardToken = normalizeIdentifier(input.providerBoardToken);
  const canonicalUrlParts = input.canonicalUrl
    ? normalizeJobIdentityUrlParts(input.canonicalUrl)
    : null;
  const sourceScope = normalizeSourceScope(
    canonicalUrlParts?.hostname ?? null,
    input.company,
  );
  const aliases: JobIdentityAlias[] = [];

  if (providerKey && sourceJobId && providerIdentifier) {
    aliases.push({
      key: `provider-id:${providerKey}:${providerIdentifier}:${sourceJobId}`,
      kind: "provider_posting_id",
      confidence: "strong",
      priority: 10,
    });
  }
  if (providerKey && sourceJobId && providerBoardToken) {
    aliases.push({
      key: `provider-board-id:${providerKey}:${providerBoardToken}:${sourceJobId}`,
      kind: "provider_posting_id",
      confidence: "strong",
      priority: 11,
    });
  }
  if (source && sourceJobId && sourceScope) {
    aliases.push({
      key: `source-id:${source}:${sourceScope}:${sourceJobId}`,
      kind: "source_posting_id",
      confidence: "strong",
      priority: 20,
    });
  }
  if (source && sourceJobId) {
    aliases.push({
      key: `unscoped-source-id:${source}:${sourceJobId}`,
      kind: "source_posting_id",
      confidence: "corroborating",
      priority: 21,
    });
  }

  const employerApplicationUrl = input.applicationUrl ?? input.canonicalUrl;
  if (employerApplicationUrl) {
    const normalizedEmployerApplicationUrl =
      employerApplicationUrl === input.canonicalUrl && canonicalUrlParts
        ? canonicalUrlParts.url
        : normalizeJobIdentityUrl(employerApplicationUrl);
    aliases.push({
      key: `employer-url:${normalizedEmployerApplicationUrl}`,
      kind: "employer_application_url",
      confidence: "strong",
      priority: 30,
    });
  }
  if (input.canonicalUrl) {
    aliases.push({
      key: `listing-url:${canonicalUrlParts!.url}`,
      kind: "canonical_listing_url",
      confidence: "strong",
      priority: 40,
    });
  }
  const alternateKeys = new Set<string>();
  for (const alternate of input.alternateListingUrls ?? []) {
    const key = `listing-url:${normalizeJobIdentityUrl(alternate)}`;
    if (
      alternate === input.canonicalUrl ||
      alternateKeys.has(key) ||
      aliases.some((alias) => alias.key === key)
    ) {
      continue;
    }
    alternateKeys.add(key);
    aliases.push({
      key,
      kind: "canonical_listing_url",
      confidence: "strong",
      priority: 41,
    });
  }

  const exactContent = normalizeListingContentIdentity(input.description);
  const contentCompany = input.company ? normalizeText(input.company) : "";
  const contentLocation = input.location ? normalizeText(input.location) : "";
  if (exactContent && contentCompany && contentLocation) {
    aliases.push({
      // A digest, not the text: aliases stay cached with every indexed job,
      // and a key holding the whole normalized description kept a second
      // copy of every listing in memory. Every match on this alias is
      // confirmed by comparing the full content (the index's resolve).
      key: `content:${contentCompany}\u0000${contentLocation}\u0000${digestListingContent(exactContent)}`,
      kind: "exact_listing_content",
      confidence: "strong",
      priority: 50,
    });
  }

  const title = input.title ? normalizeText(input.title) : "";
  const company = input.company ? normalizeText(input.company) : "";
  const location = input.location ? normalizeText(input.location) : "";
  // One job listed by two different sites (ADR 0030): the same title, the
  // same employer and the same place, and no two different application
  // forms. The host is not part of it; a board and the employer's own form
  // rarely share one. The index only accepts it between sightings from
  // different sites, so two openings on one site stay two jobs.
  if (
    input.matchAcrossSources &&
    title &&
    company &&
    location &&
    input.canonicalUrl
  ) {
    aliases.push({
      key: `cross-source:${title}\u0000${company}\u0000${location}`,
      kind: "cross_source_listing_facts",
      confidence: "strong",
      priority: 60,
    });
  }
  const postedDate = normalizePostedDate(input);
  if (title && company && location && postedDate) {
    aliases.push({
      key: `facts:${title}\u0000${company}\u0000${location}\u0000${postedDate}`,
      kind: "corroborated_listing_facts",
      confidence: "possible",
      priority: 100,
    });
  }

  // Alias-kind prefixes are disjoint and entries are appended in priority order,
  // so a de-duplication map and sort cannot change the result.
  return aliases;
}

/**
 * The site a listing link belongs to: its host and first path segment, since
 * several sources can share one host (ADR 0030).
 */
function readListingSiteKey(value: string): string | null {
  try {
    const parsed = new URL(value);
    const firstSegment = parsed.pathname.split("/").find(Boolean) ?? "";
    return `${parsed.host.toLowerCase()}/${firstSegment.toLowerCase()}`;
  } catch {
    return null;
  }
}

function readListingSiteKeys(input: JobIdentityInput): Set<string> {
  const keys = new Set<string>();
  for (const url of [
    input.canonicalUrl,
    ...(input.alternateListingUrls ?? []),
  ]) {
    const key = url ? readListingSiteKey(url) : null;
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Where a sighting says to apply, when that is somewhere other than its own
 * listing page: the path only, since one form can be reached on two hosts.
 */
function readApplicationRoutePath(input: JobIdentityInput): string | null {
  if (!input.applicationUrl) return null;
  const application = normalizeJobIdentityUrl(input.applicationUrl);
  if (
    input.canonicalUrl &&
    application === normalizeJobIdentityUrl(input.canonicalUrl)
  ) {
    return null;
  }
  try {
    const parsed = new URL(application);
    return `${parsed.pathname.toLowerCase()}${parsed.search}`;
  } catch {
    return null;
  }
}

function hasCompatibleSeniority(
  left: JobIdentityInput,
  right: JobIdentityInput,
): boolean {
  const leftLevel = normalizeText(left.seniority ?? "");
  const rightLevel = normalizeText(right.seniority ?? "");
  return !leftLevel || !rightLevel || leftLevel === rightLevel;
}

/**
 * Title, employer and place identify one job only across sites, and only
 * when the two do not name different application forms: a site that lists
 * the same title twice at one employer and place has two openings, and two
 * known, different forms are two openings too.
 */
export function areListedOnDifferentSites(
  left: JobIdentityInput,
  right: JobIdentityInput,
): boolean {
  if (!hasCompatibleSeniority(left, right)) return false;
  const leftSites = readListingSiteKeys(left);
  const rightSites = readListingSiteKeys(right);
  if (leftSites.size === 0 || rightSites.size === 0) return false;
  for (const site of leftSites) {
    if (rightSites.has(site)) return false;
  }
  const leftRoute = readApplicationRoutePath(left);
  const rightRoute = readApplicationRoutePath(right);
  return !leftRoute || !rightRoute || leftRoute === rightRoute;
}

export function createJobIdentityDigest(input: JobIdentityInput): string {
  const basis = buildJobIdentityAliases(input)
    // Ids stay what they were before cross-source matching existed.
    .filter(
      (alias) =>
        alias.confidence === "strong" &&
        alias.kind !== "cross_source_listing_facts",
    )
    .map((alias) => alias.key)
    .join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < basis.length; index += 1) {
    hash ^= basis.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function intersectValues<T>(
  current: ReadonlySet<T>,
  incoming: ReadonlySet<T>,
): ReadonlySet<T> {
  if (current === incoming) {
    return current;
  }
  if (current.size === 1) {
    const value = current.values().next().value as T;
    return incoming.has(value) ? current : new Set<T>();
  }
  if (incoming.size === 1) {
    const value = incoming.values().next().value as T;
    return current.has(value) ? incoming : new Set<T>();
  }

  const [smaller, larger] =
    current.size <= incoming.size ? [current, incoming] : [incoming, current];
  const intersection = new Set<T>();
  for (const value of smaller) {
    if (larger.has(value)) {
      intersection.add(value);
    }
  }
  return intersection;
}

/** The inputs `buildJobIdentityAliases` reads, copied so a later change shows. */
type AliasBasis = readonly (string | boolean | null | undefined)[];

function readAliasBasis(input: JobIdentityInput): AliasBasis {
  return [
    input.source,
    input.sourceJobId,
    input.canonicalUrl,
    input.applicationUrl,
    input.providerKey,
    input.providerBoardToken,
    input.providerIdentifier,
    input.title,
    input.company,
    input.location,
    input.description,
    input.postedAt,
    input.postedAtText,
    input.matchAcrossSources,
    ...(input.alternateListingUrls ?? []),
  ];
}

function sameAliasBasis(left: AliasBasis, right: AliasBasis): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * Aliases already built for an indexed value. A search builds several
 * indexes over every saved job at each checkpoint, and normalizing each
 * job's whole description every time took seconds at a few thousand jobs.
 * Entries go with their values, and a value whose identity fields changed
 * gets its aliases built again.
 */
const indexedAliasCache = new WeakMap<
  object,
  { basis: AliasBasis; aliases: readonly JobIdentityAlias[] }[]
>();

function readIndexedAliases(
  value: object,
  input: JobIdentityInput,
): readonly JobIdentityAlias[] {
  const basis = readAliasBasis(input);
  const entries = indexedAliasCache.get(value);
  const cached = entries?.find((entry) => sameAliasBasis(entry.basis, basis));
  if (cached) return cached.aliases;
  const aliases = buildJobIdentityAliases(input);
  // One value is indexed with and without cross-source matching.
  indexedAliasCache.set(value, [
    { basis, aliases },
    ...(entries ?? []).slice(0, 1),
  ]);
  return aliases;
}

export function createJobIdentityIndex<T extends object>(
  values: readonly T[],
  selectIdentity: (value: T) => JobIdentityInput,
): JobIdentityIndex<T> {
  const valuesByAlias = new Map<string, Set<T>>();
  const aliasesByValue = new Map<T, readonly JobIdentityAlias[]>();

  const add = (value: T): void => {
    const aliases = readIndexedAliases(value, selectIdentity(value));
    aliasesByValue.set(value, aliases);
    for (const alias of aliases) {
      const matches = valuesByAlias.get(alias.key);
      if (matches) {
        matches.add(value);
      } else {
        valuesByAlias.set(alias.key, new Set([value]));
      }
    }
  };

  const remove = (value: T): void => {
    const aliases = aliasesByValue.get(value) ?? [];
    for (const alias of aliases) {
      const matches = valuesByAlias.get(alias.key);
      matches?.delete(value);
      if (matches?.size === 0) {
        valuesByAlias.delete(alias.key);
      }
    }
    aliasesByValue.delete(value);
  };

  const resolve = (identity: JobIdentityInput): JobIdentityResolution<T> => {
    // A frozen identity (a stored ledger row) is resolved again on every
    // workspace refresh; its aliases are built once.
    const aliases = Object.isFrozen(identity)
      ? readIndexedAliases(identity, identity)
      : buildJobIdentityAliases(identity);
    // A URL still matches when corrected card facts have no indexed alias.
    // Check every known alias before selecting it: an alias naming another
    // posting must not attach that posting's history or activity to this one.
    const matchedStrongAliases: JobIdentityAlias[] = [];
    let strongCandidates: ReadonlySet<T> | null = null;

    for (const alias of aliases) {
      if (alias.confidence !== "strong") {
        continue;
      }
      const indexedMatches = valuesByAlias.get(alias.key);
      const matches =
        (alias.kind === "employer_application_url" ||
          alias.kind === "source_posting_id") &&
        indexedMatches
          ? new Set(
              [...indexedMatches].filter((candidate) => {
                // One employer form can serve several roles, and boards on
                // one host reuse posting numbers: neither makes two postings
                // the same job when they name different roles.
                const other = selectIdentity(candidate);
                const listingUrls = (value: JobIdentityInput) =>
                  [value.canonicalUrl, ...(value.alternateListingUrls ?? [])]
                    .filter((url): url is string => Boolean(url))
                    .map(normalizeJobIdentityUrl);
                const otherUrls = new Set(listingUrls(other));
                const sameListingSite =
                  alias.kind !== "source_posting_id" ||
                  (identity.source === "target_site" ||
                  other.source === "target_site"
                    ? listingUrls(identity).some((url) => otherUrls.has(url))
                    : [...readListingSiteKeys(identity)].some((site) =>
                        readListingSiteKeys(other).has(site),
                      ));
                return (
                  sameListingSite &&
                  (!identity.title?.trim() ||
                    !other.title?.trim() ||
                    hasCompatibleTitles(identity, other)) &&
                  hasCompatibleSeniority(identity, other)
                );
              }),
            )
          : alias.kind === "exact_listing_content" && indexedMatches
            ? new Set(
                [...indexedMatches].filter((candidate) =>
                  hasEquivalentListingContentIdentity(
                    identity,
                    selectIdentity(candidate),
                  ),
                ),
              )
            : alias.kind === "cross_source_listing_facts" && indexedMatches
              ? new Set(
                  indexedMatches.size > MAX_CROSS_SOURCE_CANDIDATES
                    ? []
                    : [...indexedMatches].filter((candidate) =>
                        areListedOnDifferentSites(
                          identity,
                          selectIdentity(candidate),
                        ),
                      ),
                )
              : indexedMatches;
      if (!matches || matches.size === 0) {
        continue;
      }
      matchedStrongAliases.push(alias);
      strongCandidates = strongCandidates
        ? intersectValues(strongCandidates, matches)
        : matches;
      if (strongCandidates.size === 0) {
        return {
          status: "conflict",
          candidates: [],
          matchedAliases: matchedStrongAliases,
        };
      }
    }

    const corroboratingAliases = aliases.filter(
      (alias) => alias.confidence === "corroborating",
    );
    const matchedCorroboratingAliases: JobIdentityAlias[] = [];
    let corroboratingCandidates: ReadonlySet<T> | null = null;
    for (const alias of corroboratingAliases) {
      const matches = valuesByAlias.get(alias.key);
      if (!matches || matches.size === 0) {
        continue;
      }
      matchedCorroboratingAliases.push(alias);
      corroboratingCandidates = corroboratingCandidates
        ? intersectValues(corroboratingCandidates, matches)
        : matches;
    }

    if (strongCandidates && corroboratingCandidates) {
      const corroborated = intersectValues(
        strongCandidates,
        corroboratingCandidates,
      );
      if (corroborated.size === 0) {
        return {
          status: "conflict",
          candidates: [],
          matchedAliases: [
            ...matchedStrongAliases,
            ...matchedCorroboratingAliases,
          ],
        };
      }
      strongCandidates = corroborated;
    }

    if (strongCandidates?.size === 1) {
      return {
        status: "matched",
        value: [...strongCandidates][0]!,
        matchedAliases: [
          ...matchedStrongAliases,
          ...matchedCorroboratingAliases,
        ],
      };
    }

    const possibleAliases = aliases.filter(
      (alias) => alias.confidence === "possible",
    );
    const matchedPossibleAliases: JobIdentityAlias[] = [];
    let possibleCandidates: ReadonlySet<T> | null = null;
    for (const alias of possibleAliases) {
      const matches = valuesByAlias.get(alias.key);
      if (!matches || matches.size === 0) {
        continue;
      }
      matchedPossibleAliases.push(alias);
      possibleCandidates = possibleCandidates
        ? intersectValues(possibleCandidates, matches)
        : matches;
    }

    if (strongCandidates) {
      if (possibleCandidates) {
        const narrowed = intersectValues(strongCandidates, possibleCandidates);
        if (narrowed.size === 1) {
          return {
            status: "matched",
            value: [...narrowed][0]!,
            matchedAliases: [
              ...matchedStrongAliases,
              ...matchedCorroboratingAliases,
              ...matchedPossibleAliases,
            ],
          };
        }
        if (narrowed.size === 0) {
          return {
            status: "ambiguous",
            candidates: [...strongCandidates],
            matchedAliases: matchedStrongAliases,
          };
        }
        strongCandidates = narrowed;
      }
      return {
        status: "ambiguous",
        candidates: [...strongCandidates],
        matchedAliases: [
          ...matchedStrongAliases,
          ...matchedCorroboratingAliases,
          ...matchedPossibleAliases,
        ],
      };
    }

    let nonStrongCandidates = corroboratingCandidates;
    const nonStrongAliases = [...matchedCorroboratingAliases];
    if (possibleCandidates) {
      nonStrongCandidates = nonStrongCandidates
        ? intersectValues(nonStrongCandidates, possibleCandidates)
        : possibleCandidates;
      nonStrongAliases.push(...matchedPossibleAliases);
    }

    if (nonStrongCandidates && nonStrongCandidates.size > 0) {
      return {
        status: "possible",
        candidates: [...nonStrongCandidates],
        matchedAliases: nonStrongAliases,
      };
    }

    return { status: "none", candidates: [], matchedAliases: [] };
  };

  for (const value of values) {
    add(value);
  }

  return {
    add,
    remove,
    replace(previous, next) {
      remove(previous);
      add(next);
    },
    resolve,
    find(identity) {
      const resolution = resolve(identity);
      return resolution.status === "matched" ? resolution.value : null;
    },
  };
}
