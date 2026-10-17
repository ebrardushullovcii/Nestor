import { z } from "zod";
import { NonEmptyStringSchema } from "./base";

export const RESUME_AI_CONCURRENCY = 50;
export const RESUME_LOCAL_CONCURRENCY = 2;
// Admission includes writers and finished drafts waiting for local processing.
// It bounds retained job/profile/draft bodies when the model outruns PDF work.
export const RESUME_PIPELINE_CAPACITY = 100;

export const ResumeBatchGenerationInputSchema = z
  .object({
    batchId: NonEmptyStringSchema,
    jobId: NonEmptyStringSchema,
    regenerate: z.boolean().optional(),
  })
  .strict();
export type ResumeBatchGenerationInput = z.infer<
  typeof ResumeBatchGenerationInputSchema
>;
export interface ResumeBatchProviderBlock {
  reason: "funding" | "authentication" | "permission";
  message: string;
}
export const ResumeBatchProviderBlockSchema: z.ZodType<ResumeBatchProviderBlock> =
  z
    .object({
      reason: z.enum(["funding", "authentication", "permission"]),
      message: NonEmptyStringSchema,
    })
    .strict();

export const ResumeBatchGenerationResultSchema = z
  .object({
    jobId: NonEmptyStringSchema,
    outcome: z.enum([
      "written",
      "fallback",
      "original",
      "cancelled",
      "not_started",
      "failed",
      "blocked",
    ]),
    failureMessage: z.string().optional(),
    providerBlock: ResumeBatchProviderBlockSchema.optional(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if ((result.outcome === "blocked") !== !!result.providerBlock) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerBlock"],
        message: "A provider block belongs to a blocked receipt.",
      });
    }
  });
export type ResumeBatchGenerationResult = z.infer<
  typeof ResumeBatchGenerationResultSchema
>;
export const ResumeBatchGenerationProgressSchema = z
  .object({
    batchId: NonEmptyStringSchema,
    jobId: NonEmptyStringSchema,
    stage: z.enum(["queued", "writing", "processing", "finished"]),
  })
  .strict();
export type ResumeBatchGenerationProgress = z.infer<
  typeof ResumeBatchGenerationProgressSchema
>;
