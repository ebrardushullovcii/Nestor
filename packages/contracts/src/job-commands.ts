import { z } from "zod";

import {
  JobIdSchema,
  JobListQuerySchema,
  JobSearchSettingsSchema,
  MoveJobsInputSchema,
  UndoMoveInputSchema,
  type JobChange,
  type JobDetail,
  type JobListPage,
  type JobSearchStatus,
  type JobSite,
  type JobStageCounts,
  type MoveJobsResult,
} from "./jobs";

const NoInputSchema = z.object({}).strict();

/**
 * Every Job Finder job command: the screens call them over the preload
 * bridge and the side-chat Assistant calls the same ones as tools, so the
 * descriptions are written for both.
 */
export const JOB_COMMANDS = {
  list_jobs: {
    description:
      "One page of jobs in one stage (found = Find jobs inbox, hidden, shortlisted, resume = ready to apply, applied), with filters, a sort, the matching total and every stage's count. Pass nextCursor back as cursor for the next page.",
    input: JobListQuerySchema,
  },
  get_job: {
    description:
      "One job in full: listing text, salary, every site that lists it, and its fit score with reasons and gaps.",
    input: z.object({ id: JobIdSchema }).strict(),
  },
  stage_counts: {
    description: "How many jobs are in each stage.",
    input: NoInputSchema,
  },
  move_jobs: {
    description:
      "Shortlist, hide or move back to Find jobs: some jobs by id, or every job a filter matches except some. Only jobs in found, hidden or shortlisted move. Returns a moveId for undo_move.",
    input: MoveJobsInputSchema,
  },
  undo_move: {
    description:
      "Puts the jobs of one move back where each was, unless something moved them since.",
    input: UndoMoveInputSchema,
  },
  list_sites: {
    description:
      "The person's job sites a search can use: the ones turned on in Profile. Pass some ids as sourceIds to start_search to search only those.",
    input: NoInputSchema,
  },
  start_search: {
    description:
      "Starts a background search of the person's job sites. depth: quick look or thorough; picky: open, balanced or strict; postedWithin: week, month or any; note: anything specific. Jobs appear in found as they are found. Returns at once.",
    input: JobSearchSettingsSchema,
  },
  stop_search: {
    description: "Stops the running search. Jobs already found stay.",
    input: NoInputSchema,
  },
  search_status: {
    description:
      "The running or last search: its choices, counts and per-site progress.",
    input: NoInputSchema,
  },
} as const;

export type JobCommandName = keyof typeof JOB_COMMANDS;

export type JobCommandInput<K extends JobCommandName> = z.input<
  (typeof JOB_COMMANDS)[K]["input"]
>;

export interface JobCommandOutputs {
  list_jobs: JobListPage;
  get_job: JobDetail | null;
  stage_counts: JobStageCounts;
  move_jobs: MoveJobsResult;
  undo_move: MoveJobsResult;
  list_sites: { sites: JobSite[] };
  start_search: JobSearchStatus;
  stop_search: JobSearchStatus;
  search_status: JobSearchStatus;
}

export type JobCommandOutput<K extends JobCommandName> = JobCommandOutputs[K];

export const JOBS_RUN_CHANNEL = "jobs:run";
export const JOBS_CHANGED_CHANNEL = "jobs:changed";
export const JOBS_SEARCH_STATUS_CHANNEL = "jobs:search-status";
/** A window asks once to hear changes and search progress. */
export const JOBS_SUBSCRIBE_CHANNEL = "jobs:subscribe";

/** The renderer's typed bridge to the job commands. */
export interface DesktopJobsBridge {
  run<K extends JobCommandName>(
    name: K,
    input: JobCommandInput<K>,
  ): Promise<JobCommandOutput<K>>;
  onChange(listener: (change: JobChange) => void): () => void;
  onSearchStatus(listener: (status: JobSearchStatus) => void): () => void;
}
