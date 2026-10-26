import type {
  ActivityFeed,
  ActivityMove,
  ApplicationWorkState,
  JobStage,
} from "@nestor/contracts";

import { JOB_FINDER_ROUTE_PATHS } from "../../lib/job-finder-route-hrefs";
import type { BadgeTone } from "../../lib/job-finder-types";

export type ActivityStatus = "running" | "done" | "stopped" | "failed";

/** One row of the Activity panel, in the words it shows. */
export interface ActivityItem {
  id: string;
  kind: "search" | "resume" | "application";
  status: ActivityStatus;
  title: string;
  detail: string;
  badge: string;
  tone: BadgeTone;
  /** The screen that shows this work. */
  href: string;
  at: string;
}

const APPLICATION_WORDS: Record<
  Exclude<ApplicationWorkState, "needs_you">,
  { status: ActivityStatus; badge: string; detail: string }
> = {
  queued: { status: "running", badge: "Waiting", detail: "Waiting to apply" },
  running: {
    status: "running",
    badge: "In progress",
    detail: "Filling in the form",
  },
  submitting: { status: "running", badge: "Sending", detail: "Sending it" },
  ready: {
    status: "done",
    badge: "Filled in",
    detail: "Filled in, ready for you to send",
  },
  submitted: { status: "done", badge: "Sent", detail: "Sent" },
  stopped: {
    status: "stopped",
    badge: "Stopped",
    detail: "Stopped before sending",
  },
  skipped: {
    status: "stopped",
    badge: "Skipped",
    detail: "Your saved rule skipped this application",
  },
  blocked: {
    status: "stopped",
    badge: "Blocked",
    detail: "The site refused this browser; open the job in your browser",
  },
  failed: { status: "failed", badge: "Failed", detail: "Could not apply" },
  uncertain: {
    status: "failed",
    badge: "Unclear",
    detail: "Sent? Check the site",
  },
};

/** The screen that lists a job where it is now. */
function jobHref(jobId: number, stage: JobStage): string {
  if (stage === "applied")
    return `${JOB_FINDER_ROUTE_PATHS.applications}?jobId=${jobId}`;
  if (stage === "shortlisted" || stage === "resume")
    return `${JOB_FINDER_ROUTE_PATHS.reviewQueue}?jobId=${jobId}`;
  return `${JOB_FINDER_ROUTE_PATHS.discovery}?job=${jobId}`;
}

function tone(status: ActivityStatus): BadgeTone {
  if (status === "running") return "active";
  if (status === "done") return "positive";
  // A run that failed can be tried again: amber, not red.
  if (status === "failed") return "warning";
  return "muted";
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

/** The feed as rows: what is running first, then what just finished. */
export function toActivityItems(feed: ActivityFeed): {
  running: ActivityItem[];
  finished: ActivityItem[];
} {
  const items: ActivityItem[] = [];
  for (const search of feed.searches) {
    const newJobs = plural(search.added, "new job");
    const status: ActivityStatus =
      search.state === "running"
        ? "running"
        : search.state === "done"
          ? "done"
          : search.state;
    items.push({
      id: `search:${search.id}:${search.state}`,
      kind: "search",
      status,
      title: "Job search",
      detail:
        search.state === "running"
          ? `${search.sourcesDone} of ${plural(search.sourcesTotal, "site")} read · ${newJobs}`
          : search.state === "failed"
            ? (search.error ?? "The search could not finish")
            : newJobs,
      badge:
        status === "running"
          ? "In progress"
          : status === "done"
            ? "Finished"
            : status === "stopped"
              ? "Stopped"
              : "Failed",
      tone: tone(status),
      href: JOB_FINDER_ROUTE_PATHS.discovery,
      at: search.finishedAt ?? search.startedAt,
    });
  }
  for (const resume of feed.resumes) {
    const status: ActivityStatus =
      resume.state === "ready"
        ? "done"
        : resume.state === "failed"
          ? "failed"
          : "running";
    items.push({
      id: `resume:${resume.jobId}:${resume.state}:${resume.at}`,
      kind: "resume",
      status,
      title: resume.title,
      detail: `${resume.company} · ${
        resume.state === "queued"
          ? "Resume waiting to be written"
          : resume.state === "writing"
            ? "Writing the resume"
            : resume.state === "ready"
              ? "Resume written"
              : (resume.error ?? "The resume could not be written")
      }`,
      badge:
        resume.state === "queued"
          ? "Waiting"
          : resume.state === "writing"
            ? "Writing"
            : resume.state === "ready"
              ? "Written"
              : "Failed",
      tone: tone(status),
      href: jobHref(resume.jobId, resume.stage),
      at: resume.at,
    });
  }
  for (const application of feed.applications) {
    // Waiting on the person belongs to Needs you; the store leaves it out.
    if (application.state === "needs_you") continue;
    const words = APPLICATION_WORDS[application.state];
    items.push({
      id: `application:${application.id}:${application.state}:${application.at}`,
      kind: "application",
      status: words.status,
      title: application.title,
      detail: `${application.company} · ${words.detail}`,
      badge: words.badge,
      tone: tone(words.status),
      href: `${JOB_FINDER_ROUTE_PATHS.applications}?jobId=${application.jobId}`,
      at: application.at,
    });
  }
  const newest = (a: ActivityItem, b: ActivityItem) => b.at.localeCompare(a.at);
  return {
    running: items.filter((item) => item.status === "running").sort(newest),
    finished: items.filter((item) => item.status !== "running").sort(newest),
  };
}

/** What a move did, in the words its button used. */
export function describeMove(move: ActivityMove): {
  title: string;
  detail: string;
} {
  const what = move.count === 1 ? move.title : plural(move.count, "job");
  const title =
    move.to === "shortlisted"
      ? `Shortlisted ${what}`
      : move.to === "hidden"
        ? `Hid ${what}`
        : `Moved ${what} back to Find jobs`;
  const detail =
    move.count === 1
      ? move.company
      : `${move.title} and ${plural(move.count - 1, "other")}`;
  return { title, detail };
}

/** How many of a move's jobs have moved on since, when some have. */
export function describeMovedOn(move: ActivityMove): string | null {
  const movedOn = move.count - move.stillThere;
  return movedOn > 0 && move.stillThere > 0
    ? `${plural(movedOn, "job")} moved on since`
    : null;
}

/**
 * What Undo did when some jobs had moved on since: those stay where they are.
 * Null when every job came back.
 */
export function describeUndo(
  move: ActivityMove,
  putBack: number,
): { title: string; description: string } | null {
  const movedOn = move.count - putBack;
  if (movedOn <= 0) return null;
  const stayed = `${movedOn === 1 ? "It" : "They"} stayed where ${movedOn === 1 ? "it is" : "they are"}.`;
  return putBack === 0
    ? {
        title: "Nothing to put back",
        description: `${move.count === 1 ? "This job" : `All ${move.count} jobs`} had moved on since. ${stayed}`,
      }
    : {
        title: `Put back ${plural(putBack, "job")}`,
        description: `${plural(movedOn, "job")} had moved on since. ${stayed}`,
      };
}
