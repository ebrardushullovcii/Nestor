import { groupCompanyConflicts } from "./same-company-sends";
import { createHash } from "node:crypto";

import {
  ApplyJobResultSchema,
  ApplyRunSchema,
  ApplicationRecordSchema,
  DiscoveryRunRecordSchema,
  JobFinderIntelligenceStateSchema,
  SourceDebugRunRecordSchema,
  SourceDebugWorkerAttemptSchema,
  type ApplyJobResult,
  type ApplyRun,
  type ApplicationRecord,
  type DiscoveryRunRecord,
  type JobFinderIntelligenceState,
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
  applyCompanyApplicationEvidence,
  recordAbnormalFailureEvidence,
  recordListingSignal,
  recordSimultaneousApplicationConflict,
  type CompanyApplicationEvidence,
  type FailureAttemptEvidence,
  type ListingSignalInput,
} from "./safeguard-operations";
import type { WorkspaceServiceContext } from "./workspace-service-context";
import {
  PERSON_TOOK_OVER_SUMMARY,
  PREPARED_PAGE_CLOSED_SUMMARY,
  SITE_UNREACHABLE_SUMMARY,
} from "./workspace-application-user-action";

/** The replay window used for automatically-derived source/discovery pauses. */
export const AUTOMATIC_FAILURE_WINDOW_DAYS = 7;

/** Stable pause id prefixes; campaign ids are appended to keep policies scoped. */
import {
  AUTOMATIC_DISCOVERY_FAILURE_PAUSE_ID,
  AUTOMATIC_SOURCE_DEBUG_FAILURE_PAUSE_ID,
  AUTOMATIC_APPLICATION_FAILURE_PAUSE_ID,
} from "../plan-safeguard-pauses";
export {
  AUTOMATIC_DISCOVERY_FAILURE_PAUSE_ID,
  AUTOMATIC_SOURCE_DEBUG_FAILURE_PAUSE_ID,
  AUTOMATIC_APPLICATION_FAILURE_PAUSE_ID,
} from "../plan-safeguard-pauses";
/** Fallback conflict window for runs not attached to a campaign. */
export const AUTOMATIC_SIMULTANEOUS_APPLICATION_WINDOW_DAYS = 1;

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
  runs: readonly unknown[],
): FailureAttemptEvidence[] {
  const terminal = runs
    .map((run) => parseDiscoveryRun(run))
    .filter((run): run is DiscoveryRunRecord => run !== null)
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
  ctx: WorkspaceServiceContext;
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

/** Re-derives a campaign's automatic discovery pause from durable run history. */
export async function persistAutomaticDiscoverySafeguard(input: {
  ctx: WorkspaceServiceContext;
  campaign: JobSearchCampaign;
  now: string;
}): Promise<void> {
  const discovery = await input.ctx.repository.getDiscoveryState();
  const runs = discovery.recentRuns.filter(
    (run) => run.campaignId === input.campaign.id,
  );
  await persistAutomaticFailurePause({
    ctx: input.ctx,
    campaign: input.campaign,
    pauseId: `${AUTOMATIC_DISCOVERY_FAILURE_PAUSE_ID}:${input.campaign.id}`,
    // Whole runs, not single source attempts, and only the unbroken run of
    // failures at the end of the history.
    evidence: deriveDiscoveryRunFailureEvidence(runs),
    minimumSample: Math.max(
      AUTOMATIC_DISCOVERY_CONSECUTIVE_FAILED_RUNS,
      input.campaign.stopRules.failureRateMinimumSample,
    ),
    failureRateThresholdPercent: 100,
    now: input.now,
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

/** How a result cut short by the app closing starts its detail. */
const APP_CLOSED_DETAIL_PREFIX = "The app closed ";
/** A check taken over after a restart whose prepared page was gone. */
const RETRY_STOPPED_SAFELY_SUMMARY = "Application retry stopped safely";

/** Returns true only for a submitted result with a matching final-submit receipt. */
export function isVerifiedApplicationSubmission(
  result: ApplyJobResult,
  run?: ApplyRun | null,
): boolean {
  const receipt = result.privacyReceipt;
  return (
    result.state === "submitted" &&
    receipt !== null &&
    receipt.finalSubmitOccurred === true &&
    receipt.lineage.runId === result.runId &&
    receipt.lineage.jobId === result.jobId &&
    receipt.lineage.resultId === result.id &&
    (run === undefined || run === null || run.id === result.runId)
  );
}

/** Derives technical application failure samples from terminal result evidence. */
export function deriveApplicationFailureEvidence(input: {
  runs?: readonly unknown[];
  results: readonly unknown[];
  campaignId?: string | null;
}): FailureAttemptEvidence[] {
  const runsById = new Map<string, ApplyRun>();
  for (const rawRun of input.runs ?? []) {
    const run = parseApplyRun(rawRun);
    if (run) runsById.set(run.id, run);
  }

  // A job that was sent later is not a failure any more: the failure-rate
  // pause measured on its earlier attempt lifts once the retries went out.
  const lastSentAt = new Map<string, string>();
  for (const rawResult of input.results) {
    const result = parseApplyJobResult(rawResult);
    if (!result || result.state !== "submitted") continue;
    const at = result.completedAt ?? result.updatedAt;
    const previous = lastSentAt.get(result.jobId);
    if (!previous || previous < at) lastSentAt.set(result.jobId, at);
  }
  const evidence: FailureAttemptEvidence[] = [];
  for (const rawResult of input.results) {
    const result = parseApplyJobResult(rawResult);
    if (!result || result.completedAt === null) continue;
    // A failure rate needs the attempts that worked in its sample too;
    // counting only failures made every sample 100% failed, so a handful of
    // failures in the window paused applying however many had been sent.
    const succeeded =
      result.state === "submitted" ||
      (result.state === "awaiting_review" && !result.blockerReason);
    if (!succeeded && result.state !== "failed" && result.state !== "blocked") {
      continue;
    }
    if (!succeeded && applicationResultIsUserOwnedBlocker(result)) continue;
    // A filled form whose page closed on restart did not fail on the site.
    if (result.blockerSummary === PREPARED_PAGE_CLOSED_SUMMARY) continue;
    // Nor did an application the person stepped into.
    if (result.summary === PERSON_TOOK_OVER_SUMMARY) continue;
    // Nor a send the site refused before anything reached it.
    if (result.blockerSummary === SITE_UNREACHABLE_SUMMARY) continue;
    // Nor work the app closing cut short (its pages close with it): a person
    // restarting mid-batch paused all application work as "too many failed".
    if (
      result.detail.startsWith(APP_CLOSED_DETAIL_PREFIX) ||
      result.summary === RETRY_STOPPED_SAFELY_SUMMARY
    )
      continue;
    if (!succeeded) {
      const sentAt = lastSentAt.get(result.jobId);
      if (sentAt && sentAt >= (result.completedAt ?? result.updatedAt))
        continue;
    }

    const run = runsById.get(result.runId);
    if (
      input.campaignId !== undefined &&
      input.campaignId !== null &&
      run?.campaignId !== input.campaignId
    ) {
      continue;
    }
    if (run?.state === "cancelled") continue;
    evidence.push({
      attemptId: `apply:${result.id}`,
      failed: !succeeded,
      occurredAt: result.completedAt ?? result.updatedAt,
    });
  }
  return evidence;
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

type VerifiedApplicationRecordEvidence = {
  applicationRecordId: string;
  companyKey: string;
  companyName: string;
  appliedAt: string;
};

type AutomaticConflictInput = {
  conflictId: string;
  applicationRecordId: string;
  conflictingApplicationRecordId: string;
  explanation: string;
  recoveryGuidance: string;
};

function normalizeCompanyName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function resolveAutomaticCompanyKey(input: {
  record: ApplicationRecord;
  companies: JobFinderIntelligenceState["companies"];
}): string | null {
  const normalized = normalizeCompanyName(input.record.company);
  if (normalized.length === 0) return null;

  // An explicit entity wins only when exactly one entity owns this name. If
  // two entities claim the same normalized name, do not silently merge them.
  const entityMatches = input.companies.filter(
    (company) =>
      normalizeCompanyName(company.canonicalName) === normalized ||
      company.aliases.some(
        (alias) => normalizeCompanyName(alias.alias) === normalized,
      ),
  );
  if (entityMatches.length > 1) return null;
  if (entityMatches.length === 1) {
    return `entity:${entityMatches[0]!.id}`;
  }

  // No entity was persisted, so retain the exact normalized name as an
  // unowned key. This never joins it to a different explicit company entity.
  return `name:${normalized}`;
}

function deriveVerifiedApplicationRecordEvidence(input: {
  runs: readonly ApplyRun[];
  results: readonly ApplyJobResult[];
  records: readonly ApplicationRecord[];
  companies: JobFinderIntelligenceState["companies"];
}): VerifiedApplicationRecordEvidence[] {
  const runsById = new Map(input.runs.map((run) => [run.id, run]));
  const recordsByJob = new Map<string, ApplicationRecord[]>();
  for (const rawRecord of input.records) {
    const parsed = ApplicationRecordSchema.safeParse(rawRecord);
    if (!parsed.success) continue;
    const entries = recordsByJob.get(parsed.data.jobId) ?? [];
    entries.push(parsed.data);
    recordsByJob.set(parsed.data.jobId, entries);
  }

  // A result has no application-record id of its own. If a job has more than
  // one durable record, skip it rather than guessing which record was used.
  const byRecordId = new Map<string, VerifiedApplicationRecordEvidence>();
  for (const result of input.results) {
    const run = runsById.get(result.runId);
    if (!isVerifiedApplicationSubmission(result, run)) continue;
    const records = recordsByJob.get(result.jobId) ?? [];
    if (records.length !== 1) continue;
    const record = records[0]!;
    const companyKey = resolveAutomaticCompanyKey({
      record,
      companies: input.companies,
    });
    if (!companyKey) continue;
    const appliedAt = result.privacyReceipt?.generatedAt ?? result.updatedAt;
    const existing = byRecordId.get(record.id);
    if (
      !existing ||
      Date.parse(appliedAt) > Date.parse(existing.appliedAt) ||
      (Date.parse(appliedAt) === Date.parse(existing.appliedAt) &&
        appliedAt.localeCompare(existing.appliedAt) > 0)
    ) {
      byRecordId.set(record.id, {
        applicationRecordId: record.id,
        companyKey,
        companyName: record.company,
        appliedAt,
      });
    }
  }

  return [...byRecordId.values()];
}

/**
 * Finds stable unordered pairs of distinct durable application records for
 * one conservative company key inside the active time window.
 */
export function deriveSimultaneousApplicationConflicts(input: {
  runs: readonly unknown[];
  results: readonly unknown[];
  records: readonly unknown[];
  companies: JobFinderIntelligenceState["companies"];
  now: string;
  windowDays: number;
}): AutomaticConflictInput[] {
  const nowMillis = Date.parse(input.now);
  if (
    !Number.isFinite(nowMillis) ||
    !Number.isInteger(input.windowDays) ||
    input.windowDays < 1 ||
    input.windowDays > 365
  ) {
    return [];
  }

  const runs = input.runs
    .map(parseApplyRun)
    .filter((run): run is ApplyRun => run !== null);
  const results = input.results
    .map(parseApplyJobResult)
    .filter((result): result is ApplyJobResult => result !== null);
  const records = input.records
    .map((record) => ApplicationRecordSchema.safeParse(record))
    .filter(
      (result): result is { success: true; data: ApplicationRecord } =>
        result.success,
    )
    .map((result) => result.data);
  const evidence = deriveVerifiedApplicationRecordEvidence({
    runs,
    results,
    records,
    companies: input.companies,
  }).filter((entry) => {
    const appliedMillis = Date.parse(entry.appliedAt);
    return (
      Number.isFinite(appliedMillis) &&
      appliedMillis <= nowMillis &&
      appliedMillis >= nowMillis - input.windowDays * 86_400_000
    );
  });

  const byCompany = new Map<string, VerifiedApplicationRecordEvidence[]>();
  for (const entry of evidence) {
    const entries = byCompany.get(entry.companyKey) ?? [];
    entries.push(entry);
    byCompany.set(entry.companyKey, entries);
  }

  const conflicts: AutomaticConflictInput[] = [];
  for (const entries of byCompany.values()) {
    const ordered = [...entries].sort(
      (left, right) =>
        left.appliedAt.localeCompare(right.appliedAt) ||
        left.applicationRecordId.localeCompare(right.applicationRecordId),
    );
    if (ordered.length < 2) continue;
    const first = ordered[0]!;
    const second = ordered[1]!;
    const digest = createHash("sha256")
      .update(`${first.companyKey}\0${first.appliedAt}\0${input.windowDays}`)
      .digest("hex");
    conflicts.push({
      conflictId: `automatic_simultaneous_application:${digest}`,
      applicationRecordId: first.applicationRecordId,
      conflictingApplicationRecordId: second.applicationRecordId,
      explanation: `More than one verified application was sent to ${first.companyName} in the last ${input.windowDays} days. Those sends have already happened; future application work for this company needs your decision.`,
      recoveryGuidance:
        "Review the applications for this company, then resolve or dismiss this hold before starting more. Sent applications are not paused.",
    });
  }
  return conflicts;
}

function resolveCompanyId(input: {
  companyName: string;
  jobId: string;
  companies: JobFinderIntelligenceState["companies"];
}): string | null {
  const normalized = normalizeCompanyName(input.companyName);
  if (normalized.length === 0) return null;

  const matches = input.companies.filter(
    (company) =>
      company.jobIds.includes(input.jobId) ||
      normalizeCompanyName(company.canonicalName) === normalized ||
      company.aliases.some(
        (alias) => normalizeCompanyName(alias.alias) === normalized,
      ),
  );
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
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

async function persistApplicationCompanyCaps(input: {
  ctx: WorkspaceServiceContext;
  results: readonly ApplyJobResult[];
  now: string;
  fallbackJob?: SavedJob | null | undefined;
}): Promise<void> {
  const verifiedResults = input.results.filter((result) =>
    isVerifiedApplicationSubmission(result),
  );
  if (verifiedResults.length === 0) return;

  await input.ctx.withIntelligenceTransition(async () => {
    const [state, savedJobs, records] = await Promise.all([
      input.ctx.repository.getIntelligenceState(),
      input.ctx.repository.listSavedJobs(),
      input.ctx.repository.listApplicationRecords(),
    ]);
    const jobsById = new Map(savedJobs.map((job) => [job.id, job]));
    if (input.fallbackJob)
      jobsById.set(input.fallbackJob.id, input.fallbackJob);

    const evidenceByCompany = new Map<string, CompanyApplicationEvidence[]>();
    for (const result of verifiedResults) {
      const job = jobsById.get(result.jobId);
      const matchingRecords = records.filter(
        (entry) => entry.jobId === result.jobId,
      );
      // A result does not identify which application record was submitted.
      // Never guess from recency when a job has multiple durable records.
      if (matchingRecords.length !== 1) continue;
      const record = matchingRecords[0]!;
      const companyName = job?.company ?? record.company;
      const companyId = resolveCompanyId({
        companyName,
        jobId: result.jobId,
        companies: state.companies,
      });
      if (!companyId) continue;
      const entries = evidenceByCompany.get(companyId) ?? [];
      entries.push({
        applicationRecordId: record.id,
        companyId,
        appliedAt: result.privacyReceipt?.generatedAt ?? result.updatedAt,
      });
      evidenceByCompany.set(companyId, entries);
    }

    let nextSafeguards = state.safeguards;
    for (const cap of state.safeguards.companyApplicationCaps) {
      const evidence = evidenceByCompany.get(cap.companyId);
      if (!evidence || evidence.length === 0) continue;
      const refreshed = applyCompanyApplicationEvidence({
        safeguards: nextSafeguards,
        evidence,
        now: input.now,
        createCapId: () => cap.id,
        config: {
          companyId: cap.companyId,
          maxApplicationsPerWindow: cap.maxApplicationsPerWindow,
          windowDays: cap.windowDays,
          windowStartedAt: cap.windowStartedAt,
          explanation: cap.explanation,
          recoveryGuidance: cap.recoveryGuidance,
        },
      });
      if (refreshed.ok) nextSafeguards = refreshed.safeguards;
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

async function persistAutomaticSimultaneousConflicts(input: {
  ctx: WorkspaceServiceContext;
  runs: readonly unknown[];
  results: readonly unknown[];
  now: string;
  windowDays: number;
}): Promise<void> {
  const [state, records] = await Promise.all([
    input.ctx.repository.getIntelligenceState(),
    input.ctx.repository.listApplicationRecords(),
  ]);
  const conflicts = deriveSimultaneousApplicationConflicts({
    runs: input.runs,
    results: input.results,
    records,
    companies: state.companies,
    now: input.now,
    windowDays: input.windowDays,
  });
  if (conflicts.length === 0) return;

  await input.ctx.withIntelligenceTransition(async () => {
    const current = await input.ctx.repository.getIntelligenceState();
    let nextSafeguards = current.safeguards;
    for (const conflict of conflicts) {
      const result = recordSimultaneousApplicationConflict({
        safeguards: nextSafeguards,
        conflict,
        now: input.now,
      });
      if (result.ok) {
        nextSafeguards = result.safeguards;
      }
    }
    nextSafeguards = groupCompanyConflicts(
      { ...current, safeguards: nextSafeguards },
      records,
      await input.ctx.repository.listSavedJobs(),
    ).safeguards;
    if (JSON.stringify(nextSafeguards) === JSON.stringify(current.safeguards)) {
      return;
    }
    await input.ctx.repository.saveIntelligenceState(
      JobFinderIntelligenceStateSchema.parse({
        ...current,
        safeguards: nextSafeguards,
        updatedAt: input.now,
      }),
    );
  });
}

/**
 * Re-measures every standing application failure pause from the evidence on
 * record. A pause is otherwise only re-measured when a run ends, and a pause
 * stops runs from starting, so one measured on stale evidence could never
 * lift by itself.
 */
export async function refreshAutomaticApplicationFailurePauses(input: {
  ctx: WorkspaceServiceContext;
  now: string;
}): Promise<void> {
  const [intelligence, campaignState, runs, results] = await Promise.all([
    input.ctx.repository.getIntelligenceState(),
    input.ctx.repository.getCampaignState(),
    input.ctx.repository.listApplyRuns(),
    input.ctx.repository.listApplyJobResults(),
  ]);
  for (const campaign of campaignState?.campaigns ?? []) {
    const pauseId = `${AUTOMATIC_APPLICATION_FAILURE_PAUSE_ID}:${campaign.id}`;
    if (
      !intelligence.safeguards.abnormalFailurePauses.some(
        (pause) => pause.id === pauseId,
      )
    ) {
      continue;
    }
    await persistAutomaticFailurePause({
      ctx: input.ctx,
      campaign,
      pauseId,
      evidence: deriveApplicationFailureEvidence({
        runs,
        results,
        campaignId: campaign.id,
      }),
      workKind: "application",
      now: input.now,
    });
  }
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
  const campaignState = await input.ctx.repository.getCampaignState();
  const campaign = campaignId
    ? (campaignState?.campaigns.find((entry) => entry.id === campaignId) ??
      null)
    : null;
  if (campaign) {
    const evidence = deriveApplicationFailureEvidence({
      runs: typedRuns,
      results: typedResults,
      campaignId: campaign.id,
    });
    await persistAutomaticFailurePause({
      ctx: input.ctx,
      campaign,
      pauseId: `${AUTOMATIC_APPLICATION_FAILURE_PAUSE_ID}:${campaign.id}`,
      evidence,
      workKind: "application",
      now: input.now,
    });
  }

  await persistApplicationCompanyCaps({
    ctx: input.ctx,
    results: typedResults,
    now: input.now,
    fallbackJob: input.job,
  });

  await persistAutomaticListingSignals({
    ctx: input.ctx,
    results: typedResults,
    now: input.now,
  });
  await persistAutomaticSimultaneousConflicts({
    ctx: input.ctx,
    runs: typedRuns,
    results: typedResults,
    now: input.now,
    windowDays:
      campaign?.applicationPolicy.simultaneousApplicationWindowDays ??
      AUTOMATIC_SIMULTANEOUS_APPLICATION_WINDOW_DAYS,
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
