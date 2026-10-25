import { SourceAccessReferenceSchema } from "./source-access";
import { z } from "zod";
import { CandidateAnswerKindSchema } from "./profile";

import { IsoDateTimeSchema } from "./base";
import { JobIdSchema, JobSelectionSchema } from "./jobs";
import { ApplicationReviewCardSchema } from "./apply";
import {
  ApplicationApplyModeSchema,
  SubmissionOutcomeRecordSchema,
} from "./application-authority";

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
export const ApplicationTargetSchema = z
  .object({ id: ApplicationIdSchema })
  .strict();
export type ApplicationTarget = z.infer<typeof ApplicationTargetSchema>;
export const ApplicationCommandResultSchema = z.boolean();
export const ApplicationsForJobsInputSchema = z
  .object({ jobIds: z.array(JobIdSchema).max(200) })
  .strict();
export type ApplicationsForJobsInput = z.infer<
  typeof ApplicationsForJobsInputSchema
>;
export const ApplicationDetailsSchema = z.object({
  application: ApplicationRowSchema,
  summary: z.string().nullable(),
  detail: z.string().nullable(),
  resumeFileName: z.string().nullable(),
  reviewCard: ApplicationReviewCardSchema.nullable(),
  receipt: SubmissionOutcomeRecordSchema.nullable(),
});
export type ApplicationDetails = z.infer<typeof ApplicationDetailsSchema>;
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
  source: SourceAccessReferenceSchema.optional(),
});
export type NeedsYouTask = z.infer<typeof NeedsYouTaskSchema>;

export const NeedsYouCountsSchema = z.object({
  question: z.number().int().nonnegative(),
  sign_in: z.number().int().nonnegative(),
  captcha: z.number().int().nonnegative(),
  mfa: z.number().int().nonnegative(),
  saved: z.number().int().nonnegative(),
});
export type NeedsYouCounts = z.infer<typeof NeedsYouCountsSchema>;
export const NeedsYouPageSchema = z.object({
  rows: z.array(NeedsYouTaskSchema),
  nextCursor: z.number().int().positive().nullable(),
  total: z.number().int().nonnegative(),
  totalCapped: z.boolean(),
  counts: NeedsYouCountsSchema,
});
export type NeedsYouPage = z.infer<typeof NeedsYouPageSchema>;

export const RequestNeedsYouInputSchema = NeedsYouTaskSchema.omit({
  id: true,
  openedAt: true,
  source: true,
})
  .extend({
    applicationId: ApplicationIdSchema,
    attempt: z.number().int().positive(),
    fieldKey: z.string().min(1).max(500),
    /** Reuse the same fact across input formats; country-dependent questions stay exact. */
    reusePrompt: z.boolean().default(false),
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
    kind: NeedsYouKindSchema.nullable().default(null),
    text: z.string().trim().max(200).default(""),
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

export const NeedsYouDraftSchema = z.object({
  answer: z.string().max(20000),
  remember: z.boolean(),
  revision: z.number().int().nonnegative(),
});
export type NeedsYouDraft = z.infer<typeof NeedsYouDraftSchema>;
export const SaveNeedsYouDraftInputSchema = NeedsYouDraftSchema.extend({
  id: z.number().int().positive(),
}).strict();
export type SaveNeedsYouDraftInput = z.infer<
  typeof SaveNeedsYouDraftInputSchema
>;
export const SaveNeedsYouDraftResultSchema = z.object({
  saved: z.boolean(),
  revision: z.number().int().nonnegative(),
});
export type SaveNeedsYouDraftResult = z.infer<
  typeof SaveNeedsYouDraftResultSchema
>;
export const NeedsYouDetailsSchema = z.object({
  task: NeedsYouTaskSchema,
  applications: z.array(
    ApplicationRowSchema.pick({
      id: true,
      jobId: true,
      title: true,
      company: true,
      location: true,
      state: true,
    }),
  ),
  draft: NeedsYouDraftSchema.nullable(),
});
export type NeedsYouDetails = z.infer<typeof NeedsYouDetailsSchema>;
export const SavedFormAnswerSummarySchema = z.object({
  key: z.string().min(1),
  kind: CandidateAnswerKindSchema,
  label: z.string(),
  needsConfirmation: z.boolean(),
  id: z.number().int().positive(),
  prompt: z.string(),
  preview: z.string(),
  scope: FormAnswerScopeSchema,
  input: NeedsYouTaskSchema.shape.input,
  updatedAt: IsoDateTimeSchema,
});
export type SavedFormAnswerSummary = z.infer<
  typeof SavedFormAnswerSummarySchema
>;
export const SavedFormAnswerSchema = SavedFormAnswerSummarySchema.extend({
  answer: z.string(),
  options: z.array(z.string()),
  roleFamilies: z.array(z.string()),
  proofEntryIds: z.array(z.string()),
});
export type SavedFormAnswer = z.infer<typeof SavedFormAnswerSchema>;
export const SavedFormAnswersQuerySchema = z
  .object({
    after: z.number().int().nonnegative().default(0),
    text: z.string().trim().max(200).default(""),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();
export type SavedFormAnswersQuery = z.input<typeof SavedFormAnswersQuerySchema>;
export const SavedFormAnswersPageSchema = z.object({
  rows: z.array(SavedFormAnswerSummarySchema),
  nextCursor: z.number().int().positive().nullable(),
  total: z.number().int().nonnegative(),
  totalCapped: z.boolean(),
});
export type SavedFormAnswersPage = z.infer<typeof SavedFormAnswersPageSchema>;
export const SaveFormAnswerInputSchema = z
  .object({
    id: z.number().int().positive(),
    answer: z.string().trim().min(1).max(20000),
  })
  .strict();
export type SaveFormAnswerInput = z.infer<typeof SaveFormAnswerInputSchema>;
export const CreateFormAnswerInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(2000),
    answer: z.string().trim().min(1).max(20000),
  })
  .strict();
export type CreateFormAnswerInput = z.infer<typeof CreateFormAnswerInputSchema>;
export const RememberFormAnswerInputSchema = NeedsYouTaskSchema.pick({
  key: true,
  scope: true,
  prompt: true,
  input: true,
  options: true,
})
  .extend({
    answer: z.string().trim().min(1).max(20000),
    kind: CandidateAnswerKindSchema.default("other"),
    label: z.string().trim().max(2000).default(""),
    roleFamilies: z.array(z.string().trim().min(1)).max(100).default([]),
    proofEntryIds: z.array(z.string().trim().min(1)).max(100).default([]),
    needsConfirmation: z.boolean().default(false),
  })
  .strict();
export type RememberFormAnswerInput = z.input<
  typeof RememberFormAnswerInputSchema
>;
export interface FormAnswerLookup {
  key: string;
  prompt: string;
  reusePrompt: boolean;
  kind?: z.infer<typeof CandidateAnswerKindSchema>;
}
export interface FormAnswerMatch {
  id: string;
  key: string;
  prompt: string;
  answer: string;
  local: boolean;
  kind?: z.infer<typeof CandidateAnswerKindSchema>;
  roleFamilies?: string[];
  proofEntryIds?: string[];
}
export function normalizeFormQuestionPrompt(value: string): string {
  return value
    .toLocaleLowerCase("en")
    .replace(/^application\s*[—–-]\s*/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
export const ForgetFormAnswersInputSchema = z.union([
  z
    .object({ ids: z.array(z.number().int().positive()).min(1).max(2000) })
    .strict(),
  z
    .object({
      filter: z.object({ text: z.string().trim().max(200) }).strict(),
      except: z.array(z.number().int().positive()).max(2000),
    })
    .strict(),
]);
export type ForgetFormAnswersInput = z.infer<
  typeof ForgetFormAnswersInputSchema
>;

export const SavedFormAnswerKeySchema = z
  .object({
    key: z.string().trim().min(1).max(500),
    scope: FormAnswerScopeSchema.default({}),
  })
  .strict();
export type SavedFormAnswerKey = z.input<typeof SavedFormAnswerKeySchema>;

export const UpsertSavedFormAnswerInputSchema =
  RememberFormAnswerInputSchema.extend({
    scope: FormAnswerScopeSchema.default({}),
    input: NeedsYouTaskSchema.shape.input.default("text"),
    options: z.array(z.string()).default([]),
  }).strict();
export type UpsertSavedFormAnswerInput = z.input<
  typeof UpsertSavedFormAnswerInputSchema
>;
