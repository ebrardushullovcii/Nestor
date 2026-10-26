import { z } from "zod";

import type { suiteModules } from "./plain-values";

export const IsoDateTimeSchema = z.string().datetime();
export const NonEmptyStringSchema = z.string().trim().min(1);
export const UrlStringSchema = z.string().trim().url();

export { suiteModules } from "./plain-values";
export type SuiteModule = (typeof suiteModules)[number];

export const applicationStatusValues = [
  "discovered",
  "shortlisted",
  "drafting",
  "ready_for_review",
  "approved",
  "submitted",
  "assessment",
  "interview",
  "rejected",
  "offer",
  "withdrawn",
  "archived",
] as const;

export const ApplicationStatusSchema = z.enum(applicationStatusValues);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

/**
 * True once an application has actually been prepared — a document exists and
 * the person can look at it.
 *
 * `discovered`, `shortlisted` and `drafting` are staging: a run that stopped
 * before the draft existed leaves exactly those behind. Counting them made a
 * plan card say "Applications prepared 11" over eleven rows all badged
 * DRAFTING with no apply attempt, so every surface that counts prepared
 * applications reads this one rule.
 */
export function isPreparedApplicationStatus(record: {
  status: ApplicationStatus;
  lastAttemptState?: ApplicationAttemptState | null | undefined;
}): boolean {
  if (
    record.lastAttemptState === "ready" ||
    record.lastAttemptState === "submitted"
  ) {
    return true;
  }

  switch (record.status) {
    case "ready_for_review":
    case "submitted":
    case "assessment":
    case "interview":
    case "rejected":
    case "offer":
    case "withdrawn":
      return true;
    default:
      return false;
  }
}

/**
 * The one immutable accounting of a finished search run.
 *
 * Six screens used to describe the same run by recomputing counts from
 * whatever inventory they happened to hold, so one search was reported as
 * 100, 50 and 15 depending on where you stood. This report is computed once,
 * frozen when the run reaches its terminal state (and completed once more at
 * the search plan's terminal commit, which is where retention is decided),
 * and read verbatim afterwards. No surface may recompute any of these
 * numbers from current inventory.
 *
 * Every count is nullable on purpose: a run recorded before this report
 * existed genuinely has no such number, and rendering a fabricated 0 would
 * be the same untruth in a new place. Missing values render as
 * "not recorded".
 */
export const DiscoverySourceRunReportSchema = z.object({
  targetId: NonEmptyStringSchema,
  inspected: z.number().int().nonnegative().nullable(),
  saved: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative().nullable(),
  duplicates: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative().nullable(),
  pagesCovered: z.number().int().nonnegative().nullable(),
});
export type DiscoverySourceRunReport = z.infer<
  typeof DiscoverySourceRunReportSchema
>;

export function formatDiscoverySourceAccounting(
  source: DiscoverySourceRunReport,
): string {
  const count = (value: number | null, label: string) => {
    if (value === null) return `${label} not recorded`;
    const noun =
      value === 1
        ? label === "duplicates"
          ? "duplicate"
          : label === "pages covered"
            ? "page covered"
            : label
        : label;
    return `${value} ${noun}`;
  };
  // "0 rejected · 0 deferred" said nothing happened, five times over. A zero
  // is left out; the first count stays so the line always says something.
  const optional = (value: number | null, label: string) =>
    value === 0 ? null : count(value, label);
  return [
    count(source.inspected, "inspected"),
    optional(source.saved, "saved"),
    optional(source.rejected, "rejected"),
    optional(source.duplicates, "duplicates"),
    optional(source.deferred, "deferred"),
    optional(source.pagesCovered, "pages covered"),
  ]
    .filter((segment) => segment !== null)
    .join(" · ");
}

export const DiscoveryRunReportSchema = z.object({
  sources: z.array(DiscoverySourceRunReportSchema).optional(),
  rejected: z.number().int().nonnegative().nullable().optional(),
  deferred: z.number().int().nonnegative().nullable().optional(),
  pagesCovered: z.number().int().nonnegative().nullable().optional(),
  /** Schema generation, so a later counting change is detectable. */
  version: z.union([z.literal(1), z.literal(2)]).default(1),
  /** When the counts were frozen. */
  measuredAt: IsoDateTimeSchema,
  /** Listings this run reviewed, duplicates and rejects included. */
  found: z.number().int().nonnegative().nullable().default(null),
  /** Distinct job identities encountered, after merging duplicate postings. */
  unique: z.number().int().nonnegative().nullable().optional(),
  /** Jobs this run added to the device for the first time. */
  new: z.number().int().nonnegative().nullable().default(null),
  /** Distinct listings this run durably persisted or staged. */
  saved: z.number().int().nonnegative().nullable().default(null),
  /**
   * Saved listings the search plan's rules kept. Null until the plan's
   * terminal commit decides retention; a run with no plan retains everything
   * it saved.
   */
  retained: z.number().int().nonnegative().nullable().default(null),
  /** Retained listings the recommendation classifier leads with. */
  worthOpening: z.number().int().nonnegative().nullable().default(null),
  /** Valid listings that merged into already-known jobs. */
  duplicates: z.number().int().nonnegative().nullable().default(null),
  /**
   * Listings this run met that the search plan already held before it started.
   *
   * Distinct from `duplicates`, which counts every merge the run made —
   * including a listing two sources both returned inside this one run. A first
   * search on an empty workspace has nothing here already, so this is 0 while
   * the duplicate tally can be large. Null until the plan's terminal commit
   * measures it, and for runs recorded before it existed.
   */
  alreadyHere: z.number().int().nonnegative().nullable().optional(),
  /** Retention settings frozen when the search plan committed this run. */
  retentionLimitApplied: z.number().int().positive().nullable().optional(),
  minimumFitScoreApplied: z
    .number()
    .int()
    .min(0)
    .max(100)
    .nullable()
    .optional(),
});
export type DiscoveryRunReport = z.infer<typeof DiscoveryRunReportSchema>;

export const approvalModeValues = [
  "draft_only",
  "review_before_submit",
  "one_click_approve",
  "full_auto",
] as const;

export const ApprovalModeSchema = z.enum(approvalModeValues);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

export const tailoringModeValues = [
  "conservative",
  "balanced",
  "aggressive",
] as const;

export const TailoringModeSchema = z.enum(tailoringModeValues);
export type TailoringMode = z.infer<typeof TailoringModeSchema>;

/**
 * The strength that actually runs for a draft: a named resume approach
 * overrides the global preference; otherwise the preference is the default.
 */
export function resolveEffectiveResumeTailoringStrength(input: {
  strategyTailoringStrength?: TailoringMode | null;
  searchPreferencesTailoringMode?: TailoringMode | null;
}): TailoringMode | null {
  return (
    input.strategyTailoringStrength ??
    input.searchPreferencesTailoringMode ??
    null
  );
}

export const resumeApplicationModeValues = [
  "tailored_per_job",
  "original_resume",
] as const;

export const ResumeApplicationModeSchema = z.enum(resumeApplicationModeValues);
export type ResumeApplicationMode = z.infer<typeof ResumeApplicationModeSchema>;

export const appearanceThemeValues = ["dark", "light", "system"] as const;

export const AppearanceThemeSchema = z.enum(appearanceThemeValues);
export type AppearanceTheme = z.infer<typeof AppearanceThemeSchema>;

export const jobSourceValues = ["target_site"] as const;

/**
 * Bucket key for outcomes whose originating job source is not known.
 *
 * Outcomes are grouped by the saved source the job came from. An outcome
 * recorded before that lineage existed, or for a job whose source was
 * removed, has no id to group by; it goes here instead of being hidden, so
 * the sum of the source buckets still equals the outcomes recorded.
 */
export const UNKNOWN_JOB_SOURCE_BUCKET_KEY = "unknown_source";

function normalizeLegacyJobSource(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "generic_site" || normalized === "linkedin") {
    return "target_site";
  }

  return value;
}

export const JobSourceSchema = z.preprocess(
  normalizeLegacyJobSource,
  z.enum(jobSourceValues),
);
export type JobSource = z.infer<typeof JobSourceSchema>;

export const jobSourceAdapterKindValues = ["auto"] as const;

function normalizeLegacyJobSourceAdapterKind(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toLowerCase();

  if (
    normalized === "linkedin" ||
    normalized === "generic_site" ||
    normalized === "target_site"
  ) {
    return "auto";
  }

  return value;
}

export const JobSourceAdapterKindSchema = z.preprocess(
  normalizeLegacyJobSourceAdapterKind,
  z.enum(jobSourceAdapterKindValues),
);
export type JobSourceAdapterKind = z.infer<typeof JobSourceAdapterKindSchema>;

export const workModeValues = [
  "remote",
  "hybrid",
  "onsite",
  "flexible",
] as const;

export const WorkModeSchema = z.enum(workModeValues);
export type WorkMode = z.infer<typeof WorkModeSchema>;

function normalizeWorkModeValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toLowerCase();

  if (
    normalized === "in_office" ||
    normalized === "in office" ||
    normalized === "on-site" ||
    normalized === "on site"
  ) {
    return "onsite";
  }

  return normalized;
}

export function normalizeWorkModeList(value: unknown): unknown {
  if (value == null) {
    return [];
  }

  if (Array.isArray(value)) {
    const results: unknown[] = [];
    for (const entry of value) {
      if (typeof entry === "string") {
        if (entry.trim()) {
          for (const part of entry.split(/\s*,\s*/).filter(Boolean)) {
            results.push(normalizeWorkModeValue(part));
          }
        }
      } else {
        results.push(normalizeWorkModeValue(entry));
      }
    }
    return results;
  }

  if (typeof value === "string") {
    if (!value.trim()) return [];
    return value
      .split(/\s*,\s*/)
      .filter(Boolean)
      .map(normalizeWorkModeValue);
  }

  return value;
}

export const WorkModeListSchema = z.preprocess(
  normalizeWorkModeList,
  z.array(WorkModeSchema).default([]),
);

export const jobApplyPathValues = [
  "easy_apply",
  "external_redirect",
  "unknown",
] as const;

export const JobApplyPathSchema = z.enum(jobApplyPathValues);
export type JobApplyPath = z.infer<typeof JobApplyPathSchema>;

export const assetStatusValues = [
  "not_started",
  "queued",
  "generating",
  "ready",
  "failed",
] as const;

export const AssetStatusSchema = z.enum(assetStatusValues);
export type AssetStatus = z.infer<typeof AssetStatusSchema>;

export const browserSessionStatusValues = [
  "unknown",
  "ready",
  "login_required",
  "blocked",
] as const;

export const BrowserSessionStatusSchema = z.enum(browserSessionStatusValues);
export type BrowserSessionStatus = z.infer<typeof BrowserSessionStatusSchema>;

export const sourceAccessPromptStateValues = [
  "prompt_login_required",
  "prompt_login_recommended",
] as const;

export const SourceAccessPromptStateSchema = z.enum(
  sourceAccessPromptStateValues,
);
export type SourceAccessPromptState = z.infer<
  typeof SourceAccessPromptStateSchema
>;

/**
 * `uninitialized` is the honest answer before any browser runtime session
 * exists: the lane is not yet known, and it is specifically *not* the
 * catalog-only lane. `catalog_seed` is a claim that the app is running
 * without a browser at all, so it must never stand in for "not started yet".
 */
export const browserDriverValues = [
  "catalog_seed",
  "chrome_profile_agent",
  "embedded_browser_agent",
  "uninitialized",
] as const;

export const BrowserDriverSchema = z.enum(browserDriverValues);
export type BrowserDriver = z.infer<typeof BrowserDriverSchema>;

export const browserRunCloseoutModeValues = ["closed", "kept_alive"] as const;

export const BrowserRunCloseoutModeSchema = z.enum(
  browserRunCloseoutModeValues,
);
export type BrowserRunCloseoutMode = z.infer<
  typeof BrowserRunCloseoutModeSchema
>;

export const BrowserRunCloseoutSchema = z.object({
  mode: BrowserRunCloseoutModeSchema.default("closed"),
  label: NonEmptyStringSchema,
  detail: NonEmptyStringSchema.nullable().default(null),
  status: BrowserSessionStatusSchema,
  driver: BrowserDriverSchema.default("catalog_seed"),
  occurredAt: IsoDateTimeSchema,
});
export type BrowserRunCloseout = z.infer<typeof BrowserRunCloseoutSchema>;

export const resumeExtractionStatusValues = [
  "not_started",
  "needs_text",
  "ready",
  "failed",
] as const;

export const ResumeExtractionStatusSchema = z.enum(
  resumeExtractionStatusValues,
);
export type ResumeExtractionStatus = z.infer<
  typeof ResumeExtractionStatusSchema
>;

export const jobDiscoveryMethodValues = [
  "catalog_seed",
  "browser_agent",
  "public_api",
] as const;

export const JobDiscoveryMethodSchema = z.enum(jobDiscoveryMethodValues);

export const jobDiscoveryCollectionMethodValues = [
  "api",
  "listing_route",
  "careers_page",
  "fallback_search",
] as const;

export const JobDiscoveryCollectionMethodSchema = z.enum(
  jobDiscoveryCollectionMethodValues,
);
export type JobDiscoveryCollectionMethod = z.infer<
  typeof JobDiscoveryCollectionMethodSchema
>;

export const discoveryRunScopeValues = ["single_target", "run_all"] as const;

export const DiscoveryRunScopeSchema = z.enum(discoveryRunScopeValues);

export const discoveryTitleTriageOutcomeValues = [
  "pass",
  "skip_title",
  "skip_location",
  "skip_work_mode",
  "skip_company",
  "skip_handled",
  "skip_existing",
] as const;

export const DiscoveryTitleTriageOutcomeSchema = z.enum(
  discoveryTitleTriageOutcomeValues,
);
export type DiscoveryTitleTriageOutcome = z.infer<
  typeof DiscoveryTitleTriageOutcomeSchema
>;

export const sourceIntelligenceProviderKeyValues = [
  "linkedin",
  "greenhouse",
  "lever",
  "ashby",
  "workday",
  "icims",
  "smartrecruiters",
  "teamtailor",
  "other",
] as const;

export const SourceIntelligenceProviderKeySchema = z.enum(
  sourceIntelligenceProviderKeyValues,
);

export const sourceIntelligenceApiAvailabilityValues = [
  "available",
  "unconfirmed",
  "not_supported",
] as const;

export const SourceIntelligenceApiAvailabilitySchema = z.enum(
  sourceIntelligenceApiAvailabilityValues,
);
export type SourceIntelligenceApiAvailability = z.infer<
  typeof SourceIntelligenceApiAvailabilitySchema
>;

export const discoveryRunStateValues = [
  "idle",
  "running",
  "completed",
  "cancelled",
  "failed",
] as const;

export const DiscoveryRunStateSchema = z.enum(discoveryRunStateValues);
export type DiscoveryRunState = z.infer<typeof DiscoveryRunStateSchema>;

export const sourceDebugRunStateValues = [
  "idle",
  "running",
  "paused_manual",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
] as const;

export const SourceDebugRunStateSchema = z.enum(sourceDebugRunStateValues);
export type SourceDebugRunState = z.infer<typeof SourceDebugRunStateSchema>;

export const sourceDebugPhaseValues = [
  "access_auth_probe",
  "site_structure_mapping",
  "search_filter_probe",
  "job_detail_validation",
  "apply_path_validation",
  "replay_verification",
] as const;

export const SourceDebugPhaseSchema = z.enum(sourceDebugPhaseValues);
export type SourceDebugPhase = z.infer<typeof SourceDebugPhaseSchema>;

export const browserRunWaitReasonValues = [
  "starting_browser",
  "attaching_browser",
  "waiting_on_page",
  "waiting_on_ai",
  "analyzing_visual_snapshot",
  "retrying_ai",
  "executing_tool",
  "retrying_tool",
  "extracting_jobs",
  "merging_results",
  "persisting_results",
  "manual_prerequisite",
  "finalizing",
] as const;

export const BrowserRunWaitReasonSchema = z.enum(browserRunWaitReasonValues);

export const sourceDebugAttemptOutcomeValues = [
  "succeeded",
  "partial",
  "blocked_auth",
  "blocked_manual_step",
  "blocked_site_protection",
  "unsupported_layout",
  "exhausted_duplicate_paths",
  "exhausted_no_progress",
  "failed_runtime",
  "interrupted",
] as const;

export const SourceDebugAttemptOutcomeSchema = z.enum(
  sourceDebugAttemptOutcomeValues,
);
export type SourceDebugAttemptOutcome = z.infer<
  typeof SourceDebugAttemptOutcomeSchema
>;

export const sourceDebugPhaseCompletionModeValues = [
  "structured_finish",
  "forced_finish",
  "timed_out_with_partial_evidence",
  "timed_out_without_evidence",
  "blocked_auth",
  "blocked_manual_step",
  "blocked_site_protection",
  "runtime_failed",
  "interrupted",
  /**
   * The phase stopped because nothing was moving: the agent itself said it
   * was stuck, or the host saw no measurable progress even after asking it
   * to change approach.
   */
  "stalled",
] as const;

export const SourceDebugPhaseCompletionModeSchema = z.enum(
  sourceDebugPhaseCompletionModeValues,
);
export type SourceDebugPhaseCompletionMode = z.infer<
  typeof SourceDebugPhaseCompletionModeSchema
>;

export const sourceInstructionStatusValues = [
  "missing",
  "draft",
  "validated",
  "stale",
  "unsupported",
] as const;

export const SourceInstructionStatusSchema = z.enum(
  sourceInstructionStatusValues,
);
export type SourceInstructionStatus = z.infer<
  typeof SourceInstructionStatusSchema
>;

export const sourceInstructionVerificationOutcomeValues = [
  "unverified",
  "passed",
  "failed",
  "stale",
] as const;

export const SourceInstructionVerificationOutcomeSchema = z.enum(
  sourceInstructionVerificationOutcomeValues,
);
export type SourceInstructionVerificationOutcome = z.infer<
  typeof SourceInstructionVerificationOutcomeSchema
>;

export const sourceDebugEvidenceKindValues = [
  "url",
  "screenshot",
  "note",
] as const;

export const SourceDebugEvidenceKindSchema = z.enum(
  sourceDebugEvidenceKindValues,
);
export type SourceDebugEvidenceKind = z.infer<
  typeof SourceDebugEvidenceKindSchema
>;

export const discoveryTargetExecutionStateValues = [
  "planned",
  "running",
  "completed",
  "cancelled",
  "failed",
  "skipped",
] as const;

export const DiscoveryTargetExecutionStateSchema = z.enum(
  discoveryTargetExecutionStateValues,
);
export type DiscoveryTargetExecutionState = z.infer<
  typeof DiscoveryTargetExecutionStateSchema
>;

export const discoveryActivityKindValues = [
  "info",
  "progress",
  "warning",
  "success",
  "error",
] as const;

export const DiscoveryActivityKindSchema = z.enum(discoveryActivityKindValues);
export type DiscoveryActivityKind = z.infer<typeof DiscoveryActivityKindSchema>;

export const discoveryActivityTerminalStateValues = [
  "completed",
  "failed",
  "cancelled",
  "skipped",
] as const;

export const DiscoveryActivityTerminalStateSchema = z.enum(
  discoveryActivityTerminalStateValues,
);
export type DiscoveryActivityTerminalState = z.infer<
  typeof DiscoveryActivityTerminalStateSchema
>;

export const discoveryActivityStageValues = [
  "planning",
  "target",
  "navigation",
  "extraction",
  "scoring",
  "persistence",
  "run",
] as const;

export const DiscoveryActivityStageSchema = z.enum(
  discoveryActivityStageValues,
);
export type DiscoveryActivityStage = z.infer<
  typeof DiscoveryActivityStageSchema
>;

export const assetGenerationMethodValues = [
  "deterministic",
  "ai_assisted",
] as const;

export const AssetGenerationMethodSchema = z.enum(assetGenerationMethodValues);
export type AssetGenerationMethod = z.infer<typeof AssetGenerationMethodSchema>;

/**
 * Why a generated asset ended up on the deterministic path. `null` means the
 * configured model produced the accepted content. The reason is recorded by
 * the AI boundary that made the decision, never inferred from note prose.
 */
export const assetGenerationReasonValues = [
  "no_provider_configured",
  "provider_failed",
  "provider_timeout",
  "provider_output_unverified",
  "forced_deterministic",
  // The posting carried no listing body (card-only capture), so there was
  // nothing to tailor toward and the model was never asked.
  "listing_text_missing",
  // The posting carried a body, but nothing in it distinguishes this job from
  // any other: tailoring toward it would produce the same draft for unrelated
  // roles, which is what "tailored" must never mean.
  "listing_text_not_distinguishing",
] as const;

export const AssetGenerationReasonSchema = z.enum(assetGenerationReasonValues);
export type AssetGenerationReason = z.infer<typeof AssetGenerationReasonSchema>;

export const aiProviderKindValues = [
  "deterministic",
  "openai_compatible",
  "openai_compatible_vision",
] as const;

export const AiProviderKindSchema = z.enum(aiProviderKindValues);
export type AiProviderKind = z.infer<typeof AiProviderKindSchema>;

export const applicationAttemptStateValues = [
  "not_started",
  "ready",
  "in_progress",
  "paused",
  "submitted",
  "failed",
  "cancelled",
  "unsupported",
] as const;

export const ApplicationAttemptStateSchema = z.enum(
  applicationAttemptStateValues,
);
export type ApplicationAttemptState = z.infer<
  typeof ApplicationAttemptStateSchema
>;

export const documentFormatValues = ["html", "pdf", "docx"] as const;

export const DocumentFormatSchema = z.enum(documentFormatValues);
export type DocumentFormat = z.infer<typeof DocumentFormatSchema>;

export const resumeTemplateIdValues = [
  "classic_ats",
  "modern_split",
  "compact_exec",
  "technical_matrix",
  "project_showcase",
  "credentials_focus",
  "timeline_longform",
  "career_pivot",
] as const;

export const ResumeTemplateIdSchema = z.enum(resumeTemplateIdValues);
export type ResumeTemplateId = z.infer<typeof ResumeTemplateIdSchema>;

export const documentFontPresetValues = [
  "inter_requisite",
  "space_grotesk_display",
] as const;

export const DocumentFontPresetSchema = z.enum(documentFontPresetValues);
export type DocumentFontPreset = z.infer<typeof DocumentFontPresetSchema>;

export const applicationEventEmphasisValues = [
  "neutral",
  "positive",
  "warning",
  "critical",
] as const;

export const ApplicationEventEmphasisSchema = z.enum(
  applicationEventEmphasisValues,
);
export type ApplicationEventEmphasis = z.infer<
  typeof ApplicationEventEmphasisSchema
>;

/**
 * Asking the operating system to show a file the app just wrote.
 *
 * The export already told the person where the PDF landed and then left them
 * to find it by hand. Revealing a path is not opening a file: the OS selects
 * it in the file manager and nothing is executed, so the app never runs what
 * it wrote.
 */
export const RevealSavedFileInputSchema = z.object({
  path: NonEmptyStringSchema,
});
export type RevealSavedFileInput = z.infer<typeof RevealSavedFileInputSchema>;

export const revealSavedFileOutcomeValues = [
  "revealed",
  "not_found",
  "unsupported",
] as const;
export const RevealSavedFileOutcomeSchema = z.enum(
  revealSavedFileOutcomeValues,
);
export type RevealSavedFileOutcome = z.infer<
  typeof RevealSavedFileOutcomeSchema
>;

export const RevealSavedFileResultSchema = z.object({
  outcome: RevealSavedFileOutcomeSchema,
});
export type RevealSavedFileResult = z.infer<typeof RevealSavedFileResultSchema>;

/** Text the desktop shell may copy to the operating system clipboard. */
export const WriteClipboardTextInputSchema = z.object({
  text: z.string().max(100_000),
});
export type WriteClipboardTextInput = z.infer<
  typeof WriteClipboardTextInputSchema
>;
export const WriteClipboardTextResultSchema = z.object({
  written: z.literal(true),
});
export type WriteClipboardTextResult = z.infer<
  typeof WriteClipboardTextResultSchema
>;

/** Add the missing scheme on a public domain; leave malformed input for validation. */
export function normalizePublicLinkUrl(value: string): string {
  let normalized = value.trim();
  if (
    !/^[a-z][a-z\d+.-]*:/i.test(normalized) &&
    /^[^\s/@:]+\.[^\s/@:]+(?::\d+)?(?:[/?#].*)?$/.test(normalized)
  ) {
    normalized = `https://${normalized}`;
  }
  try {
    return new URL(normalized).toString();
  } catch {
    return normalized;
  }
}
