import { z, type RefinementCtx } from "zod";

import {
  DiscoveryRunReportSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
} from "./base";

// ---------------------------------------------------------------------------
// Campaign rules
// ---------------------------------------------------------------------------

export const CampaignRuleKindSchema = z.enum(["must_have", "prefer", "never"]);
export type CampaignRuleKind = z.infer<typeof CampaignRuleKindSchema>;

export const campaignRuleFieldValues = [
  "role",
  "location",
  "work_mode",
  "compensation",
  "company",
  "industry",
  "seniority",
  "employment_type",
  "clearance",
  "sponsorship",
  "travel",
  "user_exclusion",
] as const;

export const CampaignRuleFieldSchema = z.enum(campaignRuleFieldValues);
export type CampaignRuleField = z.infer<typeof CampaignRuleFieldSchema>;

export const CampaignRuleOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "in_list",
  "not_in_list",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
]);
export type CampaignRuleOperator = z.infer<typeof CampaignRuleOperatorSchema>;

export const campaignRuleOperatorsByField: Record<
  CampaignRuleField,
  readonly CampaignRuleOperator[]
> = {
  role: [
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "in_list",
    "not_in_list",
  ],
  location: [
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "in_list",
    "not_in_list",
  ],
  work_mode: ["equals", "not_equals", "in_list", "not_in_list"],
  compensation: [
    "equals",
    "greater_than",
    "greater_than_or_equal",
    "less_than",
    "less_than_or_equal",
  ],
  company: [
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "in_list",
    "not_in_list",
  ],
  industry: [
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "in_list",
    "not_in_list",
  ],
  seniority: ["equals", "not_equals", "in_list", "not_in_list"],
  employment_type: ["equals", "not_equals", "in_list", "not_in_list"],
  clearance: ["equals", "not_equals", "in_list", "not_in_list"],
  sponsorship: ["equals", "not_equals", "in_list", "not_in_list"],
  travel: [
    "equals",
    "greater_than",
    "greater_than_or_equal",
    "less_than",
    "less_than_or_equal",
  ],
  user_exclusion: ["equals", "not_equals", "contains", "not_contains"],
};

export const CampaignRuleProvenanceSourceSchema = z.enum([
  "user",
  "profile_import",
  "campaign_template",
  "learning_suggestion",
]);
export type CampaignRuleProvenanceSource = z.infer<
  typeof CampaignRuleProvenanceSourceSchema
>;

export const CampaignRuleProvenanceSchema = z
  .object({
    source: CampaignRuleProvenanceSourceSchema,
    confidence: z.number().finite().min(0).max(1).default(1),
    note: NonEmptyStringSchema.max(1_000).nullable().default(null),
    recordedAt: IsoDateTimeSchema,
  })
  .strict();
export type CampaignRuleProvenance = z.infer<
  typeof CampaignRuleProvenanceSchema
>;

export const CampaignRuleEffectSchema = z
  .object({
    sampleSize: z.number().int().nonnegative().default(0),
    removedCount: z.number().int().nonnegative().default(0),
    downgradedCount: z.number().int().nonnegative().default(0),
    unknownCount: z.number().int().nonnegative().default(0),
    measuredAt: IsoDateTimeSchema.nullable().default(null),
  })
  .superRefine((effect, context) => {
    if (effect.measuredAt !== null && effect.sampleSize === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sampleSize"],
        message: "A measured effect requires a positive sample size.",
      });
    }
    if (effect.measuredAt === null && effect.sampleSize > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["measuredAt"],
        message: "A non-empty measured sample requires a measurement time.",
      });
    }
    if (
      effect.removedCount + effect.downgradedCount + effect.unknownCount >
      effect.sampleSize
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sampleSize"],
        message: "Measured rule outcomes cannot exceed the sample size.",
      });
    }
  });
export type CampaignRuleEffect = z.infer<typeof CampaignRuleEffectSchema>;

interface CampaignRuleRefinementTarget {
  field: CampaignRuleField;
  operator: CampaignRuleOperator;
  numericValue: number | null;
  currency: string | null;
}

function refineCampaignRule(
  rule: CampaignRuleRefinementTarget,
  context: RefinementCtx,
): void {
  const allowed = campaignRuleOperatorsByField[rule.field];

  if (!allowed.includes(rule.operator)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["operator"],
      message: `Operator "${rule.operator}" is not allowed for field "${rule.field}".`,
    });
  }

  if (rule.field === "compensation") {
    if (rule.numericValue === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["numericValue"],
        message: "Compensation rules require a numeric value.",
      });
    }

    if (rule.currency === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currency"],
        message: "Compensation rules require a currency code.",
      });
    }
  }

  if (rule.field === "travel" && rule.numericValue === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["numericValue"],
      message: "Travel rules require a numeric percentage.",
    });
  }
}

const CampaignRuleObjectSchema = z
  .object({
    id: NonEmptyStringSchema,
    kind: CampaignRuleKindSchema,
    field: CampaignRuleFieldSchema,
    operator: CampaignRuleOperatorSchema,
    value: NonEmptyStringSchema.max(500),
    numericValue: z.number().finite().nonnegative().nullable().default(null),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/u)
      .nullable()
      .default(null),
    enabled: z.boolean().default(true),
    provenance: CampaignRuleProvenanceSchema,
    effect: CampaignRuleEffectSchema.default({}),
  })
  .strict();

export const CampaignRuleSchema =
  CampaignRuleObjectSchema.superRefine(refineCampaignRule);
export type CampaignRule = z.infer<typeof CampaignRuleSchema>;

export const SaveCampaignRuleInputSchema = CampaignRuleObjectSchema.omit({
  id: true,
})
  .extend({
    id: NonEmptyStringSchema.nullable().default(null),
  })
  .superRefine(refineCampaignRule);
export type SaveCampaignRuleInput = z.infer<typeof SaveCampaignRuleInputSchema>;

// ---------------------------------------------------------------------------
// Campaign rule mutations and truthful funnel projection
// ---------------------------------------------------------------------------

export const SaveCampaignRuleRouteInputSchema = z
  .object({
    campaignId: NonEmptyStringSchema,
    rule: SaveCampaignRuleInputSchema,
  })
  .strict();
export type SaveCampaignRuleRouteInput = z.infer<
  typeof SaveCampaignRuleRouteInputSchema
>;

export const DeleteCampaignRuleInputSchema = z
  .object({
    campaignId: NonEmptyStringSchema,
    ruleId: NonEmptyStringSchema,
  })
  .strict();
export type DeleteCampaignRuleInput = z.infer<
  typeof DeleteCampaignRuleInputSchema
>;

export const ToggleCampaignRuleInputSchema = z
  .object({
    campaignId: NonEmptyStringSchema,
    ruleId: NonEmptyStringSchema,
    enabled: z.boolean(),
  })
  .strict();
export type ToggleCampaignRuleInput = z.infer<
  typeof ToggleCampaignRuleInputSchema
>;

export const ProjectCampaignRuleFunnelInputSchema = z
  .object({
    campaignId: NonEmptyStringSchema,
  })
  .strict();
export type ProjectCampaignRuleFunnelInput = z.infer<
  typeof ProjectCampaignRuleFunnelInputSchema
>;

/**
 * Deletes one whole search plan. The active-pointer hand-off (first remaining
 * non-archived plan, sole-plan refusal) is owned by the workspace method.
 */
export const DeleteJobSearchCampaignInputSchema = z
  .object({
    campaignId: NonEmptyStringSchema,
    expectedUpdatedAt: IsoDateTimeSchema.optional(),
  })
  .strict();
export type DeleteJobSearchCampaignInput = z.infer<
  typeof DeleteJobSearchCampaignInputSchema
>;

/**
 * Aggregate funnel counts derived ONLY from the real persisted job sample
 * retained by the campaign. Every count is produced by
 * `estimateCampaignFunnel`; a campaign with no retained jobs yields a
 * zeroed funnel instead of any invented projection.
 */
export const CampaignRuleFunnelEstimateSchema = z
  .object({
    sampleSize: z.number().int().nonnegative(),
    hardRemovedCount: z.number().int().nonnegative(),
    retainedCount: z.number().int().nonnegative(),
    preferDowngradedCount: z.number().int().nonnegative(),
    uncertainCount: z.number().int().nonnegative(),
    confirmedRetainedCount: z.number().int().nonnegative(),
    rankedJobIds: z.array(NonEmptyStringSchema).default([]),
    measuredAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((estimate, context) => {
    if (
      estimate.hardRemovedCount + estimate.retainedCount !==
      estimate.sampleSize
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retainedCount"],
        message: "Retained count must equal sample size minus hard removals.",
      });
    }
    if (estimate.rankedJobIds.length !== estimate.retainedCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rankedJobIds"],
        message: "Ranked funnel must contain exactly the retained jobs.",
      });
    }
  });
export type CampaignRuleFunnelEstimate = z.infer<
  typeof CampaignRuleFunnelEstimateSchema
>;

/**
 * Read-only projection of how the campaign's rules would treat its current
 * retained jobs. `rules` carries every ENABLED rule with its effect freshly
 * measured against the real persisted sample; `disabledRuleIds` lists the
 * rules that were not evaluated because they are turned off.
 */
export const CampaignRuleFunnelProjectionSchema = z
  .object({
    campaignId: NonEmptyStringSchema,
    generatedAt: IsoDateTimeSchema,
    rules: z.array(CampaignRuleSchema).default([]),
    disabledRuleIds: z.array(NonEmptyStringSchema).default([]),
    funnel: CampaignRuleFunnelEstimateSchema,
  })
  .strict();
export type CampaignRuleFunnelProjection = z.infer<
  typeof CampaignRuleFunnelProjectionSchema
>;

// ---------------------------------------------------------------------------
// Append-only rapid review decisions
// ---------------------------------------------------------------------------

export const CampaignPauseWindowSchema = z
  .object({
    id: NonEmptyStringSchema,
    startsAt: IsoDateTimeSchema,
    endsAt: IsoDateTimeSchema,
    reason: NonEmptyStringSchema.max(1_000).nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((window, context) => {
    if (Date.parse(window.endsAt) <= Date.parse(window.startsAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endsAt"],
        message: "A pause window must end after it starts.",
      });
    }
  });
export type CampaignPauseWindow = z.infer<typeof CampaignPauseWindowSchema>;

export const CampaignRunFactsSchema = z
  .object({
    nextRunAt: IsoDateTimeSchema.nullable().default(null),
    lastRunAt: IsoDateTimeSchema.nullable().default(null),
    lastRunOutcome: z
      .enum(["success", "partial", "failed", "skipped"])
      .nullable()
      .default(null),
    lastRunSummary: NonEmptyStringSchema.max(1_000).nullable().default(null),
    consecutiveFailures: z.number().int().nonnegative().default(0),
  })
  .strict();
export type CampaignRunFacts = z.infer<typeof CampaignRunFactsSchema>;

export const CampaignScheduleStateSchema = z
  .object({
    enabled: z.boolean().default(false),
    pauseWindows: z.array(CampaignPauseWindowSchema).max(100).default([]),
    runFacts: CampaignRunFactsSchema.default({}),
    updatedAt: IsoDateTimeSchema.nullable().default(null),
  })
  .strict();
export type CampaignScheduleState = z.infer<typeof CampaignScheduleStateSchema>;

/**
 * Manual campaign run request. Omitting `campaignId` (or passing `null`)
 * targets the active campaign.
 */
export const RunCampaignNowInputSchema = z
  .object({
    campaignId: NonEmptyStringSchema.nullable().optional(),
  })
  .strict();
export type RunCampaignNowInput = z.infer<typeof RunCampaignNowInputSchema>;

// ---------------------------------------------------------------------------
// Campaign digest
// ---------------------------------------------------------------------------

export const CampaignDigestCountsSchema = z
  .object({
    new: z.number().int().nonnegative().default(0),
    changed: z.number().int().nonnegative().default(0),
    reactivated: z.number().int().nonnegative().default(0),
    inactive: z.number().int().nonnegative().default(0),
    known: z.number().int().nonnegative().default(0),
    skipped: z.number().int().nonnegative().default(0),
  })
  .strict();
export type CampaignDigestCounts = z.infer<typeof CampaignDigestCountsSchema>;

export const CampaignDigestFailedSourceSchema = z
  .object({
    sourceTargetId: NonEmptyStringSchema,
    reason: NonEmptyStringSchema.max(1_000),
    failedAt: IsoDateTimeSchema,
    retryable: z.boolean().default(false),
  })
  .strict();
export type CampaignDigestFailedSource = z.infer<
  typeof CampaignDigestFailedSourceSchema
>;

export const CampaignDigestSourceOutcomeSchema = z.object({
  planned: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
});

export const CampaignDigestSchema = z
  .object({
    id: NonEmptyStringSchema,
    campaignId: NonEmptyStringSchema,
    discoveryRunId: NonEmptyStringSchema.nullable().default(null),
    /** Terminal run outcome, also available on cards without the run record. */
    outcome: z
      .enum(["completed", "stopped", "interrupted", "failed"])
      .optional(),
    generatedAt: IsoDateTimeSchema,
    counts: CampaignDigestCountsSchema.default({}),
    /**
     * The run's own frozen accounting, copied onto the digest at the plan's
     * terminal commit. A plan card must be able to print the run's numbers
     * without going looking for a run record it may not hold: the Search
     * plans screen only ever receives the active plan's runs, so every other
     * card printed "Counts were not recorded for this run" about a search
     * that had just finished. Null only for digests written before this
     * field existed.
     */
    report: DiscoveryRunReportSchema.nullable().default(null),
    failedSources: z
      .array(CampaignDigestFailedSourceSchema)
      .max(100)
      .default([]),
    sourceOutcome: CampaignDigestSourceOutcomeSchema.nullable().default(null),
    jobIds: z.array(NonEmptyStringSchema).max(10_000).default([]),
  })
  .strict();
export type CampaignDigest = z.infer<typeof CampaignDigestSchema>;

// ---------------------------------------------------------------------------
// In-app campaign notifications
// ---------------------------------------------------------------------------

export const CampaignNotificationKindSchema = z.enum([
  "digest_ready",
  "strong_match",
  "blocked_work",
  "schedule_paused",
  "rule_effect_update",
]);
export type CampaignNotificationKind = z.infer<
  typeof CampaignNotificationKindSchema
>;

export const CampaignNotificationSchema = z
  .object({
    id: NonEmptyStringSchema,
    campaignId: NonEmptyStringSchema,
    kind: CampaignNotificationKindSchema,
    title: NonEmptyStringSchema.max(200),
    body: NonEmptyStringSchema.max(2_000).nullable().default(null),
    createdAt: IsoDateTimeSchema,
    readAt: IsoDateTimeSchema.nullable().default(null),
    unread: z.boolean().default(true),
    jobId: NonEmptyStringSchema.nullable().default(null),
    sourceTargetId: NonEmptyStringSchema.nullable().default(null),
  })
  .strict()
  .superRefine((notification, context) => {
    if (notification.readAt !== null && notification.unread) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unread"],
        message: "A notification with a readAt timestamp must not be unread.",
      });
    }

    if (!notification.unread && notification.readAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["readAt"],
        message: "A read notification requires a readAt timestamp.",
      });
    }
  });
export type CampaignNotification = z.infer<typeof CampaignNotificationSchema>;

export const CreateCampaignNotificationInputSchema = z
  .object({
    campaignId: NonEmptyStringSchema,
    kind: CampaignNotificationKindSchema,
    title: NonEmptyStringSchema.max(200),
    body: NonEmptyStringSchema.max(2_000).nullable().default(null),
    jobId: NonEmptyStringSchema.nullable().default(null),
    sourceTargetId: NonEmptyStringSchema.nullable().default(null),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type CreateCampaignNotificationInput = z.infer<
  typeof CreateCampaignNotificationInputSchema
>;

export const MarkCampaignNotificationReadInputSchema = z
  .object({
    notificationId: NonEmptyStringSchema,
    readAt: IsoDateTimeSchema,
  })
  .strict();
export type MarkCampaignNotificationReadInput = z.infer<
  typeof MarkCampaignNotificationReadInputSchema
>;

/**
 * Marks every unread in-app campaign notification read at the given instant.
 * The read timestamp is supplied by the caller (Electron main) so the flip is
 * an exact persisted fact rather than a client-side approximation.
 */
export const MarkAllCampaignNotificationsReadInputSchema = z
  .object({
    readAt: IsoDateTimeSchema,
  })
  .strict();
export type MarkAllCampaignNotificationsReadInput = z.infer<
  typeof MarkAllCampaignNotificationsReadInputSchema
>;

export const CampaignNotificationCollectionSchema = z
  .object({
    notifications: z.array(CampaignNotificationSchema).max(5_000).default([]),
    unreadCount: z.number().int().nonnegative().default(0),
  })
  .strict()
  .superRefine((collection, context) => {
    const actualUnreadCount = collection.notifications.filter(
      (notification) => notification.unread,
    ).length;

    if (collection.unreadCount !== actualUnreadCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unreadCount"],
        message: `unreadCount must equal the number of unread notifications (expected ${actualUnreadCount}).`,
      });
    }
  });
export type CampaignNotificationCollection = z.infer<
  typeof CampaignNotificationCollectionSchema
>;
