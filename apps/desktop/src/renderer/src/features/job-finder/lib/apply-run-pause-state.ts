import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import { resolveApplyStatePresentation } from "../screens/applications/apply-state";

type ApplyRun = NonNullable<
  JobFinderRendererWorkspaceSnapshot["applyRuns"]
>[number];
type ApplyJobResult =
  JobFinderRendererWorkspaceSnapshot["applyJobResults"][number];

/**
 * What an application run that reads "paused for review" is actually doing.
 *
 * - `waiting_on_you`: a hand-off or a question on one of its jobs waits on
 *   the person (Needs you has it).
 * - `ready_for_final_review`: every job is filled in and waiting to be sent,
 *   or already sent.
 * - `stopped_by_safeguard`: a safety limit (a sample to review, a company
 *   cap, a failure-rate pause) held jobs back; it does not carry on by itself.
 * - `finished`: nothing is left. Every job was sent, could not be applied,
 *   was skipped, or was tried again in a newer attempt. Old runs keep their
 *   "paused" state and summary from before later fixes; they are finished.
 *
 * Activity and Safeguards both read this, so they never disagree about
 * whether a run is a safety pause.
 */
export type ApplyRunPauseState =
  | "waiting_on_you"
  | "ready_for_final_review"
  | "stopped_by_safeguard"
  | "finished";

const TERMINAL_REQUEST_STATES = new Set([
  "resolved",
  "cancelled",
  "skipped",
  "expired",
  "superseded",
]);

function newestResultByRecord(
  results: readonly ApplyJobResult[],
): Map<string, ApplyJobResult> {
  const newest = new Map<string, ApplyJobResult>();
  for (const result of results) {
    if (!result.applicationRecordId) continue;
    const previous = newest.get(result.applicationRecordId);
    if (!previous || previous.updatedAt < result.updatedAt)
      newest.set(result.applicationRecordId, result);
  }
  return newest;
}

function isReadyToSend(result: ApplyJobResult): boolean {
  return (
    result.state === "awaiting_review" &&
    result.blockerReason === null &&
    result.latestQuestionCount === 0 &&
    result.pendingConsentRequestCount === 0 &&
    result.reviewCard != null &&
    result.reviewCard.waitingOnYou.length === 0
  );
}

export function classifyPausedApplyRun(
  workspace: Pick<
    JobFinderRendererWorkspaceSnapshot,
    "applyJobResults" | "userActionRequests" | "intelligence"
  > & {
    applicationRecords?: JobFinderRendererWorkspaceSnapshot["applicationRecords"];
  },
  run: ApplyRun,
): ApplyRunPauseState | null {
  if (run.state !== "paused_for_user_review") return null;

  const hasOpenHandoff = (workspace.userActionRequests ?? []).some(
    (request) =>
      request.scope.type === "application" &&
      request.scope.runId === run.id &&
      !TERMINAL_REQUEST_STATES.has(request.state),
  );
  if (hasOpenHandoff) return "waiting_on_you";

  const allResults = workspace.applyJobResults ?? [];
  const newestByRecord = newestResultByRecord(allResults);
  const runResults = allResults.filter((result) => result.runId === run.id);
  // Cancelling the last hand-off moves an application to manual-only; the
  // paused run it came from is history, not a pause.
  const recordsById = new Map(
    (workspace.applicationRecords ?? []).map((record) => [record.id, record]),
  );
  const manualOnlyRecordIds = new Set(
    (workspace.applicationRecords ?? [])
      .filter((record) => record.lastAttemptState === "unsupported")
      .map((record) => record.id),
  );

  let ready = 0;
  let waiting = 0;
  let open = 0;
  for (const jobId of run.jobIds) {
    const result = runResults
      .filter((candidate) => candidate.jobId === jobId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!result) {
      open += 1;
      continue;
    }
    // A newer attempt for the same application owns it now.
    if (
      result.applicationRecordId &&
      newestByRecord.get(result.applicationRecordId)?.id !== result.id
    )
      continue;
    if (["submitted", "failed", "skipped", "cancelled"].includes(result.state))
      continue;
    if (
      result.applicationRecordId &&
      manualOnlyRecordIds.has(result.applicationRecordId)
    )
      continue;
    if (isReadyToSend(result)) {
      ready += 1;
      continue;
    }
    if (result.state === "awaiting_review") {
      // Read a filled-in form the way the Applications row does, so a stale
      // review card left from before a sign-in cannot turn a Ready to send
      // application into a "safety pause" here.
      const record = result.applicationRecordId
        ? recordsById.get(result.applicationRecordId)
        : undefined;
      const kind = resolveApplyStatePresentation({
        recordCrm: record?.crm,
        mode:
          record?.automationMode === "autonomous_submit"
            ? "apply_for_me"
            : "fill_only",
        result,
        pendingQuestionCount: record
          ? Math.max(
              0,
              record.questionSummary.total - record.questionSummary.answered,
            )
          : 0,
      }).kind;
      if (kind === "ready_to_send") {
        ready += 1;
        continue;
      }
      if (kind === "applied" || kind === "could_not_apply") continue;
      if (kind === "needs_you") {
        // Needs you lists it (a question or a wall on the kept page).
        waiting += 1;
        continue;
      }
    }
    open += 1;
  }

  if (waiting > 0) return "waiting_on_you";
  if (open === 0 && ready === 0) return "finished";
  // Only jobs it did not get to make a run a safety pause. A batch whose
  // every form is filled in waits on the sample review, which Safeguards
  // lists and counts on its own; counting the run too said "2 safeguards"
  // and "press Prepare remaining jobs" for a batch with nothing remaining.
  if (open > 0) return "stopped_by_safeguard";
  return "ready_for_final_review";
}

export function hasPendingSampleReview(
  workspace: Pick<JobFinderRendererWorkspaceSnapshot, "intelligence">,
  runId: string,
): boolean {
  return (
    workspace.intelligence?.safeguards.preparedBatchSampleReviews.some(
      (review) => review.batchId === runId && !review.reviewCompleted,
    ) ?? false
  );
}

/** Runs a safety limit stopped, the only ones Safeguards lists as pauses. */
export function listApplyRunsStoppedBySafeguard(
  workspace: Pick<
    JobFinderRendererWorkspaceSnapshot,
    | "applyRuns"
    | "applyJobResults"
    | "userActionRequests"
    | "intelligence"
    | "applicationRecords"
  >,
): ApplyRun[] {
  return (workspace.applyRuns ?? []).filter(
    (run) => classifyPausedApplyRun(workspace, run) === "stopped_by_safeguard",
  );
}
