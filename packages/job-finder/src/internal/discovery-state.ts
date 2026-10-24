import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  isFinishedDiscoveryTargetExecutionState,
  type AgentDiscoveryProgress,
  type DiscoveryActivityEvent,
  type BrowserRunWaitReason,
  type DiscoveryRunRecord,
  type DiscoveryTargetExecution,
  type JobFinderDiscoveryState,
  type JobSearchPreferences,
} from "@nestor/contracts";

const DEFAULT_DISCOVERY_HISTORY_LIMIT = 5;

export function toDiscoverySessionState(
  session: Awaited<ReturnType<BrowserSessionRuntime["getSessionState"]>>,
) {
  return {
    adapterKind: session.source,
    status: session.status,
    driver: session.driver,
    label: session.label,
    detail: session.detail,
    lastCheckedAt: session.lastCheckedAt,
  };
}

export function formatFoundSuffix(jobsFound: number): string {
  return jobsFound > 0 ? ` (${jobsFound} found so far)` : "";
}

export function summarizeProgressAction(
  progress: Pick<
    AgentDiscoveryProgress,
    "currentAction" | "message" | "waitReason"
  >,
  siteLabel: string,
  jobsFound: number,
): {
  message: string;
  stage: DiscoveryActivityEvent["stage"];
  waitReason: BrowserRunWaitReason | null;
} {
  const message = progress.message?.trim();
  const waitReason = inferWaitReason(progress);
  const normalizedAction = (progress.currentAction ?? "").toLowerCase();

  if (message) {
    return {
      message,
      stage: mapWaitReasonToStage(waitReason),
      waitReason,
    };
  }

  if (!normalizedAction || normalizedAction === "thinking...") {
    return {
      message: `Reviewing the next step${formatFoundSuffix(jobsFound)}`,
      stage: "planning",
      waitReason,
    };
  }

  if (normalizedAction.startsWith("extract_result:")) {
    const [
      ,
      addedRaw = "0",
      totalRaw = String(jobsFound),
      attemptedRaw = totalRaw,
    ] = normalizedAction.split(":");
    const addedCount = Number.parseInt(addedRaw, 10);
    const totalCount = Number.parseInt(totalRaw, 10);
    const attemptedCount = Number.parseInt(attemptedRaw, 10);

    if (
      Number.isFinite(addedCount) &&
      Number.isFinite(totalCount) &&
      addedCount > 0
    ) {
      return {
        message: `Found ${addedCount} new job${addedCount === 1 ? "" : "s"} on this pass (${totalCount} total so far)`,
        stage: "extraction",
        waitReason,
      };
    }

    if (Number.isFinite(attemptedCount) && Number.isFinite(totalCount)) {
      return {
        message: `No new jobs were kept from this pass (${attemptedCount} reviewed, ${totalCount} total so far)`,
        stage: "extraction",
        waitReason,
      };
    }
  }

  if (normalizedAction.includes("navigate")) {
    return {
      message: `Opening ${siteLabel}${formatFoundSuffix(jobsFound)}`,
      stage: "navigation",
      waitReason,
    };
  }

  if (normalizedAction.includes("extract_jobs")) {
    return {
      message: `Gathering jobs from the current page${formatFoundSuffix(jobsFound)}`,
      stage: "extraction",
      waitReason,
    };
  }

  if (normalizedAction.includes("scroll_down")) {
    return {
      message: `Loading more results${formatFoundSuffix(jobsFound)}`,
      stage: "navigation",
      waitReason,
    };
  }

  if (normalizedAction.includes("go_back")) {
    return {
      message: `Returning to the previous results page${formatFoundSuffix(jobsFound)}`,
      stage: "navigation",
      waitReason,
    };
  }

  if (normalizedAction.includes("fill")) {
    return {
      message: `Refining the search controls${formatFoundSuffix(jobsFound)}`,
      stage: "navigation",
      waitReason,
    };
  }

  if (normalizedAction.includes("click")) {
    return {
      message: `Opening a job detail or result card${formatFoundSuffix(jobsFound)}`,
      stage: "navigation",
      waitReason,
    };
  }

  return {
    message: `Continuing discovery on the current page${formatFoundSuffix(jobsFound)}`,
    stage: "navigation",
    waitReason,
  };
}

function inferWaitReason(
  progress: Pick<AgentDiscoveryProgress, "currentAction" | "waitReason">,
): BrowserRunWaitReason | null {
  if (progress.waitReason) {
    return progress.waitReason;
  }

  const normalizedAction = (progress.currentAction ?? "").toLowerCase();

  if (!normalizedAction || normalizedAction === "thinking...") {
    return "waiting_on_ai";
  }

  if (normalizedAction.includes("retrying_ai")) {
    return "retrying_ai";
  }

  if (
    normalizedAction.startsWith("retry:") ||
    normalizedAction.includes("retrying_tool")
  ) {
    return "retrying_tool";
  }

  if (
    normalizedAction.includes("extract_result") ||
    normalizedAction.includes("extract_jobs")
  ) {
    return "extracting_jobs";
  }

  if (
    normalizedAction.includes("navigate") ||
    normalizedAction.includes("scroll_down") ||
    normalizedAction.includes("go_back") ||
    normalizedAction.includes("click") ||
    normalizedAction.includes("fill")
  ) {
    return "executing_tool";
  }

  return null;
}

function mapWaitReasonToStage(
  waitReason: BrowserRunWaitReason | null,
): DiscoveryActivityEvent["stage"] {
  switch (waitReason) {
    case "waiting_on_ai":
    case "retrying_ai":
      return "planning";
    case "extracting_jobs":
      return "extraction";
    case "merging_results":
      return "scoring";
    case "persisting_results":
    case "finalizing":
    case "manual_prerequisite":
      return "persistence";
    case "starting_browser":
    case "attaching_browser":
    case "waiting_on_page":
    case "executing_tool":
    case "retrying_tool":
    case null:
      return "navigation";
    default:
      return "navigation";
  }
}

export function createDiscoveryEvent(
  input: Omit<
    DiscoveryActivityEvent,
    | "id"
    | "resolvedAdapterKind"
    | "terminalState"
    | "waitReason"
    | "collectionMethod"
    | "sourceIntelligenceProvider"
  > &
    Pick<
      Partial<DiscoveryActivityEvent>,
      | "resolvedAdapterKind"
      | "terminalState"
      | "waitReason"
      | "collectionMethod"
      | "sourceIntelligenceProvider"
    >,
): DiscoveryActivityEvent {
  return {
    ...input,
    waitReason: input.waitReason ?? null,
    resolvedAdapterKind: input.resolvedAdapterKind ?? null,
    collectionMethod: input.collectionMethod ?? null,
    sourceIntelligenceProvider: input.sourceIntelligenceProvider ?? null,
    terminalState: input.terminalState ?? null,
    id: `${input.runId}_${input.stage}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  };
}

export function appendDiscoveryEvent(
  run: DiscoveryRunRecord,
  event: DiscoveryActivityEvent,
): DiscoveryRunRecord {
  const previousEvent = run.activity[run.activity.length - 1];

  if (
    previousEvent &&
    previousEvent.message === event.message &&
    previousEvent.stage === event.stage &&
    previousEvent.waitReason === event.waitReason &&
    previousEvent.targetId === event.targetId &&
    previousEvent.url === event.url
  ) {
    return run;
  }

  // Discovery activity is persisted as a complete run history. This function
  // is called for every agent progress event, so cloning and reparsing the
  // entire history here turns a long run into quadratic work. The run is an
  // owned mutable accumulator inside the discovery service. Keep the complete
  // history and append each typed event in O(1).
  run.activity.push(event);
  return run;
}

export function updateTargetExecution(
  run: DiscoveryRunRecord,
  targetId: string,
  updater: (target: DiscoveryTargetExecution) => DiscoveryTargetExecution,
): DiscoveryRunRecord {
  const targetIndex = run.targetExecutions.findIndex(
    (target) => target.targetId === targetId,
  );

  if (targetIndex < 0) {
    return run;
  }

  const currentTarget = run.targetExecutions[targetIndex];
  if (!currentTarget) {
    return run;
  }

  // Like appendDiscoveryEvent, this is an update on the discovery service's
  // owned accumulator. Avoid rebuilding and reparsing every target and every
  // activity event for each checkpoint. Feed/model inputs are validated before
  // the service creates this typed update.
  run.targetExecutions[targetIndex] = updater(currentTarget);
  return run;
}

/**
 * How many sources actually finished. Cancelling a run finalises its running
 * sources as `cancelled`, so counting "anything past running" reported a
 * source the user had just interrupted as finished.
 */
export function countCompletedTargetExecutions(
  run: DiscoveryRunRecord,
): number {
  return run.targetExecutions.filter((execution) =>
    isFinishedDiscoveryTargetExecutionState(execution.state),
  ).length;
}

export function finalizeDiscoveryState(
  current: JobFinderDiscoveryState,
  run: DiscoveryRunRecord,
  searchPreferences: JobSearchPreferences,
): JobFinderDiscoveryState {
  const historyLimit =
    searchPreferences.discovery.historyLimit || DEFAULT_DISCOVERY_HISTORY_LIMIT;

  // A running run lives solely in activeRun. Mirroring it into recentRuns on
  // every mid-run persistence duplicated the full run payload (activity
  // included) inside the same singleton write and let one run occupy two
  // places at once. History receives the run exactly once, when it reaches a
  // terminal state; the id filter also retires any legacy running copy that
  // older versions left in stored history.
  const cancellationRequestedAt =
    run.cancellationRequestedAt ??
    (current.activeRun?.id === run.id
      ? current.activeRun.cancellationRequestedAt
      : null);
  const persistedRun = cancellationRequestedAt
    ? { ...run, cancellationRequestedAt }
    : run;
  const isRunning = persistedRun.state === "running";
  // The repository validates changed rows at the write boundary. Parsing the
  // whole state here copied every old run, checkpoint and ledger entry on each
  // progress update, even though they were already validated and unchanged.
  return {
    ...current,
    runState: persistedRun.state,
    activeRun: isRunning ? persistedRun : null,
    recentRuns: [
      ...(isRunning ? [] : [persistedRun]),
      ...current.recentRuns.filter((entry) => entry.id !== persistedRun.id),
    ].slice(0, historyLimit),
  };
}
