import {
  CLOSED_TRACKER_STATUSES,
  TRACKER_STATUS_LABEL,
  type ApplicationWorkState,
  type TrackerRow,
  type TrackerStatus,
  type TrackerStatusCounts,
} from "@nestor/contracts";

import type { BadgeTone } from "@renderer/features/job-finder/lib/job-finder-types";

/** The board's columns and the list's status chips, in pipeline order. */
export const STAGE_GROUPS: readonly {
  id: string;
  label: string;
  statuses: readonly TrackerStatus[];
}[] = [
  { id: "applying", label: "Applying", statuses: ["applying"] },
  { id: "applied", label: "Applied", statuses: ["applied"] },
  { id: "replied", label: "Heard back", statuses: ["replied"] },
  { id: "assessment", label: "Assessment", statuses: ["assessment"] },
  { id: "interview", label: "Interview", statuses: ["interview"] },
  { id: "offer", label: "Offer", statuses: ["offer"] },
  { id: "closed", label: "Closed", statuses: CLOSED_TRACKER_STATUSES },
];

/** The statuses a person sets by hand, in order; closing has its own menu. */
export const OPEN_STATUSES: readonly TrackerStatus[] = [
  "applied",
  "replied",
  "assessment",
  "interview",
  "offer",
];

export function countGroup(
  counts: TrackerStatusCounts,
  statuses: readonly TrackerStatus[],
): number {
  return statuses.reduce((sum, status) => sum + counts[status], 0);
}

const WORK_LABEL: Record<ApplicationWorkState, string> = {
  queued: "Waiting to apply",
  running: "Filling in the form",
  needs_you: "Needs you",
  ready: "Ready to send",
  submitting: "Sending",
  submitted: "Sent",
  stopped: "Stopped",
  failed: "Could not apply",
  uncertain: "Sent? Check the site",
};

/** What Apply's work state means for the person, under the badge. */
export const WORK_HINT: Record<ApplicationWorkState, string> = {
  queued: "Apply will get to it soon, and it moves to Applied once sent.",
  running: "Apply is filling in the form.",
  needs_you: "Apply is waiting for an answer from you in Needs you.",
  ready: "Filled in and waiting for you to send it.",
  submitting: "Apply is sending it.",
  submitted: "Sent.",
  stopped: "Apply stopped before sending it.",
  failed: "Apply could not send it.",
  uncertain: "Apply could not tell whether it went through. Check the site.",
};

export function describeStatus(row: Pick<TrackerRow, "status" | "work">): {
  label: string;
  tone: BadgeTone;
} {
  if (row.status === "applying") {
    const work = row.work ?? "queued";
    return {
      label: WORK_LABEL[work],
      tone:
        work === "needs_you" || work === "uncertain"
          ? "warning"
          : work === "failed" || work === "stopped"
            ? "critical"
            : "active",
    };
  }
  const tone: BadgeTone =
    row.status === "offer"
      ? "positive"
      : row.status === "interview" || row.status === "assessment"
        ? "active"
        : CLOSED_TRACKER_STATUSES.includes(row.status)
          ? "muted"
          : "neutral";
  return { label: TRACKER_STATUS_LABEL[row.status], tone };
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatDay(iso: string | null): string {
  return iso ? dateFormat.format(new Date(iso)) : "";
}

export function formatWhen(iso: string | null): string {
  return iso ? dateTimeFormat.format(new Date(iso)) : "";
}

/** "Due now", "in 3 days", "tomorrow": how soon the next thing is. */
export function describeDue(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const days = Math.round((Date.parse(iso) - now) / 86_400_000);
  if (Date.parse(iso) <= now) return "Due now";
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}
