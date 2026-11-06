import {
  CLOSED_TRACKER_STATUSES,
  TRACKER_STATUS_LABEL,
  type ApplicationWorkState,
  type TrackerFilterStatus,
  type TrackerRow,
  type TrackerStatus,
  type TrackerStatusCounts,
} from "@nestor/contracts";

import {
  formatDate,
  formatDateTime,
} from "@renderer/features/job-finder/lib/format-date";
import { APPLICATION_WORK_TONE } from "@renderer/features/job-finder/lib/application-status-tone";
import type { BadgeTone } from "@renderer/features/job-finder/lib/job-finder-types";

/** The board's columns and the list's status chips, in pipeline order. */
export const STAGE_GROUPS: readonly {
  id: string;
  label: string;
  statuses: readonly TrackerFilterStatus[];
  /** Shown only while it has applications (a chip, an option, a column). */
  onlyWhenAny?: boolean;
}[] = [
  { id: "applying", label: "Applying", statuses: ["applying"] },
  // Apply could not finish it and nothing was sent: its own place, never
  // counted as "Applying".
  {
    id: "not_sent",
    label: "Could not apply",
    statuses: ["not_sent"],
    onlyWhenAny: true,
  },
  { id: "applied", label: "Applied", statuses: ["applied"] },
  { id: "replied", label: "Heard back", statuses: ["replied"] },
  { id: "assessment", label: "Assessment", statuses: ["assessment"] },
  { id: "interview", label: "Interview", statuses: ["interview"] },
  { id: "offer", label: "Offer", statuses: ["offer"] },
  { id: "closed", label: "Closed", statuses: CLOSED_TRACKER_STATUSES },
];

/**
 * Each stage's mark, from the stage colours Home uses, so a stage looks the
 * same on Home and on the board, and each told apart by shape as well as
 * hue: Applying is a dashed ring (not sent yet), Applied a solid grey dot,
 * Closed an empty ring (over), and every live stage its own hue.
 */
export const STAGE_DOT: Record<
  string,
  { fill: string; edge?: string; ring?: "solid" | "dashed" }
> = {
  applying: {
    fill: "transparent",
    edge: "var(--chart-waiting)",
    ring: "dashed",
  },
  not_sent: {
    fill: "transparent",
    edge: "var(--warning-text)",
    ring: "solid",
  },
  applied: { fill: "var(--chart-waiting)" },
  replied: { fill: "var(--chart-heard-back)" },
  assessment: { fill: "var(--chart-assessment)" },
  interview: { fill: "var(--chart-interview)" },
  offer: { fill: "var(--chart-offer)" },
  closed: {
    fill: "transparent",
    edge: "var(--chart-closed-edge)",
    ring: "solid",
  },
};

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
  statuses: readonly TrackerFilterStatus[],
): number {
  return statuses.reduce((sum, status) => sum + (counts[status] ?? 0), 0);
}

/** The groups to offer now: one shown only while it has applications waits. */
export function shownGroups(counts: TrackerStatusCounts) {
  return STAGE_GROUPS.filter(
    (group) => !group.onlyWhenAny || countGroup(counts, group.statuses) > 0,
  );
}

/**
 * The date line under a row's status: "Applying since Nov 2" while Apply
 * works on it, "Tried Nov 2" once it could not finish, else "Since Nov 2".
 */
export function describeSince(
  row: Pick<TrackerRow, "status" | "work" | "statusAt">,
): string {
  const day = formatDate(row.statusAt);
  if (row.status !== "applying") return `Since ${day}`;
  return row.work === "failed" ? `Tried ${day}` : `Applying since ${day}`;
}

const WORK_LABEL: Record<ApplicationWorkState, string> = {
  queued: "Waiting to apply",
  running: "Filling in the form",
  needs_you: "Needs you",
  ready: "Ready to send",
  submitting: "Sending",
  submitted: "Applied",
  stopped: "Stopped",
  skipped: "Skipped",
  blocked: "Blocked",
  failed: "Could not apply",
  closed: "Posting closed",
  uncertain: "Sent? Check the site",
};

/** What Apply's work state means for the person, under the badge. */
export const WORK_HINT: Record<ApplicationWorkState, string> = {
  queued: "Apply will get to it soon, and it moves to Applied once sent.",
  running: "Apply is filling in the form.",
  needs_you: "Apply is waiting for an answer from you in Needs you.",
  ready: "Filled in and waiting for you to send it.",
  submitting: "Apply is sending it.",
  submitted: "Sent. It moves to Applied.",
  stopped: "Apply stopped.",
  skipped:
    "Your saved rule skipped this application. You can still open the job and apply by hand.",
  blocked:
    "The site blocked this browser. Open the job in your browser to continue by hand.",
  failed: "Apply couldn’t finish this application.",
  closed: "The employer is no longer accepting applications for this posting.",
  uncertain:
    "Apply could not tell whether it went through. Check the site, then say what you found.",
};

export function describeStatus(row: Pick<TrackerRow, "status" | "work">): {
  label: string;
  tone: BadgeTone;
} {
  if (row.status === "applying") {
    const work = row.work ?? "queued";
    return { label: WORK_LABEL[work], tone: APPLICATION_WORK_TONE[work] };
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

/** "Nov 2": the shared date wording (`formatDate`). */
export function formatDay(iso: string | null): string {
  return formatDate(iso);
}

/** "Nov 2, 1:08 PM": the shared date and time wording. */
export function formatWhen(iso: string | null): string {
  return formatDateTime(iso);
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

/** What comes next on an application with nothing scheduled, by its stage. */
const WORK_NEXT: Record<ApplicationWorkState, { text: string; act: boolean }> =
  {
    queued: { text: "Apply fills it in next", act: false },
    running: { text: "Apply is filling it in", act: false },
    needs_you: { text: "Answer in Needs you", act: true },
    ready: { text: "Review it and send", act: true },
    submitting: { text: "Apply is sending it", act: false },
    submitted: { text: "Moves to Applied", act: false },
    stopped: { text: "Stopped before sending", act: false },
    skipped: { text: "Apply by hand if you want it", act: false },
    blocked: { text: "Continue by hand in your browser", act: true },
    failed: { text: "Try again or apply by hand", act: true },
    closed: { text: "Posting closed", act: false },
    uncertain: { text: "Check the site", act: true },
  };

/**
 * A row's next step: the next interview or reminder when one is set, else
 * what its stage waits on. `act` marks a step that is the person's to take.
 * Closed applications have none.
 */
export function describeNext(
  row: Pick<TrackerRow, "status" | "work" | "nextAt" | "nextTitle">,
): { text: string; act: boolean } | null {
  if (row.nextAt)
    return {
      text: `${describeDue(row.nextAt)}: ${row.nextTitle ?? ""}`.replace(
        /: $/u,
        "",
      ),
      act: true,
    };
  if (row.status === "applying") return WORK_NEXT[row.work ?? "queued"];
  if (row.status === "applied")
    return { text: "Waiting for a reply", act: false };
  if (CLOSED_TRACKER_STATUSES.includes(row.status)) return null;
  return { text: "No next step set", act: false };
}
