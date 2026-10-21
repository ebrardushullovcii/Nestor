import type { JobFinderAiClient } from "@nestor/ai-providers";
import {
  SavedJobDiscoveryProvenanceSchema,
  SavedJobSchema,
  jobPostingDetailQualityValues,
  type ApplicationStatus,
  type CandidateProfile,
  type JobKeywordSignal,
  type JobRequirementAssessment,
  type JobSearchPreferences,
  type JobPosting,
  type JobPostingDetailQuality,
  type MatchAssessment,
  type SavedJob,
  type SavedJobDiscoveryProvenance,
} from "@nestor/contracts";
import {
  evaluateCompensationFit,
  parseNormalizedCompensation,
} from "./matching-compensation";
import type { MatchAssessmentPostingInput } from "./match-assessment-posting-input";
import { createMatchAssessmentChangeAudit } from "./match-assessment-change-audit";
import {
  MATCH_ASSESSMENT_SCORER_VERSION,
  createFitVerdictFingerprint,
  createMatchAssessmentPostingFingerprint,
} from "./match-assessment-session";
import { createMatchAssessmentPostingInput } from "./match-assessment-posting-input";
import { preserveCompletedAssessment } from "./fit-judgment-apply";
import { applyFitJudgment, toFitJudgment } from "./fit-judgment";
import { buildBookkeepingDimensions } from "./matching-dimensions";
import { canonicalizeLocationAliases } from "./location-normalization";
import {
  createJobIdentityDigest,
  createJobIdentityIndex,
  hasEquivalentListingContentIdentity,
} from "./job-identity";
import { assessJobPostingDetailQuality } from "./job-posting-detail-quality";
import {
  attributeLegacySighting,
  canSwitchCanonicalSighting,
  isLikelyAccessGateListingUrl,
  selectCanonicalSighting,
} from "./listing-sightings";
import {
  buildDiscoveryJobs as orderVisibleDiscoveryJobs,
  isLikelyEmptyNonDetailPosting,
  isLikelyUtilityShortlistJob,
} from "./matching-review-queue";
export {
  buildApplicationRecords,
  compareDiscoveryJobs,
  buildDiscoveryJobs,
  buildReviewQueue,
} from "./matching-review-queue";
import {
  isAbsentFieldText,
  normalizeText,
  tokenize,
  uniqueStrings,
} from "./shared";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type PhraseMatchMode = "generic" | "title" | "location";

const titleTokenAliases = new Map<string, string>([
  ["developer", "engineer"],
  ["developers", "engineer"],
  ["dev", "engineer"],
]);

const locationNoiseTokens = new Set([
  "remote",
  "hybrid",
  "onsite",
  "on",
  "site",
  "office",
  "home",
  "anywhere",
  "worldwide",
  "global",
]);

type BroadLocationRegion = "europe" | "americas" | "apac" | "africa";
type EuropeanLocationRegion =
  | "northern_europe"
  | "southern_europe"
  | "western_europe"
  | "central_europe"
  | "eastern_europe";

const broadLocationRegionPatterns: Record<
  BroadLocationRegion,
  readonly RegExp[]
> = {
  europe: [
    /\beurope\b/,
    /\bemea\b/,
    /\buk\b|\bunited kingdom\b|\bireland\b/,
    /\bkosovo\b|\bprishtina\b|\bpristina\b|\balbania\b|\bbalkan(?:s)?\b/,
    /\bspain\b|\bportugal\b|\bfrance\b|\bgermany\b|\baustria\b|\bnetherlands\b/,
    /\bhungary\b|\bpoland\b|\bitaly\b|\bsweden\b|\bnorway\b|\bdenmark\b|\bfinland\b/,
  ],
  americas: [
    /\bamericas?\b|\blatam\b/,
    /\bunited states\b|\busa\b|\bu\s*s\b|\bcanada\b/,
    /\bbrazil\b|\bmexico\b|\bargentina\b|\bcolombia\b/,
  ],
  apac: [
    /\bapac\b|\basia\b/,
    /\baustralia\b|\bnew zealand\b|\bjapan\b|\bsingapore\b|\bindia\b/,
  ],
  africa: [/\bafrica\b|\bnigeria\b|\bkenya\b|\bsouth africa\b/],
};

const europeanLocationRegionPatterns: Record<
  EuropeanLocationRegion,
  readonly RegExp[]
> = {
  northern_europe: [
    /\bnorthern europe\b/,
    /\b(?:united kingdom|uk|ireland|sweden|norway|denmark|finland|iceland)\b/,
  ],
  southern_europe: [
    /\bsouthern europe\b/,
    /\b(?:kosovo|prishtina|pristina|albania|balkans?|spain|portugal|italy|greece|malta|cyprus)\b/,
  ],
  western_europe: [
    /\bwestern europe\b/,
    /\b(?:france|germany|austria|netherlands|belgium|luxembourg|switzerland)\b/,
  ],
  central_europe: [
    /\bcentral europe\b/,
    /\b(?:hungary|poland|czechia|czech republic|slovakia|slovenia|croatia)\b/,
  ],
  eastern_europe: [
    /\beastern europe\b/,
    /\b(?:romania|bulgaria|moldova|ukraine|estonia|latvia|lithuania)\b/,
  ],
};

function inferBroadLocationRegions(value: string): Set<BroadLocationRegion> {
  const normalized = normalizeText(value);
  return new Set(
    (
      Object.entries(broadLocationRegionPatterns) as Array<
        [BroadLocationRegion, readonly RegExp[]]
      >
    ).flatMap(([region, patterns]) =>
      patterns.some((pattern) => pattern.test(normalized)) ? [region] : [],
    ),
  );
}

function inferEuropeanLocationRegions(
  value: string,
): Set<EuropeanLocationRegion> {
  const normalized = normalizeText(value);
  return new Set(
    (
      Object.entries(europeanLocationRegionPatterns) as Array<
        [EuropeanLocationRegion, readonly RegExp[]]
      >
    ).flatMap(([region, patterns]) =>
      patterns.some((pattern) => pattern.test(normalized)) ? [region] : [],
    ),
  );
}

function normalizePhraseMatchInput(
  value: string,
  mode: PhraseMatchMode,
): string {
  const normalized = value
    .replace(/\bfullstack\b/gi, "full stack")
    .replace(/\bfront\s*end\b/gi, "frontend")
    .replace(/\bback\s*end\b/gi, "backend");

  if (mode !== "location") {
    return normalized;
  }

  return canonicalizeLocationAliases(normalized)
    .replace(/\bon\s*site\b/gi, "onsite")
    .replace(/\bwork\s+from\s+home\b/gi, "remote");
}

function tokenizePhraseMatchValue(
  value: string,
  mode: PhraseMatchMode,
): string[] {
  const tokens = tokenize(normalizePhraseMatchInput(value, mode)).flatMap(
    (token) => {
      if (mode === "location" && locationNoiseTokens.has(token)) {
        return [];
      }

      if (mode === "title") {
        return [titleTokenAliases.get(token) ?? token];
      }

      return [token];
    },
  );

  return [...new Set(tokens)];
}

// Noise tokens that assert availability across every geography rather than a
// work mode alone.

const broadRemoteGeographyPattern =
  /\bremote\b|\bhybrid\b|\bemea\b|\beurope\b|\bapac\b|\blatam\b|\bamericas?\b|\bworldwide\b|\bglobal\b/iu;

type LocationGeographySignal = {
  rawText: string;
  tokens: readonly string[];
  genericTokens: readonly string[];
  workModeTokens: readonly string[];
  noiseOnly: boolean;
  regions: ReadonlySet<BroadLocationRegion>;
  europeanRegions: ReadonlySet<EuropeanLocationRegion>;
};

function readLocationGeographySignal(value: string): LocationGeographySignal {
  // Work-mode phrases normalize into noise tokens ("work from home" reads as
  // "remote"), so classification and the retained work-mode tokens share one
  // view of the value.
  const workModeTokens = tokenize(normalizePhraseMatchInput(value, "location"));

  return {
    rawText: canonicalizeLocationAliases(value),
    tokens: tokenizePhraseMatchValue(value, "location"),
    genericTokens: tokenizePhraseMatchValue(value, "generic"),
    workModeTokens,
    noiseOnly:
      workModeTokens.length > 0 &&
      workModeTokens.every((token) => locationNoiseTokens.has(token)),
    regions: inferBroadLocationRegions(value),
    europeanRegions: inferEuropeanLocationRegions(value),
  };
}

function isEditDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  const leftLength = left.length;
  const rightLength = right.length;
  if (Math.abs(leftLength - rightLength) > 1) {
    return false;
  }

  let leftIndex = 0;
  let rightIndex = 0;
  let mismatchCount = 0;

  while (leftIndex < leftLength && rightIndex < rightLength) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    mismatchCount += 1;
    if (mismatchCount > 1) {
      return false;
    }

    if (leftLength > rightLength) {
      leftIndex += 1;
      continue;
    }

    if (rightLength > leftLength) {
      rightIndex += 1;
      continue;
    }

    leftIndex += 1;
    rightIndex += 1;
  }

  if (leftIndex < leftLength || rightIndex < rightLength) {
    mismatchCount += 1;
  }

  return mismatchCount <= 1;
}

// Avoid fuzzy title-token matching on short tokens where one edit would be too permissive.
const MIN_FUZZY_MATCH_TOKEN_LENGTH = 6;

function phraseMatchTokensEqual(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  if (
    left.length < MIN_FUZZY_MATCH_TOKEN_LENGTH ||
    right.length < MIN_FUZZY_MATCH_TOKEN_LENGTH
  ) {
    return false;
  }

  return isEditDistanceAtMostOne(left, right);
}

function everyPhraseTokenMatches(
  sourceTokens: readonly string[],
  targetTokens: readonly string[],
): boolean {
  return sourceTokens.every((sourceToken) =>
    targetTokens.some((targetToken) =>
      phraseMatchTokensEqual(sourceToken, targetToken),
    ),
  );
}

const remoteGeographyHints = [
  {
    pattern: /\b(united states|u\.s\.|u\.s|us only|usa only)\b/i,
    label: "United States",
  },
  { pattern: /\b(united kingdom|uk only|u\.k\.)\b/i, label: "United Kingdom" },
  { pattern: /\b(european union|europe|eu only)\b/i, label: "Europe" },
  { pattern: /\b(canada|canadian)\b/i, label: "Canada" },
] as const;

interface MergeDiscoveryResult {
  mergedJobs: SavedJob[];
  newJobs: SavedJob[];
  validatedCount: number;
  duplicatesMerged: number;
  invalidSkipped: number;
}

type AtsProviderHostRule = {
  provider: string;
  exact?: readonly string[];
  suffixes?: readonly string[];
};

// Metadata taxonomy only: these hosts label saved jobs with the ATS provider
// that hosted the listing. Discovery routing and workflow policy never branch
// on them.
const ATS_PROVIDER_HOST_RULES: readonly AtsProviderHostRule[] = [
  { provider: "Greenhouse", suffixes: ["greenhouse.io"] },
  { provider: "Lever", suffixes: ["lever.co"] },
  { provider: "Workday", suffixes: ["myworkdayjobs.com"] },
  { provider: "Ashby", suffixes: ["ashbyhq.com"] },
  { provider: "iCIMS", suffixes: ["icims.com", "icims.eu"] },
];

function parseHttpUrlHostname(value: string | null): string | null {
  if (!value) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  // URL.hostname already lowercases and IDN-encodes special-scheme hosts;
  // only a trailing root dot survives parsing, so strip it explicitly.
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/u, "");
  return hostname.length > 0 ? hostname : null;
}

function matchesAtsProviderHostRule(
  hostname: string,
  rule: AtsProviderHostRule,
): boolean {
  if (rule.exact?.includes(hostname)) {
    return true;
  }

  return (
    rule.suffixes?.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    ) ?? false
  );
}

function detectAtsProvider(posting: JobPosting): string | null {
  const urlCandidates = [
    posting.applicationUrl,
    posting.canonicalUrl,
    posting.employerWebsiteUrl,
  ];

  for (const value of urlCandidates) {
    const hostname = parseHttpUrlHostname(value);
    if (hostname === null) {
      continue;
    }

    const matchedRule = ATS_PROVIDER_HOST_RULES.find((rule) =>
      matchesAtsProviderHostRule(hostname, rule),
    );
    if (matchedRule) {
      return matchedRule.provider;
    }
  }

  return null;
}

function buildKeywordSignals(posting: JobPosting): JobKeywordSignal[] {
  const buckets: Array<{
    values: readonly string[];
    kind: JobKeywordSignal["kind"];
    weight: number;
  }> = [
    { values: posting.keySkills, kind: "skill", weight: 5 },
    { values: posting.responsibilities, kind: "responsibility", weight: 3 },
    { values: posting.minimumQualifications, kind: "qualification", weight: 4 },
    {
      values: posting.preferredQualifications,
      kind: "qualification",
      weight: 2,
    },
    { values: posting.benefits, kind: "benefit", weight: 1 },
  ];
  const seen = new Set<string>();

  return buckets.flatMap(({ values, kind, weight }) =>
    values.flatMap((value, index) => {
      const label = value.trim();

      if (!label) {
        return [];
      }

      const key = `${kind}:${normalizeText(label)}`;
      if (seen.has(key)) {
        return [];
      }

      seen.add(key);
      return [
        {
          id: `job_keyword_${kind}_${index}_${normalizeText(label).replaceAll(" ", "_")}`,
          label,
          kind,
          weight,
        },
      ];
    }),
  );
}

function buildScreeningHints(posting: JobPosting): SavedJob["screeningHints"] {
  const remoteHintSource = [
    posting.location,
    posting.summary,
    posting.description,
  ]
    .filter(Boolean)
    .join(" ");
  const normalizedText = normalizeText(
    [
      posting.location,
      posting.summary,
      posting.description,
      ...posting.minimumQualifications,
      ...posting.preferredQualifications,
    ]
      .filter(Boolean)
      .join(" "),
  );
  const supportsRemoteGeographyHints =
    posting.workMode.includes("remote") ||
    posting.workMode.includes("flexible") ||
    /\bremote\b/i.test(remoteHintSource);

  return {
    sponsorshipText:
      normalizedText.includes("visa sponsorship") ||
      normalizedText.includes("work authorization")
        ? "Work authorization or sponsorship details are mentioned in the listing."
        : null,
    requiresSecurityClearance:
      normalizedText.includes("security clearance") ||
      normalizedText.includes("active clearance")
        ? true
        : null,
    relocationText:
      normalizedText.includes("relocation") ||
      normalizedText.includes("relocate")
        ? "Relocation support or requirements are mentioned in the listing."
        : null,
    travelText:
      /(?:\b(?:requires?|must|expected|willing|ability|availability)\b[^.!?]{0,72}\btravel\b|\btravel\b[^.!?]{0,48}\b(?:required|expected|occasionally|regularly|up to\s+\d{1,3}%|\d{1,3}%)\b)/iu.test(
        normalizedText,
      )
        ? "Travel expectations are mentioned in the listing."
        : null,
    remoteGeographies: supportsRemoteGeographyHints
      ? uniqueStrings(
          remoteGeographyHints.flatMap((entry) =>
            entry.pattern.test(remoteHintSource) ? [entry.label] : [],
          ),
        )
      : [],
    requiresConsentInterrupt: null,
    requiresConsentInterruptKind: null,
  };
}

function mergeKeywordSignals(
  existingSignals: readonly JobKeywordSignal[],
  nextSignals: readonly JobKeywordSignal[],
): JobKeywordSignal[] {
  const byKey = new Map<string, JobKeywordSignal>();

  for (const signal of [...existingSignals, ...nextSignals]) {
    byKey.set(`${signal.kind}:${normalizeText(signal.label)}`, signal);
  }

  return [...byKey.values()];
}

function selectLatestProviderUpdate(
  incoming: string | null,
  existing: string | null | undefined,
): string | null {
  if (!incoming) {
    return existing ?? null;
  }
  if (!existing) {
    return incoming;
  }
  return Date.parse(incoming) >= Date.parse(existing) ? incoming : existing;
}

function jobPostingDetailQualityRank(quality: JobPostingDetailQuality): number {
  return jobPostingDetailQualityValues.indexOf(quality);
}

function strongestDetailQuality(
  left: JobPostingDetailQuality,
  right: JobPostingDetailQuality,
): JobPostingDetailQuality {
  return jobPostingDetailQualityRank(left) >= jobPostingDetailQualityRank(right)
    ? left
    : right;
}

// Historical quality metadata remains evidence even if the current rubric
// cannot reconstruct it. Incoming strength is grounded in current content.
function hasWeakerIncomingDetailEvidence(
  posting: JobPosting,
  existingJob: SavedJob,
): boolean {
  const existingQuality = strongestDetailQuality(
    existingJob.detailQuality,
    assessJobPostingDetailQuality(existingJob),
  );

  return (
    jobPostingDetailQualityRank(assessJobPostingDetailQuality(posting)) <
    jobPostingDetailQualityRank(existingQuality)
  );
}

// Preserved groups cover every resume-affecting content field verbatim so a
// weaker recrawl leaves the stored resume-staleness signature untouched.
// Card-level freshness (lastSeenAt, providerUpdatedAt, provenance) still flows;
// nullable evidence links only fall back when the thinner recrawl dropped them.
function preserveRicherExistingDetail(
  enrichedPosting: JobPosting,
  existingJob: SavedJob,
): JobPosting {
  const existingQuality = strongestDetailQuality(
    existingJob.detailQuality,
    assessJobPostingDetailQuality(existingJob),
  );

  return {
    ...enrichedPosting,
    title: existingJob.title,
    company: existingJob.company,
    location: existingJob.location,
    workMode: [...existingJob.workMode],
    summary: existingJob.summary,
    description: existingJob.description,
    keySkills: [...existingJob.keySkills],
    responsibilities: [...existingJob.responsibilities],
    minimumQualifications: [...existingJob.minimumQualifications],
    preferredQualifications: [...existingJob.preferredQualifications],
    benefits: [...existingJob.benefits],
    seniority: existingJob.seniority,
    employmentType: existingJob.employmentType,
    department: existingJob.department,
    team: existingJob.team,
    salaryText: enrichedPosting.salaryText ?? existingJob.salaryText,
    employerWebsiteUrl:
      enrichedPosting.employerWebsiteUrl ?? existingJob.employerWebsiteUrl,
    employerDomain:
      enrichedPosting.employerDomain ?? existingJob.employerDomain,
    detailQuality: existingQuality,
    keywordSignals: [...existingJob.keywordSignals],
  };
}

export function enrichDiscoveredPosting(
  posting: JobPosting,
  existingJob: SavedJob | undefined,
): JobPosting {
  const normalizedCompensation = parseNormalizedCompensation(
    posting.salaryText,
  );
  const screeningHints = buildScreeningHints(posting);
  const existingCompensation = existingJob?.normalizedCompensation;
  const postingKeywordSignals = posting.keywordSignals ?? [];

  const enrichedPosting: JobPosting = {
    ...posting,
    title:
      existingJob &&
      hasEquivalentListingContentIdentity(posting, existingJob) &&
      normalizeText(existingJob.title).length >
        normalizeText(posting.title).length
        ? existingJob.title
        : posting.title,
    providerUpdatedAt: selectLatestProviderUpdate(
      posting.providerUpdatedAt,
      existingJob?.providerUpdatedAt,
    ),
    applicationUrl:
      posting.applicationUrl ??
      existingJob?.applicationUrl ??
      (posting.applyPath === "external_redirect"
        ? posting.employerWebsiteUrl
        : null),
    firstSeenAt:
      existingJob?.firstSeenAt ?? posting.firstSeenAt ?? posting.discoveredAt,
    lastSeenAt: posting.lastSeenAt ?? posting.discoveredAt,
    // A re-sighting from a listing card has not read the page. Dropping the
    // earlier read's record made every later search read every saved page
    // again, which is also how a board that rate-limits got asked twice.
    listingDetailFetch:
      posting.listingDetailFetch ?? existingJob?.listingDetailFetch ?? null,
    lastVerifiedActiveAt: posting.lastVerifiedActiveAt ?? posting.discoveredAt,
    // Salary the listing stated, kept across re-sightings so a card-only
    // re-read does not silently drop what a detail page published.
    salaryText: posting.salaryText ?? existingJob?.salaryText ?? null,
    // A band may only survive while some sighting of this listing actually
    // stated a salary. Carrying an earlier band onto a posting that states
    // none is how a figure no employer published reached the screen.
    normalizedCompensation:
      existingCompensation &&
      (posting.salaryText ?? existingJob?.salaryText) &&
      (existingCompensation.minAmount !== null ||
        existingCompensation.maxAmount !== null)
        ? {
            ...existingCompensation,
            ...normalizedCompensation,
            currency:
              normalizedCompensation.currency ?? existingCompensation.currency,
            interval:
              normalizedCompensation.interval ?? existingCompensation.interval,
            minAmount:
              normalizedCompensation.minAmount ??
              existingCompensation.minAmount,
            maxAmount:
              normalizedCompensation.maxAmount ??
              existingCompensation.maxAmount,
            minAnnualUsd:
              normalizedCompensation.minAnnualUsd ??
              existingCompensation.minAnnualUsd,
            maxAnnualUsd:
              normalizedCompensation.maxAnnualUsd ??
              existingCompensation.maxAnnualUsd,
          }
        : normalizedCompensation,
    atsProvider:
      posting.atsProvider ??
      existingJob?.atsProvider ??
      detectAtsProvider(posting),
    screeningHints: {
      sponsorshipText:
        screeningHints.sponsorshipText ??
        existingJob?.screeningHints.sponsorshipText ??
        null,
      requiresSecurityClearance:
        screeningHints.requiresSecurityClearance ??
        existingJob?.screeningHints.requiresSecurityClearance ??
        null,
      relocationText:
        screeningHints.relocationText ??
        existingJob?.screeningHints.relocationText ??
        null,
      travelText:
        screeningHints.travelText ??
        existingJob?.screeningHints.travelText ??
        null,
      remoteGeographies: uniqueStrings([
        ...(existingJob?.screeningHints.remoteGeographies ?? []),
        ...screeningHints.remoteGeographies,
      ]),
      requiresConsentInterrupt:
        screeningHints.requiresConsentInterrupt ??
        existingJob?.screeningHints.requiresConsentInterrupt ??
        null,
      requiresConsentInterruptKind:
        screeningHints.requiresConsentInterruptKind ??
        existingJob?.screeningHints.requiresConsentInterruptKind ??
        null,
    },
    keywordSignals: mergeKeywordSignals(
      existingJob?.keywordSignals ?? [],
      postingKeywordSignals.length > 0
        ? postingKeywordSignals
        : buildKeywordSignals(posting),
    ),
  };

  if (
    existingJob &&
    isLikelyAccessGateListingUrl(posting.canonicalUrl) &&
    !isLikelyAccessGateListingUrl(existingJob.canonicalUrl)
  ) {
    return {
      ...preserveRicherExistingDetail(enrichedPosting, existingJob),
      title: existingJob.title,
      canonicalUrl: existingJob.canonicalUrl,
      applicationUrl: existingJob.applicationUrl,
    };
  }

  if (existingJob && hasWeakerIncomingDetailEvidence(posting, existingJob)) {
    return preserveRicherExistingDetail(enrichedPosting, existingJob);
  }

  return enrichedPosting;
}

function matchesLocationPhrase(
  candidateSignal: LocationGeographySignal,
  desiredSignal: LocationGeographySignal,
): boolean {
  const candidateTokens = candidateSignal.tokens;
  const normalizedCandidate = candidateTokens.join(" ");
  const desiredTokens = desiredSignal.tokens;

  if (desiredTokens.length === 0) {
    const fallbackDesiredTokens = desiredSignal.genericTokens;
    if (fallbackDesiredTokens.length === 0) {
      return false;
    }

    if (fallbackDesiredTokens.length === 1) {
      return candidateSignal.genericTokens.some((candidateToken) =>
        phraseMatchTokensEqual(candidateToken, fallbackDesiredTokens[0]!),
      );
    }

    return everyPhraseTokenMatches(
      fallbackDesiredTokens,
      candidateSignal.genericTokens,
    );
  }

  // An empty candidate side cannot match a concrete place; the symmetric
  // token comparison below would otherwise hold vacuously.
  if (candidateTokens.length === 0) {
    return false;
  }

  if (desiredTokens.length === 1) {
    return candidateTokens.some((candidateToken) =>
      phraseMatchTokensEqual(candidateToken, desiredTokens[0]!),
    );
  }

  const normalizedDesired = desiredTokens.join(" ");
  if (
    new RegExp(`(^|\\s)${escapeRegex(normalizedDesired)}($|\\s)`).test(
      normalizedCandidate,
    )
  ) {
    return true;
  }

  return (
    everyPhraseTokenMatches(desiredTokens, candidateTokens) ||
    everyPhraseTokenMatches(candidateTokens, desiredTokens)
  );
}

function isCoarseRegionalSignal(signal: LocationGeographySignal): boolean {
  // Only europe has a finer subregion layer; every other broad region is
  // terminal, so any signal resolving to it is coarse by definition.
  return signal.europeanRegions.size === 0;
}

// Conservative containment for exclusion decisions: possible regional overlap
// conflicts, proven separation does not. Two fine-grained places in the same
// subregion are not enough evidence; at least one side must stop at the
// region level.
function locationRegionsPossiblyOverlap(
  left: LocationGeographySignal,
  right: LocationGeographySignal,
): boolean {
  if (left.regions.size === 0 || right.regions.size === 0) {
    return false;
  }

  if (![...left.regions].some((region) => right.regions.has(region))) {
    return false;
  }

  if (!isCoarseRegionalSignal(left) && !isCoarseRegionalSignal(right)) {
    return false;
  }

  if (
    left.regions.has("europe") &&
    right.regions.has("europe") &&
    left.europeanRegions.size > 0 &&
    right.europeanRegions.size > 0 &&
    ![...left.europeanRegions].some((region) =>
      right.europeanRegions.has(region),
    )
  ) {
    return false;
  }

  return true;
}

export type LocationCompatibilityState =
  | "compatible"
  | "incompatible"
  | "unknown";

// Positive preference fit only. Work-mode noise ("Remote", "Hybrid") states
// how a job is done, never where, so it cannot confirm geographic
// compatibility; "worldwide"/"anywhere" coverage is the documented exception
// because it includes every saved area, unless the person turned off
// "Count remote jobs as any location".

// A listing that says where it sits but never says it can be done away from
// there. The place words alone are not enough — a board can leave work mode
// out entirely — so an explicit in-person phrase counts as onsite too.

export type WorkModeCompatibilityState = "compatible" | "conflict" | "unknown";

// Exclusion conflicts are a different question from positive fit: they skip
// listings and must rest on concrete or conservatively contained geography.
// Noise-only listings never conflict with an arbitrary excluded place; they
// can only conflict when an exclusion targets that same work-mode noise.
export function matchesExcludedLocation(
  candidate: string,
  excludedValues: readonly string[],
): boolean {
  if (excludedValues.length === 0) {
    return false;
  }

  // An absence placeholder cannot be excluded: nothing was observed to exclude.
  if (isAbsentFieldText(candidate)) {
    return false;
  }

  const candidateSignal = readLocationGeographySignal(candidate);
  const matchesWorkModeExclusion = (excludedSignal: LocationGeographySignal) =>
    excludedSignal.noiseOnly &&
    excludedSignal.workModeTokens.length > 0 &&
    excludedSignal.workModeTokens.every((token) =>
      candidateSignal.workModeTokens.includes(token),
    );

  if (candidateSignal.noiseOnly) {
    return excludedValues.some((value) =>
      matchesWorkModeExclusion(readLocationGeographySignal(value)),
    );
  }

  return excludedValues.some((value) => {
    const excludedSignal = readLocationGeographySignal(value);
    if (excludedSignal.noiseOnly) {
      return matchesWorkModeExclusion(excludedSignal);
    }

    if (matchesLocationPhrase(candidateSignal, excludedSignal)) {
      return true;
    }

    return (
      broadRemoteGeographyPattern.test(candidateSignal.rawText) &&
      locationRegionsPossiblyOverlap(candidateSignal, excludedSignal)
    );
  });
}

export function toSavedJobId(posting: JobPosting): string {
  return `job_${posting.source}_${posting.sourceJobId}`;
}

// Boards publish more than one value in a single field: "Full-Time/Part-Time",
// "Contract or Permanent", "Mid, Senior". Read as one string, the part-time
// job a person asked for looked like a conflict with their part-time
// preference. Each stated value is compared on its own, and one match is
// enough.

/**
 * The assessment of a job the model has not judged yet (ADR 0041). It holds
 * only what needs no judgment: salary arithmetic against the saved minimum,
 * the application path's effort, and the requirements the model listed when
 * it read the listing in full. Role, place, level and the score are the
 * model's to decide; until it has, the job says it is not judged yet, and no
 * title, place or keyword rule guesses in its place.
 */
export function createMatchAssessment<
  TPosting extends MatchAssessmentPostingInput,
>(
  _profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  posting: TPosting,
  extractedRequirements: readonly JobRequirementAssessment[] = [],
): MatchAssessment {
  return {
    scorerVersion: MATCH_ASSESSMENT_SCORER_VERSION,
    contextFingerprint: null,
    postingFingerprint: null,
    score: 0,
    scoreIsUpperBound: false,
    compensationFit: evaluateCompensationFit(
      posting.salaryText,
      searchPreferences.compensation,
    ),
    locationReach: "unknown",
    titleFamilyMatch: null,
    dimensions: {
      roleSuitability: {
        state: "unknown",
        explanation: NOT_JUDGED_EXPLANATION,
        evidence: [],
      },
      preferenceAlignment: {
        state: "unknown",
        explanation: NOT_JUDGED_EXPLANATION,
        evidence: [],
      },
      ...buildBookkeepingDimensions({
        posting,
        searchPreferences,
        requirements: extractedRequirements,
      }),
    },
    reasons: [],
    gaps: [],
    recommendation: "review_before_applying",
    recommendationRationale: NOT_JUDGED_EXPLANATION,
    requirements: [...extractedRequirements],
    judgment: null,
  };
}

const NOT_JUDGED_EXPLANATION =
  "Not judged yet. The AI judges this job against your profile and goals after a search, or when you choose Read and assess listing.";

export async function createMatchAssessmentAsync(
  aiClient: JobFinderAiClient,
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  posting: JobPosting & { matchAssessment?: MatchAssessment | null },
  signal?: AbortSignal,
  options: { background?: boolean } = {},
): Promise<MatchAssessment> {
  signal?.throwIfAborted();
  const assistedAssessment = await aiClient.assessJobFit({
    ...(signal ? { signal } : {}),
    ...(options.background ? { background: true } : {}),
    assessmentDate: new Date().toISOString().slice(0, 10),
    profile,
    searchPreferences,
    job: posting,
  });

  signal?.throwIfAborted();
  const previous = posting.matchAssessment;
  if (!assistedAssessment || !assistedAssessment.requirements?.length) {
    throw new Error(
      "The fit assessment could not be completed. Your previous assessment was kept. Try again.",
    );
  }

  // The model read the full listing against the profile and goals; its score
  // and verdict stand (ADR 0041). The requirements it found feed the
  // evidence counts and the requirement list the screen shows.
  const withRequirements = createMatchAssessment(
    profile,
    searchPreferences,
    posting,
    assistedAssessment.requirements,
  );
  const judgment = toFitJudgment(
    {
      score: assistedAssessment.score,
      recommendation:
        assistedAssessment.recommendation ?? "review_before_applying",
      role: assistedAssessment.role ?? "unknown",
      roleExplanation: assistedAssessment.roleExplanation ?? null,
      preferences: assistedAssessment.preferences ?? "unknown",
      preferencesExplanation: assistedAssessment.preferencesExplanation ?? null,
      locationReach: assistedAssessment.locationReach ?? "unknown",
      reasons: assistedAssessment.reasons,
      gaps: assistedAssessment.gaps,
      listingClosed: assistedAssessment.listingClosed ?? false,
      listingClosedEvidence: assistedAssessment.listingClosedEvidence ?? null,
    },
    {
      source: "full",
      judgedAt: new Date().toISOString(),
      contextFingerprint: createFitVerdictFingerprint(
        profile,
        searchPreferences,
      ),
      postingFingerprint: createMatchAssessmentPostingFingerprint(
        createMatchAssessmentPostingInput(posting),
      ),
    },
  );
  const completed = applyFitJudgment(withRequirements, judgment);
  if (previous?.judgment && previous.score !== completed.score) {
    completed.recommendationRationale = `After reading the listing, your fit changed from ${previous.score}% to ${completed.score}%. ${completed.recommendationRationale}`;
  }
  return {
    ...completed,
    ...(assistedAssessment.requirements
      ? { requirementsSource: "model" as const }
      : {}),
  };
}

function preserveJobStatus(
  existingJob: SavedJob | undefined,
): ApplicationStatus {
  if (!existingJob) {
    return "discovered";
  }

  if (
    existingJob.status === "archived" ||
    existingJob.status === "submitted" ||
    existingJob.status === "rejected"
  ) {
    return existingJob.status;
  }

  return existingJob.status;
}

export function mergeDiscoveredJob(
  matchAssessment: MatchAssessment,
  posting: JobPosting,
  existingJob: SavedJob | undefined,
): SavedJob {
  return assembleMergedDiscoveredJob({
    matchAssessment,
    enrichedPosting: enrichDiscoveredPosting(posting, existingJob),
    posting,
    existingJob,
  });
}

// Shared assembly so callers that already enriched the posting (the merge
// pipeline) and the direct helper above stay byte-for-byte identical.
function assembleMergedDiscoveredJob(input: {
  matchAssessment: MatchAssessment;
  enrichedPosting: JobPosting;
  posting: JobPosting;
  existingJob: SavedJob | undefined;
}): SavedJob {
  const { matchAssessment, enrichedPosting, posting, existingJob } = input;

  return SavedJobSchema.parse({
    ...enrichedPosting,
    id: existingJob?.id ?? toSavedJobId(posting),
    // A discovery recrawl refreshes shared listing content, not the plans that
    // already retained that row. Dropping this list on duplicate merge made a
    // job silently leave plan 1 as soon as plan 2 found it.
    campaignIds: [...(existingJob?.campaignIds ?? [])],
    ...(existingJob?.personSupplied ? { personSupplied: true } : {}),
    ...(existingJob?.planAssessments
      ? { planAssessments: existingJob.planAssessments }
      : {}),
    status: preserveJobStatus(existingJob),
    matchAssessment: preserveCompletedAssessment(
      existingJob?.matchAssessment,
      matchAssessment,
    ),
    discoveryFeedback: existingJob?.discoveryFeedback ?? null,
    resumeApplicationMode: existingJob?.resumeApplicationMode ?? null,
    latestMatchAssessmentAudit: existingJob?.latestMatchAssessmentAudit ?? null,
  });
}

function buildVisibleDiscoveryRankById(
  jobs: readonly SavedJob[],
): ReadonlyMap<string, number> {
  return new Map(
    orderVisibleDiscoveryJobs(jobs).map((job, index) => [job.id, index + 1]),
  );
}

function selectLatestDiscoveryTimestamp(
  postings: readonly JobPosting[],
): string | null {
  return postings.reduce<string | null>((latest, posting) => {
    const candidate = posting.lastSeenAt ?? posting.discoveredAt;
    if (!latest) {
      return candidate;
    }

    return Date.parse(candidate) > Date.parse(latest) ? candidate : latest;
  }, null);
}

function hasMeaningfulMatchAssessmentChange(
  audit: ReturnType<typeof createMatchAssessmentChangeAudit>,
): boolean {
  return audit.status !== "unchanged" && audit.status !== "metadata_incomplete";
}

// Helper to merge discovered postings with existing jobs
export function mergeDiscoveredPostings(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  savedJobs: readonly SavedJob[],
  discoveredPostings: readonly JobPosting[],
  provenanceBuilder: (posting: JobPosting) => SavedJobDiscoveryProvenance,
  signal?: AbortSignal,
  assessPosting?: (posting: JobPosting) => MatchAssessment,
  auditJobIds?: ReadonlySet<string>,
): MergeDiscoveryResult {
  // Check if already aborted
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const identityIndex = createJobIdentityIndex(
    savedJobs,
    toSightingIdentityInput,
  );
  const previousJobsById = new Map(savedJobs.map((job) => [job.id, job]));
  const previousRankById = buildVisibleDiscoveryRankById(savedJobs);
  const newJobIds = new Set<string>();
  let validatedCount = 0;
  let duplicatesMerged = 0;
  let invalidSkipped = 0;

  const nextJobsById = new Map(savedJobs.map((job) => [job.id, job]));

  for (const posting of discoveredPostings) {
    // Check for cancellation periodically
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const postingUrl = (() => {
      try {
        return new URL(posting.canonicalUrl);
      } catch {
        return null;
      }
    })();

    if (
      !posting.sourceJobId ||
      !postingUrl ||
      isLikelyUtilityShortlistJob(posting) ||
      isLikelyEmptyNonDetailPosting(posting)
    ) {
      invalidSkipped += 1;
      continue;
    }

    validatedCount += 1;
    const existingJob =
      identityIndex.find({ ...posting, matchAcrossSources: true }) ?? undefined;

    // Enrich before assessing so the stored assessment fingerprint describes
    // exactly the content this merge persists. Enrichment derives fields the
    // fingerprint covers (keyword signals, screening hints, ATS provider);
    // assessing the raw posting instead stamps a fingerprint that can never
    // match the persisted job, forcing a full re-score of every staged job on
    // the next discovery run.
    // The job's listing and application link come from one sighting chosen
    // by a rule that ignores merge order (ADR 0030), not from whichever
    // source reported last. Settle it before assessing, for the same reason.
    const builtProvenance = provenanceBuilder(posting);
    const provenance: SavedJobDiscoveryProvenance = {
      ...builtProvenance,
      listingFacts: {
        title: posting.title,
        company: posting.company,
        location: posting.location,
        salaryText: posting.salaryText,
        seniority: posting.seniority,
        description: posting.description,
        summary: posting.summary,
      },
      listingUrl: builtProvenance.listingUrl ?? posting.canonicalUrl,
      applicationUrl:
        builtProvenance.applicationUrl ?? posting.applicationUrl ?? null,
      sourceJobId: builtProvenance.sourceJobId ?? posting.sourceJobId,
      applyPath: builtProvenance.applyPath ?? posting.applyPath,
    };
    const mergedProvenance = uniqueProvenance([
      ...(existingJob
        ? attributeLegacySighting(existingJob.provenance, existingJob)
        : []),
      provenance,
    ]);
    const enrichedPosting = existingJob
      ? settleCanonicalRoute(
          enrichDiscoveredPosting(posting, existingJob),
          existingJob,
          mergedProvenance,
          posting,
        )
      : enrichDiscoveredPosting(posting, existingJob);
    const matchAssessment = assessPosting
      ? assessPosting(enrichedPosting)
      : createMatchAssessment(profile, searchPreferences, enrichedPosting);
    let mergedJob = SavedJobSchema.parse({
      ...assembleMergedDiscoveredJob({
        matchAssessment,
        enrichedPosting,
        posting,
        existingJob,
      }),
      provenance: mergedProvenance,
    });

    if (!existingJob && nextJobsById.has(mergedJob.id)) {
      const baseId = `${mergedJob.id}_${createJobIdentityDigest(posting)}`;
      let availableId = baseId;
      let collisionIndex = 2;
      while (nextJobsById.has(availableId)) {
        availableId = `${baseId}_${collisionIndex}`;
        collisionIndex += 1;
      }
      mergedJob = SavedJobSchema.parse({ ...mergedJob, id: availableId });
    }

    if (existingJob) {
      duplicatesMerged += 1;
      identityIndex.replace(existingJob, mergedJob);
    } else {
      newJobIds.add(mergedJob.id);
      identityIndex.add(mergedJob);
    }

    nextJobsById.set(mergedJob.id, mergedJob);
  }

  const jobsBeforeAudit = [...nextJobsById.values()];
  const currentRankById = buildVisibleDiscoveryRankById(jobsBeforeAudit);
  const auditRecordedAt = selectLatestDiscoveryTimestamp(discoveredPostings);
  const mergedJobs = jobsBeforeAudit.map((job) => {
    const previousJob = previousJobsById.get(job.id);
    if (!previousJob || (auditJobIds && !auditJobIds.has(job.id))) {
      return job;
    }

    const audit = createMatchAssessmentChangeAudit({
      previous: previousJob.matchAssessment,
      current: job.matchAssessment,
      previousRank: previousRankById.get(job.id) ?? null,
      currentRank: currentRankById.get(job.id) ?? null,
      recordedAt: auditRecordedAt,
    });

    return SavedJobSchema.parse({
      ...job,
      latestMatchAssessmentAudit: hasMeaningfulMatchAssessmentChange(audit)
        ? audit
        : previousJob.latestMatchAssessmentAudit,
    });
  });

  return {
    mergedJobs,
    newJobs: mergedJobs.filter((job) => newJobIds.has(job.id)),
    validatedCount,
    duplicatesMerged,
    invalidSkipped,
  };
}

function uniqueProvenance(
  values: readonly SavedJobDiscoveryProvenance[],
): SavedJobDiscoveryProvenance[] {
  const kept = new Map<string, SavedJobDiscoveryProvenance>();

  for (const value of values) {
    const parsed = SavedJobDiscoveryProvenanceSchema.parse(value);
    const key = `${parsed.targetId}:${parsed.adapterKind}:${parsed.resolvedAdapterKind ?? "none"}:${parsed.startingUrl}`;
    const first = kept.get(key);
    if (!first) {
      kept.set(key, parsed);
      continue;
    }
    const route =
      parsed.listingUrl === first.listingUrl &&
      parsed.routeReadAt &&
      (!first.routeReadAt ||
        Date.parse(parsed.routeReadAt) > Date.parse(first.routeReadAt))
        ? parsed
        : first;
    // The first sighting per source keeps its discovery time; a later one only
    // fills in what the first did not record (older provenance had no links).
    kept.set(key, {
      ...first,
      listingFacts:
        parsed.listingUrl === first.listingUrl
          ? (parsed.listingFacts ?? first.listingFacts)
          : first.listingFacts,
      listingUrl: first.listingUrl ?? parsed.listingUrl ?? null,
      applicationUrl: route.routeReadAt
        ? (route.pageApplyUrl ?? null)
        : first.listingUrl
          ? (first.applicationUrl ?? null)
          : (parsed.applicationUrl ?? null),
      sourceJobId: first.sourceJobId ?? parsed.sourceJobId ?? null,
      applyPath: first.applyPath ?? parsed.applyPath ?? null,
      pageApplyUrl: route.routeReadAt
        ? (route.pageApplyUrl ?? null)
        : (first.pageApplyUrl ?? parsed.pageApplyUrl ?? null),
      routeReadAt: route.routeReadAt ?? null,
    });
  }

  return [...kept.values()];
}

/**
 * A saved job's identity for matching new sightings: its own fields plus the
 * listing links its other sources showed.
 */
export function toSightingIdentityInput(job: SavedJob): SavedJob & {
  alternateListingUrls: string[];
  matchAcrossSources: true;
} {
  return {
    ...job,
    matchAcrossSources: true,
    alternateListingUrls: job.provenance.flatMap((entry) =>
      entry.listingUrl && entry.listingUrl !== job.canonicalUrl
        ? [entry.listingUrl]
        : [],
    ),
  };
}

const SIGHTING_ROUTE_FIELDS = [
  "canonicalUrl",
  "applicationUrl",
  "applyPath",
  "easyApplyEligible",
  "source",
  "sourceJobId",
  "discoveryMethod",
  "collectionMethod",
  "providerKey",
  "providerBoardToken",
  "providerIdentifier",
  "atsProvider",
] as const satisfies readonly (keyof JobPosting)[];

function copySightingRouteFields<T extends JobPosting>(
  target: T,
  from: JobPosting,
): T {
  const next = { ...target } as Record<string, unknown>;
  for (const field of SIGHTING_ROUTE_FIELDS) {
    next[field] = from[field];
  }
  return next as T;
}

/**
 * Point a job at one of its own sightings: listing, application link, apply
 * path and identity fields all come from that sighting, never half from
 * another. Its stored display facts move with the route.
 */
export function applySightingRoute<T extends JobPosting>(
  job: T,
  sighting: SavedJobDiscoveryProvenance,
): T {
  if (
    !sighting.listingUrl ||
    (!sighting.listingFacts && sighting.listingUrl !== job.canonicalUrl)
  )
    return job;
  const applyPath = sighting.applyPath ?? job.applyPath;
  const sameProvider =
    (sighting.providerKey ?? null) === (job.providerKey ?? null);
  const routed = {
    ...job,
    ...(sighting.listingFacts ?? {}),
    ...(sighting.listingFacts
      ? {
          normalizedCompensation: parseNormalizedCompensation(
            sighting.listingFacts.salaryText,
          ),
        }
      : {}),
    canonicalUrl: sighting.listingUrl,
    applicationUrl: sighting.routeReadAt
      ? (sighting.pageApplyUrl ?? null)
      : (sighting.applicationUrl ?? null),
    applyPath,
    easyApplyEligible: applyPath === "easy_apply",
    sourceJobId: sighting.sourceJobId ?? job.sourceJobId,
    collectionMethod: sighting.collectionMethod,
    providerKey: sighting.providerKey ?? null,
    providerBoardToken: sighting.providerBoardToken ?? null,
    providerIdentifier: sameProvider ? job.providerIdentifier : null,
  } as T;
  return { ...routed, atsProvider: detectAtsProvider(routed) } as T;
}

function settleCanonicalRoute(
  enrichedPosting: JobPosting,
  existingJob: SavedJob,
  provenance: readonly SavedJobDiscoveryProvenance[],
  posting: JobPosting,
): JobPosting {
  // Work has started on this job: its listing and link stay where they are.
  if (!canSwitchCanonicalSighting(existingJob)) {
    return copySightingRouteFields(
      {
        ...enrichedPosting,
        title: existingJob.title,
        company: existingJob.company,
        location: existingJob.location,
        description: existingJob.description,
        summary: existingJob.summary,
        salaryText: existingJob.salaryText,
        normalizedCompensation: existingJob.normalizedCompensation,
        seniority: existingJob.seniority,
      },
      existingJob,
    );
  }
  const winner = selectCanonicalSighting(provenance);
  if (!winner || winner.listingUrl === existingJob.canonicalUrl) {
    if (posting.canonicalUrl === existingJob.canonicalUrl)
      return winner?.routeReadAt
        ? applySightingRoute(enrichedPosting, winner)
        : enrichedPosting;
    return copySightingRouteFields(
      {
        ...enrichedPosting,
        title: existingJob.title,
        company: existingJob.company,
        location: existingJob.location,
        description: existingJob.description,
        summary: existingJob.summary,
        salaryText: existingJob.salaryText,
        normalizedCompensation: existingJob.normalizedCompensation,
        seniority: existingJob.seniority,
      },
      existingJob,
    );
  }
  if (winner.listingUrl === enrichedPosting.canonicalUrl) {
    return {
      ...enrichedPosting,
      title: posting.title,
      company: enrichedPosting.company,
      applicationUrl: winner.routeReadAt
        ? (winner.pageApplyUrl ?? null)
        : (posting.applicationUrl ?? null),
      location: posting.location,
      seniority: posting.seniority,
      salaryText: posting.salaryText,
      description: posting.description,
      summary: posting.summary,
      normalizedCompensation: parseNormalizedCompensation(posting.salaryText),
    };
  }
  return applySightingRoute(enrichedPosting, winner);
}
