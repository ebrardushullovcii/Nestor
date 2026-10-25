import type {
  ApplicationAttemptState,
  ApplicationStatus,
  ReviewQueueItem,
  TailoredAssetSummary,
} from "@nestor/contracts";

/*
 * Readings of the old workspace's shortlist that Home and the task center
 * still show. They go when those screens read the job store.
 */

/**
 * True when the job's saved resume kept the person's own wording because the
 * listing text was not there when it was written, and the person has not
 * approved it as it is. Nothing was tailored, so the job still needs its
 * resume (ADR 0049); writing it reads the listing again first.
 */
export function needsTailoredResume(
  item: Pick<
    ReviewQueueItem,
    | "assetStatus"
    | "resumeApplicationMode"
    | "resumeReview"
    | "resumeWrittenWithoutListing"
  > | null,
): boolean {
  return Boolean(
    item &&
    item.resumeApplicationMode !== "original_resume" &&
    item.resumeWrittenWithoutListing &&
    item.assetStatus === "ready" &&
    item.resumeReview.status !== "approved",
  );
}

/**
 * Lines in the job's saved resume still waiting for the person's decision.
 * Apply cannot approve such a resume at any level, so the job is not ready.
 */
export function countResumeLinesToDecide(
  item: Pick<ReviewQueueItem, "resumeLinesToDecide" | "resumeReview"> | null,
): number {
  if (!item || item.resumeReview.status === "approved") return 0;
  return item.resumeLinesToDecide ?? 0;
}

/**
 * True when the draft has to be read by the person before it is used: an
 * Aggressive draft that is not yet approved (ADR 0018), or a draft at any
 * level with a line still waiting for their decision. Light and Tailored
 * otherwise keep every fact, so pressing Apply is their approval.
 */
export function needsPersonResumeReview(
  item: ReviewQueueItem | null,
  /**
   * The job's written resume, when the caller has it. A resume written
   * without the listing text kept the person's own wording: nothing was
   * stretched, so there are no flagged lines to read, whatever the level.
   */
  asset?: Pick<
    TailoredAssetSummary,
    "id" | "generationMethod" | "generationReason"
  > | null,
): boolean {
  if (
    item !== null &&
    item.resumeApplicationMode !== "original_resume" &&
    countResumeLinesToDecide(item) > 0
  ) {
    return true;
  }
  if (
    asset &&
    item?.resumeAssetId === asset.id &&
    asset.generationMethod === "deterministic" &&
    (asset.generationReason === "listing_text_missing" ||
      asset.generationReason === "listing_text_not_distinguishing")
  ) {
    return false;
  }
  return (
    item !== null &&
    item.resumeApplicationMode !== "original_resume" &&
    item.resumeTailoringMode === "aggressive" &&
    Boolean(item.resumeAssetId) &&
    item.resumeReview.status !== "approved"
  );
}

export function isResumeGenerationInProgress(
  item: ReviewQueueItem | null,
): boolean {
  return item?.assetStatus === "generating" || item?.assetStatus === "queued";
}

/**
 * Jobs that have moved to Applications, including a failed or staged attempt.
 * ADR 0026 excludes them from Shortlisted's Apply to all count. Their next
 * action belongs to the existing record in Applications, where Try again
 * preserves its history instead of starting another batch entry here.
 */
export function collectPreparedApplicationJobIds(
  applicationRecords:
    | readonly {
        jobId: string;
        status: ApplicationStatus;
        lastAttemptState?: ApplicationAttemptState | null;
      }[]
    | undefined,
): ReadonlySet<string> {
  return new Set((applicationRecords ?? []).map((record) => record.jobId));
}

export function collectInProgressApplicationJobIds(
  applicationRecords:
    | readonly {
        jobId: string;
        lastAttemptState?: ApplicationAttemptState | null | undefined;
      }[]
    | undefined,
): ReadonlySet<string> {
  return new Set(
    (applicationRecords ?? [])
      .filter((record) => record.lastAttemptState === "in_progress")
      .map((record) => record.jobId),
  );
}

export function isQueueStageReady(
  item: ReviewQueueItem | null,
  preparedJobIds?: ReadonlySet<string>,
): boolean {
  if (!item || preparedJobIds?.has(item.jobId)) {
    return false;
  }

  // A job set to apply with the original resume already has its resume file:
  // the one the person uploaded. It has no tailored draft and never will, so
  // requiring a ready generated asset left six such rows unselectable under a
  // sentence that named the unchanged original resume as qualifying, beside a
  // batch card explaining there was no draft to write.
  if (isResumeGenerationInProgress(item)) return false;

  if (item.resumeApplicationMode === "original_resume") {
    return true;
  }

  if (needsPersonResumeReview(item) || needsTailoredResume(item)) {
    return false;
  }

  return Boolean(
    item.assetStatus === "ready" &&
    item.resumeAssetId &&
    (item.resumeReview.status === "approved" ||
      item.resumeReview.status === "draft" ||
      item.resumeReview.status === "needs_review" ||
      item.resumeReview.status === "original_resume"),
  );
}

/**
 * A bulk draft run may only schedule a tailored job that has no existing
 * review. Failed attempts remain eligible so the user can retry them; queued,
 * generating, ready, stale, approved, and already-reviewed jobs stay out of
 * the run.
 */
export function isTailoredDraftPreparationEligible(
  item: ReviewQueueItem,
  /**
   * Jobs whose application is already prepared, read from the application
   * records — the SAME set `isQueueStageReady` is given. Both counts on the
   * batch card now come off one population, so "0 eligible · 12 ready to
   * prepare" can no longer be two answers about jobs that overlap.
   */
  preparedJobIds?: ReadonlySet<string>,
): boolean {
  if (preparedJobIds?.has(item.jobId)) {
    return false;
  }

  if (item.resumeApplicationMode === "original_resume") return false;
  // A resume that kept the person's wording because the listing was not read
  // was never tailored; it counts as missing until it is approved.
  if (item.resumeWrittenWithoutListing)
    return item.resumeReview.status !== "approved";
  return (
    (item.assetStatus === "not_started" || item.assetStatus === "failed") &&
    item.resumeReview.status === "not_started"
  );
}

export function countTailoredDraftPreparationEligible(
  queue: readonly ReviewQueueItem[],
  preparedJobIds?: ReadonlySet<string>,
): number {
  const seenJobIds = new Set<string>();
  let count = 0;

  for (const item of queue) {
    if (
      seenJobIds.has(item.jobId) ||
      !isTailoredDraftPreparationEligible(item, preparedJobIds)
    ) {
      continue;
    }

    seenJobIds.add(item.jobId);
    count += 1;
  }

  return count;
}
