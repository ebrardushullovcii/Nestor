import { z } from "zod";

import { IsoDateTimeSchema, NonEmptyStringSchema } from "./base";
import {
  PerformanceEvidenceAreaSchema,
  PerformanceEvidenceStageDurationSchema,
  WaitingFormMemorySchema,
} from "./performance";

const CountSchema = z.number().int().nonnegative();

export const JobFinderDiagnosticExportSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: IsoDateTimeSchema,
    build: z
      .object({
        appVersion: NonEmptyStringSchema,
        electronVersion: NonEmptyStringSchema,
        chromiumVersion: NonEmptyStringSchema,
        nodeVersion: NonEmptyStringSchema,
        platform: z.enum(["win32", "darwin", "linux"]),
        architecture: z.enum(["x64", "arm64", "ia32"]),
      })
      .strict(),
    state: z
      .object({
        profileSetupStatus: z.enum(["not_started", "in_progress", "completed"]),
        browserStatus: z.enum([
          "unknown",
          "ready",
          "login_required",
          "blocked",
        ]),
        counts: z
          .object({
            configuredSources: CountSchema,
            visibleJobs: CountSchema,
            shortlistedJobs: CountSchema,
            applications: CountSchema,
            unresolvedActions: CountSchema,
          })
          .strict(),
      })
      .strict(),
    timings: z
      .object({
        latestDiscoveryDurationMs: z.number().nonnegative().nullable(),
        latestResumeImportDurationMs: z.number().nonnegative().nullable(),
        latestApplyDurationMs: z.number().nonnegative().nullable(),
      })
      .strict(),
    performance: z
      .object({
        waitingFormMemory: WaitingFormMemorySchema.optional(),
        measurements: z.array(
          z.discriminatedUnion("measurementStatus", [
            z
              .object({
                area: PerformanceEvidenceAreaSchema,
                measurementStatus: z.literal("available"),
                durationMs: z.number().finite().nonnegative(),
                recordedAt: IsoDateTimeSchema,
                sampleCount: z.number().int().positive(),
                budgetStatus: z.enum([
                  "pass",
                  "warning",
                  "fail",
                  "not_evaluated",
                ]),
                stageDurations: z
                  .array(PerformanceEvidenceStageDurationSchema)
                  .default([]),
              })
              .strict(),
            z
              .object({
                area: PerformanceEvidenceAreaSchema,
                measurementStatus: z.literal("partial"),
                durationMs: z.null(),
                recordedAt: IsoDateTimeSchema,
                sampleCount: z.number().int().positive(),
                budgetStatus: z.enum([
                  "pass",
                  "warning",
                  "fail",
                  "not_evaluated",
                ]),
                stageDurations: z
                  .array(PerformanceEvidenceStageDurationSchema)
                  .min(1),
              })
              .strict(),
            z
              .object({
                area: PerformanceEvidenceAreaSchema,
                measurementStatus: z.literal("unavailable"),
                durationMs: z.null(),
                recordedAt: z.null(),
                sampleCount: z.literal(0),
                budgetStatus: z.literal("unavailable"),
                stageDurations: z.array(z.never()).max(0).default([]),
              })
              .strict(),
          ]),
        ),
        budgetEvaluations: z.array(
          z
            .object({
              id: NonEmptyStringSchema.max(100),
              status: z.enum(["pass", "warning", "fail"]),
              unit: z.enum(["milliseconds", "bytes", "count", "percent"]),
              observed: z.number().finite().nonnegative(),
              limit: z.number().finite().nonnegative(),
              sampleCount: CountSchema,
              minimumSamples: z.number().int().positive(),
            })
            .strict(),
        ),
      })
      .strict(),
    warnings: z.array(
      z
        .object({
          category: z.enum(["performance_budget", "provider_availability"]),
          code: NonEmptyStringSchema.max(80),
          status: z.enum(["warning", "fail"]),
        })
        .strict(),
    ),
    capabilities: z
      .object({
        agentReady: z.boolean(),
        visionReady: z.boolean(),
        browserReady: z.boolean(),
        originalResumeReady: z.boolean(),
        tailoredResumeCount: CountSchema,
        prepareOnlyApplicationCount: CountSchema,
        finalSubmissionAuthorized: z.literal(false),
        accountCreationAuthorized: z.literal(false),
      })
      .strict(),
    evidence: z
      .object({
        sourceDebugRuns: CountSchema,
        resumeImports: CountSchema,
        applicationAttempts: CountSchema,
        userActionEvents: CountSchema,
      })
      .strict(),
    redactionManifest: z
      .object({
        policy: z.literal("strict_allowlist_v1"),
        localOnly: z.literal(true),
        transmitted: z.literal(false),
        excluded: z.array(
          z.enum([
            "credentials",
            "raw_resumes",
            "screenshots",
            "transcripts_and_audio",
            "browser_storage",
            "private_payloads",
            "url_secrets",
            "local_paths",
          ]),
        ),
      })
      .strict(),
  })
  .strict();
export type JobFinderDiagnosticExport = z.infer<
  typeof JobFinderDiagnosticExportSchema
>;

export const JobFinderDiagnosticExportResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("saved") }).strict(),
    z.object({ status: z.literal("cancelled") }).strict(),
  ],
);
export type JobFinderDiagnosticExportResult = z.infer<
  typeof JobFinderDiagnosticExportResultSchema
>;
