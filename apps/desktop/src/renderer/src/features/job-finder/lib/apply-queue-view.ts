import {
  listApplyQueueRemainingJobIds,
  type ApplicationAutomationMode,
  type ApplyJobResult,
  type ApplyQueue,
} from "@nestor/contracts";

export type ApplyQueueControlAction = "pause" | "continue" | "stop" | "dismiss";

export interface ApplyQueueViewButton {
  label: string;
  action: ApplyQueueControlAction;
}

/** What an Apply queue is doing, in the words Home and Applications show. */
export interface ApplyQueueView {
  title: string;
  detail: string;
  /** Active work pulses; a paused or finished queue does not. */
  active: boolean;
  primary: ApplyQueueViewButton | null;
  secondary: ApplyQueueViewButton | null;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Applying sends only in Send for me; the other modes fill forms in. */
export function applyQueueVerb(mode: ApplicationAutomationMode): {
  doing: string;
  done: string;
} {
  return mode === "autonomous_submit"
    ? { doing: "Applying to", done: "Applied to" }
    : {
        doing: "Filling in applications for",
        done: "Filled in applications for",
      };
}

export function isApplyQueueOngoing(
  queue: ApplyQueue | null | undefined,
): boolean {
  return (
    !!queue && (queue.state === "running" || queue.state === "paused")
  );
}

/** Jobs an ongoing queue still holds; they are not offered again. */
export function listApplyQueueWaitingJobIds(
  queue: ApplyQueue | null | undefined,
): string[] {
  return queue && isApplyQueueOngoing(queue)
    ? listApplyQueueRemainingJobIds(queue)
    : [];
}

/** A refusal's first sentence; the screen that owns the cause says the rest. */
function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(\s|$)/u.exec(text.trim());
  return match ? match[1]! : text.trim();
}

/** The part of a run result the queue counts by. */
export type ApplyQueueResult = Pick<
  ApplyJobResult,
  "jobId" | "state" | "startedAt" | "updatedAt"
>;

/** What happened to the queue's jobs, by each started job's latest result. */
export interface ApplyQueueOutcomes {
  sent: number;
  readyForYou: number;
  needYou: number;
  failed: number;
  stillGoing: number;
  notStarted: number;
}

/**
 * A finished queue used to say "Applied to 6 jobs" for six jobs that were
 * started, though two of them failed. Each started job is counted by what
 * its latest result in this queue says; a job with no result yet is still
 * going, and a job left out or never reached is not started.
 */
export function countApplyQueueOutcomes(
  queue: ApplyQueue,
  results: readonly ApplyQueueResult[],
): ApplyQueueOutcomes {
  const latestByJob = new Map<string, ApplyQueueResult>();
  const started = new Set(queue.startedJobIds);
  for (const result of results) {
    if (!started.has(result.jobId)) continue;
    // Results from before this queue belong to an earlier press.
    if (result.updatedAt < queue.createdAt) continue;
    const known = latestByJob.get(result.jobId);
    if (!known || result.updatedAt > known.updatedAt) {
      latestByJob.set(result.jobId, result);
    }
  }
  const outcomes: ApplyQueueOutcomes = {
    sent: 0,
    readyForYou: 0,
    needYou: 0,
    failed: 0,
    stillGoing: 0,
    notStarted: queue.jobIds.length - started.size,
  };
  for (const jobId of started) {
    switch (latestByJob.get(jobId)?.state) {
      case "submitted":
        outcomes.sent += 1;
        break;
      case "awaiting_review":
        outcomes.readyForYou += 1;
        break;
      case "blocked":
      case "question_capture":
        outcomes.needYou += 1;
        break;
      case "failed":
        outcomes.failed += 1;
        break;
      case "cancelled":
      case "skipped":
        outcomes.notStarted += 1;
        break;
      default:
        outcomes.stillGoing += 1;
    }
  }
  return outcomes;
}

function describeOutcomes(
  outcomes: ApplyQueueOutcomes,
  mode: ApplicationAutomationMode,
): string {
  return [
    outcomes.sent > 0 ? `${outcomes.sent} sent` : null,
    outcomes.readyForYou > 0
      ? `${outcomes.readyForYou} ${mode === "autonomous_submit" ? "ready for you to send" : "ready for you"}`
      : null,
    outcomes.needYou > 0 ? `${outcomes.needYou} need you` : null,
    outcomes.failed > 0 ? `${outcomes.failed} failed` : null,
    outcomes.stillGoing > 0 ? `${outcomes.stillGoing} still finishing` : null,
    outcomes.notStarted > 0 ? `${outcomes.notStarted} not started` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function describeApplyQueue(
  queue: ApplyQueue | null | undefined,
  options: {
    /** Run results, so a finished queue says what happened to each job. */
    results?: readonly ApplyQueueResult[] | null;
  } = {},
): ApplyQueueView | null {
  if (!queue) return null;
  const total = queue.jobIds.length;
  const started = queue.startedJobIds.length;
  const leftOut = queue.skipped.length;
  const toGo = listApplyQueueRemainingJobIds(queue).length;
  const verb = applyQueueVerb(queue.mode);
  const jobs = plural(total, "job", "jobs");
  const leftOutPart = leftOut > 0 ? ` · ${leftOut} not applied` : "";
  switch (queue.state) {
    case "running":
      return {
        title: `${verb.doing} ${jobs}`,
        detail: `${started} started · ${toGo} to go · ten at a time${leftOutPart}`,
        active: true,
        primary: { label: "Pause", action: "pause" },
        secondary: { label: "Stop", action: "stop" },
      };
    case "paused":
      return {
        title: `${verb.doing} ${jobs} · paused`,
        detail:
          (queue.pausedReason
            ? firstSentence(queue.pausedReason)
            : `${started} started · ${toGo} to go${queue.activeRunId ? " · the ones already started finish" : ""}`) +
          leftOutPart,
        active: false,
        primary: { label: "Continue", action: "continue" },
        secondary: { label: "Stop", action: "stop" },
      };
    case "stopped":
      return {
        title: `Stopped ${verb.doing.toLowerCase()} ${jobs}`,
        detail: options.results
          ? describeOutcomes(
              countApplyQueueOutcomes(queue, options.results),
              queue.mode,
            )
          : `${started} started · ${toGo} not started${leftOutPart}`,
        active: false,
        primary: null,
        secondary: { label: "Dismiss", action: "dismiss" },
      };
    case "done": {
      if (!options.results) {
        return {
          title: `${verb.done} ${plural(started, "job", "jobs")}`,
          detail:
            leftOut > 0
              ? `${leftOut} not applied.`
              : "Check each one in Applications.",
          active: false,
          primary: null,
          secondary: { label: "Dismiss", action: "dismiss" },
        };
      }
      const outcomes = countApplyQueueOutcomes(queue, options.results);
      // The title counts only what the mode's verb is true of: a sent
      // application in Send for me, a filled-in one in the other modes.
      const succeeded =
        queue.mode === "autonomous_submit"
          ? outcomes.sent
          : outcomes.sent + outcomes.readyForYou;
      return {
        title:
          succeeded === total
            ? `${verb.done} ${jobs}`
            : succeeded === 0
              ? `Apply queue finished · none ${queue.mode === "autonomous_submit" ? "sent" : "filled in"}`
              : `${verb.done} ${succeeded} of ${jobs}`,
        detail: describeOutcomes(outcomes, queue.mode),
        active: false,
        primary: null,
        secondary: { label: "Dismiss", action: "dismiss" },
      };
    }
    default:
      return null;
  }
}
