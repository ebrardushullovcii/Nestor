import {
  listApplyQueueRemainingJobIds,
  type ApplicationAutomationMode,
  type ApplyQueue,
} from "@nestor/contracts";

export type ApplyQueueControlAction = "pause" | "continue" | "stop" | "dismiss";

export interface ApplyQueueViewButton {
  label: string;
  action: ApplyQueueControlAction | "raise_limit";
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
    !!queue &&
    (queue.state === "running" ||
      queue.state === "waiting_for_tomorrow" ||
      queue.state === "paused")
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

function formatResumeTime(iso: string | null): string {
  if (!iso) return "after midnight";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "after midnight";
  return at.getHours() === 0 && at.getMinutes() === 0
    ? "after midnight"
    : `at ${at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

export function describeApplyQueue(
  queue: ApplyQueue | null | undefined,
  options: { dailyLimit?: number | null } = {},
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
    case "waiting_for_tomorrow": {
      const limit = options.dailyLimit ?? null;
      return {
        title: `${verb.doing} ${jobs}`,
        detail: `${limit ? `Today's limit of ${limit} is reached` : "Today's limit is reached"} · ${toGo} continue ${formatResumeTime(queue.resumesAt)}${leftOutPart}`,
        active: false,
        primary: { label: "Raise the limit", action: "raise_limit" },
        secondary: { label: "Stop", action: "stop" },
      };
    }
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
        detail: `${started} started · ${toGo} not started${leftOutPart}`,
        active: false,
        primary: null,
        secondary: { label: "Dismiss", action: "dismiss" },
      };
    case "done":
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
    default:
      return null;
  }
}
