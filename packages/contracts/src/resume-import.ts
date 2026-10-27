import { z } from "zod";

import {
  AiProviderKindSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
} from "./base";
import { CandidateExperienceSchema } from "./profile";

const ProbabilitySchema = z.number().min(0).max(1);

export const resumeImportProgressStageValues = [
  "saving_file",
  "reading_document",
  "building_profile",
  "saving_results",
] as const;
export const ResumeImportProgressStageSchema = z.enum(
  resumeImportProgressStageValues,
);
export type ResumeImportProgressStage = z.infer<
  typeof ResumeImportProgressStageSchema
>;

export const ResumeImportProgressEventSchema = z.object({
  stage: ResumeImportProgressStageSchema,
  message: NonEmptyStringSchema,
  occurredAt: IsoDateTimeSchema,
  /**
   * Determinate progress. `completed` counts stages that have finished, so the
   * event announcing a stage carries the count of the stages behind it, and
   * `total` is the number of stages this import will report. Optional so an
   * older producer or a persisted legacy event still parses; the renderer falls
   * back to an indeterminate spinner when either is absent.
   */
  completed: z.number().int().min(0).optional(),
  total: z.number().int().min(1).optional(),
  /**
   * How long this stage typically takes, in seconds, stated as a range the user
   * can plan around. The long model stage is otherwise a frozen label.
   */
  expectedSecondsMin: z.number().int().min(0).optional(),
  expectedSecondsMax: z.number().int().min(0).optional(),
});
export type ResumeImportProgressEvent = z.infer<
  typeof ResumeImportProgressEventSchema
>;

export const resumeDocumentFileKindValues = [
  "plain_text",
  "markdown",
  "docx",
  "pdf",
  "unknown",
] as const;
export const ResumeDocumentFileKindSchema = z.enum(
  resumeDocumentFileKindValues,
);
export type ResumeDocumentFileKind = z.infer<
  typeof ResumeDocumentFileKindSchema
>;

export const resumeDocumentParserKindValues = [
  "plain_text",
  "textutil_docx",
  "mammoth",
  "pdfjs_text",
  "macos_pdfkit_text",
  "macos_vision_ocr",
  "local_pdf_text_probe",
  "local_pdf_layout",
  "local_docx",
  "local_python_sidecar",
  "local_sidecar_fallback",
] as const;
export const ResumeDocumentParserKindSchema = z.enum(
  resumeDocumentParserKindValues,
);
export type ResumeDocumentParserKind = z.infer<
  typeof ResumeDocumentParserKindSchema
>;

export const resumeDocumentRouteKindValues = [
  "plain_text_native",
  "docx_native",
  "native_first",
  "ocr_first",
  "hybrid_compare",
  "unsupported_fallback",
] as const;
export const ResumeDocumentRouteKindSchema = z.enum(
  resumeDocumentRouteKindValues,
);
export type ResumeDocumentRouteKind = z.infer<
  typeof ResumeDocumentRouteKindSchema
>;

export const resumeDocumentBlockKindValues = [
  "heading",
  "paragraph",
  "list_item",
  "contact",
  "experience_header",
  "unknown",
] as const;
export const ResumeDocumentBlockKindSchema = z.enum(
  resumeDocumentBlockKindValues,
);
export type ResumeDocumentBlockKind = z.infer<
  typeof ResumeDocumentBlockKindSchema
>;

export const resumeDocumentSectionHintValues = [
  "identity",
  "summary",
  "experience",
  "education",
  "certifications",
  "skills",
  "projects",
  "languages",
  "contact",
  "other",
] as const;
export const ResumeDocumentSectionHintSchema = z.enum(
  resumeDocumentSectionHintValues,
);
export type ResumeDocumentSectionHint = z.infer<
  typeof ResumeDocumentSectionHintSchema
>;

export const ResumeDocumentBlockBboxSchema = z.object({
  left: z.number(),
  top: z.number(),
  width: z.number(),
  height: z.number(),
});
export type ResumeDocumentBlockBbox = z.infer<
  typeof ResumeDocumentBlockBboxSchema
>;

export const ResumeDocumentTextSpanSchema = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
});
export type ResumeDocumentTextSpan = z.infer<
  typeof ResumeDocumentTextSpanSchema
>;

export const ResumeDocumentQualitySignalSchema = z.object({
  score: ProbabilitySchema.default(0),
  textDensity: z.number().min(0).nullable().default(null),
  tokenCount: z.number().int().min(0).default(0),
  lineCount: z.number().int().min(0).default(0),
  blockCount: z.number().int().min(0).default(0),
  columnLikelihood: ProbabilitySchema.nullable().default(null),
  readingOrderConfidence: ProbabilitySchema.nullable().default(null),
  nativeTextCoverage: ProbabilitySchema.nullable().default(null),
  ocrConfidence: ProbabilitySchema.nullable().default(null),
  imageCoverageRatio: ProbabilitySchema.nullable().default(null),
  invalidUnicodeRatio: ProbabilitySchema.nullable().default(null),
});
export type ResumeDocumentQualitySignal = z.infer<
  typeof ResumeDocumentQualitySignalSchema
>;

export const ResumeDocumentParserManifestSchema = z.object({
  workerKind: z
    .enum(["embedded_node", "python_sidecar"])
    .default("embedded_node"),
  workerVersion: NonEmptyStringSchema.nullable().default(null),
  manifestVersion: NonEmptyStringSchema.nullable().default(null),
  runtimeLabel: NonEmptyStringSchema.nullable().default(null),
  availableCapabilities: z.array(NonEmptyStringSchema).default([]),
  executorVersions: z.record(NonEmptyStringSchema).default({}),
});
export type ResumeDocumentParserManifest = z.infer<
  typeof ResumeDocumentParserManifestSchema
>;

export const ResumeDocumentRouteDecisionSchema = z.object({
  routeKind: ResumeDocumentRouteKindSchema,
  triageReasons: z.array(NonEmptyStringSchema).default([]),
  preferredExecutors: z.array(ResumeDocumentParserKindSchema).default([]),
  usedExecutors: z.array(ResumeDocumentParserKindSchema).default([]),
});
export type ResumeDocumentRouteDecision = z.infer<
  typeof ResumeDocumentRouteDecisionSchema
>;

export const ResumeDocumentPageSchema = z.object({
  pageNumber: z.number().int().min(1),
  text: NonEmptyStringSchema.nullable().default(null),
  charCount: z.number().int().min(0).default(0),
  parserKinds: z.array(ResumeDocumentParserKindSchema).default([]),
  usedOcr: z.boolean().default(false),
  width: z.number().positive().nullable().optional(),
  height: z.number().positive().nullable().optional(),
  rotationDegrees: z.number().optional(),
  routeKind: ResumeDocumentRouteKindSchema.nullable().optional(),
  quality: ResumeDocumentQualitySignalSchema.optional(),
  qualityWarnings: z.array(NonEmptyStringSchema).optional(),
});
export type ResumeDocumentPage = z.infer<typeof ResumeDocumentPageSchema>;

export const resumeImportArtifactRetentionValues = [
  "temporary",
  "debug_retained",
  "benchmark_retained",
] as const;
export const ResumeImportArtifactRetentionSchema = z.enum(
  resumeImportArtifactRetentionValues,
);
export type ResumeImportArtifactRetention = z.infer<
  typeof ResumeImportArtifactRetentionSchema
>;

export const resumeImportVisionRenderKindValues = [
  "pdf_page_image",
  "docx_rendered_preview",
  "text_rendered_preview",
  "markdown_rendered_preview",
  "fallback_rendered_preview",
] as const;
export const ResumeImportVisionRenderKindSchema = z.enum(
  resumeImportVisionRenderKindValues,
);
export type ResumeImportVisionRenderKind = z.infer<
  typeof ResumeImportVisionRenderKindSchema
>;

export const ResumeImportVisionPageImageSchema = z.object({
  id: NonEmptyStringSchema,
  sourceResumeId: NonEmptyStringSchema,
  sourceFileKind: ResumeDocumentFileKindSchema,
  pageNumber: z.number().int().min(1),
  renderKind: ResumeImportVisionRenderKindSchema,
  mimeType: NonEmptyStringSchema.default("image/svg+xml"),
  width: z.number().positive(),
  height: z.number().positive(),
  byteLength: z.number().int().min(0).default(0),
  sha256: NonEmptyStringSchema.nullable().default(null),
  dataUrl: NonEmptyStringSchema.nullable().default(null),
  storagePath: NonEmptyStringSchema.nullable().default(null),
  retained: ResumeImportArtifactRetentionSchema.default("temporary"),
  generatedAt: IsoDateTimeSchema,
  warnings: z.array(NonEmptyStringSchema).default([]),
});
export type ResumeImportVisionPageImage = z.infer<
  typeof ResumeImportVisionPageImageSchema
>;

export const ResumeImportVisionArtifactSchema = z.object({
  id: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  sourceResumeId: NonEmptyStringSchema,
  sourceFileKind: ResumeDocumentFileKindSchema,
  createdAt: IsoDateTimeSchema,
  retained: ResumeImportArtifactRetentionSchema.default("temporary"),
  pages: z.array(ResumeImportVisionPageImageSchema).default([]),
  warnings: z.array(NonEmptyStringSchema).default([]),
});
export type ResumeImportVisionArtifact = z.infer<
  typeof ResumeImportVisionArtifactSchema
>;

export const ResumeImportVisualEvidenceRefSchema = z.object({
  branch: z.enum(["text", "vision", "adjudication"]).default("vision"),
  sourceFileKind: ResumeDocumentFileKindSchema,
  pageNumber: z.number().int().min(1).nullable().default(null),
  regionHint: NonEmptyStringSchema.nullable().default(null),
  confidence: ProbabilitySchema.nullable().default(null),
  uncertaintyNotes: z.array(NonEmptyStringSchema).default([]),
});
export type ResumeImportVisualEvidenceRef = z.infer<
  typeof ResumeImportVisualEvidenceRefSchema
>;

export const ResumeDocumentBlockSchema = z.object({
  id: NonEmptyStringSchema,
  pageNumber: z.number().int().min(1),
  readingOrder: z.number().int().min(0),
  text: NonEmptyStringSchema,
  kind: ResumeDocumentBlockKindSchema.default("unknown"),
  sectionHint: ResumeDocumentSectionHintSchema.default("other"),
  bbox: ResumeDocumentBlockBboxSchema.nullable().default(null),
  sourceParserKinds: z.array(ResumeDocumentParserKindSchema).default([]),
  sourceConfidence: ProbabilitySchema.nullable().default(null),
  lineIds: z.array(NonEmptyStringSchema).optional(),
  parserLineage: z.array(ResumeDocumentParserKindSchema).optional(),
  readingOrderConfidence: ProbabilitySchema.nullable().optional(),
  textSpan: ResumeDocumentTextSpanSchema.nullable().optional(),
});
export type ResumeDocumentBlock = z.infer<typeof ResumeDocumentBlockSchema>;

export const ResumeDocumentBundleSchema = z.object({
  id: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  sourceResumeId: NonEmptyStringSchema,
  sourceFileKind: ResumeDocumentFileKindSchema,
  primaryParserKind: ResumeDocumentParserKindSchema,
  parserKinds: z.array(ResumeDocumentParserKindSchema).default([]),
  createdAt: IsoDateTimeSchema,
  languageHints: z.array(NonEmptyStringSchema).default([]),
  warnings: z.array(NonEmptyStringSchema).default([]),
  pages: z.array(ResumeDocumentPageSchema).default([]),
  blocks: z.array(ResumeDocumentBlockSchema).default([]),
  fullText: NonEmptyStringSchema.nullable().default(null),
  parserManifest: ResumeDocumentParserManifestSchema.optional(),
  route: ResumeDocumentRouteDecisionSchema.nullable().optional(),
  quality: ResumeDocumentQualitySignalSchema.optional(),
  qualityWarnings: z.array(NonEmptyStringSchema).optional(),
});
export type ResumeDocumentBundle = z.infer<typeof ResumeDocumentBundleSchema>;

export const ResumeParserWorkerPageSchema = z.object({
  pageNumber: z.number().int().min(1),
  text: z.string().default(""),
  charCount: z.number().int().min(0).default(0),
  tokenCount: z.number().int().min(0).default(0),
  quality: ResumeDocumentQualitySignalSchema.default({}),
  qualityWarnings: z.array(NonEmptyStringSchema).default([]),
  usedOcr: z.boolean().default(false),
  width: z.number().positive().nullable().default(null),
  height: z.number().positive().nullable().default(null),
});
export type ResumeParserWorkerPage = z.infer<
  typeof ResumeParserWorkerPageSchema
>;

export const ResumeParserWorkerBlockSchema = z.object({
  id: NonEmptyStringSchema,
  pageNumber: z.number().int().min(1),
  readingOrder: z.number().int().min(0),
  text: NonEmptyStringSchema,
  kind: ResumeDocumentBlockKindSchema.default("unknown"),
  sectionHint: ResumeDocumentSectionHintSchema.default("other"),
  bbox: ResumeDocumentBlockBboxSchema.nullable().default(null),
  sourceParserKinds: z.array(ResumeDocumentParserKindSchema).default([]),
  sourceConfidence: ProbabilitySchema.nullable().default(null),
  lineIds: z.array(NonEmptyStringSchema).default([]),
  parserLineage: z.array(ResumeDocumentParserKindSchema).default([]),
  readingOrderConfidence: ProbabilitySchema.nullable().default(null),
  textSpan: ResumeDocumentTextSpanSchema.nullable().default(null),
});
export type ResumeParserWorkerBlock = z.infer<
  typeof ResumeParserWorkerBlockSchema
>;

export const ResumeParserWorkerRequestSchema = z.object({
  requestId: NonEmptyStringSchema,
  filePath: NonEmptyStringSchema,
  fileKind: ResumeDocumentFileKindSchema,
  preferredRoute: ResumeDocumentRouteKindSchema.nullable().default(null),
  preferredExecutors: z.array(ResumeDocumentParserKindSchema).default([]),
});
export type ResumeParserWorkerRequest = z.infer<
  typeof ResumeParserWorkerRequestSchema
>;

export const ResumeParserWorkerResponseSchema = z.object({
  requestId: NonEmptyStringSchema,
  ok: z.boolean(),
  primaryParserKind: ResumeDocumentParserKindSchema.nullable().default(null),
  parserKinds: z.array(ResumeDocumentParserKindSchema).default([]),
  route: ResumeDocumentRouteDecisionSchema.nullable().default(null),
  parserManifest: ResumeDocumentParserManifestSchema.default({}),
  quality: ResumeDocumentQualitySignalSchema.default({}),
  qualityWarnings: z.array(NonEmptyStringSchema).default([]),
  warnings: z.array(NonEmptyStringSchema).default([]),
  pages: z.array(ResumeParserWorkerPageSchema).default([]),
  blocks: z.array(ResumeParserWorkerBlockSchema).default([]),
  fullText: z.string().nullable().default(null),
  errorMessage: NonEmptyStringSchema.nullable().default(null),
});
export type ResumeParserWorkerResponse = z.infer<
  typeof ResumeParserWorkerResponseSchema
>;

/**
 * What a text import left marked in progress says once the app has restarted
 * without it. Shared so every surface that shows the run tells the same
 * story and offers the same way back: import the file again.
 */
export const RESUME_IMPORT_INTERRUPTED_MESSAGE =
  "This import stopped before it finished, most likely because the app closed while it was reading your resume. Nothing from it was applied. Import the file again to finish it.";

export const resumeImportRunFailureKindValues = [
  "interrupted",
  "ai_unavailable",
  "cancelled",
  "invalid_document",
] as const;
export const ResumeImportRunFailureKindSchema = z.enum(
  resumeImportRunFailureKindValues,
);
export type ResumeImportRunFailureKind = z.infer<
  typeof ResumeImportRunFailureKindSchema
>;

/**
 * True for a text import the app closed on. Runs saved before
 * `failureKind` existed are recognised by their message.
 */
export function isInterruptedResumeImportRun(
  run: {
    status: string;
    errorMessage?: string | null | undefined;
    failureKind?: ResumeImportRunFailureKind | null | undefined;
  } | null,
): boolean {
  return (
    run?.status === "failed" &&
    (run.failureKind === "interrupted" ||
      run.errorMessage === RESUME_IMPORT_INTERRUPTED_MESSAGE)
  );
}

/** Only a stopped read or a connection failure can reuse the saved file. */
export function canRetrySavedResumeImport(
  run: {
    status: string;
    failureKind?: ResumeImportRunFailureKind | null | undefined;
    errorMessage?: string | null | undefined;
  } | null,
): boolean {
  if (!run || run.status !== "failed") return false;
  return (
    isInterruptedResumeImportRun(run) ||
    run.failureKind === "ai_unavailable" ||
    run.failureKind === "cancelled" ||
    run.errorMessage ===
      "The AI connection failed, so your resume could not be read. Your file is saved. Try again when the connection is back, or continue manually." ||
    run.errorMessage ===
      "Import stopped. Your file is saved; continue manually or try it again later."
  );
}

/**
 * The renderer's request to import a resume. `requestId` names the progress
 * channel and the picker a cancel press refers to; `retryInterrupted` imports
 * again the working copy a stopped import saved, with no file picker.
 */
export const ImportResumeRequestSchema = z
  .object({
    requestId: NonEmptyStringSchema.optional(),
    retryInterrupted: z.boolean().optional(),
  })
  .strict();
export const CancelResumeImportRequestSchema = z
  .object({
    requestId: NonEmptyStringSchema,
    stopProcessing: z.boolean().optional(),
  })
  .strict();
export type CancelResumeImportRequest = z.infer<
  typeof CancelResumeImportRequestSchema
>;

export type ImportResumeRequest = z.infer<typeof ImportResumeRequestSchema>;

export const resumeImportRunStatusValues = [
  "queued",
  "parsing",
  "extracting",
  "reconciling",
  "review_ready",
  "applied",
  "failed",
] as const;
export function isResumeImportRunInProgress(
  run: { status: string } | null,
): boolean {
  return (
    run !== null &&
    ["queued", "parsing", "extracting", "reconciling"].includes(run.status)
  );
}

export const ResumeImportRunStatusSchema = z.enum(resumeImportRunStatusValues);
export type ResumeImportRunStatus = z.infer<typeof ResumeImportRunStatusSchema>;

export const resumeImportTriggerValues = ["import", "refresh"] as const;
export const ResumeImportTriggerSchema = z.enum(resumeImportTriggerValues);
export type ResumeImportTrigger = z.infer<typeof ResumeImportTriggerSchema>;

export const resumeImportTargetSectionValues = [
  "identity",
  "contact",
  "location",
  "search_preferences",
  "experience",
  "education",
  "certification",
  "link",
  "project",
  "language",
  "skill",
  "narrative",
  "proof_point",
  "answer_bank",
  "application_identity",
  // Only from explicit statements, including conditional permits; never inferred
  // from residence, work history or education.
  "work_eligibility",
] as const;
export const ResumeImportTargetSectionSchema = z.enum(
  resumeImportTargetSectionValues,
);
export type ResumeImportTargetSection = z.infer<
  typeof ResumeImportTargetSectionSchema
>;

export const ResumeImportTargetSchema = z.object({
  section: ResumeImportTargetSectionSchema,
  key: NonEmptyStringSchema,
  recordId: NonEmptyStringSchema.nullable().default(null),
});
export type ResumeImportTarget = z.infer<typeof ResumeImportTargetSchema>;

export type ResumeImportJsonValue =
  | string
  | number
  | boolean
  | null
  | ResumeImportJsonValue[]
  | { [key: string]: ResumeImportJsonValue };

export const ResumeImportJsonValueSchema: z.ZodType<ResumeImportJsonValue> =
  z.lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(ResumeImportJsonValueSchema),
      z.record(ResumeImportJsonValueSchema),
    ]),
  );

export const ResumeImportConflictChoiceSchema = z.object({
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  sourceLabel: NonEmptyStringSchema,
  value: ResumeImportJsonValueSchema,
  valuePreview: NonEmptyStringSchema.nullable().default(null),
  evidenceText: NonEmptyStringSchema.nullable().default(null),
  confidence: ProbabilitySchema,
  recommended: z.boolean().default(false),
  notes: z.array(NonEmptyStringSchema).default([]),
  sourceCandidateIds: z.array(NonEmptyStringSchema).default([]),
  visualEvidence: z.array(ResumeImportVisualEvidenceRefSchema).default([]),
});
export type ResumeImportConflictChoice = z.infer<
  typeof ResumeImportConflictChoiceSchema
>;

export const resumeImportCandidateSourceValues = [
  "parser_literal",
  "model_identity_summary",
  "model_experience",
  "model_background",
  "model_shared_memory",
  "vision_omni",
  "adjudicator",
  "reconciler",
] as const;
export const ResumeImportCandidateSourceSchema = z.enum(
  resumeImportCandidateSourceValues,
);
export type ResumeImportCandidateSource = z.infer<
  typeof ResumeImportCandidateSourceSchema
>;

export const resumeImportFieldSensitivityValues = [
  "low",
  "medium",
  "high",
  "critical",
] as const;
export const ResumeImportFieldSensitivitySchema = z.enum(
  resumeImportFieldSensitivityValues,
);
export type ResumeImportFieldSensitivity = z.infer<
  typeof ResumeImportFieldSensitivitySchema
>;

export const resumeImportResolutionRecommendationValues = [
  "auto_apply",
  "needs_review",
  "abstain",
] as const;
export const ResumeImportResolutionRecommendationSchema = z.enum(
  resumeImportResolutionRecommendationValues,
);
export type ResumeImportResolutionRecommendation = z.infer<
  typeof ResumeImportResolutionRecommendationSchema
>;

export const ResumeImportConfidenceBreakdownSchema = z.object({
  overall: ProbabilitySchema,
  parserQuality: ProbabilitySchema,
  evidenceQuality: ProbabilitySchema,
  agreementScore: ProbabilitySchema,
  normalizationRisk: ProbabilitySchema,
  conflictRisk: ProbabilitySchema,
  fieldSensitivity: ResumeImportFieldSensitivitySchema,
  recommendation: ResumeImportResolutionRecommendationSchema,
});
export type ResumeImportConfidenceBreakdown = z.infer<
  typeof ResumeImportConfidenceBreakdownSchema
>;

export const resumeImportCandidateResolutionValues = [
  "auto_applied",
  "needs_review",
  "rejected",
  "abstained",
] as const;
export const ResumeImportCandidateResolutionSchema = z.enum(
  resumeImportCandidateResolutionValues,
);
export type ResumeImportCandidateResolution = z.infer<
  typeof ResumeImportCandidateResolutionSchema
>;

export const ResumeImportFieldCandidateSchema = z.object({
  id: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  target: ResumeImportTargetSchema,
  label: NonEmptyStringSchema,
  sourceKind: ResumeImportCandidateSourceSchema,
  value: ResumeImportJsonValueSchema,
  normalizedValue: ResumeImportJsonValueSchema.nullable().default(null),
  valuePreview: NonEmptyStringSchema.nullable().default(null),
  evidenceText: NonEmptyStringSchema.nullable().default(null),
  sourceBlockIds: z.array(NonEmptyStringSchema).default([]),
  confidence: ProbabilitySchema,
  confidenceBreakdown:
    ResumeImportConfidenceBreakdownSchema.nullable().optional(),
  notes: z.array(NonEmptyStringSchema).default([]),
  alternatives: z.array(ResumeImportJsonValueSchema).default([]),
  conflictChoices: z
    .array(ResumeImportConflictChoiceSchema)
    .default([])
    .optional(),
  visualEvidence: z
    .array(ResumeImportVisualEvidenceRefSchema)
    .default([])
    .optional(),
  resolution: ResumeImportCandidateResolutionSchema.default("needs_review"),
  resolutionReason: NonEmptyStringSchema.nullable().optional(),
  createdAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.nullable().default(null),
});
export type ResumeImportFieldCandidate = z.infer<
  typeof ResumeImportFieldCandidateSchema
>;

export const ResumeImportFieldCandidateDraftSchema =
  ResumeImportFieldCandidateSchema.omit({
    id: true,
    runId: true,
    sourceKind: true,
    resolution: true,
    resolutionReason: true,
    createdAt: true,
    resolvedAt: true,
  });
export type ResumeImportFieldCandidateDraft = z.infer<
  typeof ResumeImportFieldCandidateDraftSchema
>;

export const ResumeImportExtractionArtifactSchema = z.object({
  id: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  branch: z.enum(["vision", "adjudication"]),
  providerKind: AiProviderKindSchema,
  providerLabel: NonEmptyStringSchema,
  createdAt: IsoDateTimeSchema,
  sourceFileKind: ResumeDocumentFileKindSchema,
  pageNumbers: z.array(z.number().int().min(1)).default([]),
  candidates: z.array(ResumeImportFieldCandidateDraftSchema).default([]),
  notes: z.array(NonEmptyStringSchema).default([]),
  warnings: z.array(NonEmptyStringSchema).default([]),
});
export type ResumeImportExtractionArtifact = z.infer<
  typeof ResumeImportExtractionArtifactSchema
>;

export const ResumeImportFieldCandidateSummarySchema = z.object({
  id: NonEmptyStringSchema,
  target: ResumeImportTargetSchema,
  label: NonEmptyStringSchema,
  value: ResumeImportJsonValueSchema.nullable().default(null),
  valuePreview: NonEmptyStringSchema.nullable().default(null),
  evidenceText: NonEmptyStringSchema.nullable().default(null),
  confidence: ProbabilitySchema,
  resolution: ResumeImportCandidateResolutionSchema,
  resolutionReason: NonEmptyStringSchema.nullable().default(null),
  notes: z.array(NonEmptyStringSchema).default([]),
  conflictChoices: z.array(ResumeImportConflictChoiceSchema).default([]),
  visualEvidence: z.array(ResumeImportVisualEvidenceRefSchema).default([]),
});
export type ResumeImportFieldCandidateSummary = z.infer<
  typeof ResumeImportFieldCandidateSummarySchema
>;

export const ResumeImportRunCandidateCountsSchema = z.object({
  total: z.number().int().min(0).default(0),
  autoApplied: z.number().int().min(0).default(0),
  needsReview: z.number().int().min(0).default(0),
  rejected: z.number().int().min(0).default(0),
  abstained: z.number().int().min(0).optional(),
});
export type ResumeImportRunCandidateCounts = z.infer<
  typeof ResumeImportRunCandidateCountsSchema
>;

export const resumeImportBranchStatusValues = [
  "not_started",
  "running",
  "completed",
  "failed",
  "timed_out",
  "skipped",
] as const;
export const ResumeImportBranchStatusSchema = z.enum(
  resumeImportBranchStatusValues,
);
export type ResumeImportBranchStatus = z.infer<
  typeof ResumeImportBranchStatusSchema
>;

export const ResumeImportBranchStateSchema = z.object({
  status: ResumeImportBranchStatusSchema.default("not_started"),
  startedAt: IsoDateTimeSchema.nullable().default(null),
  completedAt: IsoDateTimeSchema.nullable().default(null),
  providerKind: AiProviderKindSchema.nullable().default(null),
  providerLabel: NonEmptyStringSchema.nullable().default(null),
  warning: NonEmptyStringSchema.nullable().default(null),
  errorMessage: NonEmptyStringSchema.nullable().default(null),
  timeoutMs: z.number().int().positive().nullable().default(null),
  candidateCount: z.number().int().min(0).default(0),
});
export type ResumeImportBranchState = z.infer<
  typeof ResumeImportBranchStateSchema
>;

export const resumeImportTextStageValues = [
  "identity_summary",
  "experience",
  "background",
  "shared_memory",
] as const;
export const ResumeImportTextStageSchema = z.enum(resumeImportTextStageValues);
export type ResumeImportTextStage = z.infer<typeof ResumeImportTextStageSchema>;

/**
 * Why a stage stopped using the configured model and used the built-in
 * deterministic reader instead. A stage that degrades this way still returns
 * usable candidates, so its status stays `completed`; without this field the
 * degradation is invisible and the app silently under-reports what it did.
 */
export const resumeImportStageFallbackKindValues = [
  "timeout",
  "provider_error",
] as const;
export const ResumeImportStageFallbackKindSchema = z.enum(
  resumeImportStageFallbackKindValues,
);
export type ResumeImportStageFallbackKind = z.infer<
  typeof ResumeImportStageFallbackKindSchema
>;

export const ResumeImportTextStageTimingSchema = z.object({
  stage: ResumeImportTextStageSchema,
  status: z.enum(["completed", "failed", "timed_out"]),
  providerKind: AiProviderKindSchema.nullable().default(null),
  providerLabel: NonEmptyStringSchema.nullable().default(null),
  durationMs: z.number().int().min(0),
  primaryProviderMs: z.number().int().min(0).nullable().default(null),
  deterministicFallbackMs: z.number().int().min(0).nullable().default(null),
  candidateCount: z.number().int().min(0).default(0),
  // Null on a stage that genuinely used the configured model, and on the
  // deterministic-by-design `shared_memory` stage, which never had a model
  // call to lose.
  fallbackKind: ResumeImportStageFallbackKindSchema.nullable().default(null),
  fallbackReason: NonEmptyStringSchema.nullable().default(null),
});
export type ResumeImportTextStageTiming = z.infer<
  typeof ResumeImportTextStageTimingSchema
>;

export const ResumeImportTimingSummarySchema = z.object({
  totalMs: z.number().int().min(0).nullable().default(null),
  textBranchMs: z.number().int().min(0),
  literalExtractionMs: z.number().int().min(0),
  reconciliationMs: z.number().int().min(0),
  finalizationMs: z.number().int().min(0).nullable().default(null),
  textStages: z.array(ResumeImportTextStageTimingSchema).default([]),
});
export type ResumeImportTimingSummary = z.infer<
  typeof ResumeImportTimingSummarySchema
>;

export const ResumeImportModelRoleStateSchema = z.object({
  text: ResumeImportBranchStateSchema.default({}),
  vision: ResumeImportBranchStateSchema.default({}),
  adjudication: ResumeImportBranchStateSchema.default({}),
});
export type ResumeImportModelRoleState = z.infer<
  typeof ResumeImportModelRoleStateSchema
>;

export const ResumeAnalysisCacheIdentitySchema = z.object({
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  parserFingerprint: NonEmptyStringSchema,
  textProviderKind: AiProviderKindSchema,
  textProviderFingerprint: NonEmptyStringSchema,
  visionProviderKind: AiProviderKindSchema.nullable().default(null),
  visionProviderFingerprint: NonEmptyStringSchema,
  promptVersion: NonEmptyStringSchema,
  schemaVersion: NonEmptyStringSchema,
  policyVersion: NonEmptyStringSchema,
  contextFingerprint: NonEmptyStringSchema,
});
export type ResumeAnalysisCacheIdentity = z.infer<
  typeof ResumeAnalysisCacheIdentitySchema
>;

export const resumeTimelineRepairIssueKindValues = [
  "overlapping_dates",
  "timeline_gap",
  "ambiguous_dates",
  "reversed_dates",
  "split_record",
  "duplicate_record",
  "missing_employer",
  "missing_title",
] as const;
export const ResumeTimelineRepairIssueKindSchema = z.enum(
  resumeTimelineRepairIssueKindValues,
);
export type ResumeTimelineRepairIssueKind = z.infer<
  typeof ResumeTimelineRepairIssueKindSchema
>;

export const resumeTimelineRepairStatusValues = [
  "pending",
  "accepted",
  "rejected",
] as const;
export const ResumeTimelineRepairStatusSchema = z.enum(
  resumeTimelineRepairStatusValues,
);
export type ResumeTimelineRepairStatus = z.infer<
  typeof ResumeTimelineRepairStatusSchema
>;

export const ResumeTimelineRepairCertaintySchema = z.enum([
  "review_only",
  "deterministic_normalization",
]);
export type ResumeTimelineRepairCertainty = z.infer<
  typeof ResumeTimelineRepairCertaintySchema
>;

export const ResumeTimelineRepairEvidenceSchema = z.object({
  candidateId: NonEmptyStringSchema,
  sourceBlockIds: z.array(NonEmptyStringSchema).default([]),
  excerpt: NonEmptyStringSchema,
});
export type ResumeTimelineRepairEvidence = z.infer<
  typeof ResumeTimelineRepairEvidenceSchema
>;

export const ResumeTimelineRepairActionSchema = z.enum([
  "accept",
  "reject",
  "undo",
]);
export type ResumeTimelineRepairAction = z.infer<
  typeof ResumeTimelineRepairActionSchema
>;

export const ResumeTimelineRepairActionEventSchema = z.object({
  action: ResumeTimelineRepairActionSchema,
  occurredAt: IsoDateTimeSchema,
});
export type ResumeTimelineRepairActionEvent = z.infer<
  typeof ResumeTimelineRepairActionEventSchema
>;

export const ResumeTimelineRepairProposalSchema = z.object({
  id: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  issueKind: ResumeTimelineRepairIssueKindSchema,
  status: ResumeTimelineRepairStatusSchema.default("pending"),
  certainty: ResumeTimelineRepairCertaintySchema,
  title: NonEmptyStringSchema,
  explanation: NonEmptyStringSchema,
  affectedExperienceIds: z.array(NonEmptyStringSchema).min(1),
  initiallyPresentExperienceIds: z
    .array(NonEmptyStringSchema)
    .default([])
    .optional(),
  beforeExperiences: z.array(CandidateExperienceSchema).min(1),
  proposedExperiences: z.array(CandidateExperienceSchema).min(1),
  evidence: z.array(ResumeTimelineRepairEvidenceSchema).min(1),
  createdAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.nullable().default(null),
  actionHistory: z.array(ResumeTimelineRepairActionEventSchema).default([]),
});
export type ResumeTimelineRepairProposal = z.infer<
  typeof ResumeTimelineRepairProposalSchema
>;
export const ResumeImportRunSchema = z.object({
  id: NonEmptyStringSchema,
  sourceResumeId: NonEmptyStringSchema,
  sourceResumeFileName: NonEmptyStringSchema,
  trigger: ResumeImportTriggerSchema.default("import"),
  status: ResumeImportRunStatusSchema,
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable().default(null),
  primaryParserKind: ResumeDocumentParserKindSchema.nullable().default(null),
  parserKinds: z.array(ResumeDocumentParserKindSchema).default([]),
  routeKind: ResumeDocumentRouteKindSchema.nullable().optional(),
  parserManifestVersion: NonEmptyStringSchema.nullable().optional(),
  qualityScore: ProbabilitySchema.nullable().optional(),
  analysisProviderKind: AiProviderKindSchema.nullable().default(null),
  analysisProviderLabel: NonEmptyStringSchema.nullable().default(null),
  visionProviderKind: AiProviderKindSchema.nullable().default(null).optional(),
  visionProviderLabel: NonEmptyStringSchema.nullable().default(null).optional(),
  modelRoles: ResumeImportModelRoleStateSchema.default({}).optional(),
  timing: ResumeImportTimingSummarySchema.nullable().default(null).optional(),
  analysisCacheIdentity: ResumeAnalysisCacheIdentitySchema.nullable()
    .default(null)
    .optional(),
  analysisCacheHit: z.boolean().default(false).optional(),
  analysisCacheSourceRunId: NonEmptyStringSchema.nullable()
    .default(null)
    .optional(),
  warnings: z.array(NonEmptyStringSchema).default([]),
  errorMessage: NonEmptyStringSchema.nullable().default(null),
  /**
   * Why a failed run failed, as data. `errorMessage` is copy and may be
   * reworded; surfaces that offer "import again" read this instead.
   */
  failureKind: ResumeImportRunFailureKindSchema.nullable().optional(),
  candidateCounts: ResumeImportRunCandidateCountsSchema.default({}),
  timelineRepairProposals: z
    .array(ResumeTimelineRepairProposalSchema)
    .default([])
    .optional(),
});
export type ResumeImportRun = z.infer<typeof ResumeImportRunSchema>;

export const resumeImportErrorTaxonomyValues = [
  "READING_ORDER",
  "SECTION_BOUNDARY",
  "FIELD_MISATTRIBUTION",
  "DATE_RANGE",
  "ORG_TITLE_SWAP",
  "OCR_NOISE",
  "MISSING_EVIDENCE",
  "OVERCONFIDENT_AUTO_APPLY",
  "UNRESOLVED_SHOULD_HAVE_RESOLVED",
] as const;
export const ResumeImportErrorTaxonomySchema = z.enum(
  resumeImportErrorTaxonomyValues,
);
export type ResumeImportErrorTaxonomy = z.infer<
  typeof ResumeImportErrorTaxonomySchema
>;

export const ResumeImportBenchmarkGoldSchema = z.object({
  literalFields: z.record(ResumeImportJsonValueSchema).default({}),
  summaryContains: z.array(NonEmptyStringSchema).default([]),
  experienceRecords: z.array(z.record(ResumeImportJsonValueSchema)).default([]),
  educationRecords: z.array(z.record(ResumeImportJsonValueSchema)).default([]),
  projectRecords: z.array(z.record(ResumeImportJsonValueSchema)).optional(),
  certificationRecords: z
    .array(z.record(ResumeImportJsonValueSchema))
    .optional(),
  languageRecords: z.array(z.record(ResumeImportJsonValueSchema)).optional(),
  forbiddenProfileText: z.array(NonEmptyStringSchema).optional(),
});
export type ResumeImportBenchmarkGold = z.infer<
  typeof ResumeImportBenchmarkGoldSchema
>;

export const ResumeImportBenchmarkCaseSchema = z.object({
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  resumePath: NonEmptyStringSchema,
  canary: z.boolean().default(false),
  tags: z.array(NonEmptyStringSchema).default([]),
  expected: ResumeImportBenchmarkGoldSchema,
});
export type ResumeImportBenchmarkCase = z.infer<
  typeof ResumeImportBenchmarkCaseSchema
>;

export const ResumeImportBenchmarkRequestSchema = z.object({
  benchmarkVersion: NonEmptyStringSchema.default("019-local-benchmark-v1"),
  cases: z.array(ResumeImportBenchmarkCaseSchema).default([]),
  canaryOnly: z.boolean().default(false),
  useConfiguredAi: z.boolean().default(false),
  useVision: z.boolean().default(false),
});
export type ResumeImportBenchmarkRequest = z.infer<
  typeof ResumeImportBenchmarkRequestSchema
>;

export const ResumeImportBenchmarkMetricsSchema = z.object({
  literalFieldPrecision: ProbabilitySchema.default(0),
  literalFieldRecall: ProbabilitySchema.default(0),
  experienceRecordF1: ProbabilitySchema.default(0),
  experienceDetailAccuracy: ProbabilitySchema.default(0),
  educationRecordF1: ProbabilitySchema.default(0),
  projectRecordF1: ProbabilitySchema.default(0),
  certificationRecordF1: ProbabilitySchema.default(0),
  languageRecordF1: ProbabilitySchema.default(0),
  contradictionFreeRate: ProbabilitySchema.default(0),
  evidenceCoverage: ProbabilitySchema.default(0),
  autoApplyPrecision: ProbabilitySchema.default(0),
  unresolvedRate: ProbabilitySchema.default(0),
});
export type ResumeImportBenchmarkMetrics = z.infer<
  typeof ResumeImportBenchmarkMetricsSchema
>;

export const ResumeImportBenchmarkCaseResultSchema = z.object({
  caseId: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  parserStrategy: NonEmptyStringSchema,
  passed: z.boolean(),
  metrics: ResumeImportBenchmarkMetricsSchema,
  taxonomy: z.array(ResumeImportErrorTaxonomySchema).default([]),
  notes: z.array(NonEmptyStringSchema).default([]),
});
export type ResumeImportBenchmarkCaseResult = z.infer<
  typeof ResumeImportBenchmarkCaseResultSchema
>;

export const ResumeImportBenchmarkReportSchema = z.object({
  benchmarkVersion: NonEmptyStringSchema,
  generatedAt: IsoDateTimeSchema,
  parserManifestVersion: NonEmptyStringSchema.nullable().default(null),
  parserManifestVersions: z.array(NonEmptyStringSchema).default([]),
  analysisProviderKind: AiProviderKindSchema.nullable().default(null),
  analysisProviderLabel: NonEmptyStringSchema.nullable().default(null),
  cases: z.array(ResumeImportBenchmarkCaseResultSchema).default([]),
  aggregate: ResumeImportBenchmarkMetricsSchema,
  notes: z.array(NonEmptyStringSchema).default([]),
});
export type ResumeImportBenchmarkReport = z.infer<
  typeof ResumeImportBenchmarkReportSchema
>;

export function hasModelReadResumeHeader(run: ResumeImportRun | null): boolean {
  return !!run?.timing?.textStages.some(
    (stage) =>
      stage.stage === "identity_summary" &&
      stage.status === "completed" &&
      stage.providerKind === "openai_compatible" &&
      !stage.fallbackKind,
  );
}
