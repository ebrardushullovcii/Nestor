import { z } from "zod";

/**
 * Reset recovery completion timestamps historically skipped the length cap;
 * the looser form is kept so persisted reset facts remain readable.
 */
const StartupResetRecoveryTimestampSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Expected a parseable ISO timestamp string",
  });

/** Non-empty string without whitespace trimming, matching the legacy guard. */
const StartupRecoveryNonEmptyStringSchema = z.string().min(1);

export const jobFinderStartupResetRecoveryDegradedReasonValues = [
  "marker_quarantined_malformed",
  "marker_quarantined_oversized",
  "marker_quarantined_with_pending_trash",
  "reset_recovery_failed",
  "marker_unreadable",
] as const;

export const JobFinderStartupResetRecoveryDegradedReasonSchema = z.enum(
  jobFinderStartupResetRecoveryDegradedReasonValues,
);
export type JobFinderStartupResetRecoveryDegradedReason = z.infer<
  typeof JobFinderStartupResetRecoveryDegradedReasonSchema
>;

export const JobFinderStartupResetRecoveryIdleFactSchema = z.object({
  status: z.literal("idle"),
});
export type JobFinderStartupResetRecoveryIdleFact = z.infer<
  typeof JobFinderStartupResetRecoveryIdleFactSchema
>;

export const JobFinderStartupResetRecoveryCompletedFactSchema = z.object({
  status: z.literal("completed"),
  token: StartupRecoveryNonEmptyStringSchema,
  completedAt: StartupResetRecoveryTimestampSchema,
});
export type JobFinderStartupResetRecoveryCompletedFact = z.infer<
  typeof JobFinderStartupResetRecoveryCompletedFactSchema
>;

export const JobFinderStartupResetRecoveryDegradedFactSchema = z.object({
  status: z.literal("degraded"),
  reason: JobFinderStartupResetRecoveryDegradedReasonSchema,
  quarantinedFileName: StartupRecoveryNonEmptyStringSchema.nullable(),
});
export type JobFinderStartupResetRecoveryDegradedFact = z.infer<
  typeof JobFinderStartupResetRecoveryDegradedFactSchema
>;

export const JobFinderStartupResetRecoveryFactSchema =
  z.discriminatedUnion("status", [
    JobFinderStartupResetRecoveryIdleFactSchema,
    JobFinderStartupResetRecoveryCompletedFactSchema,
    JobFinderStartupResetRecoveryDegradedFactSchema,
  ]);
export type JobFinderStartupResetRecoveryFact = z.infer<
  typeof JobFinderStartupResetRecoveryFactSchema
>;
