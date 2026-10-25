import {
  writeDiscoveryPreparation,
  readDiscoveryPreparation,
  readPreparedDiscoveryFingerprints,
  DISCOVERY_FINGERPRINT_FIELDS,
  type DiscoveryListingFingerprints,
  type DiscoveryTitleTriageOutcome,
  type JobDiscoveryCollectionMethod,
  type JobPosting,
  type SavedJob,
  type SavedJobDiscoveryProvenance,
} from "@nestor/contracts";
import { isDeepStrictEqual } from "node:util";
import { fnv1a64, } from "@nestor/core";

type DiscoveryFingerprintPosting = Pick<
  JobPosting,
  Exclude<
    (typeof DISCOVERY_FINGERPRINT_FIELDS)[number],
    "keywordSignals" | "atsProvider"
  >
> &
  Partial<Pick<JobPosting, "keywordSignals" | "atsProvider">>;

function normalizeFingerprintText(value: string | null): string | null {
  return value?.trim().replace(/\s+/gu, " ").toLowerCase() || null;
}

function normalizeFingerprintList(values: readonly string[]): string[] {
  return values
    .map((value) => normalizeFingerprintText(value))
    .filter((value): value is string => value !== null)
    .sort();
}

function createVersionOneFingerprint(value: unknown): string {
  const serialized = JSON.stringify(value);
  return `v1_${fnv1a64(serialized)}`;
}

// Only a foreign frozen input needs a fallback: owned postings carry this slot.
const frozenFingerprints = new WeakMap<
  object,
  { basis: DiscoveryFingerprintPosting; value: DiscoveryListingFingerprints }
>();
const fingerprintFields = DISCOVERY_FINGERPRINT_FIELDS;

function memoFingerprints(
  posting: DiscoveryFingerprintPosting,
  fingerprints: DiscoveryListingFingerprints,
  matchAssessmentPostingFingerprint?: string,
): void {
  const basis = Object.fromEntries(
    fingerprintFields.map((field) => {
      const value = posting[field];
      return [
        field,
        value && typeof value === "object" && !Object.isFrozen(value)
          ? structuredClone(value)
          : value,
      ];
    }),
  ) as DiscoveryFingerprintPosting;
  const prepared = { basis, value: { ...fingerprints } };
  if (
    !writeDiscoveryPreparation(posting, {
      fingerprints: prepared,
      ...(matchAssessmentPostingFingerprint
        ? { matchAssessmentPostingFingerprint }
        : {}),
    })
  )
    frozenFingerprints.set(posting, prepared);
}

/** Only owned worker results are frozen and eligible for this memo. */
export function rememberDiscoveryListingFingerprints(
  posting: JobPosting,
  fingerprints: DiscoveryListingFingerprints,
  matchAssessmentPostingFingerprint?: string,
): void {
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  memoFingerprints(posting, fingerprints, matchAssessmentPostingFingerprint);
  freeze(posting);
}

export function createDiscoveryListingFingerprints(
  posting: DiscoveryFingerprintPosting,
): DiscoveryListingFingerprints {
  const carried = readPreparedDiscoveryFingerprints(posting);
  if (carried) {
    const owner = readDiscoveryPreparation(posting)?.fingerprints?.owner;
    if (owner && owner !== posting)
      memoFingerprints(
        posting,
        carried,
        readDiscoveryPreparation(posting)?.matchAssessmentPostingFingerprint,
      );
    return { ...carried };
  }
  const frozen = frozenFingerprints.get(posting);
  if (
    frozen &&
    fingerprintFields.every((field) =>
      isDeepStrictEqual(frozen.basis[field], posting[field]),
    )
  )
    return { ...frozen.value };
  const card = createVersionOneFingerprint({
    applicationUrl: normalizeFingerprintText(posting.applicationUrl),
    title: normalizeFingerprintText(posting.title),
    company: normalizeFingerprintText(posting.company),
    location: normalizeFingerprintText(posting.location),
    workMode: [...posting.workMode].sort(),
    applyPath: posting.applyPath,
    easyApplyEligible: posting.easyApplyEligible,
    postedAt: posting.postedAt,
    postedAtText: normalizeFingerprintText(posting.postedAtText),
    providerUpdatedAt: posting.providerUpdatedAt,
    salaryText: normalizeFingerprintText(posting.salaryText),
    employmentType: normalizeFingerprintText(posting.employmentType),
    department: normalizeFingerprintText(posting.department),
    team: normalizeFingerprintText(posting.team),
  });
  const hasDetailEvidence =
    posting.detailQuality !== "card_only" ||
    posting.responsibilities.length > 0 ||
    posting.minimumQualifications.length > 0 ||
    posting.preferredQualifications.length > 0;
  const detail = hasDetailEvidence
    ? createVersionOneFingerprint({
        summary: normalizeFingerprintText(posting.summary),
        description: normalizeFingerprintText(posting.description),
        keySkills: normalizeFingerprintList(posting.keySkills),
        responsibilities: normalizeFingerprintList(posting.responsibilities),
        minimumQualifications: normalizeFingerprintList(
          posting.minimumQualifications,
        ),
        preferredQualifications: normalizeFingerprintList(
          posting.preferredQualifications,
        ),
        seniority: normalizeFingerprintText(posting.seniority),
        screeningHints: posting.screeningHints,
        benefits: normalizeFingerprintList(posting.benefits),
      })
    : null;

  const fingerprints = {
    version: 1 as const,
    card,
    detail,
    material: createVersionOneFingerprint({ card, detail }),
  };
  memoFingerprints(posting, fingerprints);
  return fingerprints;
}

export function createDiscoveryProvenance(input: {
  targetId: string;
  sourceLabel?: string;
  adapterKind: SavedJob["provenance"][number]["adapterKind"];
  resolvedAdapterKind: SavedJob["provenance"][number]["resolvedAdapterKind"];
  startingUrl: string;
  discoveredAt: string;
  collectionMethod: JobDiscoveryCollectionMethod;
  providerKey: SavedJob["providerKey"];
  providerBoardToken: SavedJob["providerBoardToken"];
  titleTriageOutcome: DiscoveryTitleTriageOutcome;
  /** This source's own listing link and the application link it carried. */
  listingUrl?: string | null;
  applicationUrl?: string | null;
  sourceJobId?: string | null;
  applyPath?: SavedJobDiscoveryProvenance["applyPath"];
}): SavedJobDiscoveryProvenance {
  return {
    listingUrl: input.listingUrl ?? null,
    applicationUrl: input.applicationUrl ?? null,
    sourceJobId: input.sourceJobId ?? null,
    applyPath: input.applyPath ?? null,
    targetId: input.targetId,
    ...(input.sourceLabel ? { sourceLabel: input.sourceLabel } : {}),
    adapterKind: input.adapterKind,
    resolvedAdapterKind: input.resolvedAdapterKind,
    startingUrl: input.startingUrl,
    discoveredAt: input.discoveredAt,
    collectionMethod: input.collectionMethod,
    providerKey: input.providerKey,
    providerBoardToken: input.providerBoardToken,
    titleTriageOutcome: input.titleTriageOutcome,
  };
}
