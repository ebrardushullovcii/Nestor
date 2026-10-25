import { ApplyAgentTimingSchema } from "./agent-timing";
import { z } from "zod";

import { IsoDateTimeSchema, NonEmptyStringSchema } from "./base";
import { DiscoveryRunRecordSchema } from "./discovery";
import { SourceDebugRunDetailsSchema } from "./source-debug";

export const performanceEvidenceAreaValues = [
  "resume_import",
  "resume_generation",
  "discovery",
  "application_preparation",
  "persistence",
  "ipc",
  "renderer_commit",
] as const;
export const PerformanceEvidenceAreaSchema = z.enum(
  performanceEvidenceAreaValues,
);
export type PerformanceEvidenceArea = z.infer<
  typeof PerformanceEvidenceAreaSchema
>;

export const performanceEvidenceStageValues = [
  "resume_import.text_branch",
  "resume_import.literal_extraction",
  "resume_import.reconciliation",
  "resume_import.finalization",
  "resume_import.identity_summary",
  "resume_import.experience",
  "resume_import.background",
  "resume_import.shared_memory",
  "resume_generation.provider",
  "resume_generation.grounding",
  "resume_generation.render",
  "discovery.planning",
  "discovery.target",
  "discovery.navigation",
  "discovery.extraction",
  "discovery.scoring",
  "discovery.persistence",
  "discovery.run",
  "application_preparation.browser_preparation",
  "application_preparation.form_preparation",
  "application_preparation.visual_diagnostics",
  "persistence.workspace_snapshot_read",
  "ipc.workspace_round_trip",
  "renderer.discovery_results_commit",
] as const;
export const PerformanceEvidenceStageIdSchema = z.enum(
  performanceEvidenceStageValues,
);
export type PerformanceEvidenceStageId = z.infer<
  typeof PerformanceEvidenceStageIdSchema
>;

export const PerformanceEvidenceStageDurationSchema = z
  .object({
    id: PerformanceEvidenceStageIdSchema,
    durationMs: z.number().finite().nonnegative(),
  })
  .strict();
export type PerformanceEvidenceStageDuration = z.infer<
  typeof PerformanceEvidenceStageDurationSchema
>;

export const performanceEvidenceMethodValues = [
  "resume_import_run",
  "resume_generation_run",
  "discovery_run",
  "application_attempt",
  "runtime_observation",
  "none",
] as const;
export const PerformanceEvidenceMethodSchema = z.enum(
  performanceEvidenceMethodValues,
);
export type PerformanceEvidenceMethod = z.infer<
  typeof PerformanceEvidenceMethodSchema
>;

export const performanceEvidenceBudgetStatusValues = [
  "pass",
  "warning",
  "fail",
  "not_evaluated",
  "unavailable",
] as const;
export const PerformanceEvidenceBudgetStatusSchema = z.enum(
  performanceEvidenceBudgetStatusValues,
);
export type PerformanceEvidenceBudgetStatus = z.infer<
  typeof PerformanceEvidenceBudgetStatusSchema
>;

const PerformanceEvidenceMeasuredBaseSchema = z.object({
  agentTiming: ApplyAgentTimingSchema.optional(),
  area: PerformanceEvidenceAreaSchema,
  recordedAt: IsoDateTimeSchema,
  sampleCount: z.number().int().positive(),
  budgetStatus: z.enum(["pass", "warning", "fail", "not_evaluated"]),
  budgetEvaluationIds: z.array(NonEmptyStringSchema.max(100)).default([]),
});

export const PerformanceEvidenceAvailableSchema =
  PerformanceEvidenceMeasuredBaseSchema.extend({
    measurementStatus: z.literal("available"),
    durationMs: z.number().finite().nonnegative(),
    method: z.enum([
      "resume_import_run",
      "resume_generation_run",
      "discovery_run",
      "application_attempt",
      "runtime_observation",
    ]),
    stageDurations: z.array(PerformanceEvidenceStageDurationSchema).default([]),
  }).strict();

export const PerformanceEvidencePartialSchema =
  PerformanceEvidenceMeasuredBaseSchema.extend({
    measurementStatus: z.literal("partial"),
    durationMs: z.null(),
    method: z.enum([
      "resume_import_run",
      "resume_generation_run",
      "discovery_run",
      "application_attempt",
      "runtime_observation",
    ]),
    stageDurations: z.array(PerformanceEvidenceStageDurationSchema).min(1),
    unavailableReason: z.literal("total_not_recorded"),
  }).strict();

export const PerformanceEvidenceUnavailableSchema = z
  .object({
    area: PerformanceEvidenceAreaSchema,
    measurementStatus: z.literal("unavailable"),
    durationMs: z.null(),
    recordedAt: z.null(),
    method: z.literal("none"),
    sampleCount: z.literal(0),
    budgetStatus: z.literal("unavailable"),
    budgetEvaluationIds: z.array(z.never()).max(0).default([]),
    stageDurations: z.array(z.never()).max(0).default([]),
    unavailableReason: z.literal("no_recorded_measurement"),
  })
  .strict();

export const JobFinderPerformanceEvidenceSchema = z.discriminatedUnion(
  "measurementStatus",
  [
    PerformanceEvidenceAvailableSchema,
    PerformanceEvidencePartialSchema,
    PerformanceEvidenceUnavailableSchema,
  ],
);
export type JobFinderPerformanceEvidence = z.infer<
  typeof JobFinderPerformanceEvidenceSchema
>;

export const PerformanceBudgetEvaluationSchema = z.object({
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  kind: z.enum(["deterministic_regression", "live_slo"]),
  unit: z.enum(["milliseconds", "bytes", "count", "percent"]),
  status: z.enum(["pass", "warning", "fail"]),
  observed: z.number().finite().nonnegative(),
  limit: z.number().finite().nonnegative(),
  sampleCount: z.number().int().nonnegative(),
  minimumSamples: z.number().int().positive(),
  regressionPercent: z.number().finite().nullable().default(null),
  detail: NonEmptyStringSchema,
});
export type PerformanceBudgetEvaluation = z.infer<
  typeof PerformanceBudgetEvaluationSchema
>;

/** Renderer process working sets, counted once when several retained tabs share a PID. */
export const WaitingFormMemorySchema = z.object({
  recordedAt: IsoDateTimeSchema,
  budgetBytes: z.number().int().positive(),
  totalBytes: z.number().int().nonnegative(),
  measurementComplete: z.boolean(),
  overBudget: z.boolean(),
  tabs: z
    .array(
      z.object({
        tabId: NonEmptyStringSchema,
        processId: z.number().int().nonnegative(),
        processBytes: z.number().int().nonnegative().nullable(),
        backgroundThrottled: z.boolean(),
      }),
    )
    .max(64),
});
export type WaitingFormMemory = z.infer<typeof WaitingFormMemorySchema>;

export const JobFinderPerformanceSnapshotSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  waitingFormMemory: WaitingFormMemorySchema.optional(),
  latestDiscoveryRun: DiscoveryRunRecordSchema.nullable().default(null),
  latestSourceDebugRun: SourceDebugRunDetailsSchema.nullable().default(null),
  budgetEvaluations: z.array(PerformanceBudgetEvaluationSchema).default([]),
  evidence: z.array(JobFinderPerformanceEvidenceSchema).default([]),
});
export type JobFinderPerformanceSnapshot = z.infer<
  typeof JobFinderPerformanceSnapshotSchema
>;
