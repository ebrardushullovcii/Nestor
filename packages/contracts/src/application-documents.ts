import { z } from "zod";

import { IsoDateTimeSchema, NonEmptyStringSchema } from "./base";
import { CandidateAssetSchema } from "./candidate-assets";

export const ApplicationDocumentKindSchema = z.enum([
  "cover_letter",
  "short_response",
]);
export type ApplicationDocumentKind = z.infer<
  typeof ApplicationDocumentKindSchema
>;

export const ApplicationDocumentStatusSchema = z.enum([
  "proposed",
  "approved",
  "exported",
]);
export type ApplicationDocumentStatus = z.infer<
  typeof ApplicationDocumentStatusSchema
>;

export const ApplicationDocumentJobLineageSchema = z.object({
  jobId: NonEmptyStringSchema,
  applicationRecordId: NonEmptyStringSchema,
  sourceJobId: NonEmptyStringSchema,
  canonicalUrl: z.string().url(),
  title: NonEmptyStringSchema,
  company: NonEmptyStringSchema,
  jobDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ApplicationDocumentJobLineage = z.infer<
  typeof ApplicationDocumentJobLineageSchema
>;

export const ApplicationDocumentQuestionLineageSchema = z.object({
  runId: NonEmptyStringSchema,
  questionId: NonEmptyStringSchema,
  prompt: NonEmptyStringSchema.max(2_000),
});
export type ApplicationDocumentQuestionLineage = z.infer<
  typeof ApplicationDocumentQuestionLineageSchema
>;

export const ApplicationDocumentEvidenceRefSchema = z.object({
  id: NonEmptyStringSchema,
  source: z.enum([
    "profile_summary",
    "experience",
    "project",
    "proof_bank",
    "skill",
  ]),
  label: NonEmptyStringSchema.max(240),
  text: NonEmptyStringSchema.max(2_000),
});
export type ApplicationDocumentEvidenceRef = z.infer<
  typeof ApplicationDocumentEvidenceRefSchema
>;

export const ApplicationDocumentRevisionSchema = z.object({
  id: NonEmptyStringSchema,
  revision: z.number().int().positive(),
  kind: ApplicationDocumentKindSchema,
  status: ApplicationDocumentStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  job: ApplicationDocumentJobLineageSchema,
  question: ApplicationDocumentQuestionLineageSchema.nullable().default(null),
  content: NonEmptyStringSchema.max(12_000),
  evidence: z.array(ApplicationDocumentEvidenceRefSchema).min(1).max(8),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  authorship: z
    .enum(["system_grounded", "user_edited"])
    .default("system_grounded"),
  requiresGroundingReview: z.boolean().default(false),
  reviewReason: NonEmptyStringSchema.max(2_000).nullable().default(null),
  approvedAt: IsoDateTimeSchema.nullable().default(null),
  outputAsset: CandidateAssetSchema.nullable().default(null),
  lastExportedAt: IsoDateTimeSchema.nullable().default(null),
});
export type ApplicationDocumentRevision = z.infer<
  typeof ApplicationDocumentRevisionSchema
>;

const ApplicationDocumentQuestionTargetSchema = z
  .object({
    runId: NonEmptyStringSchema,
    questionId: NonEmptyStringSchema,
  })
  .strict();

export const ProposeApplicationDocumentInputSchema = z
  .object({
    kind: ApplicationDocumentKindSchema,
    jobId: NonEmptyStringSchema,
    applicationRecordId: NonEmptyStringSchema,
    question: ApplicationDocumentQuestionTargetSchema.nullable().default(null),
    documentId: NonEmptyStringSchema.optional(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.documentId === undefined) !== (value.expectedRevision === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedRevision"],
        message: "Revising a document requires its ID and expected revision.",
      });
    }
  });
export type ProposeApplicationDocumentInput = z.infer<
  typeof ProposeApplicationDocumentInputSchema
>;

export const ApproveApplicationDocumentInputSchema = z
  .object({
    documentId: NonEmptyStringSchema,
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export type ApproveApplicationDocumentInput = z.infer<
  typeof ApproveApplicationDocumentInputSchema
>;

export const EditApplicationDocumentInputSchema = z
  .object({
    documentId: NonEmptyStringSchema,
    expectedRevision: z.number().int().positive(),
    content: z
      .string()
      .trim()
      .min(1, "Document content cannot be empty.")
      .max(12_000, "Document content cannot exceed 12,000 characters."),
  })
  .strict();
export type EditApplicationDocumentInput = z.infer<
  typeof EditApplicationDocumentInputSchema
>;

export const ExportApplicationDocumentInputSchema = z
  .object({
    documentId: NonEmptyStringSchema,
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export type ExportApplicationDocumentInput = z.infer<
  typeof ExportApplicationDocumentInputSchema
>;

export const ListApplicationDocumentsInputSchema = z
  .object({
    jobId: NonEmptyStringSchema,
    applicationRecordId: NonEmptyStringSchema,
  })
  .strict();
export type ListApplicationDocumentsInput = z.infer<
  typeof ListApplicationDocumentsInputSchema
>;

export const ApplicationDocumentListResultSchema = z.object({
  documents: z.array(ApplicationDocumentRevisionSchema),
  /** The latest approved revision behind each newer proposed revision. */
  approvedRevisions: z.array(ApplicationDocumentRevisionSchema).default([]),
});
export type ApplicationDocumentListResult = z.infer<
  typeof ApplicationDocumentListResultSchema
>;

export const ApplicationDocumentExportResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("cancelled") }),
    z.object({
      status: z.literal("exported"),
      document: ApplicationDocumentRevisionSchema,
      fileName: NonEmptyStringSchema,
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      byteSize: z.number().int().positive(),
    }),
  ],
);
export type ApplicationDocumentExportResult = z.infer<
  typeof ApplicationDocumentExportResultSchema
>;

/** Names for the original resume and its byte-identical Markdown text copy. */
export function resumeFormFileNames(fileName: string): readonly string[] {
  return /\.md$/iu.test(fileName)
    ? [fileName, fileName.replace(/\.md$/iu, ".txt")]
    : [fileName];
}
