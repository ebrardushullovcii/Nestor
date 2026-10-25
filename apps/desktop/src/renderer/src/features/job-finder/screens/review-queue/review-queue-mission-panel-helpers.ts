import { formatElapsedMinutes } from "../applications/applications-recovery-state";
import type {
  ApplicationAutomationMode,
  BrowserSessionState,
  ReviewQueueItem,
  JobListRow,
  TailoredAssetSummary,
} from "@nestor/contracts";
import { JOB_FINDER_BROWSER_NAME } from "../../lib/job-finder-browser-handoff-copy";
import {
  AI_UNAVAILABLE_RESUME_RESULT_MESSAGE,
  describeResumeRunStage,
  getApplyReadinessStatus,
  getResumeRunState,
  countResumeLinesToDecide,
  needsPersonResumeReview,
  needsResumeGeneration,
  needsTailoredResume,
  type ApplySupportState,
  type ResumeRunStage,
} from "./review-queue-status";

export type PrimaryApplicationRecoveryKind =
  | "approve_and_apply"
  | "open_browser"
  | "open_job_details"
  | "open_profile"
  | "open_resume_workspace"
  | "open_safeguards";

/**
 * Internal identifiers the safeguard layer appends in parentheses
 * ("(abnormal_failure_pause: automatic_discovery_failures:campaign_default)").
 * They are evidence for a bug report, not a sentence a job seeker can act on,
 * so the sentence on screen is the sentence without them.
 */
const INTERNAL_CODE_PARENTHETICAL = /\s*\((?=[^)]*[_:])[a-z0-9_:.\-\s,]+\)/gi;

/** The blocker sentence as a person should read it: no internal codes. */
export function stripInternalCodeParenthetical(value: string): string {
  return value
    .replace(INTERNAL_CODE_PARENTHETICAL, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
export interface PrimaryApplicationRecovery {
  kind: PrimaryApplicationRecoveryKind;
  label: string;
}
export interface PrimaryApplicationAction {
  blocker: string | null;
  /**
   * `info` marks a blocker that is an ordinary next step (review the
   * resume) rather than a problem; the panel renders it as status, not as a
   * destructive alert. Absent means the blocker needs attention.
   */
  blockerTone?: "info";
  enabled: boolean;
  kind:
    | "approve_resume"
    | "approve_and_apply"
    | "blocked"
    | "generate_resume"
    | "open_safeguards"
    | "start_apply"
    | "waiting";
  label: string;
  recovery: PrimaryApplicationRecovery | null;
}

export function getApplySupportState(
  selectedJob: JobListRow | null,
): ApplySupportState {
  if (
    !selectedJob ||
    (!selectedJob.applicationUrl?.trim() && !selectedJob.canonicalUrl?.trim())
  ) {
    return "incomplete";
  }

  return selectedJob.applyPath === "easy_apply" && selectedJob.easyApplyEligible
    ? "supported"
    : "manual_follow_up";
}

/**
 * One sentence under Apply that says what pressing it does, in the mode the
 * person chose once in Settings (ADR 0022). It replaces the readiness facts,
 * the four-item checklist and the "What happens when you prepare" disclosure
 * that used to say the same thing across three cards.
 */
export function describeApplyOutcome(
  mode: ApplicationAutomationMode,
  usesOriginalResume: boolean,
): string {
  const resume = usesOriginalResume
    ? "attaches your original resume"
    : "attaches this resume";
  switch (mode) {
    case "autonomous_submit":
      return `Job Finder opens the application, fills it in, ${resume}, and sends it. It stops and asks you only when the site needs you.`;
    case "confirm_before_submit":
      return `Job Finder opens the application, fills it in, ${resume}, then waits for your go-ahead before sending.`;
    default:
      return `Job Finder opens the application, fills it in, ${resume}, and leaves the browser open for you to send.`;
  }
}

/**
 * The same promise for the list's "Apply to all" row, which starts several
 * applications at once in the mode saved in Settings. A person about to send
 * five applications reads which mode they will run in before pressing.
 */
export function describeApplyAllOutcome(
  mode: ApplicationAutomationMode,
  dailyLimit: number | null = null,
): string {
  const pace = `Ten at a time${dailyLimit ? `, up to ${dailyLimit.toLocaleString("en-US")} a day` : ""}, with no more presses.`;
  switch (mode) {
    case "autonomous_submit":
      return `Sends each application for you and stops only for one that needs you. ${pace}`;
    case "confirm_before_submit":
      return `Fills in each form, then waits for your go-ahead before sending each one. ${pace}`;
    default:
      return `Fills in each form and attaches its resume; you press Send on each one. ${pace}`;
  }
}

export function getPrimaryApplicationAction(input: {
  applySupportState: ApplySupportState;
  browserSession: BrowserSessionState;
  hasGenerationFailure: boolean;
  /**
   * Why the last attempt failed, in the words the service recorded. The box
   * used to print a generic "did not finish" above the actual reason.
   */
  generationFailureDetail?: string | null;
  hasReadyApprovedAsset: boolean;
  isApplyPending: boolean;
  isGenerating: boolean;
  isSelectedJobPending: boolean;
  needsGeneration: boolean;
  resumeReviewStatus: ReviewQueueItem["resumeReview"]["status"] | "not_started";
  /**
   * Elapsed time of the run record for this job while it is still working.
   * Present means the run is genuinely in flight; the local pending flag
   * expires long before a real seven-minute run does.
   */
  runElapsedLabel?: string | null;
  /**
   * A safeguard that is holding preparation back, in plain words. When one is
   * present the Apply control is replaced rather than merely disabled: the
   * dialog used to open, close itself, and leave the page exactly as it was.
   */
  safeguardBlocker?: string | null;
  usesOriginalResume: boolean;
  /**
   * True when the draft has to be read by the person before it is used: an
   * Aggressive draft (ADR 0018). Light and Tailored keep every fact, so
   * Apply is their approval.
   */
  draftNeedsPersonReview?: boolean;
  /**
   * The saved resume kept the person's wording because the listing was not
   * read; the job still needs its resume (see `needsTailoredResume`).
   */
  needsTailoredResume?: boolean;
}): PrimaryApplicationAction {
  const {
    applySupportState,
    browserSession,
    hasGenerationFailure,
    hasReadyApprovedAsset,
    isApplyPending,
    isGenerating,
    isSelectedJobPending,
    needsGeneration,
    resumeReviewStatus,
    runElapsedLabel,
    safeguardBlocker,
    usesOriginalResume,
  } = input;
  const safeguardSentence = safeguardBlocker?.trim()
    ? stripInternalCodeParenthetical(safeguardBlocker)
    : null;

  if (isGenerating) {
    return {
      blocker: null,
      enabled: false,
      kind: "waiting",
      label: "Writing the resume…",
      recovery: null,
    };
  }

  if (hasGenerationFailure) {
    const failureDetail = input.generationFailureDetail?.trim()
      ? stripInternalCodeParenthetical(input.generationFailureDetail)
      : "";
    return {
      blocker:
        failureDetail ||
        "The last attempt to write this resume did not finish.",
      enabled: !isSelectedJobPending,
      kind: "generate_resume",
      label: "Try again",
      recovery: null,
    };
  }

  if (needsGeneration) {
    return {
      blocker: null,
      enabled: !isSelectedJobPending,
      kind: "generate_resume",
      label: "Create the resume",
      recovery: null,
    };
  }

  // The status tab and the row say this job needs a resume, so the next step
  // writes it. Applying with the person's own wording stays one press away.
  if (input.needsTailoredResume) {
    return {
      blocker: null,
      enabled: !isSelectedJobPending,
      kind: "generate_resume",
      label: "Create the resume",
      recovery: {
        kind: "approve_and_apply",
        label: "Apply with your original wording",
      },
    };
  }

  if (!hasReadyApprovedAsset) {
    if (usesOriginalResume) {
      return {
        blocker: "Your original resume is missing. Import it in Profile.",
        enabled: false,
        kind: "blocked",
        label: "Apply",
        recovery: { kind: "open_profile", label: "Import original resume" },
      };
    }

    // One status sentence for one artifact: the ordinary "not approved yet"
    // case is already stated once by the state line and by this action's own
    // label, so it does not also get a blocker box that names the same file
    // a second time with a different noun.
    const blocker =
      resumeReviewStatus === "stale"
        ? "The approved resume is out of date."
        : resumeReviewStatus === "approved"
          ? "The approved resume no longer matches the current version."
          : null;
    if (
      !input.draftNeedsPersonReview &&
      blocker === null &&
      resumeReviewStatus === "needs_review"
    ) {
      return {
        blocker: null,
        enabled: !isSelectedJobPending,
        kind: "approve_and_apply",
        label: "Apply",
        recovery: null,
      };
    }
    return {
      blocker,
      enabled: !isSelectedJobPending,
      kind: "approve_resume",
      label: "Review the resume",
      recovery: null,
    };
  }

  // Nothing downstream can start while a safeguard holds preparation, so the
  // start control is the safeguard control instead of an Apply button that
  // opens a dialog and then does nothing.
  if (safeguardSentence) {
    return {
      blocker: safeguardSentence,
      enabled: true,
      kind: "open_safeguards",
      label: "Open Safeguards",
      recovery: null,
    };
  }

  if (applySupportState === "incomplete") {
    return {
      blocker: "This job does not have a usable application link.",
      enabled: false,
      kind: "blocked",
      label: "Apply",
      recovery: { kind: "open_job_details", label: "Check the job details" },
    };
  }

  if (browserSession.status === "blocked") {
    return {
      blocker:
        browserSession.detail?.trim() ||
        `${JOB_FINDER_BROWSER_NAME} is blocked and needs attention.`,
      enabled: false,
      kind: "blocked",
      label: "Apply",
      recovery: {
        kind: "open_browser",
        label: `Open ${JOB_FINDER_BROWSER_NAME}`,
      },
    };
  }

  // While the run is in flight the button says so, and it keeps saying so
  // for as long as the run record is running. The label used to revert to
  // "Apply" after about ninety seconds of a seven-minute run.
  if (runElapsedLabel || isApplyPending) {
    return {
      blocker: null,
      enabled: false,
      kind: "start_apply",
      label: runElapsedLabel
        ? `Filling in the form… (${runElapsedLabel})`
        : "Filling in the form…",
      recovery: null,
    };
  }

  return {
    blocker: null,
    enabled: !isSelectedJobPending,
    kind: "start_apply",
    label: "Apply",
    recovery: null,
  };
}

function getBrowserActionMessage(browserSession: BrowserSessionState) {
  switch (browserSession.status) {
    case "ready":
      return null;
    case "login_required":
      return `${JOB_FINDER_BROWSER_NAME} will open the site and wait while you sign in.`;
    case "blocked":
      return `${JOB_FINDER_BROWSER_NAME} needs attention before you can apply.`;
    case "unknown":
      return null;
    default:
      return `${JOB_FINDER_BROWSER_NAME} is still starting.`;
  }
}

/**
 * The one line of state above the button: what this job is waiting on, or
 * that it is ready. Null when the button's own label already says it all.
 */
export function getReadinessDescription(input: {
  selectedItem: ReviewQueueItem | null;
  selectedJob: JobListRow | null;
  hasGenerationFailure: boolean;
  needsGeneration: boolean;
  isGenerating: boolean;
  hasReadyApprovedAsset: boolean;
  resumeReviewStatus: ReviewQueueItem["resumeReview"]["status"] | "not_started";
  applySupportState: ApplySupportState;
  browserActionMessage: string | null;
  draftNeedsPersonReview?: boolean;
  needsTailoredResume?: boolean;
  isSelectedJobPendingTooLong?: boolean;
  /** Where the running resume is, when the run reports it. */
  resumeRunStage?: ResumeRunStage | null;
}): string | null {
  const {
    selectedItem,
    selectedJob,
    hasGenerationFailure,
    needsGeneration,
    isGenerating,
    hasReadyApprovedAsset,
    resumeReviewStatus,
    applySupportState,
    browserActionMessage,
    draftNeedsPersonReview = false,
    isSelectedJobPendingTooLong = false,
    resumeRunStage = null,
  } = input;

  if (!selectedItem || !selectedJob) {
    return null;
  }

  if (isGenerating) {
    return isSelectedJobPendingTooLong
      ? "This is taking longer than usual. It is still running and will update here when ready. You can leave this page."
      : `${describeResumeRunStage(resumeRunStage)} You can leave this page; it finishes on its own.`;
  }

  if (hasGenerationFailure) {
    return "The resume could not be written. Try again, or open it to see what happened.";
  }

  if (needsGeneration) {
    return null;
  }

  if (input.needsTailoredResume) {
    return "The listing text was not captured, so this resume keeps your original wording. Creating the resume reads the listing again and tailors it.";
  }

  if (!hasReadyApprovedAsset) {
    if (resumeReviewStatus === "stale") {
      return "The approved resume is out of date. Open it and approve the current version.";
    }
    if (selectedItem.resumeApplicationMode === "original_resume") {
      return "Your original resume is missing. Import it in Profile before applying.";
    }
    const linesToDecide = countResumeLinesToDecide(selectedItem);
    if (linesToDecide > 0) {
      return linesToDecide === 1
        ? "A line in this resume is waiting for your decision. Open the resume, keep or change it, and Apply can go ahead."
        : `${linesToDecide} lines in this resume are waiting for your decision. Open the resume, keep or change each one, and Apply can go ahead.`;
    }
    if (draftNeedsPersonReview) {
      // ADR 0051: stretches are not confirmed line by line any more, so the
      // step is a read-through, not a line-by-line chore.
      return "Read the resume through, then approve it.";
    }
    return "The resume is ready. Apply approves it and starts the application.";
  }

  if (applySupportState === "incomplete") {
    return "This job has no usable application link. Check the job details.";
  }

  if (browserActionMessage) {
    return browserActionMessage;
  }

  return null;
}

export function buildMissionPanelState(input: {
  browserSession: BrowserSessionState;
  isApplyPending: boolean;
  isJobPending: (jobId: string) => boolean;
  selectedAsset: TailoredAssetSummary | null;
  selectedItem: ReviewQueueItem | null;
  selectedJob: JobListRow | null;
  isSelectedJobPendingTooLong?: boolean;
  safeguardBlocker?: string | null;
  /** The still-running apply result for the selected job, when there is one. */
  selectedApplyResult?: { startedAt?: string | null } | null;
  /** Where the selected job's running resume is, when the run reports it. */
  resumeRunStage?: ResumeRunStage | null;
}) {
  const {
    browserSession,
    isApplyPending,
    isJobPending,
    selectedAsset,
    selectedItem,
    selectedJob,
    safeguardBlocker = null,
    selectedApplyResult = null,
    isSelectedJobPendingTooLong = false,
    resumeRunStage = null,
  } = input;
  const needsGeneration = needsResumeGeneration(selectedItem);
  const isSelectedJobPending = selectedItem
    ? isJobPending(selectedItem.jobId)
    : false;
  // A rewrite in progress outranks the last attempt's failure, as on the
  // row: the old red box stayed up for the whole run after Try again.
  const { hasFailure: hasGenerationFailure, isWriting: isGenerating } =
    getResumeRunState(selectedItem, selectedAsset, isSelectedJobPending);
  const untailoredResume = !isGenerating && needsTailoredResume(selectedItem);
  const applySupportState = getApplySupportState(selectedJob);
  const resumeReviewStatus = selectedItem?.resumeReview.status ?? "not_started";
  const usesOriginalResume =
    selectedItem?.resumeApplicationMode === "original_resume";
  const approvedResumeReview =
    selectedItem?.resumeReview.status === "approved"
      ? selectedItem.resumeReview
      : null;
  const hasReadyApprovedAsset = usesOriginalResume
    ? selectedItem?.assetStatus === "ready" &&
      Boolean(selectedItem.resumeAssetId)
    : selectedAsset !== null &&
      selectedAsset.status === "ready" &&
      selectedItem?.resumeAssetId === selectedAsset.id &&
      approvedResumeReview !== null &&
      selectedAsset.storagePath === approvedResumeReview.approvedFilePath;
  const draftNeedsPersonReview = needsPersonResumeReview(
    selectedItem,
    selectedAsset,
  );
  const primaryApplicationAction = getPrimaryApplicationAction({
    applySupportState,
    browserSession,
    hasGenerationFailure,
    generationFailureDetail: selectedAsset?.failureMessage ?? null,
    hasReadyApprovedAsset,
    isApplyPending,
    isGenerating,
    isSelectedJobPending,
    needsGeneration,
    resumeReviewStatus,
    runElapsedLabel: formatElapsedMinutes(selectedApplyResult?.startedAt),
    safeguardBlocker,
    usesOriginalResume,
    draftNeedsPersonReview,
    needsTailoredResume: untailoredResume,
  });
  const canApproveApply =
    primaryApplicationAction.kind === "start_apply" &&
    primaryApplicationAction.enabled;
  const browserActionMessage = getBrowserActionMessage(browserSession);
  const applyReadinessStatus = getApplyReadinessStatus({
    applySupportState,
    browserSession,
    hasGenerationFailure,
    hasReadyApprovedAsset,
    isGenerating,
    needsGeneration,
    resumeReviewStatus,
    selectedItem,
  });
  // The state line must say the thing that is actually stopping the run. It
  // used to keep reading a browser sentence while a safeguard was refusing
  // every start.
  const readinessDescription =
    primaryApplicationAction.kind === "open_safeguards"
      ? (primaryApplicationAction.blocker ?? null)
      : hasGenerationFailure && selectedAsset?.failureMessage?.trim()
        ? // The failure box names the cause; a generic "could not be
          // written… open it to see what happened" above it sent people
          // looking for a reason that was already on screen.
          null
        : getReadinessDescription({
            selectedItem,
            selectedJob,
            hasGenerationFailure,
            needsGeneration,
            isGenerating,
            hasReadyApprovedAsset,
            resumeReviewStatus,
            applySupportState,
            browserActionMessage,
            draftNeedsPersonReview,
            needsTailoredResume: untailoredResume,
            isSelectedJobPendingTooLong,
            resumeRunStage,
          });
  const isGenerationAction =
    needsGeneration || hasGenerationFailure || untailoredResume;
  const isPrimaryApplyPending = isApplyPending && !isGenerationAction;

  return {
    applyReadinessStatus,
    canApproveApply,
    hasGenerationFailure,
    hasReadyApprovedAsset,
    isGenerating,
    isGenerationAction,
    isPrimaryApplyPending,
    isSelectedJobPending,
    needsGeneration,
    needsTailoredResume: untailoredResume,
    primaryApplicationAction,
    readinessDescription,
    usesOriginalResume,
  };
}

/**
 * Whether the Next step box repeats the last action's result line. It is
 * left out when the box already says the same thing: the failure cause, or
 * the "AI was unavailable" result under the line that already explains the
 * resume keeps the saved wording.
 */
export function shouldShowMissionActionMessage(input: {
  actionMessage: string | null | undefined;
  blocker: string | null | undefined;
  aiUnavailableLine: string | null | undefined;
}): boolean {
  const message = input.actionMessage?.trim();
  if (!message) {
    return false;
  }
  if (message === input.blocker?.trim()) {
    return false;
  }
  return !(
    input.aiUnavailableLine && message === AI_UNAVAILABLE_RESUME_RESULT_MESSAGE
  );
}
