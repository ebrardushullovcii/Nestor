import type {
  ApplicationAttempt,
  DiscoveryJobView,
  DiscoveryLedgerEntry,
  ListingActivity,
  ListingSignalRecord,
  SavedJob,
} from "@nestor/contracts";

import { createJobIdentityIndex } from "./job-identity";

type ActivityCandidate = Exclude<ListingActivity, { status: "unknown" }>;
const projectedActivityJobs = new WeakMap<
  SavedJob,
  {
    activityKey: string;
    view: DiscoveryJobView;
  }
>();

/**
 * The listing's own words saying it is over, as the model read them when it
 * judged the job (ADR 0041), or null when it did not say so. An empty string
 * means closed without a quote.
 */
export function findClosedListingPhrase(job: {
  matchAssessment?: SavedJob["matchAssessment"] | null;
}): string | null {
  const judgment = job.matchAssessment?.judgment;
  if (!judgment?.listingClosed) {
    return null;
  }
  return judgment.listingClosedEvidence ?? "";
}

function closedByOwnTextCandidate(
  job: SavedJob,
): ActivityCandidate | undefined {
  const phrase = findClosedListingPhrase(job);
  if (phrase === null) {
    return undefined;
  }

  // Same instant as the "last seen" observation it overrides, so the closure
  // wins the tie instead of losing to the sighting that captured it.
  const observedAt = job.lastSeenAt ?? job.firstSeenAt ?? job.discoveredAt;
  return {
    status: "closed",
    observedAt,
    signalId: `listing-text:${job.id}`,
    provenance: "system",
    explanation: "The listing's own text says it is no longer open.",
    detail: phrase ? `The page says "${phrase}".` : "The page says so.",
    confidence: 1,
  };
}

const activityTiePriority: Record<ActivityCandidate["status"], number> = {
  active: 0,
  inactive: 1,
  stale: 2,
  closed: 3,
};

function newerActivity(
  current: ActivityCandidate | undefined,
  candidate: ActivityCandidate,
): ActivityCandidate {
  if (!current) return candidate;

  const timestampOrder =
    Date.parse(candidate.observedAt) - Date.parse(current.observedAt);
  if (timestampOrder !== 0) {
    return timestampOrder > 0 ? candidate : current;
  }

  return activityTiePriority[candidate.status] >
    activityTiePriority[current.status]
    ? candidate
    : current;
}

function activeCandidate(job: SavedJob): ActivityCandidate | undefined {
  if (
    job.lastVerifiedActiveAt &&
    (!job.lastSeenAt ||
      Date.parse(job.lastVerifiedActiveAt) >= Date.parse(job.lastSeenAt))
  ) {
    return {
      status: "active",
      observedAt: job.lastVerifiedActiveAt,
      evidence: "last_verified_active_at",
    };
  }
  return job.lastSeenAt
    ? {
        status: "active",
        observedAt: job.lastSeenAt,
        evidence: "last_seen_at",
      }
    : undefined;
}

/**
 * Projects non-persisted listing activity in linear indexed passes. Ledger
 * aliases must resolve to exactly one job; possible, ambiguous, and conflicting
 * identities cannot change another listing's activity.
 */
export function projectDiscoveryJobViews(input: {
  jobs: readonly SavedJob[];
  discoveryLedger: readonly DiscoveryLedgerEntry[];
  listingSignals: readonly ListingSignalRecord[];
  applicationAttempts?: readonly ApplicationAttempt[];
}): DiscoveryJobView[] {
  const inactiveEntries = input.discoveryLedger.filter(
    (entry) => entry.latestStatus === "inactive" && entry.inactiveAt !== null,
  );
  // Active sightings are projected directly from their jobs. Normalizing every
  // full listing for an identity index only helps when an inactive sighting
  // actually needs resolving; doing it on every progress update was wasteful.
  const jobIdentityIndex =
    inactiveEntries.length > 0
      ? createJobIdentityIndex(input.jobs, (job) => job)
      : null;
  const candidateByJob = new Map<SavedJob, ActivityCandidate>();
  const uniqueJobById = new Map<string, SavedJob | null>();

  for (const job of input.jobs) {
    const active = activeCandidate(job);
    if (active) candidateByJob.set(job, active);
    // A listing that says it is closed is closed, whatever the last sighting
    // claimed. This used to leave such a posting labelled Active and free to
    // rank first.
    const closedByOwnText = closedByOwnTextCandidate(job);
    if (closedByOwnText) {
      candidateByJob.set(
        job,
        newerActivity(candidateByJob.get(job), closedByOwnText),
      );
    }
    uniqueJobById.set(job.id, uniqueJobById.has(job.id) ? null : job);
  }

  for (const entry of inactiveEntries) {
    if (entry.inactiveAt === null) continue;
    const resolution = jobIdentityIndex!.resolve(entry);
    if (resolution.status !== "matched") continue;

    candidateByJob.set(
      resolution.value,
      newerActivity(candidateByJob.get(resolution.value), {
        status: "inactive",
        observedAt: entry.inactiveAt,
        ledgerEntryId: entry.id,
        provenance: "discovery_ledger",
        explanation:
          "A source inventory observation marked this exact listing inactive.",
      }),
    );
  }

  for (const signal of input.listingSignals) {
    if (signal.signal === "suspicious") continue;
    const job = uniqueJobById.get(signal.jobId);
    if (!job) continue;

    candidateByJob.set(
      job,
      newerActivity(candidateByJob.get(job), {
        status: signal.signal,
        observedAt: signal.detectedAt,
        signalId: signal.id,
        provenance: signal.provenance,
        explanation: signal.explanation,
        detail: signal.detail,
        confidence: signal.confidence,
      }),
    );
  }

  for (const attempt of input.applicationAttempts ?? []) {
    if (attempt.blocker?.code !== "application_closed") continue;
    const job = uniqueJobById.get(attempt.jobId);
    if (!job) continue;
    candidateByJob.set(
      job,
      newerActivity(candidateByJob.get(job), {
        status: "closed",
        observedAt: attempt.updatedAt,
        signalId: attempt.id,
        provenance: "browser",
        confidence: 1,
        explanation: attempt.summary,
        detail: attempt.detail,
      }),
    );
  }

  return input.jobs.map((job) => {
    const listingActivity: ListingActivity = candidateByJob.get(job) ?? {
      status: "unknown",
    };
    const activityKey = JSON.stringify(listingActivity);
    const previous = projectedActivityJobs.get(job);
    if (previous?.activityKey === activityKey) return previous.view;
    const view = { ...job, listingActivity };
    // Only immutable repository rows are safe to reuse across display reads.
    if (Object.isFrozen(job)) {
      Object.freeze(listingActivity);
      Object.freeze(view);
      projectedActivityJobs.set(job, { activityKey, view });
    }
    return view;
  });
}
