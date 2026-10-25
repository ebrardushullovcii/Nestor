import { ApplyAgentTimingSchema } from "./agent-timing";
import { z } from "zod";

import { SubmissionOutcomeRecordSchema } from "./application-authority";
import {
  IsoDateTimeSchema,
  JobSourceSchema,
  NonEmptyStringSchema,
  UrlStringSchema,
} from "./base";
import {
  ApplicationAnswerProvenanceSchema,
  ApplicationAnswerSourceKindSchema,
  ApplicationAttemptSuggestedAnswerSchema,
  ApplicationConsentKindSchema,
  ApplicationQuestionControlTypeSchema,
  ApplicationQuestionInputConstraintsSchema,
  ApplicationQuestionKindSchema,
  ApplicationQuestionStatusSchema,
} from "./discovery";
import { ApplicationListingSignalEvidenceSchema } from "./job-finder-intelligence";
import {
  BrowserVisualEvidenceSummarySchema,
  BrowserVisualObservationSetSchema,
  BrowserVisualReconciliationSchema,
  ApplyVisualCheckpointSchema,
} from "./visual";

export const applyRunModeValues = [
  "copilot",
  "single_job_auto",
  "queue_auto",
] as const;
export const ApplyRunModeSchema = z.enum(applyRunModeValues);
export type ApplyRunMode = z.infer<typeof ApplyRunModeSchema>;

export const applicationResumeSourceValues = [
  "tailored_export",
  "original_upload",
] as const;
export const ApplicationResumeSourceSchema = z.enum(
  applicationResumeSourceValues,
);
export type ApplicationResumeSource = z.infer<
  typeof ApplicationResumeSourceSchema
>;

export const ApplicationResumeArtifactSchema = z.object({
  id: NonEmptyStringSchema,
  jobId: NonEmptyStringSchema,
  source: ApplicationResumeSourceSchema,
  sourceDocumentId: NonEmptyStringSchema.nullable().default(null),
  exportArtifactId: NonEmptyStringSchema.nullable().default(null),
  fileName: NonEmptyStringSchema,
  filePath: NonEmptyStringSchema,
  sha256: z
    .string()
    .regex(
      /^[a-f0-9]{64}$/i,
      "Resume SHA-256 must be 64 hexadecimal characters.",
    )
    .nullable()
    .optional(),
  approvedAt: IsoDateTimeSchema,
});
export type ApplicationResumeArtifact = z.infer<
  typeof ApplicationResumeArtifactSchema
>;

export const applyRunStateValues = [
  "draft",
  "awaiting_submit_approval",
  "running",
  "paused_for_user_review",
  "paused_for_consent",
  "completed",
  "cancelled",
  "failed",
] as const;
export const ApplyRunStateSchema = z.enum(applyRunStateValues);
export type ApplyRunState = z.infer<typeof ApplyRunStateSchema>;

/**
 * The summary of an application whose prepared page was gone (usually after a
 * restart). A form that was waiting on the person may have been sent by them,
 * so such an application is never retried in bulk; the person decides.
 */
export const PREPARED_PAGE_CLOSED_SUMMARY =
  "The prepared application page is no longer open.";

/** The summary of an application the person marked withdrawn in the tracker. */
export const WITHDRAWN_BY_PERSON_SUMMARY =
  "You marked this application withdrawn.";

/** The summary after Undo restored a withdrawn application's tracker stage. */
export const WITHDRAWAL_UNDONE_SUMMARY = "Withdrawal undone. Prepare again.";

export const applyJobStateValues = [
  "planned",
  "question_capture",
  "filling",
  "awaiting_review",
  "submitting",
  "submitted",
  "skipped",
  "blocked",
  "failed",
  "cancelled",
] as const;
export const ApplyJobStateSchema = z.enum(applyJobStateValues);
export type ApplyJobState = z.infer<typeof ApplyJobStateSchema>;

export const applyBlockerReasonValues = [
  "application_closed",
  "resume_missing",
  "resume_stale",
  "auth_required",
  "signup_consent_required",
  "site_protection",
  "field_interpretation_failed",
  "question_grounding_failed",
  "required_human_input",
  "asset_unavailable",
  "provider_submit_auth_unavailable",
  "submit_confirmation_missing",
  "unexpected_navigation",
  // Technical failure: the employer page never opened, so the application
  // never began.
  // Token intentionally mirrors the blocker code one-to-one.
  "application_page_unreachable",
  // ADR 0013 terminal uncertainty: the final-submission attempt could not be
  // externally proven as submitted or not_submitted. Automatic retry is
  // permanently blocked for the bound idempotency key; a human must verify
  // employer-site state before anything else happens.
  "submission_outcome_uncertain",
] as const;
export const ApplyBlockerReasonSchema = z.enum(applyBlockerReasonValues);
export type ApplyBlockerReason = z.infer<typeof ApplyBlockerReasonSchema>;

export const applySubmitApprovalStatusValues = [
  "pending",
  "approved",
  "declined",
  "revoked",
  "expired",
] as const;
export const ApplySubmitApprovalStatusSchema = z.enum(
  applySubmitApprovalStatusValues,
);
export type ApplySubmitApprovalStatus = z.infer<
  typeof ApplySubmitApprovalStatusSchema
>;

export const applyConsentRequestKindValues = [
  "existing_account_decision",
  "login",
  "signup",
  "manual_verification",
  "external_redirect",
  "resume_use",
  "profile_autofill",
] as const;
export const ApplyConsentRequestKindSchema = z.enum(
  applyConsentRequestKindValues,
);
export type ApplyConsentRequestKind = z.infer<
  typeof ApplyConsentRequestKindSchema
>;

export const applyConsentRequestStatusValues = [
  "pending",
  "approved",
  "declined",
  "expired",
] as const;
export const ApplyConsentRequestStatusSchema = z.enum(
  applyConsentRequestStatusValues,
);
export type ApplyConsentRequestStatus = z.infer<
  typeof ApplyConsentRequestStatusSchema
>;

export const applicationAnswerRecordStatusValues = [
  "suggested",
  "filled",
  "submitted",
  "rejected",
  "skipped",
] as const;
export const ApplicationAnswerRecordStatusSchema = z.enum(
  applicationAnswerRecordStatusValues,
);
export type ApplicationAnswerRecordStatus = z.infer<
  typeof ApplicationAnswerRecordStatusSchema
>;

export const applicationAnswerValueTypeValues = [
  "text",
  "single_choice",
  "multi_choice",
  "boolean",
  "date",
  "asset_ref",
] as const;
export const ApplicationAnswerValueTypeSchema = z.enum(
  applicationAnswerValueTypeValues,
);
export type ApplicationAnswerValueType = z.infer<
  typeof ApplicationAnswerValueTypeSchema
>;

const ApplicationAnswerDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Answer date must use YYYY-MM-DD.")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Answer date must be a real calendar date.");

export const ApplicationAnswerValueSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    value: z.string().trim().min(1).max(4_000),
  }),
  z.object({
    type: z.literal("single_choice"),
    value: NonEmptyStringSchema,
  }),
  z.object({
    type: z.literal("multi_choice"),
    values: z.array(NonEmptyStringSchema).min(1).max(100),
  }),
  z.object({
    type: z.literal("boolean"),
    value: z.boolean(),
  }),
  z.object({
    type: z.literal("date"),
    value: ApplicationAnswerDateSchema,
  }),
  z.object({
    type: z.literal("asset_ref"),
    assetId: NonEmptyStringSchema,
  }),
]);
export type ApplicationAnswerValue = z.infer<
  typeof ApplicationAnswerValueSchema
>;

export const applicationAnswerSaveScopeValues = [
  "application_once",
  "reusable_profile",
] as const;
export const ApplicationAnswerSaveScopeSchema = z.enum(
  applicationAnswerSaveScopeValues,
);
export type ApplicationAnswerSaveScope = z.infer<
  typeof ApplicationAnswerSaveScopeSchema
>;

export const applicationArtifactKindValues = [
  "screenshot",
  "field_snapshot",
  "uploaded_asset",
  "page_html",
  "checkpoint",
  "other",
] as const;
export const ApplicationArtifactKindSchema = z.enum(
  applicationArtifactKindValues,
);
export type ApplicationArtifactKind = z.infer<
  typeof ApplicationArtifactKindSchema
>;

export const applicationPrivacyLocalDataCategoryValues = [
  "profile_data",
  "resume_content",
  "application_answers",
  "job_listing_data",
  "browser_evidence",
  "generated_documents",
] as const;
export const ApplicationPrivacyLocalDataCategorySchema = z.enum(
  applicationPrivacyLocalDataCategoryValues,
);
export type ApplicationPrivacyLocalDataCategory = z.infer<
  typeof ApplicationPrivacyLocalDataCategorySchema
>;

export const applicationPrivacyModelUsePurposeValues = [
  "job_matching",
  "resume_extraction",
  "resume_generation",
  "application_answering",
  "visual_interpretation",
  "other",
] as const;
export const ApplicationPrivacyModelUsePurposeSchema = z.enum(
  applicationPrivacyModelUsePurposeValues,
);
export type ApplicationPrivacyModelUsePurpose = z.infer<
  typeof ApplicationPrivacyModelUsePurposeSchema
>;

export const applicationPrivacyModelTransportValues = [
  "local_model",
  "external_model",
] as const;
export const ApplicationPrivacyModelTransportSchema = z.enum(
  applicationPrivacyModelTransportValues,
);
export type ApplicationPrivacyModelTransport = z.infer<
  typeof ApplicationPrivacyModelTransportSchema
>;

export const applicationPrivacyExternalWriteCategoryValues = [
  "resume_attachment",
  "profile_field",
  "application_answer",
  "consent_control",
  "other",
] as const;
export const ApplicationPrivacyExternalWriteCategorySchema = z.enum(
  applicationPrivacyExternalWriteCategoryValues,
);
export type ApplicationPrivacyExternalWriteCategory = z.infer<
  typeof ApplicationPrivacyExternalWriteCategorySchema
>;

export const ApplicationPrivacyDestinationOriginSchema = UrlStringSchema.refine(
  (value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.username.length === 0 &&
        url.password.length === 0 &&
        url.pathname === "/" &&
        url.search.length === 0 &&
        url.hash.length === 0
      );
    } catch {
      return false;
    }
  },
  {
    message: "Destination origin must contain only an HTTP(S) scheme and host.",
  },
);
export type ApplicationPrivacyDestinationOrigin = z.infer<
  typeof ApplicationPrivacyDestinationOriginSchema
>;

export const ApplicationPrivacySafePathSchema = z
  .string()
  .trim()
  .min(1)
  .regex(
    /^\/[^\s?#\\]*$/,
    "Destination path must be an absolute redacted path without a query or fragment.",
  );
export type ApplicationPrivacySafePath = z.infer<
  typeof ApplicationPrivacySafePathSchema
>;

export const ApplicationPrivacyDestinationSchema = z.object({
  origin: ApplicationPrivacyDestinationOriginSchema,
  safePath: ApplicationPrivacySafePathSchema,
});
export type ApplicationPrivacyDestination = z.infer<
  typeof ApplicationPrivacyDestinationSchema
>;

export const ApplicationPrivacyResumeIdentitySchema = z.object({
  source: ApplicationResumeSourceSchema,
  sourceDocumentId: NonEmptyStringSchema.nullable().default(null),
  exportArtifactId: NonEmptyStringSchema.nullable().default(null),
  fileName: NonEmptyStringSchema,
  sha256: z
    .string()
    .regex(
      /^[a-f0-9]{64}$/i,
      "Resume SHA-256 must be 64 hexadecimal characters.",
    )
    .nullable()
    .optional(),
});
export type ApplicationPrivacyResumeIdentity = z.infer<
  typeof ApplicationPrivacyResumeIdentitySchema
>;

export const ApplicationPrivacyModelUseEntrySchema = z.object({
  purpose: ApplicationPrivacyModelUsePurposeSchema,
  transport: ApplicationPrivacyModelTransportSchema,
  providerLabel: NonEmptyStringSchema,
  modelLabel: NonEmptyStringSchema.nullable().default(null),
  dataCategories: z
    .array(ApplicationPrivacyLocalDataCategorySchema)
    .default([]),
  occurredAt: IsoDateTimeSchema,
});
export type ApplicationPrivacyModelUseEntry = z.infer<
  typeof ApplicationPrivacyModelUseEntrySchema
>;

export const ApplicationPrivacyExternalWriteEvidenceSchema = z.object({
  category: ApplicationPrivacyExternalWriteCategorySchema,
  fieldLabel: NonEmptyStringSchema,
  occurredAt: IsoDateTimeSchema,
  artifactRefId: NonEmptyStringSchema.nullable().default(null),
  verified: z.boolean().default(false),
});
export type ApplicationPrivacyExternalWriteEvidence = z.infer<
  typeof ApplicationPrivacyExternalWriteEvidenceSchema
>;

export const ApplicationPrivacyReceiptSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    generatedAt: IsoDateTimeSchema,
    lineage: z.object({
      runId: NonEmptyStringSchema,
      jobId: NonEmptyStringSchema,
      resultId: NonEmptyStringSchema,
      applicationRecordId: NonEmptyStringSchema.nullable().default(null),
    }),
    destination: ApplicationPrivacyDestinationSchema,
    resume: ApplicationPrivacyResumeIdentitySchema,
    stayedLocal: z.array(ApplicationPrivacyLocalDataCategorySchema).default([]),
    modelUse: z.array(ApplicationPrivacyModelUseEntrySchema).default([]),
    externalWrites: z
      .array(ApplicationPrivacyExternalWriteEvidenceSchema)
      .default([]),
    accountCreationAuthorized: z.boolean().default(false),
    finalSubmitAuthorized: z.boolean().default(false),
    finalSubmitOccurred: z.boolean().default(false),
    // ADR 0013 tri-state submission outcome. Null/absent keeps every legacy
    // persisted receipt parsing unchanged; presence adds externally verified
    // submission truth on top of the legacy attestations above, which stay
    // authoritative for older records.
    submissionOutcome: SubmissionOutcomeRecordSchema.nullable().default(null),
  })
  .superRefine((value, ctx) => {
    const outcome = value.submissionOutcome;
    if (!outcome) {
      return;
    }

    if (
      outcome.runId !== value.lineage.runId ||
      outcome.jobId !== value.lineage.jobId ||
      outcome.resultId !== value.lineage.resultId ||
      outcome.applicationRecordId !== value.lineage.applicationRecordId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Submission outcome lineage must exactly match the receipt lineage.",
        path: ["submissionOutcome"],
      });
    }

    if (outcome.outcome === "submitted" && value.finalSubmitOccurred !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "An externally submitted outcome requires the matching finalSubmitOccurred attestation.",
        path: ["finalSubmitOccurred"],
      });
    }

    if (
      outcome.outcome === "outcome_uncertain" &&
      value.finalSubmitOccurred !== false
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "An uncertain submission outcome forbids claiming finalSubmitOccurred.",
        path: ["finalSubmitOccurred"],
      });
    }
  });
export type ApplicationPrivacyReceipt = z.infer<
  typeof ApplicationPrivacyReceiptSchema
>;
export type ApplicationPrivacyReceiptInput = z.input<
  typeof ApplicationPrivacyReceiptSchema
>;
export const ApplicationPacketQuestionSchema = z.object({
  id: NonEmptyStringSchema,
  prompt: NonEmptyStringSchema,
  kind: ApplicationQuestionKindSchema,
  isRequired: z.boolean(),
  status: ApplicationQuestionStatusSchema,
  preparedAnswer: NonEmptyStringSchema.nullable().default(null),
  sourceKinds: z.array(ApplicationAnswerSourceKindSchema).default([]),
});
export type ApplicationPacketQuestion = z.infer<
  typeof ApplicationPacketQuestionSchema
>;

export const ApplicationPacketCheckpointSchema = z.object({
  label: NonEmptyStringSchema,
  detail: NonEmptyStringSchema.nullable().default(null),
  jobState: ApplyJobStateSchema,
  createdAt: IsoDateTimeSchema,
  destination: ApplicationPrivacyDestinationSchema.nullable().default(null),
});
export type ApplicationPacketCheckpoint = z.infer<
  typeof ApplicationPacketCheckpointSchema
>;

export const ApplicationPacketSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    generatedAt: IsoDateTimeSchema,
    job: z.object({
      id: NonEmptyStringSchema,
      source: JobSourceSchema,
      title: NonEmptyStringSchema,
      company: NonEmptyStringSchema,
      location: NonEmptyStringSchema,
      listingDestination: ApplicationPrivacyDestinationSchema,
      applicationDestination:
        ApplicationPrivacyDestinationSchema.nullable().default(null),
      summary: NonEmptyStringSchema.nullable().default(null),
    }),
    run: z.object({
      id: NonEmptyStringSchema,
      mode: ApplyRunModeSchema,
      state: ApplyRunStateSchema,
    }),
    result: z.object({
      id: NonEmptyStringSchema,
      applicationRecordId: NonEmptyStringSchema.nullable().default(null),
      state: ApplyJobStateSchema,
      summary: NonEmptyStringSchema,
      detail: NonEmptyStringSchema,
      blockerReason: ApplyBlockerReasonSchema.nullable().default(null),
      blockerSummary: NonEmptyStringSchema.nullable().default(null),
      updatedAt: IsoDateTimeSchema,
    }),
    resume: ApplicationPrivacyResumeIdentitySchema.nullable().default(null),
    questions: z.array(ApplicationPacketQuestionSchema).default([]),
    consent: z
      .array(
        z.object({
          kind: ApplyConsentRequestKindSchema,
          label: NonEmptyStringSchema,
          detail: NonEmptyStringSchema.nullable().default(null),
          status: ApplyConsentRequestStatusSchema,
          requestedAt: IsoDateTimeSchema,
          decidedAt: IsoDateTimeSchema.nullable().default(null),
        }),
      )
      .default([]),
    checkpoints: z.array(ApplicationPacketCheckpointSchema).default([]),
    privacyReceipt: ApplicationPrivacyReceiptSchema.nullable().default(null),
    submissionOccurred: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    const submissionProven =
      value.result.state === "submitted" &&
      value.privacyReceipt?.finalSubmitOccurred === true;
    if (value.submissionOccurred !== submissionProven) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Packet submission status must exactly match both result and receipt proof.",
        path: ["submissionOccurred"],
      });
    }

    const receiptLineage = value.privacyReceipt?.lineage;
    if (
      receiptLineage &&
      (receiptLineage.runId !== value.run.id ||
        receiptLineage.jobId !== value.job.id ||
        receiptLineage.resultId !== value.result.id ||
        receiptLineage.applicationRecordId !== value.result.applicationRecordId)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Packet privacy receipt lineage must match its run, job, result, and application record.",
        path: ["privacyReceipt", "lineage"],
      });
    }

    const submissionOutcome = value.privacyReceipt?.submissionOutcome ?? null;
    if (
      submissionOutcome?.outcome === "outcome_uncertain" &&
      value.submissionOccurred
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "An uncertain submission outcome forbids claiming submissionOccurred.",
        path: ["submissionOccurred"],
      });
    }
    if (
      submissionOutcome?.outcome === "submitted" &&
      !value.submissionOccurred
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "An externally submitted outcome must keep the packet submission claim.",
        path: ["submissionOccurred"],
      });
    }
    if (
      submissionOutcome !== null &&
      submissionOutcome.outcome !== "submitted" &&
      value.result.state === "submitted"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Only an externally submitted outcome may accompany a submitted result state.",
        path: ["result", "state"],
      });
    }
  });
export type ApplicationPacket = z.infer<typeof ApplicationPacketSchema>;
export type ApplicationPacketInput = z.input<typeof ApplicationPacketSchema>;
export const ApplyRecoveryContextSchema = z.object({
  previousRunId: NonEmptyStringSchema,
  previousResultId: NonEmptyStringSchema.nullable().default(null),
  previousRunMode: ApplyRunModeSchema,
  previousRunState: ApplyRunStateSchema,
  latestCheckpoint: z
    .object({
      label: NonEmptyStringSchema,
      detail: NonEmptyStringSchema.nullable().default(null),
      url: UrlStringSchema.nullable().default(null),
      jobState: ApplyJobStateSchema,
      createdAt: IsoDateTimeSchema,
    })
    .nullable()
    .default(null),
  checkpointUrls: z.array(UrlStringSchema).default([]),
  blockerSummary: NonEmptyStringSchema.nullable().default(null),
  retainedVisualEvidence: z
    .array(BrowserVisualEvidenceSummarySchema)
    .default([]),
});
export type ApplyRecoveryContext = z.infer<typeof ApplyRecoveryContextSchema>;

export const ApplySubmitApprovalSchema = z.object({
  id: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  mode: ApplyRunModeSchema.default("copilot"),
  jobIds: z.array(NonEmptyStringSchema).default([]),
  status: ApplySubmitApprovalStatusSchema.default("pending"),
  createdAt: IsoDateTimeSchema,
  approvedAt: IsoDateTimeSchema.nullable().default(null),
  revokedAt: IsoDateTimeSchema.nullable().default(null),
  expiresAt: IsoDateTimeSchema.nullable().default(null),
  detail: NonEmptyStringSchema.nullable().default(null),
  /**
   * The named batch of jobs this approval belongs to.
   *
   * A person approving preparation is answering about a batch of jobs they
   * were shown, not about one run record. When part of that batch fails and
   * the remainder is retried, the retry stays inside the same batch and
   * carries the same id, so the audit shows one human decision instead of
   * one per recovery — which is what made a recovery ask for approval again
   * for every single job.
   *
   * Null for approvals recorded before batches existed; those never satisfy
   * reuse and always ask again.
   */
  batchId: NonEmptyStringSchema.nullable().default(null),
  /**
   * The search plan in force when the batch was approved. A retry may reuse
   * the approval only while this is unchanged; a different plan is a
   * different decision and is asked again.
   */
  batchCampaignId: NonEmptyStringSchema.nullable().default(null),
  /**
   * The approval whose authority this one inherits, when a retry covered a
   * subset of an already approved batch. Null for a first-hand approval.
   * Reuse never widens scope: the inheriting approval's `jobIds` are always
   * a subset of the original's.
   */
  reusedFromApprovalId: NonEmptyStringSchema.nullable().default(null),
});
export type ApplySubmitApproval = z.infer<typeof ApplySubmitApprovalSchema>;

export const ApplicationQuestionRecordSchema = z.object({
  id: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  jobId: NonEmptyStringSchema,
  applicationRecordId: NonEmptyStringSchema.nullable().default(null),
  resultId: NonEmptyStringSchema.nullable().default(null),
  prompt: NonEmptyStringSchema,
  /** The words around the question when they say something the prompt does not. */
  description: NonEmptyStringSchema.nullable().optional(),
  /**
   * Why it came back to the person: an answer that did not fit the choices,
   * for instance. Shown beside the question so the same one is not asked in
   * the same words twice.
   */
  note: NonEmptyStringSchema.nullable().optional(),
  kind: ApplicationQuestionKindSchema.default("other"),
  answerControlType: ApplicationQuestionControlTypeSchema.default("text"),
  inputConstraints: ApplicationQuestionInputConstraintsSchema.optional(),
  isRequired: z.boolean().default(true),
  detectedAt: IsoDateTimeSchema,
  answerOptions: z.array(NonEmptyStringSchema).default([]),
  suggestedAnswers: z
    .array(ApplicationAttemptSuggestedAnswerSchema)
    .default([]),
  selectedAnswerId: NonEmptyStringSchema.nullable().default(null),
  submittedAnswer: NonEmptyStringSchema.nullable().default(null),
  status: ApplicationQuestionStatusSchema.default("detected"),
  pageUrl: UrlStringSchema.nullable().default(null),
  visualContext: BrowserVisualEvidenceSummarySchema.nullable().default(null),
});
export type ApplicationQuestionRecord = z.infer<
  typeof ApplicationQuestionRecordSchema
>;
export type ApplicationQuestionRecordInput = z.input<
  typeof ApplicationQuestionRecordSchema
>;

export const ApplicationAnswerRecordSchema = z.object({
  hiringCountry: NonEmptyStringSchema.optional(),
  id: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  jobId: NonEmptyStringSchema,
  applicationRecordId: NonEmptyStringSchema.nullable().default(null),
  resultId: NonEmptyStringSchema.nullable().default(null),
  questionId: NonEmptyStringSchema,
  status: ApplicationAnswerRecordStatusSchema.default("suggested"),
  text: NonEmptyStringSchema,
  value: ApplicationAnswerValueSchema.nullable().default(null),
  revision: z.number().int().positive().default(1),
  saveScope: ApplicationAnswerSaveScopeSchema.default("application_once"),
  supersedesAnswerId: NonEmptyStringSchema.nullable().default(null),
  sourceKind: ApplicationAnswerSourceKindSchema.default("profile"),
  sourceId: NonEmptyStringSchema.nullable().default(null),
  confidenceLabel: NonEmptyStringSchema.nullable().default(null),
  provenance: z.array(ApplicationAnswerProvenanceSchema).default([]),
  createdAt: IsoDateTimeSchema,
  submittedAt: IsoDateTimeSchema.nullable().default(null),
});
export type ApplicationAnswerRecord = z.infer<
  typeof ApplicationAnswerRecordSchema
>;

/** Newest first, including deterministic ordering for legacy revision ties. */
export function compareApplicationAnswerRecency(
  left: ApplicationAnswerRecord,
  right: ApplicationAnswerRecord,
): number {
  return (
    right.revision - left.revision ||
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    right.id.localeCompare(left.id)
  );
}

const ApplicationAnswerMutationSafetySchema = {
  submitAuthorized: z.literal(false).default(false),
  accountCreationAuthorized: z.literal(false).default(false),
} as const;

export const SaveApplicationAnswerCommandSchema = z
  .object({
    commandId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    jobId: NonEmptyStringSchema,
    resultId: NonEmptyStringSchema,
    questionId: NonEmptyStringSchema,
    expectedAnswerRevision: z.number().int().nonnegative(),
    value: ApplicationAnswerValueSchema,
    saveScope: ApplicationAnswerSaveScopeSchema.default("application_once"),
    ...ApplicationAnswerMutationSafetySchema,
  })
  .strict();
export type SaveApplicationAnswerCommand = z.infer<
  typeof SaveApplicationAnswerCommandSchema
>;
export type SaveApplicationAnswerCommandInput = z.input<
  typeof SaveApplicationAnswerCommandSchema
>;

export const ClearApplicationAnswerCommandSchema = z
  .object({
    commandId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    jobId: NonEmptyStringSchema,
    resultId: NonEmptyStringSchema,
    questionId: NonEmptyStringSchema,
    expectedAnswerRevision: z.number().int().positive(),
    ...ApplicationAnswerMutationSafetySchema,
  })
  .strict();
export type ClearApplicationAnswerCommand = z.infer<
  typeof ClearApplicationAnswerCommandSchema
>;
export type ClearApplicationAnswerCommandInput = z.input<
  typeof ClearApplicationAnswerCommandSchema
>;

export const ApplicationArtifactRefSchema = z.object({
  id: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  jobId: NonEmptyStringSchema,
  applicationRecordId: NonEmptyStringSchema.nullable().default(null),
  resultId: NonEmptyStringSchema.nullable().default(null),
  questionId: NonEmptyStringSchema.nullable().default(null),
  kind: ApplicationArtifactKindSchema.default("other"),
  label: NonEmptyStringSchema,
  createdAt: IsoDateTimeSchema,
  storagePath: NonEmptyStringSchema.nullable().default(null),
  url: UrlStringSchema.nullable().default(null),
  textSnippet: NonEmptyStringSchema.nullable().default(null),
  visualEvidence: BrowserVisualEvidenceSummarySchema.nullable().default(null),
});
export type ApplicationArtifactRef = z.infer<
  typeof ApplicationArtifactRefSchema
>;
export type ApplicationArtifactRefInput = z.input<
  typeof ApplicationArtifactRefSchema
>;

export const ApplicationReplayCheckpointSchema = z.object({
  id: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  jobId: NonEmptyStringSchema,
  applicationRecordId: NonEmptyStringSchema.nullable().default(null),
  resultId: NonEmptyStringSchema.nullable().default(null),
  createdAt: IsoDateTimeSchema,
  label: NonEmptyStringSchema,
  detail: NonEmptyStringSchema.nullable().default(null),
  url: UrlStringSchema.nullable().default(null),
  jobState: ApplyJobStateSchema.default("planned"),
  artifactRefIds: z.array(NonEmptyStringSchema).default([]),
  visualEvidence: z.array(BrowserVisualEvidenceSummarySchema).default([]),
  visualReconciliations: z.array(BrowserVisualReconciliationSchema).default([]),
});
export type ApplicationReplayCheckpoint = z.infer<
  typeof ApplicationReplayCheckpointSchema
>;
export type ApplicationReplayCheckpointInput = z.input<
  typeof ApplicationReplayCheckpointSchema
>;

export const ApplicationConsentRequestSchema = z.object({
  id: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  jobId: NonEmptyStringSchema,
  applicationRecordId: NonEmptyStringSchema.nullable().default(null),
  resultId: NonEmptyStringSchema.nullable().default(null),
  kind: ApplyConsentRequestKindSchema.default("manual_verification"),
  linkedConsentKind: ApplicationConsentKindSchema.nullable().default(null),
  label: NonEmptyStringSchema,
  detail: NonEmptyStringSchema.nullable().default(null),
  status: ApplyConsentRequestStatusSchema.default("pending"),
  requestedAt: IsoDateTimeSchema,
  decidedAt: IsoDateTimeSchema.nullable().default(null),
  expiresAt: IsoDateTimeSchema.nullable().default(null),
});
export type ApplicationConsentRequest = z.infer<
  typeof ApplicationConsentRequestSchema
>;

const ApplicationPreparationStartedLocalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Preparation local date must use YYYY-MM-DD.")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Preparation local date must be a real calendar date.");

/**
 * One answer as it appears on the review a person reads before sending.
 *
 * `source` is the phrase the run itself recorded — "your email address", "the
 * letter written for this application" — rather than a category name. A person
 * checking what is about to go out in their name deserves to see where each
 * line actually came from.
 */
export const ApplicationReviewAnswerSchema = z
  .object({
    fieldKey: NonEmptyStringSchema.max(2_000).optional(),
    /** The run's stored fact or saved answer; observed values use observed.*. */
    sourceId: NonEmptyStringSchema.optional(),
    question: NonEmptyStringSchema.max(2_000),
    answer: NonEmptyStringSchema.max(12_000),
    source: NonEmptyStringSchema.max(240),
    /** True when the run wrote this for the job rather than reusing a fact. */
    written: z.boolean(),
    /** What a written answer was built from, in the person's words. */
    groundedIn: z.array(NonEmptyStringSchema.max(240)).max(8).default([]),
  })
  .strict();
export type ApplicationReviewAnswer = z.infer<
  typeof ApplicationReviewAnswerSchema
>;

export const ApplicationReviewAttachmentSchema = z
  .object({
    fieldKey: NonEmptyStringSchema.max(2_000).optional(),
    label: NonEmptyStringSchema.max(240),
    fileName: NonEmptyStringSchema.max(240),
    field: NonEmptyStringSchema.max(2_000),
  })
  .strict();
export type ApplicationReviewAttachment = z.infer<
  typeof ApplicationReviewAttachmentSchema
>;

/**
 * Everything a person needs to decide whether to send one application.
 *
 * Recorded by the run that filled the form in, so the review shows exactly
 * what that run wrote rather than a later reconstruction of it. It carries no
 * authority: reading it never sends anything.
 */
export const ApplicationReviewCardSchema = z
  .object({
    siteLabel: NonEmptyStringSchema.max(240),
    pageUrl: UrlStringSchema.nullable().default(null),
    answers: z.array(ApplicationReviewAnswerSchema).max(200).default([]),
    /** Fields checked on the live form, including values the person cleared. */
    observedFieldKeys: z
      .array(NonEmptyStringSchema.max(2_000))
      .max(500)
      .optional(),
    attachments: z.array(ApplicationReviewAttachmentSchema).max(20).default([]),
    letter: z
      .object({
        text: z
          .string()
          .min(1)
          .max(12_000)
          .refine((text) => text.trim().length > 0),
        reviewReason: NonEmptyStringSchema.max(2_000).optional(),
        /** The form still holds the previous letter; prepare again before sending. */
        needsRefresh: z.boolean().optional(),
        fields: z.array(NonEmptyStringSchema.max(2_000)).max(20).optional(),
        groundedIn: z.array(NonEmptyStringSchema.max(240)).max(8).default([]),
      })
      .strict()
      .nullable()
      .default(null),
    /** Anything still waiting on the person. Empty means it can be sent. */
    waitingOnYou: z.array(NonEmptyStringSchema.max(2_000)).max(50).default([]),
    preparedAt: IsoDateTimeSchema,
  })
  .strict();
export type ApplicationReviewCard = z.infer<typeof ApplicationReviewCardSchema>;

export const ApplyJobResultSchema = z
  .object({
    agentTiming: ApplyAgentTimingSchema.optional(),
    id: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    jobId: NonEmptyStringSchema,
    applicationRecordId: NonEmptyStringSchema.nullable().default(null),
    queuePosition: z.number().int().nonnegative().default(0),
    state: ApplyJobStateSchema.default("planned"),
    automaticSendPending: z.boolean().optional(),
    summary: NonEmptyStringSchema,
    detail: NonEmptyStringSchema,
    startedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.nullable().default(null),
    applicationPreparationStartedAt: IsoDateTimeSchema.nullable().optional(),
    applicationPreparationStartedLocalDate:
      ApplicationPreparationStartedLocalDateSchema.nullable().optional(),
    blockerReason: ApplyBlockerReasonSchema.nullable().default(null),
    blockerSummary: NonEmptyStringSchema.nullable().default(null),
    listingSignalEvidence:
      ApplicationListingSignalEvidenceSchema.nullable().default(null),
    visualObservationSets: z
      .array(BrowserVisualObservationSetSchema)
      .default([]),
    visualCheckpoints: z.array(ApplyVisualCheckpointSchema).default([]),
    latestQuestionCount: z.number().int().nonnegative().default(0),
    latestAnswerCount: z.number().int().nonnegative().default(0),
    pendingConsentRequestCount: z.number().int().nonnegative().default(0),
    artifactCount: z.number().int().nonnegative().default(0),
    latestCheckpointId: NonEmptyStringSchema.nullable().default(null),
    lastUserActionResumptionId: NonEmptyStringSchema.optional(),
    privacyReceipt: ApplicationPrivacyReceiptSchema.nullable().default(null),
    /**
     * What this attempt wrote, for the person to read before sending it. Null
     * when the attempt never reached a complete form, and for results recorded
     * before reviews existed.
     */
    reviewCard: ApplicationReviewCardSchema.nullable().default(null),
  })
  .superRefine((value, ctx) => {
    const hasStartedAt = value.applicationPreparationStartedAt !== undefined;
    const hasStartedLocalDate =
      value.applicationPreparationStartedLocalDate !== undefined;
    const bothNull =
      value.applicationPreparationStartedAt === null &&
      value.applicationPreparationStartedLocalDate === null;
    const bothSet =
      typeof value.applicationPreparationStartedAt === "string" &&
      typeof value.applicationPreparationStartedLocalDate === "string";

    if ((hasStartedAt || hasStartedLocalDate) && !bothNull && !bothSet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Preparation start timestamp and local date must both be null or both be set.",
        path: ["applicationPreparationStartedAt"],
      });
    }
  });
export type ApplyJobResult = z.infer<typeof ApplyJobResultSchema>;
export type ApplyJobResultInput = z.input<typeof ApplyJobResultSchema>;

export const ApplyRunSchema = z.object({
  id: NonEmptyStringSchema,
  // Captured when the run is created so terminal safeguards and campaign
  // notifications remain scoped to the campaign that authorized preparation.
  // Nullable keeps older persisted runs migration-compatible.
  campaignId: NonEmptyStringSchema.nullable().default(null),
  mode: ApplyRunModeSchema.default("copilot"),
  state: ApplyRunStateSchema.default("draft"),
  jobIds: z.array(NonEmptyStringSchema).default([]),
  currentJobId: NonEmptyStringSchema.nullable().default(null),
  submitApprovalId: NonEmptyStringSchema.nullable().default(null),
  visualCheckpointsEnabled: z.boolean().default(false),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable().default(null),
  summary: NonEmptyStringSchema,
  detail: NonEmptyStringSchema,
  totalJobs: z.number().int().nonnegative().default(0),
  pendingJobs: z.number().int().nonnegative().default(0),
  submittedJobs: z.number().int().nonnegative().default(0),
  skippedJobs: z.number().int().nonnegative().default(0),
  blockedJobs: z.number().int().nonnegative().default(0),
  failedJobs: z.number().int().nonnegative().default(0),
});
export type ApplyRun = z.infer<typeof ApplyRunSchema>;

// Summary aliases intentionally mirror the full schemas for now so consumers can
// depend on stable names before we split lighter list/detail projections later.
export const ApplyRunSummarySchema = ApplyRunSchema;
export type ApplyRunSummary = z.infer<typeof ApplyRunSummarySchema>;

export const ApplyJobResultSummarySchema = ApplyJobResultSchema;
export type ApplyJobResultSummary = z.infer<typeof ApplyJobResultSummarySchema>;

/** Workspace IPC omits evidence bodies read through getApplyRunDetails. */
export const ApplyJobResultListRowSchema = ApplyJobResultSchema.innerType()
  .omit({
    visualObservationSets: true,
    visualCheckpoints: true,
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasStartedAt = value.applicationPreparationStartedAt !== undefined;
    const hasStartedLocalDate =
      value.applicationPreparationStartedLocalDate !== undefined;
    const bothNull =
      value.applicationPreparationStartedAt === null &&
      value.applicationPreparationStartedLocalDate === null;
    const bothSet =
      typeof value.applicationPreparationStartedAt === "string" &&
      typeof value.applicationPreparationStartedLocalDate === "string";
    if ((hasStartedAt || hasStartedLocalDate) && !bothNull && !bothSet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Preparation start timestamp and local date must both be null or both be set.",
        path: ["applicationPreparationStartedAt"],
      });
    }
  });
export type ApplyJobResultListRow = z.infer<typeof ApplyJobResultListRowSchema>;

export const ApplyRunDetailsSchema = z.object({
  run: ApplyRunSchema,
  result: ApplyJobResultSchema.nullable().default(null),
  results: z.array(ApplyJobResultSchema).default([]),
  submitApproval: ApplySubmitApprovalSchema.nullable().default(null),
  questionRecords: z.array(ApplicationQuestionRecordSchema).default([]),
  answerRecords: z.array(ApplicationAnswerRecordSchema).default([]),
  artifactRefs: z.array(ApplicationArtifactRefSchema).default([]),
  checkpoints: z.array(ApplicationReplayCheckpointSchema).default([]),
  consentRequests: z.array(ApplicationConsentRequestSchema).default([]),
  /**
   * What the run wrote, for the person to read before sending. Null for runs
   * that never reached a complete form, and for older runs recorded before
   * reviews existed.
   */
  reviewCard: ApplicationReviewCardSchema.nullable().default(null),
});
export type ApplyRunDetails = z.infer<typeof ApplyRunDetailsSchema>;
