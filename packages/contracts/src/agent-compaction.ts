import { z } from "zod";

import { IsoDateTimeSchema, NonEmptyStringSchema } from "./base";

const PositiveIntSchema = z.number().int().positive();
const NonNegativeIntSchema = z.number().int().nonnegative();

const sharedAgentCompactionPolicyOverrideShape = {
  enabled: z.boolean().optional(),
  warningTokenBudget: PositiveIntSchema.optional(),
  targetTokenBudget: PositiveIntSchema.optional(),
  minimumResponseHeadroomTokens: PositiveIntSchema.optional(),
  preserveRecentMessages: NonNegativeIntSchema.optional(),
  minimumPreserveRecentMessages: NonNegativeIntSchema.optional(),
  maxToolPayloadChars: PositiveIntSchema.optional(),
  messageCountFallbackThreshold: PositiveIntSchema.optional(),
} satisfies z.ZodRawShape;

export const sharedAgentCompactionTriggerKindValues = [
  "token_budget",
  "message_count_fallback",
] as const;
export const SharedAgentCompactionTriggerKindSchema = z.enum(
  sharedAgentCompactionTriggerKindValues,
);
export type SharedAgentCompactionTriggerKind = z.infer<
  typeof SharedAgentCompactionTriggerKindSchema
>;

export const SharedAgentCompactionPolicyOverrideSchema = z.object(
  sharedAgentCompactionPolicyOverrideShape,
).superRefine(validateCompactionPolicyIssues);

type CompactionPolicyValidationInput = {
  warningTokenBudget?: number | undefined;
  targetTokenBudget?: number | undefined;
  preserveRecentMessages?: number | undefined;
  minimumPreserveRecentMessages?: number | undefined;
};

function validateCompactionPolicyIssues(
  value: CompactionPolicyValidationInput,
  ctx: z.RefinementCtx,
) {
  if (
    value.warningTokenBudget !== undefined &&
    value.targetTokenBudget !== undefined &&
    value.warningTokenBudget > value.targetTokenBudget
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "warningTokenBudget cannot exceed targetTokenBudget.",
      path: ["warningTokenBudget"],
    });
  }

  if (
    value.minimumPreserveRecentMessages !== undefined &&
    value.preserveRecentMessages !== undefined &&
    value.minimumPreserveRecentMessages > value.preserveRecentMessages
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "minimumPreserveRecentMessages cannot exceed preserveRecentMessages.",
      path: ["minimumPreserveRecentMessages"],
    });
  }
}
export type SharedAgentCompactionPolicyOverride = z.infer<
  typeof SharedAgentCompactionPolicyOverrideSchema
>;

export const SharedAgentCompactionPolicySchema =
  z.object({
    ...sharedAgentCompactionPolicyOverrideShape,
    enabled: z.boolean().default(true),
    warningTokenBudget: PositiveIntSchema.default(176_000),
    targetTokenBudget: PositiveIntSchema.default(184_000),
    minimumResponseHeadroomTokens: PositiveIntSchema.default(12_000),
    preserveRecentMessages: NonNegativeIntSchema.default(8),
    minimumPreserveRecentMessages: NonNegativeIntSchema.default(4),
    maxToolPayloadChars: PositiveIntSchema.default(240),
    messageCountFallbackThreshold: PositiveIntSchema.default(18),
    workflowOverrides: z
      .record(NonEmptyStringSchema, SharedAgentCompactionPolicyOverrideSchema)
      .default({}),
  }).superRefine(validateCompactionPolicyIssues);
export type SharedAgentCompactionPolicy = z.infer<
  typeof SharedAgentCompactionPolicySchema
>;

export const SharedAgentCompactionSnapshotSchema = z.object({
  compactedAt: IsoDateTimeSchema,
  compactionCount: NonNegativeIntSchema.default(0),
  triggerKind:
    SharedAgentCompactionTriggerKindSchema.default("message_count_fallback"),
  estimatedTokensBefore: NonNegativeIntSchema.nullable().default(null),
  estimatedTokensAfter: NonNegativeIntSchema.nullable().default(null),
  summary: NonEmptyStringSchema,
  confirmedFacts: z.array(NonEmptyStringSchema).default([]),
  blockerNotes: z.array(NonEmptyStringSchema).default([]),
  avoidStrategyFingerprints: z.array(NonEmptyStringSchema).default([]),
  preservedContext: z.array(NonEmptyStringSchema).default([]),
  stickyWorkflowState: z.array(NonEmptyStringSchema).default([]),
});
export type SharedAgentCompactionSnapshot = z.infer<
  typeof SharedAgentCompactionSnapshotSchema
>;

export const sharedAgentHandoffModeValues = [
  "full_context",
  "summary_first",
] as const;
export const SharedAgentHandoffModeSchema = z.enum(
  sharedAgentHandoffModeValues,
);
export type SharedAgentHandoffMode = z.infer<
  typeof SharedAgentHandoffModeSchema
>;

export const SharedAgentHandoffCompactionSchema = z.object({
  mode: SharedAgentHandoffModeSchema.default("full_context"),
  keptTranscriptLineCount: NonNegativeIntSchema.default(0),
  droppedTranscriptLineCount: NonNegativeIntSchema.default(0),
  compactedPhaseContextCount: NonNegativeIntSchema.default(0),
  compaction: SharedAgentCompactionSnapshotSchema.nullable().default(null),
  normalizedFailureReason: NonEmptyStringSchema.nullable().default(null),
});
export type SharedAgentHandoffCompaction = z.infer<
  typeof SharedAgentHandoffCompactionSchema
>;
