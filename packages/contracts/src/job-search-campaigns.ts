import { z } from "zod";
import { IsoDateTimeSchema, NonEmptyStringSchema } from "./base";
import { CampaignNotificationSchema } from "./campaign-operations";
import {
  DISCOVERY_RUN_JOB_BUDGET_MAX,
  JobSearchPreferencesSchema,
} from "./discovery";

export const JobSearchCampaignModeSchema = z.enum(["precision", "scale"]);
export type JobSearchCampaignMode = z.infer<typeof JobSearchCampaignModeSchema>;

/**
 * Legacy scale-campaign budget, kept for callers with an explicit numeric
 * choice. New campaigns have no per-run count cap in either mode.
 */
export const DEFAULT_SCALE_CAMPAIGN_DISCOVERY_RUN_JOB_BUDGET = 1_000;

export const JobSearchCampaignStatusSchema = z.enum([
  "active",
  "paused",
  "completed",
  "archived",
]);
export type JobSearchCampaignStatus = z.infer<
  typeof JobSearchCampaignStatusSchema
>;

export const JobSearchCampaignLimitsSchema = z.object({
  retainedJobTarget: z.number().int().min(1).max(10_000),
  analysisConcurrency: z.number().int().min(1).max(20),
  /** @deprecated Parsed and round-tripped for persisted campaigns; runtime uses a fixed global safeguard. */
  preparationBatchSize: z.number().int().min(1).max(500),
  /** @deprecated Parsed and round-tripped for persisted campaigns; runtime uses a fixed global safeguard. */
  dailyPreparationLimit: z.number().int().min(1).max(5_000).nullable(),
  /**
   * Explicit per-run discovery budget for campaign runs. `null` means no
   * count cap in either mode. A person's numeric choice is hard-capped by
   * `DISCOVERY_RUN_JOB_BUDGET_MAX`.
   */
  discoveryRunJobBudget: z
    .number()
    .int()
    .min(1)
    .max(DISCOVERY_RUN_JOB_BUDGET_MAX)
    .nullish(),
});
export type JobSearchCampaignLimits = z.infer<
  typeof JobSearchCampaignLimitsSchema
>;

export const JobSearchCampaignStopRulesSchema = z.object({
  pauseOnLoginRequired: z.boolean(),
  pauseOnChangedForm: z.boolean(),
  pauseOnUncertainEligibility: z.boolean(),
  pauseOnFailureRatePercent: z.number().int().min(1).max(100),
  failureRateMinimumSample: z.number().int().min(1).max(1_000),
});
export type JobSearchCampaignStopRules = z.infer<
  typeof JobSearchCampaignStopRulesSchema
>;

export const JobSearchCampaignApplicationPolicySchema = z.object({
  resumeStrategy: z.enum(["job_specific", "job_family_variants"]),
  defaultResumeStrategyId: NonEmptyStringSchema.nullable().optional(),
  /** @deprecated Parsed and round-tripped for persisted campaigns; preparation review remains product-required. */
  requireReviewBeforePreparation: z.boolean(),
  requireReviewBeforeExternalWrite: z.literal(true).default(true),
  finalSubmitAuthorized: z.literal(false).default(false),
  /**
   * Fraction of a prepared automatic queue that must be reviewed before the
   * queue can be treated as quality-checked. The default keeps persisted
   * campaigns from gaining a new required field during migration.
   */
  qualityReviewSampleRatio: z.number().min(0).max(1).default(0.2),
  /** The active window used when comparing verified submissions for conflicts. */
  simultaneousApplicationWindowDays: z
    .number()
    .int()
    .min(1)
    .max(365)
    .default(1),
});
export type JobSearchCampaignApplicationPolicy = z.infer<
  typeof JobSearchCampaignApplicationPolicySchema
>;

export const JobSearchCampaignProgressSchema = z.object({
  jobsFound: z.number().int().nonnegative().default(0),
  jobsRetained: z.number().int().nonnegative().default(0),
  applicationsPrepared: z.number().int().nonnegative().default(0),
  applicationsApplied: z.number().int().nonnegative().default(0),
  currentBatchCompleted: z.number().int().nonnegative().default(0),
  currentBatchTotal: z.number().int().nonnegative().default(0),
  blockedCount: z.number().int().nonnegative().default(0),
  remainingQueueSize: z.number().int().nonnegative().default(0),
  lastRunAt: IsoDateTimeSchema.nullable().default(null),
  lastUpdatedAt: IsoDateTimeSchema,
});
export type JobSearchCampaignProgress = z.infer<
  typeof JobSearchCampaignProgressSchema
>;

export const JobSearchCampaignHistoryEntrySchema = z.object({
  id: NonEmptyStringSchema,
  campaignId: NonEmptyStringSchema,
  kind: z.enum([
    "created",
    "updated",
    "activated",
    "paused",
    "resumed",
    "completed",
    "discovery_run",
  ]),
  occurredAt: IsoDateTimeSchema,
  summary: NonEmptyStringSchema,
  discoveryRunId: NonEmptyStringSchema.nullable().default(null),
});
export type JobSearchCampaignHistoryEntry = z.infer<
  typeof JobSearchCampaignHistoryEntrySchema
>;

export const JobSearchCampaignSchema = z.object({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  description: z.string().trim().max(2_000).default(""),
  mode: JobSearchCampaignModeSchema,
  status: JobSearchCampaignStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  searchPreferences: JobSearchPreferencesSchema,
  sourceTargetIds: z.array(NonEmptyStringSchema).default([]),
  // Missing on older plans: an empty include list inherited Profile.
  sourceSelectionMode: z.enum(["profile", "selected"]).optional(),
  jobIds: z.array(NonEmptyStringSchema).default([]),
  minimumFitScore: z.number().int().min(0).max(100).nullable().default(null),
  limits: JobSearchCampaignLimitsSchema,
  stopRules: JobSearchCampaignStopRulesSchema,
  applicationPolicy: JobSearchCampaignApplicationPolicySchema,
  progress: JobSearchCampaignProgressSchema,
  history: z.array(JobSearchCampaignHistoryEntrySchema).default([]),
});
export type JobSearchCampaign = z.infer<typeof JobSearchCampaignSchema>;

/** The source IDs every plan card, editor and run uses. */
export function resolveCampaignSourceTargetIds(
  campaign: Pick<
    JobSearchCampaign,
    "searchPreferences" | "sourceTargetIds" | "sourceSelectionMode"
  >,
): string[] {
  const selectedIds = campaign.sourceTargetIds ?? [];
  const followsProfile =
    campaign.sourceSelectionMode === "profile" ||
    (campaign.sourceSelectionMode === undefined && selectedIds.length === 0);
  return campaign.searchPreferences.discovery.targets
    .filter((target) =>
      followsProfile ? target.enabled : selectedIds.includes(target.id),
    )
    .map((target) => target.id);
}

export const JobSearchCampaignCollectionSchema = z
  .object({
    activeCampaignId: NonEmptyStringSchema,
    campaigns: z.array(JobSearchCampaignSchema).min(1),
    notifications: z.array(CampaignNotificationSchema).max(5_000).default([]),
  })
  .superRefine((collection, context) => {
    if (
      !collection.campaigns.some(
        (campaign) => campaign.id === collection.activeCampaignId,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeCampaignId"],
        message: "The active campaign must exist in the campaign collection.",
      });
    }
  });
export type JobSearchCampaignCollection = z.infer<
  typeof JobSearchCampaignCollectionSchema
>;

export const JobFinderActivityControlSchema = z.object({
  paused: z.boolean().default(false),
  pausedAt: IsoDateTimeSchema.nullable().default(null),
  reason: z.string().trim().max(500).nullable().default(null),
  pauseBehavior: z.enum(["finish_current"]).optional(),
});
export type JobFinderActivityControl = z.infer<
  typeof JobFinderActivityControlSchema
>;

export const SetJobFinderActivityControlInputSchema = z.object({
  paused: z.boolean(),
  reason: z.string().trim().max(500).nullable().optional(),
  pauseBehavior: z.enum(["finish_current"]).optional(),
});
export type SetJobFinderActivityControlInput = z.infer<
  typeof SetJobFinderActivityControlInputSchema
>;

export const JobFinderDashboardRateSchema = z.object({
  numerator: z.number().int().nonnegative(),
  denominator: z.number().int().positive(),
  percent: z.number().min(0).max(100),
});

export const JobFinderDashboardSourceHealthSchema = z.object({
  healthy: z.number().int().nonnegative(),
  needsAttention: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const GlobalDailyApplicationPreparationCapacitySchema = z
  .object({
    limit: z.number().int().positive(),
    used: z.number().int().nonnegative(),
    legacyUncertain: z.number().int().nonnegative().default(0),
    remaining: z.number().int().nonnegative(),
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    resetsAt: IsoDateTimeSchema,
  })
  .superRefine((capacity, context) => {
    if (
      capacity.remaining !==
      Math.max(0, capacity.limit - capacity.used - capacity.legacyUncertain)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["remaining"],
        message:
          "Remaining capacity must equal max(0, limit - used - legacyUncertain).",
      });
    }
  });
export type GlobalDailyApplicationPreparationCapacity = z.infer<
  typeof GlobalDailyApplicationPreparationCapacitySchema
>;

export const JobFinderDashboardSummarySchema = z.object({
  generatedAt: IsoDateTimeSchema,
  activeCampaignId: NonEmptyStringSchema,
  activeCampaignCount: z.number().int().nonnegative(),
  jobsFoundToday: z.number().int().nonnegative(),
  jobsAwaitingReview: z.number().int().nonnegative(),
  applicationsReadyForApproval: z.number().int().nonnegative(),
  applicationsAppliedToday: z.number().int().nonnegative(),
  applicationsAppliedThisWeek: z.number().int().nonnegative(),
  needsYouCount: z.number().int().nonnegative(),
  upcomingInterviews: z.number().int().nonnegative(),
  upcomingFollowUps: z.number().int().nonnegative(),
  responseRate: JobFinderDashboardRateSchema.nullable(),
  interviewRate: JobFinderDashboardRateSchema.nullable(),
  sourceHealth: JobFinderDashboardSourceHealthSchema,
  backgroundOperationCount: z.number().int().nonnegative(),
  globalDailyApplicationPreparationCapacity:
    GlobalDailyApplicationPreparationCapacitySchema.nullable().default(null),
  recommendedNextAction: z.object({
    label: NonEmptyStringSchema,
    detail: NonEmptyStringSchema,
    route: NonEmptyStringSchema,
  }),
});
export type JobFinderDashboardSummary = z.infer<
  typeof JobFinderDashboardSummarySchema
>;

export function getDefaultCampaignConfiguration(mode: JobSearchCampaignMode) {
  return mode === "precision"
    ? {
        limits: {
          // A search keeps what it finds. The old fifteen-job cap made a
          // three-source search show ten results out of sixty-nine.
          retainedJobTarget: 10_000,
          analysisConcurrency: 2,
          preparationBatchSize: 5,
          dailyPreparationLimit: 20,
          discoveryRunJobBudget: null,
        },
        stopRules: {
          pauseOnLoginRequired: false,
          pauseOnChangedForm: true,
          pauseOnUncertainEligibility: true,
          pauseOnFailureRatePercent: 30,
          failureRateMinimumSample: 5,
        },
        applicationPolicy: {
          resumeStrategy: "job_specific" as const,
          requireReviewBeforePreparation: true,
          requireReviewBeforeExternalWrite: true as const,
          finalSubmitAuthorized: false as const,
          qualityReviewSampleRatio: 0.2,
          simultaneousApplicationWindowDays: 1,
        },
      }
    : {
        limits: {
          retainedJobTarget: 10_000,
          analysisConcurrency: 6,
          preparationBatchSize: 25,
          dailyPreparationLimit: 100,
          discoveryRunJobBudget: null,
        },
        stopRules: {
          pauseOnLoginRequired: false,
          pauseOnChangedForm: true,
          pauseOnUncertainEligibility: true,
          pauseOnFailureRatePercent: 20,
          failureRateMinimumSample: 10,
        },
        applicationPolicy: {
          resumeStrategy: "job_family_variants" as const,
          requireReviewBeforePreparation: false,
          requireReviewBeforeExternalWrite: true as const,
          finalSubmitAuthorized: false as const,
          qualityReviewSampleRatio: 0.2,
          simultaneousApplicationWindowDays: 1,
        },
      };
}
