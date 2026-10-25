import { z } from "zod";

/**
 * Job Finder startup recovery disclosure facts.
 *
 * These discriminated unions are the wire contract for the desktop startup
 * recovery IPC routes (`job-finder:get-startup-reset-recovery`,
 * `job-finder:get-startup-database-recovery`, and
 * `job-finder:dismiss-startup-database-recovery-notice`) and for the
 * versioned disclosure file the main process persists next to a recovered
 * workspace database. Redaction is structural: retained artifacts appear as
 * basenames only and no field can carry raw errors, filesystem paths, or
 * persisted workspace values.
 *
 * Timestamp validation deliberately mirrors the original desktop guard
 * semantics (bounded `Date.parse` strings rather than strict RFC3339) so
 * facts persisted by earlier app versions keep parsing.
 */

export const jobFinderStartupDatabaseRecoverySnapshotKindValues = [
  "backup",
  "backup-prev",
] as const;

export const JobFinderStartupDatabaseRecoverySnapshotKindSchema = z.enum(
  jobFinderStartupDatabaseRecoverySnapshotKindValues,
);
export type JobFinderStartupDatabaseRecoverySnapshotKind = z.infer<
  typeof JobFinderStartupDatabaseRecoverySnapshotKindSchema
>;

export const jobFinderStartupDatabaseRecoveryOutcomeValues = [
  "no-valid-candidate",
  "quarantine-incomplete",
  "restore-revalidation-rejected",
  "restore-promotion-failed",
  "salvage-required",
] as const;

export const JobFinderStartupDatabaseRecoveryOutcomeSchema = z.enum(
  jobFinderStartupDatabaseRecoveryOutcomeValues,
);
export type JobFinderStartupDatabaseRecoveryOutcome = z.infer<
  typeof JobFinderStartupDatabaseRecoveryOutcomeSchema
>;

export const jobFinderStartupDatabaseRecoveryValidationStageValues = [
  "open",
  "migrate",
  "integrity-check",
  "persisted-state",
] as const;

export const JobFinderStartupDatabaseRecoveryValidationStageSchema = z.enum(
  jobFinderStartupDatabaseRecoveryValidationStageValues,
);
export type JobFinderStartupDatabaseRecoveryValidationStage = z.infer<
  typeof JobFinderStartupDatabaseRecoveryValidationStageSchema
>;

/**
 * Bounded parseable timestamp matching the historical desktop guard: a
 * non-empty string of at most 40 characters that `Date.parse` accepts, so
 * offset-style ISO strings emitted by earlier versions stay valid.
 */
const StartupDatabaseRecoveryTimestampSchema = z
  .string()
  .min(1)
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Expected a parseable ISO timestamp string",
  });

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

export const JobFinderStartupDatabaseRecoveryLossWindowSchema = z.object({
  detectedAtIso: StartupDatabaseRecoveryTimestampSchema,
  quarantinedDatabaseModifiedAtIso:
    StartupDatabaseRecoveryTimestampSchema.nullable(),
  restoredSnapshotModifiedAtIso:
    StartupDatabaseRecoveryTimestampSchema.nullable(),
});
export type JobFinderStartupDatabaseRecoveryLossWindow = z.infer<
  typeof JobFinderStartupDatabaseRecoveryLossWindowSchema
>;

export const JobFinderStartupDatabaseRecoveryBlockedCandidateSchema = z
  .object({
    kind: JobFinderStartupDatabaseRecoverySnapshotKindSchema,
    status: z.enum(["missing", "valid", "invalid"]),
    /**
     * Legacy payloads may omit the stage for non-invalid candidates; it is
     * normalized to null so every parsed candidate carries the field.
     */
    failedStage:
      JobFinderStartupDatabaseRecoveryValidationStageSchema.nullable().default(
        null,
      ),
  })
  .superRefine((candidate, ctx) => {
    if (candidate.status === "invalid") {
      if (candidate.failedStage === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["failedStage"],
          message:
            "An invalid candidate must report the validation stage it failed.",
        });
      }
      return;
    }

    if (candidate.failedStage !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failedStage"],
        message: "Only an invalid candidate may report a failed stage.",
      });
    }
  });
export type JobFinderStartupDatabaseRecoveryBlockedCandidate = z.infer<
  typeof JobFinderStartupDatabaseRecoveryBlockedCandidateSchema
>;

export const JobFinderStartupDatabaseRecoveryIdleFactSchema = z.object({
  status: z.literal("idle"),
});
export type JobFinderStartupDatabaseRecoveryIdleFact = z.infer<
  typeof JobFinderStartupDatabaseRecoveryIdleFactSchema
>;

export const JobFinderStartupDatabaseRecoveryRestoredFactSchema = z.object({
  status: z.literal("restored"),
  incidentId: StartupRecoveryNonEmptyStringSchema,
  restoredFrom: JobFinderStartupDatabaseRecoverySnapshotKindSchema,
  lossWindow: JobFinderStartupDatabaseRecoveryLossWindowSchema,
  quarantinedArtifactBasenames: z.array(StartupRecoveryNonEmptyStringSchema),
  restoredAtIso: StartupDatabaseRecoveryTimestampSchema,
  dismissedAtIso: StartupDatabaseRecoveryTimestampSchema.nullable(),
});
export type JobFinderStartupDatabaseRecoveryRestoredFact = z.infer<
  typeof JobFinderStartupDatabaseRecoveryRestoredFactSchema
>;

export const JobFinderStartupDatabaseRecoveryBlockedFactSchema = z.object({
  status: z.literal("blocked"),
  incidentId: StartupRecoveryNonEmptyStringSchema,
  outcome: JobFinderStartupDatabaseRecoveryOutcomeSchema,
  candidates: z.array(JobFinderStartupDatabaseRecoveryBlockedCandidateSchema),
  quarantineBasenames: z.array(StartupRecoveryNonEmptyStringSchema),
});
export type JobFinderStartupDatabaseRecoveryBlockedFact = z.infer<
  typeof JobFinderStartupDatabaseRecoveryBlockedFactSchema
>;

export const JobFinderStartupDatabaseRecoveryFactSchema =
  z.discriminatedUnion("status", [
    JobFinderStartupDatabaseRecoveryIdleFactSchema,
    JobFinderStartupDatabaseRecoveryRestoredFactSchema,
    JobFinderStartupDatabaseRecoveryBlockedFactSchema,
  ]);
export type JobFinderStartupDatabaseRecoveryFact = z.infer<
  typeof JobFinderStartupDatabaseRecoveryFactSchema
>;

export const jobFinderStartupResetRecoveryDegradedReasonValues = [
  "marker_quarantined_malformed",
  "marker_quarantined_oversized",
  "marker_quarantined_with_pending_trash",
  "reset_recovery_failed",
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
