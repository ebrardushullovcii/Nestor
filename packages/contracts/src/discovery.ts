import {
  ApplyAgentTimingSchema,
  ApplicationApplyUsageTotalsSchema,
} from "./agent-timing";
import { ApplicationAnswerDependenciesSchema } from "./application-answer-dependencies";
import { z } from "zod";
import { ApplicationQuestionAskReasonSchema } from "./application-question-reason";

import { ApplicationAutomationModeSchema } from "./application-authority";

import {
  DiscoveryRunReportSchema,
  ApplicationAttemptStateSchema,
  ApplicationEventEmphasisSchema,
  ApplicationStatusSchema,
  ApprovalModeSchema,
  AssetGenerationMethodSchema,
  AssetGenerationReasonSchema,
  AssetStatusSchema,
  BrowserRunCloseoutSchema,
  BrowserRunWaitReasonSchema,
  BrowserDriverSchema,
  BrowserSessionStatusSchema,
  DiscoveryActivityKindSchema,
  DiscoveryRunScopeSchema,
  DiscoveryActivityStageSchema,
  DiscoveryActivityTerminalStateSchema,
  DiscoveryRunStateSchema,
  DiscoveryTitleTriageOutcomeSchema,
  DiscoveryTargetExecutionStateSchema,
  IsoDateTimeSchema,
  JobApplyPathSchema,
  JobDiscoveryCollectionMethodSchema,
  JobDiscoveryMethodSchema,
  JobSourceAdapterKindSchema,
  JobSourceSchema,
  NonEmptyStringSchema,
  ResumeApplicationModeSchema,
  SourceIntelligenceProviderKeySchema,
  SourceDebugPhaseCompletionModeSchema,
  SourceInstructionStatusSchema,
  TailoringModeSchema,
  UrlStringSchema,
  WorkModeListSchema,
} from "./base";
import {
  SourceDebugCompactionStateSchema,
  SourceDebugEvidenceRefSchema,
  SourceDebugPhaseEvidenceSchema,
  SourceDebugRunRecordSchema,
  SourceDebugWorkerAttemptSchema,
  SourceIntelligenceArtifactSchema,
  SourceInstructionArtifactSchema,
} from "./source-debug";
import { SharedAgentCompactionSnapshotSchema } from "./agent-compaction";
import {
  DiscoveryAccessBlockerReasonSchema,
  ParkedBrowserTabReferenceSchema,
  UserActionRequestKindSchema,
} from "./user-action";
import { ResumeExportFormatSchema } from "./resume";
import {
  BrowserVisualEvidenceSummarySchema,
  BrowserVisualObservationSetSchema,
  ApplyVisualCheckpointSchema,
} from "./visual";
import {
  ApplicationCrmDataSchema,
  isApplicationTrackedAsSentByPerson,
} from "./application-crm";
import { ApplicationListingSignalEvidenceSchema } from "./job-finder-intelligence";

export const JobDiscoveryTargetSchema = z.object({
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  startingUrl: UrlStringSchema,
  enabled: z.boolean().default(true),
  adapterKind: JobSourceAdapterKindSchema.default("auto"),
  customInstructions: NonEmptyStringSchema.nullable().default(null),
  instructionStatus: SourceInstructionStatusSchema.default("missing"),
  validatedInstructionId: NonEmptyStringSchema.nullable().default(null),
  draftInstructionId: NonEmptyStringSchema.nullable().default(null),
  lastDebugRunId: NonEmptyStringSchema.nullable().default(null),
  lastVerifiedAt: IsoDateTimeSchema.nullable().default(null),
  staleReason: NonEmptyStringSchema.nullable().default(null),
});
export type JobDiscoveryTarget = z.infer<typeof JobDiscoveryTargetSchema>;

export const JobFinderSearchRequestSchema = z.object({
  intent: z.string().trim().max(1_000).default(""),
  /** A run-scoped override of the saved search selectivity. */
  breadth: z.enum(["best_only", "wide"]).optional(),
  freshness: z.enum(["any", "recent"]).default("any"),
  sourceIds: z
    .union([z.literal("all"), z.array(NonEmptyStringSchema).min(1).max(1_000)])
    .default("all"),
});
export type JobFinderSearchRequest = z.infer<
  typeof JobFinderSearchRequestSchema
>;

/** Returns true only when a saved source can actually be used for discovery. */
export function isRunnableJobDiscoveryTarget(
  target: Pick<JobDiscoveryTarget, "enabled" | "startingUrl">,
): boolean {
  if (!target.enabled) {
    return false;
  }

  try {
    const url = new URL(target.startingUrl.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Hard cap for an explicitly configured discovery run budget. The interactive
 * default stays at the precision budget (100 jobs per run); explicit budgets
 * exist so scale campaigns can request high-volume runs without weakening fit
 * scoring or per-source fairness.
 */
export const DISCOVERY_RUN_JOB_BUDGET_MAX = 2_000;

const JobDiscoveryPreferencesObjectSchema = z.object({
  targets: z.array(JobDiscoveryTargetSchema).default([]),
  historyLimit: z.number().int().min(1).max(10).default(5),
  collectOnlyHardCriteriaMatches: z.boolean().default(false),
  /**
   * Explicit total valid-job budget for one discovery run across all enabled
   * targets. `null`/`undefined` retains all eligible listings collected with
   * the normal crawl safety ceilings; when set, the budget is split across
   * targets and raises the bounded crawl step/time ceilings proportionally.
   */
  runJobBudget: z
    .number()
    .int()
    .min(1)
    .max(DISCOVERY_RUN_JOB_BUDGET_MAX)
    .nullish(),
  /**
   * Run-time copy of Settings' "Count remote jobs as any location"
   * (`settings.aiBehavior.jobSearch.remoteCountsAsAnyLocation`), set by the
   * search and scoring code from the saved settings when they read the
   * preferences. Only `false` is ever set; absent means on. No save path
   * writes it.
   */
  remoteCountsAsAnyLocation: z.boolean().optional(),
});
type JobDiscoveryPreferencesInput = z.input<
  typeof JobDiscoveryPreferencesObjectSchema
>;
// Parsing normalizes the hard-criteria flag to its false default, while the
// public output type keeps it optional so preference literals that omit the
// flag stay assignable.
export type JobDiscoveryPreferences = Omit<
  z.infer<typeof JobDiscoveryPreferencesObjectSchema>,
  "collectOnlyHardCriteriaMatches"
> & {
  collectOnlyHardCriteriaMatches?: boolean | undefined;
};
export const JobDiscoveryPreferencesSchema: z.ZodType<
  JobDiscoveryPreferences,
  z.ZodTypeDef,
  JobDiscoveryPreferencesInput
> = JobDiscoveryPreferencesObjectSchema;

export const compensationIntervalValues = [
  "hour",
  "day",
  "week",
  "month",
  "year",
] as const;
export const CompensationIntervalSchema = z.enum(compensationIntervalValues);
export type CompensationInterval = z.infer<typeof CompensationIntervalSchema>;

export const compensationCurrencyStatusValues = [
  "explicit",
  "inherited",
  "needs_clarification",
] as const;
export const CompensationCurrencyStatusSchema = z.enum(
  compensationCurrencyStatusValues,
);
export type CompensationCurrencyStatus = z.infer<
  typeof CompensationCurrencyStatusSchema
>;

const CompensationAmountSchema = z.number().int().nonnegative().nullable();
export const CompensationPreferenceObjectSchema = z.object({
  basis: z.enum(["base", "total_ote"]).optional(),
  minimum: CompensationAmountSchema.default(null),
  maximum: CompensationAmountSchema.default(null),
  interval: CompensationIntervalSchema.default("year"),
  currency: z
    .string()
    .trim()
    .regex(
      /^[A-Z]{3}$/,
      "Compensation currency must be a three-letter ISO code.",
    )
    .nullable()
    .default(null),
  currencyStatus: CompensationCurrencyStatusSchema.default(
    "needs_clarification",
  ),
});
export const CompensationPreferenceSchema =
  CompensationPreferenceObjectSchema.superRefine((value, context) => {
    if (
      value.minimum !== null &&
      value.maximum !== null &&
      value.maximum < value.minimum
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Maximum compensation must be greater than or equal to minimum compensation.",
        path: ["maximum"],
      });
    }
    if (value.currencyStatus === "explicit" && value.currency === null) {
      context.addIssue({
        code: "custom",
        message: "An explicit compensation currency requires a currency code.",
        path: ["currency"],
      });
    }
    if (
      value.currencyStatus === "needs_clarification" &&
      value.currency !== null
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A compensation currency awaiting clarification must remain unset.",
        path: ["currency"],
      });
    }
  });
export type CompensationPreference = z.infer<
  typeof CompensationPreferenceSchema
>;

/**
 * Applies a partial compensation change and keeps the currency status
 * consistent with the currency that results: naming a currency sets it, and
 * clearing it puts the currency back to awaiting clarification. Only a status
 * supplied by the caller overrides that.
 *
 * Merging a change straight onto the stored preference used to fail schema
 * validation whenever the stored status still said the currency was awaiting
 * clarification, so the first change that named a currency could never save.
 */
export function applyCompensationPreferenceChange(
  current: CompensationPreference,
  change: {
    [Field in keyof CompensationPreference]?:
      | CompensationPreference[Field]
      | undefined;
  },
): CompensationPreference {
  const merged = { ...current, ...change };
  const requestedStatus =
    change.currencyStatus ??
    (change.currency === undefined
      ? merged.currencyStatus
      : merged.currency === null
        ? "needs_clarification"
        : "explicit");
  const currencyStatus =
    merged.currency === null
      ? requestedStatus === "explicit"
        ? "needs_clarification"
        : requestedStatus
      : requestedStatus === "needs_clarification"
        ? "explicit"
        : requestedStatus;

  return CompensationPreferenceSchema.parse({ ...merged, currencyStatus });
}

export const JobSearchPreferencesObjectSchema = z.object({
  searchSelectivity: z
    .enum(["best_matches", "balanced", "wide_net"])
    .optional(),
  targetRoles: z.array(NonEmptyStringSchema).default([]),
  jobFamilies: z.array(NonEmptyStringSchema).default([]),
  locations: z.array(NonEmptyStringSchema).default([]),
  excludedLocations: z.array(NonEmptyStringSchema).default([]),
  workModes: WorkModeListSchema,
  seniorityLevels: z.array(NonEmptyStringSchema).default([]),
  targetIndustries: z.array(NonEmptyStringSchema).default([]),
  targetCompanyStages: z.array(NonEmptyStringSchema).default([]),
  employmentTypes: z.array(NonEmptyStringSchema).default([]),
  shiftPreference: z.enum(["day", "night", "any"]).optional(),
  weeklyHours: z
    .object({
      minimum: z.number().min(0).max(168).nullable(),
      maximum: z.number().min(0).max(168).nullable(),
    })
    .refine(
      (hours) =>
        hours.minimum === null ||
        hours.maximum === null ||
        hours.minimum <= hours.maximum,
      {
        message: "Maximum weekly hours must be at least the minimum.",
      },
    )
    .optional(),
  minimumSalaryUsd: z.number().int().min(0).nullable(),
  targetSalaryUsd: z.number().int().min(0).nullable().default(null),
  salaryCurrency: NonEmptyStringSchema.nullable().default("USD"),
  compensation: CompensationPreferenceSchema.default({}),
  approvalMode: ApprovalModeSchema,
  tailoringMode: TailoringModeSchema,
  companyBlacklist: z.array(NonEmptyStringSchema).default([]),
  companyWhitelist: z.array(NonEmptyStringSchema).default([]),
  discovery: JobDiscoveryPreferencesSchema.default({}),
});

const annualMultiplierByInterval: Record<CompensationInterval, number> = {
  hour: 2_080,
  day: 260,
  week: 52,
  month: 12,
  year: 1,
};

export function annualizeCompensationAmount(
  amount: number,
  interval: CompensationInterval,
): number {
  return Math.round(amount * annualMultiplierByInterval[interval]);
}

function normalizeCompensationCompatibility(
  value: z.infer<typeof JobSearchPreferencesObjectSchema>,
): z.infer<typeof JobSearchPreferencesObjectSchema> {
  const compensationWasProvided =
    value.compensation.minimum !== null ||
    value.compensation.maximum !== null ||
    value.compensation.currency !== null;
  const compensation = compensationWasProvided
    ? value.compensation
    : value.minimumSalaryUsd !== null || value.targetSalaryUsd !== null
      ? {
          ...(value.compensation.basis
            ? { basis: value.compensation.basis }
            : {}),
          minimum: value.minimumSalaryUsd,
          maximum: value.targetSalaryUsd,
          interval: "year" as const,
          currency: value.salaryCurrency,
          currencyStatus: "inherited" as const,
        }
      : value.compensation;
  const comparableAsUsd =
    compensation.currency === "USD" &&
    compensation.currencyStatus !== "needs_clarification";

  return {
    ...value,
    minimumSalaryUsd:
      comparableAsUsd && compensation.minimum !== null
        ? annualizeCompensationAmount(
            compensation.minimum,
            compensation.interval,
          )
        : compensationWasProvided
          ? null
          : value.minimumSalaryUsd,
    targetSalaryUsd:
      comparableAsUsd && compensation.maximum !== null
        ? annualizeCompensationAmount(
            compensation.maximum,
            compensation.interval,
          )
        : compensationWasProvided
          ? null
          : value.targetSalaryUsd,
    salaryCurrency: compensationWasProvided
      ? compensation.currency
      : (compensation.currency ?? value.salaryCurrency),
    compensation,
  };
}

export const JobSearchPreferencesSchema =
  JobSearchPreferencesObjectSchema.transform(
    normalizeCompensationCompatibility,
  );
export type JobSearchPreferences = z.infer<typeof JobSearchPreferencesSchema>;

export const jobRequirementCategoryValues = [
  "skill",
  "experience",
  "seniority",
  "location",
  "work_mode",
  "work_authorization",
  "domain",
] as const;
export const JobRequirementCategorySchema = z.enum(
  jobRequirementCategoryValues,
);
export type JobRequirementCategory = z.infer<
  typeof JobRequirementCategorySchema
>;

export const jobRequirementImportanceValues = [
  "required",
  "preferred",
  "inferred",
] as const;
export const JobRequirementImportanceSchema = z.enum(
  jobRequirementImportanceValues,
);
export type JobRequirementImportance = z.infer<
  typeof JobRequirementImportanceSchema
>;

export const jobRequirementEvidenceStatusValues = [
  "supported",
  "partial",
  "missing",
  "unknown",
  "conflict",
] as const;
export const JobRequirementEvidenceStatusSchema = z.enum(
  jobRequirementEvidenceStatusValues,
);
export type JobRequirementEvidenceStatus = z.infer<
  typeof JobRequirementEvidenceStatusSchema
>;

export const resumeEvidenceSourceKindValues = [
  "profile_skill",
  "experience",
  "project",
  "profile",
] as const;
export const ResumeEvidenceSourceKindSchema = z.enum(
  resumeEvidenceSourceKindValues,
);
export type ResumeEvidenceSourceKind = z.infer<
  typeof ResumeEvidenceSourceKindSchema
>;

export const ResumeRequirementEvidenceSchema = z.object({
  sourceKind: ResumeEvidenceSourceKindSchema,
  sourceId: NonEmptyStringSchema.nullable().default(null),
  label: NonEmptyStringSchema,
  detail: NonEmptyStringSchema,
});
export type ResumeRequirementEvidence = z.infer<
  typeof ResumeRequirementEvidenceSchema
>;

export const JobRequirementAssessmentSchema = z.object({
  id: NonEmptyStringSchema,
  category: JobRequirementCategorySchema,
  label: NonEmptyStringSchema,
  importance: JobRequirementImportanceSchema,
  status: JobRequirementEvidenceStatusSchema,
  jobEvidence: NonEmptyStringSchema,
  resumeEvidence: z.array(ResumeRequirementEvidenceSchema).default([]),
  explanation: NonEmptyStringSchema,
});
export type JobRequirementAssessment = z.infer<
  typeof JobRequirementAssessmentSchema
>;

export const fitRecommendationValues = [
  "strong_fit",
  "apply_with_original",
  "review_before_applying",
  "skip",
] as const;
export const FitRecommendationSchema = z.enum(fitRecommendationValues);
export type FitRecommendation = z.infer<typeof FitRecommendationSchema>;

export const compensationFitStateValues = [
  "not_requested",
  "unknown",
  "meets_minimum",
  "below_minimum",
  "currency_incomparable",
] as const;
export const CompensationFitStateSchema = z.enum(compensationFitStateValues);
export type CompensationFitState = z.infer<typeof CompensationFitStateSchema>;

export const compensationEvidenceConfidenceValues = [
  "unavailable",
  "low",
  "high",
] as const;
export const CompensationEvidenceConfidenceSchema = z.enum(
  compensationEvidenceConfidenceValues,
);
export type CompensationEvidenceConfidence = z.infer<
  typeof CompensationEvidenceConfidenceSchema
>;

export const CompensationFitAssessmentSchema = z.object({
  state: CompensationFitStateSchema.default("unknown"),
  confidence: CompensationEvidenceConfidenceSchema.default("unavailable"),
  minimumSalaryUsd: z.number().int().nonnegative().nullable().default(null),
  listingMinimumAnnualUsd: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .default(null),
  listingCurrency: NonEmptyStringSchema.nullable().default(null),
  explanation: NonEmptyStringSchema.default(
    "The listing does not provide comparable compensation evidence.",
  ),
});
export type CompensationFitAssessment = z.infer<
  typeof CompensationFitAssessmentSchema
>;

export const matchDimensionEvidenceSourceValues = [
  "listing",
  "profile",
  "preference",
  "derived",
] as const;
export const MatchDimensionEvidenceSourceSchema = z.enum(
  matchDimensionEvidenceSourceValues,
);
export type MatchDimensionEvidenceSource = z.infer<
  typeof MatchDimensionEvidenceSourceSchema
>;

export const MatchDimensionEvidenceSchema = z.object({
  source: MatchDimensionEvidenceSourceSchema,
  label: NonEmptyStringSchema.max(120),
  detail: NonEmptyStringSchema.max(240),
});
export type MatchDimensionEvidence = z.infer<
  typeof MatchDimensionEvidenceSchema
>;

const BoundedMatchDimensionEvidenceSchema = z
  .array(MatchDimensionEvidenceSchema)
  .max(4)
  .default([]);

export const roleSuitabilityStateValues = [
  "unknown",
  "exact",
  "adjacent",
  "conflict",
] as const;
export const RoleSuitabilityStateSchema = z.enum(roleSuitabilityStateValues);
export type RoleSuitabilityState = z.infer<typeof RoleSuitabilityStateSchema>;

export const RoleSuitabilityAssessmentSchema = z.object({
  state: RoleSuitabilityStateSchema.default("unknown"),
  explanation: NonEmptyStringSchema.max(320).default(
    "Role suitability has not been assessed from saved target roles.",
  ),
  evidence: BoundedMatchDimensionEvidenceSchema,
});
export type RoleSuitabilityAssessment = z.infer<
  typeof RoleSuitabilityAssessmentSchema
>;

export const preferenceAlignmentStateValues = [
  "unknown",
  "not_configured",
  "aligned",
  "mixed",
  "conflict",
] as const;
export const PreferenceAlignmentStateSchema = z.enum(
  preferenceAlignmentStateValues,
);
export type PreferenceAlignmentState = z.infer<
  typeof PreferenceAlignmentStateSchema
>;

export const PreferenceAlignmentAssessmentSchema = z.object({
  state: PreferenceAlignmentStateSchema.default("unknown"),
  explanation: NonEmptyStringSchema.max(320).default(
    "Preference alignment has not been assessed from saved search preferences.",
  ),
  evidence: BoundedMatchDimensionEvidenceSchema,
});
export type PreferenceAlignmentAssessment = z.infer<
  typeof PreferenceAlignmentAssessmentSchema
>;

export const applicationEffortLevelValues = [
  "unknown",
  "low",
  "moderate",
  "high",
] as const;
export const ApplicationEffortLevelSchema = z.enum(
  applicationEffortLevelValues,
);
export type ApplicationEffortLevel = z.infer<
  typeof ApplicationEffortLevelSchema
>;

export const ApplicationEffortAssessmentSchema = z.object({
  level: ApplicationEffortLevelSchema.default("unknown"),
  explanation: NonEmptyStringSchema.max(320).default(
    "The listing does not provide enough application-path evidence to estimate effort.",
  ),
  evidence: BoundedMatchDimensionEvidenceSchema,
});
export type ApplicationEffortAssessment = z.infer<
  typeof ApplicationEffortAssessmentSchema
>;

export const evidenceConfidenceLevelValues = [
  "unavailable",
  "low",
  "moderate",
  "high",
] as const;
export const EvidenceConfidenceLevelSchema = z.enum(
  evidenceConfidenceLevelValues,
);
export type EvidenceConfidenceLevel = z.infer<
  typeof EvidenceConfidenceLevelSchema
>;

export const EvidenceConfidenceAssessmentSchema = z.object({
  level: EvidenceConfidenceLevelSchema.default("unavailable"),
  explanation: NonEmptyStringSchema.max(320).default(
    "No supportability assessment is available for the extracted evidence.",
  ),
  evidence: BoundedMatchDimensionEvidenceSchema,
  supportedCount: z.number().int().nonnegative().default(0),
  partialCount: z.number().int().nonnegative().default(0),
  missingCount: z.number().int().nonnegative().default(0),
  unknownCount: z.number().int().nonnegative().default(0),
  conflictCount: z.number().int().nonnegative().default(0),
});
export type EvidenceConfidenceAssessment = z.infer<
  typeof EvidenceConfidenceAssessmentSchema
>;

export const MatchDimensionsAssessmentSchema = z.object({
  roleSuitability: RoleSuitabilityAssessmentSchema.default({}),
  preferenceAlignment: PreferenceAlignmentAssessmentSchema.default({}),
  applicationEffort: ApplicationEffortAssessmentSchema.default({}),
  evidenceConfidence: EvidenceConfidenceAssessmentSchema.default({}),
});
export type MatchDimensionsAssessment = z.infer<
  typeof MatchDimensionsAssessmentSchema
>;

export const matchLocationReachValues = [
  "in_area",
  "remote_preferred",
  "outside_area",
  "unknown",
] as const;
export const MatchLocationReachSchema = z.enum(matchLocationReachValues);
/**
 * Where the listing sits against the saved areas, kept beside the score so
 * ordering can hold one promise the score alone cannot: a role that is on site
 * and outside the saved areas never outranks an in-area or remote role of the
 * same title fit. `unknown` covers "no saved area", "no stated geography", and
 * every assessment recorded before this field existed.
 */
export type MatchLocationReach = z.infer<typeof MatchLocationReachSchema>;

export const titleFamilyMatchValues = [
  "same_family",
  "adjacent",
  "unrelated",
] as const;
export const TitleFamilyMatchSchema = z.enum(titleFamilyMatchValues);
/**
 * How the listing's own job title sits against the saved target roles,
 * independent of any score.
 *
 * A role in the same occupational family as a saved target is a result the
 * person asked for even when nothing else about the listing could be read, so
 * it must never be demoted purely for the absence of a number. `null` means
 * the question was not asked — every assessment recorded before this field
 * existed — and is never read as "unrelated".
 */
export type TitleFamilyMatch = z.infer<typeof TitleFamilyMatchSchema>;

/**
 * The model's verdict on how one listing fits the person (ADR 0041). The
 * model reads the listing and the person's goals and decides; the scorer
 * builds the assessment from this verdict instead of its own title, place and
 * keyword rules. `batch` verdicts come from the search's per-page judging of
 * many jobs at once; `full` marks a completed listing and requirement comparison.
 * A rubric-only batch refresh retains `full` when that comparison's evidence
 * fingerprints still match and its requirement evidence is preserved.
 * The fingerprints record what the verdict was made from, so a later change
 * to the profile or the listing can be judged again.
 */
export const FitJudgmentSchema = z.object({
  source: z.enum(["batch", "full"]),
  judgedAt: IsoDateTimeSchema,
  contextFingerprint: NonEmptyStringSchema.nullable().default(null),
  postingFingerprint: NonEmptyStringSchema.nullable().default(null),
  score: z.number().int().min(0).max(100),
  recommendation: FitRecommendationSchema,
  role: RoleSuitabilityStateSchema.default("unknown"),
  roleExplanation: NonEmptyStringSchema.max(320).nullable().default(null),
  preferences: PreferenceAlignmentStateSchema.default("unknown"),
  preferencesExplanation: NonEmptyStringSchema.max(320)
    .nullable()
    .default(null),
  locationReach: MatchLocationReachSchema.default("unknown"),
  reasons: z.array(NonEmptyStringSchema).max(4).default([]),
  gaps: z.array(NonEmptyStringSchema).max(4).default([]),
  /** The model's one sentence on the main reason for its recommendation. */
  summary: NonEmptyStringSchema.max(320).nullable().optional(),
  /** The listing says it is closed, filled or no longer taking applications. */
  listingClosed: z.boolean().default(false),
  /** The listing's own words for that, as the model quoted them. */
  listingClosedEvidence: NonEmptyStringSchema.max(240).nullable().default(null),
});
export type FitJudgment = z.infer<typeof FitJudgmentSchema>;

export const MatchAssessmentSchema = z.object({
  scorerVersion: z.number().int().positive().default(1),
  contextFingerprint: NonEmptyStringSchema.nullable().default(null),
  postingFingerprint: NonEmptyStringSchema.nullable().default(null),
  score: z.number().int().min(0).max(100),
  /**
   * The score was held down to a ceiling by an unresolved gap rather than
   * measured. Several unrelated listings can legitimately land on the same
   * ceiling, so the screen must present the number as "up to", never as a
   * comparison between two jobs. Defaults false so assessments recorded
   * before this field existed keep their plain reading.
   */
  scoreIsUpperBound: z.boolean().default(false),
  compensationFit: CompensationFitAssessmentSchema.default({}),
  locationReach: MatchLocationReachSchema.default("unknown"),
  // Optional rather than defaulted: an assessment that never asked the
  // question must be distinguishable from one that asked and found no
  // relation, and every assessment recorded before this field existed is in
  // the first group. Read it as "not asked" when it is absent.
  titleFamilyMatch: TitleFamilyMatchSchema.nullable().optional(),
  dimensions: MatchDimensionsAssessmentSchema.default({}),
  reasons: z.array(NonEmptyStringSchema).default([]),
  gaps: z.array(NonEmptyStringSchema).default([]),
  recommendation: FitRecommendationSchema.default("review_before_applying"),
  recommendationRationale: NonEmptyStringSchema.default(
    "Review the listing and resume evidence before applying.",
  ),
  requirements: z.array(JobRequirementAssessmentSchema).default([]),
  requirementsSource: z.enum(["model", "deterministic"]).optional(),
  /** The model's verdict this assessment was built from; absent until judged. */
  judgment: FitJudgmentSchema.nullable().optional(),
});
export type MatchAssessment = z.infer<typeof MatchAssessmentSchema>;

/**
 * The fit facts a job list shows: score, verdict, states and the short
 * reasons. The written explanations and evidence stay in the job detail, so
 * thousands of rows do not carry them across IPC.
 */
export const JobListMatchAssessmentSchema = MatchAssessmentSchema.extend({
  compensationFit: CompensationFitAssessmentSchema.omit({
    explanation: true,
  }).default({}),
  dimensions: z
    .object({
      roleSuitability: RoleSuitabilityAssessmentSchema.pick({
        state: true,
      }).default({}),
      preferenceAlignment: PreferenceAlignmentAssessmentSchema.pick({
        state: true,
      }).default({}),
      applicationEffort: ApplicationEffortAssessmentSchema.pick({
        level: true,
      }).default({}),
      evidenceConfidence: EvidenceConfidenceAssessmentSchema.omit({
        explanation: true,
        evidence: true,
      }).default({}),
    })
    .default({}),
  requirements: z
    .array(
      JobRequirementAssessmentSchema.pick({
        id: true,
        category: true,
        label: true,
        importance: true,
        status: true,
      }),
    )
    .default([]),
  judgment: FitJudgmentSchema.omit({
    contextFingerprint: true,
    postingFingerprint: true,
    roleExplanation: true,
    preferencesExplanation: true,
    listingClosedEvidence: true,
    reasons: true,
    gaps: true,
  })
    .nullable()
    .optional(),
});
export type JobListMatchAssessment = z.infer<
  typeof JobListMatchAssessmentSchema
>;

export const matchAssessmentInputChangeCodeValues = [
  "scorer_version_changed",
  "candidate_context_changed",
  "listing_evidence_changed",
  "candidate_context_metadata_unknown",
  "listing_evidence_metadata_unknown",
] as const;
export const MatchAssessmentInputChangeCodeSchema = z.enum(
  matchAssessmentInputChangeCodeValues,
);
export type MatchAssessmentInputChangeCode = z.infer<
  typeof MatchAssessmentInputChangeCodeSchema
>;

export const matchAssessmentOutputChangeCodeValues = [
  "score_changed",
  "recommendation_changed",
  "compensation_fit_changed",
  "rank_position_changed",
  "role_suitability_changed",
  "preference_alignment_changed",
  "application_effort_changed",
  "evidence_confidence_changed",
  "requirement_added",
  "requirement_removed",
  "requirement_importance_changed",
  "requirement_status_changed",
  "requirement_evidence_changed",
  "assessment_explanation_changed",
] as const;
export const MatchAssessmentOutputChangeCodeSchema = z.enum(
  matchAssessmentOutputChangeCodeValues,
);
export type MatchAssessmentOutputChangeCode = z.infer<
  typeof MatchAssessmentOutputChangeCodeSchema
>;

export const MatchAssessmentInputChangeSchema = z.object({
  code: MatchAssessmentInputChangeCodeSchema,
  scope: z.enum(["scorer", "candidate_context", "listing_evidence"]),
  certainty: z.enum(["known", "unknown"]),
  title: NonEmptyStringSchema,
  detail: NonEmptyStringSchema,
  previousValue: z.union([z.string(), z.number()]).nullable(),
  currentValue: z.union([z.string(), z.number()]).nullable(),
});
export type MatchAssessmentInputChange = z.infer<
  typeof MatchAssessmentInputChangeSchema
>;

export const MatchAssessmentOutputChangeSchema = z.object({
  code: MatchAssessmentOutputChangeCodeSchema,
  subject: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  detail: NonEmptyStringSchema,
  previousValue: z.string().nullable(),
  currentValue: z.string().nullable(),
});
export type MatchAssessmentOutputChange = z.infer<
  typeof MatchAssessmentOutputChangeSchema
>;

export const matchAssessmentChangeAuditStatusValues = [
  "unchanged",
  "metadata_incomplete",
  "inputs_changed_assessment_stable",
  "assessment_changed",
  "assessment_changed_with_unknown_cause",
] as const;
export const MatchAssessmentChangeAuditStatusSchema = z.enum(
  matchAssessmentChangeAuditStatusValues,
);
export type MatchAssessmentChangeAuditStatus = z.infer<
  typeof MatchAssessmentChangeAuditStatusSchema
>;

export const matchAssessmentChangeCauseConfidenceValues = [
  "known",
  "partial",
  "unknown",
  "not_applicable",
] as const;
export const MatchAssessmentChangeCauseConfidenceSchema = z.enum(
  matchAssessmentChangeCauseConfidenceValues,
);
export type MatchAssessmentChangeCauseConfidence = z.infer<
  typeof MatchAssessmentChangeCauseConfidenceSchema
>;

export const MatchAssessmentAuditMetadataSchema = MatchAssessmentSchema.pick({
  scorerVersion: true,
  contextFingerprint: true,
  postingFingerprint: true,
});
export type MatchAssessmentAuditMetadata = z.infer<
  typeof MatchAssessmentAuditMetadataSchema
>;

export const MatchAssessmentChangeAuditSchema = z.object({
  version: z.literal(1).default(1),
  recordedAt: IsoDateTimeSchema.nullable().default(null),
  status: MatchAssessmentChangeAuditStatusSchema,
  causeConfidence: MatchAssessmentChangeCauseConfidenceSchema,
  rankingSignalChanged: z.boolean(),
  summary: NonEmptyStringSchema,
  reasons: z.array(NonEmptyStringSchema).default([]),
  previousMetadata: MatchAssessmentAuditMetadataSchema,
  currentMetadata: MatchAssessmentAuditMetadataSchema,
  inputChanges: z.array(MatchAssessmentInputChangeSchema).default([]),
  previousRank: z.number().int().positive().nullable().default(null),
  currentRank: z.number().int().positive().nullable().default(null),
  outputChanges: z.array(MatchAssessmentOutputChangeSchema).default([]),
});
export type MatchAssessmentChangeAudit = z.infer<
  typeof MatchAssessmentChangeAuditSchema
>;

export const normalizedCompensationIntervalValues = [
  "hour",
  "day",
  "week",
  "month",
  "year",
] as const;
export const NormalizedCompensationIntervalSchema = z.enum(
  normalizedCompensationIntervalValues,
);
export type NormalizedCompensationInterval = z.infer<
  typeof NormalizedCompensationIntervalSchema
>;

export const NormalizedCompensationSchema = z.object({
  currency: NonEmptyStringSchema.nullable().default(null),
  interval: NormalizedCompensationIntervalSchema.nullable().default(null),
  minAmount: z.number().nonnegative().nullable().default(null),
  maxAmount: z.number().nonnegative().nullable().default(null),
  minAnnualUsd: z.number().int().nonnegative().nullable().default(null),
  maxAnnualUsd: z.number().int().nonnegative().nullable().default(null),
});
export type NormalizedCompensation = z.infer<
  typeof NormalizedCompensationSchema
>;

export const jobKeywordSignalKindValues = [
  "skill",
  "responsibility",
  "qualification",
  "benefit",
  "domain",
  "tool",
  "industry",
] as const;
export const JobKeywordSignalKindSchema = z.enum(jobKeywordSignalKindValues);
export type JobKeywordSignalKind = z.infer<typeof JobKeywordSignalKindSchema>;

export const JobKeywordSignalSchema = z.object({
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  kind: JobKeywordSignalKindSchema.default("skill"),
  weight: z.number().int().min(1).max(5).default(3),
});
export type JobKeywordSignal = z.infer<typeof JobKeywordSignalSchema>;

export const consentInterruptKindValues = [
  "signup",
  "existing_account_decision",
  "manual_verification",
] as const;
export const ConsentInterruptKindSchema = z.enum(consentInterruptKindValues);
export type ConsentInterruptKind = z.infer<typeof ConsentInterruptKindSchema>;

export const JobScreeningHintsSchema = z
  .object({
    sponsorshipText: NonEmptyStringSchema.nullable().default(null),
    requiresSecurityClearance: z.boolean().nullable().default(null),
    relocationText: NonEmptyStringSchema.nullable().default(null),
    travelText: NonEmptyStringSchema.nullable().default(null),
    remoteGeographies: z.array(NonEmptyStringSchema).default([]),
    requiresConsentInterrupt: z.boolean().nullable().default(null),
    requiresConsentInterruptKind:
      ConsentInterruptKindSchema.nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (
      value.requiresConsentInterrupt === true &&
      value.requiresConsentInterruptKind == null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "requiresConsentInterruptKind is required when requiresConsentInterrupt is true.",
        path: ["requiresConsentInterruptKind"],
      });
    }

    if (
      value.requiresConsentInterrupt === false &&
      value.requiresConsentInterruptKind != null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "requiresConsentInterruptKind must be null when requiresConsentInterrupt is false.",
        path: ["requiresConsentInterruptKind"],
      });
    }

    if (
      value.requiresConsentInterrupt == null &&
      value.requiresConsentInterruptKind != null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "requiresConsentInterruptKind must be null when requiresConsentInterrupt is null.",
        path: ["requiresConsentInterruptKind"],
      });
    }
  });
export type JobScreeningHints = z.infer<typeof JobScreeningHintsSchema>;

export const jobPostingDetailQualityValues = [
  "card_only",
  "partial_detail",
  "detail_enriched",
] as const;
export const JobPostingDetailQualitySchema = z.enum(
  jobPostingDetailQualityValues,
);
export type JobPostingDetailQuality = z.infer<
  typeof JobPostingDetailQualitySchema
>;

/**
 * The one attempt Job Finder made to read this listing's own page after a
 * card-only capture. Recorded so the product neither re-reads a page every
 * time it looks at the job nor hides that it tried and what it found.
 */
export const listingDetailFetchOutcomeValues = [
  "enriched",
  "partial",
  "no_detail",
  "fetch_failed",
  "blocked",
  "unsupported_url",
] as const;
export const ListingDetailFetchOutcomeSchema = z.enum(
  listingDetailFetchOutcomeValues,
);
export type ListingDetailFetchOutcome = z.infer<
  typeof ListingDetailFetchOutcomeSchema
>;

export const ListingDetailFetchSchema = z.object({
  attemptedAt: IsoDateTimeSchema,
  outcome: ListingDetailFetchOutcomeSchema,
  method: z.enum(["json_ld", "page_text"]).nullable().default(null),
  detail: NonEmptyStringSchema.nullable().default(null),
  /** The linked vacancy names a different role from the saved posting. */
  identityConflict: z
    .object({
      expectedTitle: NonEmptyStringSchema,
      observedTitle: NonEmptyStringSchema,
    })
    .optional(),
  /** A server-requested earliest retry time after rate limiting. */
  retryAfterAt: IsoDateTimeSchema.nullable().optional(),
});
export type ListingDetailFetch = z.infer<typeof ListingDetailFetchSchema>;

/**
 * The single answer to "does this job have its own listing text?".
 *
 * Three states, and only three, so the score panel, the row caption and the
 * run report cannot each invent their own reading of the same job:
 *
 * - `captured`  — the listing body was read and is what the job was scored on;
 * - `blocked`   — a read was attempted and the page did not yield a body
 *                 (signed-in wall, no description published, unreachable,
 *                 nothing readable at that address). `listingDetailFetch`
 *                 keeps which of those it was;
 * - `not_attempted` — no read has been made yet, so nothing may be said
 *                 about what the page holds.
 *
 * `textHash` fingerprints the captured body so a later run can tell "the same
 * text again" from "the listing was rewritten" without storing a second copy.
 */
export const listingDetailCaptureStateValues = [
  "captured",
  "blocked",
  "not_attempted",
] as const;
export const ListingDetailCaptureStateSchema = z.enum(
  listingDetailCaptureStateValues,
);
export type ListingDetailCaptureState = z.infer<
  typeof ListingDetailCaptureStateSchema
>;

export const ListingDetailCaptureSchema = z.object({
  state: ListingDetailCaptureStateSchema.default("not_attempted"),
  textHash: NonEmptyStringSchema.nullable().default(null),
});
export type ListingDetailCapture = z.infer<typeof ListingDetailCaptureSchema>;

export const ListingRejectionCategorySchema = z.enum([
  "role",
  "place",
  "preferences",
  "closed",
  "not_a_listing",
  "person_exclusion",
  "unreadable",
]);
export const RejectedListingSchema = z.object({
  title: z.string(),
  url: UrlStringSchema,
  category: ListingRejectionCategorySchema,
  reason: NonEmptyStringSchema,
});
export const JobPostingSchema = z.object({
  needsRenderedPage: z.boolean().optional(),
  searchRejection: z
    .object({
      category: ListingRejectionCategorySchema,
      reason: NonEmptyStringSchema,
    })
    .nullable()
    .optional(),
  /** The observed page that produced this extraction, independent of the run target. */
  producingPageUrl: UrlStringSchema.optional(),
  source: JobSourceSchema,
  sourceJobId: NonEmptyStringSchema,
  discoveryMethod: JobDiscoveryMethodSchema.default("catalog_seed"),
  collectionMethod:
    JobDiscoveryCollectionMethodSchema.default("fallback_search"),
  canonicalUrl: NonEmptyStringSchema,
  applicationUrl: UrlStringSchema.nullable().default(null),
  title: NonEmptyStringSchema,
  company: NonEmptyStringSchema,
  location: NonEmptyStringSchema,
  workMode: WorkModeListSchema,
  applyPath: JobApplyPathSchema,
  easyApplyEligible: z.boolean(),
  postedAt: IsoDateTimeSchema.nullable().default(null),
  postedAtText: NonEmptyStringSchema.nullable().default(null),
  providerUpdatedAt: IsoDateTimeSchema.nullable().default(null),
  discoveredAt: IsoDateTimeSchema,
  firstSeenAt: IsoDateTimeSchema.nullable().default(null),
  lastSeenAt: IsoDateTimeSchema.nullable().default(null),
  lastVerifiedActiveAt: IsoDateTimeSchema.nullable().default(null),
  salaryText: NonEmptyStringSchema.nullable(),
  normalizedCompensation: NormalizedCompensationSchema.default({}),
  detailQuality: JobPostingDetailQualitySchema.default("card_only"),
  listingDetailFetch: ListingDetailFetchSchema.nullable().default(null),
  // Optional so that every posting written before this field existed stays
  // valid and is re-derived on read rather than silently defaulting to a
  // claim about what was tried. `deriveListingDetailCapture` is the one rule
  // for both writing and re-deriving it.
  listingDetailCapture: ListingDetailCaptureSchema.optional(),
  summary: NonEmptyStringSchema.nullable().default(null),
  description: NonEmptyStringSchema,
  keySkills: z.array(NonEmptyStringSchema).default([]),
  responsibilities: z.array(NonEmptyStringSchema).default([]),
  minimumQualifications: z.array(NonEmptyStringSchema).default([]),
  preferredQualifications: z.array(NonEmptyStringSchema).default([]),
  seniority: NonEmptyStringSchema.nullable().default(null),
  employmentType: NonEmptyStringSchema.nullable().default(null),
  department: NonEmptyStringSchema.nullable().default(null),
  team: NonEmptyStringSchema.nullable().default(null),
  employerWebsiteUrl: UrlStringSchema.nullable().default(null),
  employerDomain: NonEmptyStringSchema.nullable().default(null),
  atsProvider: NonEmptyStringSchema.nullable().default(null),
  providerKey: SourceIntelligenceProviderKeySchema.nullable().default(null),
  providerBoardToken: NonEmptyStringSchema.nullable().default(null),
  providerIdentifier: NonEmptyStringSchema.nullable().default(null),
  titleTriageOutcome: DiscoveryTitleTriageOutcomeSchema.default("pass"),
  sourceIntelligence: SourceIntelligenceArtifactSchema.nullable().default(null),
  screeningHints: JobScreeningHintsSchema.default({}),
  keywordSignals: z.array(JobKeywordSignalSchema).default([]),
  benefits: z.array(NonEmptyStringSchema).default([]),
});
export type JobPosting = z.infer<typeof JobPostingSchema>;

// ---------------------------------------------------------------------------
// Listing evidence depth
//
// `detailQuality` is the one shared vocabulary for how much of a listing was
// actually read. The assessment lives here, beside the enum and the posting
// schema, because both the browser workflow that collects postings and the
// orchestration that persists them must classify identical fields the same
// way. It is pure and source-generic: it reads only posting fields and never
// a board identity.
// ---------------------------------------------------------------------------

type JobPostingDetailQualityInput = Pick<
  JobPosting,
  | "title"
  | "company"
  | "description"
  | "keySkills"
  | "responsibilities"
  | "minimumQualifications"
  | "preferredQualifications"
  | "benefits"
>;

const PARTIAL_DESCRIPTION_WORD_FLOOR = 18;
const ENRICHED_DESCRIPTION_WORD_FLOOR = 70;
const ENRICHED_DESCRIPTION_CHARACTER_FLOOR = 500;
const ENRICHED_WITH_STRUCTURED_DETAIL_WORD_FLOOR = 35;
const ENRICHED_STRUCTURED_DETAIL_FLOOR = 5;
const ENRICHED_STRUCTURED_DETAIL_CHARACTER_FLOOR = 180;

function normalizeDetailQualityText(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function countDetailQualityWords(value: string): number {
  // All decisions use thresholds at or below 70. Count only that prefix;
  // splitting a full listing allocated thousands of strings each time it
  // passed through normalization, capture and assessment.
  const words = /\S+/gu;
  let count = 0;
  while (count < ENRICHED_DESCRIPTION_WORD_FLOOR && words.test(value))
    count += 1;
  return count;
}

function isSyntheticDescription(
  input: JobPostingDetailQualityInput,
  descriptionWords: number,
): boolean {
  const title = normalizeDetailQualityText(input.title);
  const company = normalizeDetailQualityText(input.company);
  if (
    descriptionWords >
    countDetailQualityWords(title) + countDetailQualityWords(company) + 3
  )
    return false;
  const description = normalizeDetailQualityText(input.description);

  return (
    description === title ||
    description === `${title} role at ${company}` ||
    description === `${title} opportunity at ${company}`
  );
}

export function assessJobPostingDetailQuality(
  input: JobPostingDetailQualityInput,
): JobPostingDetailQuality {
  const description = input.description.trim();
  const descriptionWordCount = countDetailQualityWords(description);
  const structuredDetails = [
    ...input.responsibilities,
    ...input.minimumQualifications,
    ...input.preferredQualifications,
    ...input.benefits,
  ]
    .map((entry) => entry.trim())
    .filter(Boolean);
  const structuredDetailCharacterCount = structuredDetails.reduce(
    (total, entry) => total + entry.length,
    0,
  );
  const syntheticDescription = isSyntheticDescription(
    input,
    descriptionWordCount,
  );

  if (
    (!syntheticDescription &&
      (descriptionWordCount >= ENRICHED_DESCRIPTION_WORD_FLOOR ||
        description.length >= ENRICHED_DESCRIPTION_CHARACTER_FLOOR)) ||
    (!syntheticDescription &&
      descriptionWordCount >= ENRICHED_WITH_STRUCTURED_DETAIL_WORD_FLOOR &&
      structuredDetails.length >= 2) ||
    (structuredDetails.length >= ENRICHED_STRUCTURED_DETAIL_FLOOR &&
      structuredDetailCharacterCount >=
        ENRICHED_STRUCTURED_DETAIL_CHARACTER_FLOOR)
  ) {
    return "detail_enriched";
  }

  if (
    (!syntheticDescription &&
      descriptionWordCount >= PARTIAL_DESCRIPTION_WORD_FLOOR) ||
    structuredDetails.length > 0 ||
    input.keySkills.length >= 2
  ) {
    return "partial_detail";
  }

  return "card_only";
}

/**
 * A short, stable fingerprint of a captured listing body.
 *
 * Deliberately not a cryptographic digest: nothing here is a security claim,
 * it has to run in the renderer as well as the main process, and it must not
 * pull a Node-only module into a shared contract. Whitespace and case are
 * normalized first so a re-read of an unchanged page fingerprints identically.
 */
export function hashListingText(value: string): string | null {
  const normalized = value.replace(/\s+/gu, " ").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  // FNV-1a, 32 bit. `Math.imul` keeps the multiply exact at 32 bits.
  let digest = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    digest ^= normalized.charCodeAt(index);
    digest = Math.imul(digest, 0x01000193);
  }
  return `${normalized.length.toString(36)}-${(digest >>> 0).toString(36)}`;
}

/**
 * The one classification of "does this job have its own listing text?".
 *
 * Both the browser workflow that collects postings and the orchestration that
 * persists them call this, so the capture state a run records and the state a
 * screen reads back are the same rule applied to the same fields.
 */
export function deriveListingDetailCapture(input: {
  description: string;
  detailQuality: JobPostingDetailQuality;
  listingDetailFetch: ListingDetailFetch | null;
}): ListingDetailCapture {
  if (input.detailQuality !== "card_only") {
    return {
      state: "captured",
      textHash: hashListingText(input.description),
    };
  }

  const outcome = input.listingDetailFetch?.outcome ?? null;
  if (outcome === "enriched" || outcome === "partial") {
    return {
      state: "captured",
      textHash: hashListingText(input.description),
    };
  }

  // Every other recorded outcome is a read that happened and produced no
  // body. The reason stays on `listingDetailFetch`; the state only says the
  // product tried and cannot score on the listing's own words.
  if (outcome) {
    return { state: "blocked", textHash: null };
  }

  return { state: "not_attempted", textHash: null };
}

/**
 * Run-level warning for a discovery run that retained postings but read no
 * listing body for any of them. It states only what was and was not read: the
 * product has no capability to open a listing outside its own managed browser,
 * so this warning must never suggest one.
 */
export function buildDiscoveryCardOnlyEvidenceWarning(
  sourceLabel: string,
): string {
  const label = sourceLabel.trim();

  return `Only listing titles and card details were read from ${label.length > 0 ? label : "this source"}; no job description was captured, so match details for these results are unchecked.`;
}

/**
 * True when a run retained at least one posting and every retained posting is
 * `card_only`. A single partly or fully detailed posting makes the run's
 * evidence mixed, and an empty run has nothing to warn about.
 */
export function isCardOnlyDiscoveryEvidence(
  postings: readonly JobPostingDetailQualityInput[],
): boolean {
  return (
    postings.length > 0 &&
    postings.every(
      (posting) => assessJobPostingDetailQuality(posting) === "card_only",
    )
  );
}

export const SavedJobDiscoveryProvenanceSchema = z.object({
  targetId: NonEmptyStringSchema,
  adapterKind: JobSourceAdapterKindSchema,
  resolvedAdapterKind: JobSourceSchema.nullable().default(null),
  startingUrl: UrlStringSchema,
  discoveredAt: IsoDateTimeSchema,
  collectionMethod:
    JobDiscoveryCollectionMethodSchema.default("fallback_search"),
  providerKey: SourceIntelligenceProviderKeySchema.nullable().default(null),
  providerBoardToken: NonEmptyStringSchema.nullable().default(null),
  titleTriageOutcome: DiscoveryTitleTriageOutcomeSchema.default("pass"),
  sourceLabel: NonEmptyStringSchema.optional(),
  // What this one source showed for the job. A job seen on several sources is
  // built from exactly one of these sightings (ADR 0030), so each keeps its own
  // listing and application link instead of the latest one overwriting the job.
  // Optional: provenance written before these fields existed stays valid.
  /** Display facts from this posting, kept together when its route wins. */
  listingFacts: JobPostingSchema.pick({
    title: true,
    company: true,
    location: true,
    salaryText: true,
    seniority: true,
    description: true,
    summary: true,
  }).optional(),
  /** The listing page this source linked to. */
  listingUrl: NonEmptyStringSchema.nullable().optional(),
  /** The application link this source's collection carried. */
  applicationUrl: UrlStringSchema.nullable().optional(),
  /** The apply link read from this sighting's own listing page. */
  pageApplyUrl: UrlStringSchema.nullable().optional(),
  /** When this sighting's listing page was read for its apply link. */
  routeReadAt: IsoDateTimeSchema.nullable().optional(),
  sourceJobId: NonEmptyStringSchema.nullable().optional(),
  applyPath: JobApplyPathSchema.nullable().optional(),
});
export type SavedJobDiscoveryProvenance = z.infer<
  typeof SavedJobDiscoveryProvenanceSchema
>;

export const discoveryFeedbackReasonValues = [
  "role",
  "seniority",
  "location",
  "work_mode",
  "compensation",
  "company",
  "missing_requirement",
  "duplicate",
  "other",
] as const;
export const DiscoveryFeedbackReasonSchema = z.enum(
  discoveryFeedbackReasonValues,
);

export const EmployerExclusionReferenceSchema = z
  .object({
    normalizedCompanyName: NonEmptyStringSchema,
    displayCompanyName: NonEmptyStringSchema,
    addedByThisFeedback: z.boolean(),
    campaignId: NonEmptyStringSchema.nullable().default(null),
  })
  .strict();
export type EmployerExclusionReference = z.infer<
  typeof EmployerExclusionReferenceSchema
>;

const DiscoveryFeedbackObjectSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().positive(),
  reasons: z.array(DiscoveryFeedbackReasonSchema).max(9),
  recordedAt: IsoDateTimeSchema,
  // Status the job held when it was hidden, so "Show again" can undo the
  // dismissal exactly instead of downgrading every hidden job to discovered.
  // Null for pending jobs and feedback recorded before this field existed.
  priorStatus: ApplicationStatusSchema.nullable().default(null),
  employerExclusion: EmployerExclusionReferenceSchema.nullable().default(null),
});
type DiscoveryFeedbackParsed = z.infer<typeof DiscoveryFeedbackObjectSchema>;
type DiscoveryFeedbackInput = z.input<typeof DiscoveryFeedbackObjectSchema>;
export type DiscoveryFeedback = Omit<
  DiscoveryFeedbackParsed,
  "employerExclusion"
> & {
  employerExclusion?: DiscoveryFeedbackParsed["employerExclusion"];
};
export const DiscoveryFeedbackSchema: z.ZodType<
  DiscoveryFeedback,
  z.ZodTypeDef,
  DiscoveryFeedbackInput
> = DiscoveryFeedbackObjectSchema;

export const discoveryLedgerEntryStatusValues = [
  "seen",
  "skipped",
  "applied",
  "enriched",
  "inactive",
] as const;
export const DiscoveryLedgerEntryStatusSchema = z.enum(
  discoveryLedgerEntryStatusValues,
);
export type DiscoveryLedgerEntryStatus = z.infer<
  typeof DiscoveryLedgerEntryStatusSchema
>;

export const DiscoveryListingFingerprintsSchema = z.object({
  version: z.literal(1),
  card: NonEmptyStringSchema,
  detail: NonEmptyStringSchema.nullable().default(null),
  material: NonEmptyStringSchema,
});
export type DiscoveryListingFingerprints = z.infer<
  typeof DiscoveryListingFingerprintsSchema
>;

/**
 * The model's screen of a job-board feed listing (title, place, work mode)
 * against the person's goals, remembered so a board fetched again is not
 * screened again. `key` hashes the goals and the listing facts it read; a
 * change to either asks again. `pending` means the screen could not run and
 * the listing was kept unscreened; the next search screens it.
 */
export const ListingScreenRecordSchema = z.object({
  key: NonEmptyStringSchema.nullable().default(null),
  verdict: z.enum(["keep", "reject", "pending"]),
  category: ListingRejectionCategorySchema.nullable().default(null),
  reason: NonEmptyStringSchema.nullable().default(null),
});

export const DiscoveryLedgerEntrySchema = z.object({
  id: NonEmptyStringSchema,
  canonicalUrl: UrlStringSchema,
  applicationUrl: UrlStringSchema.nullable().default(null),
  source: JobSourceSchema,
  sourceJobId: NonEmptyStringSchema.nullable().default(null),
  providerKey: SourceIntelligenceProviderKeySchema.nullable().default(null),
  providerBoardToken: NonEmptyStringSchema.nullable().default(null),
  providerIdentifier: NonEmptyStringSchema.nullable().default(null),
  providerUpdatedAt: IsoDateTimeSchema.nullable().default(null),
  title: NonEmptyStringSchema,
  company: NonEmptyStringSchema.nullable().default(null),
  location: NonEmptyStringSchema.nullable().default(null),
  postedAt: IsoDateTimeSchema.nullable().default(null),
  postedAtText: NonEmptyStringSchema.nullable().default(null),
  targetId: NonEmptyStringSchema,
  collectionMethod:
    JobDiscoveryCollectionMethodSchema.default("fallback_search"),
  detailQuality: JobPostingDetailQualitySchema.default("card_only"),
  fingerprints: DiscoveryListingFingerprintsSchema.nullable().default(null),
  firstSeenAt: IsoDateTimeSchema,
  lastSeenAt: IsoDateTimeSchema,
  lastAppliedAt: IsoDateTimeSchema.nullable().default(null),
  lastEnrichedAt: IsoDateTimeSchema.nullable().default(null),
  inactiveAt: IsoDateTimeSchema.nullable().default(null),
  latestStatus: DiscoveryLedgerEntryStatusSchema.default("seen"),
  titleTriageOutcome: DiscoveryTitleTriageOutcomeSchema.default("pass"),
  skipReason: NonEmptyStringSchema.nullable().default(null),
  listingScreen: ListingScreenRecordSchema.nullable().optional(),
});
export type DiscoveryLedgerEntry = z.infer<typeof DiscoveryLedgerEntrySchema>;

export type SavedJob = JobPosting & {
  id: string;
  /** Search plans that currently retain this shared global job row. */
  campaignIds?: string[];
  personSupplied?: boolean | undefined;
  planAssessments?: Record<string, MatchAssessment> | undefined;
  status: z.infer<typeof ApplicationStatusSchema>;
  shortlistedAt?: string | null | undefined;
  matchAssessment: MatchAssessment;
  provenance: SavedJobDiscoveryProvenance[];
  discoveryFeedback: DiscoveryFeedback | null;
  resumeApplicationMode: z.infer<typeof ResumeApplicationModeSchema> | null;
  /**
   * How far a tailored resume for this job may go, when the person chose a
   * level for this job. `null` follows the profile-wide setting.
   */
  resumeTailoringMode?: z.infer<typeof TailoringModeSchema> | null;
  latestMatchAssessmentAudit: MatchAssessmentChangeAudit | null;
};
type SavedJobInput = z.input<typeof JobPostingSchema> & {
  id: string;
  campaignIds?: string[] | undefined;
  personSupplied?: boolean | undefined;
  planAssessments?:
    | Record<string, z.input<typeof MatchAssessmentSchema>>
    | undefined;
  status: z.input<typeof ApplicationStatusSchema>;
  shortlistedAt?: string | null | undefined;
  matchAssessment: z.input<typeof MatchAssessmentSchema>;
  provenance?: z.input<typeof SavedJobDiscoveryProvenanceSchema>[] | undefined;
  discoveryFeedback?:
    | z.input<typeof DiscoveryFeedbackSchema>
    | null
    | undefined;
  resumeApplicationMode?:
    | z.input<typeof ResumeApplicationModeSchema>
    | null
    | undefined;
  resumeTailoringMode?: z.input<typeof TailoringModeSchema> | null | undefined;
  latestMatchAssessmentAudit?:
    | z.input<typeof MatchAssessmentChangeAuditSchema>
    | null
    | undefined;
};

const SavedJobObjectSchema = JobPostingSchema.extend({
  id: NonEmptyStringSchema,
  campaignIds: z.array(NonEmptyStringSchema).default([]),
  personSupplied: z.boolean().optional(),
  planAssessments: z.record(MatchAssessmentSchema).optional(),
  status: ApplicationStatusSchema,
  shortlistedAt: IsoDateTimeSchema.nullable().optional(),
  matchAssessment: MatchAssessmentSchema,
  provenance: z.array(SavedJobDiscoveryProvenanceSchema).default([]),
  discoveryFeedback: DiscoveryFeedbackSchema.nullable().default(null),
  resumeApplicationMode: ResumeApplicationModeSchema.nullable().default(null),
  resumeTailoringMode: TailoringModeSchema.nullable().default(null),
  latestMatchAssessmentAudit:
    MatchAssessmentChangeAuditSchema.nullable().default(null),
});
export const SavedJobSchema: z.ZodType<SavedJob, z.ZodTypeDef, SavedJobInput> =
  SavedJobObjectSchema;

/** Main's retained list facts; listing bodies remain behind repository reads. */
export const SavedJobListFactsSchema = SavedJobObjectSchema.omit({
  description: true,
  summary: true,
  keySkills: true,
  responsibilities: true,
  minimumQualifications: true,
  preferredQualifications: true,
  benefits: true,
  sourceIntelligence: true,
  screeningHints: true,
  keywordSignals: true,
}).extend({
  provenance: z
    .array(SavedJobDiscoveryProvenanceSchema.omit({ listingFacts: true }))
    .default([]),
});
export type SavedJobListFacts = z.infer<typeof SavedJobListFactsSchema>;

export const ListingActivitySchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("unknown"),
    })
    .strict(),
  z
    .object({
      status: z.literal("active"),
      observedAt: IsoDateTimeSchema,
      evidence: z.enum(["last_verified_active_at", "last_seen_at"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("inactive"),
      observedAt: IsoDateTimeSchema,
      ledgerEntryId: NonEmptyStringSchema,
      provenance: z.literal("discovery_ledger"),
      explanation: NonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("stale"),
      observedAt: IsoDateTimeSchema,
      signalId: NonEmptyStringSchema,
      provenance: z.enum(["provider", "browser", "user", "system"]),
      explanation: NonEmptyStringSchema,
      detail: NonEmptyStringSchema.nullable(),
      confidence: z.number().min(0).max(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("closed"),
      observedAt: IsoDateTimeSchema,
      signalId: NonEmptyStringSchema,
      provenance: z.enum(["provider", "browser", "user", "system"]),
      explanation: NonEmptyStringSchema,
      detail: NonEmptyStringSchema.nullable(),
      confidence: z.number().min(0).max(1),
    })
    .strict(),
]);
export type ListingActivity = z.infer<typeof ListingActivitySchema>;

export const DiscoveryJobViewSchema = SavedJobSchema.and(
  z.object({
    // Snapshot compatibility only. Persisted SavedJob rows deliberately do not
    // carry this derived projection, while newly built snapshots always set it.
    listingActivity: ListingActivitySchema.default({ status: "unknown" }),
  }),
);
export type DiscoveryJobView = z.infer<typeof DiscoveryJobViewSchema>;

/** List identity and workflow facts. Full listing evidence is read on demand. */
const JobListRowObjectSchema = JobPostingSchema.pick({
  source: true,
  sourceJobId: true,
  discoveryMethod: true,
  collectionMethod: true,
  canonicalUrl: true,
  applicationUrl: true,
  title: true,
  company: true,
  location: true,
  workMode: true,
  applyPath: true,
  easyApplyEligible: true,
  postedAt: true,
  postedAtText: true,
  providerUpdatedAt: true,
  discoveredAt: true,
  firstSeenAt: true,
  lastSeenAt: true,
  lastVerifiedActiveAt: true,
  salaryText: true,
  normalizedCompensation: true,
  detailQuality: true,
  listingDetailCapture: true,
  seniority: true,
  employmentType: true,
  employerDomain: true,
}).extend({
  id: NonEmptyStringSchema,
  campaignIds: z.array(NonEmptyStringSchema).default([]),
  personSupplied: z.boolean().optional(),
  status: ApplicationStatusSchema,
  matchAssessment: JobListMatchAssessmentSchema,
  provenance: z
    .array(SavedJobDiscoveryProvenanceSchema.omit({ listingFacts: true }))
    .default([]),
  discoveryFeedback: DiscoveryFeedbackSchema.nullable().default(null),
  resumeApplicationMode: ResumeApplicationModeSchema.nullable().default(null),
  resumeTailoringMode: TailoringModeSchema.nullable().default(null),
  listingActivity: ListingActivitySchema.default({ status: "unknown" }),
  /** Changes whenever omitted detail evidence changes; never contains that evidence. */
  detailRevision: NonEmptyStringSchema.optional(),
  rescoredAfterListingRead: z.boolean().optional(),
});
type JobListRowParsed = z.infer<typeof JobListRowObjectSchema>;
export type JobListRow = Omit<
  JobListRowParsed,
  "campaignIds" | "resumeTailoringMode" | "listingActivity"
> & {
  campaignIds?: string[];
  resumeTailoringMode?: JobListRowParsed["resumeTailoringMode"];
  listingActivity?: ListingActivity;
};
export const JobListRowSchema: z.ZodType<
  JobListRow,
  z.ZodTypeDef,
  z.input<typeof JobListRowObjectSchema>
> = JobListRowObjectSchema;

export const JobFinderJobDetailQuerySchema = z
  .object({
    jobId: NonEmptyStringSchema,
    planId: NonEmptyStringSchema.nullable(),
  })
  .strict();
export type JobFinderJobDetailQuery = z.infer<
  typeof JobFinderJobDetailQuerySchema
>;
export const JobFinderJobDetailSchema = z
  .object({
    job: SavedJobSchema,
    planId: NonEmptyStringSchema.nullable(),
  })
  .strict();
export type JobFinderJobDetail = z.infer<typeof JobFinderJobDetailSchema>;

export const TailoredAssetPreviewSectionSchema = z.object({
  heading: NonEmptyStringSchema,
  lines: z.array(NonEmptyStringSchema).default([]),
});
export type TailoredAssetPreviewSection = z.infer<
  typeof TailoredAssetPreviewSectionSchema
>;

export const TailoredAssetSchema = z.object({
  id: NonEmptyStringSchema,
  jobId: NonEmptyStringSchema,
  kind: z.literal("resume"),
  status: AssetStatusSchema,
  label: NonEmptyStringSchema,
  version: NonEmptyStringSchema,
  templateName: NonEmptyStringSchema,
  compatibilityScore: z.number().int().min(0).max(100).nullable(),
  progressPercent: z.number().int().min(0).max(100).nullable(),
  updatedAt: IsoDateTimeSchema,
  storagePath: NonEmptyStringSchema.nullable().default(null),
  contentText: NonEmptyStringSchema.nullable().default(null),
  previewSections: z.array(TailoredAssetPreviewSectionSchema).default([]),
  generationMethod: AssetGenerationMethodSchema.default("deterministic"),
  // Optional so assets saved before the structured reason existed, and the
  // many typed fixtures built from this shape, stay valid without churn.
  generationReason: AssetGenerationReasonSchema.nullable().optional(),
  generationDetail: NonEmptyStringSchema.nullable().optional(),
  /**
   * The level the text was written at. A job's level is saved before its
   * rewrite runs, so a rewrite a restart cut off left the job naming a level
   * the resume was never written at. Absent on assets written before this.
   */
  tailoringMode: TailoringModeSchema.nullable().optional(),
  notes: z.array(NonEmptyStringSchema).default([]),
  failureMessage: NonEmptyStringSchema.nullable().default(null),
  failedAt: IsoDateTimeSchema.nullable().default(null),
});
export type TailoredAsset = z.infer<typeof TailoredAssetSchema>;

/** List metadata; complete text and preview sections are loaded by asset id. */
export const TailoredAssetSummarySchema = TailoredAssetSchema.omit({
  contentText: true,
  previewSections: true,
}).strict();
export type TailoredAssetSummary = z.infer<typeof TailoredAssetSummarySchema>;

export const JobFinderTailoredAssetQuerySchema = z
  .object({
    assetId: NonEmptyStringSchema,
  })
  .strict();
export const JobFinderTailoredAssetDetailSchema =
  TailoredAssetSchema.nullable();

export const ReviewQueueResumeReviewStateSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("not_started"),
    }),
    z.object({
      status: z.literal("draft"),
    }),
    z.object({
      status: z.literal("needs_review"),
    }),
    z.object({
      status: z.literal("stale"),
      staleReason: NonEmptyStringSchema.nullable().default(null),
    }),
    z.object({
      status: z.literal("approved"),
      approvedAt: IsoDateTimeSchema,
      approvedExportId: NonEmptyStringSchema,
      approvedFormat: ResumeExportFormatSchema,
      approvedFilePath: NonEmptyStringSchema,
    }),
    z.object({
      status: z.literal("original_resume"),
      sourceDocumentId: NonEmptyStringSchema,
      fileName: NonEmptyStringSchema,
      filePath: NonEmptyStringSchema,
    }),
  ],
);
export type ReviewQueueResumeReviewState = z.infer<
  typeof ReviewQueueResumeReviewStateSchema
>;

export const ReviewQueueItemSchema = z.object({
  listingAssessmentPending: z.boolean().optional(),
  jobId: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  company: NonEmptyStringSchema,
  location: NonEmptyStringSchema,
  matchScore: z.number().int().min(0).max(100),
  applicationStatus: ApplicationStatusSchema,
  assetStatus: AssetStatusSchema,
  progressPercent: z.number().int().min(0).max(100).nullable(),
  resumeAssetId: NonEmptyStringSchema.nullable(),
  resumeApplicationMode:
    ResumeApplicationModeSchema.default("tailored_per_job"),
  /** The per-job tailoring level, or `null` when the profile setting applies. */
  resumeTailoringMode: TailoringModeSchema.nullable().optional(),
  /** The level the saved resume was written at, when the asset recorded it. */
  resumeWrittenTailoringMode: TailoringModeSchema.nullable().optional(),
  resumeReview: ReviewQueueResumeReviewStateSchema.default({
    status: "not_started",
  }),
  /**
   * Lines in the job's saved resume that still wait for the person's
   * decision. The export gate refuses the resume until each one is decided,
   * whatever the level, so a job with any is not ready to apply. Absent or 0
   * when nothing is waiting.
   */
  resumeLinesToDecide: z.number().int().min(0).optional(),
  /**
   * The saved resume kept the person's wording because the listing text was
   * missing or said nothing specific when it was written. Nothing was
   * tailored, so a batch may write it again once the listing can be read.
   */
  resumeWrittenWithoutListing: z.boolean().optional(),
  updatedAt: IsoDateTimeSchema,
});
export type ReviewQueueItem = z.infer<typeof ReviewQueueItemSchema>;

export const ApplicationEventSchema = z.object({
  id: NonEmptyStringSchema,
  at: IsoDateTimeSchema,
  title: NonEmptyStringSchema,
  detail: NonEmptyStringSchema,
  emphasis: ApplicationEventEmphasisSchema,
});
export type ApplicationEvent = z.infer<typeof ApplicationEventSchema>;

export const applicationQuestionKindValues = [
  "work_authorization",
  "visa_sponsorship",
  "salary_expectation",
  "availability",
  "notice_period",
  "portfolio",
  "cover_letter",
  "experience",
  "clearance",
  "relocation",
  "travel",
  "location",
  "personal_info",
  "resume",
  "other",
] as const;
export const ApplicationQuestionKindSchema = z.enum(
  applicationQuestionKindValues,
);
export type ApplicationQuestionKind = z.infer<
  typeof ApplicationQuestionKindSchema
>;

export const applicationQuestionControlTypeValues = [
  "text",
  "single_choice",
  "multi_choice",
  "boolean",
  "date",
  "file",
] as const;
export const ApplicationQuestionControlTypeSchema = z.enum(
  applicationQuestionControlTypeValues,
);
export type ApplicationQuestionControlType = z.infer<
  typeof ApplicationQuestionControlTypeSchema
>;

export const applicationAnswerSourceKindValues = [
  "profile",
  "proof_bank",
  "resume",
  "job",
  "prior_answer",
  "source_debug",
  "user",
] as const;
export const ApplicationAnswerSourceKindSchema = z.enum(
  applicationAnswerSourceKindValues,
);
export type ApplicationAnswerSourceKind = z.infer<
  typeof ApplicationAnswerSourceKindSchema
>;

export const applicationQuestionStatusValues = [
  "detected",
  "answered",
  "submitted",
  "skipped",
] as const;
export const ApplicationQuestionStatusSchema = z.enum(
  applicationQuestionStatusValues,
);
export type ApplicationQuestionStatus = z.infer<
  typeof ApplicationQuestionStatusSchema
>;

export const applicationBlockerCodeValues = [
  "missing_candidate_answer",
  "requires_manual_review",
  "application_closed",
  "unsupported_apply_path",
  "missing_resume",
  "missing_consent",
  "external_redirect",
  "site_login_required",
  "browser_blocked",
  // Technical failure raised only at the application goto boundary: the
  // dedicated browser never opened the employer page, so nothing was prepared.
  "application_page_unreachable",
  // The form saves each answer to the site as it is typed. Nothing left the
  // page; the person can allow saving on this site and carry on.
  "site_saves_as_you_go",
  "unknown",
] as const;
export const ApplicationBlockerCodeSchema = z.enum(
  applicationBlockerCodeValues,
);
export type ApplicationBlockerCode = z.infer<
  typeof ApplicationBlockerCodeSchema
>;

export const applicationConsentKindValues = [
  "resume_use",
  "autofill_profile",
  "external_redirect",
  "manual_follow_up",
] as const;
export const ApplicationConsentKindSchema = z.enum(
  applicationConsentKindValues,
);
export type ApplicationConsentKind = z.infer<
  typeof ApplicationConsentKindSchema
>;

export const applicationConsentStatusValues = [
  "requested",
  "approved",
  "declined",
  "not_needed",
] as const;
export const ApplicationConsentStatusSchema = z.enum(
  applicationConsentStatusValues,
);
export type ApplicationConsentStatus = z.infer<
  typeof ApplicationConsentStatusSchema
>;

export const applicationConsentSummaryStatusValues = [
  "none",
  "requested",
  "approved",
  "declined",
] as const;
export const ApplicationConsentSummaryStatusSchema = z.enum(
  applicationConsentSummaryStatusValues,
);
export type ApplicationConsentSummaryStatus = z.infer<
  typeof ApplicationConsentSummaryStatusSchema
>;

export const ApplicationAnswerProvenanceSchema = z.object({
  id: NonEmptyStringSchema,
  sourceKind: ApplicationAnswerSourceKindSchema.default("profile"),
  sourceId: NonEmptyStringSchema.nullable().default(null),
  label: NonEmptyStringSchema,
  snippet: NonEmptyStringSchema.nullable().default(null),
});
export type ApplicationAnswerProvenance = z.infer<
  typeof ApplicationAnswerProvenanceSchema
>;

export const ApplicationAttemptSuggestedAnswerSchema = z.object({
  id: NonEmptyStringSchema,
  text: NonEmptyStringSchema,
  sourceKind: ApplicationAnswerSourceKindSchema.default("profile"),
  sourceId: NonEmptyStringSchema.nullable().default(null),
  confidenceLabel: NonEmptyStringSchema.nullable().default(null),
  provenance: z.array(ApplicationAnswerProvenanceSchema).default([]),
});
export type ApplicationAttemptSuggestedAnswer = z.infer<
  typeof ApplicationAttemptSuggestedAnswerSchema
>;

export const ApplicationQuestionInputConstraintsSchema = z.object({
  type: z.enum(["number", "date", "month"]),
  min: z.string().optional(),
  max: z.string().optional(),
  step: z.string().optional(),
});

export const ApplicationAttemptQuestionSchema = z.object({
  askReason: ApplicationQuestionAskReasonSchema.optional(),
  id: NonEmptyStringSchema,
  prompt: NonEmptyStringSchema,
  repeatedAtDifferentStep: optionalStoredField(z.boolean(), false),
  /**
   * The words around the question on the page — the group it sat in, or the
   * note under it — when they say something the prompt does not.
   */
  description: NonEmptyStringSchema.nullable().optional(),
  kind: ApplicationQuestionKindSchema.default("other"),
  answerControlType: ApplicationQuestionControlTypeSchema.optional(),
  inputConstraints: ApplicationQuestionInputConstraintsSchema.optional(),
  isRequired: z.boolean().default(true),
  /**
   * Why this one came back to the person, in their own words. Set when an
   * answer they gave did not fit the choices, so the retry says so instead of
   * asking the identical question again.
   */
  note: NonEmptyStringSchema.nullable().optional(),
  detectedAt: IsoDateTimeSchema,
  answerOptions: z.array(NonEmptyStringSchema).default([]),
  suggestedAnswers: z
    .array(ApplicationAttemptSuggestedAnswerSchema)
    .default([]),
  submittedAnswer: NonEmptyStringSchema.nullable().default(null),
  status: ApplicationQuestionStatusSchema.default("detected"),
});
export type ApplicationAttemptQuestion = z.infer<
  typeof ApplicationAttemptQuestionSchema
>;

export const applicationAttemptExternalWriteCategoryValues = [
  "resume_attachment",
  "profile_field",
  "application_answer",
  "consent_control",
  "other",
] as const;
export const ApplicationAttemptExternalWriteCategorySchema = z.enum(
  applicationAttemptExternalWriteCategoryValues,
);
export type ApplicationAttemptExternalWriteCategory = z.infer<
  typeof ApplicationAttemptExternalWriteCategorySchema
>;

export const ApplicationAttemptExternalWriteEvidenceSchema = z.object({
  category: ApplicationAttemptExternalWriteCategorySchema,
  fieldLabel: NonEmptyStringSchema,
  occurredAt: IsoDateTimeSchema,
  verified: z.boolean().default(false),
});
export type ApplicationAttemptExternalWriteEvidence = z.infer<
  typeof ApplicationAttemptExternalWriteEvidenceSchema
>;
export const ApplicationAttemptBlockerSchema = z.object({
  code: ApplicationBlockerCodeSchema.default("unknown"),
  userActionKind: UserActionRequestKindSchema.nullable().optional(),
  summary: NonEmptyStringSchema,
  detail: NonEmptyStringSchema.nullable().default(null),
  questionIds: z.array(NonEmptyStringSchema).default([]),
  sourceDebugEvidenceRefIds: z.array(NonEmptyStringSchema).default([]),
  url: UrlStringSchema.nullable().default(null),
});
export type ApplicationAttemptBlocker = z.infer<
  typeof ApplicationAttemptBlockerSchema
>;

export const ApplicationAttemptConsentDecisionSchema = z.object({
  id: NonEmptyStringSchema,
  kind: ApplicationConsentKindSchema.default("resume_use"),
  label: NonEmptyStringSchema,
  status: ApplicationConsentStatusSchema.default("requested"),
  decidedAt: IsoDateTimeSchema.nullable().default(null),
  detail: NonEmptyStringSchema.nullable().default(null),
});
export type ApplicationAttemptConsentDecision = z.infer<
  typeof ApplicationAttemptConsentDecisionSchema
>;

export const ApplicationAttemptReplaySchema = z.object({
  sourceInstructionArtifactId: NonEmptyStringSchema.nullable().default(null),
  sourceDebugEvidenceRefIds: z.array(NonEmptyStringSchema).default([]),
  lastUrl: UrlStringSchema.nullable().default(null),
  checkpointUrls: z.array(UrlStringSchema).default([]),
});
export type ApplicationAttemptReplay = z.infer<
  typeof ApplicationAttemptReplaySchema
>;

export const ApplicationAttemptQuestionSummarySchema = z.object({
  total: z.number().int().nonnegative().default(0),
  required: z.number().int().nonnegative().default(0),
  answered: z.number().int().nonnegative().default(0),
  unansweredRequired: z.number().int().nonnegative().default(0),
});
export type ApplicationAttemptQuestionSummary = z.infer<
  typeof ApplicationAttemptQuestionSummarySchema
>;

export const ApplicationAttemptBlockerSummarySchema = z.object({
  code: ApplicationBlockerCodeSchema.default("unknown"),
  summary: NonEmptyStringSchema,
});
export type ApplicationAttemptBlockerSummary = z.infer<
  typeof ApplicationAttemptBlockerSummarySchema
>;

export const ApplicationAttemptConsentSummarySchema = z.object({
  status: ApplicationConsentSummaryStatusSchema.default("none"),
  pendingCount: z.number().int().nonnegative().default(0),
});
export type ApplicationAttemptConsentSummary = z.infer<
  typeof ApplicationAttemptConsentSummarySchema
>;

export const ApplicationAttemptReplaySummarySchema = z.object({
  lastUrl: UrlStringSchema.nullable().default(null),
  checkpointCount: z.number().int().nonnegative().default(0),
  evidenceCount: z.number().int().nonnegative().default(0),
  sourceInstructionArtifactId: NonEmptyStringSchema.nullable().default(null),
});
export type ApplicationAttemptReplaySummary = z.infer<
  typeof ApplicationAttemptReplaySummarySchema
>;

export const ApplicationAttemptCheckpointSchema = z.object({
  id: NonEmptyStringSchema,
  at: IsoDateTimeSchema,
  label: NonEmptyStringSchema,
  detail: NonEmptyStringSchema,
  state: ApplicationAttemptStateSchema,
  visualEvidence: z.array(BrowserVisualEvidenceSummarySchema).default([]),
});
export type ApplicationAttemptCheckpoint = z.infer<
  typeof ApplicationAttemptCheckpointSchema
>;

export const applyExecutionStageValues = [
  "browser_preparation",
  "form_preparation",
  "visual_diagnostics",
  "total",
] as const;
export const ApplyExecutionStageSchema = z.enum(applyExecutionStageValues);
export type ApplyExecutionStage = z.infer<typeof ApplyExecutionStageSchema>;

export const ApplyExecutionTimingSchema = z.object({
  stage: ApplyExecutionStageSchema,
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema,
  durationMs: z.number().nonnegative(),
});
export type ApplyExecutionTiming = z.infer<typeof ApplyExecutionTimingSchema>;

export const ApplicationUserActionResumptionSchema = z
  .object({
    requestId: NonEmptyStringSchema,
    requestRevision: z.number().int().positive(),
    verificationEventId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    jobId: NonEmptyStringSchema,
    resultId: NonEmptyStringSchema,
    replayCheckpointId: NonEmptyStringSchema,
  })
  .strict();
export type ApplicationUserActionResumption = z.infer<
  typeof ApplicationUserActionResumptionSchema
>;

export const ApplicationAttemptSchema = z.object({
  id: NonEmptyStringSchema,
  jobId: NonEmptyStringSchema,
  applicationRecordId: NonEmptyStringSchema.nullable().default(null),
  state: ApplicationAttemptStateSchema,
  summary: NonEmptyStringSchema,
  detail: NonEmptyStringSchema,
  startedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable(),
  outcome: ApplicationStatusSchema.nullable(),
  checkpoints: z.array(ApplicationAttemptCheckpointSchema).default([]),
  questions: z.array(ApplicationAttemptQuestionSchema).default([]),
  blocker: ApplicationAttemptBlockerSchema.nullable().default(null),
  listingSignalEvidence:
    ApplicationListingSignalEvidenceSchema.nullable().default(null),
  consentDecisions: z
    .array(ApplicationAttemptConsentDecisionSchema)
    .default([]),
  replay: ApplicationAttemptReplaySchema.default({}),
  visualEvidence: z.array(BrowserVisualEvidenceSummarySchema).default([]),
  visualObservationSets: z.array(BrowserVisualObservationSetSchema).default([]),
  visualCheckpoints: z.array(ApplyVisualCheckpointSchema).default([]),
  nextActionLabel: NonEmptyStringSchema.nullable(),
  executionTimings: z.array(ApplyExecutionTimingSchema).default([]),
  agentTiming: ApplyAgentTimingSchema.optional(),
  userActionResumption: ApplicationUserActionResumptionSchema.optional(),
});
export type ApplicationAttempt = z.infer<typeof ApplicationAttemptSchema>;
export type ApplicationAttemptInput = z.input<typeof ApplicationAttemptSchema>;

/** Current attempt facts; historical visual/checkpoint bodies stay in storage. */
export const ApplicationAttemptListRowSchema = ApplicationAttemptSchema.omit({
  checkpoints: true,
  visualEvidence: true,
  visualObservationSets: true,
  visualCheckpoints: true,
}).strict();
export type ApplicationAttemptListRow = z.infer<
  typeof ApplicationAttemptListRowSchema
>;

/**
 * One use of a model during application preparation, for the privacy
 * receipt. The agent that fills a form is a model loop; a receipt that says
 * nothing went to a model is false, and this is how it stays true.
 */
export const ApplyExecutionModelUseSchema = z.object({
  purpose: z.enum([
    "application_answering",
    "resume_generation",
    "visual_interpretation",
    "other",
  ]),
  providerLabel: NonEmptyStringSchema,
  modelLabel: NonEmptyStringSchema.nullable().default(null),
  occurredAt: IsoDateTimeSchema,
  turns: z.number().int().nonnegative().default(0),
});
export type ApplyExecutionModelUse = z.infer<
  typeof ApplyExecutionModelUseSchema
>;

/** Choices a picker on this application refused, kept so a rerun does not retry them. */
export const ApplyPickerAttemptSchema = z.object({
  question: z.string().min(1).max(2000),
  tried: z.array(z.string().max(300)).max(20),
  /** The refused choices a list that finished loading said it does not have. */
  notOffered: z.array(z.string().max(300)).max(20).default([]),
  offeredOptions: z.array(z.string().max(300)).max(500),
});
export type ApplyPickerAttempt = z.infer<typeof ApplyPickerAttemptSchema>;
/**
 * One move Fill made between the form's screens: the button that opened the
 * form, a cookie banner, a link it followed. `from` is the screen it was on
 * (address without query, and step label). A restore follows the same path.
 */
export const ApplyFormPathStepSchema = z.object({
  from: z.string().max(2_000),
  tool: z.enum(["click", "follow_link", "navigate"]),
  label: z.string().max(300),
  href: z.string().max(4_096).optional(),
});
export type ApplyFormPathStep = z.infer<typeof ApplyFormPathStepSchema>;
/** As stored by a run from before `notOffered` was kept. */
export type StoredApplyPickerAttempt = z.input<typeof ApplyPickerAttemptSchema>;

export const ApplyExecutionResultSchema = z.object({
  pickerAttempts: optionalStoredField(
    z.array(ApplyPickerAttemptSchema).max(200),
    [],
  ),
  formPath: optionalStoredField(z.array(ApplyFormPathStepSchema).max(40), []),
  skipReason: optionalStoredField(z.string().min(1).max(2000).nullable(), null),
  applyUsageTotals: optionalStoredField(
    ApplicationApplyUsageTotalsSchema.nullable(),
    null,
  ),
  questionContexts: optionalStoredField(
    z
      .array(
        z.object({ prompt: z.string().max(2000), step: z.string().max(5000) }),
      )
      .max(2000),
    [],
  ),
  answerDependencies: ApplicationAnswerDependenciesSchema.optional(),
  state: ApplicationAttemptStateSchema,
  summary: NonEmptyStringSchema,
  detail: NonEmptyStringSchema,
  submittedAt: IsoDateTimeSchema.nullable(),
  outcome: ApplicationStatusSchema.nullable(),
  checkpoints: z.array(ApplicationAttemptCheckpointSchema).default([]),
  questions: z.array(ApplicationAttemptQuestionSchema).default([]),
  blocker: ApplicationAttemptBlockerSchema.nullable().default(null),
  listingSignalEvidence:
    ApplicationListingSignalEvidenceSchema.nullable().default(null),
  consentDecisions: z
    .array(ApplicationAttemptConsentDecisionSchema)
    .default([]),
  replay: ApplicationAttemptReplaySchema.default({}),
  visualEvidence: z.array(BrowserVisualEvidenceSummarySchema).default([]),
  visualObservationSets: z.array(BrowserVisualObservationSetSchema).default([]),
  visualCheckpoints: z.array(ApplyVisualCheckpointSchema).default([]),
  nextActionLabel: NonEmptyStringSchema.nullable(),
  executionTimings: z.array(ApplyExecutionTimingSchema).default([]),
  agentTiming: ApplyAgentTimingSchema.optional(),
  externalWrites: z
    .array(ApplicationAttemptExternalWriteEvidenceSchema)
    .optional(),
  modelUse: z.array(ApplyExecutionModelUseSchema).default([]),
});
export type ApplyExecutionResult = z.infer<typeof ApplyExecutionResultSchema>;

export const AgentDebugFindingsSchema = z.object({
  summary: NonEmptyStringSchema.nullable().default(null),
  reliableControls: z.array(NonEmptyStringSchema).default([]),
  trickyFilters: z.array(NonEmptyStringSchema).default([]),
  navigationTips: z.array(NonEmptyStringSchema).default([]),
  applyTips: z.array(NonEmptyStringSchema).default([]),
  warnings: z.array(NonEmptyStringSchema).default([]),
  visualFindings: z.array(BrowserVisualEvidenceSummarySchema).default([]),
  visualObservationSets: z.array(BrowserVisualObservationSetSchema).default([]),
});
export type AgentDebugFindings = z.infer<typeof AgentDebugFindingsSchema>;

export const DiscoveryAgentMetadataSchema = z.object({
  coveredPageUrls: z.array(UrlStringSchema).optional(),
  deferredListingPageUrls: z.array(UrlStringSchema).optional(),
  duplicateListingPageUrls: z.array(UrlStringSchema).optional(),
  duplicateListings: z.number().int().nonnegative().optional(),
  unreadableListings: z.array(RejectedListingSchema).optional(),
  pagesCovered: z.number().int().nonnegative().optional(),
  steps: z.number().int().nonnegative().default(0),
  incomplete: z.boolean().default(false),
  transcriptMessageCount: z.number().int().nonnegative().default(0),
  reviewTranscript: z.array(NonEmptyStringSchema).default([]),
  compactionState: SourceDebugCompactionStateSchema.nullable().default(null),
  compactionUsedFallbackTrigger: z.boolean().default(false),
  phaseCompletionMode:
    SourceDebugPhaseCompletionModeSchema.nullable().default(null),
  phaseCompletionReason: NonEmptyStringSchema.nullable().default(null),
  phaseEvidence: SourceDebugPhaseEvidenceSchema.nullable().default(null),
  debugFindings: AgentDebugFindingsSchema.nullable().default(null),
  accessBlockerReason: DiscoveryAccessBlockerReasonSchema.nullable().optional(),
  parkedTab: ParkedBrowserTabReferenceSchema.nullable().optional(),
});
export type DiscoveryAgentMetadata = z.infer<
  typeof DiscoveryAgentMetadataSchema
>;

export const DiscoveryInventoryCompletenessSchema = z.enum([
  "complete",
  "partial",
  "unknown",
]);
export type DiscoveryInventoryCompleteness = z.infer<
  typeof DiscoveryInventoryCompletenessSchema
>;

export const DiscoveryRunResultSchema = z.object({
  source: JobSourceSchema,
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema,
  querySummary: NonEmptyStringSchema,
  warning: NonEmptyStringSchema.nullable(),
  inventoryCompleteness:
    DiscoveryInventoryCompletenessSchema.default("unknown"),
  jobs: z.array(JobPostingSchema).default([]),
  agentMetadata: DiscoveryAgentMetadataSchema.nullable().default(null),
});
export type DiscoveryRunResult = z.infer<typeof DiscoveryRunResultSchema>;
export type DiscoveryRunResultInput = z.input<typeof DiscoveryRunResultSchema>;

export const DiscoveryAdapterSessionStateSchema = z.object({
  adapterKind: JobSourceSchema,
  status: BrowserSessionStatusSchema,
  driver: BrowserDriverSchema.default("catalog_seed"),
  label: NonEmptyStringSchema,
  detail: NonEmptyStringSchema.nullable().default(null),
  lastCheckedAt: IsoDateTimeSchema,
});
export type DiscoveryAdapterSessionState = z.infer<
  typeof DiscoveryAdapterSessionStateSchema
>;

export const DiscoveryStageDurationSchema = z.object({
  stage: DiscoveryActivityStageSchema,
  durationMs: z.number().int().nonnegative().default(0),
});
export type DiscoveryStageDuration = z.infer<
  typeof DiscoveryStageDurationSchema
>;

export const DiscoveryWaitReasonDurationSchema = z.object({
  waitReason: BrowserRunWaitReasonSchema,
  durationMs: z.number().int().nonnegative().default(0),
});
export type DiscoveryWaitReasonDuration = z.infer<
  typeof DiscoveryWaitReasonDurationSchema
>;

export const DiscoveryTimingSummarySchema = z.object({
  totalDurationMs: z.number().int().nonnegative().default(0),
  firstActivityMs: z.number().int().nonnegative().nullable().default(null),
  firstCandidateMs: z.number().int().nonnegative().nullable().default(null),
  firstDistinctUsefulJobMs: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .default(null),
  longestGapMs: z.number().int().nonnegative().default(0),
  eventCount: z.number().int().nonnegative().default(0),
  stageDurations: z.array(DiscoveryStageDurationSchema).default([]),
  waitReasonDurations: z.array(DiscoveryWaitReasonDurationSchema).default([]),
});

export const DiscoveryChangeDigestSchema = z.object({
  new: z.number().int().nonnegative().default(0),
  unchanged: z.number().int().nonnegative().default(0),
  changed: z.number().int().nonnegative().default(0),
  reactivated: z.number().int().nonnegative().default(0),
  inactive: z.number().int().nonnegative().default(0),
  known: z.number().int().nonnegative().default(0),
  skipped: z.number().int().nonnegative().default(0),
});
export type DiscoveryChangeDigest = z.infer<typeof DiscoveryChangeDigestSchema>;

export const DiscoverySourceHealthStateSchema = z.enum([
  "healthy",
  "warning",
  "failed",
  "cancelled",
  "skipped",
  "pending",
]);
export type DiscoverySourceHealthState = z.infer<
  typeof DiscoverySourceHealthStateSchema
>;

export const DiscoverySourceHealthSummarySchema = z.object({
  targetId: NonEmptyStringSchema,
  health: DiscoverySourceHealthStateSchema,
  durationMs: z.number().int().nonnegative().default(0),
  warnings: z.array(NonEmptyStringSchema).default([]),
});
export type DiscoverySourceHealthSummary = z.infer<
  typeof DiscoverySourceHealthSummarySchema
>;

export interface BrowserAgentRunCheckpoint {
  revision: number;
  savedAt: string;
  currentUrl: string;
  lastStableUrl: string;
  stepCount: number;
  collectedJobs: JobPosting[];
  visitedUrls: string[];
  phaseEvidence: z.infer<typeof SourceDebugPhaseEvidenceSchema>;
}

export const BrowserAgentRunCheckpointSchema: z.ZodType<
  BrowserAgentRunCheckpoint,
  z.ZodTypeDef,
  unknown
> = z.object({
  revision: z.number().int().nonnegative(),
  savedAt: IsoDateTimeSchema,
  currentUrl: z.string(),
  lastStableUrl: z.string(),
  stepCount: z.number().int().nonnegative(),
  collectedJobs: z.array(JobPostingSchema).default([]),
  visitedUrls: z.array(UrlStringSchema).default([]),
  phaseEvidence: SourceDebugPhaseEvidenceSchema,
});

export const DiscoverySourceListingCountsSchema = z.object({
  sourceId: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  startingUrl: UrlStringSchema,
  inspected: z.number().int().nonnegative(),
  saved: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
  pagesCovered: z.number().int().nonnegative().nullable(),
});
export const DiscoveryTargetExecutionSchema = z.object({
  sourceCounts: z.array(DiscoverySourceListingCountsSchema).optional(),
  inspectedJobIds: z.array(NonEmptyStringSchema).optional(),
  uniqueInspectionsKnown: z.boolean().optional(),
  targetId: NonEmptyStringSchema,
  adapterKind: JobSourceAdapterKindSchema,
  resolvedAdapterKind: JobSourceSchema.nullable().default(null),
  collectionMethod: JobDiscoveryCollectionMethodSchema.nullable().default(null),
  sourceIntelligenceProvider:
    SourceIntelligenceProviderKeySchema.nullable().default(null),
  state: DiscoveryTargetExecutionStateSchema,
  startedAt: IsoDateTimeSchema.nullable().default(null),
  completedAt: IsoDateTimeSchema.nullable().default(null),
  requestedJobBudget: z.number().int().positive().nullable().default(null),
  jobsInspected: z.number().int().nonnegative().optional(),
  rejectedListings: z.array(RejectedListingSchema).optional(),
  listingsDeferred: z.number().int().nonnegative().optional(),
  pagesCovered: z.number().int().nonnegative().optional(),
  jobsReviewed: z.number().int().nonnegative().default(0),
  jobsFound: z.number().int().nonnegative().default(0),
  jobsPersisted: z.number().int().nonnegative().default(0),
  jobsStaged: z.number().int().nonnegative().default(0),
  jobsSkippedByLedger: z.number().int().nonnegative().default(0),
  jobsSkippedByTitleTriage: z.number().int().nonnegative().default(0),
  duplicatesMerged: z.number().int().nonnegative().default(0),
  invalidSkipped: z.number().int().nonnegative().default(0),
  changeDigest: DiscoveryChangeDigestSchema.default({}),
  warning: NonEmptyStringSchema.nullable().default(null),
  accessBlockerReason: DiscoveryAccessBlockerReasonSchema.nullable().optional(),
  parkedTab: ParkedBrowserTabReferenceSchema.nullable().optional(),
  compactionState: SharedAgentCompactionSnapshotSchema.nullable().default(null),
  compactionUsedFallbackTrigger: z.boolean().default(false),
  timing: DiscoveryTimingSummarySchema.nullable().default(null),
  agentCheckpoint: BrowserAgentRunCheckpointSchema.nullable().default(null),
  /**
   * Saved-job ids for every listing this target execution actually collected,
   * re-seen duplicates included. Campaign membership reads this rather than
   * the resume checkpoint: a checkpoint only carries the batch the agent had
   * open when it was written, so a run that finished in one pass recorded no
   * encountered listing at all and its plan retained nothing. Empty for runs
   * recorded before the field existed.
   */
  encounteredJobIds: z.array(NonEmptyStringSchema).default([]),
});

export const DiscoveryActivityEventSchema = z.object({
  progress: z
    .object({
      phase: z.enum(["reading_listings", "judging_fit"]),
      completed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .optional(),
  id: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  timestamp: IsoDateTimeSchema,
  kind: DiscoveryActivityKindSchema,
  stage: DiscoveryActivityStageSchema,
  waitReason: BrowserRunWaitReasonSchema.nullable().default(null),
  targetId: NonEmptyStringSchema.nullable().default(null),
  adapterKind: JobSourceAdapterKindSchema.nullable().default(null),
  resolvedAdapterKind: JobSourceSchema.nullable().default(null),
  collectionMethod: JobDiscoveryCollectionMethodSchema.nullable().default(null),
  sourceIntelligenceProvider:
    SourceIntelligenceProviderKeySchema.nullable().default(null),
  message: NonEmptyStringSchema,
  terminalState: DiscoveryActivityTerminalStateSchema.nullable().default(null),
  url: UrlStringSchema.nullable().default(null),
  jobsFound: z.number().int().nonnegative().nullable().default(null),
  jobsPersisted: z.number().int().nonnegative().nullable().default(null),
  jobsStaged: z.number().int().nonnegative().nullable().default(null),
  duplicatesMerged: z.number().int().nonnegative().nullable().default(null),
  invalidSkipped: z.number().int().nonnegative().nullable().default(null),
});
export type DiscoveryActivityEvent = z.infer<
  typeof DiscoveryActivityEventSchema
>;

/**
 * The persisted run activity below is the complete, append-only history. The
 * renderer receives a separate rolling projection while a run is live, so a
 * chatty source cannot make the UI retain one entry for every progress tick.
 * Run-level (target-less) activity is limited to this many non-terminal
 * entries. The projection also keeps the latest event and the latest
 * terminal/error event for each source, so source truth is not lost when old
 * progress is compacted.
 */
export const DISCOVERY_LIVE_ACTIVITY_EVENT_LIMIT = 256;

function isTerminalOrErrorDiscoveryActivityEvent(
  event: DiscoveryActivityEvent,
): boolean {
  return event.terminalState !== null || event.kind === "error";
}

function findLastTerminalOrErrorDiscoveryActivityEvent(
  events: readonly DiscoveryActivityEvent[],
): DiscoveryActivityEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && isTerminalOrErrorDiscoveryActivityEvent(event)) {
      return event;
    }
  }

  return undefined;
}

function getDiscoveryActivitySourceKey(event: DiscoveryActivityEvent): string {
  return `${event.runId}:${event.targetId ?? "__run__"}`;
}

/**
 * Adds an event to the bounded live activity projection.
 *
 * This is intentionally different from appending to `DiscoveryRunRecord`
 * history: the persisted record remains complete for search, timing, and
 * recovery. For each source, the projection keeps its latest event and, when
 * distinct, its latest terminal/error event. Target-less progress is a rolling
 * window capped by `DISCOVERY_LIVE_ACTIVITY_EVENT_LIMIT`; the latest
 * target-less terminal/error event for each run is retained as well.
 */
export function appendDiscoveryLiveActivityEvent(
  current: readonly DiscoveryActivityEvent[],
  event: DiscoveryActivityEvent,
): DiscoveryActivityEvent[] {
  const sourceKey = getDiscoveryActivitySourceKey(event);
  const currentRunEvents = current.filter(
    (candidate) => candidate.runId === event.runId,
  );

  if (event.targetId !== null) {
    const sourceEvents = currentRunEvents.filter(
      (candidate) =>
        candidate.targetId !== null &&
        getDiscoveryActivitySourceKey(candidate) === sourceKey,
    );
    const previousTerminal =
      findLastTerminalOrErrorDiscoveryActivityEvent(sourceEvents);
    const nextSourceEvents = isTerminalOrErrorDiscoveryActivityEvent(event)
      ? [event]
      : previousTerminal
        ? [event, previousTerminal]
        : [event];

    return [
      ...currentRunEvents.filter(
        (candidate) => getDiscoveryActivitySourceKey(candidate) !== sourceKey,
      ),
      ...nextSourceEvents,
    ];
  }

  const next = [...currentRunEvents, event];
  const runActivity = next.filter((candidate) => candidate.targetId === null);
  const latestCriticalRunEvent =
    findLastTerminalOrErrorDiscoveryActivityEvent(runActivity);
  const rollingRunEvents = runActivity
    .filter((candidate) => !isTerminalOrErrorDiscoveryActivityEvent(candidate))
    .slice(-DISCOVERY_LIVE_ACTIVITY_EVENT_LIMIT);
  const retainedRunEvents = latestCriticalRunEvent
    ? [...rollingRunEvents, latestCriticalRunEvent]
    : rollingRunEvents;
  const retainedRunEventIds = new Set(
    retainedRunEvents.map((candidate) => candidate.id),
  );

  return next.filter(
    (candidate) =>
      candidate.targetId !== null || retainedRunEventIds.has(candidate.id),
  );
}

export const DiscoveryRunSummarySchema = z.object({
  targetsPlanned: z.number().int().nonnegative().default(0),
  targetsCompleted: z.number().int().nonnegative().default(0),
  validJobsFound: z.number().int().nonnegative().default(0),
  jobsPersisted: z.number().int().nonnegative().default(0),
  jobsStaged: z.number().int().nonnegative().default(0),
  jobsSkippedByLedger: z.number().int().nonnegative().default(0),
  jobsSkippedByTitleTriage: z.number().int().nonnegative().default(0),
  duplicatesMerged: z.number().int().nonnegative().default(0),
  invalidSkipped: z.number().int().nonnegative().default(0),
  changeDigest: DiscoveryChangeDigestSchema.default({}),
  sourceHealth: z.array(DiscoverySourceHealthSummarySchema).default([]),
  warnings: z.array(NonEmptyStringSchema).default([]),
  durationMs: z.number().int().nonnegative().default(0),
  outcome: DiscoveryRunStateSchema.default("idle"),
  browserCloseout: BrowserRunCloseoutSchema.nullable().default(null),
  timing: DiscoveryTimingSummarySchema.nullable().default(null),
  /**
   * The frozen run accounting every surface reads. Null for runs recorded
   * before the report existed and for runs still in flight.
   */
  report: DiscoveryRunReportSchema.nullable().default(null),
});
export type DiscoveryRunSummary = z.infer<typeof DiscoveryRunSummarySchema>;

/**
 * How far a search run got, independent of why it ended.
 *
 * A run that was still scoring results when the app closed used to leave only
 * `state: "running"` behind. On the next start the app said "50 new jobs
 * saved" about work it had dropped, then "Nothing was deleted" over a list of
 * 15. The phase is the durable fact a screen can read: results land as they
 * are scored, an interrupted run says so and names what it kept, and a
 * complete run is complete.
 */
export const discoveryRunPhaseValues = [
  "in_progress",
  "interrupted",
  "complete",
] as const;
export const DiscoveryRunPhaseSchema = z.enum(discoveryRunPhaseValues);
export type DiscoveryRunPhase = z.infer<typeof DiscoveryRunPhaseSchema>;

export const DiscoveryRunRecordSchema = z.object({
  id: NonEmptyStringSchema,
  campaignId: NonEmptyStringSchema.nullable().default(null),
  state: DiscoveryRunStateSchema,
  /**
   * Null for runs recorded before the phase existed; read it through
   * {@link getDiscoveryRunPhase}, which derives the honest value from the
   * run state instead of guessing "complete" for everything.
   */
  runPhase: DiscoveryRunPhaseSchema.nullable().default(null),
  cancellationRequestedAt: IsoDateTimeSchema.nullable().optional(),
  scope: DiscoveryRunScopeSchema.default("run_all"),
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable().default(null),
  targetIds: z.array(NonEmptyStringSchema).default([]),
  searchIntent: z.string().trim().max(1_000).optional(),
  searchBreadth: z.enum(["best_only", "wide"]).nullable().optional(),
  searchFreshness: z.enum(["any", "recent"]).optional(),
  targetExecutions: z.array(DiscoveryTargetExecutionSchema).default([]),
  activity: z.array(DiscoveryActivityEventSchema).default([]),
  summary: DiscoveryRunSummarySchema.default({}),
});
export type DiscoveryRunRecord = z.infer<typeof DiscoveryRunRecordSchema>;

/**
 * The run's phase, deriving an honest value for records written before the
 * field existed: a run still marked running is in progress, and any terminal
 * state is complete. It never invents "interrupted"; only recovery, which
 * actually observed the interruption, writes that.
 */
export function getDiscoveryRunPhase(
  run: Pick<DiscoveryRunRecord, "runPhase" | "state">,
): DiscoveryRunPhase {
  if (run.runPhase !== null) return run.runPhase;
  return run.state === "running" || run.state === "idle"
    ? "in_progress"
    : "complete";
}

/**
 * What the app says about a run the close interrupted, and what it kept.
 *
 * The counts come from the run's own frozen report, never recomputed from
 * current inventory: quoting the report is the whole point, since recomputing
 * is what produced three different answers for one search.
 */
export function describeInterruptedDiscoveryRun(
  run: Pick<DiscoveryRunRecord, "summary">,
): string {
  const saved = run.summary.report?.saved ?? null;
  if (saved === null) {
    return "This search stopped when the app closed. Everything it had saved before then was kept; the rest of the search did not run.";
  }
  return saved === 1
    ? "This search stopped when the app closed. The 1 result it had already saved was kept; the rest of the search did not run."
    : `This search stopped when the app closed. The ${saved} results it had already saved were kept; the rest of the search did not run.`;
}

/**
 * What the service says when a second search is asked for while one is still
 * running (including while a Stop is still finishing). Plain user copy, shared
 * so the renderer can recognise it and show "still stopping" instead of a
 * failure.
 */
/**
 * What the service says when all work is paused and an application tried to
 * start anyway. It names the control the person can actually press: Continue,
 * on Home and in the header.
 */
export const ACTIVITY_PAUSED_MESSAGE =
  "All work is paused, so this did not start. Press Continue on Home to start work again.";

export const DISCOVERY_RUN_ALREADY_ACTIVE_MESSAGE =
  "A search is already running for this plan.";

export const ApplicationRecordSchema = z.object({
  id: NonEmptyStringSchema,
  jobId: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  company: NonEmptyStringSchema,
  status: ApplicationStatusSchema,
  lastActionLabel: NonEmptyStringSchema,
  nextActionLabel: NonEmptyStringSchema.nullable(),
  lastUpdatedAt: IsoDateTimeSchema,
  personSendReceipt: z
    .object({
      observedAt: IsoDateTimeSchema,
      origin: UrlStringSchema,
      safePath: z.string().startsWith("/").max(4096),
      summary: NonEmptyStringSchema.max(500),
    })
    .strict()
    .optional(),
  lastAttemptState: ApplicationAttemptStateSchema.nullable().default(null),
  questionSummary: ApplicationAttemptQuestionSummarySchema.default({}),
  latestBlocker:
    ApplicationAttemptBlockerSummarySchema.nullable().default(null),
  consentSummary: ApplicationAttemptConsentSummarySchema.default({}),
  replaySummary: ApplicationAttemptReplaySummarySchema.default({}),
  events: z.array(ApplicationEventSchema).default([]),
  crm: ApplicationCrmDataSchema.nullable().default(null),
  /**
   * What the person allowed for this application when it was last prepared.
   *
   * Recorded so a screen can tell "filled in and stopped" from "filled in and
   * waiting on you" without inferring it from which buttons happen to be
   * wired up. Older records normalize to filling in only, which is what they
   * did.
   */
  automationMode: ApplicationAutomationModeSchema.default("prepare_only"),
  /**
   * When the person moved this unsent application back to Shortlisted. It
   * leaves Applications until the record is next updated (a new Apply), and
   * keeps its history and receipts. Optional so a build without it reads the
   * record anyway (the object is not strict and drops the key); such a build
   * simply lists the application again.
   */
  returnedToShortlistAt: IsoDateTimeSchema.nullable().optional(),
});
export type ApplicationRecord = z.infer<typeof ApplicationRecordSchema>;

/**
 * Moved back to Shortlisted and not touched since: Applications leaves it out
 * and Shortlisted shows the job again. Any later write (a new Apply) moves the
 * last update past the marker and brings it back.
 */
export function isApplicationReturnedToShortlist(
  record: Pick<ApplicationRecord, "lastUpdatedAt" | "returnedToShortlistAt">,
): boolean {
  return (
    typeof record.returnedToShortlistAt === "string" &&
    Date.parse(record.returnedToShortlistAt) >= Date.parse(record.lastUpdatedAt)
  );
}

const SENT_APPLICATION_STATUSES = new Set<ApplicationRecord["status"]>([
  "submitted",
  "assessment",
  "interview",
  "rejected",
  "offer",
]);

/**
 * The record says this application went to the employer: sent by Job Finder,
 * or by the person by their own word. A sent application cannot go back to
 * Shortlisted; it can be marked withdrawn or archived.
 */
export function isApplicationRecordSent(
  record: Pick<
    ApplicationRecord,
    "status" | "lastAttemptState" | "personSendReceipt" | "crm"
  >,
): boolean {
  return (
    SENT_APPLICATION_STATUSES.has(record.status) ||
    record.lastAttemptState === "submitted" ||
    record.personSendReceipt !== undefined ||
    isApplicationTrackedAsSentByPerson(record.crm)
  );
}

/** Why a sent application has no "Move back to Shortlisted". */
export const APPLICATION_SENT_CANNOT_MOVE_BACK_MESSAGE =
  "It was sent, so it stays here. Mark it withdrawn or archive it instead.";
/**
 * What a caller may hand the repository. Defaulted fields may be omitted; the
 * repository parses before it stores, so every stored record is complete.
 */
export type ApplicationRecordInput = z.input<typeof ApplicationRecordSchema>;

export const JobFinderInterviewFollowUpInputSchema = z.object({
  /** The job in Applications this session was opened for. */
  jobId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  action: z.enum(["mark_interviewed", "add_follow_up_note"]),
  note: NonEmptyStringSchema.optional(),
});
export type JobFinderInterviewFollowUpInput = z.infer<
  typeof JobFinderInterviewFollowUpInputSchema
>;

// ---------------------------------------------------------------------------
// Compact-snapshot discovery observations (ADR 0013)
//
// Discovery is API-first, deterministic compact-browser observation second,
// and model-escalated third. A browser adapter returns exactly one
// schema-validated observation per capture: either a supported observation
// with bounded page summaries, typed posting candidates, and snapshot-scoped
// pagination/action references, or an explicit unsupported outcome. These
// shapes are transient (never persisted), strictly parsed, and deliberately
// generic: no DOM handles, Playwright types, selectors as policy, raw HTML,
// or site-specific fields cross this boundary, and nothing here assumes a
// listing line shape or a minimum content-length readiness gate.
// ---------------------------------------------------------------------------

/** Conservative character cap for one bounded visible-text sample. */
export const DISCOVERY_OBSERVATION_TEXT_SAMPLE_MAX = 4_000;

/** Conservative character cap for one bounded accessibility-tree summary. */
export const DISCOVERY_OBSERVATION_ACCESSIBILITY_SUMMARY_MAX = 16_000;

/** Maximum posting candidates carried by one supported observation. */
export const DISCOVERY_OBSERVATION_POSTING_CANDIDATES_MAX = 100;

/** Maximum pagination candidates carried by one supported observation. */
export const DISCOVERY_OBSERVATION_PAGINATION_CANDIDATES_MAX = 32;

/** Maximum action candidates carried by one supported observation. */
export const DISCOVERY_OBSERVATION_ACTION_CANDIDATES_MAX = 32;

/** Maximum bounded uncertainty notes carried by one supported observation. */
export const DISCOVERY_OBSERVATION_UNCERTAINTY_NOTES_MAX = 16;

/** Character cap for control labels (accessible names), never selectors. */
export const DISCOVERY_OBSERVATION_LABEL_MAX = 200;

/** Character cap for free-text details and unsupported-outcome explanations. */
export const DISCOVERY_OBSERVATION_DETAIL_MAX = 600;

const DiscoveryObservationLabelSchema = NonEmptyStringSchema.max(
  DISCOVERY_OBSERVATION_LABEL_MAX,
);
const DiscoveryObservationDetailSchema = NonEmptyStringSchema.max(
  DISCOVERY_OBSERVATION_DETAIL_MAX,
);

/**
 * Evidence channel summarized by one observation. Values stay source-generic;
 * the adapter declares what it read instead of embedding site structure.
 */
export const discoveryCompactObservationSourceKindValues = [
  "accessibility_snapshot",
  "visible_text",
] as const;
export const DiscoveryCompactObservationSourceKindSchema = z.enum(
  discoveryCompactObservationSourceKindValues,
);
export type DiscoveryCompactObservationSourceKind = z.infer<
  typeof DiscoveryCompactObservationSourceKindSchema
>;

/** Explicit reasons a deterministic observation cannot proceed. */
export const discoveryCompactObservationUnsupportedReasonValues = [
  "unsupported_layout",
  "auth_required",
  "site_protection",
  "manual_step_required",
  /**
   * A full-page overlay stands between the reader and the listings — usually
   * an upsell for a paid plan. The listings are not readable behind it and
   * dismissing it is the reader's decision, so the run stops instead of
   * spending itself on a page it cannot read.
   */
  "paid_plan_required",
  "navigation_failed",
] as const;
export const DiscoveryCompactObservationUnsupportedReasonSchema = z.enum(
  discoveryCompactObservationUnsupportedReasonValues,
);
export type DiscoveryCompactObservationUnsupportedReason = z.infer<
  typeof DiscoveryCompactObservationUnsupportedReasonSchema
>;

/**
 * Shared observation identity. `observationId` uniquely identifies one
 * capture; `revision` is the adapter's monotonic per-target sequence starting
 * at 1. Both travel with every snapshot-scoped reference, so a consumer can
 * detect a stale reference by comparing it against the current observation
 * identity alone.
 */
const DiscoveryCompactObservationIdentitySchema = z.object({
  observationId: NonEmptyStringSchema,
  revision: z.number().int().positive(),
  targetId: NonEmptyStringSchema,
  observedAt: IsoDateTimeSchema,
  pageUrl: UrlStringSchema,
  pageTitle: DiscoveryObservationLabelSchema.nullable().default(null),
});

/**
 * Bounded page summaries. Truncation flags are mandatory honesty signals: an
 * adapter that clips its samples must set the flags and report omitted rows
 * instead of letting downstream steps assume completeness.
 */
export const DiscoveryCompactObservationContentSchema = z
  .object({
    textSample: NonEmptyStringSchema.max(DISCOVERY_OBSERVATION_TEXT_SAMPLE_MAX)
      .nullable()
      .default(null),
    accessibilitySummary: NonEmptyStringSchema.max(
      DISCOVERY_OBSERVATION_ACCESSIBILITY_SUMMARY_MAX,
    )
      .nullable()
      .default(null),
    textTruncated: z.boolean().default(false),
    accessibilitySummaryTruncated: z.boolean().default(false),
  })
  .strict();
export type DiscoveryCompactObservationContent = z.infer<
  typeof DiscoveryCompactObservationContentSchema
>;

export const discoveryCompactObservationPaginationKindValues = [
  "next_page",
  "previous_page",
  "numbered_page",
  "load_more",
] as const;
export const DiscoveryCompactObservationPaginationKindSchema = z.enum(
  discoveryCompactObservationPaginationKindValues,
);
export type DiscoveryCompactObservationPaginationKind = z.infer<
  typeof DiscoveryCompactObservationPaginationKindSchema
>;

/**
 * Name-based pagination candidate. `label` is the control's accessible name;
 * pagination stays name-based because selectors are not policy and never
 * cross this boundary.
 */
export const DiscoveryCompactObservationPaginationCandidateSchema = z
  .object({
    refId: NonEmptyStringSchema,
    kind: DiscoveryCompactObservationPaginationKindSchema,
    label: DiscoveryObservationLabelSchema,
    pageNumber: z.number().int().positive().nullable().default(null),
  })
  .strict();
export type DiscoveryCompactObservationPaginationCandidate = z.infer<
  typeof DiscoveryCompactObservationPaginationCandidateSchema
>;

/**
 * Generic action kinds a deterministic handler or a bounded model proposal
 * may target. Proposing an action grants no authority (ADR 0013): any
 * execution must recheck observation identity first.
 */
export const discoveryCompactObservationActionKindValues = [
  "open_posting",
  "close_overlay",
] as const;
export const DiscoveryCompactObservationActionKindSchema = z.enum(
  discoveryCompactObservationActionKindValues,
);
export type DiscoveryCompactObservationActionKind = z.infer<
  typeof DiscoveryCompactObservationActionKindSchema
>;

export const DiscoveryCompactObservationActionCandidateSchema = z
  .object({
    refId: NonEmptyStringSchema,
    kind: DiscoveryCompactObservationActionKindSchema,
    label: DiscoveryObservationLabelSchema,
  })
  .strict();
export type DiscoveryCompactObservationActionCandidate = z.infer<
  typeof DiscoveryCompactObservationActionCandidateSchema
>;

/**
 * Detached, snapshot-scoped reference to one pagination/action candidate.
 * The reference is current only while the live observation has the same
 * `observationId` and `observationRevision`; any mismatch is stale and must
 * fail closed instead of being replayed against the page.
 */
export const DiscoveryCompactObservationControlRefSchema = z
  .object({
    observationId: NonEmptyStringSchema,
    observationRevision: z.number().int().positive(),
    refId: NonEmptyStringSchema,
  })
  .strict();
export type DiscoveryCompactObservationControlRef = z.infer<
  typeof DiscoveryCompactObservationControlRefSchema
>;

/** Binds a candidate ref id to the observation identity that scoped it. */
export function getDiscoveryCompactObservationControlRef(
  observation: Pick<DiscoveryCompactObservation, "observationId" | "revision">,
  refId: string,
): DiscoveryCompactObservationControlRef {
  return {
    observationId: observation.observationId,
    observationRevision: observation.revision,
    refId,
  };
}

/** True only when the reference belongs to the exact current observation. */
export function isCurrentDiscoveryCompactObservationRef(
  ref: DiscoveryCompactObservationControlRef,
  observation: Pick<DiscoveryCompactObservation, "observationId" | "revision">,
): boolean {
  return (
    ref.observationId === observation.observationId &&
    ref.observationRevision === observation.revision
  );
}

/**
 * Supported observation: bounded summaries plus typed candidates. Posting
 * candidates reuse the existing source-generic `JobPostingSchema` so
 * canonicalization, merge-key dedupe, and ledger identity downstream stay
 * unchanged.
 */
export const DiscoverySupportedCompactObservationSchema =
  DiscoveryCompactObservationIdentitySchema.extend({
    kind: z.literal("supported"),
    sourceKind: DiscoveryCompactObservationSourceKindSchema,
    content: DiscoveryCompactObservationContentSchema.default({}),
    postingCandidates: z
      .array(JobPostingSchema)
      .max(DISCOVERY_OBSERVATION_POSTING_CANDIDATES_MAX)
      .default([]),
    paginationCandidates: z
      .array(DiscoveryCompactObservationPaginationCandidateSchema)
      .max(DISCOVERY_OBSERVATION_PAGINATION_CANDIDATES_MAX)
      .default([]),
    actionCandidates: z
      .array(DiscoveryCompactObservationActionCandidateSchema)
      .max(DISCOVERY_OBSERVATION_ACTION_CANDIDATES_MAX)
      .default([]),
    uncertaintyNotes: z
      .array(DiscoveryObservationDetailSchema)
      .max(DISCOVERY_OBSERVATION_UNCERTAINTY_NOTES_MAX)
      .default([]),
    /**
     * Rows the adapter saw but excluded from `postingCandidates` because of
     * bounds, so consumers know the observed inventory may be incomplete.
     */
    omittedPostingCandidateCount: z.number().int().nonnegative().default(0),
  }).strict();
export type DiscoverySupportedCompactObservation = z.infer<
  typeof DiscoverySupportedCompactObservationSchema
>;

/**
 * Unsupported observation: an explicit terminal outcome for the deterministic
 * tier. It keeps the shared identity for logging and may retain bounded
 * summaries as context for later bounded model escalation.
 */
export const DiscoveryUnsupportedCompactObservationSchema =
  DiscoveryCompactObservationIdentitySchema.extend({
    kind: z.literal("unsupported"),
    reason: DiscoveryCompactObservationUnsupportedReasonSchema,
    detail: DiscoveryObservationDetailSchema.nullable().default(null),
    content: DiscoveryCompactObservationContentSchema.default({}),
  }).strict();
export type DiscoveryUnsupportedCompactObservation = z.infer<
  typeof DiscoveryUnsupportedCompactObservationSchema
>;

const DiscoveryCompactObservationUnionSchema = z.discriminatedUnion("kind", [
  DiscoverySupportedCompactObservationSchema,
  DiscoveryUnsupportedCompactObservationSchema,
]);

/**
 * One schema-validated result of a deterministic compact-snapshot capture.
 * Reference ids must stay unique within an observation so snapshot-scoped
 * references remain resolvable; violations fail closed.
 */
export const DiscoveryCompactObservationSchema =
  DiscoveryCompactObservationUnionSchema.superRefine((value, ctx) => {
    if (value.kind !== "supported") {
      return;
    }
    const seenRefIds = new Set<string>();
    const candidateGroups = [
      ["paginationCandidates", value.paginationCandidates],
      ["actionCandidates", value.actionCandidates],
    ] as const;
    for (const [field, candidates] of candidateGroups) {
      for (const [index, candidate] of candidates.entries()) {
        if (seenRefIds.has(candidate.refId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Snapshot-scoped reference ids must be unique within one observation.",
            path: [field, index, "refId"],
          });
          continue;
        }
        seenRefIds.add(candidate.refId);
      }
    }
  });
export type DiscoveryCompactObservation = z.infer<
  typeof DiscoveryCompactObservationSchema
>;

export const SourceDebugPersistenceSchemas = {
  SourceDebugEvidenceRefSchema,
  SourceDebugRunRecordSchema,
  SourceDebugWorkerAttemptSchema,
  SourceInstructionArtifactSchema,
} as const;
import { optionalStoredField } from "./stored-json";
