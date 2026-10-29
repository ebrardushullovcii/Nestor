import { z } from "zod";

import {
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  ResumeTemplateIdSchema,
} from "./base";
import { AgentTaskMessageAttributionSchema } from "./agent-task";

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

export const resumeExportFormatValues = ["html", "pdf"] as const;

export const ResumeExportFormatSchema = z.enum(resumeExportFormatValues);
export type ResumeExportFormat = z.infer<typeof ResumeExportFormatSchema>;

export const resumeDraftStatusValues = [
  "draft",
  "needs_review",
  "approved",
  "stale",
] as const;

export const ResumeDraftStatusSchema = z.enum(resumeDraftStatusValues);
export type ResumeDraftStatus = z.infer<typeof ResumeDraftStatusSchema>;

export const resumeDraftSectionKindValues = [
  "header",
  "summary",
  "skills",
  "experience",
  "projects",
  "education",
  "certifications",
  "keywords",
] as const;

export const ResumeDraftSectionKindSchema = z.enum(
  resumeDraftSectionKindValues,
);
export type ResumeDraftSectionKind = z.infer<
  typeof ResumeDraftSectionKindSchema
>;

export const resumeDraftEntryTypeValues = [
  "experience",
  "project",
  "education",
  "certification",
  "skill_group",
  "language",
] as const;

export const ResumeDraftEntryTypeSchema = z.enum(resumeDraftEntryTypeValues);
export type ResumeDraftEntryType = z.infer<typeof ResumeDraftEntryTypeSchema>;

export const resumeDraftSourceKindValues = [
  "resume",
  "profile",
  "proof",
  "job",
  "research",
  "user",
] as const;

export const ResumeDraftSourceKindSchema = z.enum(resumeDraftSourceKindValues);
export type ResumeDraftSourceKind = z.infer<typeof ResumeDraftSourceKindSchema>;

export const resumeDraftOriginValues = [
  "imported",
  "ai_generated",
  "user_edited",
  "assistant_edited",
  "deterministic_fallback",
] as const;

export const ResumeDraftOriginSchema = z.enum(resumeDraftOriginValues);
export type ResumeDraftOrigin = z.infer<typeof ResumeDraftOriginSchema>;

export const resumeDraftGenerationMethodValues = [
  "ai",
  "deterministic",
  "manual",
] as const;

export const ResumeDraftGenerationMethodSchema = z.enum(
  resumeDraftGenerationMethodValues,
);
export type ResumeDraftGenerationMethod = z.infer<
  typeof ResumeDraftGenerationMethodSchema
>;

export const resumeCoverageClassificationValues = [
  "detailed",
  "compact",
  "suggested_hidden",
  "omitted",
] as const;

export const ResumeCoverageClassificationSchema = z.enum(
  resumeCoverageClassificationValues,
);
export type ResumeCoverageClassification = z.infer<
  typeof ResumeCoverageClassificationSchema
>;

export const resumeCareerFamilyFitValues = [
  "strong",
  "weak",
  "unrelated",
] as const;

export const ResumeCareerFamilyFitSchema = z.enum(resumeCareerFamilyFitValues);
export type ResumeCareerFamilyFit = z.infer<typeof ResumeCareerFamilyFitSchema>;

export const ResumeCoverageDecisionSchema = z.object({
  profileRecordId: NonEmptyStringSchema,
  classification: ResumeCoverageClassificationSchema,
  careerFamilyFit: ResumeCareerFamilyFitSchema,
  reasons: z.array(NonEmptyStringSchema).default([]),
  reviewGuidance: z.array(NonEmptyStringSchema).default([]),
  coversMeaningfulGap: z.boolean().default(false),
});
export type ResumeCoverageDecision = z.infer<
  typeof ResumeCoverageDecisionSchema
>;

export const TailoredResumeCoverageMetadataSchema =
  ResumeCoverageDecisionSchema;
export type TailoredResumeCoverageMetadata = z.infer<
  typeof TailoredResumeCoverageMetadataSchema
>;

export const resumePatchOperationValues = [
  "replace_section_text",
  "replace_entry_summary",
  "replace_entry_date_range",
  "insert_bullet",
  "update_bullet",
  "remove_bullet",
  "move_bullet",
  "move_entry",
  "reset_entry_order",
  "toggle_include",
  "set_lock",
  "replace_section_bullets",
] as const;

export const ResumeDraftPatchOperationSchema = z.enum(
  resumePatchOperationValues,
);
export type ResumeDraftPatchOperation = z.infer<
  typeof ResumeDraftPatchOperationSchema
>;

export const resumePatchOriginValues = ["user", "assistant"] as const;

export const ResumeDraftPatchOriginSchema = z.enum(resumePatchOriginValues);
export type ResumeDraftPatchOrigin = z.infer<
  typeof ResumeDraftPatchOriginSchema
>;

export const resumeValidationSeverityValues = [
  "error",
  "warning",
  "info",
] as const;

export const ResumeValidationSeveritySchema = z.enum(
  resumeValidationSeverityValues,
);
export type ResumeValidationSeverity = z.infer<
  typeof ResumeValidationSeveritySchema
>;

export const resumeValidationCategoryValues = [
  "unsupported_claim",
  "invented_metric",
  "duplicate_bullet",
  "duplicate_section_content",
  "job_description_bleed",
  "thin_output",
  "keyword_stuffing",
  "vague_filler",
  "poor_keyword_coverage",
  "empty_section",
  "page_overflow",
  "work_history_review",
  "low_confidence_fact",
  "stale_approval",
  "date_quality",
  "claim_confirmation_needed",
  "identity_mismatch",
] as const;

export const ResumeValidationCategorySchema = z.enum(
  resumeValidationCategoryValues,
);
export type ResumeValidationCategory = z.infer<
  typeof ResumeValidationCategorySchema
>;

export const resumeResearchFetchStatusValues = [
  "success",
  "failed",
  "skipped",
] as const;

export const ResumeResearchFetchStatusSchema = z.enum(
  resumeResearchFetchStatusValues,
);
export type ResumeResearchFetchStatus = z.infer<
  typeof ResumeResearchFetchStatusSchema
>;

export const resumeAssistantRoleValues = ["user", "assistant"] as const;

export const ResumeAssistantRoleSchema = z.enum(resumeAssistantRoleValues);
export type ResumeAssistantRole = z.infer<typeof ResumeAssistantRoleSchema>;

export const ResumeDraftSourceRefSchema = z.object({
  id: NonEmptyStringSchema,
  sourceKind: ResumeDraftSourceKindSchema,
  sourceId: NonEmptyStringSchema.nullable().default(null),
  snippet: NonEmptyStringSchema.nullable().default(null),
});
export type ResumeDraftSourceRef = z.infer<typeof ResumeDraftSourceRefSchema>;

export const resumeClaimAssessmentStatusValues = [
  "exact",
  "paraphrase",
  "review",
  "confirm_needed",
  "unsupported",
] as const;
export const ResumeClaimAssessmentStatusSchema = z.enum(
  resumeClaimAssessmentStatusValues,
);
export type ResumeClaimAssessmentStatus = z.infer<
  typeof ResumeClaimAssessmentStatusSchema
>;

export const resumeClaimFieldValues = [
  "section_text",
  "section_bullet",
  "entry_summary",
  "entry_bullet",
] as const;
export const ResumeClaimFieldSchema = z.enum(resumeClaimFieldValues);
export type ResumeClaimField = z.infer<typeof ResumeClaimFieldSchema>;

export const ResumeClaimEvidenceRefSchema = z.object({
  id: NonEmptyStringSchema,
  sourceKind: z.enum(["resume", "profile", "proof", "user"]),
  sourceId: NonEmptyStringSchema,
  snippet: NonEmptyStringSchema,
});
export type ResumeClaimEvidenceRef = z.infer<
  typeof ResumeClaimEvidenceRefSchema
>;

export const resumeClaimVerifierValues = [
  "deterministic_candidate_evidence_v1",
  "deterministic_candidate_evidence_v2",
  /** The model read the line against the candidate's evidence (ADR 0041). */
  "model_fact_check_v1",
] as const;
export const ResumeClaimVerifierSchema = z.enum(resumeClaimVerifierValues);
export type ResumeClaimVerifier = z.infer<typeof ResumeClaimVerifierSchema>;

export const ResumeClaimAssessmentSchema = z.object({
  id: NonEmptyStringSchema,
  field: ResumeClaimFieldSchema,
  sectionId: NonEmptyStringSchema,
  entryId: NonEmptyStringSchema.nullable().default(null),
  bulletId: NonEmptyStringSchema.nullable().default(null),
  claimText: NonEmptyStringSchema,
  claimOrigin: ResumeDraftOriginSchema,
  contentHash: NonEmptyStringSchema,
  status: ResumeClaimAssessmentStatusSchema,
  evidenceRefs: z.array(ResumeClaimEvidenceRefSchema).default([]),
  // Persisted v1 assessments must stay parseable; v2 marks the converged
  // deterministic evidence verifier without changing the assessment shape.
  verifier: ResumeClaimVerifierSchema,
  assessedAt: IsoDateTimeSchema,
});
export type ResumeClaimAssessment = z.infer<typeof ResumeClaimAssessmentSchema>;

/**
 * FNV-1a 32-bit hash of the normalized claim text, matching how existing
 * claim assessments hash candidate content:
 * `fnv1a32(normalizeText(claim.text))`. Normalization-equivalent text
 * changes intentionally retain the same hash; substantive wording changes
 * produce a different hash.
 */
export const ResumeClaimContentHashSchema = z
  .string()
  .regex(/^fnv1a32:[0-9a-f]{8}$/);

/**
 * The person's explicit approval of one validation blocker that is not a
 * claim assessment (an invented-looking metric, job-description wording, a
 * thin import, an identity mismatch). It is their resume: the product warns,
 * the person decides. Bound to the exact flagged wording so an edit to the
 * line drops the approval and the check runs again.
 */
export const ResumeIssueApprovalSchema = z
  .object({
    id: NonEmptyStringSchema,
    draftId: NonEmptyStringSchema,
    issueId: NonEmptyStringSchema,
    approvedContentHash: ResumeClaimContentHashSchema,
    approvedAt: IsoDateTimeSchema,
  })
  .strict();
export type ResumeIssueApproval = z.infer<typeof ResumeIssueApprovalSchema>;
export const ResumeIssueApprovalsFieldSchema = z
  .array(ResumeIssueApprovalSchema)
  .max(200)
  .default([]);

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

type ResumeValidationIssueShape = {
  id: string;
  severity: "error" | "warning" | "info";
  message: string;
  flaggedText?: string | null | undefined;
};

/** What an issue approval is bound to: the flagged sentence, else the message. */
export function buildResumeIssueApprovalContentHash(
  issue: Pick<ResumeValidationIssueShape, "flaggedText" | "message">,
): string {
  const text = (issue.flaggedText ?? issue.message)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return fnv1a32(text);
}

export function matchResumeIssueApproval<
  T extends ResumeValidationIssueShape,
>(input: {
  issue: T;
  draft: Pick<ResumeDraft, "id" | "issueApprovals">;
}): ResumeIssueApproval | null {
  const hash = buildResumeIssueApprovalContentHash(input.issue);
  return (
    (input.draft.issueApprovals ?? []).find(
      (approval) =>
        approval.draftId === input.draft.id &&
        approval.issueId === input.issue.id &&
        approval.approvedContentHash === hash,
    ) ?? null
  );
}

export const RESUME_ISSUE_APPROVED_PREFIX = "You approved this as accurate. ";

/**
 * Blockers the person approved become notes: same wording, no longer an
 * error, prefixed so the row says who decided. Every gate that asks "is this
 * issue blocking" reads the result, so approval and export can never disagree.
 */
export function applyResumeIssueApprovals<
  T extends ResumeValidationIssueShape,
>(input: {
  issues: readonly T[];
  draft: Pick<ResumeDraft, "id" | "issueApprovals">;
}): T[] {
  return input.issues.map((issue) => {
    if (issue.severity !== "error") return issue;
    if (!matchResumeIssueApproval({ issue, draft: input.draft })) return issue;
    return {
      ...issue,
      severity: "warning" as const,
      message: `${RESUME_ISSUE_APPROVED_PREFIX}${issue.message}`,
    };
  });
}

export const ResumeDraftIdentitySchema = z.object({
  fullName: NonEmptyStringSchema.nullable().default(null),
  headline: NonEmptyStringSchema.nullable().default(null),
  location: NonEmptyStringSchema.nullable().default(null),
  email: NonEmptyStringSchema.nullable().default(null),
  phone: NonEmptyStringSchema.nullable().default(null),
  portfolioUrl: NonEmptyStringSchema.nullable().default(null),
  linkedinUrl: NonEmptyStringSchema.nullable().default(null),
  githubUrl: NonEmptyStringSchema.nullable().default(null),
  personalWebsiteUrl: NonEmptyStringSchema.nullable().default(null),
  additionalLinks: z.array(NonEmptyStringSchema).default([]),
});
export type ResumeDraftIdentity = z.infer<typeof ResumeDraftIdentitySchema>;

export const ResumeDraftBulletSchema = z.object({
  id: NonEmptyStringSchema,
  text: NonEmptyStringSchema,
  origin: ResumeDraftOriginSchema,
  locked: z.boolean().default(false),
  included: z.boolean().default(true),
  sourceRefs: z.array(ResumeDraftSourceRefSchema).default([]),
  lastGeneratedContentHash:
    ResumeClaimContentHashSchema.nullable().default(null),
  updatedAt: IsoDateTimeSchema,
});
export type ResumeDraftBullet = z.infer<typeof ResumeDraftBulletSchema>;

const resumeDraftEntryBaseSchema = z.object({
  id: NonEmptyStringSchema,
  entryType: ResumeDraftEntryTypeSchema,
  title: NonEmptyStringSchema.nullable().default(null),
  subtitle: NonEmptyStringSchema.nullable().default(null),
  location: NonEmptyStringSchema.nullable().default(null),
  dateRange: NonEmptyStringSchema.nullable().default(null),
  startDate: NonEmptyStringSchema.nullable().default(null),
  endDate: NonEmptyStringSchema.nullable().default(null),
  isCurrent: z.boolean().default(false),
  summary: NonEmptyStringSchema.nullable().default(null),
  bullets: z.array(ResumeDraftBulletSchema).default([]),
  origin: ResumeDraftOriginSchema,
  locked: z.boolean().default(false),
  included: z.boolean().default(true),
  sortOrder: z.number().int().min(0),
  profileRecordId: NonEmptyStringSchema.nullable().default(null),
  sourceRefs: z.array(ResumeDraftSourceRefSchema).default([]),
  updatedAt: IsoDateTimeSchema,
});
export const ResumeDraftEntrySchema = resumeDraftEntryBaseSchema.transform(
  (entry) => {
    if (
      entry.startDate ||
      entry.endDate ||
      entry.isCurrent ||
      !entry.dateRange
    ) {
      return entry;
    }

    const parts = entry.dateRange
      .split(/\s*[–—]\s*|\s+-\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length < 2) {
      return entry;
    }

    const end = parts.at(-1) ?? null;
    const matchesCurrent = Boolean(
      end && /^(present|current|now|ongoing)$/i.test(end),
    );

    return {
      ...entry,
      startDate: parts[0] ?? null,
      endDate: matchesCurrent ? null : end,
      isCurrent: matchesCurrent,
    };
  },
);
export type ResumeDraftEntry = z.infer<typeof ResumeDraftEntrySchema>;

export const resumeDraftEntryOrderModeValues = [
  "chronology",
  "manual",
] as const;

export const ResumeDraftEntryOrderModeSchema = z.enum(
  resumeDraftEntryOrderModeValues,
);
export type ResumeDraftEntryOrderMode = z.infer<
  typeof ResumeDraftEntryOrderModeSchema
>;

export const ResumeDraftSectionSchema = z.object({
  id: NonEmptyStringSchema,
  kind: ResumeDraftSectionKindSchema,
  label: NonEmptyStringSchema,
  text: NonEmptyStringSchema.nullable().default(null),
  bullets: z.array(ResumeDraftBulletSchema).default([]),
  entries: z.array(ResumeDraftEntrySchema).default([]),
  origin: ResumeDraftOriginSchema,
  locked: z.boolean().default(false),
  included: z.boolean().default(true),
  sortOrder: z.number().int().min(0),
  entryOrderMode: ResumeDraftEntryOrderModeSchema.default("chronology"),
  profileRecordId: NonEmptyStringSchema.nullable().default(null),
  sourceRefs: z.array(ResumeDraftSourceRefSchema).default([]),
  updatedAt: IsoDateTimeSchema,
});
export type ResumeDraftSection = z.output<typeof ResumeDraftSectionSchema>;

export const workHistoryReviewSuggestionKindValues = [
  "weak_fit",
  "gap_coverage",
  "compact_recommended",
  "date_quality",
] as const;
export const WorkHistoryReviewSuggestionKindSchema = z.enum(
  workHistoryReviewSuggestionKindValues,
);
export type WorkHistoryReviewSuggestionKind = z.infer<
  typeof WorkHistoryReviewSuggestionKindSchema
>;

export const workHistoryReviewSuggestionActionValues = [
  "review",
  "consider_showing",
  "consider_hiding",
  "keep_compact",
  "fix_dates",
] as const;
export const WorkHistoryReviewSuggestionActionSchema = z.enum(
  workHistoryReviewSuggestionActionValues,
);
export type WorkHistoryReviewSuggestionAction = z.infer<
  typeof WorkHistoryReviewSuggestionActionSchema
>;

/**
 * FNV-1a 32-bit hash of the exact canonical `WorkHistoryReviewSuggestion.message`
 * string. No normalization is applied: acknowledgments must hash the exact
 * canonical message so any suggestion rewrite invalidates prior acknowledgments.
 */
export const WorkHistoryReviewMessageContentHashSchema = z
  .string()
  .regex(/^fnv1a32:[0-9a-f]{8}$/);

export const WorkHistoryReviewSuggestionSchema = z.object({
  id: NonEmptyStringSchema,
  profileRecordId: NonEmptyStringSchema,
  sectionId: NonEmptyStringSchema.nullable().default(null),
  entryId: NonEmptyStringSchema.nullable().default(null),
  kind: WorkHistoryReviewSuggestionKindSchema,
  action: WorkHistoryReviewSuggestionActionSchema,
  severity: ResumeValidationSeveritySchema.default("info"),
  message: NonEmptyStringSchema,
  messageContentHash: WorkHistoryReviewMessageContentHashSchema,
});
export type WorkHistoryReviewSuggestion = z.infer<
  typeof WorkHistoryReviewSuggestionSchema
>;

export const workHistoryReviewAcknowledgmentReasonValues = [
  "intentional_omission",
  "intentional_compaction",
] as const;
export const WorkHistoryReviewAcknowledgmentReasonSchema = z.enum(
  workHistoryReviewAcknowledgmentReasonValues,
);
export type WorkHistoryReviewAcknowledgmentReason = z.infer<
  typeof WorkHistoryReviewAcknowledgmentReasonSchema
>;

export const workHistoryReviewAcknowledgmentKindValues = [
  "weak_fit",
  "gap_coverage",
  "compact_recommended",
] as const;
export const WorkHistoryReviewAcknowledgmentKindSchema = z.enum(
  workHistoryReviewAcknowledgmentKindValues,
);
export type WorkHistoryReviewAcknowledgmentKind = z.infer<
  typeof WorkHistoryReviewAcknowledgmentKindSchema
>;

export const workHistoryReviewAcknowledgmentActionValues = [
  "consider_showing",
  "keep_compact",
] as const;
export const WorkHistoryReviewAcknowledgmentActionSchema = z.enum(
  workHistoryReviewAcknowledgmentActionValues,
);
export type WorkHistoryReviewAcknowledgmentAction = z.infer<
  typeof WorkHistoryReviewAcknowledgmentActionSchema
>;

export const WorkHistoryReviewAcknowledgmentSchema = z
  .object({
    id: NonEmptyStringSchema,
    // draftId equality with the parent draft is a service responsibility:
    // contracts may parse cross-draft acknowledgments and no persistence path exists yet.
    draftId: NonEmptyStringSchema,
    profileRecordId: NonEmptyStringSchema,
    kind: WorkHistoryReviewAcknowledgmentKindSchema,
    action: WorkHistoryReviewAcknowledgmentActionSchema,
    messageContentHash: WorkHistoryReviewMessageContentHashSchema,
    reason: WorkHistoryReviewAcknowledgmentReasonSchema,
    acknowledgedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const isHonestPair =
      ((value.kind === "weak_fit" || value.kind === "gap_coverage") &&
        value.action === "consider_showing" &&
        value.reason === "intentional_omission") ||
      (value.kind === "compact_recommended" &&
        value.action === "keep_compact" &&
        value.reason === "intentional_compaction");

    if (!isHonestPair) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message:
          "Acknowledgments require an honest kind/action/reason pair: weak_fit or gap_coverage with consider_showing and intentional_omission, or compact_recommended with keep_compact and intentional_compaction.",
      });
    }
  });
export type WorkHistoryReviewAcknowledgment = z.infer<
  typeof WorkHistoryReviewAcknowledgmentSchema
>;

export const WorkHistoryReviewAcknowledgmentsFieldSchema = z
  .array(WorkHistoryReviewAcknowledgmentSchema)
  .max(100)
  .default([]);

/**
 * The model's verdict on one resume line, kept with the draft so every check
 * of the same wording reuses it (ADR 0041). Keyed by the normalized-content
 * hash; reworded lines are checked again.
 */
export const ResumeClaimCheckSchema = z.object({
  contentHash: NonEmptyStringSchema,
  verdict: z.enum(["supported", "stretch", "unsupported"]),
  reason: z.string().default(""),
  evidenceIds: z.array(NonEmptyStringSchema).default([]),
  /**
   * The checker's fix for a line it did not pass: the line rewritten to claim
   * only what the evidence backs, or "" when nothing in it can be kept. Null
   * when the line passed or no fix was given.
   */
  fix: z.string().nullable().default(null),
  /** The checker's note when the line is not finished resume writing. */
  style: z.string().nullable().optional(),
  /**
   * Fingerprint of the evidence and tailoring strength it was checked
   * against; a change to either re-checks.
   */
  evidenceKey: NonEmptyStringSchema.nullable().default(null),
  checkedAt: IsoDateTimeSchema,
});
export type ResumeClaimCheck = z.infer<typeof ResumeClaimCheckSchema>;

export const ResumeBatchCheckpointSchema = z.object({
  /** A provider access rejection pauses new work without completing the queue. */
  providerBlock: ResumeBatchProviderBlockSchema.optional(),
  id: NonEmptyStringSchema,
  jobIds: z.array(NonEmptyStringSchema),
  activeJobIds: z.array(NonEmptyStringSchema),
  completedJobIds: z.array(NonEmptyStringSchema),
  done: z.boolean(),
  stopRequested: z.boolean(),
  requests: z
    .array(
      z.object({
        jobId: NonEmptyStringSchema,
        regenerate: z.boolean().optional(),
        level: z.enum(["light", "tailored", "aggressive"]).optional(),
        language: NonEmptyStringSchema.optional(),
      }),
    )
    .optional(),
  durationsMs: z.array(z.number().nonnegative().finite()).optional(),
  resumedBatchIds: z.array(NonEmptyStringSchema).optional(),
  /** Liveness is rederived from this process before a saved receipt is displayed. */
  running: z.boolean().optional(),
});
export type ResumeBatchCheckpoint = z.infer<typeof ResumeBatchCheckpointSchema>;

export const ResumeLanguageTranslationSchema = z.object({
  language: NonEmptyStringSchema,
  listingLanguage: NonEmptyStringSchema.nullable().optional(),
  translations: z.array(
    z.object({ id: NonEmptyStringSchema, text: NonEmptyStringSchema }),
  ),
});

export const ResumeDraftSchema = z.object({
  id: NonEmptyStringSchema,
  jobId: NonEmptyStringSchema,
  status: ResumeDraftStatusSchema,
  templateId: ResumeTemplateIdSchema,
  /** Null follows the listing language; a value is the person’s choice. */
  language: NonEmptyStringSchema.nullable().optional(),
  writtenLanguage: NonEmptyStringSchema.nullable().optional(),
  listingLanguage: NonEmptyStringSchema.nullable().optional(),
  identity: ResumeDraftIdentitySchema.nullable().default(null),
  sections: z.array(ResumeDraftSectionSchema).default([]),
  targetPageCount: z.number().int().min(1).max(3).default(2),
  generationMethod: ResumeDraftGenerationMethodSchema.nullable().default(null),
  approvedAt: IsoDateTimeSchema.nullable().default(null),
  approvedExportId: NonEmptyStringSchema.nullable().default(null),
  staleReason: NonEmptyStringSchema.nullable().default(null),
  workHistoryReviewAcknowledgments: WorkHistoryReviewAcknowledgmentsFieldSchema,
  issueApprovals: ResumeIssueApprovalsFieldSchema,
  claimChecks: z.array(ResumeClaimCheckSchema).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type ResumeDraft = z.output<typeof ResumeDraftSchema>;

export const ResumeDraftPatchSchema = z.object({
  id: NonEmptyStringSchema,
  draftId: NonEmptyStringSchema,
  operation: ResumeDraftPatchOperationSchema,
  targetSectionId: NonEmptyStringSchema,
  targetEntryId: NonEmptyStringSchema.nullable().default(null),
  anchorEntryId: NonEmptyStringSchema.nullable().default(null),
  targetBulletId: NonEmptyStringSchema.nullable().default(null),
  anchorBulletId: NonEmptyStringSchema.nullable().default(null),
  position: z.enum(["before", "after"]).nullable().default(null),
  newText: NonEmptyStringSchema.nullable().default(null),
  newIncluded: z.boolean().nullable().default(null),
  newLocked: z.boolean().nullable().default(null),
  newBullets: z.array(ResumeDraftBulletSchema).nullable().default(null),
  appliedAt: IsoDateTimeSchema,
  origin: ResumeDraftPatchOriginSchema,
  conflictReason: NonEmptyStringSchema.nullable().default(null),
});
export type ResumeDraftPatch = z.output<typeof ResumeDraftPatchSchema>;

export const ResumeDraftRevisionActorSchema = z.enum([
  "user",
  "assistant",
  "system",
  "restore",
]);
export type ResumeDraftRevisionActor = z.infer<
  typeof ResumeDraftRevisionActorSchema
>;

export const ResumeDraftRevisionMutationKindSchema = z.enum([
  "manual_patch",
  "manual_save",
  "assistant_patch",
  "regenerate_draft",
  "regenerate_section",
  "restore",
]);
export type ResumeDraftRevisionMutationKind = z.infer<
  typeof ResumeDraftRevisionMutationKindSchema
>;

export const ResumeDraftRevisionDiffSchema = z.object({
  templateChanged: z.boolean().default(false),
  identityChanged: z.boolean().default(false),
  sectionOrderChanged: z.boolean().default(false),
  addedSectionIds: z.array(NonEmptyStringSchema).max(100).default([]),
  removedSectionIds: z.array(NonEmptyStringSchema).max(100).default([]),
  changedSectionIds: z.array(NonEmptyStringSchema).max(100).default([]),
});
export type ResumeDraftRevisionDiff = z.infer<
  typeof ResumeDraftRevisionDiffSchema
>;

export const ResumeDraftRevisionSchema = z.object({
  id: NonEmptyStringSchema,
  draftId: NonEmptyStringSchema,
  parentRevisionId: NonEmptyStringSchema.nullable().default(null),
  actor: ResumeDraftRevisionActorSchema.default("system"),
  mutationKind: ResumeDraftRevisionMutationKindSchema.default("manual_patch"),
  snapshotDraft: ResumeDraftSchema.nullable().default(null),
  snapshotIdentity: ResumeDraftIdentitySchema.nullable().default(null),
  snapshotSections: z.array(ResumeDraftSectionSchema),
  beforeHash: NonEmptyStringSchema.nullable().default(null),
  afterHash: NonEmptyStringSchema.nullable().default(null),
  diff: ResumeDraftRevisionDiffSchema.nullable().default(null),
  restoredFromRevisionId: NonEmptyStringSchema.nullable().default(null),
  createdAt: IsoDateTimeSchema,
  reason: NonEmptyStringSchema.nullable().default(null),
});
export type ResumeDraftRevision = z.infer<typeof ResumeDraftRevisionSchema>;
export const ResumeValidationIssueSchema = z.object({
  id: NonEmptyStringSchema,
  severity: ResumeValidationSeveritySchema,
  category: ResumeValidationCategorySchema,
  sectionId: NonEmptyStringSchema.nullable().default(null),
  entryId: NonEmptyStringSchema.nullable().default(null),
  bulletId: NonEmptyStringSchema.nullable().default(null),
  message: NonEmptyStringSchema,
  // The exact sentence the deterministic classifier flagged, when the issue
  // came from one. Blockers can then name the text a user must rewrite or
  // restore instead of only naming a locator. Optional so historical issues
  // and non-claim issues stay valid without a synthetic value.
  flaggedText: NonEmptyStringSchema.nullable().optional(),
});
export type ResumeValidationIssue = z.infer<typeof ResumeValidationIssueSchema>;

/**
 * The severity an issue is treated and shown with. Length is a quiet note,
 * never a blocker (ADR 0051), but drafts checked before that decision still
 * carry page overflow saved as an error, which held their approval back
 * behind a red "Blocks approval" box.
 */
export function getResumeValidationIssueSeverity(
  issue: Pick<ResumeValidationIssue, "severity"> & {
    category?: ResumeValidationCategory;
  },
): ResumeValidationSeverity {
  return issue.category === "page_overflow" ? "info" : issue.severity;
}

export function isBlockingResumeValidationIssue(
  issue: Pick<ResumeValidationIssue, "severity"> & {
    category?: ResumeValidationCategory;
  },
): boolean {
  return getResumeValidationIssueSeverity(issue) === "error";
}

/**
 * Whether an assessment comes from a verifier whose verdicts still stand:
 * the model's fact check, or the last deterministic verifier for claims
 * assessed before it (ADR 0041). Older verdicts must be checked again.
 */
export function isCurrentResumeClaimVerifier(
  verifier: ResumeClaimVerifier,
): boolean {
  return (
    verifier === "model_fact_check_v1" ||
    verifier === "deterministic_candidate_evidence_v2"
  );
}

export function isGeneratedResumeClaimOrigin(
  origin: ResumeDraftOrigin,
): boolean {
  return (
    origin === "ai_generated" ||
    origin === "assistant_edited" ||
    origin === "deterministic_fallback"
  );
}

/**
 * The single deterministic rule that decides whether one assessed claim blocks
 * export/approval. Every layer that judges grounded-ness — the export/approval
 * validator, the Resume Studio blocker surfaces, and the Guided Edits proposal
 * gate — must call this exact function so a proposal can never be presented as
 * grounded while the export gate would reject the same text.
 *
 * Only a generated line the saved evidence contradicts can hold a resume
 * back, and generation settles those itself (it puts back the person's
 * wording or leaves the line off). The person's own lines are theirs, a
 * stretch was accepted by choosing Aggressive (ADR 0018), and a line the
 * AI could not check yet does not wait on the person.
 */
export function isBlockingResumeClaimAssessment(input: {
  assessment: Pick<ResumeClaimAssessment, "claimOrigin" | "status">;
}): boolean {
  return (
    input.assessment.status === "unsupported" &&
    isGeneratedResumeClaimOrigin(input.assessment.claimOrigin)
  );
}

/**
 * Whether a person may approve this claim as accurate instead of rewriting
 * it: any claim the current verifier would otherwise block. Only an
 * assessment from an older verifier is not approvable, because it must be
 * re-checked first.
 */
export function isResumeClaimAssessmentApprovable(
  assessment: Pick<
    ResumeClaimAssessment,
    "claimOrigin" | "status" | "verifier"
  >,
): boolean {
  if (!isCurrentResumeClaimVerifier(assessment.verifier)) {
    return false;
  }
  return (
    assessment.status === "confirm_needed" ||
    assessment.status === "unsupported" ||
    (assessment.status === "review" &&
      isGeneratedResumeClaimOrigin(assessment.claimOrigin))
  );
}

export const resumeCoverageRoleStatusValues = [
  "unchanged",
  "rewritten",
  "compacted",
  "hidden",
  "missing",
] as const;
export const ResumeCoverageRoleStatusSchema = z.enum(
  resumeCoverageRoleStatusValues,
);
export type ResumeCoverageRoleStatus = z.infer<
  typeof ResumeCoverageRoleStatusSchema
>;

export const ResumeCoverageClaimChangeSchema = z.object({
  field: z.enum(["summary", "bullet"]),
  sourceAchievementIds: z.array(NonEmptyStringSchema).optional(),
  text: NonEmptyStringSchema,
  restorable: z.boolean().default(false),
});
export type ResumeCoverageClaimChange = z.infer<
  typeof ResumeCoverageClaimChangeSchema
>;

export const ResumeCoverageRoleComparisonSchema = z.object({
  profileRecordId: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  employer: NonEmptyStringSchema,
  sectionId: NonEmptyStringSchema.nullable().default(null),
  entryId: NonEmptyStringSchema.nullable().default(null),
  status: ResumeCoverageRoleStatusSchema,
  included: z.boolean(),
  reordered: z.boolean().default(false),
  originalIndex: z.number().int().min(0),
  tailoredIndex: z.number().int().min(0).nullable().default(null),
  originalClaimCount: z.number().int().min(0),
  retainedClaimCount: z.number().int().min(0),
  addedClaims: z.array(ResumeCoverageClaimChangeSchema).default([]),
  removedClaims: z.array(ResumeCoverageClaimChangeSchema).default([]),
  reasons: z.array(NonEmptyStringSchema).default([]),
});
export type ResumeCoverageRoleComparison = z.infer<
  typeof ResumeCoverageRoleComparisonSchema
>;

export const ResumeCoverageComparisonSchema = z.object({
  originalRoleCount: z.number().int().min(0),
  representedRoleCount: z.number().int().min(0),
  visibleRoleCount: z.number().int().min(0),
  rewrittenRoleCount: z.number().int().min(0),
  compactedRoleCount: z.number().int().min(0),
  hiddenRoleCount: z.number().int().min(0),
  missingRoleCount: z.number().int().min(0),
  reorderedRoleCount: z.number().int().min(0),
  addedClaimCount: z.number().int().min(0),
  removedClaimCount: z.number().int().min(0),
  duplicateIssueCount: z.number().int().min(0),
  addedKeywords: z.array(NonEmptyStringSchema).default([]),
  removedKeywords: z.array(NonEmptyStringSchema).default([]),
  pageImpact: z.enum(["within_target", "over_target", "unknown"]),
  pageCount: z.number().int().min(0).nullable().default(null),
  targetPageCount: z.number().int().min(1).max(3),
  roles: z.array(ResumeCoverageRoleComparisonSchema).default([]),
});
export type ResumeCoverageComparison = z.infer<
  typeof ResumeCoverageComparisonSchema
>;

export const ResumeValidationResultSchema = z.object({
  id: NonEmptyStringSchema,
  draftId: NonEmptyStringSchema,
  issues: z.array(ResumeValidationIssueSchema).default([]),
  draftContentHash: NonEmptyStringSchema.nullable().default(null),
  claimAssessments: z.array(ResumeClaimAssessmentSchema).default([]),
  coverageComparison: ResumeCoverageComparisonSchema.nullable().default(null),
  pageCount: z.number().int().min(0).nullable().default(null),
  validatedAt: IsoDateTimeSchema,
});
export type ResumeValidationResult = z.infer<
  typeof ResumeValidationResultSchema
>;

export const resumePreviewWarningSourceValues = [
  "validation",
  "render",
] as const;

export const ResumePreviewWarningSourceSchema = z.enum(
  resumePreviewWarningSourceValues,
);
export type ResumePreviewWarningSource = z.infer<
  typeof ResumePreviewWarningSourceSchema
>;

export const ResumePreviewWarningSchema = z.object({
  id: NonEmptyStringSchema,
  source: ResumePreviewWarningSourceSchema,
  severity: ResumeValidationSeveritySchema,
  category: ResumeValidationCategorySchema.nullable().default(null),
  sectionId: NonEmptyStringSchema.nullable().default(null),
  entryId: NonEmptyStringSchema.nullable().default(null),
  bulletId: NonEmptyStringSchema.nullable().default(null),
  message: NonEmptyStringSchema,
});
export type ResumePreviewWarning = z.infer<typeof ResumePreviewWarningSchema>;

export const ResumePreviewMetadataSchema = z.object({
  templateId: ResumeTemplateIdSchema,
  renderedAt: IsoDateTimeSchema,
  pageCount: z.number().int().min(1).nullable().default(null),
  sectionCount: z.number().int().nonnegative().default(0),
  entryCount: z.number().int().nonnegative().default(0),
});
export type ResumePreviewMetadata = z.infer<typeof ResumePreviewMetadataSchema>;

export const ResumePreviewSchema = z.object({
  draftId: NonEmptyStringSchema,
  revisionKey: NonEmptyStringSchema,
  html: NonEmptyStringSchema,
  warnings: z.array(ResumePreviewWarningSchema).default([]),
  metadata: ResumePreviewMetadataSchema,
});
export type ResumePreview = z.infer<typeof ResumePreviewSchema>;

export const ResumeResearchArtifactSchema = z.object({
  id: NonEmptyStringSchema,
  jobId: NonEmptyStringSchema,
  sourceUrl: NonEmptyStringSchema,
  pageTitle: NonEmptyStringSchema.nullable().default(null),
  fetchedAt: IsoDateTimeSchema,
  extractedText: NonEmptyStringSchema.nullable().default(null),
  companyNotes: NonEmptyStringSchema.nullable().default(null),
  domainVocabulary: z.array(NonEmptyStringSchema).default([]),
  priorityThemes: z.array(NonEmptyStringSchema).default([]),
  fetchStatus: ResumeResearchFetchStatusSchema,
});
export type ResumeResearchArtifact = z.infer<
  typeof ResumeResearchArtifactSchema
>;

export const ResumeExportArtifactSchema = z.object({
  id: NonEmptyStringSchema,
  draftId: NonEmptyStringSchema,
  jobId: NonEmptyStringSchema,
  format: ResumeExportFormatSchema,
  filePath: NonEmptyStringSchema,
  sha256: z
    .string()
    .regex(
      /^[a-f0-9]{64}$/i,
      "Resume SHA-256 must be 64 hexadecimal characters.",
    )
    .nullable()
    .optional(),
  pageCount: z.number().int().min(1).nullable().default(null),
  templateId: ResumeTemplateIdSchema,
  exportedAt: IsoDateTimeSchema,
  isApproved: z.boolean().default(false),
});
export type ResumeExportArtifact = z.infer<typeof ResumeExportArtifactSchema>;

export const ResumeAssistantProposalStatusSchema = z.enum([
  "none",
  "pending",
  "accepted",
  "rejected",
]);
export type ResumeAssistantProposalStatus = z.infer<
  typeof ResumeAssistantProposalStatusSchema
>;

/**
 * One export-gate blocker the proposed wording would introduce, produced by
 * running the same deterministic classifier the export/approval validator uses
 * against the draft that would result from accepting the proposal.
 */
export const ResumeProposalApprovalBlockerSchema = z.object({
  patchId: NonEmptyStringSchema.nullable().default(null),
  sectionId: NonEmptyStringSchema.nullable().default(null),
  entryId: NonEmptyStringSchema.nullable().default(null),
  bulletId: NonEmptyStringSchema.nullable().default(null),
  flaggedText: NonEmptyStringSchema.nullable().default(null),
  message: NonEmptyStringSchema,
  // `needs_confirmation`: a stretch the person keeps or removes under Lines to
  // confirm after accepting. `unsupported` (and absent, on older messages):
  // the saved evidence does not back the wording, so it blocks approval until
  // it is rewritten or approved as accurate.
  kind: z.enum(["needs_confirmation", "unsupported"]).optional(),
});
export type ResumeProposalApprovalBlocker = z.infer<
  typeof ResumeProposalApprovalBlockerSchema
>;

export const ResumeAssistantMessageSchema = z.object({
  id: NonEmptyStringSchema,
  jobId: NonEmptyStringSchema,
  role: ResumeAssistantRoleSchema,
  content: NonEmptyStringSchema,
  patches: z.array(ResumeDraftPatchSchema).default([]),
  // Empty means the export gate accepted the proposed wording; non-empty means
  // accepting this proposal would block approval until the text is rewritten.
  approvalBlockers: z.array(ResumeProposalApprovalBlockerSchema).optional(),
  proposalStatus: ResumeAssistantProposalStatusSchema.default("none"),
  baseDraftUpdatedAt: IsoDateTimeSchema.nullable().default(null),
  resolvedPatchIds: z.array(NonEmptyStringSchema).default([]),
  resolvedAt: IsoDateTimeSchema.nullable().default(null),
  proposalError: NonEmptyStringSchema.nullable().default(null),
  executionAttribution: AgentTaskMessageAttributionSchema.nullable().optional(),
  createdAt: IsoDateTimeSchema,
});
export type ResumeAssistantMessage = z.infer<
  typeof ResumeAssistantMessageSchema
>;

export const ResumeDraftSummarySchema = ResumeDraftSchema.pick({
  id: true,
  jobId: true,
  status: true,
  templateId: true,
  targetPageCount: true,
  generationMethod: true,
  approvedAt: true,
  approvedExportId: true,
  staleReason: true,
  createdAt: true,
  updatedAt: true,
});
export type ResumeDraftSummary = z.infer<typeof ResumeDraftSummarySchema>;

export const ResumeExportArtifactSummarySchema =
  ResumeExportArtifactSchema.pick({
    id: true,
    draftId: true,
    jobId: true,
    format: true,
    filePath: true,
    sha256: true,
    pageCount: true,
    templateId: true,
    exportedAt: true,
    isApproved: true,
  }).extend({
    sha256: ResumeExportArtifactSchema.shape.sha256.default(null),
  });
export type ResumeExportArtifactSummary = z.infer<
  typeof ResumeExportArtifactSummarySchema
>;

export const ResumeResearchArtifactSummarySchema =
  ResumeResearchArtifactSchema.pick({
    id: true,
    jobId: true,
    sourceUrl: true,
    pageTitle: true,
    fetchedAt: true,
    fetchStatus: true,
    domainVocabulary: true,
    priorityThemes: true,
  });
export type ResumeResearchArtifactSummary = z.infer<
  typeof ResumeResearchArtifactSummarySchema
>;

/**
 * Two completed resumes establish an observed average or measured queue
 * throughput. With `inFlight` known, the rest is counted in waves of that
 * many resumes written side by side: ten at once finish together, not one
 * after another.
 */
export function estimateResumeBatchMinutesLeft(
  durationsMs: readonly number[],
  remainingCount: number,
  observed?: { elapsedMs: number; completedCount: number },
  inFlight?: number,
): number | null {
  if (durationsMs.length < 2 || remainingCount <= 0) return null;
  if (inFlight !== undefined && inFlight > 0) {
    const average =
      durationsMs.reduce((sum, duration) => sum + duration, 0) /
      durationsMs.length;
    const waves = Math.ceil(remainingCount / inFlight);
    return Math.max(1, Math.ceil((average * waves) / 60_000));
  }
  if (observed && observed.completedCount >= 2 && observed.elapsedMs > 0)
    return Math.max(
      1,
      Math.ceil(
        ((observed.elapsedMs / observed.completedCount) * remainingCount) /
          60_000,
      ),
    );
  const average =
    durationsMs.reduce((sum, duration) => sum + duration, 0) /
    durationsMs.length;
  return Math.max(
    1,
    Math.ceil((average * Math.ceil(remainingCount / 2)) / 60_000),
  );
}

/** Older translated fields have no original wording to compare against. */
export function resumeComparisonNeedsRefresh(draft: ResumeDraft): boolean {
  if (!draft.writtenLanguage) return Boolean(draft.language);
  return draft.sections.some(
    (section) =>
      section.included &&
      (section.kind === "skills" ||
        section.kind === "keywords" ||
        section.kind === "certifications") &&
      ((!!section.text && section.sourceRefs.length === 0) ||
        section.bullets.some(
          (bullet) =>
            bullet.included && !!bullet.text && bullet.sourceRefs.length === 0,
        ) ||
        section.entries.some(
          (entry) =>
            entry.included &&
            entry.sourceRefs.length === 0 &&
            (!!entry.title ||
              !!entry.summary ||
              entry.bullets.some((bullet) => bullet.included && !!bullet.text)),
        )),
  );
}
