import {
  ApplicationAttemptSchema,
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  type ApplicationAttempt,
  type ApplicationAttemptInput,
  type ApplicationRecord,
  type ApplyJobResult,
  type ApplyRun,
  type JobFinderActivityControl,
  type ApplySubmitApproval,
} from "@nestor/contracts";

/** A paused queue may be resumed after restart only between jobs. */
export function isSafelyParkedApplyQueue(input: {
  run: ApplyRun;
  results: readonly ApplyJobResult[];
  control: JobFinderActivityControl;
}): boolean {
  const { run, results, control } = input;
  if (
    !control.paused ||
    control.pauseBehavior !== "finish_current" ||
    run.mode !== "queue_auto" ||
    run.state !== "running" ||
    results.length !== run.jobIds.length
  )
    return false;
  if (new Set(results.map((result) => result.jobId)).size !== run.jobIds.length)
    return false;
  if (!results.some((result) => result.state === "planned")) return false;
  return results.every(
    (result) =>
      result.runId === run.id &&
      run.jobIds.includes(result.jobId) &&
      (result.state !== "planned" ||
        (result.applicationPreparationStartedAt == null &&
          result.applicationPreparationStartedLocalDate == null)) &&
      (result.state === "planned" ||
        result.state === "awaiting_review" ||
        result.state === "submitted" ||
        result.state === "blocked" ||
        result.state === "failed" ||
        result.state === "cancelled" ||
        result.state === "skipped") &&
      result.privacyReceipt?.submissionOutcome?.outcome !== "outcome_uncertain",
  );
}

// ---------------------------------------------------------------------------
// Reusing one batch approval across a retry of part of that batch
//
// Recovering a failed batch used to stage a fresh run with a fresh pending
// approval, so a person who had already approved twelve named jobs was asked
// again for every job that failed. ADR 0012 is untouched by this: approval is
// still per batch of named jobs, still revocable, and still authorises
// preparation only — nothing is submitted, and reuse can only ever cover jobs
// the person already named.
// ---------------------------------------------------------------------------

/**
 * How long an approved batch stays reusable for a retry of part of it. An
 * approval is a decision about work happening now, not standing permission;
 * after this it is asked again.
 */
export const APPLY_BATCH_APPROVAL_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ApplyBatchApprovalReuseRefusal =
  | "no_batch_approval"
  | "jobs_outside_batch"
  | "different_plan"
  | "batch_already_finished"
  | "approval_expired";

export interface ApplyBatchApprovalReuseDecision {
  /** The approval whose authority a retry may inherit, when there is one. */
  approval: ApplySubmitApproval | null;
  /** The first-hand approval that owns the lineage's time boundary. */
  authorityApproval: ApplySubmitApproval | null;
  /** Why no approval may be reused; null when one may. */
  refusal: ApplyBatchApprovalReuseRefusal | null;
}

function isReusableCandidate(
  approval: ApplySubmitApproval,
  authorityApproval: ApplySubmitApproval,
  nowMs: number,
): boolean {
  if (approval.status !== "approved") return false;
  if (approval.revokedAt !== null) return false;
  if (approval.batchId === null) return false;
  if (authorityApproval.status !== "approved") return false;
  if (authorityApproval.revokedAt !== null) return false;
  if (authorityApproval.approvedAt === null) return false;
  const approvedMs = Date.parse(authorityApproval.approvedAt);
  if (Number.isNaN(approvedMs)) return false;
  if (nowMs - approvedMs >= APPLY_BATCH_APPROVAL_REUSE_WINDOW_MS) return false;
  if (authorityApproval.expiresAt !== null) {
    const expiresMs = Date.parse(authorityApproval.expiresAt);
    if (Number.isNaN(expiresMs) || expiresMs <= nowMs) return false;
  }
  return true;
}

function resolveAuthorityApproval(
  approval: ApplySubmitApproval,
  approvalsById: ReadonlyMap<string, ApplySubmitApproval>,
): ApplySubmitApproval | null {
  const seen = new Set<string>();
  let current = approval;
  while (current.reusedFromApprovalId !== null) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    const parent = approvalsById.get(current.reusedFromApprovalId);
    if (!parent) return null;
    if (
      parent.batchId !== current.batchId ||
      (parent.batchCampaignId ?? null) !== (current.batchCampaignId ?? null) ||
      !current.jobIds.every((jobId) => parent.jobIds.includes(jobId))
    ) {
      return null;
    }
    current = parent;
  }
  return current;
}

function isValidReuseEdge(
  child: ApplySubmitApproval,
  parent: ApplySubmitApproval,
): boolean {
  return (
    child.reusedFromApprovalId === parent.id &&
    child.batchId === parent.batchId &&
    (child.batchCampaignId ?? null) === (parent.batchCampaignId ?? null) &&
    child.jobIds.every((jobId) => parent.jobIds.includes(jobId))
  );
}

/** Approval ids connected to any revoked ancestor or descendant. */
function findRevokedLineageApprovalIds(
  approvals: readonly ApplySubmitApproval[],
  approvalsById: ReadonlyMap<string, ApplySubmitApproval>,
): ReadonlySet<string> {
  const linkedApprovalIds = new Map<string, Set<string>>();
  const link = (leftId: string, rightId: string): void => {
    const linked = linkedApprovalIds.get(leftId) ?? new Set<string>();
    linked.add(rightId);
    linkedApprovalIds.set(leftId, linked);
  };
  for (const child of approvals) {
    if (!child.reusedFromApprovalId) continue;
    const parent = approvalsById.get(child.reusedFromApprovalId);
    if (!parent || !isValidReuseEdge(child, parent)) continue;
    link(child.id, parent.id);
    link(parent.id, child.id);
  }

  const invalidated = new Set<string>();
  const pending = approvals.filter(
    (approval) => approval.status === "revoked" || approval.revokedAt !== null,
  );

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || invalidated.has(current.id)) continue;
    invalidated.add(current.id);
    for (const linkedId of linkedApprovalIds.get(current.id) ?? []) {
      const linked = approvalsById.get(linkedId);
      if (linked) pending.push(linked);
    }
  }

  return invalidated;
}

/**
 * Decides whether a retry of `jobIds` is already covered by an approval the
 * person gave for the batch those jobs belong to.
 *
 * Pure and deliberately narrow. It refuses unless every requested job was
 * named in the original approval, the plan is the same, the approval is
 * approved and not revoked, and it is recent. The refusal is named so the
 * screen can say which of those was not true instead of showing a second
 * approval card with no explanation.
 */
export function selectReusableBatchApproval(input: {
  approvals: readonly ApplySubmitApproval[];
  jobIds: readonly string[];
  campaignId: string | null;
  /**
   * Runs of approved batches that did not finish. Only an unfinished batch
   * can be continued; once a batch ran to completion, staging the same jobs
   * again is a new intent and is asked about again.
   */
  unfinishedApprovalRunIds: ReadonlySet<string>;
  now: string;
}): ApplyBatchApprovalReuseDecision {
  const requested = [...new Set(input.jobIds)];
  if (requested.length === 0) {
    return {
      approval: null,
      authorityApproval: null,
      refusal: "no_batch_approval",
    };
  }
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) {
    return {
      approval: null,
      authorityApproval: null,
      refusal: "approval_expired",
    };
  }

  const approvalsById = new Map(
    input.approvals.map((approval) => [approval.id, approval]),
  );
  const revokedLineageApprovalIds = findRevokedLineageApprovalIds(
    input.approvals,
    approvalsById,
  );
  const candidates = input.approvals.flatMap((approval) => {
    const authorityApproval = resolveAuthorityApproval(approval, approvalsById);
    return authorityApproval &&
      !revokedLineageApprovalIds.has(approval.id) &&
      isReusableCandidate(approval, authorityApproval, nowMs)
      ? [{ approval, authorityApproval }]
      : [];
  });
  if (candidates.length === 0) {
    return {
      approval: null,
      authorityApproval: null,
      refusal: "no_batch_approval",
    };
  }

  const covering = candidates.filter(({ authorityApproval }) => {
    const covered = new Set(authorityApproval.jobIds);
    return requested.every((jobId) => covered.has(jobId));
  });
  if (covering.length === 0) {
    return {
      approval: null,
      authorityApproval: null,
      refusal: "jobs_outside_batch",
    };
  }

  const samePlan = covering.filter(
    ({ authorityApproval }) =>
      (authorityApproval.batchCampaignId ?? null) === input.campaignId,
  );
  if (samePlan.length === 0) {
    return {
      approval: null,
      authorityApproval: null,
      refusal: "different_plan",
    };
  }

  const unfinished = samePlan.filter(({ approval }) =>
    input.unfinishedApprovalRunIds.has(approval.runId),
  );
  if (unfinished.length === 0) {
    return {
      approval: null,
      authorityApproval: null,
      refusal: "batch_already_finished",
    };
  }

  // Prefer the latest continuation record, while its authority time remains
  // anchored to the first-hand approval at the root of that lineage.
  const chosen = [...unfinished].sort(
    (left, right) =>
      (right.authorityApproval.approvedAt ?? "").localeCompare(
        left.authorityApproval.approvedAt ?? "",
      ) || right.approval.createdAt.localeCompare(left.approval.createdAt),
  )[0];

  return {
    approval: chosen?.approval ?? null,
    authorityApproval: chosen?.authorityApproval ?? null,
    refusal: chosen ? null : "no_batch_approval",
  };
}

/**
 * One plain sentence for a batch that was staged but never got to start.
 *
 * The staged run is persisted before execution begins, so a refusal after
 * that point used to leave the run parked in its paused state with nothing
 * on screen saying why — the button could be pressed again and again and the
 * task would simply stay paused. Every refusal now ends as a sentence a
 * person can act on.
 */
export function describeUnstartedBatchReason(
  rawMessage: string | null,
): string {
  const message = rawMessage?.trim() ?? "";
  if (message.includes("activity is paused") || message.includes("work is paused")) {
    return "Job Finder did not start these jobs because all work is paused. Press Continue on Home, then try again.";
  }
  if (message.includes("already being prepared")) {
    return "Job Finder did not start these jobs because one of them is already being prepared. Wait for that one to finish, then try again.";
  }
  if (message.includes("already executing")) {
    return "Job Finder did not start these jobs because another batch is already running. Wait for it to finish, then try again.";
  }
  return "Job Finder could not start preparing these jobs, so nothing was opened or filled. Try again, and if it keeps happening prepare one job at a time.";
}

/** The action a batch summary offers for the jobs that still need preparing. */
export function describeRemainingBatchPreparation(
  remainingCount: number,
): string {
  return remainingCount === 1
    ? "Prepare the remaining job"
    : `Prepare the remaining ${remainingCount}`;
}

// Result states that claim a live browser flow. A row in one of these states
// whose parent run was already terminalized by a prior partial recovery pass
// is an orphan: no process owns it and nothing else will ever advance it.
export function isInterruptedApplyJobState(
  state: ApplyJobResult["state"],
): boolean {
  return (
    state === "planned" ||
    state === "question_capture" ||
    state === "filling" ||
    state === "submitting"
  );
}

export function isRecoveryTerminalizedApplyRun(run: ApplyRun): boolean {
  return (
    run.state === "failed" && run.summary === INTERRUPTED_APPLY_RUN_SUMMARY
  );
}

export function groupApplyJobResultsByRunId(
  results: readonly ApplyJobResult[],
): Map<string, ApplyJobResult[]> {
  const resultsByRunId = new Map<string, ApplyJobResult[]>();
  for (const result of results) {
    const bucket = resultsByRunId.get(result.runId);
    if (bucket) {
      bucket.push(result);
    } else {
      resultsByRunId.set(result.runId, [result]);
    }
  }
  return resultsByRunId;
}

// Summary stamped onto runs terminalized by interruption recovery. It doubles
// as the deterministic provenance marker for the startup orphan sweep: only
// runs this recovery itself terminalized (or a prior partial pass terminalized
// before crashing) may have their stranded rows swept. User-cancelled and
// completed runs own their parked results and counters by design and stay
// untouched.
export const INTERRUPTED_APPLY_RUN_SUMMARY =
  "Automatic apply stopped because the app closed.";

export function recoverInterruptedApplyRun(
  run: ApplyRun,
  completedAt: string,
  // Results scoped to this run. They let the terminalized run recompute its
  // queue counters from truthful post-recovery result states instead of
  // retaining stale in-flight counts forever.
  runResults: readonly ApplyJobResult[] = [],
): ApplyRun {
  if (run.state !== "running") {
    return run;
  }

  return ApplyRunSchema.parse({
    ...run,
    state: "failed",
    updatedAt: completedAt,
    completedAt,
    summary: INTERRUPTED_APPLY_RUN_SUMMARY,
    detail:
      "The app closed before safe application preparation finished. No final submit action was taken, and any preparation saved before the interruption remains available for review.",
    ...deriveRecoveredApplyRunCounters(runResults, completedAt),
  });
}

/**
 * Recomputes queue counters on a run a prior partial recovery pass already
 * terminalized, without touching its state, copy, or completion timestamp.
 * Old recovery versions committed the failed run before its results could be
 * swept, so surviving damaged runs can retain stale running-time counters
 * forever; this restores counter truth while every other field stays exactly
 * as the prior pass wrote it. Returns null when the run does not qualify or
 * the counters are already truthful (steady-state no-op).
 */
export function refreshTerminalizedApplyRunCounters(
  run: ApplyRun,
  runResults: readonly ApplyJobResult[],
  completedAt: string,
): ApplyRun | null {
  if (run.state !== "failed" || run.summary !== INTERRUPTED_APPLY_RUN_SUMMARY) {
    return null;
  }

  const counters = deriveRecoveredApplyRunCounters(runResults, completedAt);
  if (
    run.pendingJobs === counters.pendingJobs &&
    run.submittedJobs === counters.submittedJobs &&
    run.skippedJobs === counters.skippedJobs &&
    run.blockedJobs === counters.blockedJobs &&
    run.failedJobs === counters.failedJobs
  ) {
    return null;
  }

  return ApplyRunSchema.parse({
    ...run,
    updatedAt: completedAt,
    ...counters,
  });
}

/**
 * Truthful queue counters for a terminalized interrupted run. Every result is
 * projected through the same recovery the rows themselves receive, so the
 * counters describe the run's durable end state exactly: interrupted
 * in-flight rows count as failed, preserved awaiting_review checkpoints stay
 * the only outstanding (user-owned) work, and total/submitted/skipped/
 * blocked/failed semantics are unchanged. Without this, a terminalized run
 * would keep its stale running-time `pendingJobs` forever and every derived
 * dashboard queue size (campaign progress `remainingQueueSize`) would stay
 * inflated long after the process died.
 */
export function deriveRecoveredApplyRunCounters(
  runResults: readonly ApplyJobResult[],
  completedAt: string,
): Pick<
  ApplyRun,
  "pendingJobs" | "submittedJobs" | "skippedJobs" | "blockedJobs" | "failedJobs"
> {
  let pendingJobs = 0;
  let submittedJobs = 0;
  let skippedJobs = 0;
  let blockedJobs = 0;
  let failedJobs = 0;
  for (const result of runResults) {
    const state =
      recoverInterruptedApplyJobResult(result, completedAt)?.state ??
      result.state;
    if (state === "awaiting_review") {
      pendingJobs += 1;
    } else if (state === "submitted") {
      submittedJobs += 1;
    } else if (state === "skipped") {
      skippedJobs += 1;
    } else if (state === "blocked") {
      blockedJobs += 1;
    } else if (state === "failed") {
      failedJobs += 1;
    }
  }
  return { pendingJobs, submittedJobs, skippedJobs, blockedJobs, failedJobs };
}

export function recoverInterruptedApplyJobResult(
  result: ApplyJobResult,
  completedAt: string,
): ApplyJobResult | null {
  // An interrupted planned result must never linger as phantom in-flight work
  // forever. The durable begun mark commits before the browser flow starts and
  // the next durable transition only lands after that flow reaches its review
  // checkpoint, so a crash or close in between durably leaves a begun row in
  // planned. Recovery therefore terminalizes every interrupted planned row;
  // rows whose preparation began keep their mark so the daily-capacity slot
  // they consumed still counts, while never-begun rows normalize to nulls.
  //
  // Absent marks count as never-begun: legacy rows predate these fields and
  // the migration intentionally leaves them out of the persisted document, so
  // only paired string values prove preparation began. Recovery rewrites
  // absent marks as explicit nulls so downstream begun-capacity accounting
  // never mistakes a terminalized orphan for uncertain legacy evidence.
  const hasPairedBegunPreparationMark =
    typeof result.applicationPreparationStartedAt === "string" &&
    typeof result.applicationPreparationStartedLocalDate === "string";
  // `awaiting_review` is a truthful user-owned checkpoint: the run may have
  // been interrupted, but this job finished preparation and is waiting for
  // human review, so it keeps its state. Terminal rows (submitted, skipped,
  // blocked, failed) already tell the truth and stay untouched. Everything
  // else (planned, question_capture, filling, submitting) is in-flight work
  // that no longer owns a running process and would otherwise linger as a
  // phantom "Filling"/"In progress"/"Submitting" claim after reopen.
  if (!isInterruptedApplyJobState(result.state)) {
    return null;
  }

  if (result.state !== "planned") {
    return ApplyJobResultSchema.parse({
      ...result,
      state: "failed",
      updatedAt: completedAt,
      completedAt,
      summary: "Application preparation stopped when the app closed.",
      detail:
        "The app closed while this job's application preparation was underway, so it never reached its review checkpoint. No final submit action occurred.",
    });
  }

  return ApplyJobResultSchema.parse({
    ...result,
    applicationPreparationStartedAt: hasPairedBegunPreparationMark
      ? result.applicationPreparationStartedAt
      : null,
    applicationPreparationStartedLocalDate: hasPairedBegunPreparationMark
      ? result.applicationPreparationStartedLocalDate
      : null,
    state: "failed",
    updatedAt: completedAt,
    completedAt,
    summary: hasPairedBegunPreparationMark
      ? "Application preparation stopped before review."
      : "Application preparation stopped before it began.",
    detail: hasPairedBegunPreparationMark
      ? "The app closed while this job's application preparation was underway, so it never reached its review checkpoint. No final submit action occurred."
      : "The app closed before this queued job's preparation began, so no browser action was taken for this job. No final submit action occurred.",
  });
}

/**
 * The same terminalization for a run the person cancelled: an in-flight
 * result under a cancelled run is not "still filling", it stopped. Without
 * this the Applications screen kept showing "filling in the form (791 min)"
 * beside "run cancelled" for as long as the row existed.
 */
export function cancelInterruptedApplyJobResult(
  result: ApplyJobResult,
  cancelledAt: string,
): ApplyJobResult | null {
  if (!isInterruptedApplyJobState(result.state)) {
    return null;
  }
  const hasPairedBegunPreparationMark =
    typeof result.applicationPreparationStartedAt === "string" &&
    typeof result.applicationPreparationStartedLocalDate === "string";
  return ApplyJobResultSchema.parse({
    ...result,
    ...(result.state === "planned"
      ? {
          applicationPreparationStartedAt: hasPairedBegunPreparationMark
            ? result.applicationPreparationStartedAt
            : null,
          applicationPreparationStartedLocalDate: hasPairedBegunPreparationMark
            ? result.applicationPreparationStartedLocalDate
            : null,
        }
      : {}),
    state: "failed",
    updatedAt: cancelledAt,
    completedAt: cancelledAt,
    summary: "Application preparation was cancelled.",
    detail:
      "You cancelled the run before this job reached its review checkpoint. No final submit action occurred. Prepare it again when you want to continue.",
  });
}

const INTERRUPTED_ATTEMPT_SUMMARY = "Preparation stopped when the app closed.";
const INTERRUPTED_ATTEMPT_DETAIL =
  "The app closed while this application's preparation was underway. No final submit action occurred.";

export function recoverInterruptedApplyAttempt(
  attempt: ApplicationAttempt,
  completedAt: string,
): ApplicationAttempt | null {
  // Only an attempt that claims live execution can be stale after an
  // interrupted run. Paused attempts sit at truthful user-owned checkpoints
  // and are preserved exactly as recorded.
  if (attempt.state !== "in_progress") {
    return null;
  }

  return ApplicationAttemptSchema.parse({
    ...attempt,
    state: "failed",
    summary: INTERRUPTED_ATTEMPT_SUMMARY,
    detail: INTERRUPTED_ATTEMPT_DETAIL,
    updatedAt: completedAt,
    completedAt,
    nextActionLabel: "Retry preparation when you are ready.",
  });
}

export function recoverInterruptedApplicationRecord(input: {
  record: ApplicationRecord;
  completedAt: string;
  eventId: string;
}): ApplicationRecord | null {
  const { record } = input;
  if (record.lastAttemptState !== "in_progress") {
    return null;
  }

  return ApplicationRecordSchema.parse({
    ...record,
    lastActionLabel: INTERRUPTED_ATTEMPT_SUMMARY,
    nextActionLabel: "Retry preparation when you are ready.",
    lastUpdatedAt: input.completedAt,
    lastAttemptState: "failed",
    events: [
      ...record.events,
      {
        id: input.eventId,
        at: input.completedAt,
        title: "Preparation stopped because the app closed",
        detail:
          "The app closed before safe application preparation finished for this job. No final submit action occurred.",
        emphasis: "warning",
      },
    ],
  });
}

interface InterruptedProjectionRepository {
  listApplicationAttempts(options?: {
    jobId?: string;
    applicationRecordId?: string;
  }): Promise<readonly ApplicationAttempt[]>;
  upsertApplicationAttempt(
    applicationAttempt: ApplicationAttemptInput,
  ): Promise<void>;
  listApplicationRecords(): Promise<readonly ApplicationRecord[]>;
  upsertApplicationRecord(applicationRecord: ApplicationRecord): Promise<void>;
}

// Central interrupted-run projection for attempt and record surfaces. Only
// records reached through exact applicationRecordId lineage from a
// terminalized result are touched; legacy null-lineage rows stay fail-closed
// and are never attributed here. Paused rows at user-owned checkpoints and
// every already-terminal row are preserved exactly as persisted.
export async function recoverInterruptedExactLineageProjections(input: {
  repository: InterruptedProjectionRepository;
  interruptedRecordIds: ReadonlySet<string>;
  completedAt: string;
  eventIdFor: (applicationRecordId: string) => string;
}): Promise<void> {
  if (input.interruptedRecordIds.size === 0) {
    return;
  }

  const [attempts, records] = await Promise.all([
    input.repository.listApplicationAttempts(),
    input.repository.listApplicationRecords(),
  ]);

  await Promise.all([
    ...attempts
      .filter(
        (attempt) =>
          attempt.applicationRecordId !== null &&
          input.interruptedRecordIds.has(attempt.applicationRecordId),
      )
      .map((attempt) => {
        const recoveredAttempt = recoverInterruptedApplyAttempt(
          attempt,
          input.completedAt,
        );
        return recoveredAttempt
          ? input.repository.upsertApplicationAttempt(recoveredAttempt)
          : Promise.resolve();
      }),
    ...records.map((record) => {
      if (!input.interruptedRecordIds.has(record.id)) {
        return Promise.resolve();
      }
      const recoveredRecord = recoverInterruptedApplicationRecord({
        record,
        completedAt: input.completedAt,
        eventId: input.eventIdFor(record.id),
      });
      return recoveredRecord
        ? input.repository.upsertApplicationRecord(recoveredRecord)
        : Promise.resolve();
    }),
  ]);
}
