import type { QuestionAnswerDraft } from "../actions/actions-screen";
import { isSameSiteApplicationActive } from "../actions/actions-screen";
import {
  applicationCrmStageLabelForView,
  inferApplicationCrmStageForView,
  trackedHiringStageBadge,
} from "./applications-crm-model";
import { useMemo, useRef } from "react";
import {
  isApplicationTrackedAsSentByPerson,
  type ApplicationCrmStageDefinition,
} from "@nestor/contracts";
import type {
  ApplicationAttemptListRow,
  ApplicationRecord,
  ApplyRunDetails,
  ClearApplicationAnswerCommandInput,
  GlobalDailyApplicationPreparationCapacity,
  JobFinderRendererWorkspaceSnapshot,
  SaveApplicationAnswerCommandInput,
  JobFinderApplyConsentActionInput,
  JobFinderApplyRunActionInput,
  JobFinderApplyRunDetailsQuery,
  JobFinderExactApplicationTarget,
  UserActionCommandInput,
  UserActionRequest,
} from "@nestor/contracts";
import type { ApplicationAnswerStep } from "./applications-answer-step";
import { Mic } from "lucide-react";
import { Button } from "@renderer/components/ui";
import { StatusBadge } from "../../components/status-badge";
import { ApplicationsDetailPanelActivitySections } from "./applications-detail-panel-activity-sections";
import { getApplicationApplyPresentation } from "./applications-apply-state";
import { resolveApplyStatePresentation } from "./apply-state";
import type { ApplyRunContext } from "./applications-recovery-state";
import type { ApplyMode } from "../../lib/apply-mode-contracts-stub";
import { ApplicationsApplicationDocuments } from "./applications-application-documents";
import { ApplicationsDetailPanelEmptyState } from "./applications-detail-panel-empty-state";
import { ApplicationsDetailFactStrip } from "./applications-detail-fact-strip";
import {
  buildQueueEntries,
  applicationNeedsPrimaryRecovery,
  findActionableApplicationAnswerRequest,
  getApplyResultDestinationUrl,
} from "./applications-detail-panel-helpers";
import { ApplicationsDetailPanelOverviewSections } from "./applications-detail-panel-overview-sections";
import type {
  ConfirmFinishedInBrowserStatus,
  FinishInBrowserHandler,
  FinishInBrowserInput,
} from "./applications-detail-panel-recovery-actions-section";
import { openApplicationForm } from "./application-form-open";
import { resolveApplicationMoveBack } from "./application-move-back";
import { ApplicationsDetailPanelRecoverySections } from "./applications-detail-panel-recovery-sections";
import {
  pageNeedsPreparing,
  useApplicationPageStates,
} from "../../hooks/use-application-page-states";
import {
  ApplicationsDetailPanelSubmitApprovalSection,
  isAwaitingPreparationApproval,
  preparationApprovalActionLabel,
} from "./applications-detail-panel-submit-approval-section";
import { type ApplicationsViewFilter } from "./applications-filters";
import {
  getApplicationStagePresentation,
  listPendingApplicationQuestions,
} from "./applications-status";
import { formatApplicationEmployerLine } from "../../lib/job-employer-location-display";

function buildLiveAssistantApplicationHref(input: {
  record: ApplicationRecord;
  relatedJob:
    | JobFinderRendererWorkspaceSnapshot["discoveryJobs"][number]
    | null;
}) {
  const { record, relatedJob } = input;
  const employerLine = formatApplicationEmployerLine({
    company: record.company,
    ...(relatedJob?.canonicalUrl
      ? { canonicalUrl: relatedJob.canonicalUrl }
      : {}),
  });
  const notes = [
    record.nextActionLabel ? `Next step: ${record.nextActionLabel}` : null,
    record.lastActionLabel
      ? `Latest application activity: ${record.lastActionLabel}`
      : null,
    relatedJob?.matchAssessment.judgment?.summary
      ? `Job fit: ${relatedJob.matchAssessment.judgment.summary}`
      : null,
  ].filter((entry): entry is string => Boolean(entry));
  const params = new URLSearchParams({
    source: "job_application",
    id: record.id,
    label: employerLine ? `${record.title} at ${employerLine}` : record.title,
    role: record.title,
    company: employerLine ?? "",
    sourceUrl: relatedJob?.canonicalUrl ?? "",
    notes:
      notes.join("\n\n") ||
      (employerLine
        ? `Application record for ${record.title} at ${employerLine}.`
        : `Application record for ${record.title}.`),
  });

  return `/live-assistant?${params.toString()}`;
}

interface ApplicationsDetailPanelProps {
  progressNow?: number | undefined;
  /** Applications -> Shortlisted, shown only for an unsent application. */
  onReturnToShortlist?: (record: ApplicationRecord) => void;
  answerDraft?: QuestionAnswerDraft | undefined;
  answerDraftRestored?: boolean;
  onAnswerDraftChange?: (draft: QuestionAnswerDraft) => void | Promise<void>;
  activeFilter: ApplicationsViewFilter;
  /** Stages the person named in the tracker, shown by those names. */
  customStages?: readonly ApplicationCrmStageDefinition[];
  /** What each result's run is doing, so a planned job is never "Filling in". */
  readApplyRunContext?: (
    result:
      | JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]
      | null,
  ) => ApplyRunContext | null;
  applyRunDetails: ApplyRunDetails | null;
  applyRunDetailsTarget: {
    applicationRecordId: string;
    jobId: string;
    runId: string;
  } | null;
  applyRunDetailsError: string | null;
  applyRunDetailsStatus: "idle" | "loading" | "ready" | "error";
  applicationAttempts?: readonly ApplicationAttemptListRow[];
  applicationRecords: readonly ApplicationRecord[];
  applyJobResults: JobFinderRendererWorkspaceSnapshot["applyJobResults"];
  dailyPreparationCapacity: GlobalDailyApplicationPreparationCapacity | null;
  discoveryJobs: JobFinderRendererWorkspaceSnapshot["discoveryJobs"];
  applyRunHistory: Array<{
    result: JobFinderRendererWorkspaceSnapshot["applyJobResults"][number];
    run: JobFinderRendererWorkspaceSnapshot["applyRuns"][number] | null;
  }>;
  effectiveSelectedApplyResult:
    | JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]
    | null;
  hasAnyApplications: boolean;
  hasVisibleApplications: boolean;
  isApplyPending: boolean;
  /** All work is paused: no control here may start an application. */
  applicationWorkPaused?: boolean;
  isApplyRequestPending: (requestId: string) => boolean;
  isApplyRunPending: (runId: string) => boolean;
  onApproveApplyRun: (input: JobFinderApplyRunActionInput) => void;
  onCancelApplyRun: (input: JobFinderApplyRunActionInput) => void;
  onOpenCompany?: (companyId: string) => void;
  onExportApplicationPacket: (
    input: JobFinderApplyRunDetailsQuery,
  ) => Promise<void>;
  onResolveSubmissionOutcome?: (
    uncertainOutcomeId: string,
    resolution: "submitted" | "not_submitted",
  ) => Promise<void>;
  /** Sends an application the person chose to look over first. */
  onSubmitPreparedApplication?: (jobId: string) => Promise<void>;
  /** Prepares the application again when its page is no longer open. */
  onPrepareApplicationAgain?: (jobId: string) => Promise<void>;
  onSaveApplicationAnswer: (
    command: SaveApplicationAnswerCommandInput,
  ) => Promise<void>;
  onClearApplicationAnswer: (
    command: ClearApplicationAnswerCommandInput,
  ) => Promise<void>;
  onResolveApplyConsentRequest: (
    input: JobFinderApplyConsentActionInput,
  ) => void;
  onRevokeApplyRunApproval: (input: JobFinderApplyRunActionInput) => void;
  onSelectApplyRun: (runId: string) => void;
  onStartApplyCopilot: (input: JobFinderExactApplicationTarget) => void;
  onReviewResumePdf?: (jobId: string) => void;
  onStartAutoApplyQueue: (jobIds: string[]) => void;
  /** The mode chosen in Settings; decides what a finished fill means. */
  applyMode?: ApplyMode;
  onOpenSafeguards?: () => void;
  onOpenNeedsYou?: () => void;
  /** Open requests, so the question step can be answered on this panel. */
  userActionRequests?: readonly UserActionRequest[];
  onPerformUserAction?: (
    command: UserActionCommandInput,
  ) => void | Promise<void>;
  isUserActionPending?: (requestId: string) => boolean;
  onAllowSiteSaves?: (host: string | null) => void;
  /**
   * Pass-through only. The declared return type has to match the leaf's, or
   * the outcome the leaf uses to decide what the hand-off status claims would
   * be under-reported at every intermediate hop.
   */
  onFinishInBrowser?: FinishInBrowserHandler;
  onConfirmFinishedInBrowser?: (input: FinishInBrowserInput) => void;
  canConfirmFinishedInBrowser?: boolean;
  browserStepContinuesOnItsOwn?: boolean;
  confirmFinishedInBrowserStatus?: ConfirmFinishedInBrowserStatus;
  confirmFinishedInBrowserBlockerText?: string | null;
  selectedApplyRunId: string | null;
  selectedAttempt: ApplicationAttemptListRow | null;
  selectedRecord: ApplicationRecord | null;
  selectedRecordCompanyId?: string | null;
}

export function ApplicationsDetailPanel({
  progressNow,
  onReturnToShortlist,
  applyMode,
  activeFilter,
  customStages,
  readApplyRunContext,
  applyRunDetails,
  applyRunDetailsTarget,
  applyRunDetailsError,
  applyRunDetailsStatus,
  applicationAttempts = [],
  applicationRecords,
  applyJobResults,
  dailyPreparationCapacity,
  discoveryJobs,
  applyRunHistory,
  effectiveSelectedApplyResult,
  hasAnyApplications,
  hasVisibleApplications,
  isApplyPending,
  applicationWorkPaused = false,
  isApplyRequestPending,
  isApplyRunPending,
  onApproveApplyRun,
  onOpenCompany,
  onExportApplicationPacket,
  onResolveSubmissionOutcome,
  onSaveApplicationAnswer,
  onClearApplicationAnswer,
  onResolveApplyConsentRequest,
  onSelectApplyRun,
  onStartApplyCopilot,
  onReviewResumePdf,
  onStartAutoApplyQueue,
  onOpenSafeguards,
  onOpenNeedsYou,
  userActionRequests,
  answerDraft,
  answerDraftRestored,
  onAnswerDraftChange,
  onPerformUserAction,
  isUserActionPending,
  onAllowSiteSaves,
  onFinishInBrowser,
  onConfirmFinishedInBrowser,
  canConfirmFinishedInBrowser,
  browserStepContinuesOnItsOwn,
  confirmFinishedInBrowserStatus,
  confirmFinishedInBrowserBlockerText,
  selectedApplyRunId,
  selectedAttempt,
  selectedRecord,
  selectedRecordCompanyId,
  onSubmitPreparedApplication,
  onPrepareApplicationAgain,
}: ApplicationsDetailPanelProps) {
  const visibleApplyResult = effectiveSelectedApplyResult;
  const pageStateResults = useMemo(
    () => (visibleApplyResult ? [visibleApplyResult] : []),
    [visibleApplyResult],
  );
  const applicationPageState =
    useApplicationPageStates(pageStateResults).get(
      visibleApplyResult?.id ?? "",
    ) ?? null;
  const pendingQuestions = selectedRecord
    ? listPendingApplicationQuestions({
        applicationAttempts,
        applicationRecordId: selectedRecord.id,
        jobId: selectedRecord.jobId,
      })
    : [];
  const pendingQuestionCount = pendingQuestions.length;
  const answerRun = effectiveSelectedApplyResult
    ? (applyRunHistory.find(
        ({ result }) => result.runId === effectiveSelectedApplyResult.runId,
      )?.run ?? null)
    : null;
  // The question step for this application, answerable right here.
  const answerRequest =
    selectedRecord && onPerformUserAction
      ? findActionableApplicationAnswerRequest({
          applicationRecordId: selectedRecord.id,
          jobId: selectedRecord.jobId,
          requests: userActionRequests,
          run: answerRun,
        })
      : null;
  const selectedRecordJob = selectedRecord
    ? (discoveryJobs.find((job) => job.id === selectedRecord.jobId) ?? null)
    : null;
  const answerStep: ApplicationAnswerStep | null =
    answerRequest && onPerformUserAction && pendingQuestions.length > 0
      ? {
          request: answerRequest,
          ...(answerDraft ? { draft: answerDraft } : {}),
          ...(onAnswerDraftChange
            ? { onDraftChange: onAnswerDraftChange }
            : {}),
          draftRestored: answerDraftRestored ?? false,
          jobLocation: selectedRecordJob?.location,
          questions: pendingQuestions,
          runSends: selectedRecord?.automationMode === "autonomous_submit",
          isPending: isUserActionPending?.(answerRequest.id) ?? false,
          waitingForTurn: selectedRecordJob
            ? isSameSiteApplicationActive(
                selectedRecordJob,
                applyJobResults,
                new Map(discoveryJobs.map((job) => [job.id, job])),
              )
            : false,
          onCommand: onPerformUserAction,
        }
      : null;
  // Where this application stands, in the one vocabulary the screen uses.
  const applyPresentation = selectedRecord
    ? getApplicationApplyPresentation({
        record: selectedRecord,
        applyResult: effectiveSelectedApplyResult,
      })
    : null;
  const canRestageAutoRun =
    selectedRecord?.status === "approved" ||
    selectedRecord?.status === "ready_for_review";
  const selectedRunHistoryEntry = useMemo(
    () =>
      applyRunHistory.find(
        ({ result }) => result.runId === selectedApplyRunId,
      ) ?? null,
    [applyRunHistory, selectedApplyRunId],
  );
  const selectedApplyRunDetails = useMemo(
    () =>
      applyRunDetailsStatus === "ready" &&
      selectedRecord != null &&
      applyRunDetailsTarget?.jobId === selectedRecord.jobId &&
      applyRunDetailsTarget.applicationRecordId === selectedRecord.id &&
      applyRunDetailsTarget.runId === selectedApplyRunId &&
      applyRunDetails?.run?.id === selectedApplyRunId
        ? applyRunDetails
        : null,
    [
      applyRunDetails,
      applyRunDetailsStatus,
      applyRunDetailsTarget,
      selectedApplyRunId,
      selectedRecord,
    ],
  );
  const selectedRun = selectedApplyRunDetails
    ? selectedApplyRunDetails.run
    : (selectedRunHistoryEntry?.run ?? null);
  const visibleApplyRunId =
    selectedApplyRunDetails?.run.id ?? visibleApplyResult?.runId ?? null;
  const selectedQueueEntries = useMemo(
    () =>
      buildQueueEntries({
        applicationRecords,
        applyJobResults,
        discoveryJobs,
        selectedRun,
      }),
    [applicationRecords, applyJobResults, discoveryJobs, selectedRun],
  );
  const selectedQueueRecoveryEntries = selectedQueueEntries.filter(
    (entry) => entry.includeInRecovery,
  );
  const selectedQueueRecoveryJobIds = selectedQueueRecoveryEntries.map(
    (entry) => entry.jobId,
  );
  const excludedQueueRecoveryEntries = selectedQueueEntries.filter(
    (entry) => !entry.includeInRecovery,
  );
  const canRestageQueueRun =
    selectedRun?.mode === "queue_auto" &&
    selectedQueueRecoveryJobIds.length > 0;
  // The same five words the row uses (ADR 0022), read from the newest run;
  // the older stage words only for a record no run has touched yet.
  const selectedApplyState =
    selectedRecord && visibleApplyResult
      ? resolveApplyStatePresentation({
          ...(progressNow === undefined ? {} : { now: progressNow }),
          recordCrm: selectedRecord.crm,
          recordLatestBlocker: selectedRecord.latestBlocker,
          mode:
            selectedRecord.automationMode === "autonomous_submit"
              ? "apply_for_me"
              : "fill_only",
          result: visibleApplyResult,
          run: readApplyRunContext?.(visibleApplyResult) ?? null,
          pendingQuestionCount:
            selectedRecord.questionSummary.total -
            selectedRecord.questionSummary.answered,
          recordLastActionLabel: selectedRecord.lastActionLabel,
          recordFailure:
            selectedRecord.lastAttemptState === "failed"
              ? {
                  lastActionLabel: selectedRecord.lastActionLabel,
                  lastUpdatedAt: selectedRecord.lastUpdatedAt,
                }
              : null,
        })
      : null;
  const selectedHiringStage = selectedRecord
    ? trackedHiringStageBadge(selectedRecord, customStages)
    : null;
  const selectedApplyStage = selectedApplyState
    ? {
        label: selectedApplyState.title,
        tone:
          selectedApplyState.kind === "applied"
            ? ("positive" as const)
            : selectedApplyState.cancelledByPerson
              ? ("muted" as const)
              : selectedApplyState.formClosed
                ? ("warning" as const)
                : selectedApplyState.kind === "could_not_apply"
                  ? ("critical" as const)
                  : selectedApplyState.kind === "needs_you"
                    ? ("warning" as const)
                    : ("active" as const),
      }
    : selectedRecord
      ? getApplicationStagePresentation(selectedRecord)
      : null;
  const selectedStage = selectedHiringStage ?? selectedApplyStage;
  // Prepare-only runs never reach a "submitted" status, so the tracker stage
  // the user records by hand is the path that actually enables this.
  const canPrepareInterview = selectedRecord
    ? selectedRecord.lastAttemptState === "submitted" ||
      ["submitted", "assessment", "interview", "offer"].includes(
        selectedRecord.status,
      ) ||
      ["assessment", "interview", "offer"].includes(
        inferApplicationCrmStageForView(selectedRecord),
      )
    : false;
  const needsPrimaryRecovery = selectedRecord
    ? applicationNeedsPrimaryRecovery({
        lastAttemptState: selectedRecord.lastAttemptState,
        visibleApplyResult,
      })
    : false;
  // The one control this panel is asking for cannot be the one the reader has
  // to find. Moving the approval block above the documents was not enough at
  // the panel's smallest height, where it still sat below the fold and was
  // reachable only by tabbing into the pane, so while an approval is pending
  // the action is pinned to the panel's own footer, outside the scroller.
  const awaitingPreparationApproval = isAwaitingPreparationApproval(
    selectedApplyRunDetails,
  );
  const pinnedApproval =
    selectedRecord &&
    awaitingPreparationApproval &&
    selectedApplyRunDetails?.submitApproval
      ? {
          approval: selectedApplyRunDetails.submitApproval,
          record: selectedRecord,
        }
      : null;

  // Existing drafts remain accessible while the form waits for answers.
  const documentsSection = selectedRecord ? (
    <ApplicationsApplicationDocuments
      applicationRecord={selectedRecord}
      applyRunDetails={selectedApplyRunDetails}
      demoteAsSecondary={needsPrimaryRecovery}
    />
  ) : null;

  const reviewTargetRef = useRef<HTMLDivElement>(null);
  const recoverySection = selectedRecord ? (
    <ApplicationsDetailPanelRecoverySections
      progressNow={progressNow}
      {...(applyMode ? { applyMode } : {})}
      canRestageAutoRun={canRestageAutoRun}
      canRestageQueueRun={canRestageQueueRun}
      dailyPreparationCapacity={dailyPreparationCapacity}
      excludedQueueRecoveryEntries={excludedQueueRecoveryEntries}
      isApplyPending={isApplyPending}
      applicationWorkPaused={applicationWorkPaused}
      onStartApplyCopilot={onStartApplyCopilot}
      {...(onReviewResumePdf ? { onReviewResumePdf } : {})}
      onStartAutoApplyQueue={onStartAutoApplyQueue}
      {...(applyPresentation?.state === "awaiting_your_review"
        ? {
            onReviewBeforeSending: () => {
              reviewTargetRef.current?.scrollIntoView({
                block: "start",
                behavior: "smooth",
              });
              reviewTargetRef.current?.focus({ preventScroll: true });
            },
          }
        : {})}
      {...(onOpenSafeguards ? { onOpenSafeguards } : {})}
      {...(onOpenNeedsYou ? { onOpenNeedsYou } : {})}
      answerStep={answerStep}
      {...(onAllowSiteSaves ? { onAllowSiteSaves } : {})}
      {...(onFinishInBrowser ? { onFinishInBrowser } : {})}
      {...(onConfirmFinishedInBrowser ? { onConfirmFinishedInBrowser } : {})}
      canConfirmFinishedInBrowser={canConfirmFinishedInBrowser ?? false}
      browserStepContinuesOnItsOwn={browserStepContinuesOnItsOwn ?? false}
      confirmFinishedInBrowserStatus={confirmFinishedInBrowserStatus ?? "idle"}
      confirmFinishedInBrowserBlockerText={
        confirmFinishedInBrowserBlockerText ?? null
      }
      selectedQueueOutcomeEntries={selectedQueueEntries}
      selectedQueueRecoveryEntries={selectedQueueRecoveryEntries}
      selectedQueueRecoveryJobIds={selectedQueueRecoveryJobIds}
      // The same selector Needs you renders from, so the two screens can
      // never disagree about how many questions are pending.
      pausedQuestionCount={pendingQuestionCount}
      selectedRecordJobId={selectedRecord.jobId}
      selectedApplicationRecordId={selectedRecord.id}
      selectedRecordLastActionLabel={selectedRecord.lastActionLabel}
      personSendReceiptSummary={
        selectedRecord.personSendReceipt?.summary ?? null
      }
      selectedRecordTrackedAsApplied={isApplicationTrackedAsSentByPerson(
        selectedRecord.crm,
      )}
      selectedRecordLatestBlockerCode={
        selectedRecord.latestBlocker?.code ?? null
      }
      selectedRun={selectedRun}
      visibleApplyRunContext={readApplyRunContext?.(visibleApplyResult) ?? null}
      applicationPageState={applicationPageState}
      visibleApplyResult={visibleApplyResult}
    />
  ) : null;

  const selectedRecordEmployerDisplay = selectedRecord
    ? formatApplicationEmployerLine({
        company: selectedRecord.company,
        ...(selectedRecordJob?.canonicalUrl
          ? { canonicalUrl: selectedRecordJob.canonicalUrl }
          : {}),
      })
    : null;

  /**
   * Convenience destinations (Companies, interview prep). Useful, but never
   * the next step — when the application is waiting on the user they render
   * after the recovery actions so the action row is not pushed below the
   * fold at 1024x768.
   */
  // Only a run that actually reached the employer's send control leaves the
  // reader wondering whether something went out.
  const showNotSubmittedPill =
    visibleApplyResult?.privacyReceipt?.submissionOutcome?.outcome ===
    "not_submitted";
  const convenienceLinks = selectedRecord ? (
    <>
      {selectedRecordCompanyId &&
      onOpenCompany &&
      selectedRecordEmployerDisplay ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* Reference links, not actions: text links read as "also
              available" rather than as one more thing to do. */}
          <Button
            aria-label={`View ${selectedRecordEmployerDisplay} in Companies`}
            className="h-auto px-0 text-sm font-medium normal-case tracking-normal"
            onClick={() => onOpenCompany(selectedRecordCompanyId)}
            size="compact"
            type="button"
            variant="link"
          >
            {/* The employer is named just above; a long name ran past the
                panel edge here. */}
            View in Companies
          </Button>
          {canPrepareInterview ? (
            <Button
              asChild
              className="h-auto px-0 text-sm font-medium normal-case tracking-normal"
              size="compact"
              variant="link"
            >
              <a
                href={`#${buildLiveAssistantApplicationHref({
                  record: selectedRecord,
                  relatedJob: selectedRecordJob,
                })}`}
              >
                <Mic aria-hidden="true" className="size-4" focusable="false" />
                Prepare interview
              </a>
            </Button>
          ) : null}
        </div>
      ) : canPrepareInterview ? (
        <Button
          asChild
          className="h-10 justify-start px-3.5 text-sm font-medium normal-case tracking-normal"
          size="compact"
          variant="secondary"
        >
          <a
            href={`#${buildLiveAssistantApplicationHref({
              record: selectedRecord,
              relatedJob: selectedRecordJob,
            })}`}
          >
            <Mic aria-hidden="true" className="size-4" focusable="false" />
            Prepare interview
          </a>
        </Button>
      ) : null}
      {onReturnToShortlist &&
      resolveApplicationMoveBack(selectedRecord, selectedApplyState?.kind) ===
        "to_shortlisted" ? (
        <div>
          <Button
            className="h-auto px-0 text-sm font-medium normal-case tracking-normal"
            onClick={() => onReturnToShortlist(selectedRecord)}
            size="compact"
            type="button"
            variant="link"
          >
            Move back to Shortlisted
          </Button>
        </div>
      ) : null}
    </>
  ) : null;

  const headerStatusLabel = showNotSubmittedPill
    ? "Not sent"
    : selectedRecord
      ? (selectedHiringStage?.label ??
        (visibleApplyResult
          ? selectedApplyStage?.label
          : applicationCrmStageLabelForView(selectedRecord, customStages)) ??
        null)
      : "Nothing selected";

  return (
    <section
      className="@container/detail surface-panel-shell relative flex min-w-0 flex-col gap-6 overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border) px-8 py-5 xl:h-full xl:min-h-0"
      id="applications-detail-content"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid min-w-0 gap-0.5">
          {/* Title first, employer under it: the same order as the row the
              reader just clicked. The "Details" eyebrow said nothing the
              panel did not already show. */}
          {selectedRecord ? (
            <>
              <h2 className="min-w-0 break-words font-semibold tracking-tight text-(--text-headline)">
                {selectedRecord.title}
              </h2>
              {selectedRecordEmployerDisplay ? (
                <span className="text-(length:--text-small) text-foreground-soft">
                  {selectedRecordEmployerDisplay}
                </span>
              ) : null}
            </>
          ) : hasAnyApplications ? (
            <strong className="text-(length:--text-body) text-muted-foreground">
              Nothing selected
            </strong>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {showNotSubmittedPill ? (
            <StatusBadge
              data-testid="applications-not-submitted-pill"
              tone="muted"
            >
              Not sent
            </StatusBadge>
          ) : null}
          {/* "Nothing selected" as a heading and again as a badge said it
              twice; the badge is a record's stage, so only a record has one. */}
          {!showNotSubmittedPill && selectedRecord ? (
            <StatusBadge tone={selectedStage ? selectedStage.tone : "muted"}>
              {headerStatusLabel ?? ""}
            </StatusBadge>
          ) : null}
        </div>
      </div>
      {selectedRecord ? (
        // A scroller that only names one axis still resolves the other to
        // `auto`, so at 1920 this pane drew a horizontal track beside its
        // vertical one and clipped run-history content into two-direction
        // scrolling. The pane scrolls vertically; its content wraps.
        <div
          className="grid min-h-0 min-w-0 flex-1 content-start gap-5 overflow-x-hidden overflow-y-auto pr-1"
          data-locked-pane-scroll-region
        >
          {/* "Not submitted" used to be a boxed paragraph above a NEXT STEP
              callout above the status block above the fact strip — four
              places for one fact. It is a pill beside the title now, and only
              where a run actually reached a send control and the reader might
              wonder. */}
          {needsPrimaryRecovery ? null : convenienceLinks}
          <ApplicationsDetailPanelOverviewSections
            selectedAttempt={selectedAttempt}
            selectedRecord={selectedRecord}
            visibleApplyResult={visibleApplyResult}
            visibleApplyRunId={visibleApplyRunId}
            plannedStanding={selectedApplyState?.plannedStanding ?? null}
            showFactStrip={!needsPrimaryRecovery}
            headerStatusLabel={headerStatusLabel}
            waitingOnSafetyLimitReview={
              selectedRun?.state === "paused_for_user_review" &&
              visibleApplyResult?.state === "planned"
            }
          />
          {/* The decision comes before the paperwork. This sat under the
              documents block, where it was not visible without tabbing into
              the panel, so a person who had read everything still could not
              see the one control the screen was asking them to use. */}
          <ApplicationsDetailPanelSubmitApprovalSection
            approvalScopeEntries={selectedQueueEntries.map(
              ({ jobId, label }) => ({ jobId, label }),
            )}
            showApproveAction={!awaitingPreparationApproval}
            isApplyRunPending={isApplyRunPending}
            onApproveApplyRun={onApproveApplyRun}
            selectedApplicationTarget={{
              applicationRecordId: selectedRecord.id,
              jobId: selectedRecord.jobId,
            }}
            selectedApplyRunDetails={selectedApplyRunDetails}
          />
          {/* Where the application stands and what it asks of you come
              first; the optional cover letter follows, never above them. */}
          {recoverySection}
          {needsPrimaryRecovery ? convenienceLinks : null}
          {needsPrimaryRecovery ? (
            <ApplicationsDetailFactStrip
              selectedAttempt={selectedAttempt}
              selectedRecord={selectedRecord}
              visibleApplyResult={visibleApplyResult}
              visibleApplyRunId={visibleApplyRunId}
              plannedStanding={selectedApplyState?.plannedStanding ?? null}
              headerStatusLabel={headerStatusLabel}
              waitingOnSafetyLimitReview={
                selectedRun?.state === "paused_for_user_review" &&
                visibleApplyResult?.state === "planned"
              }
            />
          ) : null}
          {/* Under Ask before sending, the send card (inside the activity
              sections) is the decision; the optional documents follow it. */}
          {applyPresentation?.state === "awaiting_your_review"
            ? null
            : documentsSection}
          {/* Same spacing as the sections above: History and details sat
              flush against Activity, with a wide gap before them. */}
          <div
            className="grid min-w-0 gap-5"
            data-application-review-target
            ref={reviewTargetRef}
            tabIndex={-1}
          >
            <ApplicationsDetailPanelActivitySections
              {...(applyMode ? { applyMode } : {})}
              applyRunDetailsError={applyRunDetailsError}
              applyRunDetailsStatus={applyRunDetailsStatus}
              applyRunHistory={applyRunHistory}
              isApplyRequestPending={isApplyRequestPending}
              onResolveApplyConsentRequest={onResolveApplyConsentRequest}
              onExportApplicationPacket={onExportApplicationPacket}
              {...(onResolveSubmissionOutcome
                ? { onResolveSubmissionOutcome }
                : {})}
              onSaveApplicationAnswer={onSaveApplicationAnswer}
              onClearApplicationAnswer={onClearApplicationAnswer}
              onSelectApplyRun={onSelectApplyRun}
              {...(onSubmitPreparedApplication
                ? { onSubmitPreparedApplication }
                : {})}
              onOpenApplicationPage={
                onFinishInBrowser && visibleApplyResult
                  ? async (onReopenProgress) => {
                      // The same open the status block and the row use, so
                      // all three show the same step and outcome.
                      const outcome = await openApplicationForm(
                        onFinishInBrowser,
                        {
                          jobId: visibleApplyResult.jobId,
                          resultId: visibleApplyResult.id,
                          runId: visibleApplyResult.runId,
                          applicationRecordId: selectedRecord.id,
                          destinationUrl:
                            selectedApplyRunDetails?.reviewCard?.pageUrl ??
                            getApplyResultDestinationUrl(
                              visibleApplyResult.privacyReceipt,
                            ),
                        },
                        onReopenProgress,
                      );
                      if (outcome?.kind !== "opened_application_page")
                        throw new Error(
                          outcome?.kind === "failed" && outcome.reason
                            ? outcome.reason
                            : "The application page could not be opened. Prepare it again.",
                        );
                    }
                  : undefined
              }
              awaitsYourReview={
                applyPresentation?.state === "awaiting_your_review"
              }
              {...(onPrepareApplicationAgain
                ? { onPrepareApplicationAgain }
                : {})}
              applicationPageClosed={
                selectedRecord?.nextActionLabel === "Prepare again" ||
                pageNeedsPreparing(applicationPageState ?? undefined)
              }
              selectedApplyRunDetails={selectedApplyRunDetails}
              selectedApplyRunId={selectedApplyRunId}
              selectedAttempt={selectedAttempt}
              selectedRecord={selectedRecord}
              visibleApplyResult={visibleApplyResult}
            />
          </div>
          {applyPresentation?.state === "awaiting_your_review"
            ? documentsSection
            : null}
        </div>
      ) : (
        <ApplicationsDetailPanelEmptyState
          activeFilter={activeFilter}
          hasAnyApplications={hasAnyApplications}
          hasVisibleApplications={hasVisibleApplications}
        />
      )}
      {pinnedApproval ? (
        <div
          className="-mx-8 -mb-5 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-(--surface-panel-border) bg-(--surface-panel) px-8 py-4"
          data-testid="applications-pinned-preparation-approval"
        >
          <p className="text-(length:--text-small) leading-6 text-foreground-soft">
            {pinnedApproval.approval.jobIds.length === 1
              ? "This application is waiting for you to start it."
              : `These ${pinnedApproval.approval.jobIds.length} applications are waiting for you to start them.`}
          </p>
          <Button
            disabled={isApplyRunPending(pinnedApproval.approval.runId)}
            onClick={() =>
              onApproveApplyRun({
                applicationRecordId: pinnedApproval.record.id,
                jobId: pinnedApproval.record.jobId,
                runId: pinnedApproval.approval.runId,
              })
            }
            pending={isApplyRunPending(pinnedApproval.approval.runId)}
            type="button"
            variant="secondary"
          >
            {preparationApprovalActionLabel(
              pinnedApproval.approval.jobIds.length,
            )}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
