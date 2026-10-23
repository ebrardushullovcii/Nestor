import type {
  ApplicationPageState,
  GlobalDailyApplicationPreparationCapacity,
  JobFinderExactApplicationTarget,
  JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import type { QueueEntry } from "./applications-detail-panel-helpers";
import type { ApplicationAnswerStep } from "./applications-answer-step";
import type { ApplyRunContext } from "./applications-recovery-state";
import type { ApplyMode } from "../../lib/apply-mode-contracts-stub";
import {
  ApplicationsDetailPanelRecoveryActionsSection,
  type ConfirmFinishedInBrowserStatus,
  type FinishInBrowserHandler,
  type FinishInBrowserInput,
} from "./applications-detail-panel-recovery-actions-section";

/**
 * Recovery keeps only the action group here; the per-run history now lives in
 * the collapsed Technical details block rendered by the activity sections.
 */
export function ApplicationsDetailPanelRecoverySections(props: {
  progressNow?: number | undefined;
  /** The mode saved in Settings; a retry runs in it. */
  applyMode?: ApplyMode;
  canRestageAutoRun: boolean;
  canRestageQueueRun: boolean;
  dailyPreparationCapacity: GlobalDailyApplicationPreparationCapacity | null;
  excludedQueueRecoveryEntries: QueueEntry[];
  isApplyPending: boolean;
  onStartApplyCopilot: (input: JobFinderExactApplicationTarget) => void;
  onReviewResumePdf?: (jobId: string) => void;
  onStartAutoApplyQueue: (jobIds: string[]) => void;
  onOpenSafeguards?: () => void;
  onOpenNeedsYou?: () => void;
  answerStep?: ApplicationAnswerStep | null;
  onAllowSiteSaves?: (host: string | null) => void;
  /**
   * Pass-through only. The declared return type has to match the leaf's, or
   * the outcome the leaf uses to decide what the hand-off status claims would
   * be under-reported at every intermediate hop.
   */
  onFinishInBrowser?: FinishInBrowserHandler;
  onReviewBeforeSending?: () => void;
  onConfirmFinishedInBrowser?: (input: FinishInBrowserInput) => void;
  canConfirmFinishedInBrowser?: boolean;
  browserStepContinuesOnItsOwn?: boolean;
  confirmFinishedInBrowserStatus?: ConfirmFinishedInBrowserStatus;
  confirmFinishedInBrowserBlockerText?: string | null;
  selectedQueueOutcomeEntries: QueueEntry[];
  selectedQueueRecoveryEntries: QueueEntry[];
  selectedQueueRecoveryJobIds: string[];
  pausedQuestionCount?: number | null;
  selectedRecordJobId: string;
  selectedApplicationRecordId: string;
  selectedRecordLatestBlockerCode?: string | null;
  selectedRecordLastActionLabel?: string | null;
  selectedRecordTrackedAsApplied?: boolean;
  personSendReceiptSummary?: string | null;
  selectedRun: JobFinderRendererWorkspaceSnapshot["applyRuns"][number] | null;
  /** What the visible result's run is doing (a planned job's standing). */
  visibleApplyRunContext?: ApplyRunContext | null;
  applicationPageState?: ApplicationPageState | null;
  visibleApplyResult:
    | JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]
    | null;
}) {
  const {
    canRestageAutoRun,
    canRestageQueueRun,
    dailyPreparationCapacity,
    excludedQueueRecoveryEntries,
    isApplyPending,
    onStartApplyCopilot,
    onReviewResumePdf,
    onStartAutoApplyQueue,
    onOpenSafeguards,
    onOpenNeedsYou,
    answerStep = null,
    onAllowSiteSaves,
    onFinishInBrowser,
    onReviewBeforeSending,
    onConfirmFinishedInBrowser,
    canConfirmFinishedInBrowser,
    browserStepContinuesOnItsOwn,
    confirmFinishedInBrowserStatus,
    confirmFinishedInBrowserBlockerText,
    selectedQueueOutcomeEntries,
    selectedQueueRecoveryEntries,
    selectedQueueRecoveryJobIds,
    selectedApplicationRecordId,
    selectedRecordLatestBlockerCode,
    selectedRecordLastActionLabel = null,
    selectedRecordTrackedAsApplied = false,
    pausedQuestionCount,
    selectedRecordJobId,
    selectedRun,
    visibleApplyRunContext = null,
    visibleApplyResult,
  } = props;

  return (
    <ApplicationsDetailPanelRecoveryActionsSection
      progressNow={props.progressNow}
      {...(props.applyMode ? { applyMode: props.applyMode } : {})}
      canRestageAutoRun={canRestageAutoRun}
      canRestageQueueRun={canRestageQueueRun}
      dailyPreparationCapacity={dailyPreparationCapacity}
      excludedQueueRecoveryEntries={excludedQueueRecoveryEntries}
      isApplyPending={isApplyPending}
      onStartApplyCopilot={onStartApplyCopilot}
      {...(onReviewResumePdf ? { onReviewResumePdf } : {})}
      onStartAutoApplyQueue={onStartAutoApplyQueue}
      {...(onOpenSafeguards ? { onOpenSafeguards } : {})}
      {...(onOpenNeedsYou ? { onOpenNeedsYou } : {})}
      answerStep={answerStep}
      {...(onAllowSiteSaves ? { onAllowSiteSaves } : {})}
      {...(onFinishInBrowser ? { onFinishInBrowser } : {})}
      {...(onReviewBeforeSending ? { onReviewBeforeSending } : {})}
      {...(onConfirmFinishedInBrowser ? { onConfirmFinishedInBrowser } : {})}
      canConfirmFinishedInBrowser={canConfirmFinishedInBrowser ?? false}
      browserStepContinuesOnItsOwn={browserStepContinuesOnItsOwn ?? false}
      confirmFinishedInBrowserStatus={confirmFinishedInBrowserStatus ?? "idle"}
      confirmFinishedInBrowserBlockerText={
        confirmFinishedInBrowserBlockerText ?? null
      }
      selectedQueueOutcomeEntries={selectedQueueOutcomeEntries}
      selectedQueueRecoveryEntries={selectedQueueRecoveryEntries}
      selectedQueueRecoveryJobIds={selectedQueueRecoveryJobIds}
      selectedApplicationRecordId={selectedApplicationRecordId}
      selectedRecordLastActionLabel={selectedRecordLastActionLabel}
      selectedRecordTrackedAsApplied={selectedRecordTrackedAsApplied}
      personSendReceiptSummary={props.personSendReceiptSummary ?? null}
      {...(selectedRecordLatestBlockerCode !== undefined
        ? { selectedRecordLatestBlockerCode }
        : {})}
      pausedQuestionCount={pausedQuestionCount ?? null}
      selectedRecordJobId={selectedRecordJobId}
      selectedRun={selectedRun}
      visibleApplyRunContext={visibleApplyRunContext}
      applicationPageState={props.applicationPageState ?? null}
      visibleApplyResult={visibleApplyResult}
    />
  );
}
