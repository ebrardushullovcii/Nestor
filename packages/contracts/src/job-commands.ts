import { z } from "zod";
import type { AppCommandDefinition } from "./app-commands";

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
  type JobStageCounts,
  type MoveJobsResult,
} from "./jobs";

import {
  AddJobSitesInputSchema,
  JobSiteListQuerySchema,
  JobSiteSchema,
  UpdateJobSiteInputSchema,
  SetJobSitesEnabledInputSchema,
  type AddJobSitesResult,
  type JobSite,
  type JobSitePage,
} from "./job-sites";

const NoInputSchema = z.object({}).strict();

/**
 * Every Job Finder job command: the screens call them over the preload
 * bridge and the side-chat Assistant calls the same ones as tools, so the
 * descriptions are written for both.
 */
export const JOB_COMMANDS = {
  list_jobs: {
    effect: "read",
    description:
      "One page of jobs in one stage (found = Find jobs inbox, hidden, shortlisted, resume = ready to apply, applied), with filters, a sort, the matching total and every stage's count. Pass nextCursor back as cursor for the next page.",
    input: JobListQuerySchema,
  },
  get_job: {
    effect: "read",
    description:
      "One job in full: listing text, salary, every site that lists it, and its fit score with reasons and gaps.",
    input: z.object({ id: JobIdSchema }).strict(),
  },
  stage_counts: {
    effect: "read",
    description: "How many jobs are in each stage.",
    input: NoInputSchema,
  },
  move_jobs: {
    effect: "local_write",
    description:
      "Shortlist, hide or move back to Find jobs: some jobs by id, or every job a filter matches except some. Only jobs in found, hidden or shortlisted move. Returns a moveId for undo_move.",
    input: MoveJobsInputSchema,
  },
  undo_move: {
    effect: "local_write",
    description:
      "Puts the jobs of one move back where each was, unless something moved them since.",
    input: UndoMoveInputSchema,
  },
  list_sites: {
    effect: "read",
    description:
      "One indexed page of the person's job sites, with text and enabled/disabled/attention filters, matching counts and a next cursor. Use enabled sites for search selection.",
    input: JobSiteListQuerySchema,
  },
  get_site: {
    description:
      "One job site with its address, preferences, health and saved guidance metadata.",
    input: z.object({ id: JobSiteSchema.shape.id }).strict(),
  },
  add_sites: {
    description:
      "Adds job-site URLs from pasted text and turns them on. Reports duplicates and invalid entries without changing existing sites.",
    input: AddJobSitesInputSchema,
  },
  update_site: {
    description:
      "Updates only one site's name, address, enabled state or custom instructions.",
    input: UpdateJobSiteInputSchema,
  },
  remove_site: {
    description:
      "Removes one job site from the person's list. Saved jobs remain.",
    input: z.object({ id: JobSiteSchema.shape.id }).strict(),
  },
  set_sites_enabled: {
    description:
      "Turns the selected sites on or off, including an entire filtered list except excluded ids. Writes only sites whose enabled state changes.",
    input: SetJobSitesEnabledInputSchema,
  },
  start_search: {
    effect: "external",
    description:
      "Starts a background search of the person's job sites. depth: quick look or thorough; picky: open, balanced or strict; postedWithin: week, month or any; note: anything specific. Jobs appear in found as they are found. Returns at once.",
    input: JobSearchSettingsSchema,
  },
  stop_search: {
    effect: "local_write",
    description: "Stops the running search. Jobs already found stay.",
    input: NoInputSchema,
  },
  search_status: {
    effect: "read",
    description:
      "The running or last search: its choices, counts and per-site progress.",
    input: NoInputSchema,
  },
} as const satisfies Record<string, AppCommandDefinition>;

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
  list_sites: JobSitePage;
  get_site: JobSite | null;
  add_sites: AddJobSitesResult;
  update_site: JobSite | null;
  remove_site: { removed: boolean };
  set_sites_enabled: { changed: number };
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
