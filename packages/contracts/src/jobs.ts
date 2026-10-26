import { JobSiteSelectionSchema } from "./job-sites";
import { z } from "zod";

import { WorkModeSchema, type WorkMode } from "./base";

/**
 * Where a job is in the person's hunt. Every job has exactly one stage, kept
 * in one indexed column, so each screen lists and counts its own stage:
 *
 * - `found`: a search found it and nobody has decided yet (Find jobs)
 * - `hidden`: the person hid it; searches never bring it back
 * - `shortlisted`: picked; its resume is being written or reviewed
 * - `resume`: its resume is approved and Apply can take it
 * - `applied`: the application went out (Applications)
 */
export const jobStageValues = [
  "found",
  "hidden",
  "shortlisted",
  "resume",
  "applied",
] as const;
export const JobStageSchema = z.enum(jobStageValues);
export type JobStage = z.infer<typeof JobStageSchema>;

/** The stages a person moves jobs between while triaging Find jobs. */
export const triageStageValues = ["found", "hidden", "shortlisted"] as const;
export const TriageStageSchema = z.enum(triageStageValues);
export type TriageStage = z.infer<typeof TriageStageSchema>;

export const JobStageCountsSchema = z.object({
  found: z.number().int().nonnegative(),
  hidden: z.number().int().nonnegative(),
  shortlisted: z.number().int().nonnegative(),
  resume: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
});
export type JobStageCounts = z.infer<typeof JobStageCountsSchema>;

/**
 * `best_fit`: highest fit first, unscored last. `newest`: most recently found.
 * `posted`: most recently posted, unknown dates last. `recent`: most recently
 * moved into its stage (what you just hid or shortlisted comes first).
 */
export const jobSortValues = [
  "best_fit",
  "newest",
  "posted",
  "recent",
] as const;
export const JobSortSchema = z.enum(jobSortValues);
export type JobSort = z.infer<typeof JobSortSchema>;

/** A job's id in the store: a small positive integer. */
export const JobIdSchema = z.number().int().positive();

/** Which jobs of one stage a list shows. Every field maps to an indexed column. */
export const JobFilterSchema = z
  .object({
    stage: JobStageSchema,
    /** Only jobs this search found first. */
    searchId: z.string().min(1).max(200).nullable().default(null),
    /** Only jobs scored at least this fit, plus jobs not scored yet. */
    minFit: z.number().int().min(0).max(100).nullable().default(null),
    /** Words that must appear in the title, company or location. */
    text: z.string().max(200).default(""),
    /** Any of these work modes; empty means all. */
    workModes: z.array(WorkModeSchema).max(4).default([]),
  })
  .strict();
export type JobFilter = z.infer<typeof JobFilterSchema>;
export type JobFilterInput = z.input<typeof JobFilterSchema>;

export const JobListQuerySchema = JobFilterSchema.extend({
  sort: JobSortSchema.default("best_fit"),
  /** Opaque position from the previous page's `nextCursor`. */
  cursor: z.string().max(400).nullable().default(null),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();
export type JobListQuery = z.infer<typeof JobListQuerySchema>;
export type JobListQueryInput = z.input<typeof JobListQuerySchema>;

/** One list row: only what a list shows. */
export const JobRowSchema = z.object({
  id: JobIdSchema,
  stage: JobStageSchema,
  stageChangedAt: z.string(),
  /** Why the app put it in this stage, e.g. why a search hid it. */
  stageNote: z.string().nullable(),
  title: z.string(),
  company: z.string(),
  location: z.string(),
  workModes: z.array(WorkModeSchema),
  salaryText: z.string().nullable(),
  /** 0–100, or null until the job is scored. */
  fitScore: z.number().int().min(0).max(100).nullable(),
  /** One line on why it fits or not. */
  fitSummary: z.string().nullable(),
  postedAt: z.string().nullable(),
  foundAt: z.string(),
  /** The search that found it first. */
  searchId: z.string().nullable(),
  /** The site it was first found on. */
  sourceLabel: z.string(),
  /** How many sites list it. */
  sourceCount: z.number().int().positive(),
});
export type JobRow = z.infer<typeof JobRowSchema>;

export const JobListPageSchema = z.object({
  rows: z.array(JobRowSchema),
  nextCursor: z.string().nullable(),
  /** Jobs matching the filter. Beyond the stage alone, counted up to `JOB_TOTAL_CAP`. */
  total: z.number().int().nonnegative(),
  totalCapped: z.boolean(),
  counts: JobStageCountsSchema,
});
export type JobListPage = z.infer<typeof JobListPageSchema>;

/** A filtered count stops here so its cost never grows with the job count. */
export const JOB_TOTAL_CAP = 1000;

export const JobFitSchema = z.object({
  score: z.number().int().min(0).max(100),
  summary: z.string(),
  reasons: z.array(z.string()),
  gaps: z.array(z.string()),
  scoredAt: z.string(),
  role: z
    .object({ assessment: z.string(), explanation: z.string() })
    .optional(),
  preferences: z
    .object({ assessment: z.string(), explanation: z.string() })
    .optional(),
  coverage: z
    .object({ assessment: z.string(), explanation: z.string() })
    .optional(),
});
export type JobFit = z.infer<typeof JobFitSchema>;

export const JobSightingSchema = z.object({
  sourceId: z.string(),
  sourceLabel: z.string(),
  url: z.string(),
  applyUrl: z.string().nullable(),
  seenAt: z.string(),
});
export type JobSighting = z.infer<typeof JobSightingSchema>;

/** Listing facts a screen shows in detail and the resume writer reads. */
export const JobListingFactsSchema = z.object({
  keySkills: z.array(z.string()).default([]),
  responsibilities: z.array(z.string()).default([]),
  minimumQualifications: z.array(z.string()).default([]),
  preferredQualifications: z.array(z.string()).default([]),
  benefits: z.array(z.string()).default([]),
  department: z.string().nullable().default(null),
  team: z.string().nullable().default(null),
  employerDomain: z.string().nullable().default(null),
  atsProvider: z.string().nullable().default(null),
});
export type JobListingFacts = z.infer<typeof JobListingFactsSchema>;
export type JobListingFactsInput = z.input<typeof JobListingFactsSchema>;

export const JobDetailSchema = JobRowSchema.extend({
  url: z.string(),
  applyUrl: z.string().nullable(),
  seenAt: z.string(),
  description: z.string(),
  summary: z.string().nullable(),
  seniority: z.string().nullable(),
  employmentType: z.string().nullable(),
  salary: z
    .object({
      min: z.number().nullable(),
      max: z.number().nullable(),
      currency: z.string().nullable(),
    })
    .nullable(),
  facts: JobListingFactsSchema,
  fit: JobFitSchema.nullable(),
  sightings: z.array(JobSightingSchema),
});
export type JobDetail = z.infer<typeof JobDetailSchema>;

/** Some jobs by id, or every job a filter matches except a few. */
export const JobSelectionSchema = z.union([
  z.object({ ids: z.array(JobIdSchema).min(1).max(5000) }).strict(),
  z
    .object({
      filter: JobFilterSchema,
      except: z.array(JobIdSchema).max(5000).default([]),
    })
    .strict(),
]);
export type JobSelection = z.infer<typeof JobSelectionSchema>;
export type JobSelectionInput = z.input<typeof JobSelectionSchema>;

export const MoveJobsInputSchema = z
  .object({ selection: JobSelectionSchema, to: TriageStageSchema })
  .strict();
export type MoveJobsInput = z.infer<typeof MoveJobsInputSchema>;
export type MoveJobsInputValue = z.input<typeof MoveJobsInputSchema>;

export const UndoMoveInputSchema = z
  .object({ moveId: z.number().int().positive() })
  .strict();
export type UndoMoveInput = z.infer<typeof UndoMoveInputSchema>;

export const MoveJobsResultSchema = z.object({
  /** Pass to undo; null when nothing moved. */
  moveId: z.number().int().positive().nullable(),
  moved: z.number().int().nonnegative(),
  counts: JobStageCountsSchema,
});
export type MoveJobsResult = z.infer<typeof MoveJobsResultSchema>;

/**
 * Sent after every write so a screen refreshes only when it shows one of
 * these stages. `ids` names the jobs when there are few; null means many.
 */
export const JobChangeSchema = z.object({
  cause: z.enum([
    "found",
    "fit",
    "move",
    "undo",
    "stage",
    "application",
    "tracker",
    "resume",
    "sites",
  ]),
  stages: z.array(JobStageSchema),
  ids: z.array(JobIdSchema).nullable(),
  searchId: z.string().nullable(),
});
export type JobChange = z.infer<typeof JobChangeSchema>;

/** One job as a search found it on one site, before it is merged. */
export interface FoundJob {
  title: string;
  company: string;
  location: string;
  workModes: readonly WorkMode[];
  /** The listing page on the site where it was found. */
  url: string;
  applyUrl: string | null;
  /** The job site (source) it was found on. */
  sourceId: string;
  sourceLabel: string;
  /** The site's own id for the listing, when it shows one. */
  sourceJobId: string | null;
  postedAt: string | null;
  salaryText: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  seniority: string | null;
  employmentType: string | null;
  summary: string | null;
  description: string;
  facts?: JobListingFactsInput;
  /** Set when the search decided not to keep it: saved hidden, with this reason. */
  hiddenReason?: string;
}

export interface SaveFoundJobsResult {
  /** New jobs, in input order. They start in `found`. */
  added: number[];
  /** New jobs the search did not keep; saved hidden with their reason. */
  hidden: number[];
  /** Jobs already saved that this batch saw again. Their stage is kept. */
  merged: number[];
  /** The saved job for each input job, in input order. */
  ids: number[];
}

export interface JobFitUpdate extends Omit<JobFit, "scoredAt"> {
  id: number;
  scoredAt?: string;
}

/**
 * The few choices made before each search. `depth`: how long each site gets
 * (quick look or full search). `picky`: how close a fit the search looks for
 * and the list shows first. `postedWithin`: what to keep by listing age.
 */
export const JobSearchSettingsSchema = z
  .object({
    depth: z.enum(["quick", "thorough"]).default("quick"),
    sites: JobSiteSelectionSchema.default({ all: true, except: [] }),
    picky: z.enum(["open", "balanced", "strict"]).default("balanced"),
    postedWithin: z.enum(["week", "month", "any"]).default("month"),
    /** Anything specific for this search, in the person's words. */
    note: z.string().trim().max(500).default(""),
  })
  .strict();
export type JobSearchSettings = z.infer<typeof JobSearchSettingsSchema>;
export type JobSearchSettingsInput = z.input<typeof JobSearchSettingsSchema>;

/** The score bands used by fit judgments, labels and pickiness. */
export const JOB_FIT_BANDS = { strong: 85, good: 65, stretch: 40 } as const;

/** The lowest fit each pickiness shows first. */
export const PICKY_MIN_FIT: Record<JobSearchSettings["picky"], number | null> =
  { open: null, balanced: JOB_FIT_BANDS.good, strict: JOB_FIT_BANDS.strong };

export const jobSearchStateValues = [
  "running",
  "done",
  "stopped",
  "failed",
] as const;
export const JobSearchStateSchema = z.enum(jobSearchStateValues);
export type JobSearchState = z.infer<typeof JobSearchStateSchema>;

export const JobSearchRecordSchema = z.object({
  id: z.string(),
  state: JobSearchStateSchema,
  settings: JobSearchSettingsSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  sourcesTotal: z.number().int().nonnegative(),
  sourcesDone: z.number().int().nonnegative(),
  /** Listings read, before merging. */
  found: z.number().int().nonnegative(),
  /** New jobs saved. */
  added: z.number().int().nonnegative(),
  /** Listings that were jobs already saved. */
  merged: z.number().int().nonnegative(),
  scored: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type JobSearchRecord = z.infer<typeof JobSearchRecordSchema>;

export const JobSearchSourceStateSchema = z.object({
  sourceId: z.string(),
  label: z.string(),
  state: z.enum([
    "waiting",
    "searching",
    "done",
    "failed",
    "needs_you",
    "stopped",
  ]),
  found: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  /** New listings the search did not keep (saved hidden). */
  hidden: z.number().int().nonnegative(),
  /** What it is doing or why it stopped, in a few words. */
  message: z.string().nullable(),
});
export type JobSearchSourceState = z.infer<typeof JobSearchSourceStateSchema>;

export const JobSearchSourceRowSchema = JobSearchSourceStateSchema.extend({
  url: z.string(),
  lane: z.enum(["http", "browser"]).nullable(),
  phase: z.enum(["http", "browser", "screening", "reading"]).nullable(),
  cards: z.number().int().nonnegative(),
  related: z.number().int().nonnegative(),
  unrelated: z.number().int().nonnegative(),
  seen: z.number().int().nonnegative(),
  failedReads: z.number().int().nonnegative(),
});
export type JobSearchSourceRow = z.infer<typeof JobSearchSourceRowSchema>;
export const JobSearchSourceQuerySchema = z
  .object({
    searchId: z.string().nullable().default(null),
    text: z.string().trim().max(200).default(""),
    state: JobSearchSourceStateSchema.shape.state.nullable().default(null),
    after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();
export type JobSearchSourceQuery = z.input<typeof JobSearchSourceQuerySchema>;
export const JobSearchSourcePageSchema = z.object({
  rows: z.array(JobSearchSourceRowSchema),
  nextCursor: z.number().int().positive().nullable(),
  total: z.number().int().nonnegative(),
});
export type JobSearchSourcePage = z.infer<typeof JobSearchSourcePageSchema>;
export const JobSearchProgressSchema = z.object({
  httpQueued: z.number(),
  httpActive: z.number(),
  browserQueued: z.number(),
  browserActive: z.number(),
  processing: z.number(),
  fitQueued: z.number(),
  fitActive: z.number(),
  needsYou: z.number(),
  failed: z.number(),
});

export type JobSearchProgress = z.infer<typeof JobSearchProgressSchema>;

/** A bounded active sample; the paged site-results command owns the complete list. */
export const JobSearchStatusSchema = z.object({
  search: JobSearchRecordSchema.nullable(),
  sources: z.array(JobSearchSourceStateSchema).max(3),
  progress: JobSearchProgressSchema.nullable(),
  sourceRevision: z.number().int().nonnegative(),
});
export type JobSearchStatus = z.infer<typeof JobSearchStatusSchema>;
