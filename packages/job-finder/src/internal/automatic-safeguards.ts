import {
  ApplyJobResultSchema,
  ApplyRunSchema,
  DiscoveryRunRecordSchema,
  JobFinderIntelligenceStateSchema,
  SourceDebugRunRecordSchema,
  SourceDebugWorkerAttemptSchema,
  type ApplyJobResult,
  type ApplyRun,
  type DiscoveryRunRecord,
  type JobSearchCampaign,
  type SavedJob,
  type SourceDebugRunRecord,
  type SourceDebugWorkerAttempt,
} from "@nestor/contracts";

import {
  deriveCampaignNotifications,
  mergeCampaignNotifications,
  type CampaignWorkFailureEvidence,
} from "./campaign-digest-notifications";
import {
  recordAbnormalFailureEvidence,
  recordListingSignal,
  type FailureAttemptEvidence,
  type ListingSignalInput,
} from "./safeguard-operations";
import type { WorkspaceServiceContext } from "./workspace-service-context";

/** The replay window used for automatically-derived source/discovery pauses. */
export const AUTOMATIC_FAILURE_WINDOW_DAYS = 7;

/** Stable pause id prefixes; campaign ids are appended to keep policies scoped. */
import {
  AUTOMATIC_SOURCE_DEBUG_FAILURE_PAUSE_ID,
} from "../plan-safeguard-pauses";
export {
  AUTOMATIC_DISCOVERY_FAILURE_PAUSE_ID,
  AUTOMATIC_SOURCE_DEBUG_FAILURE_PAUSE_ID,
  AUTOMATIC_APPLICATION_FAILURE_PAUSE_ID,
} from "../plan-safeguard-pauses";

const USER_OWNED_BLOCKER_PATTERN =
  /\b(?:log\s*in|login|sign\s*in|signup|sign\s*up|consent|captcha|re[- ]?captcha|mfa|two[- ]factor|manual(?:ly)?|human(?:\s+verification)?|credential|password|account\s+creation|create\s+an?\s+account|email\s+verification)\b/i;

/**
 * Returns true only for explicit user-owned access/manual blockers. These
 * facts may notify a campaign, but they must never be counted as technical
 * failures in the automatic abnormal-failure safeguard.
 */
export function isUserOwnedBlockerEvidence(
  value: string | null | undefined,
): boolean {
  return typeof value === "string" && USER_OWNED_BLOCKER_PATTERN.test(value);
}

function firstNonEmpty(
  ...values: readonly (string | null | undefined)[]
): string | null {
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function parseDiscoveryRun(run: unknown): DiscoveryRunRecord | null {
  // Repository display rows are validated and deeply frozen when read.
  if (
    typeof run === "object" &&
    run !== null &&
    Object.isFrozen(run) &&
    Object.isFrozen((run as Partial<DiscoveryRunRecord>).targetExecutions)
  )
    return run as DiscoveryRunRecord;
  const parsed = DiscoveryRunRecordSchema.safeParse(run);
  return parsed.success ? parsed.data : null;
}

function parseSourceDebugRun(run: unknown): SourceDebugRunRecord | null {
  const parsed = SourceDebugRunRecordSchema.safeParse(run);
  return parsed.success ? parsed.data : null;
}

function earliestTimestamp(
  evidence: readonly FailureAttemptEvidence[],
  fallback: string,
): string {
  return (
    [...evidence].sort(
      (left, right) =>
        Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
        left.occurredAt.localeCompare(right.occurredAt) ||
        left.attemptId.localeCompare(right.attemptId),
    )[0]?.occurredAt ?? fallback
  );
}

/**
 * Derives discovery target attempts from durable run evidence. Failed target
 * executions with an explicit login/consent/manual warning are excluded from
 * the technical-failure sample; successful target executions remain the
 * denominator. User cancellation is also excluded because it is not a
 * system failure.
 */
export function deriveDiscoveryFailureEvidence(
  runs: readonly unknown[],
): FailureAttemptEvidence[] {
  const evidence: FailureAttemptEvidence[] = [];

  for (const rawRun of runs) {
    const run = parseDiscoveryRun(rawRun);
    if (!run || run.state === "idle" || run.state === "running") continue;

    let failedTargetCount = 0;
    for (const execution of run.targetExecutions) {
      if (execution.state === "cancelled" || execution.state === "skipped") {
        continue;
      }

      const reason = execution.warning ?? null;
      if (execution.state === "failed" && isUserOwnedBlockerEvidence(reason)) {
        continue;
      }

      if (execution.state === "failed") failedTargetCount += 1;

      evidence.push({
        attemptId: `discovery:${run.id}:${execution.targetId}`,
        failed: execution.state === "failed",
        occurredAt: execution.completedAt ?? run.completedAt ?? run.startedAt,
      });
    }

    // A failed run can have no target execution when setup failed before a
    // target was started. Keep that objective failure visible rather than
    // silently treating the run as an empty sample.
    const hasUserOwnedFailure = run.targetExecutions.some(
      (execution) =>
        execution.state === "failed" &&
        isUserOwnedBlockerEvidence(execution.warning),
    );
    if (
      run.state === "failed" &&
      failedTargetCount === 0 &&
      !hasUserOwnedFailure &&
      !run.summary.warnings.some((warning) =>
        isUserOwnedBlockerEvidence(warning),
      )
    ) {
      evidence.push({
        attemptId: `discovery:${run.id}:run`,
        failed: true,
        occurredAt: run.completedAt ?? run.startedAt,
      });
    }
  }

  return evidence;
}

/**
 * How many whole search runs in a row must fail before a plan pauses itself.
 *
 * A pause stops the person's searches, so it has to mean the plan is broken
 * rather than that a source had a bad afternoon. One source returning an
 * error while the others bring back jobs is not a broken plan: it is one
 * source needing attention, which is where it is reported.
 */
export const AUTOMATIC_DISCOVERY_CONSECUTIVE_FAILED_RUNS = 3;

/** True when this run brought back nothing because everything in it failed. */
function runFailedOutright(run: DiscoveryRunRecord): boolean {
  const attempted = run.targetExecutions.filter(
    (execution) =>
      execution.state !== "cancelled" && execution.state !== "skipped",
  );
  if (attempted.some((execution) => execution.state === "completed")) {
    return false;
  }
  // Sign-in, consent and other things only the person can do are never
  // counted as the plan failing.
  if (
    attempted.some(
      (execution) =>
        execution.state === "failed" &&
        isUserOwnedBlockerEvidence(execution.warning),
    ) ||
    run.summary.warnings.some((warning) => isUserOwnedBlockerEvidence(warning))
  ) {
    return false;
  }
  if (attempted.length > 0) {
    return attempted.every((execution) => execution.state === "failed");
  }
  return run.state !== "completed";
}

/**
 * The run-level evidence behind a plan's automatic pause.
 *
 * Only the unbroken run of failures at the end of the history counts: one
 * successful run clears it. Counting individual source attempts instead is
 * what made two failed source checks out of five look like a broken plan.
 */
export function deriveDiscoveryRunFailureEvidence(
  runs: readonly DiscoveryRunRecord[],
): FailureAttemptEvidence[] {
  const terminal = runs
    .filter(
      (run) =>
        run.state !== "idle" &&
        run.state !== "running" &&
        run.state !== "cancelled",
    )
    .sort(
      (left, right) =>
        Date.parse(left.completedAt ?? left.startedAt) -
          Date.parse(right.completedAt ?? right.startedAt) ||
        left.id.localeCompare(right.id),
    );

  const streak: DiscoveryRunRecord[] = [];
  for (let index = terminal.length - 1; index >= 0; index -= 1) {
    const run = terminal[index];
    if (!run || !runFailedOutright(run)) break;
    streak.unshift(run);
  }

  return streak.map((run) => ({
    attemptId: `discovery_run:${run.id}`,
    failed: true,
    occurredAt: run.completedAt ?? run.startedAt,
  }));
}

function sourceAttemptIsUserOwned(attempt: SourceDebugWorkerAttempt): boolean {
  return (
    attempt.outcome === "blocked_auth" ||
    attempt.outcome === "blocked_manual_step" ||
    attempt.outcome === "blocked_site_protection" ||
    isUserOwnedBlockerEvidence(attempt.blockerSummary) ||
    isUserOwnedBlockerEvidence(attempt.completionReason) ||
    isUserOwnedBlockerEvidence(attempt.resultSummary)
  );
}

function sourceAttemptIsTechnicalFailure(
  attempt: SourceDebugWorkerAttempt,
): boolean {
  return (
    attempt.outcome === "failed_runtime" ||
    attempt.outcome === "exhausted_no_progress" ||
    attempt.outcome === "exhausted_duplicate_paths" ||
    attempt.outcome === "unsupported_layout"
  );
}

/**
 * Derives source-debug attempts from persisted run/attempt records. Explicit
 * user-owned blockers are omitted from the technical sample. A partial or
 * successful attempt is a non-failure denominator entry; runtime/exhaustion
 * outcomes are failures.
 */
export function deriveSourceDebugFailureEvidence(input: {
  runs: readonly unknown[];
  attempts: readonly unknown[];
}): FailureAttemptEvidence[] {
  const attemptsByRun = new Map<string, SourceDebugWorkerAttempt[]>();
  for (const rawAttempt of input.attempts) {
    const parsed = SourceDebugWorkerAttemptSchema.safeParse(rawAttempt);
    if (!parsed.success) continue;
    const attempt = parsed.data;
    const entries = attemptsByRun.get(attempt.runId) ?? [];
    entries.push(attempt);
    attemptsByRun.set(attempt.runId, entries);
  }

  const evidence: FailureAttemptEvidence[] = [];
  for (const rawRun of input.runs) {
    const run = parseSourceDebugRun(rawRun);
    if (!run || run.state === "idle" || run.state === "running") continue;
    if (run.state === "cancelled" || run.state === "paused_manual") continue;

    const attempts = (attemptsByRun.get(run.id) ?? []).filter((attempt) =>
      run.attemptIds.includes(attempt.id),
    );
    for (const attempt of attempts) {
      if (sourceAttemptIsUserOwned(attempt)) continue;
      evidence.push({
        attemptId: `source-debug:${attempt.id}`,
        failed: sourceAttemptIsTechnicalFailure(attempt),
        occurredAt: attempt.completedAt ?? run.completedAt ?? attempt.startedAt,
      });
    }

    if (
      attempts.length === 0 &&
      run.state !== "completed" &&
      !isUserOwnedBlockerEvidence(run.finalSummary)
    ) {
      evidence.push({
        attemptId: `source-debug:${run.id}:run`,
        failed: true,
        occurredAt: run.completedAt ?? run.updatedAt,
      });
    }
  }

  return evidence;
}

function sourceDebugNotificationEvidence(
  run: SourceDebugRunRecord,
): { outcome: "blocked" | "failed"; reason: string } | null {
  if (
    run.state === "cancelled" ||
    run.state === "idle" ||
    run.state === "running"
  ) {
    return null;
  }

  const reason =
    firstNonEmpty(
      run.finalSummary,
      run.manualPrerequisiteSummary,
      "Source check did not complete.",
    ) ?? "Source check did not complete.";

  if (run.state === "paused_manual" || isUserOwnedBlockerEvidence(reason)) {
    return { outcome: "blocked", reason };
  }

  if (run.state === "failed" || run.state === "interrupted") {
    return { outcome: "failed", reason };
  }

  return null;
}

/** Derives one stable campaign-work item for a terminal source-debug run. */
export function deriveSourceDebugCampaignWork(rawRun: unknown): {
  blockedWork: CampaignWorkFailureEvidence[];
  failedWork: CampaignWorkFailureEvidence[];
} {
  const run = parseSourceDebugRun(rawRun);
  if (!run) return { blockedWork: [], failedWork: [] };

  const notification = sourceDebugNotificationEvidence(run);
  if (!notification) return { blockedWork: [], failedWork: [] };

  const work: CampaignWorkFailureEvidence = {
    workId: `source_debug_${run.id}`,
    sourceTargetId: run.targetId,
    title: `Source check: ${run.targetLabel}`,
    reason: notification.reason,
  };
  return notification.outcome === "blocked"
    ? { blockedWork: [work], failedWork: [] }
    : { blockedWork: [], failedWork: [work] };
}

async function persistAutomaticFailurePause(input: {
  ctx: Pick<
    WorkspaceServiceContext,
    "repository" | "withIntelligenceTransition"
  >;
  campaign: JobSearchCampaign;
  pauseId: string;
  evidence: readonly FailureAttemptEvidence[];
  /** Overrides the plan's own rule when a safeguard sets its own floor. */
  minimumSample?: number;
  failureRateThresholdPercent?: number;
  workKind?: "application";
  now: string;
}): Promise<void> {
  if (typeof input.ctx.withIntelligenceTransition !== "function") return;

  await input.ctx.withIntelligenceTransition(async () => {
    const state = await input.ctx.repository.getIntelligenceState();
    const existing = state.safeguards.abnormalFailurePauses.find(
      (pause) => pause.id === input.pauseId,
    );
    // No evidence and nothing recorded is nothing to say. No evidence with a
    // pause already standing still has to run, so the pause can lift.
    if (input.evidence.length === 0 && !existing) return;
    const result = recordAbnormalFailureEvidence({
      safeguards: state.safeguards,
      pauseId: input.pauseId,
      windowStartedAt:
        existing?.windowStartedAt ??
        earliestTimestamp(input.evidence, input.now),
      evidence: input.evidence,
      now: input.now,
      config: {
        windowDays: AUTOMATIC_FAILURE_WINDOW_DAYS,
        failureRateThresholdPercent:
          input.failureRateThresholdPercent ??
          input.campaign.stopRules.pauseOnFailureRatePercent,
        minimumSample:
          input.minimumSample ??
          input.campaign.stopRules.failureRateMinimumSample,
        explanation:
          input.workKind === "application"
            ? "Too many application attempts failed, so this search plan paused further application preparation."
            : "Too many searches or source checks failed in a row, so this search plan paused itself.",
        recoveryGuidance:
          input.workKind === "application"
            ? "Open Applications to review the failed attempts, resolve the cause, then retry."
            : "Open Search history to see which source failed and why. Fix or disable that source, then retry.",
      },
    });
    if (!result.ok) return;

    if (existing && JSON.stringify(existing) === JSON.stringify(result.pause)) {
      return;
    }

    await input.ctx.repository.saveIntelligenceState(
      JobFinderIntelligenceStateSchema.parse({
        ...state,
        safeguards: result.safeguards,
        updatedAt: input.now,
      }),
    );
  });
}

/** Re-derives a campaign's automatic source-debug pause from durable history. */
export async function persistAutomaticSourceDebugSafeguard(input: {
  ctx: WorkspaceServiceContext;
  campaign: JobSearchCampaign;
  targetIds: readonly string[];
  now: string;
}): Promise<void> {
  const targetIdSet = new Set(input.targetIds);
  if (targetIdSet.size === 0) return;
  const [runs, attempts] = await Promise.all([
    input.ctx.repository.listSourceDebugRuns(),
    input.ctx.repository.listSourceDebugAttempts(),
  ]);
  await persistAutomaticFailurePause({
    ctx: input.ctx,
    campaign: input.campaign,
    pauseId: `${AUTOMATIC_SOURCE_DEBUG_FAILURE_PAUSE_ID}:${input.campaign.id}`,
    evidence: deriveSourceDebugFailureEvidence({
      runs: runs.filter((run) => targetIdSet.has(run.targetId)),
      attempts,
    }),
    now: input.now,
  });
}

/**
 * Persists terminal source-debug notifications for every campaign that owns
 * the affected source target. Existing notifications win, so read state is
 * preserved and repeated workflow/restart calls are idempotent.
 */
export async function persistSourceDebugCampaignNotifications(
  ctx: WorkspaceServiceContext,
  rawRun: unknown,
): Promise<void> {
  const run = parseSourceDebugRun(rawRun);
  if (!run) return;
  const work = deriveSourceDebugCampaignWork(run);
  if (work.blockedWork.length === 0 && work.failedWork.length === 0) return;

  if (typeof ctx.withCampaignTransition !== "function") return;

  await ctx.withCampaignTransition(async () => {
    const state = await ctx.repository.getCampaignState();
    if (!state) return;

    const now = run.completedAt ?? run.updatedAt;
    // Notifications are global to the campaign collection, so merge once per
    // relevant campaign while preserving the existing state and read flags.
    let notifications = state.notifications;
    for (const campaign of state.campaigns) {
      if (!campaign.sourceTargetIds.includes(run.targetId)) continue;
      notifications = mergeCampaignNotifications({
        existing: notifications,
        incoming: deriveCampaignNotifications({
          campaignId: campaign.id,
          now,
          blockedWork: work.blockedWork,
          failedWork: work.failedWork,
        }),
      });
    }
    if (JSON.stringify(notifications) === JSON.stringify(state.notifications))
      return;
    await ctx.repository.saveCampaignState({
      ...state,
      notifications,
    });
  });
}

/** Returns the latest typed source-debug run for a target from persisted state. */
export function selectLatestSourceDebugRun(
  runs: readonly unknown[],
  targetId: string,
): SourceDebugRunRecord | null {
  return (
    runs
      .map(parseSourceDebugRun)
      .filter((run): run is SourceDebugRunRecord => run !== null)
      .filter((run) => run.targetId === targetId)
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
          right.id.localeCompare(left.id),
      )[0] ?? null
  );
}

const APPLICATION_USER_OWNED_BLOCKER_REASONS = new Set([
  "resume_missing",
  "resume_stale",
  "auth_required",
  "signup_consent_required",
  "site_protection",
  "required_human_input",
  "asset_unavailable",
  "provider_submit_auth_unavailable",
]);

function parseApplyRun(run: unknown): ApplyRun | null {
  const parsed = ApplyRunSchema.safeParse(run);
  return parsed.success ? parsed.data : null;
}

function parseApplyJobResult(result: unknown): ApplyJobResult | null {
  const parsed = ApplyJobResultSchema.safeParse(result);
  return parsed.success ? parsed.data : null;
}

function applicationResultIsUserOwnedBlocker(result: ApplyJobResult): boolean {
  return (
    (result.blockerReason !== null &&
      APPLICATION_USER_OWNED_BLOCKER_REASONS.has(result.blockerReason)) ||
    isUserOwnedBlockerEvidence(result.blockerSummary) ||
    isUserOwnedBlockerEvidence(result.summary) ||
    isUserOwnedBlockerEvidence(result.detail)
  );
}

/**
 * Returns only explicit provider/browser listing evidence from terminal
 * application results. A result's job id must match the evidence job id; a
 * malformed or non-terminal result is ignored rather than guessed.
 */
export function deriveApplicationListingSignals(
  results: readonly unknown[],
): ListingSignalInput[] {
  const signals: ListingSignalInput[] = [];

  for (const rawResult of results) {
    const result = parseApplyJobResult(rawResult);
    if (!result || result.completedAt === null) continue;
    const evidence = result.listingSignalEvidence;
    if (!evidence || evidence.jobId !== result.jobId) continue;

    signals.push({
      id: `automatic_listing_signal:${evidence.evidenceId}`,
      jobId: evidence.jobId,
      signal: evidence.signal,
      detail: evidence.detail,
      detectedAt: evidence.detectedAt,
      confidence: evidence.confidence,
      provenance: evidence.provenance,
      explanation: evidence.explanation,
      recoveryGuidance: evidence.recoveryGuidance,
    });
  }

  return signals;
}

/**
 * A failed/blocked result is notification-worthy only while its persisted
 * apply run is still active. This guards the cancellation race between
 * writing a result and deriving campaign notifications.
 */
export function shouldPersistApplicationFailureNotification(input: {
  result: ApplyJobResult;
  run: ApplyRun | null;
}): boolean {
  return (
    input.run?.state !== "cancelled" &&
    (input.result.state === "blocked" || input.result.state === "failed")
  );
}

function resultNotificationWork(input: {
  result: ApplyJobResult;
  run: ApplyRun | null;
  job?: SavedJob | null | undefined;
}): {
  outcome: "blocked" | "failed";
  work: CampaignWorkFailureEvidence;
} | null {
  // Cancellation may win the race after the result is written but before
  // safeguard persistence runs. A cancelled queue is not failed work and
  // must not create a campaign notification.
  if (!shouldPersistApplicationFailureNotification(input)) return null;
  const blocked =
    input.result.state === "blocked" ||
    applicationResultIsUserOwnedBlocker(input.result);
  const title = input.job?.title ?? `Application for ${input.result.jobId}`;
  const reason =
    firstNonEmpty(
      input.result.blockerSummary,
      input.result.detail,
      input.result.summary,
    ) ?? "Application preparation did not complete.";
  return {
    outcome: blocked ? "blocked" : "failed",
    work: {
      workId: `apply_result_${input.result.id}`,
      jobId: input.result.jobId,
      title,
      reason,
    },
  };
}

function runNotificationWork(
  run: ApplyRun,
): { outcome: "blocked" | "failed"; work: CampaignWorkFailureEvidence } | null {
  if (run.state !== "failed") return null;
  const reason =
    firstNonEmpty(run.detail, run.summary) ??
    "Application run did not complete.";
  const blocked = isUserOwnedBlockerEvidence(reason);
  return {
    outcome: blocked ? "blocked" : "failed",
    work: {
      workId: `apply_run_${run.id}`,
      title: "Application run",
      reason,
    },
  };
}

async function persistAutomaticListingSignals(input: {
  ctx: WorkspaceServiceContext;
  results: readonly unknown[];
  now: string;
}): Promise<void> {
  const signals = deriveApplicationListingSignals(input.results);
  if (signals.length === 0) return;

  await input.ctx.withIntelligenceTransition(async () => {
    const state = await input.ctx.repository.getIntelligenceState();
    let nextSafeguards = state.safeguards;
    for (const signal of signals) {
      const result = recordListingSignal({
        safeguards: nextSafeguards,
        signal,
        now: input.now,
      });
      if (result.ok) {
        nextSafeguards = result.safeguards;
      }
    }

    if (JSON.stringify(nextSafeguards) === JSON.stringify(state.safeguards)) {
      return;
    }
    await input.ctx.repository.saveIntelligenceState(
      JobFinderIntelligenceStateSchema.parse({
        ...state,
        safeguards: nextSafeguards,
        updatedAt: input.now,
      }),
    );
  });
}

/** Applies cap/failure evidence and campaign notifications after terminal apply persistence. */
export async function persistAutomaticApplicationSafeguards(input: {
  ctx: WorkspaceServiceContext;
  run: unknown;
  result?: unknown;
  job?: SavedJob | null;
  now: string;
}): Promise<void> {
  const run = parseApplyRun(input.run);
  if (!run) return;
  const result =
    input.result === undefined ? null : parseApplyJobResult(input.result);
  const [runs, results] = await Promise.all([
    input.ctx.repository.listApplyRuns(),
    input.ctx.repository.listApplyJobResults(),
  ]);
  const typedRuns = runs
    .map(parseApplyRun)
    .filter((value): value is ApplyRun => value !== null);
  if (!typedRuns.some((entry) => entry.id === run.id)) {
    typedRuns.push(run);
  }
  const typedResults = results
    .map(parseApplyJobResult)
    .filter((value): value is ApplyJobResult => value !== null);
  if (result && !typedResults.some((entry) => entry.id === result.id)) {
    typedResults.push(result);
  }

  const campaignId = run.campaignId;
  await persistAutomaticListingSignals({
    ctx: input.ctx,
    results: typedResults,
    now: input.now,
  });

  if (!campaignId || typeof input.ctx.withCampaignTransition !== "function") {
    return;
  }
  const persistedRun = typedRuns.find((entry) => entry.id === run.id) ?? run;
  const resultWork = result
    ? resultNotificationWork({ result, run: persistedRun, job: input.job })
    : null;
  const runWork = runNotificationWork(persistedRun);
  if (!resultWork && !runWork) return;
  await input.ctx.withCampaignTransition(async () => {
    const state = await input.ctx.repository.getCampaignState();
    if (!state || !state.campaigns.some((entry) => entry.id === campaignId)) {
      return;
    }
    const blockedWork = [
      ...(resultWork?.outcome === "blocked" ? [resultWork.work] : []),
      ...(runWork?.outcome === "blocked" ? [runWork.work] : []),
    ];
    const failedWork = [
      ...(resultWork?.outcome === "failed" ? [resultWork.work] : []),
      ...(runWork?.outcome === "failed" ? [runWork.work] : []),
    ];
    const incoming = deriveCampaignNotifications({
      campaignId,
      now: input.now,
      blockedWork,
      failedWork,
    });
    const notifications = mergeCampaignNotifications({
      existing: state.notifications,
      incoming,
    });
    if (JSON.stringify(notifications) === JSON.stringify(state.notifications)) {
      return;
    }
    await input.ctx.repository.saveCampaignState({
      ...state,
      notifications,
    });
  });
}
