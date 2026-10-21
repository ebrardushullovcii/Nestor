import { RESUME_PIPELINE_CAPACITY } from "@nestor/contracts";
import {
  type ApplicationAttemptState,
  type ApplicationStatus,
  type BrowserSessionState,
  type ResumeApplicationMode,
  type ReviewQueueItem,
  type TailoredAssetSummary,
  type TailoringMode,
  type ResumeBatchProviderBlock,
} from "@nestor/contracts";
import type { BadgeTone } from "../../lib/job-finder-types";
import {
  describeAiUnavailableResume,
  describeUntailorableListing,
} from "./resume-workspace-utils";

export const APPLICATION_PREPARATION_BATCH_LIMIT = 10;

export type TailoredDraftPreparationStatus =
  | "idle"
  | "running"
  | "completed"
  | "stopped"
  | "failed";

export interface TailoredDraftPreparationViewState {
  attemptedCount: number;
  completedCount: number;
  fallbackCount?: number;
  originalChoiceCount?: number;
  cancelledCount?: number;
  currentIndex: number | null;
  eligibleRemainingCount: number;
  failedCount: number;
  status: TailoredDraftPreparationStatus;
  providerBlock?: ResumeBatchProviderBlock;
  /** Stop was pressed: nothing new starts; drafts already started finish. */
  stopRequested?: boolean;
  totalCount: number;
  durationsMs?: number[];
  elapsedMs?: number;
  writingCount?: number;
  processingCount?: number;
  waitingCount?: number;
  /** Where each job of the running batch is, as the main process reports it. */
  stageByJobId?: Readonly<Record<string, ResumeRunStage>>;
}

export interface TailoredDraftPreparationProgress {
  completedCount: number;
  fallbackCount?: number;
  originalChoiceCount?: number;
  cancelledCount?: number;
  currentIndex: number;
  failedCount: number;
  totalCount: number;
}

export interface TailoredDraftPreparationResult {
  attemptedCount: number;
  completedCount: number;
  fallbackCount?: number;
  originalChoiceCount?: number;
  cancelledCount?: number;
  failedCount: number;
  failedJobIds: readonly string[];
  stopped: boolean;
  totalCount: number;
}

export interface ReviewQueueWorkflowStatus {
  label: string;
  tone: BadgeTone;
}

/**
 * One name for a job that still needs its resume: the status tab, the row
 * badge and the detail header all use it.
 */
export const NEEDS_RESUME_LABEL = "Needs a resume";

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
 * Whether the job's resume is being written right now, and whether the last
 * attempt failed, in the order the row badge uses: a run in progress outranks
 * the last one's failure. "Try again" used to leave the failure box and a
 * disabled Try again on screen for the whole rewrite.
 */
export function getResumeRunState(
  item: ReviewQueueItem | null,
  asset: TailoredAssetSummary | null | undefined,
  isPending: boolean,
): { hasFailure: boolean; isWriting: boolean } {
  const failed = hasResumeGenerationFailure(item, asset);
  const isWriting =
    item !== null &&
    item.resumeApplicationMode !== "original_resume" &&
    (isPending || (!failed && isResumeGenerationInProgress(item)));
  return { hasFailure: failed && !isPending && !isWriting, isWriting };
}

/** The stages a resume run reports while it is still going. */
export type ResumeRunStage = "queued" | "writing" | "processing";

/**
 * What a running resume is doing, in one calm sentence. Only the batch run
 * reports stages; a single run has none and says it is writing.
 */
export function describeResumeRunStage(
  stage: ResumeRunStage | null | undefined,
): string {
  switch (stage) {
    case "queued":
      return "Waiting its turn while other resumes are written.";
    case "processing":
      return "Checking it against your profile…";
    default:
      return "Writing the resume…";
  }
}

export interface ApplyReadinessStatus {
  label: string;
  tone: "active" | "critical" | "muted" | "positive";
}

export type ApplySupportState = "incomplete" | "manual_follow_up" | "supported";

export function getReviewQueueWorkflowStatus(
  item: ReviewQueueItem | null,
  asset?: TailoredAssetSummary | null,
  /**
   * The renderer's own in-flight flag. The persisted asset status never moves
   * to "generating" during a draft, so without this the row and header kept
   * saying "Needs resume" for the whole run beside a progress bar.
   */
  isPending = false,
  /** Jobs whose application is already prepared; see isQueueStageReady. */
  preparedJobIds?: ReadonlySet<string>,
  /** Jobs with a preparation attempt that is still running. */
  applicationPreparingJobIds?: ReadonlySet<string>,
): ReviewQueueWorkflowStatus {
  if (!item) {
    return {
      label: "Choose a job",
      tone: "muted",
    };
  }

  // A run in progress outranks the last one's failure: "Try again" used to
  // leave the row saying "Resume failed" for the whole rewrite.
  if (isPending) {
    return {
      label:
        item.resumeApplicationMode === "original_resume"
          ? "Reading the listing"
          : "Writing resume",
      tone: "active",
    };
  }

  if (hasResumeGenerationFailure(item, asset)) {
    return {
      label: "Resume failed",
      tone: "critical",
    };
  }

  if (applicationPreparingJobIds?.has(item.jobId)) {
    return {
      label: "Applying",
      tone: "active",
    };
  }

  if (preparedJobIds?.has(item.jobId)) {
    return {
      label: "In Applications",
      tone: "positive",
    };
  }

  if (item.assetStatus === "not_started") {
    // Original with nothing imported has no file to send; Apply stays off and
    // the label says what unblocks it.
    return item.resumeApplicationMode === "original_resume"
      ? { label: "Import your resume", tone: "warning" }
      : { label: NEEDS_RESUME_LABEL, tone: "muted" };
  }

  if (item.assetStatus === "generating" || item.assetStatus === "queued") {
    return {
      label: "Writing resume",
      tone: "active",
    };
  }

  // Same words as the status tab it sits under: a resume that kept the
  // person's wording because the listing was not read was never tailored
  // (ADR 0049). The row used to say "Review resume" inside "Needs a resume".
  if (needsTailoredResume(item)) {
    return { label: NEEDS_RESUME_LABEL, tone: "muted" };
  }

  // An Aggressive draft is read by the person before it is used (ADR 0018),
  // so the row says so instead of promising Apply.
  if (needsPersonResumeReview(item, asset)) {
    return {
      label: "Review resume",
      tone: "active",
    };
  }

  if (isQueueStageReady(item)) {
    return {
      label: "Ready to apply",
      tone: "positive",
    };
  }

  if (item.resumeReview.status === "approved" && !item.resumeAssetId) {
    return {
      label: "Resume unavailable",
      tone: "critical",
    };
  }

  if (item.resumeReview.status === "stale") {
    // The approved draft is stale, not broken: the resume still exists and the
    // job is still reviewable, it just needs regenerating. `warning` (F44)
    // instead of the failure hue `critical` used before the tone existed.
    return {
      label: "Out of date",
      tone: "warning",
    };
  }

  return {
    label: "Review resume",
    tone: "active",
  };
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
 * Picking another level for a job whose resume is already written rewrites
 * it at that level. Changing Light to Tailored used to leave the Light text
 * in place, still "ready", and Apply approved and sent it; the only rewrite
 * sat inside the guided-edits popup. Original sends the imported file, so
 * moving to it rewrites nothing, and a job with no resume yet keeps its
 * "Create the resume" step.
 */
export function shouldRewriteResumeAfterLevelChange(input: {
  item: Pick<
    ReviewQueueItem,
    "assetStatus" | "resumeApplicationMode" | "resumeTailoringMode"
  >;
  /** The saved strength a job without its own level is written at. */
  defaultTailoringMode: TailoringMode;
  nextApplicationMode: ResumeApplicationMode;
  nextTailoringMode?: TailoringMode | null;
}): boolean {
  if (
    input.nextApplicationMode === "original_resume" ||
    input.item.assetStatus !== "ready"
  ) {
    return false;
  }
  const currentLevel =
    input.item.resumeApplicationMode === "original_resume"
      ? "original_resume"
      : (input.item.resumeTailoringMode ?? input.defaultTailoringMode);
  const nextLevel = input.nextTailoringMode ?? input.defaultTailoringMode;
  return currentLevel !== nextLevel;
}

export function needsResumeGeneration(item: ReviewQueueItem | null): boolean {
  return (
    item?.resumeApplicationMode !== "original_resume" &&
    item?.assetStatus === "not_started"
  );
}

export function hasResumeGenerationFailure(
  item: ReviewQueueItem | null,
  asset?: TailoredAssetSummary | null,
): boolean {
  if (asset?.failureMessage && asset.failedAt) return true;
  if (item?.assetStatus !== "failed") {
    return false;
  }
  // A real generation failure always persists sanitized failure detail next
  // to its failed status. A failed marker without any failure detail is a
  // restored or stale review state (the tailored draft still exists), so the
  // nearest recovery is review plus export instead of regenerating.
  if (!asset) {
    return true;
  }
  return asset.failureMessage !== null || asset.failedAt !== null;
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
 * Shortlisted row caption: what the resume for this job is right now, in
 * one short line. Must match readiness: never say a resume "will be created"
 * when one is ready.
 */
export function getReviewQueueResumePolicyCaption(
  item: ReviewQueueItem,
  asset?: TailoredAssetSummary | null,
): string {
  if (hasResumeGenerationFailure(item, asset)) {
    return asset?.status === "ready"
      ? "Rewrite failed — your previous resume was kept"
      : "Resume failed — try again";
  }
  if (item.resumeApplicationMode === "original_resume") {
    return item.resumeReview.status === "original_resume"
      ? "Original resume, unchanged"
      : "Original resume, unchanged (import it in Profile)";
  }

  // Nothing could be written for a job whose listing text was never captured,
  // so the row must not promise a tailored resume it is not going to produce.
  if (describeUntailorableListing(asset)) {
    return "Original wording — the listing text was not captured";
  }

  if (item.assetStatus === "generating" || item.assetStatus === "queued") {
    return "Writing the resume…";
  }

  if (item.resumeReview.status === "stale") {
    return "Resume is out of date — refresh it";
  }

  if (hasResumeGenerationFailure(item)) {
    return "Resume failed — try again";
  }

  if (item.resumeReview.status === "approved") {
    return "Resume approved";
  }

  // The built-in generator wrote it because AI was unavailable. It is usable,
  // but the row must not read like an AI-written resume.
  if (item.assetStatus === "ready" && describeAiUnavailableResume(asset)) {
    return "Your saved wording — AI was unavailable";
  }

  const linesToDecide = countResumeLinesToDecide(item);
  if (linesToDecide > 0) {
    return linesToDecide === 1
      ? "A line in this resume needs your decision"
      : `${linesToDecide} lines in this resume need your decision`;
  }

  if (needsPersonResumeReview(item, asset)) {
    return "Resume ready — review it before applying";
  }

  if (
    item.assetStatus === "ready" ||
    item.resumeReview.status === "needs_review" ||
    item.resumeReview.status === "draft"
  ) {
    return "Resume ready — Apply approves it";
  }

  // Nothing has been requested yet; name the need, not a promised action.
  return "No resume yet";
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

/**
 * Why the batch-draft button cannot run, in the words of what would change it.
 * A permanently greyed control beside a number the person cannot act on is the
 * shape of the defect this replaces; null means the button is live.
 */
export function describeTailoredDraftPreparationBlocker(
  queue: readonly ReviewQueueItem[],
  preparedJobIds?: ReadonlySet<string>,
): string | null {
  if (countTailoredDraftPreparationEligible(queue, preparedJobIds) > 0) {
    return null;
  }

  if (queue.length === 0) {
    return "Shortlist a job first.";
  }

  const allOriginalResume = queue.every(
    (item) => item.resumeApplicationMode === "original_resume",
  );
  if (allOriginalResume) {
    return "Every job here uses your original resume, so there is nothing to write.";
  }

  return "Every job here already has a resume.";
}

export function getTailoredDraftPreparationCandidates(
  queue: readonly ReviewQueueItem[],
  limit = queue.length,
  preparedJobIds?: ReadonlySet<string>,
): ReviewQueueItem[] {
  const boundedLimit = Math.max(0, limit);

  if (boundedLimit === 0) {
    return [];
  }

  const seenJobIds = new Set<string>();
  const candidates: ReviewQueueItem[] = [];

  for (const item of queue) {
    if (
      seenJobIds.has(item.jobId) ||
      !isTailoredDraftPreparationEligible(item, preparedJobIds)
    ) {
      continue;
    }

    seenJobIds.add(item.jobId);
    candidates.push(item);

    if (candidates.length >= boundedLimit) {
      break;
    }
  }

  return candidates;
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

export function countQueueStageReady(
  queue: readonly ReviewQueueItem[],
  preparedJobIds?: ReadonlySet<string>,
): number {
  const seenJobIds = new Set<string>();
  let count = 0;

  for (const item of queue) {
    if (seenJobIds.has(item.jobId)) {
      continue;
    }

    seenJobIds.add(item.jobId);
    if (isQueueStageReady(item, preparedJobIds)) {
      count += 1;
    }
  }

  return count;
}

export async function prepareTailoredDraftBatch(
  queue: readonly ReviewQueueItem[],
  // null: the job was not started because the batch was stopped first.
  onGenerateResume: (
    jobId: string,
  ) => Promise<
    | boolean
    | null
    | "written"
    | "fallback"
    | "original"
    | "cancelled"
    | "blocked"
  >,
  options: {
    onProgress?: (progress: TailoredDraftPreparationProgress) => void;
    shouldStop?: () => boolean;
    includeExisting?: boolean;
  } = {},
): Promise<TailoredDraftPreparationResult> {
  const candidates = options.includeExisting
    ? [...queue]
    : getTailoredDraftPreparationCandidates(queue);
  let attemptedCount = 0;
  let nextCandidateIndex = 0;
  let completedCount = 0;
  let fallbackCount = 0;
  let originalChoiceCount = 0;
  let cancelledCount = 0;
  const failedJobIds: string[] = [];
  let stopped = false;

  const reportProgress = () => {
    options.onProgress?.({
      completedCount,
      ...(fallbackCount ? { fallbackCount } : {}),
      ...(originalChoiceCount ? { originalChoiceCount } : {}),
      ...(cancelledCount ? { cancelledCount } : {}),
      currentIndex: attemptedCount,
      failedCount: failedJobIds.length,
      totalCount: candidates.length,
    });
  };
  const worker = async () => {
    while (nextCandidateIndex < candidates.length && !stopped) {
      if (options.shouldStop?.()) {
        stopped = true;
        return;
      }
      // Claim synchronously before awaiting so each job has exactly one owner.
      const item = candidates[nextCandidateIndex++]!;
      attemptedCount += 1;
      reportProgress();
      let succeeded:
        | boolean
        | null
        | "written"
        | "fallback"
        | "original"
        | "cancelled"
        | "blocked" = false;
      try {
        succeeded = await onGenerateResume(item.jobId);
      } catch {
        succeeded = false;
      }
      if (succeeded === null) {
        attemptedCount -= 1;
        stopped = true;
        reportProgress();
        return;
      }
      if (succeeded === "blocked") {
        stopped = true;
        reportProgress();
        return;
      }
      if (succeeded === "fallback") fallbackCount += 1;
      if (succeeded === "original") originalChoiceCount += 1;
      if (succeeded === "cancelled") cancelledCount += 1;
      if (succeeded) completedCount += 1;
      else failedJobIds.push(item.jobId);
      reportProgress();
    }
  };

  // The main pipeline gates50 writers and2 local processors. Admission is
  // bounded so finished drafts cannot accumulate for the whole selection.
  await Promise.all(
    Array.from(
      { length: Math.min(RESUME_PIPELINE_CAPACITY, candidates.length) },
      worker,
    ),
  );

  return {
    attemptedCount,
    completedCount,
    ...(fallbackCount ? { fallbackCount } : {}),
    ...(originalChoiceCount ? { originalChoiceCount } : {}),
    ...(cancelledCount ? { cancelledCount } : {}),
    failedCount: failedJobIds.length,
    failedJobIds: candidates
      .filter((item) => failedJobIds.includes(item.jobId))
      .map((item) => item.jobId),
    stopped,
    totalCount: candidates.length,
  };
}

/**
 * Result copy for a finished tailored-draft batch. A run that attempted every
 * candidate never reports "Stopped": failures continue the batch, and failed
 * jobs stay eligible so the exact remainder can be rerun.
 */
export function getTailoredDraftPreparationResultMessage(
  state: TailoredDraftPreparationViewState,
): string | null {
  if (
    state.status !== "completed" &&
    state.status !== "failed" &&
    state.status !== "stopped"
  ) {
    return null;
  }

  const completedCount = Math.max(0, state.completedCount);
  const failedCount = Math.max(0, state.failedCount);
  const fallbackCount = state.fallbackCount ?? 0;
  const originalChoiceCount = state.originalChoiceCount ?? 0;
  const cancelledCount = state.cancelledCount ?? 0;
  const writtenCount = Math.max(
    0,
    completedCount - fallbackCount - originalChoiceCount - cancelledCount,
  );
  const completedDrafts = `${writtenCount} resume${writtenCount === 1 ? "" : "s"}${fallbackCount ? ` · ${fallbackCount} kept your original wording` : ""}${originalChoiceCount ? ` · ${originalChoiceCount} Original by choice` : ""}${cancelledCount ? ` · ${cancelledCount} removed from the shortlist` : ""}`;

  if (state.providerBlock) {
    const unfinished = Math.max(0, state.totalCount - completedCount);
    return `Batch paused. ${state.providerBlock.message} ${unfinished} unfinished resume${unfinished === 1 ? " remains" : "s remain"} in the batch. Finished resumes were kept.`;
  }

  if (state.status === "completed") {
    return `Wrote ${completedDrafts}.`;
  }

  if (state.status === "stopped") {
    return `Stopped after ${completedDrafts}.`;
  }

  const ranToCompletion = state.attemptedCount >= state.totalCount;
  const leadSentence = ranToCompletion
    ? `Wrote ${completedDrafts}; ${failedCount} failed.`
    : `Stopped after ${completedDrafts}; ${failedCount} failed.`;

  return `${leadSentence} Run it again to retry the failed job${failedCount === 1 ? "" : "s"}.`;
}

export function getApplyReadinessStatus(params: {
  applySupportState: ApplySupportState;
  browserSession: BrowserSessionState;
  hasGenerationFailure: boolean;
  hasReadyApprovedAsset: boolean;
  isGenerating: boolean;
  needsGeneration: boolean;
  resumeReviewStatus: ReviewQueueItem["resumeReview"]["status"] | "not_started";
  selectedItem: ReviewQueueItem | null;
}): ApplyReadinessStatus {
  const {
    applySupportState,
    browserSession,
    hasGenerationFailure,
    hasReadyApprovedAsset,
    isGenerating,
    needsGeneration,
    resumeReviewStatus,
    selectedItem,
  } = params;

  if (!selectedItem) {
    return {
      label: "Choose a job",
      tone: "muted",
    };
  }

  if (hasGenerationFailure) {
    return {
      label: "Resume failed",
      tone: "critical",
    };
  }

  // An in-flight run wins over "Needs a resume": both flags are true while a
  // draft is being written, and the readiness description already orders
  // them this way.
  if (isGenerating) {
    return {
      label: "Writing resume",
      tone: "active",
    };
  }

  if (needsGeneration) {
    return {
      label: NEEDS_RESUME_LABEL,
      tone: "muted",
    };
  }

  if (!hasReadyApprovedAsset) {
    return {
      label: resumeReviewStatus === "stale" ? "Out of date" : "Review resume",
      tone: "critical",
    };
  }

  if (applySupportState === "incomplete") {
    return {
      label: "Job data missing",
      tone: "critical",
    };
  }

  if (applySupportState === "manual_follow_up") {
    if (browserSession.status === "blocked") {
      return {
        label: "Browser blocked",
        tone: "critical",
      };
    }

    if (browserSession.status === "login_required") {
      return {
        label: "Browser requires sign-in",
        tone: "active",
      };
    }

    return {
      label:
        browserSession.status === "unknown"
          ? "Browser not open"
          : "Live form check",
      tone: "active",
    };
  }

  if (browserSession.status === "ready") {
    return {
      label: "Ready to apply",
      tone: "positive",
    };
  }

  if (browserSession.status === "unknown") {
    return {
      label: "Browser not open",
      tone: "active",
    };
  }

  if (browserSession.status === "login_required") {
    return {
      label: "Browser requires sign-in",
      tone: "active",
    };
  }

  return {
    label: "Browser blocked",
    tone: "critical",
  };
}

/** The Shortlisted level name for a saved tailoring strength. */
export function describeSavedResumeLevel(level: TailoringMode): string {
  return level === "aggressive"
    ? "Aggressive"
    : level === "conservative"
      ? "Light"
      : "Tailored";
}

/**
 * The level a shortlisted row names, or null when the job follows the
 * profile's level and the list cannot know it without the profile.
 */
export function describeQueueItemResumeLevel(
  item: Pick<ReviewQueueItem, "resumeApplicationMode" | "resumeTailoringMode">,
): string | null {
  if (item.resumeApplicationMode === "original_resume") return "Original";
  return item.resumeTailoringMode
    ? describeSavedResumeLevel(item.resumeTailoringMode)
    : null;
}

/**
 * Captions that only repeat the row's status badge in other words. A row
 * used to read "REVIEW RESUME" and, under it, "Resume ready — review it
 * before applying"; the status is said once now, and the caption line is
 * kept for what the badge cannot say (kept wording, a kept previous resume,
 * lines to decide).
 */
const CAPTIONS_REPEATING_STATUS: Readonly<Record<string, readonly string[]>> = {
  [NEEDS_RESUME_LABEL]: ["No resume yet"],
  "Writing resume": ["Writing the resume…"],
  "Resume failed": ["Resume failed — try again"],
  "Review resume": ["Resume ready — review it before applying"],
  "Ready to apply": ["Resume approved", "Resume ready — Apply approves it"],
  "Out of date": ["Resume is out of date — refresh it"],
};

/** The row's caption, or null when it would only repeat the status badge. */
export function getReviewQueueRowCaption(
  statusLabel: string,
  caption: string,
): string | null {
  return CAPTIONS_REPEATING_STATUS[statusLabel]?.includes(caption)
    ? null
    : caption;
}

/** What the action line says after a resume run for one job finished. */
export const AI_UNAVAILABLE_RESUME_RESULT_MESSAGE =
  "AI was unavailable, so this resume keeps your saved wording. Press Try again with AI when you are ready.";

/**
 * A resume run can end with the built-in resume when AI was unavailable. The
 * action line must say so instead of "Resume created", which reads as an AI
 * resume that is ready.
 */
export function describeResumeRunResult(
  snapshot:
    | { tailoredAssets?: readonly TailoredAssetSummary[] }
    | null
    | undefined,
  jobId: string,
  successMessage: string,
): string {
  const asset = snapshot?.tailoredAssets?.find(
    (candidate) => candidate.jobId === jobId,
  );
  return describeAiUnavailableResume(asset)
    ? AI_UNAVAILABLE_RESUME_RESULT_MESSAGE
    : successMessage;
}

export type ShortlistStatusFilter =
  | "all"
  | "needs_resume"
  | "writing"
  | "to_review"
  | "ready"
  | "in_applications";

export const SHORTLIST_STATUS_FILTER_LABELS: Record<
  ShortlistStatusFilter,
  string
> = {
  all: "All",
  needs_resume: NEEDS_RESUME_LABEL,
  writing: "Writing",
  to_review: "To review",
  ready: "Ready to apply",
  in_applications: "In Applications",
};

/**
 * Which status filter a shortlisted job falls under, from the same status the
 * row shows. A job that can have a resume written (none yet, a failed one, or
 * one written without the listing) counts as needing one.
 */
export function getShortlistStatusFilter(
  workflowLabel: string,
  canWriteResume: boolean,
): Exclude<ShortlistStatusFilter, "all"> | null {
  switch (workflowLabel) {
    case "Writing resume":
    case "Reading the listing":
      return "writing";
    case "Applying":
    case "In Applications":
      return "in_applications";
  }
  if (
    canWriteResume ||
    workflowLabel === NEEDS_RESUME_LABEL ||
    workflowLabel === "Resume failed"
  )
    return "needs_resume";
  if (workflowLabel === "Review resume") return "to_review";
  if (workflowLabel === "Ready to apply") return "ready";
  return null;
}

function duplicateKeyPart(value: string | null | undefined): string {
  return (value ?? "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Shortlisted jobs that share title, employer and place with another one. */
export function findPossibleDuplicateJobIds(
  queue: readonly Pick<
    ReviewQueueItem,
    "jobId" | "title" | "company" | "location"
  >[],
): ReadonlySet<string> {
  const jobIdsByKey = new Map<string, string[]>();
  for (const item of queue) {
    const key = [item.title, item.company, item.location]
      .map(duplicateKeyPart)
      .join("|");
    const jobIds = jobIdsByKey.get(key);
    if (jobIds) jobIds.push(item.jobId);
    else jobIdsByKey.set(key, [item.jobId]);
  }
  return new Set(
    [...jobIdsByKey.values()].filter((ids) => ids.length > 1).flat(),
  );
}
