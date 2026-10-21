import { cn } from "@renderer/lib/cn";
import { LIST_DETAIL_COLUMNS_CLASS } from "../../components/list-detail-columns";
import { useJobDetail } from "../../hooks/use-job-detail";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  BrowserSessionState,
  ApplicationAutomationMode,
  ApplicationRecord,
  CandidateProfile,
  GlobalDailyApplicationPreparationCapacity,
  JobFinderApplicationStartTarget,
  JobFinderRendererWorkspaceSnapshot,
  ResumeApplicationMode,
  TailoringMode,
  ResumeSourceDocument,
  ReviewQueueItem,
  JobListRow,
  TailoredAssetSummary,
} from "@nestor/contracts";
import {
  APPLICATION_PREPARATION_BATCH_LIMIT,
  collectInProgressApplicationJobIds,
  getResumeRunState,
  getReviewQueueWorkflowStatus,
  isQueueStageReady,
} from "./review-queue-status";
import { LockedScreenLayout } from "../../components/locked-screen-layout";
import {
  PageHeaderStack,
  type PageStatusItem,
} from "../../components/page-header";
import { Button } from "@renderer/components/ui/button";
import { EmptyState } from "../../components/empty-state";
import { StatusBadge } from "../../components/status-badge";
import { MatchEvidenceMatrix } from "../../components/match-evidence-matrix";
import { jobDescriptionToText } from "../../lib/job-description-text";
import { describeListingReadFailure } from "../../lib/describe-failure";
import {
  formatJobEmployerLocationLine,
  scrubJobAbsencePlaceholdersList,
} from "../../lib/job-employer-location-display";
import { getMatchAssessmentPresentation } from "../../lib/match-assessment-presentation";
import { RESUME_DRAFT_LONG_RUNNING_MS } from "@renderer/features/job-finder/lib/wait-state";
import type { JobFinderAutoApplyQueueStartOutcome } from "../../lib/job-finder-types";
import { useStableCallback } from "../../hooks/use-stable-callback";
import { ReviewQueueListPanel } from "./review-queue-list-panel";
import {
  collectPreparedApplicationJobIds,
  isTailoredDraftPreparationEligible,
} from "./review-queue-status";
import { ReviewQueueMissionPanel } from "./review-queue-mission-panel";
import { useAssistantContextSource } from "../../assistant/assistant-provider";
import { buildListContext } from "../../assistant/assistant-context-capture";
import { describeApplyAllOutcome } from "./review-queue-mission-panel-helpers";
import { ReviewQueuePreviewPanel } from "./review-queue-preview-panel";
import type { TailoredDraftPreparationViewState } from "./review-queue-status";

const workspacePanelId = "review-queue-workspace-panel";

const DISMISSED_RESUME_BATCH_NOTICES_KEY =
  "nestor.resume-batch.dismissed-notices";

function readDismissedResumeBatchNotices(): string[] {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(DISMISSED_RESUME_BATCH_NOTICES_KEY) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string").slice(-100)
      : [];
  } catch {
    return [];
  }
}

function rememberDismissedResumeBatchNotice(noticeId: string): string[] {
  const next = [...readDismissedResumeBatchNotices(), noticeId].slice(-100);
  try {
    window.localStorage.setItem(
      DISMISSED_RESUME_BATCH_NOTICES_KEY,
      JSON.stringify(next),
    );
  } catch {
    // The current visit can still hide it.
  }
  return next;
}

export function ReviewQueueScreen(props: {
  scopeControl?: ReactNode;
  resumeOperationStarts?: Readonly<Record<string, number>> | undefined;
  actionState: { message: string | null };
  applicationRecords: readonly ApplicationRecord[];
  applicationAutomationMode?: ApplicationAutomationMode;
  browserSession: BrowserSessionState;
  campaignId: string;
  draftPreparation: TailoredDraftPreparationViewState;
  resumeBatchCheckpoint?: JobFinderRendererWorkspaceSnapshot["intelligence"]["resumeBatchCheckpoint"];
  globalDailyApplicationPreparationCapacity: GlobalDailyApplicationPreparationCapacity | null;
  isApplyPending: boolean;
  /**
   * The live apply results, so the start control can follow the run record
   * rather than a local pending flag that expires after about a minute while
   * a real run keeps going for several.
   */
  applyJobResults?: JobFinderRendererWorkspaceSnapshot["applyJobResults"];
  isJobPending: (jobId: string) => boolean;
  onPrepareTailoredDrafts: (jobIds?: readonly string[]) => void;
  onStopTailoredDraftPreparation: () => void;
  onStartAutoApplyQueue: (
    jobIds: string[],
    applicationAutomationMode?: ApplicationAutomationMode,
  ) => Promise<JobFinderAutoApplyQueueStartOutcome>;
  onStartApplyCopilot: (input: JobFinderApplicationStartTarget) => void;
  onEditResumeWorkspace: (jobId: string) => void;
  onApproveResumeAndApply?: (jobId: string) => void;
  onGenerateResume: (
    jobId: string,
    options?: { selectAfter?: boolean },
  ) => Promise<boolean>;
  onOpenBrowserSession: () => void;
  onOpenJobDetails: (jobId: string) => void;
  onOpenApplication?: (recordId: string) => void;
  onOpenProfile: () => void;
  onOpenSafeguards?: () => void;
  safeguardBlocker?: string | null;
  onClaimResumeIdentity?: () => void;
  onKeepResumeIdentity?: () => void;
  onRemoveReviewJob: (jobId: string) => void;
  /** Moves the selected jobs back to Find jobs in one request. */
  onRemoveReviewJobs?: (jobIds: readonly string[]) => Promise<void>;
  /** Reads a job's listing again when the search kept only its card. */
  onReadJobListing?: (jobId: string) => Promise<void>;
  onSetJobResumeApplicationMode: (
    jobId: string,
    resumeApplicationMode: ResumeApplicationMode,
    resumeTailoringMode?: TailoringMode | null,
  ) => void;
  onSelectItem: (jobId: string) => void;
  originalResume: ResumeSourceDocument;
  profile?: CandidateProfile;
  queue: readonly ReviewQueueItem[];
  selectedAsset: TailoredAssetSummary | null;
  selectedItem: ReviewQueueItem | null;
  selectedJob: JobListRow | null;
  tailoredAssets?: readonly TailoredAssetSummary[] | undefined;
}) {
  const {
    resumeOperationStarts,
    actionState,
    applicationRecords,
    applicationAutomationMode = "prepare_only",
    browserSession,
    draftPreparation,
    globalDailyApplicationPreparationCapacity,
    isApplyPending,
    applyJobResults,
    isJobPending,
    onPrepareTailoredDrafts,
    onStopTailoredDraftPreparation,
    onStartAutoApplyQueue,
    onStartApplyCopilot,
    onEditResumeWorkspace,
    onApproveResumeAndApply,
    onGenerateResume,
    onOpenBrowserSession,
    onOpenJobDetails,
    onOpenApplication,
    onOpenProfile,
    onOpenSafeguards,
    safeguardBlocker,
    onClaimResumeIdentity,
    onKeepResumeIdentity,
    onRemoveReviewJob,
    onRemoveReviewJobs,
    onReadJobListing,
    onSetJobResumeApplicationMode,
    onSelectItem,
    originalResume,
    profile,
    queue,
    selectedAsset,
    selectedItem,
    selectedJob,
    tailoredAssets,
  } = props;
  const selectedDetail = useJobDetail(selectedJob, props.campaignId);
  const [listingRead, setListingRead] = useState<{
    jobId: string;
    pending: boolean;
    error: string | null;
  } | null>(null);
  const readSelectedListing = (jobId: string, listingUrl: string) => {
    if (!onReadJobListing) return;
    setListingRead({ jobId, pending: true, error: null });
    void onReadJobListing(jobId)
      .then(() =>
        setListingRead((current) =>
          current?.jobId === jobId ? null : current,
        ),
      )
      .catch((error: unknown) =>
        setListingRead((current) =>
          current?.jobId === jobId
            ? {
                jobId,
                pending: false,
                error: describeListingReadFailure(error, { listingUrl }),
              }
            : current,
        ),
      );
  };
  const selectedListingRead =
    listingRead && listingRead.jobId === selectedJob?.id ? listingRead : null;
  const previewState =
    selectedItem &&
    selectedItem.resumeApplicationMode !== "original_resume" &&
    !selectedAsset &&
    selectedItem.assetStatus === "ready"
      ? "missing"
      : null;
  const selectedJobPending = selectedItem
    ? isJobPending(selectedItem.jobId)
    : false;
  const selectedJobId = selectedItem?.jobId ?? null;
  const [selectedJobPendingTooLong, setSelectedJobPendingTooLong] =
    useState(false);
  // Same order as the row: a rewrite after a failure runs the clock too.
  const isSelectedJobPreparing = getResumeRunState(
    selectedItem,
    selectedAsset,
    selectedJobPending,
  ).isWriting;
  const [pendingElapsedSeconds, setPendingElapsedSeconds] = useState(0);
  const actionMessageScopeRef = useRef<{
    jobId: string | null;
    message: string | null;
  }>({ jobId: selectedItem?.jobId ?? null, message: actionState.message });
  if (actionMessageScopeRef.current.message !== actionState.message) {
    actionMessageScopeRef.current = {
      jobId: selectedItem?.jobId ?? null,
      message: actionState.message,
    };
  }
  const scopedActionMessage =
    actionMessageScopeRef.current.jobId === (selectedItem?.jobId ?? null)
      ? actionState.message
      : null;
  // Jobs that already have an application record are in Applications; they
  // stop counting as ready to apply here.
  const preparedJobIds = useMemo(
    () => collectPreparedApplicationJobIds(applicationRecords),
    [applicationRecords],
  );
  // The shortlist as the person sees it, for the assistant (ADR 0037).
  useAssistantContextSource("shortlist", () => ({
    focus: selectedItem
      ? {
          kind: "job",
          id: selectedItem.jobId,
          label: `${selectedItem.title} at ${selectedItem.company}`,
        }
      : null,
    // The open job is focus; the list panel publishes the ticked rows.
    list: buildListContext({
      listKind: "shortlist",
      checkedIds: [],
      displayedIds: queue.map((item) => item.jobId),
      filteredIds: queue.map((item) => item.jobId),
    }),
  }));
  const applicationPreparingJobIds = useMemo(
    () => collectInProgressApplicationJobIds(applicationRecords),
    [applicationRecords],
  );
  const selectedWorkflowStatus = getReviewQueueWorkflowStatus(
    selectedItem,
    selectedAsset,
    selectedItem ? isJobPending(selectedItem.jobId) : false,
    // Same set the Shortlisted rows read. Leaving it out gave the header its
    // own second verdict for the job already selected in the list.
    preparedJobIds,
    applicationPreparingJobIds,
  );
  const selectedJobEmployerLocationLine = selectedJob
    ? formatJobEmployerLocationLine({
        company: selectedJob.company,
        location: selectedJob.location,
        canonicalUrl: selectedJob.canonicalUrl,
      })
    : "";
  const selectedJobFitReasons = selectedJob
    ? scrubJobAbsencePlaceholdersList(selectedJob.matchAssessment.reasons)
    : [];
  const selectedJobAssessment = selectedJob
    ? getMatchAssessmentPresentation(selectedJob)
    : null;
  // A "summary" that only repeats the job title is not listing text.
  const selectedJobSummaryText = (() => {
    if (!selectedJob) {
      return "";
    }
    const text = jobDescriptionToText(
      selectedDetail.job?.summary ?? selectedDetail.job?.description ?? "",
    ).trim();
    return text.toLowerCase() === selectedJob.title.trim().toLowerCase()
      ? ""
      : text;
  })();

  const operationStartedAt = selectedJobId
    ? resumeOperationStarts?.[selectedJobId]
    : undefined;

  useEffect(() => {
    setSelectedJobPendingTooLong(false);

    if (!selectedJobPending || selectedJobId === null) {
      return;
    }

    const timeoutId = window.setTimeout(
      () => {
        setSelectedJobPendingTooLong(true);
      },
      Math.max(
        0,
        RESUME_DRAFT_LONG_RUNNING_MS -
          (operationStartedAt === undefined
            ? 0
            : Date.now() - operationStartedAt),
      ),
    );

    return () => window.clearTimeout(timeoutId);
  }, [selectedJobId, selectedJobPending, operationStartedAt]);

  // The draft reports no real progress, so the honest thing to move is the
  // clock, not a fabricated percentage. Keyed to the same condition the
  // panels use to show the indicator, so the bar never appears beside a
  // stopped clock.
  useEffect(() => {
    if (!isSelectedJobPreparing || selectedJobId === null) {
      setPendingElapsedSeconds(0);
      return;
    }

    const startedAt = operationStartedAt ?? Date.now();
    const updateElapsed = () =>
      setPendingElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);

    return () => window.clearInterval(timer);
  }, [isSelectedJobPreparing, selectedJobId, operationStartedAt]);

  // "Apply to all ready jobs": every job whose resume is ready, in list
  // order, up to the per-run cap. Jobs already in Applications and jobs whose
  // application is running are left alone (ADR 0022's "Apply to all").
  const [applyAllPending, setApplyAllPending] = useState(false);
  const applicationBatchLimit = Math.min(
    APPLICATION_PREPARATION_BATCH_LIMIT,
    Math.max(
      0,
      globalDailyApplicationPreparationCapacity?.remaining ??
        Number.POSITIVE_INFINITY,
    ),
  );
  const handleApplyToAllReady = useCallback(() => {
    const unavailable = new Set([
      ...preparedJobIds,
      ...applicationPreparingJobIds,
    ]);
    const readyJobIds = queue
      .filter(
        (item) =>
          !isJobPending(item.jobId) && isQueueStageReady(item, unavailable),
      )
      .map((item) => item.jobId)
      .slice(0, applicationBatchLimit);
    if (readyJobIds.length === 0) {
      return;
    }
    setApplyAllPending(true);
    void onStartAutoApplyQueue(readyJobIds, applicationAutomationMode).finally(
      () => {
        setApplyAllPending(false);
      },
    );
  }, [
    applicationBatchLimit,
    applicationPreparingJobIds,
    applicationAutomationMode,
    onStartAutoApplyQueue,
    isJobPending,
    preparedJobIds,
    queue,
  ]);

  // Both entry points publish their batch receipt to the workspace.
  const runningBatch =
    props.resumeBatchCheckpoint?.running && !props.resumeBatchCheckpoint.done
      ? props.resumeBatchCheckpoint
      : null;
  const visibleDraftPreparation: TailoredDraftPreparationViewState =
    draftPreparation.status === "running" || !runningBatch
      ? draftPreparation
      : {
          status: "running",
          totalCount: runningBatch.jobIds.length,
          completedCount: runningBatch.completedJobIds.length,
          attemptedCount:
            runningBatch.completedJobIds.length +
            runningBatch.activeJobIds.length,
          failedCount: 0,
          currentIndex: null,
          eligibleRemainingCount: 0,
          durationsMs: runningBatch.durationsMs ?? [],
          stopRequested: runningBatch.stopRequested,
        };
  const [batchStopError, setBatchStopError] = useState<string | null>(null);
  const stopVisibleBatch = () => {
    setBatchStopError(null);
    onStopTailoredDraftPreparation();
    if (runningBatch)
      void window.nestor.assistant
        .stopResumeBatch()
        .catch(() =>
          setBatchStopError("Could not stop the resume batch. Try again."),
        );
  };
  const interruptedJobIds =
    (props.draftPreparation.status === "idle" ||
      !!props.draftPreparation.providerBlock) &&
    props.resumeBatchCheckpoint &&
    !props.resumeBatchCheckpoint.done &&
    !props.resumeBatchCheckpoint.running
      ? props.resumeBatchCheckpoint.jobIds.filter(
          (id) =>
            !props.resumeBatchCheckpoint!.completedJobIds.includes(id) &&
            !preparedJobIds.has(id),
        )
      : [];
  const interruptedJobs = queue.filter((item) =>
    interruptedJobIds.includes(item.jobId),
  );
  // When every unfinished job still needs a resume, Create missing resumes
  // already picks them up; a second button for the same work only confused.
  // A job of the batch that has its resume by now is not unfinished work
  // either: the owner's 183 "unfinished resumes" box counted ten jobs whose
  // resumes were ready to review. A batch the AI service paused keeps its
  // line, which says why, and so does one that carries per-job choices (a
  // level or a language).
  const interruptedNoticeAddsNothing =
    !props.resumeBatchCheckpoint?.providerBlock &&
    !props.resumeBatchCheckpoint?.requests?.length &&
    interruptedJobs.length === interruptedJobIds.length &&
    interruptedJobs.every(
      (item) =>
        isTailoredDraftPreparationEligible(item, preparedJobIds) ||
        item.assetStatus === "ready",
    );
  const [dismissedBatchNotices, setDismissedBatchNotices] = useState(
    readDismissedResumeBatchNotices,
  );
  const batchNoticeId = props.resumeBatchCheckpoint
    ? `${props.resumeBatchCheckpoint.id}|${props.resumeBatchCheckpoint.completedJobIds.length}|${props.resumeBatchCheckpoint.stopRequested}`
    : null;
  // A batch that did not finish is a quiet line under the title with one
  // Continue button, not a box above the list (issue #50, ADR 0044). Hiding
  // it keeps it hidden for this batch.
  const interruptedBatchStatusItem: PageStatusItem | null =
    interruptedJobIds.length > 0 &&
    props.resumeBatchCheckpoint &&
    batchNoticeId &&
    !interruptedNoticeAddsNothing &&
    !dismissedBatchNotices.includes(batchNoticeId)
      ? {
          id: "interrupted-resume-batch",
          ...(props.resumeBatchCheckpoint.providerBlock
            ? { tone: "info" as const }
            : {}),
          text: props.resumeBatchCheckpoint.providerBlock
            ? `The resume batch is paused. ${props.resumeBatchCheckpoint.providerBlock.message}`
            : `The last resume batch ${props.resumeBatchCheckpoint.stopRequested ? "was stopped" : "did not finish"}: ${interruptedJobIds.length === 1 ? "1 resume" : `${interruptedJobIds.length} resumes`} not written yet.`,
          action: {
            kind: "button",
            label: "Continue batch",
            onClick: () => onPrepareTailoredDrafts(interruptedJobIds),
          },
          onHide: () =>
            setDismissedBatchNotices(
              rememberDismissedResumeBatchNotice(batchNoticeId),
            ),
        }
      : null;
  // Below the `xl` two-pane breakpoint the job column stacks under the list,
  // so selecting a job moved the one next action below the fold with nothing
  // saying so. Find jobs and Applications both reveal their stacked detail
  // region on pointer selection; Shortlisted uses the same mechanism.
  //
  // Stable for the life of the screen: the rows are memoised, and this
  // handler reaches every one of them.
  const selectItemAndRevealWorkspace = useStableCallback((jobId: string) => {
    onSelectItem(jobId);

    if (
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(min-width: 1280px)").matches
    ) {
      return;
    }

    window.requestAnimationFrame(() => {
      document
        .getElementById(workspacePanelId)
        ?.scrollIntoView({ block: "start" });
    });
  });
  return (
    <LockedScreenLayout
      contentClassName="xl:flex xl:flex-col xl:overflow-hidden"
      lockContentHeight
      topContent={
        <PageHeaderStack
          title="Shortlisted"
          subnav={props.scopeControl}
          description="Pick a resume level, get the resume ready, then apply."
          statusItems={
            interruptedBatchStatusItem ? [interruptedBatchStatusItem] : []
          }
        />
      }
    >
      {batchStopError ? <p role="alert">{batchStopError}</p> : null}
      <div
        className={cn(
          "grid min-w-0 items-stretch gap-4 xl:flex-1 xl:min-h-0 xl:overflow-hidden",
          LIST_DETAIL_COLUMNS_CLASS,
        )}
      >
        <ReviewQueueListPanel
          key={props.campaignId}
          campaignId={props.campaignId}
          draftPreparation={visibleDraftPreparation}
          isApplyToAllPending={applyAllPending || isApplyPending}
          applicationBatchLimit={applicationBatchLimit}
          isJobPending={isJobPending}
          onApplyToAllReady={handleApplyToAllReady}
          applyAllOutcome={describeApplyAllOutcome(applicationAutomationMode)}
          onPrepareTailoredDrafts={onPrepareTailoredDrafts}
          {...(onRemoveReviewJobs ? { onRemoveJobs: onRemoveReviewJobs } : {})}
          {...(onOpenSafeguards ? { onOpenSafeguards } : {})}
          safeguardBlocker={safeguardBlocker ?? null}
          onSelectItem={selectItemAndRevealWorkspace}
          onShowItem={onSelectItem}
          onStopTailoredDraftPreparation={stopVisibleBatch}
          preparedJobIds={preparedJobIds}
          applicationPreparingJobIds={applicationPreparingJobIds}
          queue={queue}
          selectedItem={selectedItem}
          tailoredAssets={tailoredAssets}
        />
        <section className="surface-panel-shell flex min-h-0 min-w-0 flex-col overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border) xl:h-full">
          {/* Pinned: reading a long resume or job description must not scroll
              away the job title or its state. */}
          <header className="sticky top-0 z-10 grid shrink-0 gap-1 border-b border-(--surface-panel-border) bg-(--surface-panel) px-5 pb-3 pt-4 xl:static">
            {/* Title and place on the left, the status on the right: the
                same header Applications uses. With wrapping on, a long title
                pushed the badge under the employer line. */}
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-(--text-headline)">
                  {selectedJob?.title ?? "Job"}
                </h2>
                {selectedJob ? (
                  selectedJobEmployerLocationLine ? (
                    <p className="mt-1 truncate text-(length:--text-small) text-foreground-muted">
                      {selectedJobEmployerLocationLine}
                    </p>
                  ) : null
                ) : (
                  <p className="mt-1 truncate text-(length:--text-small) text-foreground-muted">
                    Choose a shortlisted job.
                  </p>
                )}
              </div>
              {selectedItem ? (
                <StatusBadge
                  className="shrink-0 whitespace-nowrap"
                  tone={selectedWorkflowStatus.tone}
                >
                  {/* The same words as the job's row in the list. */}
                  {selectedItem.listingAssessmentPending
                    ? "Assessing listing"
                    : selectedWorkflowStatus.label}
                </StatusBadge>
              ) : null}
            </div>
          </header>
          {/* One column, in the order the work happens: the resume level and
              the one next action, then the resume once it exists, then the
              job facts. */}
          <div
            className="grid min-h-0 min-w-0 flex-1 content-start gap-4 overflow-x-hidden overflow-y-auto pb-6"
            data-locked-pane-scroll-region
            data-testid="review-queue-workspace-column"
            id={workspacePanelId}
          >
            {selectedItem ? (
              <ReviewQueueMissionPanel
                actionMessage={scopedActionMessage}
                applicationAutomationMode={applicationAutomationMode}
                applicationRecords={applicationRecords}
                browserSession={browserSession}
                pendingElapsedSeconds={pendingElapsedSeconds}
                globalDailyApplicationPreparationCapacity={
                  globalDailyApplicationPreparationCapacity
                }
                applyJobResults={applyJobResults ?? []}
                isApplyPending={isApplyPending}
                isJobPending={isJobPending}
                isSelectedJobPendingTooLong={selectedJobPendingTooLong}
                onStartApplyCopilot={onStartApplyCopilot}
                onEditResumeWorkspace={onEditResumeWorkspace}
                {...(onApproveResumeAndApply
                  ? { onApproveResumeAndApply }
                  : {})}
                onGenerateResume={onGenerateResume}
                onOpenBrowserSession={onOpenBrowserSession}
                onOpenJobDetails={onOpenJobDetails}
                onOpenApplication={onOpenApplication ?? (() => undefined)}
                onOpenProfile={onOpenProfile}
                {...(onOpenSafeguards ? { onOpenSafeguards } : {})}
                safeguardBlocker={safeguardBlocker ?? null}
                {...(onClaimResumeIdentity ? { onClaimResumeIdentity } : {})}
                {...(onKeepResumeIdentity ? { onKeepResumeIdentity } : {})}
                onRemoveReviewJob={onRemoveReviewJob}
                onSetJobResumeApplicationMode={onSetJobResumeApplicationMode}
                originalResume={originalResume}
                {...(profile ? { profile } : {})}
                selectedAsset={selectedAsset}
                selectedItem={selectedItem}
                selectedJob={selectedJob}
                preferenceExplanation={
                  selectedDetail.job?.matchAssessment.dimensions
                    ?.preferenceAlignment.explanation ?? null
                }
                resumeRunStage={
                  visibleDraftPreparation.stageByJobId?.[selectedItem.jobId] ??
                  null
                }
              />
            ) : null}
            {selectedItem && (selectedAsset || previewState === "missing") ? (
              // The resume appears in place once one exists.
              <ReviewQueuePreviewPanel
                pendingElapsedSeconds={pendingElapsedSeconds}
                embedded
                isGenerating={selectedJobPending}
                isPendingTooLong={selectedJobPendingTooLong}
                onEditResumeWorkspace={onEditResumeWorkspace}
                onGenerateResume={onGenerateResume}
                originalResume={originalResume}
                preparedJobIds={preparedJobIds}
                applicationPreparingJobIds={applicationPreparingJobIds}
                previewState={previewState}
                queue={queue}
                selectedAsset={selectedAsset}
                selectedItem={selectedItem}
                selectedJob={selectedJob}
                stacked
              />
            ) : null}
            {selectedJob && selectedItem ? (
              <div className="min-w-0 px-6 pt-2">
                {/* Every level down to the listing text resets its minimum
                    width, and the text may break inside a word: a listing
                    with one long unbroken token otherwise sets the column's
                    minimum content width and pushes the whole column past
                    the pane's right edge. */}
                <div className="grid min-w-0 max-w-3xl gap-6">
                  <section className="grid min-w-0 gap-2 border-t border-(--surface-panel-border) pt-5">
                    <span className="label-mono-xs text-foreground-muted">
                      About this job
                    </span>
                    {/* An echoed title under a heading looks like a bug; the
                        listing text only appears when it is real text. */}
                    {selectedJobSummaryText ? (
                      <p className="min-w-0 wrap-anywhere whitespace-pre-line text-(length:--text-body) leading-7 text-foreground-soft">
                        {selectedJobSummaryText}
                      </p>
                    ) : (
                      <p className="text-(length:--text-small) leading-6 text-foreground-soft">
                        {selectedDetail.loading
                          ? "Loading job details…"
                          : (selectedDetail.error ??
                            "The listing text was not captured. Open the full job details to read it.")}
                        {selectedDetail.error ? (
                          <Button onClick={selectedDetail.retry}>Retry</Button>
                        ) : null}
                      </p>
                    )}
                    {!selectedJobSummaryText &&
                    !selectedDetail.loading &&
                    !selectedDetail.error &&
                    onReadJobListing ? (
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Button
                          disabled={selectedListingRead?.pending === true}
                          onClick={() =>
                            readSelectedListing(
                              selectedJob.id,
                              selectedJob.canonicalUrl,
                            )
                          }
                          pending={selectedListingRead?.pending === true}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          {selectedListingRead?.pending
                            ? "Reading the listing… about a minute"
                            : "Read the listing again"}
                        </Button>
                        {selectedListingRead?.error ? (
                          <p
                            className="text-(length:--text-small) text-foreground-soft"
                            role="alert"
                          >
                            {selectedListingRead.error}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <strong
                        aria-label={
                          selectedJobAssessment?.headlineScoreAriaLabel
                        }
                        className="text-(length:--text-body) text-(--text-headline)"
                        data-testid="review-queue-fit-score"
                      >
                        {selectedItem.listingAssessmentPending
                          ? "Assessing listing"
                          : selectedJobAssessment?.headlineScoreLabel}
                      </strong>
                      <span className="min-w-0 text-(length:--text-small) leading-6 text-foreground-soft">
                        {selectedItem.listingAssessmentPending
                          ? "Reading and assessing this listing in the background."
                          : selectedJobAssessment?.isNotJudged
                            ? "Open full job details to read and assess this listing."
                            : (selectedJobAssessment?.withheldReason ??
                              selectedJobFitReasons[0] ??
                              "Estimated from the listing and your approved profile.")}
                      </span>
                    </div>
                    <Button
                      className="mt-1 w-fit"
                      onClick={() => onOpenJobDetails(selectedItem.jobId)}
                      type="button"
                      variant="secondary"
                    >
                      Open full job details
                    </Button>
                  </section>
                  <details className="min-w-0 rounded-(--radius-field) border border-(--surface-panel-border)">
                    <summary className="cursor-pointer px-4 py-3 text-(length:--text-small) font-medium text-foreground-soft">
                      How this was scored
                    </summary>
                    <div className="px-4 pb-4">
                      {selectedDetail.job ? (
                        <MatchEvidenceMatrix
                          assessment={selectedDetail.job.matchAssessment}
                          listingCapture={
                            selectedJob.listingDetailCapture?.state ?? null
                          }
                          scoreLabel={
                            selectedJobAssessment?.breakdownScoreLabel ?? null
                          }
                        />
                      ) : (
                        <p className="text-(length:--text-small) leading-6 text-foreground-soft">
                          {selectedDetail.error ?? "Loading job details…"}
                        </p>
                      )}
                    </div>
                  </details>
                </div>
              </div>
            ) : null}
            {!selectedItem ? (
              <div className="grid place-items-center p-8">
                <EmptyState
                  description="Select a shortlisted job to get its resume ready and apply."
                  title="Choose a job"
                />
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </LockedScreenLayout>
  );
}
