import { z } from "zod";

export const ModelTokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  // Separate from provider totals above. Absent on older or fully reported usage.
  estimated: z
    .object({
      calls: z.number().int().nonnegative().default(0),
      inputTokens: z.number().int().nonnegative().default(0),
      outputTokens: z.number().int().nonnegative().default(0),
      // Hidden reasoning, cache hits and provider billing cannot be inferred.
      method: z.literal("utf8_bytes_div_4_visible_only"),
    })
    .optional(),
});
export type ModelTokenUsage = z.infer<typeof ModelTokenUsageSchema>;
export interface ModelRequestUsage extends ModelTokenUsage {
  requestId: string;
  startedAt: string;
  finishedAt: string;
  provider: string;
  model: string;
  purpose: string;
  attempt: number;
  outcome: "completed" | "failed" | "cancelled";
  httpStatus?: number;
  providerTotalTokens?: number;
  failureKind?:
    | "network"
    | "http_status"
    | "timeout"
    | "incomplete_stream"
    | "other"
    | "cancelled";
}
export interface ModelRequestAttempt {
  attempt: number;
  maxAttempts: number;
}

export const ModelUsageTotalsSchema = ModelTokenUsageSchema.extend({
  calls: z.number().int().nonnegative(),
  unreportedCalls: z.number().int().nonnegative(),
});
export type ModelUsageTotals = z.infer<typeof ModelUsageTotalsSchema>;
export const ApplicationApplyUsageTotalsSchema = ModelUsageTotalsSchema.extend({
  preparationAttempts: z.number().int().nonnegative(),
});
export type ApplicationApplyUsageTotals = z.infer<
  typeof ApplicationApplyUsageTotalsSchema
>;

/** Durations overlap: tool time includes checks; auxiliary model calls may run during tools. */
const ApplyAgentTimingRecordSchema = z.object({
  totalMs: z.number().finite().nonnegative(),
  modelMs: z.number().finite().nonnegative(),
  modelTurns: z.number().int().nonnegative(),
  auxiliaryModelMs: z.number().finite().nonnegative(),
  auxiliaryModelCalls: z.number().int().nonnegative(),
  // Absent on runs from before provider requests were counted: not zero, unknown.
  transportCalls: z.number().int().nonnegative().optional(),
  transportRetries: z.number().int().nonnegative().optional(),
  tokenUsage: ModelTokenUsageSchema.extend({
    reportedCalls: z.number().int().nonnegative(),
    unreportedCalls: z.number().int().nonnegative(),
  }).optional(),
  questionReadingCalls: z.number().int().nonnegative().optional(),
  questionReadingMs: z.number().finite().nonnegative().optional(),
  answerCheckCalls: z.number().int().nonnegative().optional(),
  answerCheckMs: z.number().finite().nonnegative().optional(),
  toolMs: z.number().finite().nonnegative(),
  pageReadMs: z.number().finite().nonnegative(),
  pageReads: z.number().int().nonnegative(),
  writeMs: z.number().finite().nonnegative(),
  uploadMs: z.number().finite().nonnegative(),
  longestSteps: z
    .array(
      z.object({
        toolName: z.string().min(1).max(100),
        durationMs: z.number().finite().nonnegative(),
      }),
    )
    .max(5),
  requests: z
    .array(
      z.object({
        turn: z.number().int().positive(),
        historyChars: z.number().int().nonnegative(),
        observationChars: z.number().int().nonnegative(),
        // Optional so timing records from earlier runs still load.
        fieldsAttempted: z.number().int().nonnegative().optional(),
        fieldsFilled: z.number().int().nonnegative().optional(),
        storedFactFills: z.number().int().nonnegative().optional(),
        answersWaited: z.number().int().nonnegative().optional(),
        stepsAdvanced: z.number().int().nonnegative().optional(),
        uploadsAttached: z.number().int().nonnegative().optional(),
      }),
    )
    .max(1000),
});
export type ApplyAgentTiming = z.infer<typeof ApplyAgentTimingRecordSchema>;
// Keep the timing schema from expanding through every workspace state schema.
export const ApplyAgentTimingSchema: z.ZodType<ApplyAgentTiming> =
  ApplyAgentTimingRecordSchema;
