import {
  SourceDebugProgressEventSchema,
  type AgentDiscoveryProgress,
  type SourceDebugPhase,
  type SourceDebugProgressEvent,
} from "@nestor/contracts";

import { formatStatusLabel } from "./source-instructions";

/**
 * What each stage of a source check is actually doing, said the way a person
 * would say it.
 *
 * The only feedback a person got while a source check ran was a rotating
 * sequence of the internal phase names — "Access Auth Probe", "Site Structure
 * Mapping", "Replay Verification" — which describe the code's stages, not
 * anything the person asked for. These are the same stages named by what they
 * are finding out.
 */
const SOURCE_DEBUG_PHASE_PLAIN_LABELS: Record<SourceDebugPhase, string> = {
  access_auth_probe: "Checking whether this site lets Job Finder in",
  site_structure_mapping:
    "Learning how this site works: where the jobs are, how search behaves, and how applying starts",
  search_filter_probe: "Trying this site's own search and filters",
  job_detail_validation: "Opening a job to check what it shows",
  apply_path_validation: "Following the apply button to see where it leads",
  replay_verification: "Repeating the steps to check they work every time",
};

/** The plain sentence for one stage; falls back to a readable label. */
function describeSourceDebugPhase(phase: SourceDebugPhase): string {
  return SOURCE_DEBUG_PHASE_PLAIN_LABELS[phase] ?? formatStatusLabel(phase);
}

function normalizeProgressUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

export interface SourceDebugOpenFailureCopy {
  summary: string;
  technicalDetails: string;
}

/** Converts browser navigation failures into screen-safe source-check copy. */
export function describeSourceDebugOpenFailure(
  error: unknown,
  sourceLabel: string,
): SourceDebugOpenFailureCopy | null {
  const technicalDetails =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (
    !/(?:ApplicationNavigationError|page\.(?:goto|waitFor)|navigation.*(?:failed|timeout)|Timeout \d+ms exceeded|net::ERR_)/iu.test(
      technicalDetails,
    )
  ) {
    return null;
  }

  const timedOut = /(?:timeout|timed out)/iu.test(technicalDetails);
  return {
    summary: `Job Finder could not open ${sourceLabel} (${
      timedOut
        ? "the page did not load in time"
        : "the page could not be opened"
    }).`,
    technicalDetails,
  };
}

export function buildSourceDebugProgressEmitter(input: {
  runId: string;
  targetId: string;
  onProgress?: (event: SourceDebugProgressEvent) => void;
}) {
  const startedAtMs = Date.now();
  let lastActivityAt = new Date().toISOString();

  return (eventInput: {
    phase?: SourceDebugPhase | null;
    waitReason: SourceDebugProgressEvent["waitReason"];
    message: string;
    currentUrl?: string | null;
    stepCount?: number;
    jobsFound?: number;
  }) => {
    lastActivityAt = new Date().toISOString();
    const event = SourceDebugProgressEventSchema.parse({
      runId: input.runId,
      targetId: input.targetId,
      phase: eventInput.phase ?? null,
      waitReason: eventInput.waitReason,
      timestamp: lastActivityAt,
      elapsedMs: Date.now() - startedAtMs,
      lastActivityAt,
      message: eventInput.message,
      currentUrl: normalizeProgressUrl(eventInput.currentUrl),
      stepCount: eventInput.stepCount ?? 0,
      jobsFound: eventInput.jobsFound ?? 0,
    });

    input.onProgress?.(event);
    return event;
  };
}

function inferProgressWaitReason(
  progress: Pick<AgentDiscoveryProgress, "currentAction" | "waitReason">,
): SourceDebugProgressEvent["waitReason"] {
  if (progress.waitReason) {
    return progress.waitReason;
  }

  const normalizedAction = (progress.currentAction ?? "").toLowerCase();

  if (!normalizedAction || normalizedAction === "thinking...") {
    return "waiting_on_ai";
  }

  if (
    normalizedAction === "thinking" ||
    normalizedAction.includes("retrying_ai")
  ) {
    return normalizedAction.includes("retrying_ai")
      ? "retrying_ai"
      : "waiting_on_ai";
  }

  if (
    normalizedAction.startsWith("retry:") ||
    normalizedAction.includes("retrying_tool")
  ) {
    return "retrying_tool";
  }

  if (
    normalizedAction.startsWith("extract_result:") ||
    normalizedAction.includes("extract_jobs")
  ) {
    return "extracting_jobs";
  }

  return "executing_tool";
}

function buildFallbackProgressMessage(
  waitReason: SourceDebugProgressEvent["waitReason"],
  phaseLabel: string,
  jobsFound: number,
  stepCount: number,
): string {
  switch (waitReason) {
    case "waiting_on_ai":
      return `${phaseLabel}: working out what to do next (step ${stepCount}).`;
    case "retrying_ai":
      return `${phaseLabel}: trying again after a hiccup working out the next step.`;
    case "waiting_on_page":
      return `${phaseLabel}: waiting for the page to finish loading.`;
    case "executing_tool":
      return `${phaseLabel}: using the site.`;
    case "retrying_tool":
      return `${phaseLabel}: trying the last step again after the page did not respond.`;
    case "extracting_jobs":
      return `${phaseLabel}: reading the jobs on this page (${jobsFound} so far).`;
    case "persisting_results":
      return `${phaseLabel}: saving what this stage found.`;
    case "manual_prerequisite":
      return `${phaseLabel}: waiting for you to finish a step in the browser.`;
    case "finalizing":
      return "Finishing the check on this job site.";
    case "starting_browser":
      return "Opening the browser to check this job site.";
    case "attaching_browser":
      return "Getting the browser tab ready for the next stage.";
    case "merging_results":
      return `${phaseLabel}: putting together what was found.`;
    default:
      return `${phaseLabel}: still checking this job site.`;
  }
}

export function summarizeAgentProgressForSourceDebug(
  progress: AgentDiscoveryProgress,
  phase: SourceDebugPhase,
): {
  waitReason: SourceDebugProgressEvent["waitReason"];
  message: string;
} {
  const phaseLabel = describeSourceDebugPhase(phase);
  const waitReason = inferProgressWaitReason(progress);
  const message =
    progress.message?.trim() ||
    buildFallbackProgressMessage(
      waitReason,
      phaseLabel,
      progress.jobsFound,
      progress.stepCount,
    );

  return {
    waitReason,
    message:
      message.toLowerCase().startsWith(phaseLabel.toLowerCase()) ||
      waitReason === "starting_browser" ||
      waitReason === "attaching_browser" ||
      waitReason === "finalizing"
        ? message
        : `${phaseLabel}: ${message}`,
  };
}
