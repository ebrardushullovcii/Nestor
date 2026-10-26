import { RetrySourceInputSchema } from "./source-access";
import { z } from "zod";
import type { AppCommandDefinition } from "./app-commands";

import {
  JobIdSchema,
  JobListQuerySchema,
  JobSearchSettingsSchema,
  JobSearchSourceQuerySchema,
  type JobSearchSourcePage,
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
      "Shortlist, hide or move back to Find jobs: some jobs by id, or every job a filter matches except some. Only jobs in found, hidden or shortlisted move, plus approved jobs moving back to Find jobs, which takes their approval away until undo_move. Returns a moveId for undo_move.",
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
      "One indexed page of the person's job sites, with text and enabled/disabled/attention filters, matching counts and a next cursor. Use filter=enabled for search selection; pass sites:{ids:[...]} to start_search, or sites:{all:true,except:[...]} for all except a few.",
    input: JobSiteListQuerySchema,
  },
  get_site: {
    effect: "read",
    description:
      "One job site with its address, preferences, health and saved guidance metadata.",
    input: z.object({ id: JobSiteSchema.shape.id }).strict(),
  },
  add_sites: {
    effect: "local_write",
    description:
      "Adds job-site URLs from pasted text and turns them on. Reports duplicates and invalid entries without changing existing sites.",
    input: AddJobSitesInputSchema,
  },
  update_site: {
    effect: "local_write",
    description:
      "Updates only one site's name, address, enabled state or custom instructions.",
    input: UpdateJobSiteInputSchema,
  },
  remove_site: {
    effect: "local_write",
    description:
      "Removes one job site from the person's list. Saved jobs remain.",
    input: z.object({ id: JobSiteSchema.shape.id }).strict(),
  },
  undo_site_change: {
    effect: "local_write",
    description:
      "Undoes one site change, keeping later edits and saved jobs. Returns changed and skipped counts.",
    input: z.object({ undoId: z.number().int().positive() }).strict(),
  },
  set_sites_enabled: {
    effect: "local_write",
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
  retry_source: {
    effect: "external",
    description:
      "Retries just one job site after you open it and finish sign-in or verification. Leaves its Needs you item open until the site can actually be read; other sites keep running.",
    input: RetrySourceInputSchema,
  },
  stop_search: {
    effect: "local_write",
    description: "Stops the running search. Jobs already found stay.",
    input: NoInputSchema,
  },
  list_search_sources: {
    effect: "read",
    description:
      "One page of a search's per-site results and coverage, with a text or status filter. Does not load all sites into the screen.",
    input: JobSearchSourceQuerySchema,
  },
  search_status: {
    effect: "read",
    description:
      "The running or last search: its choices, counts and per-site progress.",
    input: NoInputSchema,
  },
} as const satisfies Record<string, AppCommandDefinition>;

export interface SiteChange {
  undoId: number | null;
  undoCount: number;
}

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
  add_sites: AddJobSitesResult & SiteChange;
  update_site: (JobSite & SiteChange) | null;
  remove_site: { removed: boolean } & SiteChange;
  set_sites_enabled: { changed: number } & SiteChange;
  undo_site_change: { changed: number; skipped: number };
  start_search: JobSearchStatus;
  retry_source: JobSearchStatus;
  stop_search: JobSearchStatus;
  search_status: JobSearchStatus;
  list_search_sources: JobSearchSourcePage;
}

export type JobCommandOutput<K extends JobCommandName> = JobCommandOutputs[K];

export {
  JOBS_CHANGED_CHANNEL,
  JOBS_RUN_CHANNEL,
  JOBS_SEARCH_STATUS_CHANNEL,
  JOBS_SUBSCRIBE_CHANNEL,
} from "./ipc-channels";

/** The renderer's typed bridge to the job commands. */
export interface DesktopJobsBridge {
  run<K extends JobCommandName>(
    name: K,
    input: JobCommandInput<K>,
  ): Promise<JobCommandOutput<K>>;
  onChange(listener: (change: JobChange) => void): () => void;
  onSearchStatus(listener: (status: JobSearchStatus) => void): () => void;
}
