import {
  hasModelReadResumeHeader,
  PROFILE_SETUP_PLACEHOLDER_HEADLINE,
  PROFILE_SETUP_PLACEHOLDER_SUMMARY,
  isInterruptedResumeImportRun,
  isResumeImportRunInProgress,
  RESUME_IMPORT_INTERRUPTED_MESSAGE,
  type AssetStatus,
  type CandidateProfile,
  type ResumeExtractionStatus,
  type ResumeImportFieldCandidateSummary,
  type ResumeImportProgressEvent,
  type ResumeImportRun,
  type ResumeTimelineRepairAction,
} from "@nestor/contracts";
import { Sparkles, Upload } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import {
  formatDateOnly,
  formatResumeAnalysisSummary,
  getAssetTone,
} from "@renderer/features/job-finder/lib/job-finder-utils";
import { getVisibleYearsExperience } from "@renderer/features/job-finder/lib/profile-resume-panel-utils";
import { Field, FieldLabel } from "@renderer/components/ui/field";
import type { UseFormReturn } from "react-hook-form";
import type { ProfileEditorValues } from "../../lib/profile-editor";
import { PreferenceList } from "../preference-list";
import { StatusBadge } from "../status-badge";
import { ProfileImportSuggestionList } from "./profile-import-suggestion-list";
import { ProfileTextarea } from "./profile-form-primitives";
import { ProfileTimelineRepairList } from "./profile-timeline-repair-list";
import { getResumeImportStageFallbackSummary } from "./resume-import-quality-note";
import { ResumeImportProgress } from "./resume-import-progress";

const PROFILE_PLACEHOLDER_HEADLINE = PROFILE_SETUP_PLACEHOLDER_HEADLINE;
const PROFILE_PLACEHOLDER_SUMMARY = PROFILE_SETUP_PLACEHOLDER_SUMMARY;
const RESUME_PLACEHOLDER_FILE_NAME = "No resume imported yet";

function isPlaceholderValue(
  value: string | null | undefined,
  placeholder: string,
) {
  return value?.trim().toLowerCase() === placeholder.toLowerCase();
}

function getImportedIdentityStatus(input: {
  headline: string;
  latestResumeImportReviewCandidates: readonly ResumeImportFieldCandidateSummary[];
  summary: string;
}) {
  const reviewKeys = new Set(
    input.latestResumeImportReviewCandidates
      .filter((candidate) => candidate.target.section === "identity")
      .map((candidate) => candidate.target.key),
  );

  const headlinePending =
    isPlaceholderValue(input.headline, PROFILE_PLACEHOLDER_HEADLINE) ||
    reviewKeys.has("headline");
  const summaryPending =
    isPlaceholderValue(input.summary, PROFILE_PLACEHOLDER_SUMMARY) ||
    reviewKeys.has("summary");

  if (headlinePending && summaryPending) {
    return {
      headline: "Imported identity still needs review",
      headlinePending,
      description:
        "Headline and summary still need a quick confirmation before this imported profile reads as complete.",
    };
  }

  if (headlinePending) {
    return {
      headline: "Imported headline still needs review",
      headlinePending,
      description:
        "Confirm or edit the imported headline so your profile and tailored resumes describe your target clearly.",
    };
  }

  if (summaryPending) {
    return {
      headline: "Imported summary still needs review",
      headlinePending,
      description:
        "Confirm or tighten the imported summary so this profile is ready to reuse across discovery and resumes.",
    };
  }

  return null;
}

interface ProfileResumePanelProps {
  sourceInfo?: {hasResumeText:boolean;hasSavedResumeFile:boolean};
  compact?: boolean;
  importDisabledReason?: string | null;
  isProfileReady?: boolean;
  isAnalyzeProfilePending: boolean;
  isImportResumePending: boolean;
  latestResumeImportReviewCandidates: readonly ResumeImportFieldCandidateSummary[];
  resumeImportProgress: ResumeImportProgressEvent | null;
  latestResumeImportRun: ResumeImportRun | null;
  onAnalyzeProfileFromResume: () => void;
  onApplyTimelineRepairAction: (
    proposalId: string,
    action: ResumeTimelineRepairAction,
  ) => Promise<void>;
  onImportResume: () => void;
  /** Imports again the file a stopped import saved; no file picker. */
  onRetryInterruptedImport?: () => void;
  onReviewImportSuggestion?: (
    candidate: ResumeImportFieldCandidateSummary,
  ) => void;
  profileForm: UseFormReturn<ProfileEditorValues>;
  profile: CandidateProfile;
}

/**
 * The resume strip's label and tone come from one derivation so they can
 * never disagree. The profile's own extraction status is authoritative: a
 * resume whose fields were already extracted and applied reads as imported
 * even when a later import stage (for example the deferred visual scan)
 * recorded a warning. "Failed" is reserved for a genuinely failed
 * extraction on the profile itself.
 */
export function resolveResumeStripStatus(input: {
  extractionStatus: ResumeExtractionStatus;
  hasImportedResume: boolean;
  isProfileReady: boolean;
  latestRun: Pick<ResumeImportRun, "status"> | null;
  pendingReviewCount: number;
}): { label: string; tone: AssetStatus } {
  if (!input.hasImportedResume) {
    return { label: "Not imported", tone: "not_started" };
  }

  if (input.pendingReviewCount > 0) {
    return input.isProfileReady
      ? { label: "Ready", tone: "ready" }
      : { label: "Needs review", tone: "queued" };
  }

  if (isResumeImportRunInProgress(input.latestRun)) {
    return { label: "Importing", tone: "queued" };
  }

  switch (input.extractionStatus) {
    case "ready":
      return { label: "Imported", tone: "ready" };
    case "failed":
      return { label: "Import failed", tone: "failed" };
    case "needs_text":
      return { label: "Needs better text", tone: "queued" };
    case "not_started":
      return input.latestRun?.status === "failed"
        ? { label: "Import failed", tone: "failed" }
        : { label: "Ready to refresh", tone: "not_started" };
    default:
      return { label: "Imported", tone: "ready" };
  }
}
/**
 * Written by `describeResumeImportStageFallback` in the import workflow. These
 * sentences say, in plain language, which part of the resume the configured
 * model never got to read. They are rendered on their own as the import
 * quality note, so they are kept out of the general notes list rather than
 * printed twice.
 */
const RESUME_IMPORT_STAGE_FALLBACK_PATTERN =
  /^job finder could not use the ai model for /;

export function getResumeImportStageFallbackNotes(
  warnings: readonly string[],
): string[] {
  return warnings.filter((warning) =>
    RESUME_IMPORT_STAGE_FALLBACK_PATTERN.test(warning.trim().toLowerCase()),
  );
}

/**
 * The notes Job Finder itself writes for the person after an import. The
 * stored list also carries the import model's own working notes ("No target
 * roles or salary statements; search_preferences omitted.", "Per
 * instructions, do not create…") and parser diagnostics; those are for
 * debugging and never shown under Import notes.
 */
const PERSON_FACING_IMPORT_NOTE_PATTERNS: readonly RegExp[] = [
  /^\d+ optional proof suggestions? (?:is|are) available to review\b/u,
  /^paste plain-text resume content\b/u,
  /^could not import\b/u,
  /^job finder could not read\b/u,
];

export function isPersonFacingImportNote(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return PERSON_FACING_IMPORT_NOTE_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

function shouldHideAnalysisWarning(value: string): boolean {
  const normalized = value.trim().toLowerCase();

  return (
    RESUME_IMPORT_STAGE_FALLBACK_PATTERN.test(normalized) ||
    normalized.includes("pdfplumber is unavailable") ||
    /^\d+ imported suggestions? still need review\b/.test(normalized) ||
    normalized.includes("pypdf is unavailable") ||
    normalized.includes(
      "python resume parser sidecar returned no usable parse",
    ) ||
    normalized.includes("python resume parser sidecar fallback:") ||
    normalized.includes(
      "fell back to the deterministic staged resume importer after the model call failed",
    ) ||
    normalized.includes("primary ai import stage failed:") ||
    normalized.includes(
      "fell back to the deterministic resume parser after the model call failed",
    ) ||
    normalized.includes("primary ai extraction failed:") ||
    // Vision-branch diagnostics are provider output, not advice for the user.
    normalized.includes("vision branch used") ||
    normalized.includes("configured resume vision provider failed") ||
    normalized.startsWith("error from provider (")
  );
}

export function getFallbackResumeImportWarnings(
  warnings: readonly string[],
): string[] {
  // A named stage that lost its model call is the specific, actionable version
  // of this note, so it wins over the generic "a fallback path was used" copy.
  const stageFallbackNotes = getResumeImportStageFallbackNotes(warnings);

  if (stageFallbackNotes.length > 0) {
    return stageFallbackNotes;
  }

  const normalizedWarnings = warnings.map((warning) =>
    warning.trim().toLowerCase(),
  );
  const usedFallback = normalizedWarnings.some(
    (warning) =>
      warning.includes("python resume parser sidecar fallback:") ||
      warning.includes(
        "python resume parser sidecar returned no usable parse",
      ) ||
      warning.includes(
        "fell back to the deterministic staged resume importer after the model call failed",
      ) ||
      warning.includes(
        "fell back to the deterministic resume parser after the model call failed",
      ) ||
      warning.includes("primary ai import stage failed:") ||
      warning.includes("primary ai extraction failed:"),
  );

  if (!usedFallback) {
    return [];
  }

  return [
    "This import used a fallback parsing path, so review the imported details more closely before saving them.",
  ];
}

function getResumePanelCopy(input: {
  extractionStatus: ResumeExtractionStatus;
  hasImportedResume: boolean;
  isProfileReady: boolean;
  pendingReviewCount: number;
  resumeTextReadyToAnalyze: boolean;
}): { headline: string; description: string } {
  const {
    extractionStatus,
    hasImportedResume,
    isProfileReady,
    pendingReviewCount,
    resumeTextReadyToAnalyze,
  } = input;

  if (resumeTextReadyToAnalyze && pendingReviewCount > 0) {
    if (isProfileReady) {
      return {
        headline: "Resume ready — optional suggestions available",
        description: `${pendingReviewCount} optional imported suggestion${pendingReviewCount === 1 ? " is" : "s are"} saved for later review. ${pendingReviewCount === 1 ? "It does" : "They do"} not block job search or safe application preparation.`,
      };
    }

    return {
      headline: "Review imported suggestions",
      description: `${pendingReviewCount} imported suggestion${pendingReviewCount === 1 ? "" : "s"} still need${pendingReviewCount === 1 ? "s" : ""} your decision before this resume is ready to reuse everywhere.`,
    };
  }

  if (resumeTextReadyToAnalyze) {
    return {
      headline: "Your resume is ready to reuse",
      description:
        "Replace the file to import a newer resume, or refresh to read this one again.",
    };
  }

  if (hasImportedResume) {
    return extractionStatus === "failed"
      ? {
          headline:
            "This resume needs another import before it can help your profile",
          description:
            "The last import did not produce usable text. Replace the file, then refresh your profile suggestions once the text is ready.",
        }
      : {
          headline: "Job Finder could not read text from this file",
          description:
            "It may be a scan or an image. It still goes out unchanged as your Original resume. To fill your profile from it, replace it with a DOCX or a PDF saved from a document editor, or paste the text below.",
        };
  }

  return {
    headline: "Import your resume to fill in your profile faster",
    description:
      "Job Finder suggests profile details from the imported text. You choose what to keep.",
  };
}

export function ProfileResumePanel({
  sourceInfo,
  compact = false,
  importDisabledReason,
  isProfileReady = false,
  isAnalyzeProfilePending,
  isImportResumePending,
  latestResumeImportReviewCandidates,
  resumeImportProgress,
  latestResumeImportRun,
  onAnalyzeProfileFromResume,
  onApplyTimelineRepairAction,
  onImportResume,
  onRetryInterruptedImport,
  onReviewImportSuggestion,
  profileForm,
  profile,
}: ProfileResumePanelProps) {
  const resumeAnalysisSummary = formatResumeAnalysisSummary(profile);
  const resumeTextReadyToAnalyze = sourceInfo?.hasResumeText ?? Boolean(
    profile.baseResume.textContent?.trim(),
  );
  const rawFileName = profile.baseResume.fileName.trim();
  const hasImportedResume =
    rawFileName.length > 0 &&
    rawFileName.toLowerCase() !== RESUME_PLACEHOLDER_FILE_NAME.toLowerCase();
  const showResumeTextRecovery = hasImportedResume && !resumeTextReadyToAnalyze;
  const resumeFileName = hasImportedResume
    ? rawFileName
    : RESUME_PLACEHOLDER_FILE_NAME;
  const originalFileNeedsReimport =
    hasImportedResume &&
    !(sourceInfo?.hasSavedResumeFile ?? Boolean(profile.baseResume.storagePath?.trim() && profile.baseResume.sha256));
  const { headline: panelHeadline, description: panelDescription } =
    getResumePanelCopy({
      extractionStatus: profile.baseResume.extractionStatus,
      hasImportedResume,
      isProfileReady,
      pendingReviewCount: latestResumeImportReviewCandidates.length,
      resumeTextReadyToAnalyze,
    });
  const uploadedLabel =
    hasImportedResume && profile.baseResume.uploadedAt
      ? `Imported ${formatDateOnly(profile.baseResume.uploadedAt)}`
      : "Import your resume to fill in this profile faster.";
  const resumeStripStatus = resolveResumeStripStatus({
    extractionStatus: profile.baseResume.extractionStatus,
    hasImportedResume,
    isProfileReady,
    latestRun: latestResumeImportRun,
    pendingReviewCount: latestResumeImportReviewCandidates.length,
  });
  const extractionStatusLabel = resumeStripStatus.label;
  const displayName =
    profile.preferredDisplayName?.trim() ||
    profile.fullName?.trim() ||
    "Name not set yet";
  const importedIdentityStatus = hasImportedResume
    ? getImportedIdentityStatus({
        headline: profile.headline ?? "",
        latestResumeImportReviewCandidates,
        summary: profile.summary ?? "",
      })
    : null;
  const headline =
    !hasImportedResume &&
    isPlaceholderValue(profile.headline, PROFILE_PLACEHOLDER_HEADLINE)
      ? "Headline not set yet"
      : importedIdentityStatus?.headline &&
          importedIdentityStatus?.headlinePending &&
          isPlaceholderValue(profile.headline, PROFILE_PLACEHOLDER_HEADLINE)
        ? importedIdentityStatus.headline
        : profile.headline?.trim() || "Headline not set yet";
  const location = profile.currentLocation?.trim() || "Location not set yet";
  const visibleYearsExperience = getVisibleYearsExperience({
    profileYearsExperience: profile.yearsExperience,
    reviewCandidates: latestResumeImportReviewCandidates,
  });
  const experienceLabel =
    visibleYearsExperience === null
      ? "Years of experience need review"
      : visibleYearsExperience === 1
        ? "1 year"
        : `${visibleYearsExperience} years`;
  const latestRunSummary = latestResumeImportRun
    ? latestResumeImportRun.status === "review_ready"
      ? `${latestResumeImportRun.candidateCounts.autoApplied} imported automatically, ${latestResumeImportRun.candidateCounts.needsReview} waiting for review.`
      : latestResumeImportRun.status === "applied"
        ? `${latestResumeImportRun.candidateCounts.autoApplied} imported automatically; the resume is ready to use.`
        : latestResumeImportRun.status === "failed"
          ? profile.baseResume.extractionStatus === "ready"
            ? "A later import step could not finish, but the details already extracted from this resume are in your profile."
            : "The latest resume import failed. Replace the file or refresh the import before relying on these details."
          : isResumeImportRunInProgress(latestResumeImportRun)
            ? "The latest resume import is still in progress."
            : null
    : null;
  // Run warnings are secondary: they never change the strip's status, they
  // only explain it in a quieter sentence underneath.
  const latestRunWarning =
    latestResumeImportRun && latestResumeImportRun.status !== "failed"
      ? (latestResumeImportRun.warnings.find(
          (warning) =>
            !shouldHideAnalysisWarning(warning) &&
            /superseded|changed while|could not|not applied|timed out/i.test(
              warning,
            ),
        ) ?? null)
      : null;
  const pendingReviewLabels = new Set(
    latestResumeImportReviewCandidates.map((candidate) =>
      candidate.label.trim().toLowerCase(),
    ),
  );
  const visibleAnalysisWarnings = profile.baseResume.analysisWarnings.filter(
    (warning) =>
      isPersonFacingImportNote(warning) &&
      !shouldHideAnalysisWarning(warning) &&
      !pendingReviewLabels.has(warning.trim().toLowerCase()),
  );
  const fallbackResumeImportWarnings = getFallbackResumeImportWarnings(
    profile.baseResume.analysisWarnings,
  );
  const resumeImportStageFallbackSummary = getResumeImportStageFallbackSummary(
    latestResumeImportRun,
  );
  const resumeStatusTone = resumeStripStatus.tone;
  // An import cut off by the app closing: its file is kept, so importing it
  // again is one press instead of finding the file in a picker.
  const interruptedImport =
    isInterruptedResumeImportRun(latestResumeImportRun ?? null) &&
    !isImportResumePending;
  /* The strip that owns the READY badge owns its qualifier. The detailed
     per-stage prose lives in the full panel below the whole Basics editor,
     thousands of pixels down the column, so an import where every AI stage
     fell back painted an unqualified READY in the only band the user reads.
     Falling back is normal and successful — it only changes what is worth
     double-checking — so this stays a short countable fact, not an error. */
  const compactFallbackHint = resumeImportStageFallbackSummary
    ? `${resumeImportStageFallbackSummary.hint}.`
    : fallbackResumeImportWarnings.length > 0
      ? "Part of this import used the built-in reader."
      : null;

  // The strip is one line when the resume is simply ready: "replace or
  // refresh" repeats its own two buttons. Any state that needs reading
  // (suggestions to review, a failed or unreadable import) keeps its line.
  const compactDescription =
    resumeTextReadyToAnalyze && latestResumeImportReviewCandidates.length === 0
      ? null
      : panelDescription;

  if (compact) {
    return (
      <section
        className="grid gap-2 border-b border-(--surface-panel-border) bg-(--surface-overlay-strong) px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-4"
        data-profile-resume-summary
      >
        <div className="grid min-w-0 gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="text-(length:--text-eyebrow) font-medium uppercase tracking-(--tracking-mono) text-foreground-muted">
              Resume
            </p>
            <StatusBadge tone={getAssetTone(resumeStatusTone)}>
              {extractionStatusLabel}
            </StatusBadge>
            <strong className="min-w-0 truncate text-sm text-(--text-headline)">
              {resumeFileName}
            </strong>
            {compactFallbackHint ? (
              <span
                className="text-sm leading-5 text-foreground-muted"
                data-profile-resume-fallback-hint
              >
                {compactFallbackHint}
              </span>
            ) : null}
          </div>
          {compactDescription ? (
            <p className="text-sm leading-5 text-foreground-muted">
              {compactDescription}
            </p>
          ) : null}
          {latestRunWarning ? (
            <p
              className="text-sm leading-5 text-foreground-muted"
              data-profile-resume-run-warning
            >
              {latestRunWarning}
            </p>
          ) : null}
          {originalFileNeedsReimport ? (
            <p className="text-sm leading-5 text-(--warning-text)" role="alert">
              The saved original resume cannot be verified for applications.
              Replace it before using the original file for an application.
            </p>
          ) : null}
          {interruptedImport ? (
            <p
              className="text-sm leading-5 text-(--warning-text)"
              data-profile-resume-import-interrupted
              role="status"
            >
              {RESUME_IMPORT_INTERRUPTED_MESSAGE}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2 sm:justify-end">
          {interruptedImport && onRetryInterruptedImport ? (
            <Button
              disabled={Boolean(importDisabledReason)}
              pending={isImportResumePending}
              onClick={onRetryInterruptedImport}
              size="compact"
              type="button"
              variant="secondary"
            >
              Import {latestResumeImportRun?.sourceResumeFileName} again
            </Button>
          ) : null}
          <Button
            disabled={Boolean(importDisabledReason)}
            pending={isImportResumePending}
            onClick={onImportResume}
            size="compact"
            type="button"
            variant="secondary"
          >
            <Upload className="size-4" />
            {hasImportedResume ? "Replace resume" : "Import resume"}
          </Button>
          <Button
            disabled={
              isAnalyzeProfilePending ||
              !resumeTextReadyToAnalyze ||
              Boolean(importDisabledReason)
            }
            pending={isAnalyzeProfilePending}
            onClick={onAnalyzeProfileFromResume}
            size="compact"
            type="button"
            variant="outline"
          >
            <Sparkles className="size-4" />
            {/* F80: "Refresh" alone is a verb with no object, and the full
                panel below already calls the same action "Refresh from
                resume". One name for one action. */}
            {hasModelReadResumeHeader(latestResumeImportRun)
              ? "Refresh from resume"
              : "Read my resume again"}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="relative overflow-hidden border-y border-(--surface-panel-border) bg-transparent py-4 sm:py-5">
      <div className="grid gap-5 xl:items-start xl:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
        <div className="grid gap-5">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
            <div className="grid gap-2">
              <p className="text-(length:--text-eyebrow) font-medium uppercase tracking-(--tracking-mono) text-foreground-muted">
                Resume
              </p>
              <div className="grid gap-2">
                <h2 className="font-semibold tracking-[-0.03em] text-(--text-headline)">
                  {panelHeadline}
                </h2>
                <p className="max-w-[62ch] text-(length:--text-description) leading-6 text-foreground-muted">
                  {panelDescription}
                </p>
              </div>
            </div>

            <StatusBadge tone={getAssetTone(resumeStatusTone)}>
              {extractionStatusLabel}
            </StatusBadge>
          </div>

          <article className="grid gap-4 rounded-(--radius-panel) border border-(--surface-panel-border-warm) bg-(--surface-overlay-heavy) p-4">
            <div className="grid gap-1.5">
              <strong className="text-[1.22rem] font-semibold text-(--text-headline)">
                {resumeFileName}
              </strong>
              <span className="text-(length:--text-body) text-foreground-soft">
                {uploadedLabel}
              </span>
              {resumeAnalysisSummary ? (
                <span className="text-(length:--text-description) leading-6 text-foreground-muted">
                  {resumeAnalysisSummary}
                </span>
              ) : latestRunSummary ? (
                <span className="text-(length:--text-description) leading-6 text-foreground-muted">
                  {latestRunSummary}
                </span>
              ) : (
                <span className="text-(length:--text-description) leading-6 text-foreground-muted">
                  {hasImportedResume
                    ? "Refresh your profile suggestions any time you want to pull in changes from the saved resume text."
                    : "Import a resume for faster suggestions, or continue entering profile details manually."}
                </span>
              )}
              {latestRunWarning ? (
                <span
                  className="text-(length:--text-description) leading-6 text-foreground-muted"
                  data-profile-resume-run-warning
                >
                  {latestRunWarning}
                </span>
              ) : null}
            </div>

            {/* The quality note qualifies the import status, so it sits with
                it in ordinary sentences. It used to be an uppercase mono
                `PreferenceList` far below the fold, which read as machine log
                output rather than as something to act on.

                The structured `fallbackKind` recorded on each stage timing is
                the authority: a run whose stages all fell back must show the
                note even when the workflow emitted no matching prose (a
                reworded warning string in main used to silently hide it). The
                prose warnings remain a fallback for legacy runs recorded
                before stage timings carried the structured field. */}
            {resumeImportStageFallbackSummary !== null ||
            fallbackResumeImportWarnings.length > 0 ? (
              <div
                className="grid gap-1.5 border-t border-(--surface-panel-border) pt-3"
                data-profile-resume-quality-note
              >
                {resumeImportStageFallbackSummary ? (
                  <p className="text-(length:--text-description) font-medium leading-6 text-(--text-headline)">
                    {resumeImportStageFallbackSummary.hint}.
                  </p>
                ) : null}
                {fallbackResumeImportWarnings.map((warning) => (
                  <p
                    className="text-(length:--text-description) leading-6 text-foreground-muted"
                    key={warning}
                  >
                    {warning}
                  </p>
                ))}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2.5">
              <Button
                className="h-11 px-4"
                disabled={Boolean(importDisabledReason)}
                pending={isImportResumePending}
                onClick={onImportResume}
                type="button"
                variant="secondary"
              >
                <Upload className="size-4" />
                {hasImportedResume ? "Replace resume" : "Import resume"}
              </Button>
              <Button
                className="h-11 px-4"
                disabled={
                  isAnalyzeProfilePending ||
                  !resumeTextReadyToAnalyze ||
                  Boolean(importDisabledReason)
                }
                pending={isAnalyzeProfilePending}
                onClick={onAnalyzeProfileFromResume}
                type="button"
                variant="primary"
              >
                <Sparkles className="size-4" />
                {hasModelReadResumeHeader(latestResumeImportRun)
                  ? "Refresh from resume"
                  : "Read my resume again"}
              </Button>
            </div>
            <ResumeImportProgress
              isPending={isImportResumePending}
              progress={resumeImportProgress}
            />
            {showResumeTextRecovery ? (
              <Field>
                <FieldLabel htmlFor="profile-resume-recovery-text">
                  Resume text recovery
                </FieldLabel>
                <ProfileTextarea
                  aria-describedby="profile-resume-recovery-text-description"
                  id="profile-resume-recovery-text"
                  placeholder="Paste the plain text of your resume here"
                  rows={10}
                  {...profileForm.register("identity.resumeText")}
                />
                <p
                  className="text-sm leading-6 text-foreground-muted"
                  id="profile-resume-recovery-text-description"
                >
                  If this file has no readable text, paste a plain-text copy
                  here. Save your profile first, then choose Refresh from resume
                  to rebuild profile suggestions from the saved text.
                </p>
              </Field>
            ) : null}
            {importDisabledReason ? (
              <p className="text-sm leading-6 text-foreground-soft">
                {importDisabledReason}
              </p>
            ) : null}
            {originalFileNeedsReimport ? (
              <div
                className="rounded-(--radius-field) border border-(--warning-border) bg-(--warning-surface) px-4 py-3 text-sm leading-6 text-(--warning-text)"
                role="alert"
              >
                The saved original resume cannot be verified for applications.
                Replace it to create a new private copy; your extracted profile
                details will stay available until the new import finishes.
              </div>
            ) : null}
          </article>

          {visibleAnalysisWarnings.length > 0 ||
          latestResumeImportReviewCandidates.length > 0 ||
          (latestResumeImportRun?.timelineRepairProposals?.length ?? 0) > 0 ? (
            <article className="grid gap-3 rounded-(--radius-panel) border border-(--surface-panel-border-warm) bg-(--surface-overlay-strong) p-4">
              <p className="text-(length:--text-eyebrow) font-medium uppercase tracking-(--tracking-mono) text-foreground-muted">
                {isProfileReady ? "Optional review" : "Review before saving"}
              </p>
              {visibleAnalysisWarnings.length > 0 ? (
                <PreferenceList
                  label="Import notes"
                  values={visibleAnalysisWarnings}
                />
              ) : null}
              {importedIdentityStatus ? (
                <PreferenceList
                  label="What to confirm next"
                  values={[importedIdentityStatus.description]}
                />
              ) : null}
              {(latestResumeImportRun?.timelineRepairProposals?.length ?? 0) >
              0 ? (
                <ProfileTimelineRepairList
                  onAction={onApplyTimelineRepairAction}
                  proposals={
                    latestResumeImportRun?.timelineRepairProposals ?? []
                  }
                />
              ) : null}
              {latestResumeImportReviewCandidates.length > 0 ? (
                <div className="grid gap-3">
                  <p className="text-sm font-medium text-foreground">
                    {isProfileReady
                      ? "Optional imported suggestions"
                      : "Imported suggestions waiting for confirmation"}
                  </p>
                  <ProfileImportSuggestionList
                    candidates={latestResumeImportReviewCandidates}
                    {...(onReviewImportSuggestion
                      ? { onReviewCandidate: onReviewImportSuggestion }
                      : {})}
                  />
                </div>
              ) : null}
            </article>
          ) : null}
        </div>

        <aside className="grid gap-3 self-start rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-overlay-strong) p-4">
          <div className="grid gap-1">
            <p className="text-(length:--text-eyebrow) font-medium uppercase tracking-(--tracking-mono) text-foreground-muted">
              {hasImportedResume ? "Imported details" : "Profile details"}
            </p>
            <p className="text-(length:--text-description) leading-6 text-foreground-muted">
              {hasImportedResume
                ? "These details came from your resume. Use the tabs to confirm them and fix anything that needs a closer look."
                : "These are the details currently saved in your profile. Use the tabs to add or update them."}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <div className="rounded-(--radius-field) border border-(--surface-well-border) bg-(--surface-well) p-4">
              <span className="text-(length:--text-eyebrow) font-medium uppercase tracking-(--tracking-mono) text-foreground-muted">
                Name
              </span>
              <strong className="mt-2 block text-[1rem] text-(--text-headline)">
                {displayName}
              </strong>
            </div>
            <div className="rounded-(--radius-field) border border-(--surface-well-border) bg-(--surface-well) p-4">
              <span className="text-(length:--text-eyebrow) font-medium uppercase tracking-(--tracking-mono) text-foreground-muted">
                Headline
              </span>
              <strong className="mt-2 block text-[1rem] text-(--text-headline)">
                {headline}
              </strong>
            </div>
            <div className="rounded-(--radius-field) border border-(--surface-well-border) bg-(--surface-well) p-4">
              <span className="text-(length:--text-eyebrow) font-medium uppercase tracking-(--tracking-mono) text-foreground-muted">
                Location
              </span>
              <strong className="mt-2 block text-[1rem] text-(--text-headline)">
                {location}
              </strong>
            </div>
            <div className="rounded-(--radius-field) border border-(--surface-well-border) bg-(--surface-well) p-4">
              <span className="text-(length:--text-eyebrow) font-medium uppercase tracking-(--tracking-mono) text-foreground-muted">
                Experience
              </span>
              <strong className="mt-2 block text-[1rem] text-(--text-headline)">
                {experienceLabel}
              </strong>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
