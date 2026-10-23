import {
  DiscoveryLedgerEntrySchema,
  type DiscoveryLedgerEntry,
  type DiscoveryListingFingerprints,
  type DiscoveryTitleTriageOutcome,
  type JobDiscoveryCollectionMethod,
  type JobPosting,
  type SavedJob,
  type SavedJobDiscoveryProvenance,
} from "@nestor/contracts";
import { createUniqueId } from "./shared";
import { fnv1a64, yieldToEventLoop } from "@nestor/core";
import { patchDiscoveryLedger, readDiscoveryLedgerChanges } from "@nestor/db";
import {
  createJobIdentityIndex,
  normalizeJobIdentityUrl,
  type JobIdentityInput,
} from "./job-identity";

const normalizeLedgerUrl = normalizeJobIdentityUrl;

type DiscoveryFingerprintPosting = Pick<
  JobPosting,
  | "applicationUrl"
  | "title"
  | "company"
  | "location"
  | "workMode"
  | "applyPath"
  | "easyApplyEligible"
  | "postedAt"
  | "postedAtText"
  | "providerUpdatedAt"
  | "salaryText"
  | "employmentType"
  | "department"
  | "team"
  | "detailQuality"
  | "summary"
  | "description"
  | "keySkills"
  | "responsibilities"
  | "minimumQualifications"
  | "preferredQualifications"
  | "seniority"
  | "screeningHints"
  | "benefits"
>;

function selectLatestProviderUpdatedAt(
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

export function createDiscoveryListingFingerprints(
  posting: DiscoveryFingerprintPosting,
): DiscoveryListingFingerprints {
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

  return {
    version: 1,
    card,
    detail,
    material: createVersionOneFingerprint({ card, detail }),
  };
}

export type DiscoveryFreshnessClassification =
  | "new"
  | "unchanged"
  | "changed"
  | "reactivated";

export type DiscoveryFreshnessDigest = {
  total: number;
  counts: Record<DiscoveryFreshnessClassification, number>;
  digest: string;
};

type DiscoveryLedgerIdentity = JobIdentityInput & {
  canonicalUrl: string;
  source: string;
  sourceJobId: string | null;
  providerKey: string | null;
  providerBoardToken: string | null;
  providerIdentifier: string | null;
};

export type DiscoveryLedgerIndex = {
  find(posting: DiscoveryLedgerIdentity): DiscoveryLedgerEntry | null;
  add(entry: DiscoveryLedgerEntry): void;
  remove(entry: DiscoveryLedgerEntry): void;
  replace(previous: DiscoveryLedgerEntry, next: DiscoveryLedgerEntry): void;
};

export function createDiscoveryLedgerIndex(
  ledger: readonly DiscoveryLedgerEntry[],
): DiscoveryLedgerIndex {
  const identityIndex = createJobIdentityIndex(ledger, (entry) => entry);

  return {
    find(posting) {
      return identityIndex.find(posting);
    },
    add(entry) {
      identityIndex.add(entry);
    },
    remove(entry) {
      identityIndex.remove(entry);
    },
    replace(previous, next) {
      identityIndex.replace(previous, next);
    },
  };
}
export function classifyDiscoveryPostingFreshness(input: {
  ledgerEntry: DiscoveryLedgerEntry | null;
  posting: DiscoveryFingerprintPosting;
}): {
  classification: DiscoveryFreshnessClassification;
  incomingFingerprints: DiscoveryListingFingerprints;
} {
  const incomingFingerprints = createDiscoveryListingFingerprints(
    input.posting,
  );
  if (!input.ledgerEntry) {
    return { classification: "new", incomingFingerprints };
  }
  if (input.ledgerEntry.latestStatus === "inactive") {
    return { classification: "reactivated", incomingFingerprints };
  }
  if (!input.ledgerEntry.fingerprints) {
    return { classification: "changed", incomingFingerprints };
  }

  const unchanged =
    input.posting.detailQuality === "card_only"
      ? input.ledgerEntry.fingerprints.card === incomingFingerprints.card
      : input.ledgerEntry.fingerprints.material ===
        incomingFingerprints.material;
  return {
    classification: unchanged ? "unchanged" : "changed",
    incomingFingerprints,
  };
}
type FreshnessDigestInput = {
  ledger: readonly DiscoveryLedgerEntry[];
  postings: readonly (DiscoveryFingerprintPosting & DiscoveryLedgerIdentity)[];
  /** An index already built over exactly `ledger`, to skip building one. */
  index?: Pick<DiscoveryLedgerIndex, "find">;
};

function startFreshnessDigest(input: FreshnessDigestInput) {
  const ledgerIndex =
    input.index ??
    (input.postings.length > 0
      ? createDiscoveryLedgerIndex(input.ledger)
      : { find: () => null });
  const counts: Record<DiscoveryFreshnessClassification, number> = {
    new: 0,
    unchanged: 0,
    changed: 0,
    reactivated: 0,
  };
  const classify = (
    posting: DiscoveryFingerprintPosting & DiscoveryLedgerIdentity,
  ) => {
    const existingEntry = ledgerIndex.find(posting);
    const { classification, incomingFingerprints } =
      classifyDiscoveryPostingFreshness({
        ledgerEntry: existingEntry,
        posting,
      });

    counts[classification] += 1;
    return {
      classification,
      identity: normalizeLedgerUrl(posting.canonicalUrl),
      fingerprint:
        posting.detailQuality === "card_only"
          ? incomingFingerprints.card
          : incomingFingerprints.material,
    };
  };
  return { counts, classify };
}

export function createDiscoveryFreshnessDigest(
  input: FreshnessDigestInput,
): DiscoveryFreshnessDigest {
  const { counts, classify } = startFreshnessDigest(input);
  return finishFreshnessDigest(
    input.postings.length,
    counts,
    input.postings.map(classify),
  );
}

/** The same digest, giving the event loop a turn every `perTurn` postings. */
export async function createDiscoveryFreshnessDigestInTurns(
  input: FreshnessDigestInput & { perTurn: number },
): Promise<DiscoveryFreshnessDigest> {
  const { counts, classify } = startFreshnessDigest(input);
  const classified: ReturnType<typeof classify>[] = [];
  for (const [position, posting] of input.postings.entries()) {
    if (position % input.perTurn === 0) await yieldToEventLoop();
    classified.push(classify(posting));
  }
  return finishFreshnessDigest(input.postings.length, counts, classified);
}

function finishFreshnessDigest(
  total: number,
  counts: Record<DiscoveryFreshnessClassification, number>,
  classifiedPostings: Array<{
    classification: DiscoveryFreshnessClassification;
    identity: string;
    fingerprint: string;
  }>,
): DiscoveryFreshnessDigest {
  classifiedPostings.sort((left, right) => {
    const leftKey = `${left.identity}\u0000${left.classification}\u0000${left.fingerprint}`;
    const rightKey = `${right.identity}\u0000${right.classification}\u0000${right.fingerprint}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  return {
    total,
    counts,
    digest: createVersionOneFingerprint({
      counts,
      postings: classifiedPostings,
    }),
  };
}

export function formatDiscoveryFreshnessDigest(
  freshness: DiscoveryFreshnessDigest,
): string {
  return `Freshness: ${freshness.counts.new} new, ${freshness.counts.unchanged} unchanged, ${freshness.counts.changed} changed, ${freshness.counts.reactivated} reactivated. Digest ${freshness.digest}.`;
}

const frozenLedgerIndexes = new WeakMap<
  readonly DiscoveryLedgerEntry[],
  DiscoveryLedgerIndex
>();
let lastIndexedLedger: {
  ledger: readonly DiscoveryLedgerEntry[];
  index: DiscoveryLedgerIndex;
} | null = null;
/** More changed entries than this rebuild the index instead. */
const MAX_CARRIED_LEDGER_CHANGES = 64;

/** Build the feedback lookup between turns, before the first Hide needs it. */
export async function warmDiscoveryLedgerIndex(
  ledger: readonly DiscoveryLedgerEntry[],
): Promise<void> {
  if (!Object.isFrozen(ledger) || frozenLedgerIndexes.has(ledger)) return;
  const carried = carryLedgerIndex(ledger);
  if (carried) {
    frozenLedgerIndexes.set(ledger, carried);
    lastIndexedLedger = { ledger, index: carried };
    return;
  }
  const index = createDiscoveryLedgerIndex([]);
  for (let start = 0; start < ledger.length; start += 100) {
    for (const entry of ledger.slice(start, start + 100)) index.add(entry);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  frozenLedgerIndexes.set(ledger, index);
  lastIndexedLedger = { ledger, index };
}

/**
 * The last ledger's index, moved to `ledger` when the two share all but a
 * few entries. Storage keeps every unchanged entry as the same frozen value,
 * so hiding one job leaves 6,999 of 7,000 entries in place; re-indexing them
 * all cost each hide about 100 ms. The earlier ledger gives up its index and
 * builds a fresh one if it is ever looked up again.
 */
function carryLedgerIndex(
  ledger: readonly DiscoveryLedgerEntry[],
): DiscoveryLedgerIndex | null {
  const last = lastIndexedLedger;
  if (!last) return null;
  const changes = readDiscoveryLedgerChanges(last.ledger, ledger);
  if (changes) {
    frozenLedgerIndexes.delete(last.ledger);
    for (const entry of changes.removed) last.index.remove(entry);
    for (const entry of changes.added) last.index.add(entry);
    return last.index;
  }
  if (Math.abs(last.ledger.length - ledger.length) > MAX_CARRIED_LEDGER_CHANGES) return null;
  const current = new Set(ledger);
  const previous = new Set(last.ledger);
  if (current.size !== ledger.length || previous.size !== last.ledger.length)
    return null;
  const removed = last.ledger.filter((entry) => !current.has(entry));
  const added = ledger.filter((entry) => !previous.has(entry));
  if (removed.length + added.length > MAX_CARRIED_LEDGER_CHANGES) return null;
  frozenLedgerIndexes.delete(last.ledger);
  for (const entry of removed) last.index.remove(entry);
  for (const entry of added) last.index.add(entry);
  return last.index;
}

export function findDiscoveryLedgerEntry(
  ledger: readonly DiscoveryLedgerEntry[],
  posting: DiscoveryLedgerIdentity,
): DiscoveryLedgerEntry | null {
  // A stored ledger is frozen, so one index serves every lookup into it.
  // Building it per lookup cost about 150 ms on 7,000 entries, twice for
  // each job the person hid or shortlisted.
  if (!Object.isFrozen(ledger)) {
    return createDiscoveryLedgerIndex(ledger).find(posting);
  }
  let index = frozenLedgerIndexes.get(ledger);
  if (!index) {
    index = carryLedgerIndex(ledger) ?? createDiscoveryLedgerIndex(ledger);
    frozenLedgerIndexes.set(ledger, index);
    lastIndexedLedger = { ledger, index };
  }
  return index.find(posting);
}

function upsertLedgerEntry(
  ledger: readonly DiscoveryLedgerEntry[],
  existingEntry: DiscoveryLedgerEntry | null,
  nextEntry: DiscoveryLedgerEntry,
): DiscoveryLedgerEntry[] {
  if (Object.isFrozen(ledger))
    return patchDiscoveryLedger(ledger, [
      {
        id: nextEntry.id,
        moveToEnd: true,
        update: () => nextEntry,
      },
    ]);
  const nextLedger = existingEntry
    ? ledger.filter((entry) => entry !== existingEntry)
    : [...ledger];

  return [...nextLedger, nextEntry];
}

export type DiscoveryLedgerSighting = {
  posting: DiscoveryFingerprintPosting &
    Pick<
      JobPosting,
      | "canonicalUrl"
      | "source"
      | "sourceJobId"
      | "providerKey"
      | "providerBoardToken"
      | "providerIdentifier"
      | "collectionMethod"
      | "titleTriageOutcome"
    >;
  targetId: string;
  seenAt: string;
  status: DiscoveryLedgerEntry["latestStatus"];
  skipReason?: string | null;
  /** The feed screen's verdict for this sighting; absent keeps the last one. */
  listingScreen?: DiscoveryLedgerEntry["listingScreen"];
};

export function recordDiscoveredPostingInLedger(
  input: DiscoveryLedgerSighting & {
    ledger: readonly DiscoveryLedgerEntry[];
    index?: DiscoveryLedgerIndex;
  },
): DiscoveryLedgerEntry[] {
  const existingEntry = input.index
    ? input.index.find(input.posting)
    : findDiscoveryLedgerEntry(input.ledger, input.posting);
  const nextEntry = buildDiscoveryLedgerEntry(input, existingEntry);

  if (input.index) {
    if (existingEntry) {
      input.index.replace(existingEntry, nextEntry);
    } else {
      input.index.add(nextEntry);
    }
  }

  return upsertLedgerEntry(input.ledger, existingEntry, nextEntry);
}

/** The entry one sighting leaves in the ledger, given the entry it had. */
export function buildDiscoveryLedgerEntry(
  input: DiscoveryLedgerSighting,
  existingEntry: DiscoveryLedgerEntry | null,
): DiscoveryLedgerEntry {
  const incomingFingerprints = createDiscoveryListingFingerprints(
    input.posting,
  );
  const preservesEnrichedDetail =
    existingEntry?.detailQuality === "detail_enriched" &&
    input.posting.detailQuality !== "detail_enriched" &&
    existingEntry.fingerprints?.version === incomingFingerprints.version &&
    existingEntry.fingerprints.card === incomingFingerprints.card;
  const detailQuality = preservesEnrichedDetail
    ? "detail_enriched"
    : input.posting.detailQuality;
  const unchangedEnrichedMaterial =
    existingEntry?.fingerprints?.version === incomingFingerprints.version &&
    existingEntry.fingerprints.material === incomingFingerprints.material;
  const refreshedEnrichedAt =
    input.status === "seen"
      ? preservesEnrichedDetail
        ? (existingEntry?.lastEnrichedAt ?? null)
        : null
      : input.status !== "enriched"
        ? (existingEntry?.lastEnrichedAt ?? null)
        : input.posting.detailQuality === "detail_enriched"
          ? unchangedEnrichedMaterial
            ? (existingEntry?.lastEnrichedAt ?? input.seenAt)
            : input.seenAt
          : preservesEnrichedDetail
            ? (existingEntry?.lastEnrichedAt ?? null)
            : null;
  const fingerprints =
    preservesEnrichedDetail || unchangedEnrichedMaterial
      ? (existingEntry?.fingerprints ?? incomingFingerprints)
      : incomingFingerprints;

  return DiscoveryLedgerEntrySchema.parse({
    id: existingEntry?.id ?? createUniqueId("discovery_ledger"),
    canonicalUrl: normalizeLedgerUrl(input.posting.canonicalUrl),
    applicationUrl:
      input.posting.applicationUrl ?? existingEntry?.applicationUrl ?? null,
    source: input.posting.source,
    sourceJobId: input.posting.sourceJobId,
    providerKey: input.posting.providerKey,
    providerBoardToken: input.posting.providerBoardToken,
    providerIdentifier: input.posting.providerIdentifier,
    providerUpdatedAt: selectLatestProviderUpdatedAt(
      input.posting.providerUpdatedAt,
      existingEntry?.providerUpdatedAt,
    ),
    title: input.posting.title,
    company: input.posting.company,
    location: input.posting.location,
    postedAt: input.posting.postedAt ?? existingEntry?.postedAt ?? null,
    postedAtText:
      input.posting.postedAtText ?? existingEntry?.postedAtText ?? null,
    targetId: input.targetId,
    collectionMethod: input.posting.collectionMethod,
    detailQuality,
    fingerprints,
    firstSeenAt: existingEntry?.firstSeenAt ?? input.seenAt,
    lastSeenAt: input.seenAt,
    lastAppliedAt:
      input.status === "applied"
        ? input.seenAt
        : (existingEntry?.lastAppliedAt ?? null),
    lastEnrichedAt: refreshedEnrichedAt,
    inactiveAt: input.status === "inactive" ? input.seenAt : null,
    latestStatus: input.status,
    titleTriageOutcome: input.posting.titleTriageOutcome,
    skipReason:
      input.status === "seen" ||
      input.status === "enriched" ||
      input.status === "applied"
        ? null
        : (input.skipReason ?? existingEntry?.skipReason ?? null),
    listingScreen:
      input.listingScreen !== undefined
        ? input.listingScreen
        : (existingEntry?.listingScreen ?? null),
  });
}

export function markSavedJobStatusInLedger(input: {
  ledger: readonly DiscoveryLedgerEntry[];
  job: SavedJob;
  activeTargetId?: string;
  status: DiscoveryLedgerEntry["latestStatus"];
  occurredAt: string;
  skipReason: string | null;
}): DiscoveryLedgerEntry[] {
  const existingEntry = findDiscoveryLedgerEntry(input.ledger, input.job);
  // Prefer the most recent saved-job provenance, then older provenance and existing
  // ledger context, so status updates still attach to the same target after imports,
  // merges, or legacy records that may not carry a fresh active target id.
  const targetId =
    input.job.provenance[input.job.provenance.length - 1]?.targetId ??
    input.job.provenance[0]?.targetId ??
    existingEntry?.targetId ??
    input.activeTargetId ??
    null;

  if (!targetId) {
    return [...input.ledger];
  }

  return recordDiscoveredPostingInLedger({
    ledger: input.ledger,
    posting: {
      ...input.job,
      canonicalUrl: input.job.canonicalUrl,
      source: input.job.source,
      sourceJobId: input.job.sourceJobId,
      providerKey: input.job.providerKey,
      providerBoardToken: input.job.providerBoardToken,
      providerIdentifier: input.job.providerIdentifier,
      title: input.job.title,
      company: input.job.company,
      collectionMethod:
        input.job.provenance[input.job.provenance.length - 1]
          ?.collectionMethod ??
        existingEntry?.collectionMethod ??
        input.job.collectionMethod,
      detailQuality: input.job.detailQuality,
      titleTriageOutcome: input.job.titleTriageOutcome,
    },
    targetId,
    seenAt: input.occurredAt,
    status: input.status,
    skipReason: input.skipReason,
  });
}

export function shouldSkipPostingFromLedger(input: {
  ledgerEntry: DiscoveryLedgerEntry | null;
  posting: DiscoveryFingerprintPosting;
  triageOutcome: DiscoveryTitleTriageOutcome;
  /**
   * True when this identity is already persisted as a kept saved or staged
   * job. Retained identities can never become new distinct results, so an
   * unchanged re-observation is skipped instead of competing for budget;
   * changed content still reaches the merge as a detail upgrade.
   */
  hasRetainedJob?: boolean;
}): {
  skip: boolean;
  reason: string | null;
  outcome: DiscoveryTitleTriageOutcome;
} {
  if (!input.ledgerEntry) {
    return {
      skip: false,
      reason: null,
      outcome: input.triageOutcome,
    };
  }

  if (input.ledgerEntry.latestStatus === "applied") {
    return {
      skip: true,
      reason: `Already applied to ${input.posting.title} at ${input.posting.company}.`,
      outcome: "skip_handled",
    };
  }

  if (input.ledgerEntry.latestStatus === "skipped") {
    return {
      skip: true,
      reason:
        input.ledgerEntry.skipReason ?? "Previously skipped intentionally.",
      outcome: "skip_handled",
    };
  }

  if (input.hasRetainedJob && input.ledgerEntry.latestStatus !== "inactive") {
    const classification = classifyDiscoveryPostingFreshness({
      ledgerEntry: input.ledgerEntry,
      posting: input.posting,
    }).classification;
    if (classification === "unchanged") {
      return {
        skip: true,
        reason: "Already retained from an earlier unchanged run.",
        outcome: "skip_existing",
      };
    }
  }

  if (
    input.ledgerEntry.latestStatus === "enriched" &&
    input.ledgerEntry.detailQuality === "detail_enriched"
  ) {
    const previousFingerprints = input.ledgerEntry.fingerprints;
    if (!previousFingerprints) {
      return {
        skip: false,
        reason: "Legacy discovery history needs one safe refresh.",
        outcome: input.triageOutcome,
      };
    }

    const incomingFingerprints = createDiscoveryListingFingerprints(
      input.posting,
    );
    const unchanged =
      input.posting.detailQuality === "card_only"
        ? previousFingerprints.card === incomingFingerprints.card
        : previousFingerprints.material === incomingFingerprints.material;
    if (unchanged) {
      return {
        skip: true,
        reason: "Already retained from an earlier unchanged run.",
        outcome: "skip_existing",
      };
    }
  }

  return {
    skip: false,
    reason: null,
    outcome: input.triageOutcome,
  };
}

export function applyInactiveLedgerMarks(input: {
  ledger: readonly DiscoveryLedgerEntry[];
  targetId: string;
  seenCanonicalUrls: readonly string[];
  occurredAt: string;
  allowInactiveMarking: boolean;
}): DiscoveryLedgerEntry[] {
  if (!input.allowInactiveMarking) {
    return [...input.ledger];
  }

  const seenSet = new Set(
    input.seenCanonicalUrls.map((value) => normalizeLedgerUrl(value)),
  );

  return input.ledger.map((entry) => {
    if (entry.targetId !== input.targetId) {
      return entry;
    }

    if (seenSet.has(normalizeLedgerUrl(entry.canonicalUrl))) {
      return entry;
    }

    if (entry.latestStatus === "applied" || entry.latestStatus === "skipped") {
      return entry;
    }

    return DiscoveryLedgerEntrySchema.parse({
      ...entry,
      latestStatus: "inactive",
      inactiveAt: input.occurredAt,
    });
  });
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
