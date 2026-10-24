import { z } from "zod";
import { ApplicationStatusSchema, NonEmptyStringSchema, WorkModeSchema } from "./base";
import type { ApplicationStatus } from "./base";
import type { SavedJob, JobFinderJobDetail } from "./discovery";
import type { CompanyEntity } from "./job-finder-intelligence";
import type { JobFinderRendererWorkspaceSnapshot } from "./workspace";

export const WorkspaceJobListSchema = z.enum([
  "discovery",
  "dismissed",
  "shortlisted",
  "applications",
  "company",
  "all",
]);
export type WorkspaceJobList = z.infer<typeof WorkspaceJobListSchema>;
export const WorkspacePageSchema = z
  .object({
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict()
  .default({});
export const QueryJobListInputSchema = z
  .object({
    list: WorkspaceJobListSchema,
    filters: z
      .object({
        planId: NonEmptyStringSchema.nullable().optional(),
        companyId: NonEmptyStringSchema.optional(),
        statuses: z.array(ApplicationStatusSchema).max(20).optional(),
        sources: z.array(NonEmptyStringSchema).max(100).optional(),
      workModes: z.array(WorkModeSchema).max(10).optional(),
        minimumScore: z.number().min(0).max(100).optional(),
        maximumScore: z.number().min(0).max(100).optional(),
      })
      .strict()
      .default({}),
    sort: z
      .enum(["best_match", "newest", "title", "company", "recently_seen"])
      .default("best_match"),
    search: z.string().max(500).default(""),
    page: WorkspacePageSchema,
  })
  .strict();
export type QueryJobListInput = z.input<typeof QueryJobListInputSchema>;
export const QueryCompaniesInputSchema = z
  .object({
    search: z.string().max(500).default(""),
    page: WorkspacePageSchema,
  })
  .strict()
  .default({});
export type QueryCompaniesInput = z.input<typeof QueryCompaniesInputSchema>;

/** Actual list columns; never a partial SavedJob disguised as a full record. */
export type WorkspaceJobListRow = Pick<
  SavedJob,
  | "id"
  | "status"
  | "title"
  | "company"
  | "location"
  | "source"
  | "sourceJobId"
  | "canonicalUrl"
  | "applicationUrl"
  | "workMode"
  | "postedAt"
  | "postedAtText"
  | "discoveredAt"
  | "firstSeenAt"
  | "lastSeenAt"
  | "salaryText"
  | "detailQuality"
  | "resumeApplicationMode"
  | "resumeTailoringMode"
> & {
  planId: string | null;
  score: number;
  recommendation: SavedJob["matchAssessment"]["recommendation"];
  judged: boolean;
  scoreIsUpperBound: boolean;
  titleFamilyMatch: SavedJob["matchAssessment"]["titleFamilyMatch"] | null;
  locationReach: SavedJob["matchAssessment"]["locationReach"];
  listingClosed: boolean;
};
export interface WorkspaceListCounts {
  discovery: number;
  dismissed: number;
  shortlisted: number;
  applications: number;
  companies: number;
  all: number;
}
export interface WorkspaceEntitySummary {
  id: string;
  jobId: string;
  status: string;
  updatedAt: string;
  approvedAt: string | null;
  approvedExportId: string | null;
  staleReason: string | null;
  stage: string | null;
  returnedToShortlistAt: string | null;
  runId: string | null;
  lastActionLabel: string | null;
  nextActionLabel: string | null;
}
export interface QueryJobListResult {
  rows: WorkspaceJobListRow[];
  total: number;
  counts: WorkspaceListCounts;
  revision: number;
  resumeDrafts: WorkspaceEntitySummary[];
  applications: WorkspaceEntitySummary[];
  applyResults: WorkspaceEntitySummary[];
}
export interface WorkspaceHomeSummary {
  counts: WorkspaceListCounts;
  revision: number;
  resumesToReview: number;
  resumesApproved: number;
  activePlanId: string | null;
  searchRunning: boolean;
  applicationsByStatus: Record<string, number>;
}
export interface WorkspaceCompanySummary {
  id: string;
  canonicalName: string;
  preference: CompanyEntity["preference"];
  jobCount: number;
  applicationCount: number;
  updatedAt: string;
}
export interface QueryCompaniesResult {
  rows: WorkspaceCompanySummary[];
  total: number;
  revision: number;
}
export interface WorkspaceChange {
  revision: number;
  table: string;
  id: string;
  operation: "upsert" | "delete";
}
export interface WorkspaceChanges {
  changes: WorkspaceChange[];
  revision: number;
  hasMore: boolean;
  lists: WorkspaceJobList[];
}
export type WorkspaceStartupContext = Pick<
  JobFinderRendererWorkspaceSnapshot,
  | "profile"
  | "searchPreferences"
  | "profileSetupState"
  | "settings"
  | "campaigns"
  | "activeCampaignId"
  | "activityControl"
>;

export const WorkspaceReadRequestSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("getStartupContext"),
    input: z.object({}).strict(),
  }),
  z.object({
    method: z.literal("queryJobList"),
    input: QueryJobListInputSchema,
  }),
  z.object({
    method: z.literal("getJobDetail"),
    input: z
      .object({
        jobId: NonEmptyStringSchema,
        planId: NonEmptyStringSchema.nullable().default(null),
      })
      .strict(),
  }),
  z.object({
    method: z.literal("getCompanyDetail"),
    input: z.object({ companyId: NonEmptyStringSchema }).strict(),
  }),
  z.object({
    method: z.literal("getHomeSummary"),
    input: z
      .object({ planId: NonEmptyStringSchema.nullable().optional() })
      .strict(),
  }),
  z.object({
    method: z.literal("getListCounts"),
    input: z
      .object({ planId: NonEmptyStringSchema.nullable().optional() })
      .strict(),
  }),
  z.object({
    method: z.literal("queryCompanies"),
    input: QueryCompaniesInputSchema,
  }),
  z.object({
    method: z.literal("getChanges"),
    input: z
      .object({
        after: z.number().int().nonnegative(),
        limit: z.number().int().min(1).max(2000).default(500),
      })
      .strict(),
  }),
]);
export type WorkspaceReadRequest = z.infer<typeof WorkspaceReadRequestSchema>;
export interface WorkspaceQueryApi {
  getStartupContext(): Promise<WorkspaceStartupContext>;
  queryJobList(input: QueryJobListInput): Promise<QueryJobListResult>;
  getJobDetail(
    jobId: string,
    planId?: string | null,
  ): Promise<JobFinderJobDetail | null>;
  getCompanyDetail(companyId: string): Promise<CompanyEntity | null>;
  getHomeSummary(input?: {
    planId?: string | null;
  }): Promise<WorkspaceHomeSummary>;
  getListCounts(input?: {
    planId?: string | null;
  }): Promise<WorkspaceListCounts>;
  queryCompanies(input?: QueryCompaniesInput): Promise<QueryCompaniesResult>;
  getChanges(after: number, limit?: number): Promise<WorkspaceChanges>;
  onChanges(listener: (changes: WorkspaceChanges) => void): () => void;
}

// Useful to consumers without importing the larger saved-job contracts.
export type WorkspaceJobStatus = ApplicationStatus;
