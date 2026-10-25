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
    /** Only jobs scored at least this fit. */
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
  /** Jobs matching the filter, counted up to `JOB_TOTAL_CAP`. */
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
    "resume",
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
}

export interface SaveFoundJobsResult {
  /** New jobs, in input order. They start in `found`. */
  added: number[];
  /** Jobs already saved that this batch saw again. Their stage is kept. */
  merged: number[];
}

export interface JobFitUpdate extends Omit<JobFit, "scoredAt"> {
  id: number;
  scoredAt?: string;
}
