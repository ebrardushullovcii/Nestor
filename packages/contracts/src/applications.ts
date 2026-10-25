import { z } from "zod";

import { IsoDateTimeSchema } from "./base";
import { JobIdSchema, JobSelectionSchema } from "./jobs";
import { ApplicationApplyModeSchema } from "./application-authority";

export const ApplyJobsInputSchema = z
  .object({ selection: JobSelectionSchema })
  .strict();
export type ApplyJobsInput = z.input<typeof ApplyJobsInputSchema>;

export const ApplyJobsResultSchema = z.object({
  queued: z.number().int().nonnegative(),
  /** Already queued, sent, or otherwise protected from another attempt. */
  unchanged: z.number().int().nonnegative(),
  /** Explicit ids that are missing or do not have an approved resume. */
  notApproved: z.number().int().nonnegative(),
});
export type ApplyJobsResult = z.infer<typeof ApplyJobsResultSchema>;

export const applicationWorkStates = [
  "queued",
  "running",
  "needs_you",
  "ready",
  "submitting",
  "submitted",
  "stopped",
  "failed",
  "uncertain",
] as const;
export const ApplicationWorkStateSchema = z.enum(applicationWorkStates);
export type ApplicationWorkState = z.infer<typeof ApplicationWorkStateSchema>;

export const ApplicationIdSchema = z.number().int().positive();
export const ApplicationRowSchema = z.object({
  id: ApplicationIdSchema,
  jobId: JobIdSchema,
  mode: ApplicationApplyModeSchema,
  title: z.string(),
  company: z.string(),
  location: z.string(),
  state: ApplicationWorkStateSchema,
  attempt: z.number().int().nonnegative(),
  queuedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  submittedAt: IsoDateTimeSchema.nullable(),
  error: z.string().nullable(),
});
export type ApplicationRow = z.infer<typeof ApplicationRowSchema>;
export const ApplicationPreparationUpdateSchema = z
  .object({
    id: ApplicationIdSchema,
    attempt: z.number().int().positive(),
    state: z.enum(["ready", "failed"]),
    error: z.string().max(2000).optional(),
  })
  .strict();
export type ApplicationPreparationUpdate = z.infer<
  typeof ApplicationPreparationUpdateSchema
>;

export const ApplicationListQuerySchema = z
  .object({
    state: ApplicationWorkStateSchema.nullable().default(null),
    cursor: z.string().max(200).nullable().default(null),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ApplicationListQuery = z.input<typeof ApplicationListQuerySchema>;
export const ApplicationListPageSchema = z.object({
  rows: z.array(ApplicationRowSchema),
  nextCursor: z.string().nullable(),
});
export type ApplicationListPage = z.infer<typeof ApplicationListPageSchema>;

export const NeedsYouKindSchema = z.enum([
  "question",
  "sign_in",
  "captcha",
  "mfa",
]);
export type NeedsYouKind = z.infer<typeof NeedsYouKindSchema>;

/** The producer supplies a semantic key and a country code or site when relevant. */
export const FormAnswerScopeSchema = z
  .object({
    country: z
      .string()
      .trim()
      .regex(
        /^(?:[a-z]{2})?$/iu,
        "Use a two-letter country code, or leave a global answer unscoped.",
      )
      .default("")
      .transform((v) => v.toUpperCase()),
    siteOrigin: z
      .string()
      .url()
      .or(z.literal(""))
      .refine((v) => v === "" || /^https?:\/\//iu.test(v))
      .default("")
      .transform((v) => (v ? new URL(v).origin : "")),
  })
  .strict();
export type FormAnswerScope = z.infer<typeof FormAnswerScopeSchema>;

export const NeedsYouTaskSchema = z.object({
  id: z.number().int().positive(),
  kind: NeedsYouKindSchema,
  key: z.string().min(1),
  scope: FormAnswerScopeSchema,
  prompt: z.string(),
  input: z.enum(["text", "boolean", "choice", "number", "file"]),
  options: z.array(z.string()),
  openedAt: IsoDateTimeSchema,
});
export type NeedsYouTask = z.infer<typeof NeedsYouTaskSchema>;

export const NeedsYouPageSchema = z.object({
  rows: z.array(NeedsYouTaskSchema),
  nextCursor: z.number().int().positive().nullable(),
});
export type NeedsYouPage = z.infer<typeof NeedsYouPageSchema>;

export const RequestNeedsYouInputSchema = NeedsYouTaskSchema.omit({
  id: true,
  openedAt: true,
})
  .extend({
    applicationId: ApplicationIdSchema,
    attempt: z.number().int().positive(),
    fieldKey: z.string().min(1).max(500),
  })
  .strict();
export type RequestNeedsYouInput = z.input<typeof RequestNeedsYouInputSchema>;
export const RequestNeedsYouResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("stale") }),
  z.object({ status: z.literal("answered"), answer: z.string() }),
  z.object({ status: z.literal("needs_you"), task: NeedsYouTaskSchema }),
]);
export type RequestNeedsYouResult = z.infer<typeof RequestNeedsYouResultSchema>;

export const NeedsYouListQuerySchema = z
  .object({
    after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();
export type NeedsYouListQuery = z.input<typeof NeedsYouListQuerySchema>;

export const AnswerNeedsYouInputSchema = z
  .object({
    id: z.number().int().positive(),
    answer: z.string().min(1).max(20000),
    remember: z.boolean(),
  })
  .strict();
export type AnswerNeedsYouInput = z.infer<typeof AnswerNeedsYouInputSchema>;
export const AnswerNeedsYouResultSchema = z.object({
  resolved: z.boolean(),
  queued: z.number().int().nonnegative(),
});
export type AnswerNeedsYouResult = z.infer<typeof AnswerNeedsYouResultSchema>;

/** Synthetic preconditions for the isolated desktop verification instance. */
export const ApplicationStoreDemoInputSchema = z
  .object({
    sourceUrl: z.string().url(),
    trackApplications: z.boolean().optional(),
  })
  .strict();
export const ApplicationStoreDemoResultSchema = z.object({
  approvedIds: z.array(JobIdSchema),
  unapprovedId: JobIdSchema,
});
export type ApplicationStoreDemoResult = z.infer<
  typeof ApplicationStoreDemoResultSchema
>;
