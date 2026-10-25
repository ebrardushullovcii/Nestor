import type {
  ApplicationPageState,
  GlobalDailyApplicationPreparationCapacity,
  JobFinderExactApplicationTarget,
  JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import { useId } from "react";
import {
  ApplicationAnswerStepCard,
  type ApplicationAnswerStep,
} from "./applications-answer-step";
import { Button } from "@renderer/components/ui";
import {
  formatDailyPreparationBatchExceedsRemainingText,
  formatDailyPreparationCapacityReachedText,
  isDailyPreparationCapacityExhausted,
} from "@renderer/features/job-finder/lib/job-finder-daily-capacity";
import {
  CONFIRM_STEP_DONE_ACTION,
  CONFIRM_STEP_DONE_PENDING_LABEL,
  JOB_FINDER_BROWSER_NAME,
  JOB_FINDER_BROWSER_UNAVAILABLE_NOTE,
  OPEN_JOB_FINDER_BROWSER_ACTION,
  REOPEN_JOB_FINDER_BROWSER_ACTION,
  RUN_PREPARATION_AGAIN_ACTION,
} from "../../lib/job-finder-browser-handoff-copy";
import { resolveApplyStatePresentation } from "./apply-state";
import type { ApplyMode } from "../../lib/apply-mode-contracts-stub";
import { StatusBadge } from "../../components/status-badge";
import { APPLICATION_WORK_PAUSED_REASON } from "../../lib/application-work-paused";
import {
  getApplyResultDestinationUrl,
  getCustomerFacingApplyText,
  getQueueRecoveryTone,
  getQueueStateExplanation,
  type QueueEntry,
} from "./applications-detail-panel-helpers";
import {
  getApplicationHostLabel,
  resolveApplicationRecoveryPresentation,
  resolvePlannedApplyStanding,
  type ApplyRunContext,
} from "./applications-recovery-state";

import {
  describeFormOpenOutcome,
  formOpenPhaseLabel,
  openApplicationForm,
  useApplicationFormOpenState,
  type FinishInBrowserHandler,
  type FinishInBrowserInput,
} from "./application-form-open";

export type {
  FinishInBrowserHandler,
  FinishInBrowserInput,
  FinishInBrowserOutcome,
} from "./application-form-open";
import type { ApplicationQueueHold } from "./application-queue-hold";

/**
 * Resolution state of the "I finished this step" verification, derived from
 * the exact pending browser-step request rather than from the fire-and-forget
 * command that starts it.
 */
export type ConfirmFinishedInBrowserStatus =
  | "idle"
  | "checking"
  | "still_blocked";

/**
 * Every control in the recovery row shares one box metric so the row cannot
 * render at three heights and three tops the way it did in the round-eight
 * captures. Weight and fill carry the hierarchy; geometry does not.
 */
const RECOVERY_ACTION_CLASS_NAME =
  "h-auto min-h-11 w-fit min-w-0 max-w-full whitespace-normal px-4 py-2.5 text-(length:--text-body) leading-5";
const RECOVERY_PRIMARY_ACTION_CLASS_NAME = `${RECOVERY_ACTION_CLASS_NAME} font-semibold`;

export function ApplicationsDetailPanelRecoveryActionsSection(props: {
  progressNow?: number | undefined;
  /** The Apply queue set this job aside before it started. */
  queueHold?: ApplicationQueueHold | null;
  /** The employer, for a held job's sentence. */
  company?: string;
  /** The mode saved in Settings; a retry runs in it and is named for it. */
  applyMode?: ApplyMode;
  canRestageAutoRun: boolean;
  canRestageQueueRun: boolean;
  dailyPreparationCapacity: GlobalDailyApplicationPreparationCapacity | null;
  excludedQueueRecoveryEntries: QueueEntry[];
  isApplyPending: boolean;
  /** All work is paused: nothing here may start an application. */
  applicationWorkPaused?: boolean;
  onStartApplyCopilot: (input: JobFinderExactApplicationTarget) => void;
  onReviewResumePdf?: (jobId: string) => void;
  onStartAutoApplyQueue: (jobIds: string[]) => void;
  onOpenSafeguards?: () => void;
  /** Takes the person to the Needs you step that holds the answer control. */
  onOpenNeedsYou?: () => void;
  /** The question step, answerable here instead of only on Needs you. */
  answerStep?: ApplicationAnswerStep | null;
  /**
   * Adds this host to the saved automation setting with saving-as-you-go
   * allowed, then starts the retry. Without it the state has nothing that can
   * change the refusal, so the control is not drawn.
   */
  onAllowSiteSaves?: (host: string | null) => void;
  /**
   * Reports what the hand-off did so the status beside it can say the same
   * thing. Every intermediate panel declares this same return type, so the
   * outcome is not under-reported on the way down. `void` stays accepted so a
   * handler that reports nothing gets no status at all rather than an
   * unearned success claim.
   */
  onFinishInBrowser?: FinishInBrowserHandler;
  onReviewBeforeSending?: () => void;
  /**
   * Runs the exact verification Needs you runs for the pending browser step on
   * this result. Without it the loop had two homes: Applications sent the user
   * to the browser and only Needs you — a page they were never told to visit —
   * could take them back in.
   */
  onConfirmFinishedInBrowser?: (input: FinishInBrowserInput) => void;
  canConfirmFinishedInBrowser?: boolean;
  /**
   * The pending browser step is an application sign-in Job Finder watches on
   * the kept page; the run carries on by itself, so no check is offered.
   */
  browserStepContinuesOnItsOwn?: boolean;
  /**
   * Live state of the verification this section starts, read from the exact
   * pending browser-step request. `checking` while the check runs and
   * `still_blocked` once it came back without the step being complete; without
   * it the click produced a "Verification started…" banner and then nothing
   * changed in place for the rest of the wait.
   */
  confirmFinishedInBrowserStatus?: ConfirmFinishedInBrowserStatus;
  confirmFinishedInBrowserBlockerText?: string | null;
  selectedQueueOutcomeEntries: QueueEntry[];
  selectedQueueRecoveryEntries: QueueEntry[];
  selectedQueueRecoveryJobIds: string[];
  /** How many questions the form is still waiting on, from the record. */
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
  /** Whether the visible result's filled-in form is open, reopenable or gone. */
  applicationPageState?: ApplicationPageState | null;
  visibleApplyResult:
    | JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]
    | null;
}) {
  const {
    canRestageAutoRun,
    canRestageQueueRun,
    dailyPreparationCapacity,
    isApplyPending,
    applicationWorkPaused = false,
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
    browserStepContinuesOnItsOwn = false,
    confirmFinishedInBrowserStatus = "idle",
    confirmFinishedInBrowserBlockerText,
    selectedQueueOutcomeEntries,
    selectedQueueRecoveryJobIds,
    pausedQuestionCount,
    selectedRecordJobId,
    selectedApplicationRecordId,
    selectedRecordLatestBlockerCode,
    selectedRecordLastActionLabel = null,
    selectedRecordTrackedAsApplied = false,
    selectedRun,
    visibleApplyRunContext = null,
    visibleApplyResult,
  } = props;
  // One state, one sentence, one action. Everything visible in the top block
  // below is chosen here rather than by six overlapping booleans, so the panel
  // can no longer show a "Try again" pair beside a third automation button.
  const presentation = resolveApplicationRecoveryPresentation({
    ...(props.progressNow === undefined ? {} : { now: props.progressNow }),
    ...(props.applyMode ? { applyMode: props.applyMode } : {}),
    canOpenSafeguards: Boolean(onOpenSafeguards),
    destinationUrl: getApplyResultDestinationUrl(
      visibleApplyResult?.privacyReceipt,
    ),
    isApplyPending,
    recordLastActionLabel: selectedRecordLastActionLabel,
    recordTrackedAsApplied: selectedRecordTrackedAsApplied,
    personSendReceiptSummary: props.personSendReceiptSummary ?? null,
    ...(selectedRecordLatestBlockerCode !== undefined
      ? { recordLatestBlockerCode: selectedRecordLatestBlockerCode }
      : {}),
    pausedQuestionCount: pausedQuestionCount ?? null,
    run: visibleApplyRunContext,
    applicationPageState: props.applicationPageState ?? null,
    queueHold: props.queueHold ?? null,
    ...(props.company ? { company: props.company } : {}),
    visibleApplyResult,
  });
  const { primaryAction } = presentation;
  // A pause the person has to finish themselves owns the primary path — never
  // show an in-progress spinner that contradicts the sentence above it.
  const needsUserFinishPath =
    presentation.state === "finish_in_browser" ||
    presentation.state === "site_blocked";
  // "Filling this application now" only for a job that is being filled in:
  // one waiting its turn or held by the person's pause says so above.
  const showPreparingState =
    (visibleApplyResult?.automaticSendPending !== true ||
      visibleApplyResult?.privacyReceipt?.submissionOutcome != null) &&
    primaryAction !== "close_finished_tabs" &&
    presentation.state === "preparing" &&
    resolvePlannedApplyStanding(visibleApplyResult, visibleApplyRunContext) ===
      null;
  // The queue action is meaningful only when the selected run produced a
  // recoverable queue. Keep an empty or non-queue selection out of the action
  // group instead of leaving a disabled control without a target.
  const showQueueRecoveryAction =
    canRestageQueueRun && selectedQueueRecoveryJobIds.length > 0;
  // The fixed local-day safeguard is enforced fail-closed by the workspace
  // service. When nothing remains, every start control is disabled here so no
  // dialog or run can begin, and the reached state is stated in plain text
  // with the exact usage and reset timing instead of a silent no-op.
  const isDailyCapacityExhausted = isDailyPreparationCapacityExhausted(
    dailyPreparationCapacity,
  );
  // The pause holds every start the same way the spent day does.
  const isStartBlocked = isDailyCapacityExhausted || applicationWorkPaused;
  const dailyCapacityReachedText =
    dailyPreparationCapacity && isDailyCapacityExhausted
      ? formatDailyPreparationCapacityReachedText(dailyPreparationCapacity)
      : null;
  // A partial exceedance keeps its own control-associated reason so the
  // disabled multi-job control names the selected count, the remaining
  // slots, and the local reset timing instead of reading as full
  // exhaustion, which stays owned by the reached summary below. Single-job
  // retry keeps working while any slot remains.
  const selectedQueueRecoveryExceedsDailyRemaining =
    showQueueRecoveryAction &&
    dailyPreparationCapacity !== null &&
    !isDailyCapacityExhausted &&
    selectedQueueRecoveryJobIds.length > dailyPreparationCapacity.remaining;
  const queueRecoveryExceedsNoteId = useId();
  const dailyQueueRecoveryExceedsRemainingReason =
    dailyPreparationCapacity && selectedQueueRecoveryExceedsDailyRemaining
      ? formatDailyPreparationBatchExceedsRemainingText({
          capacity: dailyPreparationCapacity,
          selectedCount: selectedQueueRecoveryJobIds.length,
        })
      : null;
  // A fresh run is offered under More only where a fresh run could change
  // anything. A structural stop — no apply route, closed listing, applying
  // happens elsewhere — offers no retry at all, here or above.
  const showSecondaryRunAgain =
    canRestageAutoRun &&
    primaryAction !== "try_again" &&
    presentation.state !== "preparing" &&
    presentation.state !== "verify_outcome" &&
    presentation.state !== "structural_stop" &&
    !isStartBlocked;
  // The site-saves state keeps the browser hand-off as its secondary way out,
  // for a person who would rather finish it there than grant the permission.
  const showSecondaryOpenBrowser =
    (presentation.state === "site_saves_as_you_go" ||
      Boolean(onReviewBeforeSending)) &&
    Boolean(onFinishInBrowser && visibleApplyResult);
  const hasSecondaryActions =
    showSecondaryRunAgain ||
    showQueueRecoveryAction ||
    showSecondaryOpenBrowser;

  // Opening this result's form, wherever it was pressed (this panel, its
  // review card or the row in the list): the step while it opens, then what
  // the hand-off did.
  const formOpenState = useApplicationFormOpenState(visibleApplyResult?.id);
  const finishInBrowserOutcome =
    visibleApplyResult &&
    presentation.state !== "submitted" &&
    formOpenState &&
    "outcome" in formOpenState
      ? formOpenState.outcome
      : null;
  /**
   * True once this exact result's application page has actually been opened
   * in the Job Finder browser. Pressing the primary action used to leave the
   * button identical and still primary, so the only proof anything had
   * happened was a passive grey box; a real hand-off now visibly demotes the
   * open action and promotes the confirm action in its place. A fall-back
   * that only opened the window, or a failure, must not demote it: the page
   * still needs opening.
   */
  const hasHandedOffToBrowser =
    finishInBrowserOutcome?.kind === "opened_application_page";
  const reopenPhaseLabel = formOpenPhaseLabel(formOpenState);
  const finishInBrowserStatus =
    finishInBrowserOutcome === null
      ? null
      : describeFormOpenOutcome(finishInBrowserOutcome, {
          continuesOnItsOwn: browserStepContinuesOnItsOwn,
          readyToSend:
            presentation.state === "finish_in_browser" &&
            visibleApplyResult?.state === "awaiting_review",
        });
  const finishInBrowserUnavailableNoteId = useId();
  const canFinishInBrowser = Boolean(onFinishInBrowser && visibleApplyResult);
  const handleFinishInBrowser = () => {
    if (!onFinishInBrowser || !visibleApplyResult) {
      return;
    }

    void openApplicationForm(onFinishInBrowser, {
      jobId: visibleApplyResult.jobId,
      resultId: visibleApplyResult.id,
      runId: visibleApplyResult.runId,
      applicationRecordId:
        visibleApplyResult.applicationRecordId ?? selectedApplicationRecordId,
      destinationUrl: getApplyResultDestinationUrl(
        visibleApplyResult.privacyReceipt,
      ),
    });
  };
  const canConfirmFinished = Boolean(
    onConfirmFinishedInBrowser &&
    canConfirmFinishedInBrowser &&
    visibleApplyResult,
  );
  const showConfirmFinishedAction = needsUserFinishPath && canConfirmFinished;
  // The verification runs in the background after the click. Until it settles,
  // the button says so in place and stays disabled; when it comes back without
  // the step complete, the same place says why and offers the check again.
  const isCheckingFinishedInBrowser =
    canConfirmFinished && confirmFinishedInBrowserStatus === "checking";
  const isStillBlockedAfterCheck =
    canConfirmFinished && confirmFinishedInBrowserStatus === "still_blocked";
  const confirmFinishedInBrowserStatusBaseId = useId();
  const confirmFinishedInBrowserStatusId =
    isCheckingFinishedInBrowser || isStillBlockedAfterCheck
      ? confirmFinishedInBrowserStatusBaseId
      : null;
  const handleConfirmFinishedInBrowser = () => {
    if (!onConfirmFinishedInBrowser || !visibleApplyResult) {
      return;
    }

    onConfirmFinishedInBrowser({
      jobId: visibleApplyResult.jobId,
      resultId: visibleApplyResult.id,
      runId: visibleApplyResult.runId,
      applicationRecordId:
        visibleApplyResult.applicationRecordId ?? selectedApplicationRecordId,
      destinationUrl: getApplyResultDestinationUrl(
        visibleApplyResult.privacyReceipt,
      ),
    });
  };
  const rejectedFormat =
    presentation.state === "reattach_resume" &&
    onReviewResumePdf !== undefined &&
    /rejected|not accepted|unsupported|upload a nonempty|file (?:type|format)/iu.test(
      [
        visibleApplyResult?.summary,
        visibleApplyResult?.detail,
        visibleApplyResult?.blockerSummary,
      ]
        .filter(Boolean)
        .join(" "),
    );
  const startFreshRun = () =>
    onStartApplyCopilot({
      jobId: selectedRecordJobId,
      applicationRecordId: selectedApplicationRecordId,
    });
  // The hand-off is the one browser control; the label is whatever the state
  // earned it. A structural stop opens the listing rather than the form.
  const browserActionLabel = hasHandedOffToBrowser
    ? REOPEN_JOB_FINDER_BROWSER_ACTION
    : presentation.primaryActionLabel;

  return (
    <>
      <section
        className="surface-card-tint grid gap-5 rounded-(--radius-field) border border-(--surface-panel-border) px-5 py-5"
        data-recovery-state={presentation.state}
      >
        {/* The state in plain words, then the run's own sentence about why it
            is in that state. "Job Finder could not finish this application"
            with the reason three disclosures down in Run details is the
            complaint this block answers. */}
        <div className="grid min-w-0 max-w-prose gap-1.5">
          {/* "Prepare again" over a "Prepare again" button said it twice;
              the heading stays for screen readers only then. */}
          <h3
            className={
              presentation.statusLine.trim().toLowerCase() ===
              browserActionLabel?.trim().toLowerCase()
                ? "sr-only"
                : "text-(length:--text-body) font-semibold text-(--text-headline)"
            }
            data-testid="applications-recovery-status-line"
          >
            {presentation.statusLine}
          </h3>
          {presentation.reasonSentence &&
          !(
            visibleApplyResult?.state === "submitted" &&
            visibleApplyResult.privacyReceipt?.submissionOutcome?.outcome ===
              "submitted" &&
            visibleApplyResult.privacyReceipt.submissionOutcome.evidence
              .length > 0 &&
            !props.personSendReceiptSummary
          ) ? (
            <p
              className="text-(length:--text-small) leading-6 text-foreground-soft"
              data-testid="applications-recovery-reason"
            >
              {presentation.reasonSentence}
            </p>
          ) : null}
          {!props.personSendReceiptSummary &&
          visibleApplyResult?.state === "submitted" &&
          visibleApplyResult.privacyReceipt?.submissionOutcome?.outcome ===
            "submitted" ? (
            <div className="grid min-w-0 gap-1" data-site-confirmation>
              {visibleApplyResult.privacyReceipt.submissionOutcome.evidence
                .filter(
                  (entry, index, entries) =>
                    entries.findIndex(
                      (other) => other.summary === entry.summary,
                    ) === index,
                )
                .map((entry) => (
                  <p
                    key={entry.id}
                    className="break-words text-(length:--text-small) leading-6 text-foreground-soft"
                  >
                    {entry.summary}
                  </p>
                ))}
            </div>
          ) : null}
        </div>
        {primaryAction === "try_again" && !rejectedFormat && isApplyPending ? (
          // The press is answered in place while the run starts, before the
          // run's own state replaces this block.
          <p
            aria-live="polite"
            className="flex min-w-0 items-center gap-2 text-(length:--text-small) leading-6 text-foreground-soft"
            data-testid="applications-recovery-starting"
            role="status"
          >
            <span
              aria-hidden="true"
              className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
            />
            <span>Opening the page…</span>
          </p>
        ) : null}
        {showPreparingState ? (
          <p
            aria-live="polite"
            className="flex min-w-0 items-center gap-2 text-(length:--text-small) leading-6 text-foreground-soft"
            data-testid="applications-recovery-progress"
            role="status"
          >
            <span
              aria-hidden="true"
              className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
              data-testid="applications-recovery-progress-spinner"
            />
            <span>
              {`Filling this application in ${JOB_FINDER_BROWSER_NAME} now. This can take a few minutes on a long form. When it is ready, Job Finder follows the application mode chosen in Settings.`}
            </span>
          </p>
        ) : null}
        {presentation.state === "verify_outcome" ? (
          <p
            className="text-(length:--text-small) leading-6 text-foreground-soft"
            data-testid="submission-outcome-verification-guidance"
          >
            Check this application on the employer site before doing anything
            else, then record what you saw below. Trying again stays unavailable
            until you do.
          </p>
        ) : null}
        {primaryAction === "none" ? null : (
          <div
            aria-label="Application recovery actions"
            className="flex min-w-0 max-w-full flex-wrap items-start justify-start gap-2"
            data-testid="applications-recovery-actions"
            role="group"
          >
            <div
              aria-label="Primary application recovery action"
              className="flex min-w-0 max-w-full flex-wrap items-stretch gap-2"
              data-testid="applications-recovery-primary-action"
              role="group"
            >
              {primaryAction === "close_finished_tabs" ? (
                <Button
                  className={RECOVERY_PRIMARY_ACTION_CLASS_NAME}
                  data-testid="applications-recovery-primary-action-button"
                  onClick={() =>
                    void window.nestor?.browser?.command({
                      type: "close_finished_tabs",
                    })
                  }
                  type="button"
                  variant="primary"
                >
                  {presentation.primaryActionLabel}
                </Button>
              ) : null}
              {primaryAction === "open_safeguards" && onOpenSafeguards ? (
                <Button
                  className={RECOVERY_PRIMARY_ACTION_CLASS_NAME}
                  data-testid="applications-recovery-primary-action-button"
                  onClick={onOpenSafeguards}
                  type="button"
                  variant="primary"
                >
                  {presentation.primaryActionLabel}
                </Button>
              ) : null}
              {onReviewBeforeSending ? (
                <Button
                  className={RECOVERY_PRIMARY_ACTION_CLASS_NAME}
                  data-testid="applications-recovery-primary-action-button"
                  onClick={onReviewBeforeSending}
                  type="button"
                  variant="primary"
                >
                  Review before sending
                </Button>
              ) : null}
              {!onReviewBeforeSending &&
              (primaryAction === "open_browser" ||
                primaryAction === "open_listing") ? (
                <Button
                  aria-describedby={
                    canFinishInBrowser
                      ? undefined
                      : finishInBrowserUnavailableNoteId
                  }
                  className={
                    hasHandedOffToBrowser && showConfirmFinishedAction
                      ? RECOVERY_ACTION_CLASS_NAME
                      : RECOVERY_PRIMARY_ACTION_CLASS_NAME
                  }
                  data-testid="applications-recovery-primary-action-button"
                  disabled={!canFinishInBrowser || reopenPhaseLabel !== null}
                  onClick={handleFinishInBrowser}
                  pending={reopenPhaseLabel !== null}
                  type="button"
                  variant={
                    hasHandedOffToBrowser && showConfirmFinishedAction
                      ? "secondary"
                      : "primary"
                  }
                >
                  {reopenPhaseLabel ?? browserActionLabel}
                </Button>
              ) : null}
              {primaryAction === "allow_site_saves" ? (
                <Button
                  className={RECOVERY_PRIMARY_ACTION_CLASS_NAME}
                  data-testid="applications-recovery-primary-action-button"
                  disabled={!onAllowSiteSaves}
                  onClick={() =>
                    onAllowSiteSaves?.(
                      getApplicationHostLabel(
                        getApplyResultDestinationUrl(
                          visibleApplyResult?.privacyReceipt,
                        ),
                      ),
                    )
                  }
                  type="button"
                  variant="primary"
                >
                  {presentation.primaryActionLabel}
                </Button>
              ) : null}
              {primaryAction === "answer_in_needs_you" && answerStep ? (
                <ApplicationAnswerStepCard step={answerStep} />
              ) : primaryAction === "answer_in_needs_you" ? (
                <Button
                  className={RECOVERY_PRIMARY_ACTION_CLASS_NAME}
                  data-testid="applications-recovery-primary-action-button"
                  disabled={!onOpenNeedsYou}
                  onClick={() => onOpenNeedsYou?.()}
                  type="button"
                  variant="primary"
                >
                  {presentation.primaryActionLabel}
                </Button>
              ) : null}
              {primaryAction === "try_again" ? (
                <Button
                  className={RECOVERY_PRIMARY_ACTION_CLASS_NAME}
                  data-testid="applications-recovery-primary-action-button"
                  disabled={
                    (!rejectedFormat && isStartBlocked) ||
                    (!rejectedFormat && isApplyPending)
                  }
                  title={
                    !rejectedFormat && applicationWorkPaused
                      ? APPLICATION_WORK_PAUSED_REASON
                      : undefined
                  }
                  onClick={
                    rejectedFormat
                      ? () => onReviewResumePdf?.(selectedRecordJobId)
                      : startFreshRun
                  }
                  // The press shows at once; the status above turns to
                  // "Filling this application" when the run starts.
                  pending={!rejectedFormat && isApplyPending}
                  type="button"
                  variant="primary"
                >
                  {rejectedFormat
                    ? "Review a PDF"
                    : presentation.primaryActionLabel}
                </Button>
              ) : null}
              {showConfirmFinishedAction ? (
                <Button
                  aria-describedby={
                    confirmFinishedInBrowserStatusId ?? undefined
                  }
                  className={
                    hasHandedOffToBrowser
                      ? RECOVERY_PRIMARY_ACTION_CLASS_NAME
                      : RECOVERY_ACTION_CLASS_NAME
                  }
                  data-testid="confirm-finished-in-browser"
                  disabled={isApplyPending || isCheckingFinishedInBrowser}
                  onClick={handleConfirmFinishedInBrowser}
                  pending={isApplyPending || isCheckingFinishedInBrowser}
                  type="button"
                  variant={hasHandedOffToBrowser ? "primary" : "secondary"}
                >
                  {/* One name, always. The round-eight build renamed this
                      control in place twice ("I finished this step" ->
                      "Check again" -> "Step is complete"), so the same
                      action looked like three. A running check is a pending
                      state and a failed check is reported beside the row. */}
                  {isCheckingFinishedInBrowser
                    ? CONFIRM_STEP_DONE_PENDING_LABEL
                    : CONFIRM_STEP_DONE_ACTION}
                </Button>
              ) : null}
            </div>
            {confirmFinishedInBrowserStatusId ? (
              <p
                className={
                  isCheckingFinishedInBrowser
                    ? "flex w-full min-w-0 items-center gap-2 text-(length:--text-small) leading-6 text-foreground-soft"
                    : "flex w-full min-w-0 items-start gap-2 text-(length:--text-small) leading-6 text-(--warning-text)"
                }
                data-testid="confirm-finished-in-browser-status"
                id={confirmFinishedInBrowserStatusId}
                role="status"
              >
                {isCheckingFinishedInBrowser ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
                      data-testid="confirm-finished-in-browser-spinner"
                    />
                    <span>
                      {`Checking this step in ${JOB_FINDER_BROWSER_NAME}… When it is complete, Job Finder continues in your chosen apply mode.`}
                    </span>
                  </>
                ) : (
                  <span>
                    {/* One sentence. This used to restate the whole pause
                        paragraph and then add a second instruction on top of
                        the button that is already on screen. */}
                    {confirmFinishedInBrowserBlockerText?.trim() ||
                      (presentation.state === "needs_answer"
                        ? "Your answer did not fit this question; choose one of the options in Needs you."
                        : `The application page still shows the step you need to finish in ${JOB_FINDER_BROWSER_NAME}.`)}
                  </span>
                )}
              </p>
            ) : null}
          </div>
        )}
        {/* Everything that is not the one thing to do next. One disclosure,
            closed by default — not a second row of buttons competing with the
            first. */}
        {hasSecondaryActions ? (
          <details
            className="group min-w-0"
            data-testid="applications-recovery-more"
          >
            <summary className="w-fit cursor-pointer text-(length:--text-small) font-semibold leading-6 text-foreground-soft">
              More
            </summary>
            <div
              className="mt-2 flex min-w-0 max-w-full flex-wrap items-start justify-start gap-2"
              data-testid="applications-recovery-secondary-action-list"
            >
              {showSecondaryOpenBrowser ? (
                <Button
                  className={RECOVERY_ACTION_CLASS_NAME}
                  onClick={handleFinishInBrowser}
                  type="button"
                  variant="secondary"
                >
                  {OPEN_JOB_FINDER_BROWSER_ACTION}
                </Button>
              ) : null}
              {showSecondaryRunAgain ? (
                <Button
                  className={RECOVERY_ACTION_CLASS_NAME}
                  onClick={startFreshRun}
                  type="button"
                  variant="secondary"
                >
                  {RUN_PREPARATION_AGAIN_ACTION}
                </Button>
              ) : null}
              {showQueueRecoveryAction ? (
                <div className="grid gap-1.5">
                  {selectedRun?.state === "paused_for_user_review" ? (
                    <p className="text-(length:--text-small) leading-6 text-foreground-soft">
                      One of your safety limits was reached, so the batch will
                      not carry on by itself. Prepare remaining jobs finishes
                      the ones it did not get to.
                    </p>
                  ) : null}
                  <Button
                    aria-describedby={
                      dailyQueueRecoveryExceedsRemainingReason
                        ? queueRecoveryExceedsNoteId
                        : undefined
                    }
                    className={RECOVERY_ACTION_CLASS_NAME}
                    onClick={() =>
                      onStartAutoApplyQueue(selectedQueueRecoveryJobIds)
                    }
                    type="button"
                    variant="secondary"
                    disabled={
                      isStartBlocked ||
                      selectedQueueRecoveryExceedsDailyRemaining
                    }
                  >
                    Prepare remaining jobs
                  </Button>
                </div>
              ) : null}
            </div>
          </details>
        ) : null}
        {(primaryAction === "open_browser" ||
          primaryAction === "open_listing") &&
        !canFinishInBrowser &&
        !onReviewBeforeSending ? (
          <p
            className="text-(length:--text-small) leading-6 text-foreground-soft"
            data-testid="manual-field-finish-unavailable-note"
            id={finishInBrowserUnavailableNoteId}
          >
            {JOB_FINDER_BROWSER_UNAVAILABLE_NOTE}
          </p>
        ) : null}
        {finishInBrowserStatus && finishInBrowserOutcome ? (
          <p
            aria-live="polite"
            className={
              finishInBrowserOutcome.kind === "opened_application_page"
                ? "text-(length:--text-small) leading-6 text-foreground-muted"
                : "rounded-(--radius-field) border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-(length:--text-small) leading-6 text-foreground"
            }
            data-handoff-outcome={finishInBrowserOutcome.kind}
            data-testid="manual-field-finish-status"
            role="status"
          >
            {finishInBrowserStatus}
          </p>
        ) : null}
        {dailyQueueRecoveryExceedsRemainingReason ? (
          <p
            aria-live="polite"
            className="text-(length:--text-small) leading-6 text-foreground-muted"
            data-testid="queue-recovery-daily-capacity-exceeded-note"
            id={queueRecoveryExceedsNoteId}
          >
            {dailyQueueRecoveryExceedsRemainingReason}
          </p>
        ) : null}
        {applicationWorkPaused &&
        ((primaryAction === "try_again" && !rejectedFormat) ||
          showQueueRecoveryAction) ? (
          <p
            className="text-(length:--text-small) leading-6 text-foreground-soft"
            data-testid="application-work-paused-note"
          >
            {APPLICATION_WORK_PAUSED_REASON}
          </p>
        ) : null}
        {dailyCapacityReachedText ? (
          <p
            // A line by the actions it limits, not a box: amber because the
            // day's preparations are used up (ADR 0042).
            className="text-(length:--text-small) leading-6 text-(--warning-text)"
            data-testid="daily-capacity-reached-alert"
            role="alert"
          >
            {dailyCapacityReachedText}
          </p>
        ) : null}
      </section>
      {/* A sent application has no next step in its batch: the batch's
          recovery list ("Will be prepared", "Some jobs in this run failed")
          described jobs that were later sent, beside this one's Applied. */}
      {!needsUserFinishPath &&
      selectedRun?.mode === "queue_auto" &&
      visibleApplyResult?.state !== "submitted" ? (
        <section className="surface-card-tint grid gap-4 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid gap-1">
              <h3 className="text-(length:--text-eyebrow) font-semibold uppercase tracking-(--tracking-badge) text-muted-foreground">
                {selectedRun.state === "running"
                  ? "Run progress and outcomes"
                  : "Run outcome summary"}
              </h3>
              <p className="text-(length:--text-small) leading-6 text-foreground-soft">
                Check each job's progress and outcome before starting another
                attempt.
              </p>
            </div>
            <StatusBadge tone={canRestageQueueRun ? "active" : "muted"}>
              {selectedQueueOutcomeEntries.length} job
              {selectedQueueOutcomeEntries.length === 1 ? "" : "s"} in run
            </StatusBadge>
          </div>
          <p className="text-(length:--text-small) leading-6 text-foreground-soft">
            {getQueueStateExplanation(
              selectedRun
                ? {
                    runState: selectedRun.state,
                    stopReason: selectedRun.detail,
                    selectedJobCount: selectedQueueOutcomeEntries.length,
                    blockedJobCount: selectedQueueOutcomeEntries.filter(
                      (entry) => entry.runResult?.state === "blocked",
                    ).length,
                    skippedJobCount: selectedQueueOutcomeEntries.filter(
                      (entry) => entry.runResult?.state === "skipped",
                    ).length,
                    failedJobCount: selectedQueueOutcomeEntries.filter(
                      (entry) => entry.runResult?.state === "failed",
                    ).length,
                    waitingJobCount: selectedQueueOutcomeEntries.filter(
                      (entry) =>
                        entry.runResult?.state === "awaiting_review" ||
                        entry.runResult?.state === "blocked",
                    ).length,
                    completedJobCount: selectedQueueOutcomeEntries.filter(
                      (entry) =>
                        entry.runResult?.state === "submitted" &&
                        entry.runResult.privacyReceipt?.finalSubmitOccurred !==
                          false,
                    ).length,
                    unfinishedJobCount: selectedQueueRecoveryJobIds.length,
                  }
                : null,
            )}
          </p>
          <div className="grid gap-2">
            {selectedQueueOutcomeEntries.map((entry) => {
              const unconfirmed =
                entry.runResult?.state === "submitted" &&
                entry.runResult.privacyReceipt?.finalSubmitOccurred === false;
              const resolvedState = unconfirmed
                ? "blocked"
                : (entry.runResult?.state ?? "planned");
              // The same standing the row and Home read: a planned job of a
              // stopped batch was never reached, not "waiting its turn".
              const jobPresentation = resolveApplyStatePresentation({
                mode: "fill_only",
                result: entry.runResult ?? null,
                pendingQuestionCount: Math.max(
                  0,
                  (entry.runResult?.latestQuestionCount ?? 0) -
                    (entry.runResult?.latestAnswerCount ?? 0),
                ),
                run: {
                  state: selectedRun.state,
                  activityPaused:
                    visibleApplyRunContext?.activityPaused ?? false,
                  started: true,
                },
              });
              const jobLabel =
                jobPresentation.kind === "needs_you" &&
                jobPresentation.questionsLeftLabel
                  ? "Needs your answers"
                  : jobPresentation.title;
              return (
                <div
                  key={`queue-outcome-${entry.jobId}`}
                  className="grid gap-2 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-foreground">{entry.label}</strong>
                    <StatusBadge tone={getQueueRecoveryTone(resolvedState)}>
                      {jobLabel}
                    </StatusBadge>
                  </div>
                  <p className="text-(length:--text-small) leading-6 text-foreground-soft">
                    {jobLabel}
                    {jobPresentation.sentence
                      ? ` — ${jobPresentation.sentence}`
                      : null}
                  </p>
                  {entry.runResult?.blockerSummary ? (
                    <p className="text-(length:--text-small) leading-6 text-foreground-soft">
                      {getCustomerFacingApplyText(
                        entry.runResult.blockerSummary,
                        entry.runResult.privacyReceipt,
                      )}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </>
  );
}
