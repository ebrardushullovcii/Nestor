import { useSyncExternalStore } from "react";
import type {
  ApplicationRecord,
  ReviewQueueItem,
  TailoredAssetSummary,
} from "@nestor/contracts";
import {
  collectInProgressApplicationJobIds,
  collectPreparedApplicationJobIds,
  getReviewQueueWorkflowStatus,
  TO_REVIEW_LABEL,
} from "./review-queue-status";

/**
 * The person's pass through "To review" in Resume Studio.
 *
 * Approving builds and checks the application PDF, which takes seconds, so
 * "Approve and next" opens the next resume at once and the approval finishes
 * behind it, one at a time. This store remembers, for this run of the app,
 * which approvals are still being built, which finished, and which failed,
 * so the progress line and the "next" choice do not wait for them.
 */
export interface ResumeReviewSessionState {
  readonly approving: ReadonlySet<string>;
  readonly approved: ReadonlySet<string>;
  /** Job id to the reason its approval failed. */
  readonly failed: ReadonlyMap<string, string>;
}

let state: ResumeReviewSessionState = {
  approving: new Set(),
  approved: new Set(),
  failed: new Map(),
};
const listeners = new Set<() => void>();

function update(next: ResumeReviewSessionState) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getResumeReviewSession(): ResumeReviewSessionState {
  return state;
}

export function useResumeReviewSession(): ResumeReviewSessionState {
  return useSyncExternalStore(subscribe, getResumeReviewSession);
}

export function markResumeReviewApproving(jobId: string): void {
  const failed = new Map(state.failed);
  failed.delete(jobId);
  update({
    approving: new Set([...state.approving, jobId]),
    approved: state.approved,
    failed,
  });
}

export function markResumeReviewApproved(jobId: string): void {
  const approving = new Set(state.approving);
  approving.delete(jobId);
  update({
    approving,
    approved: new Set([...state.approved, jobId]),
    failed: state.failed,
  });
}

export function markResumeReviewFailed(jobId: string, reason: string): void {
  const approving = new Set(state.approving);
  approving.delete(jobId);
  update({
    approving,
    approved: state.approved,
    failed: new Map([...state.failed, [jobId, reason]]),
  });
}

/** For tests: forget the session. */
export function resetResumeReviewSession(): void {
  update({ approving: new Set(), approved: new Set(), failed: new Map() });
}

let approvalChain: Promise<void> = Promise.resolve();

/**
 * Runs approvals one after another, so several quick "Approve and next"
 * presses do not build several PDFs at once.
 */
export function enqueueResumeApproval(run: () => Promise<void>): void {
  approvalChain = approvalChain.then(run, run);
}

/**
 * The shortlisted jobs whose resume waits for the person's read, in the
 * Shortlisted list's order: the same "To review" status the rows and the
 * "To review" tab show. Approvals still being built are left out.
 */
export function listResumesToReview(input: {
  queue: readonly ReviewQueueItem[];
  tailoredAssets: readonly TailoredAssetSummary[];
  applicationRecords: readonly ApplicationRecord[];
  session: ResumeReviewSessionState;
}): readonly ReviewQueueItem[] {
  const assetsByJobId = new Map(
    input.tailoredAssets.map((asset) => [asset.jobId, asset] as const),
  );
  const prepared = collectPreparedApplicationJobIds(input.applicationRecords);
  const preparing = collectInProgressApplicationJobIds(
    input.applicationRecords,
  );
  return input.queue.filter(
    (item) =>
      !input.session.approving.has(item.jobId) &&
      getReviewQueueWorkflowStatus(
        item,
        assetsByJobId.get(item.jobId),
        false,
        prepared,
        preparing,
      ).label === TO_REVIEW_LABEL,
  );
}

export interface ResumeReviewProgress {
  /** Resumes approved (or being approved) during this pass. */
  reviewed: number;
  /** Reviewed plus the ones still waiting, the current one included. */
  total: number;
  /** The next resume to open after this one, in list order, or null. */
  next: ReviewQueueItem | null;
  /** Approvals that failed, with the job they belong to. */
  failures: readonly { item: ReviewQueueItem; reason: string }[];
}

export function describeResumeReviewProgress(input: {
  currentJobId: string;
  toReview: readonly ReviewQueueItem[];
  queue: readonly ReviewQueueItem[];
  session: ResumeReviewSessionState;
}): ResumeReviewProgress {
  const waiting = new Set(input.toReview.map((item) => item.jobId));
  const reviewed = new Set(
    [...input.session.approved, ...input.session.approving].filter(
      (jobId) => !waiting.has(jobId),
    ),
  ).size;
  const indexById = new Map(
    input.queue.map((item, index) => [item.jobId, index] as const),
  );
  const currentIndex = indexById.get(input.currentJobId) ?? -1;
  // The next one after this job in list order, wrapping to the top, so a
  // person who started in the middle of the list still meets every resume.
  const after = input.toReview.filter(
    (item) => (indexById.get(item.jobId) ?? -1) > currentIndex,
  );
  const before = input.toReview.filter(
    (item) => (indexById.get(item.jobId) ?? -1) < currentIndex,
  );
  const ordered = [...after, ...before];
  const queueById = new Map(input.queue.map((item) => [item.jobId, item]));
  return {
    reviewed,
    total: reviewed + input.toReview.length,
    next: ordered.find((item) => item.jobId !== input.currentJobId) ?? null,
    failures: [...input.session.failed].flatMap(([jobId, reason]) => {
      const item = queueById.get(jobId);
      return item && waiting.has(jobId) ? [{ item, reason }] : [];
    }),
  };
}

/** What Resume Studio needs to run the review pass for the open resume. */
export interface ResumeReviewFlow {
  reviewed: number;
  total: number;
  /** Title of the resume "Approve and next" opens, or null at the last one. */
  nextTitle: string | null;
  failures: readonly { jobId: string; title: string; reason: string }[];
  /** Approves this resume and opens the next one (or Shortlisted). */
  onApproveAndNext: (exportId?: string) => void;
  /** Opens the next resume without approving this one. */
  onSkip: (() => void) | null;
  onOpenJob: (jobId: string) => void;
}
