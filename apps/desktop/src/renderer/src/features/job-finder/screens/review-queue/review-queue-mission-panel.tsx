import { joinUniqueSentences } from "../../lib/sentence-copy";
import { StatusBadge } from "../../components/status-badge";
import { fitRecommendationCopy } from "../../lib/match-assessment-presentation";
import { Check, ChevronDown, Pencil } from "lucide-react";
import { useCallback, useRef } from "react";
import type {
  ApplicationRecord,
  ApplicationAutomationMode,
  CandidateProfile,
  JobFinderApplicationStartTarget,
  JobFinderRendererWorkspaceSnapshot,
  BrowserSessionState,
  GlobalDailyApplicationPreparationCapacity,
  ResumeApplicationMode,
  TailoringMode,
  ResumeSourceDocument,
  ReviewQueueItem,
  JobListRow,
  TailoredAssetSummary,
} from "@nestor/contracts";
import { Button, ProgressBar } from "@renderer/components/ui";
import { cn } from "@renderer/lib/cn";
import { openUrlInJobFinderBrowser } from "../../components/open-outside-links";
import { formatDailyPreparationCapacitySummaryText } from "../../lib/job-finder-daily-capacity";
import {
  formatResumeOperationElapsed,
  RESUME_DRAFT_EXPECTED_WAIT_LABEL,
} from "./review-queue-progress";
import {
  buildMissionPanelState,
  describeApplyOutcome,
  shouldShowMissionActionMessage,
} from "./review-queue-mission-panel-helpers";
import {
  describeAiUnavailableResume,
  describeUntailorableListing,
} from "./resume-workspace-utils";
import type { ResumeRunStage } from "./review-queue-status";

const dailyCapacityLimitDescriptionId =
  "employer-application-daily-capacity-limit";

interface ReviewQueueMissionPanelProps {
  actionMessage: string | null;
  applicationAutomationMode?: ApplicationAutomationMode;
  applicationRecords: readonly ApplicationRecord[];
  browserSession: BrowserSessionState;
  /** Seconds the current resume run has been going. */
  pendingElapsedSeconds: number;
  globalDailyApplicationPreparationCapacity?: GlobalDailyApplicationPreparationCapacity | null;
  isApplyPending: boolean;
  isJobPending: (jobId: string) => boolean;
  isSelectedJobPendingTooLong?: boolean;
  onStartApplyCopilot: (input: JobFinderApplicationStartTarget) => void;
  onEditResumeWorkspace: (jobId: string) => void;
  /** Approves a Light or Tailored draft and starts the application in one press. */
  onApproveResumeAndApply?: (jobId: string) => void;
  onGenerateResume: (jobId: string) => Promise<boolean>;
  onOpenBrowserSession: () => void;
  onOpenJobDetails: (jobId: string) => void;
  onOpenApplication?: (recordId: string) => void;
  onOpenProfile: () => void;
  /** Takes the person to Safeguards when one is holding preparation back. */
  onOpenSafeguards?: () => void;
  /** Live apply results, so the start control follows the run record. */
  applyJobResults?: JobFinderRendererWorkspaceSnapshot["applyJobResults"];
  /** A safeguard holding preparation back, in plain words. */
  safeguardBlocker?: string | null;
  onClaimResumeIdentity?: () => void;
  onKeepResumeIdentity?: () => void;
  onRemoveReviewJob: (jobId: string) => void;
  onSetJobResumeApplicationMode: (
    jobId: string,
    resumeApplicationMode: ResumeApplicationMode,
    resumeTailoringMode?: TailoringMode | null,
  ) => void;
  originalResume?: ResumeSourceDocument;
  profile?: CandidateProfile;
  selectedAsset: TailoredAssetSummary | null;
  selectedItem: ReviewQueueItem | null;
  selectedJob: JobListRow | null;
  /** The written preference verdict, read with the job detail. */
  preferenceExplanation?: string | null;
  /** Where this job's running resume is, when the run reports it. */
  resumeRunStage?: ResumeRunStage | null;
}

/** The four resume levels a job can be sent with, in order of how far they go. */
type ResumeLevelId = "original" | "light" | "tailored" | "aggressive";
const RESUME_LEVEL_OPTIONS: readonly {
  id: ResumeLevelId;
  label: string;
  detail: string;
  tailoringMode: TailoringMode | null;
}[] = [
  {
    id: "original",
    label: "Original",
    detail: "Your file, unchanged.",
    tailoringMode: null,
  },
  {
    id: "light",
    label: "Light",
    detail: "Light edits; stays close to your wording.",
    tailoringMode: "conservative",
  },
  {
    id: "tailored",
    label: "Tailored",
    detail: "Rewrites bullets to match the posting.",
    tailoringMode: "balanced",
  },
  {
    id: "aggressive",
    label: "Aggressive",
    detail: "Stretches toward the posting to get you the interview.",
    tailoringMode: "aggressive",
  },
];

function getSelectedResumeLevel(
  item: Pick<ReviewQueueItem, "resumeApplicationMode" | "resumeTailoringMode">,
): ResumeLevelId {
  if (item.resumeApplicationMode === "original_resume") return "original";
  switch (item.resumeTailoringMode) {
    case "conservative":
      return "light";
    case "aggressive":
      return "aggressive";
    default:
      return "tailored";
  }
}

const quietActionClassName =
  "h-auto min-h-8 w-fit px-0 text-sm font-medium normal-case tracking-normal";

/**
 * One job's column on Shortlisted, in the order the work happens: pick the
 * resume level, get the resume ready, press Apply. Everything the button
 * needs the person to know is one state line above it and one outcome
 * sentence below it.
 */
export function ReviewQueueMissionPanel({
  actionMessage,
  applicationAutomationMode = "prepare_only",
  applicationRecords,
  browserSession,
  pendingElapsedSeconds,
  globalDailyApplicationPreparationCapacity = null,
  isApplyPending,
  isJobPending,
  isSelectedJobPendingTooLong = false,
  onStartApplyCopilot,
  onEditResumeWorkspace,
  onApproveResumeAndApply,
  onGenerateResume,
  onOpenBrowserSession,
  onOpenJobDetails,
  onOpenApplication = () => undefined,
  onOpenProfile,
  onOpenSafeguards,
  applyJobResults = [],
  safeguardBlocker = null,
  onRemoveReviewJob,
  onSetJobResumeApplicationMode,
  originalResume,
  selectedAsset,
  selectedItem,
  selectedJob,
  preferenceExplanation = null,
  resumeRunStage = null,
}: ReviewQueueMissionPanelProps) {
  const {
    isGenerating,
    isPrimaryApplyPending,
    isSelectedJobPending,
    needsTailoredResume,
    primaryApplicationAction,
    readinessDescription,
    usesOriginalResume,
  } = buildMissionPanelState({
    browserSession,
    isApplyPending,
    isJobPending,
    isSelectedJobPendingTooLong,
    safeguardBlocker,
    selectedApplyResult:
      applyJobResults.find(
        (result) =>
          selectedItem !== null &&
          result.jobId === selectedItem.jobId &&
          (result.state === "planned" ||
            result.state === "filling" ||
            result.state === "question_capture" ||
            result.state === "submitting"),
      ) ?? null,
    selectedAsset,
    selectedItem,
    selectedJob,
    resumeRunStage,
  });
  const existingApplication = selectedItem
    ? (applicationRecords
        .filter((record) => record.jobId === selectedItem.jobId)
        .sort(
          (left, right) =>
            new Date(right.lastUpdatedAt).getTime() -
            new Date(left.lastUpdatedAt).getTime(),
        )[0] ?? null)
    : null;

  // A resume the built-in generator wrote because AI was unavailable is
  // usable, but the person should know and be able to retry in one press.
  // When the next step is reading it (Aggressive), the line says so instead
  // of "apply it as it is" above a "Review the resume" button.
  const aiUnavailableResume =
    selectedItem &&
    !existingApplication &&
    !usesOriginalResume &&
    !isGenerating &&
    selectedItem.resumeReview.status !== "approved"
      ? describeAiUnavailableResume(selectedAsset)
      : null;
  const aiUnavailableLine =
    aiUnavailableResume && primaryApplicationAction.kind === "approve_resume"
      ? "AI could not write this resume, so it keeps your saved wording. Try again, or review it and use it as it is."
      : aiUnavailableResume;

  const runPrimaryRecovery = () => {
    if (!selectedItem || !primaryApplicationAction.recovery) {
      return;
    }

    switch (primaryApplicationAction.recovery.kind) {
      case "approve_and_apply":
        if (onApproveResumeAndApply) {
          onApproveResumeAndApply(selectedItem.jobId);
        } else {
          onEditResumeWorkspace(selectedItem.jobId);
        }
        return;
      case "open_browser":
        onOpenBrowserSession();
        return;
      case "open_job_details":
        onOpenJobDetails(selectedItem.jobId);
        return;
      case "open_profile":
        onOpenProfile();
        return;
      case "open_resume_workspace":
        onEditResumeWorkspace(selectedItem.jobId);
        return;
      case "open_safeguards":
        onOpenSafeguards?.();
        return;
    }
  };

  // "Edit resume" is offered whenever a draft exists to edit. It is the one
  // door into Resume Studio from here; when review is the primary action the
  // primary already opens it, so it is not repeated.
  const hasDraftToEdit =
    selectedItem !== null &&
    !usesOriginalResume &&
    selectedItem.assetStatus !== "not_started" &&
    !isGenerating;
  // An Original job has no draft, but its studio is where the person turns
  // the original into an editable one (one press there). Without this the
  // studio was reachable only by a deep link.
  // A job that still needs its resume already has two actions here; the
  // resume below keeps its own Edit link.
  const showEditResume =
    (hasDraftToEdit ||
      (selectedItem !== null && usesOriginalResume && !isGenerating)) &&
    !needsTailoredResume &&
    primaryApplicationAction.kind !== "approve_resume" &&
    primaryApplicationAction.recovery?.kind !== "open_resume_workspace";
  const dailyCapacityExhausted =
    globalDailyApplicationPreparationCapacity?.remaining === 0;
  const dailyCapacityDescription = formatDailyPreparationCapacitySummaryText(
    globalDailyApplicationPreparationCapacity,
  );
  const showsApplyOutcome =
    primaryApplicationAction.kind === "start_apply" ||
    primaryApplicationAction.kind === "approve_and_apply";

  // One radiogroup with roving focus: arrow keys move and choose, Tab enters
  // and leaves the group once.
  const resumeChoiceGroupRef = useRef<HTMLDivElement | null>(null);
  const handleResumeChoiceKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
      if (!forward && !backward) {
        return;
      }

      const options = [
        ...(resumeChoiceGroupRef.current?.querySelectorAll<HTMLButtonElement>(
          "button[role='radio']:not([disabled])",
        ) ?? []),
      ];
      const activeIndex = options.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      if (options.length < 2 || activeIndex === -1) {
        return;
      }

      event.preventDefault();
      const next =
        options[
          (activeIndex + (forward ? 1 : -1) + options.length) % options.length
        ];
      next?.focus();
      next?.click();
    },
    [],
  );
  // A draft that kept the original wording because the listing body was never
  // captured is presented as the original-resume path once it is approved.
  // Until then the job still needs its resume, so its level stays choosable
  // and the next step writes it at that level.
  const untailorableListing =
    selectedItem?.resumeApplicationMode === "original_resume" ||
    needsTailoredResume ||
    isGenerating
      ? null
      : describeUntailorableListing(selectedAsset);
  const untailorableListingReasonId = "resume-choice-untailorable-listing";
  const selectedResumeLevel = selectedItem
    ? untailorableListing
      ? "original"
      : getSelectedResumeLevel(selectedItem)
    : null;
  const selectedResumeLevelOption = RESUME_LEVEL_OPTIONS.find(
    (option) => option.id === selectedResumeLevel,
  );
  // The four levels are one segmented row; each level's description is its
  // tooltip, and only the chosen level's description is spelled out under
  // the row. Four description cards used to fill half the pane.
  const resumeChoiceGroup = selectedItem ? (
    <div
      aria-describedby={
        untailorableListing ? untailorableListingReasonId : undefined
      }
      aria-label="Resume level for this job"
      className="inline-flex min-w-0 max-w-full flex-wrap gap-0.5 rounded-(--radius-small) border border-(--control-border) bg-background/30 p-0.5"
      onKeyDown={handleResumeChoiceKeyDown}
      ref={resumeChoiceGroupRef}
      role="radiogroup"
    >
      {RESUME_LEVEL_OPTIONS.map((option) => {
        const selected = selectedResumeLevel === option.id;
        const unavailable =
          Boolean(untailorableListing) && option.id !== "original";

        return (
          <button
            aria-checked={selected}
            className={cn(
              "inline-flex min-h-8 items-center gap-1.5 rounded-[calc(var(--radius-small)-2px)] px-3 text-(length:--text-small) font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "bg-primary/12 text-(--text-headline) shadow-[inset_0_0_0_1px_var(--primary)]"
                : "text-foreground-soft hover:bg-secondary hover:text-foreground",
              isSelectedJobPending || unavailable
                ? "cursor-not-allowed opacity-60"
                : "cursor-pointer",
            )}
            data-resume-level={option.id}
            disabled={isSelectedJobPending || unavailable}
            key={option.id}
            onClick={() =>
              option.id === "original"
                ? onSetJobResumeApplicationMode(
                    selectedItem.jobId,
                    "original_resume",
                  )
                : onSetJobResumeApplicationMode(
                    selectedItem.jobId,
                    "tailored_per_job",
                    option.tailoringMode,
                  )
            }
            role="radio"
            tabIndex={0}
            title={
              unavailable
                ? "Not possible for this job"
                : selected
                  ? option.detail
                  : `${option.detail}${selectedItem.assetStatus === "ready" && option.id !== "original" ? " Writes a new draft." : ""}`
            }
            type="button"
          >
            {selected ? (
              <Check
                aria-hidden="true"
                className="size-3.5 shrink-0 text-primary"
              />
            ) : null}
            {option.label}
            <span className="sr-only"> {option.detail}</span>
          </button>
        );
      })}
    </div>
  ) : null;
  const resumeChoiceNote = selectedItem ? (
    untailorableListing ? (
      <p
        className="text-(length:--text-small) leading-5 text-foreground-soft"
        id={untailorableListingReasonId}
      >
        {untailorableListing.reason} {untailorableListing.approvalMessage}
      </p>
    ) : selectedResumeLevelOption ? (
      <p className="text-xs leading-5 text-foreground-muted">
        {selectedResumeLevelOption.detail}
        {selectedItem.assetStatus === "ready"
          ? " Choosing another level writes a new draft."
          : ""}
      </p>
    ) : null
  ) : null;
  const resumeLevelLabel = (
    <span className="shrink-0 text-(length:--text-small) font-semibold text-foreground-soft">
      Resume level
    </span>
  );

  if (!selectedItem || !selectedJob) {
    return null;
  }

  return (
    <section className="relative grid min-w-0 content-start gap-3 px-6 pb-1 pt-3">
      <div className="grid min-w-0 gap-1.5">
        {selectedItem.resumeReview.status === "approved" ? (
          // Approved work is destructive to change, so the control is parked
          // behind a deliberate reveal that states the cost first.
          <details className="group grid min-w-0 gap-2" data-resume-choice-disclosure>
            <summary className="flex w-fit cursor-pointer list-none items-center gap-3 text-(length:--text-small) font-semibold text-foreground outline-none marker:hidden focus-visible:ring-[3px] focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
              {resumeLevelLabel}
              <span className="inline-flex items-center gap-1.5">
                {selectedResumeLevelOption?.label ?? "Tailored"} · change level
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 shrink-0 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
                />
              </span>
            </summary>
            <p
              className="text-(length:--text-small) leading-5 text-foreground-muted"
              role="note"
            >
              This resume is approved. Changing the level writes a new one that
              you approve again.
            </p>
            {resumeChoiceGroup}
            {resumeChoiceNote}
          </details>
        ) : (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
              {resumeLevelLabel}
              {resumeChoiceGroup}
            </div>
            {resumeChoiceNote}
          </>
        )}
        {usesOriginalResume &&
        originalResume &&
        selectedItem.resumeReview.status === "original_resume" ? (
          <p
            className="text-(length:--text-small) leading-5 text-foreground-muted"
            role="note"
          >
            {originalResume.fileName} goes out with its content unchanged.{" "}
            {/\.md$/iu.test(originalResume.fileName)
              ? "Forms that accept plain text receive an unchanged .txt copy. "
              : ""}
            Check it for details you would not share with every employer, such
            as a home address or date of birth.
          </p>
        ) : null}
      </div>

      {/* The next step: what state the job is in, one primary button, and
          the job's two quiet links on the same row. The tinted box says it
          is the next step; an eyebrow saying so cost a row. */}
      <div
        className="grid min-w-0 gap-2.5 rounded-(--radius-field) border border-primary/30 bg-primary/5 px-4 py-3"
        data-testid="apply-copilot-footer"
      >
        {existingApplication ? (
          <p className="text-(length:--text-small) leading-6 text-foreground-soft">
            This job is already in Applications. Open it to see its latest
            status.
          </p>
        ) : aiUnavailableLine || readinessDescription ? (
          <p
            className="text-(length:--text-small) leading-6 text-foreground-soft"
            data-testid="shortlisted-state-line"
          >
            {aiUnavailableLine ?? readinessDescription}
          </p>
        ) : null}
        {isGenerating ? (
          <div className="grid gap-1.5">
            <ProgressBar
              ariaLabel="Resume preparation in progress"
              indeterminate
            />
            <p className="text-(length:--text-small) leading-5 text-foreground-muted">
              <span className="tabular-nums" data-resume-draft-elapsed>
                {formatResumeOperationElapsed(pendingElapsedSeconds)}
              </span>{" "}
              <span data-resume-draft-expected-wait>
                {RESUME_DRAFT_EXPECTED_WAIT_LABEL}
              </span>
            </p>
          </div>
        ) : null}
        {!existingApplication && primaryApplicationAction.blocker ? (
          primaryApplicationAction.blockerTone === "info" ? (
            <p
              className="min-w-0 break-words text-(length:--text-small) leading-5 text-foreground-muted"
              role="status"
            >
              {primaryApplicationAction.blocker}
            </p>
          ) : (
            <p
              className="min-w-0 break-words rounded-(--radius-small) border border-destructive/35 bg-destructive/8 px-3 py-2 text-(length:--text-small) leading-5 text-foreground"
              role="alert"
            >
              {primaryApplicationAction.blocker}
            </p>
          )
        ) : null}
        <div className="flex min-w-0 flex-wrap items-center gap-2 empty:hidden">
          {selectedJob.matchAssessment.recommendation === "skip" ? (
            <StatusBadge tone={fitRecommendationCopy.skip.tone}>
              {fitRecommendationCopy.skip.label}
            </StatusBadge>
          ) : null}
          {selectedJob.matchAssessment.recommendation === "skip" ||
          selectedJob.matchAssessment.locationReach === "outside_area" ||
          selectedJob.matchAssessment.dimensions?.preferenceAlignment.state ===
            "conflict" ||
          selectedJob.matchAssessment.dimensions?.preferenceAlignment.state ===
            "mixed" ? (
            <span
              className="text-(length:--text-small) text-foreground-soft"
              data-testid="queue-suitability-warning"
            >
              {selectedJob.matchAssessment.recommendation === "skip"
                ? selectedJob.matchAssessment.recommendationRationale
                : preferenceExplanation}
              {selectedJob.matchAssessment.gaps.length > 0
                ? ` ${selectedJob.matchAssessment.gaps.join(" ")}`
                : ""}
            </span>
          ) : null}
          {selectedJob.matchAssessment.judgment?.source === "full" &&
          selectedJob.matchAssessment.recommendation !== "skip" &&
          selectedJob.matchAssessment.recommendationRationale ? (
            <p
              className="basis-full text-xs leading-5 text-foreground-muted"
              data-testid="queue-full-assessment-reason"
            >
              {joinUniqueSentences([
                selectedJob.matchAssessment.recommendationRationale,
              ])}
            </p>
          ) : null}
        </div>
        <div
          className="flex min-w-0 flex-wrap items-center gap-2"
          data-testid="application-action-row"
        >
          {existingApplication ? (
            <Button
              className="h-10 w-fit max-w-full justify-start px-5 text-sm font-semibold normal-case tracking-normal"
              onClick={() => onOpenApplication(existingApplication.id)}
              type="button"
              variant="primary"
            >
              Open application
            </Button>
          ) : (
            <Button
              className="h-10 w-fit max-w-full justify-start px-5 text-sm font-semibold normal-case tracking-normal"
              pending={
                primaryApplicationAction.kind === "waiting" ||
                (primaryApplicationAction.kind === "start_apply" &&
                  isPrimaryApplyPending)
              }
              variant="primary"
              disabled={
                !primaryApplicationAction.enabled ||
                (primaryApplicationAction.kind === "start_apply" &&
                  dailyCapacityExhausted)
              }
              onClick={() => {
                if (primaryApplicationAction.kind === "open_safeguards") {
                  onOpenSafeguards?.();
                  return;
                }

                if (primaryApplicationAction.kind === "generate_resume") {
                  void onGenerateResume(selectedItem.jobId);
                  return;
                }

                if (primaryApplicationAction.kind === "approve_resume") {
                  onEditResumeWorkspace(selectedItem.jobId);
                  return;
                }

                if (primaryApplicationAction.kind === "approve_and_apply") {
                  if (onApproveResumeAndApply) {
                    onApproveResumeAndApply(selectedItem.jobId);
                  } else {
                    onEditResumeWorkspace(selectedItem.jobId);
                  }
                  return;
                }

                if (primaryApplicationAction.kind === "start_apply") {
                  onStartApplyCopilot({ jobId: selectedItem.jobId });
                }
              }}
              type="button"
            >
              {primaryApplicationAction.label}
            </Button>
          )}
          {!existingApplication &&
          primaryApplicationAction.recovery !== null ? (
            <Button
              className="h-10 min-w-0 justify-start px-4 text-sm font-medium normal-case tracking-normal"
              onClick={runPrimaryRecovery}
              type="button"
              variant="secondary"
            >
              {primaryApplicationAction.recovery.label}
            </Button>
          ) : null}
          {aiUnavailableLine ? (
            <Button
              className="h-10 min-w-0 justify-start px-4 text-sm font-medium normal-case tracking-normal"
              disabled={isSelectedJobPending}
              onClick={() => void onGenerateResume(selectedItem.jobId)}
              type="button"
              variant="secondary"
            >
              Try again with AI
            </Button>
          ) : null}
          {showEditResume ? (
            <Button
              className="h-10 min-w-0 justify-start px-4 text-sm font-medium normal-case tracking-normal"
              onClick={() => onEditResumeWorkspace(selectedItem.jobId)}
              type="button"
              variant="secondary"
            >
              <Pencil aria-hidden="true" className="size-4" focusable="false" />
              Edit resume
            </Button>
          ) : null}
          {isGenerating && isSelectedJobPendingTooLong ? (
            <Button
              className="h-10 min-w-0 justify-start px-4 text-sm font-medium normal-case tracking-normal"
              onClick={() => onEditResumeWorkspace(selectedItem.jobId)}
              type="button"
              variant="secondary"
            >
              Open the resume
            </Button>
          ) : null}
          <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
            <Button
              className={quietActionClassName}
              onClick={() =>
                openUrlInJobFinderBrowser(selectedJob.canonicalUrl)
              }
              size="compact"
              type="button"
              variant="link"
            >
              Open the listing
            </Button>
            <Button
              className={quietActionClassName}
              onClick={() => onRemoveReviewJob(selectedItem.jobId)}
              size="compact"
              type="button"
              variant="link"
            >
              Remove from shortlist
            </Button>
          </span>
        </div>
        {isGenerating ? (
          <p className="text-xs text-foreground-muted">
            Removing this job stops the draft from being saved. An AI request
            already running may finish.
          </p>
        ) : null}
        {showsApplyOutcome && !existingApplication ? (
          <p
            className="min-w-0 break-words text-(length:--text-small) leading-5 text-foreground-muted"
            data-testid="apply-outcome"
          >
            {describeApplyOutcome(
              applicationAutomationMode,
              usesOriginalResume,
            )}
          </p>
        ) : null}
        {/* Quiet capacity fact below the actions, and only where it can
            change a decision. */}
        {!existingApplication &&
        dailyCapacityDescription &&
        (primaryApplicationAction.kind === "start_apply" ||
          dailyCapacityExhausted) ? (
          <p
            className="min-w-0 break-words text-(length:--text-tiny) leading-5 text-foreground-muted"
            data-testid="daily-application-preparation-capacity"
            id={dailyCapacityLimitDescriptionId}
            role="note"
          >
            {dailyCapacityDescription}
          </p>
        ) : null}
        {/* The box above already says it; the same news twice read as
            two problems. */}
        {actionMessage &&
        shouldShowMissionActionMessage({
          actionMessage,
          blocker: primaryApplicationAction.blocker,
          aiUnavailableLine,
        }) ? (
          <p
            aria-atomic="true"
            aria-live="polite"
            className="min-w-0 break-words text-(length:--text-small) leading-6 text-primary"
            role="status"
          >
            {actionMessage}
          </p>
        ) : null}
      </div>
    </section>
  );
}
