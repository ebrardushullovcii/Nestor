import type {
  ApplicationAttempt,
  ListingActivity,
  ListingSignalRecord,
  SavedJob,
} from "@nestor/contracts";

import {
  type JobIdentityInput,
} from "./job-identity";
import { copyView } from "@nestor/core";

export type ListingActivityJob = JobIdentityInput &
  Pick<
    SavedJob,
    | "id"
    | "lastSeenAt"
    | "firstSeenAt"
    | "lastVerifiedActiveAt"
    | "discoveredAt"
  > & {
    matchAssessment?:
      | {
          judgment?:
            | Pick<
                NonNullable<SavedJob["matchAssessment"]["judgment"]>,
                "listingClosed" | "listingClosedEvidence"
              >
            | null
            | undefined;
        }
      | undefined;
  };

type ActivityCandidate = Exclude<ListingActivity, { status: "unknown" }>;
const projectedActivityJobs = new WeakMap<
  object,
  {
    activity: ListingActivity;
    activityKey: string;
    view: object;
  }
>();

/**
 * The listing's own words saying it is over, as the model read them when it
 * judged the job (ADR 0041), or null when it did not say so. An empty string
 * means closed without a quote.
 */
export function findClosedListingPhrase(job: {
  matchAssessment?: ListingActivityJob["matchAssessment"] | null;
}): string | null {
  const judgment = job.matchAssessment?.judgment;
  if (!judgment?.listingClosed) {
    return null;
  }
  return judgment.listingClosedEvidence ?? "";
}

function closedByOwnTextCandidate(
  job: ListingActivityJob,
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

/**
 * A frozen saved job never changes, so its own activity facts are computed
 * once; every refresh used to redo them for all the person's jobs.
 */
const ownCandidates = new WeakMap<
  object,
  {
    active: ActivityCandidate | undefined;
    closed: ActivityCandidate | undefined;
  }
>();
function ownActivityCandidates(job: ListingActivityJob) {
  const cached = ownCandidates.get(job);
  if (cached) return cached;
  const candidates = {
    active: activeCandidate(job),
    closed: closedByOwnTextCandidate(job),
  };
  if (Object.isFrozen(job)) ownCandidates.set(job, candidates);
  return candidates;
}

function activeCandidate(
  job: ListingActivityJob,
): ActivityCandidate | undefined {
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

/** Projects non-persisted listing activity in linear indexed passes. */
export function projectDiscoveryJobViews<T extends ListingActivityJob>(input: {
  jobs: readonly T[];
  listingSignals: readonly ListingSignalRecord[];
  applicationAttempts?: readonly ApplicationAttempt[];
}): Array<T & { listingActivity: ListingActivity }> {
  const candidateByJob = new Map<T, ActivityCandidate>();
  const uniqueJobById = new Map<string, T | null>();

  for (const job of input.jobs) {
    const { active, closed: closedByOwnText } = ownActivityCandidates(job);
    if (active) candidateByJob.set(job, active);
    // A listing that says it is closed is closed, whatever the last sighting
    // claimed. This used to leave such a posting labelled Active and free to
    // rank first.
    if (closedByOwnText) {
      candidateByJob.set(
        job,
        newerActivity(candidateByJob.get(job), closedByOwnText),
      );
    }
    uniqueJobById.set(job.id, uniqueJobById.has(job.id) ? null : job);
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
    const candidate = candidateByJob.get(job);
    const previous = projectedActivityJobs.get(job);
    // The same activity object as last time (a job's own sighting, cached
    // with the job) needs no comparison of its contents.
    if (candidate !== undefined && previous?.activity === candidate)
      return previous.view as T & { listingActivity: ListingActivity };
    const listingActivity: ListingActivity = candidate ?? {
      status: "unknown",
    };
    const activityKey = JSON.stringify(listingActivity);
    if (previous?.activityKey === activityKey)
      return previous.view as T & { listingActivity: ListingActivity };
    const view = copyView(job, { listingActivity });
    // Only immutable repository rows are safe to reuse across display reads.
    if (Object.isFrozen(job)) {
      Object.freeze(listingActivity);
      Object.freeze(view);
      projectedActivityJobs.set(job, {
        activity: listingActivity,
        activityKey,
        view,
      });
    }
    return view;
  });
}
