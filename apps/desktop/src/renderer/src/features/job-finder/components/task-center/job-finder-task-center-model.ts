import type {
  JobFinderRendererWorkspaceSnapshot,
  ResumeImportProgressEvent,
  ResumeImportRun,
  SourceDebugRunRecord,
} from "@nestor/contracts";
import { JOB_FINDER_ROUTE_PATHS } from "../../lib/job-finder-route-hrefs";

export type JobFinderTaskKind =
  | "source_check"
  | "resume_import"
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
  resumeRoute: string | null;
  resumeActionLabel: string | null;
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
    resumeRoute: canRestart ? "/job-finder/profile" : null,
    resumeActionLabel: canRestart ? "Open Profile" : null,
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
