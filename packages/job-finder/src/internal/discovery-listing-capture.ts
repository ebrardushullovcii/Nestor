import {
  deriveListingDetailCapture,
  type ListingDetailCaptureState,
  type SavedJob,
} from "@nestor/contracts";

/**
 * Run-level accounting for "did this search read the listings it kept?".
 *
 * A search used to finish on the strength of a list of titles, and the only
 * trace of the listings it never opened was a per-job silence: the row said
 * "title match only" and nothing said how many rows were in that state or
 * why. Capture is a stage of the run, so the run has to be able to state its
 * own result. These counts are what the finished run reports and what the
 * result screen reads back, so neither can invent a different total.
 */
export interface DiscoveryListingCaptureCounts {
  blocked: number;
  captured: number;
  notAttempted: number;
  total: number;
}

/**
 * The capture state of a stored job, tolerant of rows written before the
 * field existed: those are re-derived from what they do carry rather than
 * defaulting to "nothing was read".
 */
export function getSavedJobListingCaptureState(
  job: Pick<
    SavedJob,
    | "description"
    | "detailQuality"
    | "listingDetailCapture"
    | "listingDetailFetch"
  >,
): ListingDetailCaptureState {
  const stored = job.listingDetailCapture?.state;
  if (stored === "captured" || stored === "blocked") {
    return stored;
  }
  return deriveListingDetailCapture({
    description: job.description,
    detailQuality: job.detailQuality,
    listingDetailFetch: job.listingDetailFetch ?? null,
  }).state;
}

export function countDiscoveryListingCapture(
  jobs: readonly Parameters<typeof getSavedJobListingCaptureState>[0][],
): DiscoveryListingCaptureCounts {
  const counts: DiscoveryListingCaptureCounts = {
    blocked: 0,
    captured: 0,
    notAttempted: 0,
    total: jobs.length,
  };
  for (const job of jobs) {
    switch (getSavedJobListingCaptureState(job)) {
      case "captured":
        counts.captured += 1;
        break;
      case "blocked":
        // A rate limit is a "come back later", and the next search does:
        // it is still to read, not a page that gave nothing.
        if (job.listingDetailFetch?.retryAfterAt) {
          counts.notAttempted += 1;
        } else {
          counts.blocked += 1;
        }
        break;
      default:
        counts.notAttempted += 1;
        break;
    }
  }
  return counts;
}

/**
 * One plain sentence stating how the run left every job it kept. It never
 * claims a job was read when it was not, and it never leaves an unread job
 * unmentioned: the two failure shapes a person can act on differently — the
 * page refused, and the search ran out of room — are named separately.
 */
export function describeDiscoveryListingCapture(
  counts: DiscoveryListingCaptureCounts,
): string {
  if (counts.total === 0) {
    return "No jobs were kept, so there was nothing to read.";
  }
  const parts: string[] = [
    `Read the full listing for ${counts.captured} of ${counts.total} kept ${
      counts.total === 1 ? "job" : "jobs"
    }`,
  ];
  if (counts.blocked > 0) {
    parts.push(
      `${counts.blocked} ${
        counts.blocked === 1 ? "listing page gave" : "listing pages gave"
      } nothing to read`,
    );
  }
  if (counts.notAttempted > 0) {
    parts.push(
      `${counts.notAttempted} ${
        counts.notAttempted === 1 ? "is" : "are"
      } still to read on the next search`,
    );
  }
  return `${parts.join("; ")}.`;
}
