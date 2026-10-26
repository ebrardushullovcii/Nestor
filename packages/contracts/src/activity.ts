import type { ApplicationWorkState } from "./applications";
import type { ResumeState } from "./resumes";

/**
 * What Job Finder is doing and what it just finished, read from the job
 * store for the Activity panel. It only reports: anything for the person to
 * do is in Needs you.
 */
export interface ActivitySearch {
  id: string;
  state: "running" | "done" | "stopped" | "failed";
  startedAt: string;
  finishedAt: string | null;
  sourcesDone: number;
  sourcesTotal: number;
  /** New jobs the search added. */
  added: number;
  error: string | null;
}

export interface ActivityResume {
  jobId: number;
  title: string;
  company: string;
  state: ResumeState;
  at: string;
  error: string | null;
}

export interface ActivityApplication {
  id: number;
  jobId: number;
  title: string;
  company: string;
  state: ApplicationWorkState;
  at: string;
  error: string | null;
}

export interface ActivityFeed {
  /** Newest first: running ones, then those finished in the last day. */
  searches: ActivitySearch[];
  resumes: ActivityResume[];
  applications: ActivityApplication[];
  /** Everything running now, beyond the rows listed: the button's count. */
  running: number;
}

export const ACTIVITY_FEED_CHANNEL = "activity:feed";
