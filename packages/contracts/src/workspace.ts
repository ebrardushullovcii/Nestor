import { PreparedApplicationFormSchema } from "./prepared-application-form";
import { z } from "zod";

import {
  AiProviderKindSchema,
  AppearanceThemeSchema,
  BrowserRunWaitReasonSchema,
  BrowserDriverSchema,
  BrowserSessionStatusSchema,
  DocumentFontPresetSchema,
  DocumentFormatSchema,
  DiscoveryRunStateSchema,
  IsoDateTimeSchema,
  JobSourceSchema,
  NonEmptyStringSchema,
  ResumeApplicationModeSchema,
  ResumeTemplateIdSchema,
  SourceAccessPromptStateSchema,
  SourceDebugPhaseSchema,
  TailoringModeSchema,
} from "./base";
import { ApplicationCrmSettingsSchema } from "./application-crm";
import {
  ApplyJobResultSchema,
  ApplyJobResultSummarySchema,
  ApplyJobResultListRowSchema,
  ApplyRunSchema,
  ApplyRunSummarySchema,
  ApplySubmitApprovalSchema,
  ApplicationAnswerRecordSchema,
  ApplicationArtifactRefSchema,
  ApplicationConsentRequestSchema,
  ApplicationQuestionRecordSchema,
  ApplicationReplayCheckpointSchema,
} from "./apply";
import {
  ApplicationAttestationKindSchema,
  ApplicationAutomationModeSchema,
  ApplicationApplyModeSchema,
  ApplicationSalaryDisclosureRuleSchema,
  ApplicationAuthorityEnvelopeSchema,
  SubmissionArmedMarkerSchema,
  SubmissionExecutionGrantSchema,
  SubmissionIdempotencyRecordSchema,
  SubmissionOutcomeRecordSchema,
  SubmissionPreflightRecordSchema,
} from "./application-authority";
import type { ApplicationAttestationKind } from "./application-authority";
import { ApprovedApplicationAnswerSnapshotSchema } from "./application-answer-snapshot";
import {
  ApplicationAttemptSchema,
  ApplicationRecordSchema,
  DiscoveryLedgerEntrySchema,
  DiscoveryJobViewSchema,
  JobListRowSchema,
  DiscoveryFeedbackReasonSchema,
  DiscoveryAdapterSessionStateSchema,
  DiscoveryRunRecordSchema,
  JobSearchPreferencesSchema,
  ReviewQueueItemSchema,
  SavedJobSchema,
  TailoredAssetSchema,
  TailoredAssetSummarySchema,
  ApplicationAttemptListRowSchema,
} from "./discovery";
import { CandidateProfileSchema } from "./profile";
import {
  ProfileSetupReviewActionOptionsSchema,
  ProfileSetupReviewActionSchema,
  ProfileSetupStateSchema,
} from "./profile-setup";
import {
  ProfileCopilotContextSchema,
  ProfileCopilotMessageSchema,
  ProfileRevisionSchema,
  ProfileRevisionSummarySchema,
} from "./profile-copilot";
import {
  ResumeAssistantMessageSchema,
  ResumeClaimContentHashSchema,
  ResumeClaimFieldSchema,
  ResumeClaimOwnershipStatementSchema,
  ResumeDraftPatchSchema,
  ResumeDraftRevisionSchema,
  ResumeDraftSchema,
  ResumePreviewSchema,
  ResumeDraftSummarySchema,
  ResumeExportArtifactSchema,
  ResumeExportArtifactSummarySchema,
  ResumeResearchArtifactSchema,
  ResumeResearchArtifactSummarySchema,
  ResumeValidationResultSchema,
  WorkHistoryReviewAcknowledgmentActionSchema,
  WorkHistoryReviewAcknowledgmentKindSchema,
  WorkHistoryReviewAcknowledgmentReasonSchema,
  WorkHistoryReviewMessageContentHashSchema,
  WorkHistoryReviewSuggestionSchema,
} from "./resume";
import {
  EditableSourceInstructionArtifactSchema,
  SourceDebugEvidenceRefSchema,
  SourceDebugRunRecordSchema,
  SourceDebugWorkerAttemptSchema,
  SourceInstructionArtifactSchema,
} from "./source-debug";
import {
  ResumeDocumentBundleSchema,
  ResumeImportFieldCandidateSchema,
  ResumeImportFieldCandidateSummarySchema,
  ResumeImportRunSchema,
  ResumeTimelineRepairActionSchema,
} from "./resume-import";
import { UserActionEventSchema, UserActionRequestSchema } from "./user-action";
import {
  JobFinderActivityControlSchema,
  JobFinderDashboardSummarySchema,
  JobSearchCampaignSchema,
} from "./job-search-campaigns";
import { CampaignNotificationSchema } from "./campaign-operations";
import {
  JobFinderIntelligenceStateSchema } from "./job-finder-intelligence";
import { ApplyQueueSchema } from "./apply-queue";

export const JobFinderJobActionInputSchema = z.object({
  jobId: NonEmptyStringSchema,
});
export type JobFinderJobActionInput = z.infer<
  typeof JobFinderJobActionInputSchema
>;

/**
 * Moves an unsent application back to Shortlisted: its prepared form closes,
 * nothing is sent, and its history stays. Undo names the job.
 */
export const JobFinderReturnApplicationToShortlistInputSchema = z.object({
  applicationRecordId: NonEmptyStringSchema,
});
export type JobFinderReturnApplicationToShortlistInput = z.infer<
  typeof JobFinderReturnApplicationToShortlistInputSchema
>;

/**
 * Clearing a resume's approval. Undo of an approval names the status the
 * draft had before it, so the resume goes back to To review as it was
 * instead of reading as stale.
 */
export const JobFinderClearResumeApprovalInputSchema =
  JobFinderJobActionInputSchema.extend({
    restoreStatus: z.enum(["draft", "needs_review"]).optional(),
  });
export type JobFinderClearResumeApprovalInput = z.infer<
  typeof JobFinderClearResumeApprovalInputSchema
>;

/** Send for me: the filled-in forms the agent sends, one after another. */
export const JobFinderSendPreparedApplicationsInputSchema = z.object({
  jobIds: z.array(NonEmptyStringSchema).min(1).max(100),
});
export type JobFinderSendPreparedApplicationsInput = z.infer<
  typeof JobFinderSendPreparedApplicationsInputSchema
>;

/** Durable identity of one prepared application page. */
export const JobFinderPreparedApplicationPageInputSchema = z.object({
  runId: NonEmptyStringSchema,
  jobId: NonEmptyStringSchema,
  resultId: NonEmptyStringSchema,
  applicationRecordId: NonEmptyStringSchema,
});
export type JobFinderPreparedApplicationPageInput = z.infer<
  typeof JobFinderPreparedApplicationPageInputSchema
>;

export const ResumePdfExportIntentSchema = z.enum(["approval", "download"]);
export type ResumePdfExportIntent = z.infer<typeof ResumePdfExportIntentSchema>;

export const JobFinderExportResumePdfInputSchema =
  JobFinderJobActionInputSchema.extend({
    intent: ResumePdfExportIntentSchema.default("download"),
  });
export type JobFinderExportResumePdfInput = z.infer<
  typeof JobFinderExportResumePdfInputSchema
>;

export const JobFinderJobResumeApplicationModeInputSchema =
  JobFinderJobActionInputSchema.extend({
    resumeApplicationMode: ResumeApplicationModeSchema,
    /** Per-job tailoring level; omitted keeps the job's current level. */
    resumeTailoringMode: TailoringModeSchema.nullable().optional(),
  });
export type JobFinderJobResumeApplicationModeInput = z.infer<
  typeof JobFinderJobResumeApplicationModeInputSchema
>;

export const JobFinderDismissDiscoveryJobInputSchema = z
  .object({
    jobId: NonEmptyStringSchema,
    reasons: z.array(DiscoveryFeedbackReasonSchema).max(9),
    action: z.enum(["hide_job", "hide_and_exclude_employer"]).optional(),
    expectedNormalizedCompanyName: NonEmptyStringSchema.nullish(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.action === "hide_and_exclude_employer" &&
      input.expectedNormalizedCompanyName == null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedNormalizedCompanyName"],
        message:
          "Employer exclusion requires the previewed normalized company name.",
      });
    }
  });
export type JobFinderDismissDiscoveryJobInput = z.infer<
  typeof JobFinderDismissDiscoveryJobInputSchema
>;

export const employerExclusionUnavailableReasonValues = [
  "missing_or_generic_company",
  "ambiguous_company_name",
  "ambiguous_employer_domain",
  "company_name_domain_conflict",
  "pending_company_merge",
  "provider_domain_only",
  "company_whitelisted",
] as const;
export const EmployerExclusionUnavailableReasonSchema = z.enum(
  employerExclusionUnavailableReasonValues,
);
export type EmployerExclusionUnavailableReason = z.infer<
  typeof EmployerExclusionUnavailableReasonSchema
>;

export const EmployerExclusionPreviewSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("available"),
      jobId: NonEmptyStringSchema,
      displayCompanyName: NonEmptyStringSchema,
      normalizedCompanyName: NonEmptyStringSchema,
      employerDomain: NonEmptyStringSchema.nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      jobId: NonEmptyStringSchema,
      reason: EmployerExclusionUnavailableReasonSchema,
      employerDomain: NonEmptyStringSchema.nullable(),
    })
    .strict(),
]);
export type EmployerExclusionPreview = z.infer<
  typeof EmployerExclusionPreviewSchema
>;

export const RemoveEmployerExclusionInputSchema = z
  .object({
    jobId: NonEmptyStringSchema,
    normalizedCompanyName: NonEmptyStringSchema,
  })
  .strict();
export type RemoveEmployerExclusionInput = z.infer<
  typeof RemoveEmployerExclusionInputSchema
>;

export const JobFinderApplicationTargetSchema = z
  .object({
    jobId: NonEmptyStringSchema,
    applicationRecordId: NonEmptyStringSchema.optional(),
  })
  .strict();
export type JobFinderApplicationTarget = z.infer<
  typeof JobFinderApplicationTargetSchema
>;

export const JobFinderExactApplicationTargetSchema = z
  .object({
    jobId: NonEmptyStringSchema,
    applicationRecordId: NonEmptyStringSchema,
  })
  .strict();
export type JobFinderExactApplicationTarget = z.infer<
  typeof JobFinderExactApplicationTargetSchema
>;

const JobFinderApplicationStartTargetShape = {
  jobId: NonEmptyStringSchema,
  applicationRecordId: NonEmptyStringSchema.optional(),
  startNewApplication: z.boolean().optional(),
} satisfies z.ZodRawShape;

export const JobFinderApplicationStartTargetSchema = z
  .object(JobFinderApplicationStartTargetShape)
  .strict()
  .superRefine((input, context) => {
    if (input.startNewApplication && input.applicationRecordId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["applicationRecordId"],
        message:
          "Starting a new application cannot also target an existing application record.",
      });
    }
  });
export type JobFinderApplicationStartTarget = z.infer<
  typeof JobFinderApplicationStartTargetSchema
>;

export const JobFinderApplyCopilotActionInputSchema = z
  .object({
    ...JobFinderApplicationStartTargetShape,
    visualCheckpointsEnabled: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.startNewApplication && input.applicationRecordId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["applicationRecordId"],
        message:
          "Starting a new application cannot also target an existing application record.",
      });
    }
  });
export type JobFinderApplyCopilotActionInput = z.infer<
  typeof JobFinderApplyCopilotActionInputSchema
>;

export const JobFinderApplyQueueActionInputSchema = z.object({
  jobIds: z.array(NonEmptyStringSchema).min(1),
  applicationAutomationMode: ApplicationAutomationModeSchema.optional(),
  salaryDisclosure: ApplicationSalaryDisclosureRuleSchema.optional(),
});
export type JobFinderApplyQueueActionInput = z.infer<
  typeof JobFinderApplyQueueActionInputSchema
>;

export const JobFinderApplicationPacketExportResultSchema = z.object({
  status: z.enum(["saved", "cancelled"]),
});
export type JobFinderApplicationPacketExportResult = z.infer<
  typeof JobFinderApplicationPacketExportResultSchema
>;

export const JobFinderResumeWorkspaceQuerySchema = z.object({
  jobId: NonEmptyStringSchema,
});
export type JobFinderResumeWorkspaceQuery = z.infer<
  typeof JobFinderResumeWorkspaceQuerySchema
>;

export const JobFinderSaveResumeDraftInputSchema = z.object({
  draft: ResumeDraftSchema,
  autosaveSessionId: NonEmptyStringSchema.optional(),
});
export type JobFinderSaveResumeDraftInput = z.infer<
  typeof JobFinderSaveResumeDraftInputSchema
>;

export const JobFinderRestoreResumeDraftRevisionInputSchema = z.object({
  jobId: NonEmptyStringSchema,
  revisionId: NonEmptyStringSchema,
});
export type JobFinderRestoreResumeDraftRevisionInput = z.infer<
  typeof JobFinderRestoreResumeDraftRevisionInputSchema
>;

export const JobFinderPreviewResumeDraftInputSchema = z.object({
  draft: ResumeDraftSchema,
  /** Monotonic renderer-local identity used to supersede stale preview work. */
  requestId: NonEmptyStringSchema.default("resume_preview_legacy"),
});
export type JobFinderPreviewResumeDraftInput = z.infer<
  typeof JobFinderPreviewResumeDraftInputSchema
>;

export const JobFinderResumePreviewModeSchema = z.enum(["ok", "fail_once"]);
export type JobFinderResumePreviewMode = z.infer<
  typeof JobFinderResumePreviewModeSchema
>;

/**
 * The save surfaces supported by the desktop fault-injection hook. A failed
 * save is a first-class product state (dismissable toast, navigation and
 * window-close guards, Settings keeping staged drafts), but a running build
 * offers no way to reach it: the preload bridge is frozen and the workspace
 * file handle is already open, so neither patching nor read-only permissions
 * fails a save. The desktop test API therefore exposes a one-shot,
 * per-surface synthetic failure keyed by these values; it exists only while
 * NESTOR_ENABLE_TEST_API is set and never changes product behavior.
 */
export const jobFinderTestSaveSurfaceValues = [
  "profile",
  "answers",
  "settings",
] as const;
export const JobFinderTestSaveSurfaceSchema = z.enum(
  jobFinderTestSaveSurfaceValues,
);
export type JobFinderTestSaveSurface = z.infer<
  typeof JobFinderTestSaveSurfaceSchema
>;

export const JobFinderResumeSectionActionInputSchema = z.object({
  jobId: NonEmptyStringSchema,
  sectionId: NonEmptyStringSchema,
});
export type JobFinderResumeSectionActionInput = z.infer<
  typeof JobFinderResumeSectionActionInputSchema
>;

export const JobFinderApproveResumeInputSchema = z.object({
  jobId: NonEmptyStringSchema,
  exportId: NonEmptyStringSchema,
});
export type JobFinderApproveResumeInput = z.infer<
  typeof JobFinderApproveResumeInputSchema
>;

export const JobFinderApplyResumePatchInputSchema = z.object({
  patch: ResumeDraftPatchSchema,
  revisionReason: NonEmptyStringSchema.nullable().default(null),
});
export type JobFinderApplyResumePatchInput = z.infer<
  typeof JobFinderApplyResumePatchInputSchema
>;

export const JobFinderResumeAssistantMessageInputSchema = z.object({
  jobId: NonEmptyStringSchema,
  content: NonEmptyStringSchema,
});
export type JobFinderResumeAssistantMessageInput = z.infer<
  typeof JobFinderResumeAssistantMessageInputSchema
>;

export const JobFinderResumeAssistantProposalActionSchema = z.enum([
  "accept",
  "reject",
]);
export const JobFinderResolveResumeAssistantProposalInputSchema = z.object({
  jobId: NonEmptyStringSchema,
  proposalId: NonEmptyStringSchema,
  action: JobFinderResumeAssistantProposalActionSchema,
  patchIds: z.array(NonEmptyStringSchema).default([]),
});
export type JobFinderResolveResumeAssistantProposalInput = z.infer<
  typeof JobFinderResolveResumeAssistantProposalInputSchema
>;

export const JobFinderProfileSetupReviewActionInputSchema = z.object({
  reviewItemId: NonEmptyStringSchema,
  action: ProfileSetupReviewActionSchema,
  options: ProfileSetupReviewActionOptionsSchema.optional(),
});
export type JobFinderProfileSetupReviewActionInput = z.infer<
  typeof JobFinderProfileSetupReviewActionInputSchema
>;

export const JobFinderResumeTimelineRepairActionInputSchema = z.object({
  runId: NonEmptyStringSchema,
  proposalId: NonEmptyStringSchema,
  action: ResumeTimelineRepairActionSchema,
});
export type JobFinderResumeTimelineRepairActionInput = z.infer<
  typeof JobFinderResumeTimelineRepairActionInputSchema
>;

export const JobFinderProfileCopilotMessageInputSchema = z.object({
  content: NonEmptyStringSchema,
  context: ProfileCopilotContextSchema.default({ surface: "general" }),
});
export type JobFinderProfileCopilotMessageInput = z.infer<
  typeof JobFinderProfileCopilotMessageInputSchema
>;

export const JobFinderProfileCopilotPatchGroupActionInputSchema = z.object({
  patchGroupId: NonEmptyStringSchema,
});
export type JobFinderProfileCopilotPatchGroupActionInput = z.infer<
  typeof JobFinderProfileCopilotPatchGroupActionInputSchema
>;

export const JobFinderUndoProfileRevisionInputSchema = z.object({
  revisionId: NonEmptyStringSchema,
});
export type JobFinderUndoProfileRevisionInput = z.infer<
  typeof JobFinderUndoProfileRevisionInputSchema
>;

export const JobFinderSourceDebugActionInputSchema = z.object({
  targetId: NonEmptyStringSchema,
});
export type JobFinderSourceDebugActionInput = z.infer<
  typeof JobFinderSourceDebugActionInputSchema
>;

export const JobFinderOpenBrowserSessionInputSchema = z.object({
  targetId: NonEmptyStringSchema.nullable().default(null),
});
export type JobFinderOpenBrowserSessionInput = z.infer<
  typeof JobFinderOpenBrowserSessionInputSchema
>;

export const JobFinderDiscoveryTargetActionInputSchema = z.object({
  targetId: NonEmptyStringSchema,
});
export type JobFinderDiscoveryTargetActionInput = z.infer<
  typeof JobFinderDiscoveryTargetActionInputSchema
>;

export const JobFinderSourceDebugRunQuerySchema = z.object({
  runId: NonEmptyStringSchema,
});
export type JobFinderSourceDebugRunQuery = z.infer<
  typeof JobFinderSourceDebugRunQuerySchema
>;

export const JobFinderApplyRunDetailsQuerySchema = z
  .object({
    runId: NonEmptyStringSchema,
    jobId: NonEmptyStringSchema,
    applicationRecordId: NonEmptyStringSchema,
  })
  .strict();
export type JobFinderApplyRunDetailsQuery = z.infer<
  typeof JobFinderApplyRunDetailsQuerySchema
>;

export const JobFinderApplyRunActionInputSchema = z
  .object({
    runId: NonEmptyStringSchema,
    jobId: NonEmptyStringSchema,
    applicationRecordId: NonEmptyStringSchema,
  })
  .strict();
export type JobFinderApplyRunActionInput = z.infer<
  typeof JobFinderApplyRunActionInputSchema
>;

export const JobFinderApplyConsentActionInputSchema = z
  .object({
    requestId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    jobId: NonEmptyStringSchema,
    applicationRecordId: NonEmptyStringSchema,
    action: z.enum(["approve", "decline"]),
  })
  .strict();
export type JobFinderApplyConsentActionInput = z.infer<
  typeof JobFinderApplyConsentActionInputSchema
>;

export const JobFinderSourceInstructionActionInputSchema = z.object({
  targetId: NonEmptyStringSchema,
  instructionId: NonEmptyStringSchema,
});
export type JobFinderSourceInstructionActionInput = z.infer<
  typeof JobFinderSourceInstructionActionInputSchema
>;

export const JobFinderSaveSourceInstructionInputSchema = z.object({
  targetId: NonEmptyStringSchema,
  artifact: EditableSourceInstructionArtifactSchema,
});
export type JobFinderSaveSourceInstructionInput = z.infer<
  typeof JobFinderSaveSourceInstructionInputSchema
>;

/**
 * The one name this product uses for the separate browser window Job Finder
 * drives, without an article, for labels and headings that carry none.
 *
 * It lives here — beside the session state it names — because both the desktop
 * renderer and `@nestor/job-finder` write user-facing copy about that
 * window, and a review found the same window called four different things
 * across four screens. Contracts is the one package both already depend on, so
 * this is the only place the label can exist once. Every derived form ("the
 * Job Finder browser", "Open the Job Finder browser", …) is composed from it in
 * the desktop copy module; nothing should re-spell the words here.
 */
export const JOB_FINDER_BROWSER_LABEL = "Job Finder browser";

export const BrowserSessionStateSchema = z.object({
  source: JobSourceSchema,
  status: BrowserSessionStatusSchema,
  driver: BrowserDriverSchema.default("catalog_seed"),
  label: NonEmptyStringSchema,
  detail: NonEmptyStringSchema.nullable(),
  lastCheckedAt: IsoDateTimeSchema,
});
export type BrowserSessionState = z.infer<typeof BrowserSessionStateSchema>;

export const SourceAccessPromptSchema = z.object({
  targetId: NonEmptyStringSchema,
  targetLabel: NonEmptyStringSchema,
  targetUrl: NonEmptyStringSchema,
  state: SourceAccessPromptStateSchema,
  summary: NonEmptyStringSchema,
  detail: NonEmptyStringSchema.nullable().default(null),
  actionLabel: NonEmptyStringSchema,
  rerunLabel: NonEmptyStringSchema.nullable().default(null),
  updatedAt: IsoDateTimeSchema,
});
export type SourceAccessPrompt = z.infer<typeof SourceAccessPromptSchema>;

export const AgentProviderStatusSchema = z.object({
  kind: AiProviderKindSchema,
  role: z.enum(["chat", "vision", "embedding", "stt"]).default("chat"),
  ready: z.boolean(),
  label: NonEmptyStringSchema,
  model: NonEmptyStringSchema.nullable().default(null),
  baseUrl: NonEmptyStringSchema.nullable().default(null),
  modelContextWindowTokens: z
    .number()
    .int()
    .positive()
    .nullable()
    .default(null),
  reservedHeadroomTokens: z.number().int().positive().nullable().default(null),
  requestTimeoutMs: z.number().int().positive().nullable().default(null),
  detail: NonEmptyStringSchema.nullable().default(null),
});
export type AgentProviderStatus = z.infer<typeof AgentProviderStatusSchema>;

export const ResumeTemplateDeliveryLaneSchema = z.enum([
  "apply_safe",
  "share_ready",
]);
export type ResumeTemplateDeliveryLane = z.infer<
  typeof ResumeTemplateDeliveryLaneSchema
>;

export const ResumeTemplateAtsConfidenceSchema = z.enum([
  "high",
  "medium",
  "low",
]);
export type ResumeTemplateAtsConfidence = z.infer<
  typeof ResumeTemplateAtsConfidenceSchema
>;

export const ResumeTemplateDefinitionSchema = z.object({
  id: ResumeTemplateIdSchema,
  label: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  familyId: NonEmptyStringSchema.optional(),
  familyLabel: NonEmptyStringSchema.optional(),
  familyDescription: NonEmptyStringSchema.optional(),
  variantLabel: NonEmptyStringSchema.optional(),
  deliveryLane: ResumeTemplateDeliveryLaneSchema.optional(),
  atsConfidence: ResumeTemplateAtsConfidenceSchema.optional(),
  fitSummary: NonEmptyStringSchema.nullable().optional(),
  avoidSummary: NonEmptyStringSchema.nullable().optional(),
  bestFor: z.array(NonEmptyStringSchema).default([]),
  visualTags: z.array(NonEmptyStringSchema).optional(),
  density: z.enum(["comfortable", "balanced", "compact"]),
  applyEligible: z.boolean().optional(),
  approvalEligible: z.boolean().optional(),
  benchmarkEligible: z.boolean().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
});
export type ResumeTemplateDefinition = z.infer<
  typeof ResumeTemplateDefinitionSchema
>;

export function getResumeTemplateFamilyId(
  template: Pick<ResumeTemplateDefinition, "familyId" | "id">,
): string {
  return template.familyId ?? template.id;
}

export function getResumeTemplateFamilyLabel(
  template: Pick<ResumeTemplateDefinition, "familyLabel" | "label">,
): string {
  return template.familyLabel ?? template.label;
}

export function getResumeTemplateVariantLabel(
  template: Pick<ResumeTemplateDefinition, "variantLabel" | "label">,
): string {
  return template.variantLabel ?? template.label;
}

export function getResumeTemplateVisualTags(
  template: Pick<ResumeTemplateDefinition, "visualTags" | "bestFor">,
): readonly string[] {
  return template.visualTags ?? template.bestFor;
}

export function getResumeTemplateDeliveryLane(
  template: Pick<ResumeTemplateDefinition, "deliveryLane">,
): ResumeTemplateDeliveryLane {
  return template.deliveryLane ?? "apply_safe";
}

export function getResumeTemplateAtsConfidence(
  template: Pick<ResumeTemplateDefinition, "atsConfidence">,
): ResumeTemplateAtsConfidence {
  return template.atsConfidence ?? "high";
}

export function isResumeTemplateApprovalEligible(
  template: Pick<ResumeTemplateDefinition, "approvalEligible" | "deliveryLane">,
): boolean {
  if (template.approvalEligible !== undefined) {
    return template.approvalEligible;
  }

  return getResumeTemplateDeliveryLane(template) === "apply_safe";
}

export function isResumeTemplateApplyEligible(
  template: Pick<
    ResumeTemplateDefinition,
    "applyEligible" | "approvalEligible" | "deliveryLane"
  >,
): boolean {
  if (template.applyEligible !== undefined) {
    return template.applyEligible;
  }

  return isResumeTemplateApprovalEligible(template);
}

export function isResumeTemplateBenchmarkEligible(
  template: Pick<
    ResumeTemplateDefinition,
    "benchmarkEligible" | "applyEligible" | "approvalEligible" | "deliveryLane"
  >,
): boolean {
  if (template.benchmarkEligible !== undefined) {
    return template.benchmarkEligible;
  }

  return isResumeTemplateApplyEligible(template);
}

/**
 * How a cover or motivation letter should read when Job Finder writes one.
 *
 * The defaults are the safe, unremarkable choice: plain professional, about a
 * page's worth, in whatever language the posting is written in. Everything
 * here shapes the writing; none of it adds a fact the resume and profile do
 * not already support.
 */
export const coverLetterToneValues = [
  "plain_professional",
  "warm",
  "direct",
  "formal",
] as const;
export const CoverLetterToneSchema = z.enum(coverLetterToneValues);
export type CoverLetterTone = z.infer<typeof CoverLetterToneSchema>;

export const coverLetterLengthValues = [
  "short",
  "standard",
  "detailed",
] as const;
export const CoverLetterLengthSchema = z.enum(coverLetterLengthValues);
export type CoverLetterLength = z.infer<typeof CoverLetterLengthSchema>;

export const CoverLetterPreferenceSchema = z
  .object({
    tone: CoverLetterToneSchema.default("plain_professional"),
    length: CoverLetterLengthSchema.default("standard"),
    /**
     * The language to write in. Null follows the posting, which is almost
     * always what the employer expects.
     */
    language: NonEmptyStringSchema.nullable().default(null),
    /**
     * A letter the person wrote themselves, kept only as an example of how
     * they sound. Its facts are never reused for another job.
     */
    sample: NonEmptyStringSchema.max(8_000).nullable().default(null),
  })
  .strict();
export type CoverLetterPreference = z.infer<typeof CoverLetterPreferenceSchema>;

/**
 * How the AI behaves on each surface, chosen by the person in one place.
 *
 * Every value here changes what the model is told, never what it is allowed
 * to do: the safety boundaries (ADR 0012, ADR 0022) and the resume grounding
 * gate (ADR 0018) are unchanged by any choice below. Defaults are the
 * behaviour the product had before the choices existed.
 */
export const profileAssistantInitiativeValues = [
  "answer_only",
  "suggest",
  "proactive",
] as const;
export const ProfileAssistantInitiativeSchema = z.enum(
  profileAssistantInitiativeValues,
);
export type ProfileAssistantInitiative = z.infer<
  typeof ProfileAssistantInitiativeSchema
>;

export const profileAssistantReplyStyleValues = [
  "brief",
  "conversational",
] as const;
export const ProfileAssistantReplyStyleSchema = z.enum(
  profileAssistantReplyStyleValues,
);
export type ProfileAssistantReplyStyle = z.infer<
  typeof ProfileAssistantReplyStyleSchema
>;

export const jobSearchSelectivityValues = [
  "best_matches",
  "balanced",
  "wide_net",
] as const;
export const JobSearchSelectivitySchema = z.enum(jobSearchSelectivityValues);
export type JobSearchSelectivity = z.infer<typeof JobSearchSelectivitySchema>;

export const coverLetterPolicyValues = [
  "when_required",
  "when_possible",
  "never",
] as const;
export const CoverLetterPolicySchema = z.enum(coverLetterPolicyValues);
export type CoverLetterPolicy = z.infer<typeof CoverLetterPolicySchema>;

export const writtenAnswerLengthValues = ["short", "full"] as const;
export const WrittenAnswerLengthSchema = z.enum(writtenAnswerLengthValues);
export type WrittenAnswerLength = z.infer<typeof WrittenAnswerLengthSchema>;

export const AiProfileAssistantBehaviorSchema = z
  .object({
    /** How much the Profile chat volunteers beyond what was asked. */
    initiative: ProfileAssistantInitiativeSchema.default("suggest"),
    /** How long its replies run. */
    replyStyle: ProfileAssistantReplyStyleSchema.default("brief"),
  })
  .strict();
export type AiProfileAssistantBehavior = z.infer<
  typeof AiProfileAssistantBehaviorSchema
>;

export const AiJobSearchBehaviorSchema = z
  .object({
    /**
     * How picky a search is. `best_matches` also turns on the strict
     * collection filter (title, location, work mode must match); `wide_net`
     * runs the search in its broad mode.
     */
    selectivity: JobSearchSelectivitySchema.default("balanced"),
    /** Whether a remote posting counts as matching any preferred location. */
    remoteCountsAsAnyLocation: z.boolean().default(true),
  })
  .strict();
export type AiJobSearchBehavior = z.infer<typeof AiJobSearchBehaviorSchema>;

/**
 * The declarations Job Finder may tick for the person without asking each
 * time. The routine ones (the answers are true, the privacy notice, the
 * site's terms, consent to the employer's background check) are on by
 * default: an applicant has to accept them to be considered at all, and
 * leaving them for the person only turns every application into a stop.
 * Self-identification and marketing contact stay off until the person turns
 * them on: neither is needed to apply (ADR 0027).
 */
export const defaultPreApprovedDeclarations = [
  "truthfulness_certification",
  "privacy_notice_acknowledgement",
  "terms_acceptance",
  "background_check_consent",
] as const satisfies readonly ApplicationAttestationKind[];

export const AiApplyingBehaviorSchema = z
  .object({
    /** When the apply agent writes a cover or motivation letter. */
    coverLetterPolicy: CoverLetterPolicySchema.default("when_required"),
    /** How long the answers it writes for open questions run. */
    writtenAnswerLength: WrittenAnswerLengthSchema.default("short"),
    /** Declaration kinds the run may tick for the person (ADR 0027). */
    preApprovedDeclarations: z
      .array(ApplicationAttestationKindSchema)
      .default([...defaultPreApprovedDeclarations]),
  })
  .strict();
export type AiApplyingBehavior = z.infer<typeof AiApplyingBehaviorSchema>;

export const AiBehaviorPreferenceSchema = z
  .object({
    profileAssistant: AiProfileAssistantBehaviorSchema.default({}),
    jobSearch: AiJobSearchBehaviorSchema.default({}),
    applying: AiApplyingBehaviorSchema.default({}),
  })
  .strict();
export type AiBehaviorPreference = z.infer<typeof AiBehaviorPreferenceSchema>;

export const JobFinderSettingsSchema = z.object({
  resumeFormat: DocumentFormatSchema,
  resumeTemplateId: ResumeTemplateIdSchema,
  fontPreset: DocumentFontPresetSchema,
  appearanceTheme: AppearanceThemeSchema.default("system"),
  /**
   * Fold the left side menu to icons while the assistant sidebar is docked,
   * so the page keeps room. Absent means on (older workspaces never stored
   * it): read it through `collapsesSideMenuWithAssistant`.
   */
  collapseSideMenuWithAssistant: z.boolean().optional(),
  /**
   * Start writing a job's resume as soon as it is shortlisted (ADR 0076).
   * Absent means on: read it through `writesResumesOnShortlist`.
   */
  writeResumesOnShortlist: z.boolean().optional(),
  humanReviewRequired: z.boolean(),
  allowAutoSubmitOverride: z.boolean(),
  /** Fill and leave for the person's click, or send for them. */
  applicationAutomationMode: ApplicationApplyModeSchema.optional(),
  salaryDisclosure: ApplicationSalaryDisclosureRuleSchema.optional(),
  keepSessionAlive: z.boolean(),
  discoveryOnly: z.boolean().default(false),
  resumeApplicationMode: ResumeApplicationModeSchema.optional(),
  applicationCrm: ApplicationCrmSettingsSchema.default({}).optional(),
  // Optional so a workspace saved before letters existed still loads; every
  // read goes through the schema default.
  coverLetter: CoverLetterPreferenceSchema.default({}).optional(),
  // Same reason: absent on older workspaces, defaulted on every read.
  aiBehavior: AiBehaviorPreferenceSchema.default({}).optional(),
});
export type JobFinderSettings = z.infer<typeof JobFinderSettingsSchema>;

/** On unless the person turned it off. */
export function writesResumesOnShortlist(
  settings: Pick<JobFinderSettings, "writeResumesOnShortlist">,
): boolean {
  return settings.writeResumesOnShortlist !== false;
}

/** On unless the person turned it off. */
export function collapsesSideMenuWithAssistant(
  settings: Pick<JobFinderSettings, "collapseSideMenuWithAssistant">,
): boolean {
  return settings.collapseSideMenuWithAssistant !== false;
}

const PersistedDiscoveryRunRecordSchema: z.ZodType<
  z.output<typeof DiscoveryRunRecordSchema>,
  z.ZodTypeDef,
  z.input<typeof DiscoveryRunRecordSchema>
> = DiscoveryRunRecordSchema;

export const JobFinderDiscoveryStateSchema = z.object({
  sessions: z.array(DiscoveryAdapterSessionStateSchema).default([]),
  runState: DiscoveryRunStateSchema.default("idle"),
  activeRun: PersistedDiscoveryRunRecordSchema.nullable().default(null),
  recentRuns: z.array(PersistedDiscoveryRunRecordSchema).default([]),
  activeSourceDebugRun: SourceDebugRunRecordSchema.nullable().default(null),
  recentSourceDebugRuns: z.array(SourceDebugRunRecordSchema).default([]),
  discoveryLedger: z.array(DiscoveryLedgerEntrySchema).default([]),
  pendingDiscoveryJobs: z.array(SavedJobSchema).default([]),
});
export type JobFinderDiscoveryState = z.infer<
  typeof JobFinderDiscoveryStateSchema
>;

/** Shell fields only; history, pending jobs and ledger are deferred. */
export const DiscoveryBootstrapStateSchema = JobFinderDiscoveryStateSchema.pick(
  {
    sessions: true,
    runState: true,
    activeRun: true,
    activeSourceDebugRun: true,
  },
);
export type DiscoveryBootstrapState = z.infer<
  typeof DiscoveryBootstrapStateSchema
>;

// Keep repository schema declarations small as application receipt fields grow.
const PersistedApplicationRecordSchema: z.ZodType<
  z.output<typeof ApplicationRecordSchema>,
  z.ZodTypeDef,
  z.input<typeof ApplicationRecordSchema>
> = ApplicationRecordSchema;

// Keep repository inference bounded as discovery accounting grows.
const PersistedDiscoveryStateSchema: z.ZodType<
  JobFinderDiscoveryState,
  z.ZodTypeDef,
  z.input<typeof JobFinderDiscoveryStateSchema>
> = JobFinderDiscoveryStateSchema;

const JobFinderRepositoryStateShape = {
  preparedApplicationForms: z.array(PreparedApplicationFormSchema).optional(),
  profile: CandidateProfileSchema,
  searchPreferences: JobSearchPreferencesSchema,
  profileSetupState: ProfileSetupStateSchema.default({}),
  savedJobs: z.array(SavedJobSchema).default([]),
  tailoredAssets: z.array(TailoredAssetSchema).default([]),
  resumeDrafts: z.array(ResumeDraftSchema).default([]),
  resumeDraftRevisions: z.array(ResumeDraftRevisionSchema).default([]),
  resumeExportArtifacts: z.array(ResumeExportArtifactSchema).default([]),
  resumeResearchArtifacts: z.array(ResumeResearchArtifactSchema).default([]),
  resumeValidationResults: z.array(ResumeValidationResultSchema).default([]),
  resumeAssistantMessages: z.array(ResumeAssistantMessageSchema).default([]),
  profileCopilotMessages: z.array(ProfileCopilotMessageSchema).default([]),
  profileRevisions: z.array(ProfileRevisionSchema).default([]),
  applyRuns: z.array(ApplyRunSchema).default([]),
  applyJobResults: z.array(ApplyJobResultSchema).default([]),
  applySubmitApprovals: z.array(ApplySubmitApprovalSchema).default([]),
  applicationQuestionRecords: z
    .array(ApplicationQuestionRecordSchema)
    .default([]),
  applicationAnswerRecords: z.array(ApplicationAnswerRecordSchema).default([]),
  applicationArtifactRefs: z.array(ApplicationArtifactRefSchema).default([]),
  applicationReplayCheckpoints: z
    .array(ApplicationReplayCheckpointSchema)
    .default([]),
  applicationConsentRequests: z
    .array(ApplicationConsentRequestSchema)
    .default([]),
  applicationAnswerSnapshots: z
    .array(ApprovedApplicationAnswerSnapshotSchema)
    .default([]),
  applicationAuthorityEnvelopes: z
    .array(ApplicationAuthorityEnvelopeSchema)
    .default([]),
  submissionPreflights: z.array(SubmissionPreflightRecordSchema).default([]),
  submissionExecutionGrants: z
    .array(SubmissionExecutionGrantSchema)
    .default([]),
  submissionIdempotencyRecords: z
    .array(SubmissionIdempotencyRecordSchema)
    .default([]),
  submissionArmedMarkers: z.array(SubmissionArmedMarkerSchema).default([]),
  submissionOutcomeRecords: z.array(SubmissionOutcomeRecordSchema).default([]),
  userActionRequests: z.array(UserActionRequestSchema).default([]),
  userActionEvents: z.array(UserActionEventSchema).default([]),
  applicationRecords: z.array(PersistedApplicationRecordSchema).default([]),
  applicationAttempts: z.array(ApplicationAttemptSchema).default([]),
  sourceDebugRuns: z.array(SourceDebugRunRecordSchema).default([]),
  sourceDebugAttempts: z.array(SourceDebugWorkerAttemptSchema).default([]),
  sourceInstructionArtifacts: z
    .array(SourceInstructionArtifactSchema)
    .default([]),
  sourceDebugEvidenceRefs: z.array(SourceDebugEvidenceRefSchema).default([]),
  resumeImportRuns: z.array(ResumeImportRunSchema).default([]),
  resumeImportDocumentBundles: z.array(ResumeDocumentBundleSchema).default([]),
  resumeImportFieldCandidates: z
    .array(ResumeImportFieldCandidateSchema)
    .default([]),
  settings: JobFinderSettingsSchema,
  discovery: PersistedDiscoveryStateSchema.default({}),
  campaigns: z.array(JobSearchCampaignSchema).default([]),
  activeCampaignId: NonEmptyStringSchema.nullable().default(null),
  campaignNotifications: z.array(CampaignNotificationSchema).default([]),
  activityControl: JobFinderActivityControlSchema.default({}),
  intelligence: JobFinderIntelligenceStateSchema.default({}),
};

const JobFinderRepositoryStateObjectSchema: z.ZodObject<
  typeof JobFinderRepositoryStateShape
> = z.object(JobFinderRepositoryStateShape);

export const JobFinderRepositoryStateSchema: z.ZodEffects<
  typeof JobFinderRepositoryStateObjectSchema
> = JobFinderRepositoryStateObjectSchema.superRefine((state, context) => {
  if (state.campaigns.length === 0) {
    if (state.activeCampaignId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeCampaignId"],
        message:
          "A workspace without campaigns must not reference an active campaign.",
      });
    }
    return;
  }

  if (state.activeCampaignId === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["activeCampaignId"],
      message:
        "A workspace with campaigns must reference an active campaign id.",
    });
    return;
  }

  if (
    !state.campaigns.some((campaign) => campaign.id === state.activeCampaignId)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["activeCampaignId"],
      message: "The active campaign must exist in the workspace campaigns.",
    });
  }
});
type JobFinderRepositoryStateOutput = z.infer<
  typeof JobFinderRepositoryStateSchema
>;
/**
 * New state collections remain optional to callers that construct a complete
 * workspace snapshot. The parser still defaults the persisted collection to
 * an empty array, so older seeds and benchmark fixtures remain compatible
 * while repository implementations normalize the value before use.
 */
export type JobFinderRepositoryState = Omit<
  JobFinderRepositoryStateOutput,
  "applicationAnswerSnapshots"
> & {
  applicationAnswerSnapshots?: JobFinderRepositoryStateOutput["applicationAnswerSnapshots"];
};
export type JobFinderRepositoryStateInput = z.input<
  typeof JobFinderRepositoryStateSchema
>;

export const JobFinderResumeWorkspaceSharedProfileProofSchema = z.object({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  claim: NonEmptyStringSchema,
  heroMetric: NonEmptyStringSchema.nullable().default(null),
  roleFamilies: z.array(NonEmptyStringSchema).default([]),
  supportingLinks: z.array(NonEmptyStringSchema).default([]),
});
export type JobFinderResumeWorkspaceSharedProfileProof = z.infer<
  typeof JobFinderResumeWorkspaceSharedProfileProofSchema
>;

export const JobFinderResumeWorkspaceSharedProfileSchema = z.object({
  narrativeSummary: NonEmptyStringSchema.nullable().default(null),
  nextChapterSummary: NonEmptyStringSchema.nullable().default(null),
  selfIntroduction: NonEmptyStringSchema.nullable().default(null),
  highlightedProofs: z
    .array(JobFinderResumeWorkspaceSharedProfileProofSchema)
    .default([]),
});
export type JobFinderResumeWorkspaceSharedProfile = z.infer<
  typeof JobFinderResumeWorkspaceSharedProfileSchema
>;

export const JobFinderResumeWorkspaceSchema = z.object({
  listingCheckState: z.enum(["checking", "failed"]).nullable().optional(),
  job: SavedJobSchema,
  draft: ResumeDraftSchema,
  validation: ResumeValidationResultSchema.nullable().default(null),
  exports: z.array(ResumeExportArtifactSchema).default([]),
  research: z.array(ResumeResearchArtifactSchema).default([]),
  assistantMessages: z.array(ResumeAssistantMessageSchema).default([]),
  revisions: z.array(ResumeDraftRevisionSchema).default([]),
  tailoredAsset: TailoredAssetSchema.nullable().default(null),
  sharedProfile: JobFinderResumeWorkspaceSharedProfileSchema.default({}),
  workHistoryReviewSuggestions: z
    .array(WorkHistoryReviewSuggestionSchema)
    .default([]),
  /**
   * Strength that actually ran (or will run) for this job: the named
   * approach's tailoring strength when one is selected, otherwise the
   * global search-preference default. Null only when neither is set.
   */
  effectiveTailoringStrength: TailoringModeSchema.nullable().default(null),
});
export type JobFinderResumeWorkspace = z.infer<
  typeof JobFinderResumeWorkspaceSchema
>;

export const JobFinderResumePreviewSchema = ResumePreviewSchema;
export type JobFinderResumePreview = z.infer<
  typeof JobFinderResumePreviewSchema
>;

const JobFinderAcknowledgeWorkHistoryReviewSuggestionInputObjectSchema = z
  .object({
    intent: z.literal("acknowledge"),
    jobId: NonEmptyStringSchema,
    draftId: NonEmptyStringSchema,
    expectedDraftUpdatedAt: IsoDateTimeSchema,
    suggestionId: NonEmptyStringSchema,
    profileRecordId: NonEmptyStringSchema,
    kind: WorkHistoryReviewAcknowledgmentKindSchema,
    action: WorkHistoryReviewAcknowledgmentActionSchema,
    messageContentHash: WorkHistoryReviewMessageContentHashSchema,
    reason: WorkHistoryReviewAcknowledgmentReasonSchema,
  })
  .strict();
export type JobFinderAcknowledgeWorkHistoryReviewSuggestionInput = z.infer<
  typeof JobFinderAcknowledgeWorkHistoryReviewSuggestionInputObjectSchema
>;

const JobFinderRemoveWorkHistoryReviewAcknowledgmentInputObjectSchema = z
  .object({
    intent: z.literal("remove"),
    jobId: NonEmptyStringSchema,
    draftId: NonEmptyStringSchema,
    expectedDraftUpdatedAt: IsoDateTimeSchema,
    acknowledgmentId: NonEmptyStringSchema,
  })
  .strict();
export type JobFinderRemoveWorkHistoryReviewAcknowledgmentInput = z.infer<
  typeof JobFinderRemoveWorkHistoryReviewAcknowledgmentInputObjectSchema
>;

/**
 * Server-owned work-history review decision command. Clients identify the
 * exact projected suggestion (acknowledge) or stored acknowledgment (remove)
 * and never supply record ids or timestamps: those are minted by the service.
 */
export const JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema = z
  .discriminatedUnion("intent", [
    JobFinderAcknowledgeWorkHistoryReviewSuggestionInputObjectSchema,
    JobFinderRemoveWorkHistoryReviewAcknowledgmentInputObjectSchema,
  ])
  .superRefine((input, ctx) => {
    if (input.intent !== "acknowledge") {
      return;
    }

    const isEligibleOmissionPair =
      (input.kind === "weak_fit" || input.kind === "gap_coverage") &&
      input.action === "consider_showing" &&
      input.reason === "intentional_omission";

    if (!isEligibleOmissionPair) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message:
          "Only weak_fit or gap_coverage suggestions with consider_showing can be acknowledged as intentional_omission.",
      });
    }
  });
export type JobFinderSetWorkHistoryReviewAcknowledgmentInput = z.infer<
  typeof JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema
>;

const JobFinderAddResumeClaimConfirmationInputObjectSchema = z
  .object({
    intent: z.literal("add"),
    jobId: NonEmptyStringSchema,
    draftId: NonEmptyStringSchema,
    expectedDraftUpdatedAt: IsoDateTimeSchema,
    field: ResumeClaimFieldSchema,
    sectionId: NonEmptyStringSchema,
    entryId: NonEmptyStringSchema.nullable(),
    bulletId: NonEmptyStringSchema.nullable(),
    confirmedClaimContentHash: ResumeClaimContentHashSchema,
    ownershipStatement: ResumeClaimOwnershipStatementSchema,
  })
  .strict();
export type JobFinderAddResumeClaimConfirmationInput = z.infer<
  typeof JobFinderAddResumeClaimConfirmationInputObjectSchema
>;

const ResumeClaimConfirmationTargetSchema = z
  .object({
    field: ResumeClaimFieldSchema,
    sectionId: NonEmptyStringSchema,
    entryId: NonEmptyStringSchema.nullable(),
    bulletId: NonEmptyStringSchema.nullable(),
    confirmedClaimContentHash: ResumeClaimContentHashSchema,
  })
  .strict();
export type ResumeClaimConfirmationTarget = z.infer<
  typeof ResumeClaimConfirmationTargetSchema
>;

const JobFinderAddManyResumeClaimConfirmationInputObjectSchema = z
  .object({
    intent: z.literal("add_many"),
    jobId: NonEmptyStringSchema,
    draftId: NonEmptyStringSchema,
    expectedDraftUpdatedAt: IsoDateTimeSchema,
    ownershipStatement: ResumeClaimOwnershipStatementSchema,
    targets: z.array(ResumeClaimConfirmationTargetSchema).min(1).max(40),
  })
  .strict();
export type JobFinderAddManyResumeClaimConfirmationInput = z.infer<
  typeof JobFinderAddManyResumeClaimConfirmationInputObjectSchema
>;

const JobFinderRemoveResumeClaimConfirmationInputObjectSchema = z
  .object({
    intent: z.literal("remove"),
    jobId: NonEmptyStringSchema,
    draftId: NonEmptyStringSchema,
    expectedDraftUpdatedAt: IsoDateTimeSchema,
    confirmationId: NonEmptyStringSchema,
  })
  .strict();
export type JobFinderRemoveResumeClaimConfirmationInput = z.infer<
  typeof JobFinderRemoveResumeClaimConfirmationInputObjectSchema
>;

/** Approve one non-claim blocker (see ResumeIssueApprovalSchema). */
const JobFinderApproveResumeIssueInputObjectSchema = z
  .object({
    intent: z.literal("approve_issue"),
    jobId: NonEmptyStringSchema,
    draftId: NonEmptyStringSchema,
    expectedDraftUpdatedAt: IsoDateTimeSchema,
    issueId: NonEmptyStringSchema,
    approvedContentHash: z.string().regex(/^fnv1a32:[0-9a-f]{8}$/),
  })
  .strict();
const JobFinderRemoveResumeIssueApprovalInputObjectSchema = z
  .object({
    intent: z.literal("remove_issue_approval"),
    jobId: NonEmptyStringSchema,
    draftId: NonEmptyStringSchema,
    expectedDraftUpdatedAt: IsoDateTimeSchema,
    approvalId: NonEmptyStringSchema,
  })
  .strict();

function addClaimConfirmationLocatorIssues(
  locator: {
    field: string;
    entryId: string | null;
    bulletId: string | null;
  },
  ctx: z.RefinementCtx,
  pathPrefix: Array<string | number> = [],
) {
  const expectsEntry =
    locator.field === "entry_summary" || locator.field === "entry_bullet";
  const expectsBullet =
    locator.field === "section_bullet" || locator.field === "entry_bullet";

  if ((locator.entryId !== null) !== expectsEntry) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...pathPrefix, "entryId"],
      message:
        "Claim confirmation locators require an entryId exactly when field is entry_summary or entry_bullet.",
    });
  }

  if ((locator.bulletId !== null) !== expectsBullet) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...pathPrefix, "bulletId"],
      message:
        "Claim confirmation locators require a bulletId exactly when field is section_bullet or entry_bullet.",
    });
  }
}

/**
 * Server-owned resume claim confirmation command. Clients identify the exact
 * projected `confirm_needed` assessment (add: claim locator plus normalized
 * content hash and literal ownership statement; add_many: the same for a
 * batch of skills-section locators) or the stored confirmation (remove:
 * confirmation id), and never supply record ids or timestamps: those are
 * minted by the service. Only an exact explicit ownership of the exact
 * normalized claim text can unblock export; edits and removals invalidate it.
 * `add_many` still mints one confirmation record per target.
 */
export const JobFinderSetResumeClaimConfirmationInputSchema = z
  .discriminatedUnion("intent", [
    JobFinderAddResumeClaimConfirmationInputObjectSchema,
    JobFinderAddManyResumeClaimConfirmationInputObjectSchema,
    JobFinderRemoveResumeClaimConfirmationInputObjectSchema,
    JobFinderApproveResumeIssueInputObjectSchema,
    JobFinderRemoveResumeIssueApprovalInputObjectSchema,
  ])
  .superRefine((input, ctx) => {
    if (input.intent === "add") {
      addClaimConfirmationLocatorIssues(input, ctx);
      return;
    }
    if (input.intent === "add_many") {
      input.targets.forEach((target, index) => {
        addClaimConfirmationLocatorIssues(target, ctx, ["targets", index]);
      });
    }
  });
export type JobFinderSetResumeClaimConfirmationInput = z.infer<
  typeof JobFinderSetResumeClaimConfirmationInputSchema
>;

export const JobFinderWorkspaceHydrationSchema = z
  .object({
    phase: z.enum(["bootstrap", "complete"]).default("complete"),
    deferredCollections: z
      .array(
        z.enum([
          "discovery_jobs",
          "review_queue",
          "applications",
          "source_history",
          "documents",
          "intelligence",
        ]),
      )
      .default([]),
  })
  .strict();
export type JobFinderWorkspaceHydration = z.infer<
  typeof JobFinderWorkspaceHydrationSchema
>;

export const FitJudgmentProgressSchema = z.object({
  planId: NonEmptyStringSchema.nullable(),
  phase: z.enum(["judging", "saving", "completed", "failed"]),
  judged: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  startedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type FitJudgmentProgress = z.infer<typeof FitJudgmentProgressSchema>;

const WorkspaceSnapshotCoreSchema = z.object({
  module: z.literal("job-finder"),
  generatedAt: IsoDateTimeSchema,
  hydration: JobFinderWorkspaceHydrationSchema.default({}),
  agentProvider: AgentProviderStatusSchema,
  visionProvider: AgentProviderStatusSchema.nullable().default(null),
  availableResumeTemplates: z.array(ResumeTemplateDefinitionSchema).default([]),
  profile: CandidateProfileSchema,
  searchPreferences: JobSearchPreferencesSchema,
  profileSetupState: ProfileSetupStateSchema,
  browserSession: BrowserSessionStateSchema,
  sourceAccessPrompts: z.array(SourceAccessPromptSchema).default([]),
  discoverySessions: z.array(DiscoveryAdapterSessionStateSchema).default([]),
  discoveryRunState: DiscoveryRunStateSchema.default("idle"),
  activeDiscoveryRun: DiscoveryRunRecordSchema.nullable().default(null),
  recentDiscoveryRuns: z.array(DiscoveryRunRecordSchema).default([]),
  activeSourceDebugRun: SourceDebugRunRecordSchema.nullable().default(null),
  recentSourceDebugRuns: z.array(SourceDebugRunRecordSchema).default([]),
  discoveryJobs: z.array(DiscoveryJobViewSchema).default([]),
  dismissedDiscoveryJobs: z.array(DiscoveryJobViewSchema).default([]),
  companyJobs: z.array(DiscoveryJobViewSchema).default([]),
  selectedDiscoveryJobId: NonEmptyStringSchema.nullable(),
  reviewQueue: z.array(ReviewQueueItemSchema).default([]),
  selectedReviewJobId: NonEmptyStringSchema.nullable(),
  tailoredAssets: z.array(TailoredAssetSchema).default([]),
  resumeDrafts: z.array(ResumeDraftSummarySchema).default([]),
  resumeExportArtifacts: z.array(ResumeExportArtifactSummarySchema).default([]),
  resumeResearchArtifacts: z
    .array(ResumeResearchArtifactSummarySchema)
    .default([]),
  applyRuns: z.array(ApplyRunSummarySchema).default([]),
  applyJobResults: z.array(ApplyJobResultSummarySchema).default([]),
  applicationRecords: z.array(PersistedApplicationRecordSchema).default([]),
  applicationAttempts: z.array(ApplicationAttemptSchema).default([]),
  userActionRequests: z.array(UserActionRequestSchema).default([]),
  userActionEvents: z.array(UserActionEventSchema).default([]),
  sourceInstructionArtifacts: z
    .array(SourceInstructionArtifactSchema)
    .default([]),
  latestResumeImportRun: ResumeImportRunSchema.nullable().default(null),
  resumeImportActive: z.boolean().default(false),
  latestResumeImportReviewCandidates: z
    .array(ResumeImportFieldCandidateSummarySchema)
    .default([]),
  profileCopilotMessages: z.array(ProfileCopilotMessageSchema).default([]),
  profileRevisions: z.array(ProfileRevisionSummarySchema).default([]),
  selectedApplyRunId: NonEmptyStringSchema.nullable().default(null),
  selectedApplicationRecordId: NonEmptyStringSchema.nullable(),
  settings: JobFinderSettingsSchema,
  campaigns: z.array(JobSearchCampaignSchema).min(1),
  activeCampaignId: NonEmptyStringSchema,
  campaignNotifications: z.array(CampaignNotificationSchema).default([]),
  dashboard: JobFinderDashboardSummarySchema,
  activityControl: JobFinderActivityControlSchema.default({}),
  applyQueue: ApplyQueueSchema.nullable().default(null),
});
const SnapshotIntelligenceSchema = JobFinderIntelligenceStateSchema.default({});
const WorkspaceSnapshotBaseSchema: z.ZodObject<
  typeof WorkspaceSnapshotCoreSchema.shape & {
    intelligence: typeof SnapshotIntelligenceSchema;
  }
> = WorkspaceSnapshotCoreSchema.extend({
  intelligence: SnapshotIntelligenceSchema,
});
const OptionalFitJudgmentProgressSchema =
  FitJudgmentProgressSchema.nullable().optional();
export const JobFinderWorkspaceSnapshotSchema: z.ZodObject<
  typeof WorkspaceSnapshotBaseSchema.shape & {
    fitJudgmentProgress: typeof OptionalFitJudgmentProgressSchema;
  }
> = WorkspaceSnapshotBaseSchema.extend({
  fitJudgmentProgress: OptionalFitJudgmentProgressSchema,
});

export type JobFinderWorkspaceSnapshot = z.infer<
  typeof JobFinderWorkspaceSnapshotSchema
>;

/** The IPC workspace carries every job identity, with detail evidence kept in main. */
export const JobFinderRendererWorkspaceSnapshotSchema =
  JobFinderWorkspaceSnapshotSchema.extend({
    tailoredAssets: z.array(TailoredAssetSummarySchema).default([]),
    applyJobResults: z.array(ApplyJobResultListRowSchema).default([]),
    applicationAttempts: z.array(ApplicationAttemptListRowSchema).default([]),
    discoveryJobs: z.array(JobListRowSchema).default([]),
    dismissedDiscoveryJobs: z.array(JobListRowSchema).default([]),
    companyJobs: z.array(JobListRowSchema).default([]),
  });
export type JobFinderRendererWorkspaceSnapshot = z.infer<
  typeof JobFinderRendererWorkspaceSnapshotSchema
>;

export const JobFinderAgentDiscoveryOutcomeSchema = z.enum([
  "completed",
  "cancelled",
]);
export type JobFinderAgentDiscoveryOutcome = z.infer<
  typeof JobFinderAgentDiscoveryOutcomeSchema
>;

/**
 * Typed terminal outcome for the agent-discovery IPC route. `cancelled` is
 * authoritative: the run stopped because the user (or the runtime) aborted it,
 * so callers must never render success feedback for it. The snapshot stays
 * required in both variants so incrementally committed jobs remain visible and
 * the workspace commit path is unchanged.
 */
export type JobFinderAgentDiscoveryResult = {
  outcome: JobFinderAgentDiscoveryOutcome;
  snapshot: JobFinderRendererWorkspaceSnapshot;
};
type JobFinderAgentDiscoveryResultInput = {
  outcome: z.input<typeof JobFinderAgentDiscoveryOutcomeSchema>;
  snapshot: z.input<typeof JobFinderRendererWorkspaceSnapshotSchema>;
};
export const JobFinderAgentDiscoveryResultSchema: z.ZodType<
  JobFinderAgentDiscoveryResult,
  z.ZodTypeDef,
  JobFinderAgentDiscoveryResultInput
> = z
  .object({
    outcome: JobFinderAgentDiscoveryOutcomeSchema,
    snapshot: JobFinderRendererWorkspaceSnapshotSchema,
  })
  .strict();

/**
 * What happened to a resume PDF export, beside the snapshot it produced.
 * `outputPath` is the file a download wrote; it is null when the person
 * cancelled the save dialog or the export only rendered the PDF for approval.
 */
export type JobFinderResumePdfExportResult = {
  outcome: "saved" | "cancelled";
  outputPath: string | null;
  snapshot: JobFinderRendererWorkspaceSnapshot;
};
type JobFinderResumePdfExportResultInput = {
  outcome: "saved" | "cancelled";
  outputPath?: string | null | undefined;
  snapshot: z.input<typeof JobFinderRendererWorkspaceSnapshotSchema>;
};
export const JobFinderResumePdfExportResultSchema: z.ZodType<
  JobFinderResumePdfExportResult,
  z.ZodTypeDef,
  JobFinderResumePdfExportResultInput
> = z
  .object({
    outcome: z.enum(["saved", "cancelled"]),
    outputPath: NonEmptyStringSchema.nullable().default(null),
    snapshot: JobFinderRendererWorkspaceSnapshotSchema,
  })
  .strict();

export const WorkspaceRevisionSchema = z.number().int().nonnegative();
export type WorkspaceRevision = z.infer<typeof WorkspaceRevisionSchema>;

export const JobFinderWorkspaceEntityMutationSchema = z.discriminatedUnion(
  "type",
  [
    z
      .object({
        type: z.literal("assess_job_listing"),
        jobId: NonEmptyStringSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("queue_job_for_review"),
        jobId: NonEmptyStringSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("queue_jobs_for_review"),
        jobIds: z.array(NonEmptyStringSchema).min(1).max(10_000),
      })
      .strict(),
    z
      .object({
        type: z.literal("remove_job_from_review"),
        jobId: NonEmptyStringSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("remove_jobs_from_review"),
        jobIds: z.array(NonEmptyStringSchema).min(1).max(10_000),
      })
      .strict(),
  ],
);
export type JobFinderWorkspaceEntityMutation = z.infer<
  typeof JobFinderWorkspaceEntityMutationSchema
>;

export const JobFinderWorkspaceEntityMutationInputSchema = z
  .object({
    baseRevision: WorkspaceRevisionSchema.nullable(),
    mutation: JobFinderWorkspaceEntityMutationSchema,
  })
  .strict();
export type JobFinderWorkspaceEntityMutationInput = z.infer<
  typeof JobFinderWorkspaceEntityMutationInputSchema
>;

const WorkspaceDeltaRemovalIdsSchema = z
  .array(NonEmptyStringSchema)
  .default([]);

/** Whole top-level workspace fields a delta replaces; typed by the snapshot. */
const JobFinderWorkspaceDeltaReplacedSchema =
  JobFinderRendererWorkspaceSnapshotSchema.partial() as unknown as z.ZodType<
    Partial<JobFinderRendererWorkspaceSnapshot>,
    z.ZodTypeDef,
    unknown
  >;

export const JobFinderWorkspaceDeltaSchema = z
  .object({
    baseRevision: WorkspaceRevisionSchema,
    currentRevision: WorkspaceRevisionSchema,
    generatedAt: IsoDateTimeSchema,
    discoveryRunState: DiscoveryRunStateSchema,
    fitJudgmentProgress: FitJudgmentProgressSchema.nullable().optional(),
    activeDiscoveryRun: DiscoveryRunRecordSchema.nullable(),
    /**
     * When set, `activeDiscoveryRun.activity` holds only the events after the
     * first this-many, which the receiver already has for the same run. A
     * long search's history only grows, so each delta carries what is new.
     */
    activeDiscoveryRunActivityFrom: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .default(null),
    // The fields below are sent only when they changed; an absent field
    // keeps what the receiver holds. Plan state alone is hundreds of KB with
    // a large search, and resending it on every refresh dominated the delta.
    discoverySessions: z.array(DiscoveryAdapterSessionStateSchema).optional(),
    sourceAccessPrompts: z.array(SourceAccessPromptSchema).optional(),
    latestResumeImportRun: ResumeImportRunSchema.nullable().optional(),
    campaigns: z.array(JobSearchCampaignSchema).min(1).optional(),
    activeCampaignId: NonEmptyStringSchema,
    campaignNotifications: z.array(CampaignNotificationSchema).optional(),
    dashboard: JobFinderDashboardSummarySchema.optional(),
    activityControl: JobFinderActivityControlSchema.optional(),
    intelligence: JobFinderIntelligenceStateSchema.optional(),
    /**
     * Other top-level workspace fields that changed (the profile, resumes,
     * settings and so on), each replaced whole. Without it any such change
     * made the sender resend the complete workspace.
     */
    replaced: JobFinderWorkspaceDeltaReplacedSchema.optional(),
    selectedDiscoveryJobId: NonEmptyStringSchema.nullable(),
    selectedReviewJobId: NonEmptyStringSchema.nullable(),
    selectedApplyRunId: NonEmptyStringSchema.nullable(),
    selectedApplicationRecordId: NonEmptyStringSchema.nullable(),
    discoveryJobs: z
      .object({
        upserts: z.array(JobListRowSchema).default([]),
        removedIds: WorkspaceDeltaRemovalIdsSchema,
      })
      .strict(),
    dismissedDiscoveryJobs: z
      .object({
        upserts: z.array(JobListRowSchema).default([]),
        removedIds: WorkspaceDeltaRemovalIdsSchema,
      })
      .strict(),
    companyJobs: z
      .object({
        upserts: z.array(JobListRowSchema).default([]),
        removedIds: WorkspaceDeltaRemovalIdsSchema,
      })
      .strict()
      .default({}),
    recentDiscoveryRuns: z
      .object({
        upserts: z.array(DiscoveryRunRecordSchema).default([]),
        removedIds: WorkspaceDeltaRemovalIdsSchema,
      })
      .strict(),
    reviewQueue: z
      .object({
        upserts: z.array(ReviewQueueItemSchema).default([]),
        removedIds: WorkspaceDeltaRemovalIdsSchema,
      })
      .strict(),
    applyRuns: z
      .object({
        upserts: z.array(ApplyRunSummarySchema).default([]),
        removedIds: WorkspaceDeltaRemovalIdsSchema,
      })
      .strict(),
    applyJobResults: z
      .object({
        upserts: z.array(ApplyJobResultListRowSchema).default([]),
        removedIds: WorkspaceDeltaRemovalIdsSchema,
      })
      .strict(),
    applicationRecords: z
      .object({
        upserts: z.array(PersistedApplicationRecordSchema).default([]),
        removedIds: WorkspaceDeltaRemovalIdsSchema,
      })
      .strict(),
    applicationAttempts: z
      .object({
        upserts: z.array(ApplicationAttemptListRowSchema).default([]),
        removedIds: WorkspaceDeltaRemovalIdsSchema,
      })
      .strict(),
    userActionRequests: z
      .object({
        upserts: z.array(UserActionRequestSchema).default([]),
        removedIds: WorkspaceDeltaRemovalIdsSchema,
      })
      .strict(),
    userActionEvents: z
      .object({
        upserts: z.array(UserActionEventSchema).default([]),
        removedIds: WorkspaceDeltaRemovalIdsSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((delta, context) => {
    if (delta.currentRevision <= delta.baseRevision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currentRevision"],
        message: "Workspace deltas must advance beyond their base revision.",
      });
    }
  });
export type JobFinderWorkspaceDelta = z.infer<
  typeof JobFinderWorkspaceDeltaSchema
>;

export const JobFinderWorkspaceSyncInputSchema = z
  .object({
    baseRevision: WorkspaceRevisionSchema.nullable(),
  })
  .strict();
export type JobFinderWorkspaceSyncInput = z.infer<
  typeof JobFinderWorkspaceSyncInputSchema
>;

export const JobFinderResumePdfExportOutcomeSchema = z
  .object({
    outcome: z.enum(["saved", "cancelled"]),
    outputPath: NonEmptyStringSchema.nullable().default(null),
  })
  .strict();

/**
 * What the PDF export route sends: its outcome and the workspace as a sync
 * result. The window turns it back into a JobFinderResumePdfExportResult.
 * Sending (and validating) the whole workspace with every export cost an
 * approval over a second.
 */
export type JobFinderResumePdfExportReply = z.infer<
  typeof JobFinderResumePdfExportOutcomeSchema
> & {
  workspace: JobFinderWorkspaceSyncResult;
};

/**
 * The revision a window now shows, sent each time it commits one. Main
 * answers that window's next change with a delta from it instead of the
 * whole workspace. 0 means the window holds no revision main knows.
 */
export const JobFinderWorkspaceHeldRevisionSchema = z
  .object({
    revision: WorkspaceRevisionSchema,
  })
  .strict();
export type JobFinderWorkspaceHeldRevision = z.infer<
  typeof JobFinderWorkspaceHeldRevisionSchema
>;

type JobFinderWorkspaceSyncResultValue =
  | {
      kind: "delta";
      delta: JobFinderWorkspaceDelta;
    }
  | {
      kind: "snapshot";
      currentRevision: WorkspaceRevision;
      reason: "initial" | "stale_base" | "revision_gap" | "unsupported_change";
      snapshot: JobFinderRendererWorkspaceSnapshot;
    };

export const JobFinderWorkspaceSyncResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("delta"),
      delta: JobFinderWorkspaceDeltaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("snapshot"),
      currentRevision: WorkspaceRevisionSchema,
      reason: z.enum([
        "initial",
        "stale_base",
        "revision_gap",
        "unsupported_change",
      ]),
      snapshot: JobFinderRendererWorkspaceSnapshotSchema,
    })
    .strict(),
]) as z.ZodType<JobFinderWorkspaceSyncResultValue>;
export type JobFinderWorkspaceSyncResult = z.infer<
  typeof JobFinderWorkspaceSyncResultSchema
>;

/**
 * What the agent-discovery IPC route answers: the terminal outcome and what
 * changed relative to the revision the window holds. A finished search used
 * to answer with the whole workspace (tens of megabytes with thousands of
 * jobs), which also made the window's next refresh send it all again.
 */
export type JobFinderAgentDiscoveryReply = {
  outcome: JobFinderAgentDiscoveryOutcome;
  sync: JobFinderWorkspaceSyncResult;
};
export const JobFinderAgentDiscoveryReplySchema = z
  .object({
    outcome: JobFinderAgentDiscoveryOutcomeSchema,
    sync: JobFinderWorkspaceSyncResultSchema,
  })
  .strict() as z.ZodType<JobFinderAgentDiscoveryReply>;

/** Search commands answer with committed run facts, never a workspace view. */
export const JobFinderDiscoveryCommandReplySchema = z
  .object({
    outcome: JobFinderAgentDiscoveryOutcomeSchema,
    runId: NonEmptyStringSchema.nullable(),
    newJobs: z.number().int().nonnegative(),
  })
  .strict();
export type JobFinderDiscoveryCommandReply = z.infer<
  typeof JobFinderDiscoveryCommandReplySchema
>;
export const JobFinderDiscoveryCancellationReplySchema = z
  .object({
    runId: NonEmptyStringSchema,
    accepted: z.boolean(),
  })
  .strict();
export type JobFinderDiscoveryCancellationReply = z.infer<
  typeof JobFinderDiscoveryCancellationReplySchema
>;

export const SaveCandidateProfileInputSchema = CandidateProfileSchema;
export type SaveCandidateProfileInput = z.infer<
  typeof SaveCandidateProfileInputSchema
>;

export const SaveJobSearchPreferencesInputSchema = JobSearchPreferencesSchema;
export type SaveJobSearchPreferencesInput = z.infer<
  typeof SaveJobSearchPreferencesInputSchema
>;

export const SaveJobFinderWorkspaceInputSchema = z.object({
  profile: CandidateProfileSchema,
  searchPreferences: JobSearchPreferencesSchema,
  settings: JobFinderSettingsSchema.optional(),
});
export type SaveJobFinderWorkspaceInput = z.infer<
  typeof SaveJobFinderWorkspaceInputSchema
>;

export const SaveJobFinderSettingsInputSchema = JobFinderSettingsSchema;
export type SaveJobFinderSettingsInput = z.infer<
  typeof SaveJobFinderSettingsInputSchema
>;

export const UpdateApplicationDefaultsInputSchema = z.object({
  resumeApplicationMode: ResumeApplicationModeSchema.optional(),
  resumeTemplateId: ResumeTemplateIdSchema.optional(),
  fontPreset: DocumentFontPresetSchema.optional(),
  /** How a letter Job Finder writes should read. */
  coverLetter: CoverLetterPreferenceSchema.optional(),
  applicationAutomationMode: ApplicationApplyModeSchema.optional(),
  salaryDisclosure: ApplicationSalaryDisclosureRuleSchema.optional(),
});
export type UpdateApplicationDefaultsInput = z.infer<
  typeof UpdateApplicationDefaultsInputSchema
>;

export const UpdateWorkspaceBehaviorInputSchema = z.object({
  keepSessionAlive: z.boolean().optional(),
  discoveryOnly: z.boolean().optional(),
  collapseSideMenuWithAssistant: z.boolean().optional(),
  writeResumesOnShortlist: z.boolean().optional(),
});
export type UpdateWorkspaceBehaviorInput = z.infer<
  typeof UpdateWorkspaceBehaviorInputSchema
>;

/**
 * Everything the AI behavior section of Settings saves in one action, plus
 * the resume level saved from Profile.
 *
 * `resumeApproach` is the person's one four-way choice: keep the imported
 * file, or tailor at one of three strengths. It writes two stored fields
 * (`settings.resumeApplicationMode` and `searchPreferences.tailoringMode`)
 * that older surfaces edited separately.
 */
export const ResumeApproachSchema = z.union([
  z.literal("original_resume"),
  TailoringModeSchema,
]);
export type ResumeApproach = z.infer<typeof ResumeApproachSchema>;

export const UpdateAiBehaviorInputSchema = z.object({
  aiBehavior: z
    .object({
      profileAssistant: AiProfileAssistantBehaviorSchema.partial().optional(),
      jobSearch: AiJobSearchBehaviorSchema.partial().optional(),
      applying: AiApplyingBehaviorSchema.partial().optional(),
    })
    .strict()
    .optional(),
  coverLetter: CoverLetterPreferenceSchema.partial().optional(),
  resumeApproach: ResumeApproachSchema.optional(),
});
export type UpdateAiBehaviorInput = z.infer<typeof UpdateAiBehaviorInputSchema>;

export const DesktopPlatformPingSchema = z.object({
  ok: z.literal(true),
  platform: z.enum(["darwin", "win32", "linux"]),
});
export type DesktopPlatformPing = z.infer<typeof DesktopPlatformPingSchema>;

export const DesktopTestOkResponseSchema = z.object({
  ok: z.literal(true),
});
export type DesktopTestOkResponse = z.infer<typeof DesktopTestOkResponseSchema>;

/**
 * Renderer-owned close protection state mirrored to the main process. The
 * renderer stays the single owner of dirty Profile/setup/Resume Studio state;
 * main only caches this flag so a native window close can be paused and
 * confirmed through the app-owned dialog instead of discarding drafts.
 */
export const DesktopWindowCloseGuardStateSchema = z.object({
  blocked: z.boolean(),
});
export type DesktopWindowCloseGuardState = z.infer<
  typeof DesktopWindowCloseGuardStateSchema
>;

/**
 * A right-click menu the window asks main to show as the system's own menu.
 * Main answers with the chosen item's id, or null when it was dismissed.
 */
export const DesktopContextMenuItemSchema = z.union([
  z
    .object({
      id: z.string().trim().min(1).max(80),
      label: z.string().trim().min(1).max(120),
      enabled: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("separator") }).strict(),
]);
export type DesktopContextMenuItem = z.infer<
  typeof DesktopContextMenuItemSchema
>;

export const DesktopContextMenuInputSchema = z
  .object({ items: z.array(DesktopContextMenuItemSchema).min(1).max(24) })
  .strict();
export type DesktopContextMenuInput = z.infer<
  typeof DesktopContextMenuInputSchema
>;

export const DesktopContextMenuResultSchema = z
  .object({ id: z.string().nullable() })
  .strict();
export type DesktopContextMenuResult = z.infer<
  typeof DesktopContextMenuResultSchema
>;

/**
 * Main-to-renderer request pushed after a native close was paused. The
 * renderer answers through `DesktopWindowCloseResolution`; an unanswered
 * request is bounded by a main-process watchdog instead of blocking forever.
 */
export const DesktopWindowCloseRequestSchema = z.object({
  requestId: NonEmptyStringSchema,
});
export type DesktopWindowCloseRequest = z.infer<
  typeof DesktopWindowCloseRequestSchema
>;

export const DesktopWindowCloseDecisionSchema = z.enum(["proceed", "cancel"]);
export type DesktopWindowCloseDecision = z.infer<
  typeof DesktopWindowCloseDecisionSchema
>;

export const DesktopWindowCloseResolutionSchema = z.object({
  requestId: NonEmptyStringSchema,
  decision: DesktopWindowCloseDecisionSchema,
});
export type DesktopWindowCloseResolution = z.infer<
  typeof DesktopWindowCloseResolutionSchema
>;

export const DesktopWindowControlsStateSchema = z.object({
  isFullScreen: z.boolean(),
  isMaximized: z.boolean(),
  isMinimizable: z.boolean(),
  isClosable: z.boolean(),
});
export type DesktopWindowControlsState = z.infer<
  typeof DesktopWindowControlsStateSchema
>;

export const AgentDiscoveryProgressSchema = z.object({
  currentUrl: z.string().min(1),
  jobsFound: z.number().int().nonnegative(),
  stepCount: z.number().int().nonnegative(),
  completedUnits: z.number().int().nonnegative().nullable().optional(),
  totalUnits: z.number().int().positive().nullable().optional(),
  progressLabel: NonEmptyStringSchema.nullable().optional(),
  currentAction: z.string().optional(),
  message: NonEmptyStringSchema.nullable().optional(),
  waitReason: BrowserRunWaitReasonSchema.nullable().optional(),
  phase: SourceDebugPhaseSchema.nullable().optional(),
  elapsedMs: z.number().nonnegative().optional(),
  lastActivityAt: IsoDateTimeSchema.nullable().optional(),
  targetId: NonEmptyStringSchema.nullable().default(null),
  adapterKind: JobSourceSchema.nullable().default(null),
});
export type AgentDiscoveryProgress = z.infer<
  typeof AgentDiscoveryProgressSchema
>;

export interface Tool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Private model state retained only across turns on its originating route. */
export interface ModelContinuation {
  kind: "reasoning_content";
  route: string;
  text: string;
}
