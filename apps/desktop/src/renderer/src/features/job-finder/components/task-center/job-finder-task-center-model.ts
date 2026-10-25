import type {
  ApplyRunSummary,
  JobFinderRendererWorkspaceSnapshot,
  ResumeImportProgressEvent,
  ResumeImportRun,
  SourceDebugRunRecord,
} from "@nestor/contracts";
import { classifyPausedApplyRun } from "../../lib/apply-run-pause-state";
import { applyRunJobNeedsPreparation } from "../../screens/applications/applications-detail-panel-helpers";
import { WAITING_FOR_BROWSER_TAB_SUMMARY } from "../../screens/applications/applications-recovery-state";
import { JOB_FINDER_ROUTE_PATHS } from "../../lib/job-finder-route-hrefs";
import { countApplicationLedgerEntries } from "../../lib/needs-you-count";

export type JobFinderTaskKind =
  | "source_check"
  | "resume_import"
  | "apply"
  | "safeguards";
export type JobFinderTaskStatus =
  | "active"
  | "stopping"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export interface JobFinderTaskCenterItem {
  id: string;
  kind: JobFinderTaskKind;
  title: string;
  status: JobFinderTaskStatus;
  stageLabel: string;
  sourceLabel: string;
  countLabel: string;
  historyEstimateLabel: string | null;
  canCancel: boolean;
  cancelKind: "apply" | null;
  resumeRoute: string | null;
  resumeActionLabel: string | null;
  applyRecoveryJobIds?: readonly string[];
  reviewRoute?: string | null;
  reviewActionLabel?: string | null;
  /** When the run last changed; a finished run older than a day is history. */
  updatedAt?: string | null;
}

export interface JobFinderTaskCenterModel {
  activeCount: number;
  pausedCount: number;
  items: readonly JobFinderTaskCenterItem[];
}

export interface BuildJobFinderTaskCenterModelInput {
  workspace: JobFinderRendererWorkspaceSnapshot;
  isResumeImportPending: boolean;
  resumeImportProgress?: ResumeImportProgressEvent | null | undefined;
  /** Injected by tests so the bounded Stop window is deterministic. */
  now?: number | undefined;
}

const resumeStageLabels: Record<ResumeImportProgressEvent["stage"], string> = {
  saving_file: "Saving selected file",
  reading_document: "Reading resume",
  building_profile: "Building profile suggestions",
  saving_results: "Saving review items",
};

function timestamp(value: string): number {
  return new Date(value).getTime();
}

function newestBy<T>(
  values: readonly T[],
  getTimestamp: (value: T) => string,
): T | null {
  return values.reduce<T | null>((latest, value) => {
    if (
      !latest ||
      timestamp(getTimestamp(value)) > timestamp(getTimestamp(latest))
    ) {
      return value;
    }

    return latest;
  }, null);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) {
    return null;
  }

  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? upper) + upper) / 2)
    : upper;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  if (seconds < 60) {
    return `about ${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0
    ? `about ${minutes}m`
    : `about ${minutes}m ${remainingSeconds}s`;
}

function historyEstimate(
  durations: readonly number[],
  singularLabel: string,
  pluralLabel: string,
  suffix = "",
): string | null {
  const typicalDuration = median(durations);
  if (typicalDuration === null) {
    return null;
  }

  const sampleLabel = durations.length === 1 ? singularLabel : pluralLabel;
  return `${formatDuration(typicalDuration)} from ${durations.length} ${sampleLabel}${suffix}`;
}

const sourceCheckStageLabels: Record<
  NonNullable<SourceDebugRunRecord["activePhase"]>,
  string
> = {
  access_auth_probe: "Checking access",
  site_structure_mapping: "Reading the site layout",
  search_filter_probe: "Checking search filters",
  job_detail_validation: "Checking job details",
  apply_path_validation: "Checking application links",
  replay_verification: "Confirming the saved instructions",
};

function buildSourceCheckTask(
  input: BuildJobFinderTaskCenterModelInput,
): JobFinderTaskCenterItem | null {
  const run =
    input.workspace.activeSourceDebugRun ??
    newestBy(
      input.workspace.recentSourceDebugRuns ?? [],
      (candidate) => candidate.updatedAt,
    );
  if (!run) return null;

  const status: JobFinderTaskStatus =
    run.state === "running"
      ? "active"
      : run.state === "paused_manual"
        ? "paused"
        : run.state === "completed"
          ? "completed"
          : run.state === "cancelled"
            ? "cancelled"
            : run.state === "failed"
              ? "failed"
              : "interrupted";
  // A check that stopped on its own is the app's to retry, not a chore for
  // the person (ADR 0051); only a check paused on them stays in Activity.
  if (status === "failed" || status === "interrupted") return null;
  const canResume = status === "paused";

  return {
    id: run.id,
    kind: "source_check",
    title: "Source check",
    status,
    stageLabel: run.activePhase
      ? sourceCheckStageLabels[run.activePhase]
      : status === "completed"
        ? "Check completed"
        : status === "cancelled"
          ? "Check stopped"
          : "Waiting for you",
    sourceLabel: run.targetLabel,
    countLabel: `${run.phaseSummaries?.length ?? 0} checks finished`,
    historyEstimateLabel: null,
    canCancel: false,
    cancelKind: null,
    resumeRoute: canResume ? JOB_FINDER_ROUTE_PATHS.profileSources : null,
    resumeActionLabel: canResume ? "Open job sources" : null,
    updatedAt: run.updatedAt,
  };
}

function isCompletedResumeRun(run: ResumeImportRun): boolean {
  return run.status === "review_ready" || run.status === "applied";
}

function resumeStatus(
  run: ResumeImportRun | null,
  isPending: boolean,
): JobFinderTaskStatus {
  if (isPending) {
    return "active";
  }

  if (!run) {
    return "interrupted";
  }

  if (isCompletedResumeRun(run)) {
    return "completed";
  }

  if (run.status === "failed") {
    return "failed";
  }

  return "active";
}

function buildResumeTask(
  input: BuildJobFinderTaskCenterModelInput,
): JobFinderTaskCenterItem | null {
  const run = input.workspace.latestResumeImportRun;
  if (!run && !input.isResumeImportPending) {
    return null;
  }

  const status = resumeStatus(run, input.isResumeImportPending);
  const count = run?.candidateCounts;
  const canRestart = status === "failed" || status === "interrupted";
  const historicalDuration =
    input.isResumeImportPending &&
    run &&
    isCompletedResumeRun(run) &&
    run.timing?.totalMs
      ? [run.timing.totalMs]
      : [];

  return {
    id: input.isResumeImportPending
      ? "resume-import-current"
      : (run?.id ?? "resume-import-interrupted"),
    kind: "resume_import",
    title: "Resume import",
    status,
    stageLabel:
      status === "active"
        ? input.resumeImportProgress
          ? resumeStageLabels[input.resumeImportProgress.stage]
          : run?.status === "extracting"
            ? "Building profile suggestions"
            : run?.status === "reconciling"
              ? "Saving your review items"
              : run?.status === "parsing"
                ? "Reading your resume"
                : "Waiting for file selection"
        : status === "completed"
          ? "Ready for review"
          : status === "failed"
            ? "Import failed"
            : "Import interrupted",
    sourceLabel:
      input.isResumeImportPending && (!run || isCompletedResumeRun(run))
        ? "Selected resume file"
        : (run?.sourceResumeFileName ?? "Selected resume file"),
    countLabel:
      !input.isResumeImportPending && count && count.total > 0
        ? `${count.autoApplied} accepted · ${count.needsReview} need review · ${count.total} extracted`
        : "Counts available after extraction",
    historyEstimateLabel:
      status === "active"
        ? historyEstimate(
            historicalDuration,
            "previous completed import",
            "previous completed imports",
          )
        : null,
    canCancel: false,
    cancelKind: null,
    resumeRoute: canRestart ? "/job-finder/profile" : null,
    resumeActionLabel: canRestart ? "Open Profile" : null,
  };
}

function applyStatus(run: ApplyRunSummary): JobFinderTaskStatus {
  if (
    run.state === "paused_for_user_review" ||
    run.state === "paused_for_consent"
  ) {
    return "paused";
  }

  if (run.state === "completed") {
    return "completed";
  }

  if (run.state === "cancelled" || run.state === "failed") {
    return run.state;
  }

  return "active";
}

function applySourceLabel(
  workspace: JobFinderRendererWorkspaceSnapshot,
  jobId: string | null,
): string {
  if (!jobId) {
    return "Applications";
  }

  const job = workspace.discoveryJobs.find(
    (candidate) => candidate.id === jobId,
  );
  if (job) {
    return `${job.company ?? "Employer"} · ${job.title}`;
  }

  const application = workspace.applicationRecords.find(
    (candidate) => candidate.jobId === jobId,
  );
  return application
    ? `${application.company} · ${application.title}`
    : "Applications";
}

function applyDuration(run: ApplyRunSummary): number | null {
  if (!run.completedAt) {
    return null;
  }

  return Math.max(0, timestamp(run.completedAt) - timestamp(run.createdAt));
}

function buildApplyTasks(
  input: BuildJobFinderTaskCenterModelInput,
): JobFinderTaskCenterItem[] {
  const latestResultByRecordId = new Map<
    string,
    JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]
  >();
  for (const result of input.workspace.applyJobResults ?? []) {
    if (!result.applicationRecordId) continue;
    const previous = latestResultByRecordId.get(result.applicationRecordId);
    if (!previous || previous.updatedAt < result.updatedAt) {
      latestResultByRecordId.set(result.applicationRecordId, result);
    }
  }
  const uncertainResult = newestBy(
    (input.workspace.applyJobResults ?? []).filter(
      (result) =>
        result.privacyReceipt?.submissionOutcome?.outcome ===
          "outcome_uncertain" &&
        (!result.applicationRecordId ||
          latestResultByRecordId.get(result.applicationRecordId)?.id ===
            result.id),
    ),
    (result) => result.updatedAt,
  );
  // An application waiting on "Verify outcome" must not hide a batch that is
  // running meanwhile: both are shown, and the running one keeps its Stop.
  const verificationItem: JobFinderTaskCenterItem | null = uncertainResult
    ? {
        id: `submission-verification_${uncertainResult.id}`,
        kind: "apply",
        title: "Manual verification required",
        status: "paused",
        stageLabel: "Verify on the employer site",
        sourceLabel: applySourceLabel(input.workspace, uncertainResult.jobId),
        countLabel: "Automatic retry is blocked until you record the outcome",
        historyEstimateLabel: null,
        canCancel: false,
        cancelKind: null,
        resumeRoute: "/job-finder/applications",
        resumeActionLabel: "Verify outcome",
      }
    : null;
  const runs = input.workspace.applyRuns ?? [];
  const newest = newestBy(runs, (run) => run.updatedAt);
  const displayedRuns = runs.filter(
    (run) => run.state === "running" || run.id === newest?.id,
  );
  const runItems = displayedRuns.map((run) => buildApplyRunTask(input, run));
  return [verificationItem, ...runItems].filter(
    (item): item is JobFinderTaskCenterItem =>
      item !== null &&
      // With an outcome to verify, the run card shows only while it runs.
      (verificationItem === null ||
        item === verificationItem ||
        item.status === "active" ||
        item.status === "stopping"),
  );
}

function buildApplyRunTask(
  input: BuildJobFinderTaskCenterModelInput,
  selectedRun?: ApplyRunSummary,
): JobFinderTaskCenterItem | null {
  const runs = input.workspace.applyRuns ?? [];
  const run = selectedRun ?? newestBy(runs, (candidate) => candidate.updatedAt);
  if (!run) {
    return null;
  }

  const allResults = input.workspace.applyJobResults ?? [];
  const resultsForRun = allResults.filter((result) => result.runId === run.id);
  // A job this run failed or stopped on, and that a later run took up again
  // (a Try again, or a handed-back application carried on), is that later
  // run's now. Counting it here said "1 need attention" and offered
  // "Prepare remaining jobs" while Needs you was empty and nothing remained.
  const supersededResultIds = new Set(
    resultsForRun
      .filter((result) =>
        allResults.some(
          (other) =>
            other.runId !== run.id &&
            other.jobId === result.jobId &&
            other.startedAt > result.startedAt,
        ),
      )
      .map((result) => result.id),
  );
  const supersededJobIds = new Set(
    resultsForRun
      .filter((result) => supersededResultIds.has(result.id))
      .map((result) => result.jobId),
  );
  const supersededCount = (state: string) =>
    resultsForRun.filter(
      (result) => result.state === state && supersededResultIds.has(result.id),
    ).length;
  const currentJobEnded = resultsForRun.some(
    (result) =>
      result.jobId === run.currentJobId &&
      [
        "failed",
        "submitted",
        "awaiting_review",
        "blocked",
        "skipped",
        "cancelled",
      ].includes(result.state),
  );
  const failedJobs = Math.max(0, run.failedJobs - supersededCount("failed"));
  const cancelledJobs = resultsForRun.filter(
    (result) =>
      result.state === "cancelled" && !supersededResultIds.has(result.id),
  ).length;
  const blockedJobs = Math.max(0, run.blockedJobs - supersededCount("blocked"));
  const parked =
    input.workspace.activityControl?.paused &&
    input.workspace.activityControl.pauseBehavior === "finish_current" &&
    run.state === "running" &&
    resultsForRun.some((result) => result.state === "planned") &&
    resultsForRun.every(
      (result) =>
        [
          "planned",
          "awaiting_review",
          "submitted",
          "blocked",
          "failed",
          "skipped",
          "cancelled",
        ].includes(result.state) &&
        (result.state !== "planned" ||
          (result.applicationPreparationStartedAt === null &&
            result.applicationPreparationStartedLocalDate === null)),
    );
  // Old runs keep a "paused for review" state after everything in them was
  // sent or ended; read what each one is actually doing.
  const pauseState = classifyPausedApplyRun(input.workspace, run);
  const finishedPause = pauseState === "finished";
  const status = parked
    ? "paused"
    : finishedPause
      ? "completed"
      : applyStatus(run);
  // `pendingJobs` is the number the service has not attempted. Jobs waiting on
  // the person are finished for this batch and belong in Needs you, so they
  // count here instead of leaving a completed preparation run at 0 of N.
  const canCancel = status === "active" || status === "paused";
  // Two pauses that look the same on this card behave completely differently.
  // A consent pause holds a real decision the person can settle in Needs you,
  // and the run carries on once they do. A safety-limit pause holds nothing to
  // settle: the run will not continue, and the remaining jobs need a fresh
  // "Prepare remaining jobs" in Applications. Offering "Continue application"
  // for both is why the button could be clicked three times over several
  // minutes and change nothing.
  const hasOpenApplicationHandoff = pauseState === "waiting_on_you";
  const awaitingDecision =
    run.state === "paused_for_consent" ||
    (run.state === "paused_for_user_review" && hasOpenApplicationHandoff);
  const needsReview = status === "paused";
  const canRestage = status === "cancelled" || status === "failed";
  const readyForFinalReview = pauseState === "ready_for_final_review";
  const stoppedBySafeguard = pauseState === "stopped_by_safeguard";
  const finishedJobs =
    readyForFinalReview || finishedPause
      ? run.totalJobs
      : Math.max(0, run.totalJobs - run.pendingJobs);
  // Same predicate Applications uses to build its "Prepare remaining jobs"
  // target list, so the two surfaces cannot disagree about what is left.
  const applyRecoveryJobIds = run.jobIds.filter(
    (jobId) =>
      !supersededJobIds.has(jobId) &&
      applyRunJobNeedsPreparation(
        resultsForRun.find((candidate) => candidate.jobId === jobId),
      ),
  );
  const recordsById = new Map(
    input.workspace.applicationRecords.map((record) => [record.id, record]),
  );
  const resultRecords = resultsForRun.flatMap((result) => {
    if (!result.applicationRecordId) return [];
    const record = recordsById.get(result.applicationRecordId);
    return record ? [record] : [];
  });
  // Cancelling the last handoff moves its application record to manual-only.
  // The older paused run/result remain as immutable history, so they must not
  // keep a derived Tasks chip alive after the record no longer needs a person.
  if (
    stoppedBySafeguard &&
    applyRecoveryJobIds.length === 0 &&
    resultRecords.length > 0 &&
    resultRecords.every(
      (record) => record.lastAttemptState === "unsupported",
    ) &&
    !hasOpenApplicationHandoff
  ) {
    return null;
  }
  // A finished batch that left blocked, skipped or never-attempted jobs has
  // work remaining whatever ended it. Applications already offers to prepare
  // those; the card offered only "Open Applications" unless a safety limit
  // had stopped the run, so the same batch had two different next steps
  // depending on which screen the person was looking at. A run still going,
  // or one waiting on a decision the person has to settle first, is not
  // ready for it.
  const canPrepareRemaining =
    applyRecoveryJobIds.length > 0 &&
    !parked &&
    !awaitingDecision &&
    status !== "active" &&
    status !== "stopping";
  const historyDurations = runs
    .filter(
      (candidate) =>
        candidate.id !== run.id &&
        candidate.mode === run.mode &&
        candidate.state === "completed",
    )
    .map(applyDuration)
    .filter(
      (duration): duration is number => duration !== null && duration > 0,
    );

  // A job that holds its place but has no browser tab yet is waiting, not
  // being worked on: Home read "Applying: <it> · Working through
  // application" while it waited for the person to free a tab.
  const activeResults = resultsForRun.filter((result) =>
    ["filling", "question_capture", "submitting"].includes(result.state),
  );
  const isWaitingForTab = (result: (typeof resultsForRun)[number]) =>
    result.summary === WAITING_FOR_BROWSER_TAB_SUMMARY;
  const workingResult = activeResults.find(
    (result) => !isWaitingForTab(result),
  );
  const waitingForTabResult =
    run.state === "running" && !workingResult
      ? resultsForRun.find(
          (result) =>
            isWaitingForTab(result) &&
            ["planned", "filling", "question_capture"].includes(result.state),
        )
      : undefined;
  return {
    id: run.id,
    updatedAt: run.updatedAt,
    kind: "apply",
    title: "Applications",
    status,
    stageLabel: parked
      ? "Paused before the next application"
      : waitingForTabResult
        ? WAITING_FOR_BROWSER_TAB_SUMMARY
        : run.state === "draft"
          ? "Ready to start"
          : run.state === "awaiting_submit_approval"
            ? "Waiting for your approval"
            : run.state === "running"
              ? "Working through application"
              : run.state === "paused_for_user_review"
                ? hasOpenApplicationHandoff
                  ? "Waiting on you"
                  : readyForFinalReview
                    ? "Ready for final review"
                    : finishedPause
                      ? resultsForRun.length > 0 &&
                        resultsForRun.every(
                          (result) => result.state === "submitted",
                        )
                        ? "Applied"
                        : "Finished"
                      : "Paused by a safety limit"
                : run.state === "paused_for_consent"
                  ? "Waiting for your consent"
                  : run.state === "completed"
                    ? failedJobs > 0 || blockedJobs > 0
                      ? "Some applications need attention"
                      : cancelledJobs > 0 && cancelledJobs === run.totalJobs
                        ? "Cancelled by you"
                        : run.totalJobs > 0 &&
                            run.submittedJobs === run.totalJobs
                          ? "Applied"
                          : resultsForRun.some(
                                (result) =>
                                  result.state === "awaiting_review" &&
                                  !supersededResultIds.has(result.id),
                              )
                            ? "Ready for final review"
                            : "Finished"
                    : run.state === "cancelled"
                      ? "Application stopped"
                      : "Application needs attention",
    sourceLabel: applySourceLabel(
      input.workspace,
      (parked
        ? resultsForRun.find((result) => result.state === "planned")?.jobId
        : // The job being worked right now. After a Resume the run record's
          // current job still named the one finished before the pause, so
          // Home read "Applying: <that job>" while the next one filled.
          (workingResult?.jobId ??
          waitingForTabResult?.jobId ??
          // Between two jobs the run's current job can be one that already
          // ended (one the person took over read "Applying: <it>" while
          // the batch went on); name the next job waiting instead.
          (currentJobEnded
            ? resultsForRun.find((result) => result.state === "planned")?.jobId
            : null) ??
          run.currentJobId)) ??
        run.jobIds[0] ??
        null,
    ),
    countLabel: [
      `${countApplicationLedgerEntries(input.workspace.applicationRecords)} applications`,
      `${finishedJobs} of ${run.totalJobs} application tasks finished`,
      blockedJobs > 0 ? `${blockedJobs} blocked` : null,
      failedJobs > 0 ? `${failedJobs} need attention` : null,
      cancelledJobs > 0 ? `${cancelledJobs} cancelled` : null,
      awaitingDecision
        ? "Waiting on you"
        : stoppedBySafeguard
          ? "It will not carry on by itself"
          : null,
    ]
      .filter(Boolean)
      .join(" · "),
    historyEstimateLabel:
      status === "active"
        ? historyEstimate(
            historyDurations,
            "similar application task",
            "similar application tasks",
            " (total time, including pauses)",
          )
        : null,
    canCancel,
    cancelKind: canCancel ? "apply" : null,
    resumeRoute: awaitingDecision
      ? "/job-finder/actions"
      : canPrepareRemaining || needsReview || canRestage
        ? "/job-finder/applications"
        : null,
    resumeActionLabel: awaitingDecision
      ? "Resolve what needs you"
      : canPrepareRemaining
        ? // In Send for me the new runs send, so the press says Apply.
          input.workspace.settings?.applicationAutomationMode ===
          "autonomous_submit"
          ? "Apply to remaining jobs"
          : "Prepare remaining jobs"
        : needsReview || canRestage
          ? "Open Applications"
          : null,
    ...(canPrepareRemaining ? { applyRecoveryJobIds } : {}),
  };
}

const FINISHED_TASK_SHOWN_FOR_MS = 24 * 60 * 60 * 1000;

/**
 * A run that ended more than a day ago is history: Home, Search history and
 * Applications keep its outcome, and Activity is for what is going on.
 * Eight-day-old "Stopped" and "Failed" cards read as news on every open.
 */
export function isStaleFinishedTask(
  item: JobFinderTaskCenterItem,
  now: number,
): boolean {
  if (
    item.status === "active" ||
    item.status === "stopping" ||
    item.status === "paused" ||
    !item.updatedAt
  ) {
    return false;
  }
  const endedAt = timestamp(item.updatedAt);
  return Number.isFinite(endedAt) && now - endedAt > FINISHED_TASK_SHOWN_FOR_MS;
}

export function buildJobFinderTaskCenterModel(
  input: BuildJobFinderTaskCenterModelInput,
): JobFinderTaskCenterModel {
  const items = [
    buildSourceCheckTask(input),
    buildResumeTask(input),
    ...buildApplyTasks(input),
  ].filter((item): item is JobFinderTaskCenterItem => item !== null);

  return {
    activeCount: items.filter(
      (item) => item.status === "active" || item.status === "stopping",
    ).length,
    pausedCount: items.filter((item) => item.status === "paused").length,
    items,
  };
}

/**
 * The Activity chip caption: how many runs are working right now, or null
 * when nothing is, so the chip renders no count at all.
 *
 * Paused runs are not counted here. Every pause this panel knows about is
 * waiting on the person, and Needs you already counts that work; "Tasks · 1
 * paused" beside "Needs you · 2 unresolved" was two numbers for one queue.
 */
export function describeTaskCenterCounts(input: {
  activeCount: number;
  pausedCount: number;
}): string | null {
  return input.activeCount > 0 ? `${input.activeCount} running` : null;
}
