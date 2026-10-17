import {
  getPausedQuestionText,
  applyResultPausedOnQuestion,
  applyResultHasQuestionForPerson,
  applyResultNeedsSecurityCheck,
  looksLikeAccountWall,
  looksLikeSignInWall,
} from "@nordri/job-finder/assistant-attention";
export {
  getPausedQuestionText,
  formatQuestionPrompt,
  applyResultPausedOnQuestion,
  applyResultHasQuestionForPerson,
  applyResultNeedsSecurityCheck,
  looksLikeAccountWall,
  looksLikeSignInWall,
} from "@nordri/job-finder/assistant-attention";
import {
  APPLICATION_SKIPPED_BY_PERSON_LABEL,
  PREPARED_PAGE_CLOSED_SUMMARY,
  WITHDRAWAL_UNDONE_SUMMARY,
  type JobFinderRendererWorkspaceSnapshot,
} from "@nordri/contracts";
import {
  JOB_FINDER_BROWSER_NAME,
  OPEN_JOB_FINDER_BROWSER_ACTION,
} from "../../lib/job-finder-browser-handoff-copy";
import {
  applyResultIsServiceWorkerBlocked,
  applyResultNeedsManualFieldFinish,
  applyResultNeedsResumeAttachment,
  getCustomerFacingApplyText,
} from "./applications-detail-panel-helpers";

type ApplyResult = JobFinderRendererWorkspaceSnapshot["applyJobResults"][number] | null;

/**
 * One state, one sentence, one action.
 *
 * The Applications detail panel used to stack a "Try again" group of two
 * side-by-side buttons, a contradicting fact strip ("could not finish" next to
 * "Nothing blocking"), and a third automation button, while the one thing the
 * reader needed — the sentence the run itself wrote about why it stopped — was
 * three disclosures deep in Run details. Every visible control on that panel is
 * now chosen here, from the run, so there can only ever be one of them.
 */
export type ApplicationRecoveryState =
  | "preparing"
  | "submitted"
  | "verify_outcome"
  | "site_blocked"
  | "finish_in_browser"
  | "needs_sign_in"
  | "reattach_resume"
  | "needs_answer"
  | "site_saves_as_you_go"
  | "structural_stop"
  | "retry";

/**
 * Which control the state earns. `none` is a real answer: while a run is
 * working there is nothing for the person to press, and drawing a button
 * anyway is what made the screen a loop of clicks that changed nothing.
 */
export type ApplicationRecoveryPrimaryAction =
  | "close_finished_tabs"
  | "none"
  | "open_browser"
  | "open_safeguards"
  | "open_listing"
  | "answer_in_needs_you"
  | "allow_site_saves"
  | "try_again";

export type ApplicationRecoveryPresentation = {
  state: ApplicationRecoveryState;
  /** The state in plain words, as a heading. */
  statusLine: string;
  /**
   * Why, in the run's own words where it has them. Never null for a stopped
   * run: a "could not finish" with no because is the complaint this module
   * exists to answer.
   */
  reasonSentence: string | null;
  primaryAction: ApplicationRecoveryPrimaryAction;
  primaryActionLabel: string | null;
};

/**
 * The site writes every keystroke back to its own server as you type, and
 * Job Finder has no permission to let it. Recognised from the blocker code
 * once the runtime records one, and until then from the sentence it writes.
 */
const SITE_SAVES_AS_YOU_GO_PATTERN =
  /tried to save your answer[^.]*straight away|saves your answers as you type/i;

export function applyResultBlockedBySiteSaves(result: ApplyResult): boolean {
  if (!result) {
    return false;
  }

  return (
    (result.blockerReason as string) === "site_saves_as_you_go" ||
    SITE_SAVES_AS_YOU_GO_PATTERN.test(
      `${result.blockerSummary ?? ""} ${result.detail ?? ""} ${result.summary ?? ""}`,
    )
  );
}

/** The record-level form of the same check, for the list row. */
export function applicationRecordBlockedBySiteSaves(record: {
  latestBlocker?: { code?: string | null; summary?: string | null } | null;
  lastActionLabel?: string | null;
  nextActionLabel?: string | null;
}): boolean {
  if (record.latestBlocker?.code === "site_saves_as_you_go") {
    return true;
  }

  return SITE_SAVES_AS_YOU_GO_PATTERN.test(
    `${record.latestBlocker?.summary ?? ""} ${record.lastActionLabel ?? ""} ${record.nextActionLabel ?? ""}`,
  );
}

/** The one sentence that state earns. */
export const SITE_SAVES_AS_YOU_GO_REASON =
  "This site saves your answers as you type. Job Finder now lets sites do that, so run it again.";

/** The host the permission would be granted for, as a person would name it. */
export function getApplicationHostLabel(
  destinationUrl: string | null | undefined,
): string | null {
  if (!destinationUrl) {
    return null;
  }

  try {
    return new URL(destinationUrl).hostname.replace(/^www\./i, "") || null;
  } catch {
    return null;
  }
}

/**
 * States the run record itself reports while it is still working. A local
 * pending flag times out after a minute or so; a seven-minute run does not,
 * and the screen used to offer "Try again" beside a run that was still
 * filling the form.
 */
const RUNNING_RESULT_STATES = new Set([
  "planned",
  "filling",
  "question_capture",
  "submitting",
]);

/**
 * What the run a result belongs to is doing, read from the workspace. A
 * "planned" result means nothing on its own: it is waiting its turn in a
 * running batch, held by the person's pause, or left behind by a batch that
 * stopped and will never come back for it.
 */
export interface ApplyRunContext {
  state: ApplyRunState;
  detail?: string | null;
  /** The person paused new work ("Pause new work"). */
  activityPaused: boolean;
  /** Any job in the run has been started. */
  started: boolean;
}

type ApplyRunState = NonNullable<
  JobFinderRendererWorkspaceSnapshot["applyRuns"]
>[number]["state"];

/** Where a planned (not yet started) application stands. */
export type PlannedApplyStanding =
  | "waiting_turn"
  | "paused"
  | "not_started"
  | "waiting_tab";

export function buildApplyRunContextReader(workspace: {
  applyRuns?: JobFinderRendererWorkspaceSnapshot["applyRuns"] | null;
  applyJobResults?: JobFinderRendererWorkspaceSnapshot["applyJobResults"] | null;
  activityControl?: Pick<
    JobFinderRendererWorkspaceSnapshot["activityControl"],
    "paused" | "pauseBehavior"
  > | null;
}): (result: ApplyResult) => ApplyRunContext | null {
  const activityPaused = Boolean(workspace.activityControl?.paused);
  const startedRunIds = new Set(
    (workspace.applyJobResults ?? [])
      .filter(
        (result) =>
          result.state !== "planned" ||
          result.applicationPreparationStartedAt != null,
      )
      .map((result) => result.runId),
  );
  const runsById = new Map(
    (workspace.applyRuns ?? []).map((run) => [run.id, run]),
  );
  return (result) => {
    const run = result ? runsById.get(result.runId) : undefined;
    if (!run) return null;
    return {
      state: run.state,
      detail: run.detail,
      activityPaused,
      started: startedRunIds.has(run.id),
    };
  };
}

export function resolvePlannedApplyStanding(
  result: ApplyResult,
  run: ApplyRunContext | null | undefined,
): PlannedApplyStanding | null {
  if (result?.state !== "planned") return null;
  if (result.summary === WAITING_FOR_BROWSER_TAB_SUMMARY) return "waiting_tab";
  if (!run) return "waiting_turn";
  switch (run.state) {
    case "draft":
    case "awaiting_submit_approval":
    case "paused_for_consent":
      return "waiting_turn";
    case "running":
      return run.activityPaused ? "paused" : "waiting_turn";
    case "paused_for_user_review":
      // A batch reusing an approval is written paused and started a moment
      // later; until any job in it starts, it is a batch about to run.
      return "not_started";
    default:
      return "not_started";
  }
}

/** Why a planned job of a stopped batch was never filled in. */
export function describeNotStartedApplication(
  run: ApplyRunContext | null | undefined,
): string {
  return run?.state === "paused_for_user_review"
    ? `${run.detail?.trim() || "A safety limit stopped the batch before Job Finder got to this one."} Nothing was filled in or sent.`
    : "The batch stopped before Job Finder got to this one. Nothing was filled in or sent.";
}

export const PAUSED_BEFORE_APPLICATION_SENTENCE =
  "You paused new work before Job Finder got to this one. It carries on when you resume.";

export function applyResultIsStillRunning(result: ApplyResult): boolean {
  if (result === null || !RUNNING_RESULT_STATES.has(result.state)) {
    return false;
  }
  return result.state !== "planned";
}

/** "2 min" from a start timestamp, for a wait the person is watching. */
export function formatElapsedMinutes(
  startedAt: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!startedAt) {
    return null;
  }

  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started) || now < started) {
    return null;
  }

  const minutes = Math.floor((now - started) / 60_000);
  return minutes < 1 ? "under a minute" : `${minutes} min`;
}

/** What the service writes on an application waiting for a free tab. */
export const WAITING_FOR_BROWSER_TAB_SUMMARY = "Waiting for a free browser tab";

/** The one sentence a working run earns, wherever it is said. */
export const FILLING_IN_THE_FORM_STATUS = "Job Finder is filling in the form";

/** The label every retry control on the Applications screen carries. */
export const TRY_AGAIN_ACTION = "Try again";

/** The label for a stop a retry cannot change. */
export const OPEN_LISTING_ACTION = `Open the listing in ${JOB_FINDER_BROWSER_NAME}`;

/**
 * A stop that running the same thing again cannot change: the listing has no
 * apply route Job Finder can drive, the posting is gone, or applying happens
 * somewhere this run cannot reach. Offering "Try again" here is the button
 * that does nothing.
 */
const STRUCTURAL_STOP_PATTERN =
  /\b(?:no apply (?:link|button|form|route)|could not find (?:an?|the) apply|apply (?:link|button) (?:was |is )?(?:not |n't )?(?:found|present|available)|listing (?:is |was )?closed|no longer (?:accepting|available|open)|posting (?:is |was )?(?:closed|removed|expired)|applications? (?:are |is )?closed|apply(?:ing)? (?:happens|is handled|takes place) (?:elsewhere|externally|on another)|email your application|apply by email|redirect(?:s|ed)? to an? (?:external|third-party) (?:site|application))/i;

/**
 * A stop a fresh run can genuinely change: the site erred, the page timed out,
 * or the browser could not reach it.
 */
const RETRYABLE_STOP_PATTERN =
  /\b(?:timed? ?out|timeout|temporarily unavailable|try again later|network|connection|502|503|504|server error|rate limit|too many requests)\b/i;

function readReasonCorpus(result: ApplyResult): string {
  if (!result) {
    return "";
  }

  return `${result.detail ?? ""} ${result.blockerSummary ?? ""} ${result.summary ?? ""}`;
}

/**
 * How the runtime introduces its own stuck sentence. The words after the colon
 * are the reason; the prefix is bookkeeping and reads as a second, vaguer
 * restatement of the headline directly above it.
 */
const STUCK_PREFIX_PATTERN =
  /^\s*job finder\s+(?:got stuck|stopped(?:\s+on\s+.+?)?\s+because it got stuck)\s*[:—-]\s*/i;

/**
 * Summaries that say a run ended without saying anything about why. These are
 * never used as the reason sentence: "Job Finder could not finish this
 * application" under the headline "Job Finder stopped before finishing this
 * application" is the same non-answer twice.
 */
const GENERIC_SUMMARY_PATTERN =
  /^\s*(?:job finder\s+)?(?:could not finish|did not finish|failed to finish|could not complete)\b[^.]*\.?\s*$|^\s*attempt (?:failed|finished)\.?\s*$|^\s*preparation (?:failed|stopped)\.?\s*$/i;

/** The one sentence a sign-in wall earns, wherever it is said. */
export const SIGN_IN_WALL_REASON = `This site asks you to sign in before applying. Sign in in ${JOB_FINDER_BROWSER_NAME} and Job Finder can pick the application back up.`;

/** The one sentence an account wall earns. Job Finder never creates accounts. */
export const ACCOUNT_WALL_REASON = `The site wants an account before you can apply. Job Finder never creates accounts for you. Make the account once in ${JOB_FINDER_BROWSER_NAME} and it can carry on from there.`;

/**
 * The run's own sentence about why it stopped, cleaned of transport wording
 * and of the recorded blocked-attempt evidence line. The blocker summary wins
 * over the general summary because it is the one the agent wrote about the
 * stop rather than about the whole attempt.
 */
export function getApplicationStopReasonSentence(
  result: ApplyResult,
): string | null {
  if (!result) {
    return null;
  }

  // A completed prepare-only run can retain the model's earlier observation
  // in its summary even after the exact page check resolved the blocker. Once
  // the durable result says it is awaiting review with no blocker, that old
  // prose is history rather than a current stop reason.
  if (result.state === "awaiting_review" && !result.blockerReason) {
    return null;
  }

  // The run's own stop detail first — that is where the agent writes its
  // "Job Finder got stuck: …" sentence, and it was reachable only three
  // disclosures down in Run details. The general summary is the last resort
  // and is dropped outright when it says nothing but "could not finish".
  for (const candidate of [result.detail, result.blockerSummary]) {
    const text = getCustomerFacingApplyText(candidate, result.privacyReceipt);
    const stripped = text?.replace(STUCK_PREFIX_PATTERN, "").trim();
    if (stripped && !GENERIC_SUMMARY_PATTERN.test(stripped)) {
      return [...new Set(stripped.split(/(?<=[.!?])\s+/u))].join(" ");
    }
  }

  const summary = getCustomerFacingApplyText(
    result.summary,
    result.privacyReceipt,
  )
    ?.replace(STUCK_PREFIX_PATTERN, "")
    .trim();

  return summary && !GENERIC_SUMMARY_PATTERN.test(summary) ? summary : null;
}

/**
 * True when this run stopped for a reason that will still be true next time.
 * Exported so the fact strip and the records row read the same evidence the
 * button does.
 */
export function applyResultStoppedStructurally(result: ApplyResult): boolean {
  if (!result) {
    return false;
  }

  if (result.state !== "blocked" && result.state !== "failed") {
    return false;
  }

  // Losing the exact in-memory prepared page after restart is recoverable by
  // preparing the application again. "Page is no longer open" describes the
  // browser binding, not a closed employer listing.
  if (result.blockerReason === "unexpected_navigation") {
    return false;
  }

  const corpus = readReasonCorpus(result);
  if (RETRYABLE_STOP_PATTERN.test(corpus)) {
    return false;
  }
  // The same lost prepared page, reported by a continuation that found it
  // gone (an answer given after a restart), carries no blocker code.
  if (/\bprepared (?:application )?page\b/i.test(corpus)) {
    return false;
  }

  return STRUCTURAL_STOP_PATTERN.test(corpus);
}

/**
 * Decides the whole top block of the Applications detail panel from the run.
 *
 * `isApplyPending` is the screen's own in-flight flag; a pause the person has
 * to resolve themselves outranks it, because a spinner beside "finish this in
 * the browser" tells the reader to wait for something that will never happen.
 */
export function resolveApplicationRecoveryPresentation(input: {
  canOpenSafeguards: boolean;
  /** The page the run finished on, used to recognise a login page by its URL. */
  destinationUrl?: string | null;
  isApplyPending: boolean;
  /** The exact question the run paused on, when the caller already has it. */
  pausedQuestion?: string | null;
  /** How many questions the form is still waiting on. */
  pausedQuestionCount?: number | null;
  /** Injected so elapsed time is testable. */
  now?: number;
  /** Current record blocker after resume-state reconciliation. */
  recordLatestBlockerCode?: string | null;
  /** The record's last action; a person's skip is not a failure. */
  recordLastActionLabel?: string | null;
  /**
   * The person set the tracker to Applied or later themselves: they sent it
   * outside Job Finder, so it is never filled in again.
   */
  recordTrackedAsApplied?: boolean;
  personSendReceiptSummary?: string | null;
  /** What the result's run is doing; a planned job means nothing without it. */
  run?: ApplyRunContext | null;
  visibleApplyResult: ApplyResult;
}): ApplicationRecoveryPresentation {
  const {
    canOpenSafeguards,
    destinationUrl = null,
    isApplyPending,
    pausedQuestion = null,
    pausedQuestionCount = null,
    now = Date.now(),
    recordLatestBlockerCode,
    visibleApplyResult,
  } = input;
  const reasonSentence = getApplicationStopReasonSentence(visibleApplyResult);
  if (
    input.recordLastActionLabel === APPLICATION_SKIPPED_BY_PERSON_LABEL &&
    visibleApplyResult?.state !== "submitted"
  ) {
    return {
      state: "retry",
      statusLine: "Skipped at your request",
      reasonSentence: "Nothing was sent. Apply again if you change your mind.",
      primaryAction: "try_again",
      primaryActionLabel: "Apply again",
    };
  }
  const isServiceWorkerBlocked =
    applyResultIsServiceWorkerBlocked(visibleApplyResult);
  // A pause with questions on file is a question step, not a browser
  // hand-off: the answers are typed here, and the run carries on itself.
  const needsManualFieldFinish =
    applyResultNeedsManualFieldFinish(visibleApplyResult) &&
    !(
      applyResultPausedOnQuestion(visibleApplyResult) &&
      (pausedQuestionCount ?? 0) > 0
    );
  const requiresSubmissionOutcomeVerification =
    visibleApplyResult?.blockerReason === "submission_outcome_uncertain" ||
    visibleApplyResult?.privacyReceipt?.submissionOutcome?.outcome ===
      "outcome_uncertain";

  if (
    input.personSendReceiptSummary ||
    (visibleApplyResult?.state === "submitted" &&
      visibleApplyResult.privacyReceipt?.finalSubmitOccurred === true &&
      (visibleApplyResult.privacyReceipt.submissionOutcome?.outcome ??
        "submitted") === "submitted")
  ) {
    return {
      state: "submitted",
      statusLine: "Application submitted",
      reasonSentence:
        input.personSendReceiptSummary ??
        reasonSentence ??
        "The employer site confirmed receipt.",
      primaryAction: "none",
      primaryActionLabel: null,
    };
  }
  if (input.recordTrackedAsApplied) {
    return {
      state: "submitted",
      statusLine: "Marked sent by you",
      reasonSentence:
        "You recorded this send. Job Finder has no site receipt for it.",
      primaryAction: "none",
      primaryActionLabel: null,
    };
  }
  if (visibleApplyResult?.state === "submitted") {
    return {
      state: "verify_outcome",
      statusLine: "Not confirmed",
      reasonSentence:
        "No saved receipt confirms this send. Check the site and record the outcome before trying again.",
      primaryAction: "none",
      primaryActionLabel: null,
    };
  }

  if (requiresSubmissionOutcomeVerification) {
    return {
      state: "verify_outcome",
      statusLine: "Job Finder could not tell whether this was sent",
      reasonSentence:
        reasonSentence ??
        "The last action finished without the employer site confirming one way or the other.",
      primaryAction: "none",
      primaryActionLabel: null,
    };
  }

  // A site rejection is a known unsent outcome, even if preparation was ready.
  const rejectedOutcome = visibleApplyResult?.privacyReceipt?.submissionOutcome;
  if (
    rejectedOutcome?.outcome === "not_submitted" &&
    rejectedOutcome.browserAction?.reason === "form_validation_failed"
  ) {
    return {
      state: "finish_in_browser",
      statusLine: "Not sent",
      reasonSentence:
        rejectedOutcome.browserAction?.detail ??
        visibleApplyResult?.detail ??
        reasonSentence,
      primaryAction: "open_browser",
      primaryActionLabel: "Correct the fields in the browser",
    };
  }

  if (
    visibleApplyResult?.state === "failed" &&
    visibleApplyResult.summary === PREPARED_PAGE_CLOSED_SUMMARY
  ) {
    return {
      state: "retry",
      statusLine: "Prepare again",
      reasonSentence:
        "The prepared form is no longer open. Prepare it again using your saved answers and files.",
      primaryAction: "try_again",
      primaryActionLabel: "Prepare again",
    };
  }

  if (
    visibleApplyResult?.state === "skipped" &&
    visibleApplyResult.summary === WITHDRAWAL_UNDONE_SUMMARY
  ) {
    return {
      state: "retry",
      statusLine: "Prepare again",
      reasonSentence: visibleApplyResult.detail,
      primaryAction: "try_again",
      primaryActionLabel: "Prepare again",
    };
  }

  if (visibleApplyResult?.state === "cancelled") {
    return {
      state: "retry",
      statusLine: "Cancelled by you",
      reasonSentence: visibleApplyResult.detail,
      primaryAction: "try_again",
      primaryActionLabel: TRY_AGAIN_ACTION,
    };
  }

  // Cancelling a question handoff ends its result, but retains the questions
  // as history. They must not send the person back to a closed answer step.
  // Uncertain submissions above still require verification before any retry.
  if (
    (visibleApplyResult?.state === "failed" ||
      visibleApplyResult?.state === "skipped") &&
    applyResultPausedOnQuestion(visibleApplyResult)
  ) {
    return {
      state: "retry",
      statusLine: "This application did not finish",
      reasonSentence:
        reasonSentence ??
        "The previous question step ended. Try again to continue this application.",
      primaryAction: "try_again",
      primaryActionLabel: TRY_AGAIN_ACTION,
    };
  }

  if (isServiceWorkerBlocked) {
    return {
      state: "site_blocked",
      statusLine: "This job site blocked automatic filling",
      reasonSentence:
        reasonSentence ??
        `The site stopped ${JOB_FINDER_BROWSER_NAME} before anything was filled.`,
      primaryAction: canOpenSafeguards ? "open_safeguards" : "open_browser",
      primaryActionLabel: canOpenSafeguards
        ? `Open Safeguards to reset ${JOB_FINDER_BROWSER_NAME}`
        : OPEN_JOB_FINDER_BROWSER_ACTION,
    };
  }

  if (applyResultNeedsSecurityCheck(visibleApplyResult)) {
    return {
      state: "needs_sign_in",
      statusLine: "This application needs a security check",
      reasonSentence:
        reasonSentence ??
        "Complete the security check in the Job Finder browser.",
      primaryAction: "open_browser",
      primaryActionLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
    };
  }

  if (needsManualFieldFinish) {
    return {
      state: "finish_in_browser",
      statusLine: "Ready for you to finish and send",
      reasonSentence:
        reasonSentence ??
        "Some fields on the page still need a person to settle them.",
      primaryAction: "open_browser",
      primaryActionLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
    };
  }

  // An account wall is the same shape of answer with a different sentence:
  // Job Finder never creates accounts, so the person makes one and it carries
  // on. "Try again" here reruns straight back into the same wall.
  if (
    looksLikeAccountWall({
      blockerCode: visibleApplyResult?.blockerReason ?? null,
      text: readReasonCorpus(visibleApplyResult),
    })
  ) {
    return {
      state: "needs_sign_in",
      statusLine: "This application needs an account first",
      reasonSentence: ACCOUNT_WALL_REASON,
      primaryAction: "open_browser",
      primaryActionLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
    };
  }

  // A sign-in wall, however the run recorded it: a blocker code, its own
  // sentence, or simply ending on the site's login page. Offering "Try again"
  // here reruns straight back into the same wall.
  if (
    looksLikeSignInWall({
      blockerCode: visibleApplyResult?.blockerReason ?? null,
      destinationUrl,
      text: readReasonCorpus(visibleApplyResult),
    })
  ) {
    return {
      state: "needs_sign_in",
      statusLine: "This application needs you to sign in",
      reasonSentence: SIGN_IN_WALL_REASON,
      primaryAction: "open_browser",
      primaryActionLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
    };
  }

  if (
    visibleApplyResult?.blockerReason === "site_protection" ||
    visibleApplyResult?.blockerReason === "provider_submit_auth_unavailable"
  ) {
    return {
      state: "needs_sign_in",
      statusLine: "This application needs you on the job site",
      reasonSentence:
        reasonSentence ??
        `The employer site asked for something only you can give — an account, a security check, or a consent. Do that step yourself in ${JOB_FINDER_BROWSER_NAME}.`,
      primaryAction: "open_browser",
      primaryActionLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
    };
  }

  // The site writes as you type. Runs let sites save as they go now, so a
  // result stopped on this (from an older run) just needs another go.
  if (applyResultBlockedBySiteSaves(visibleApplyResult)) {
    return {
      state: "site_saves_as_you_go",
      statusLine: "This site saves as you type",
      reasonSentence: SITE_SAVES_AS_YOU_GO_REASON,
      primaryAction: "try_again",
      primaryActionLabel: "Try again",
    };
  }

  // The form asked something nothing on file answers. The answer control is
  // the Needs you step, so that is the one button: "Try again" would rerun
  // into the same unanswered question.
  const resolvedResumeReview =
    recordLatestBlockerCode === null &&
    visibleApplyResult?.blockerReason === "required_human_input" &&
    /resume review|tailored resume|work history|resume[^.]*leaves out|hidden role/i.test(
      readReasonCorpus(visibleApplyResult),
    );
  if (resolvedResumeReview) {
    return {
      state: "retry",
      statusLine: "Your resume is ready",
      reasonSentence:
        "The resume review is complete. Try this same application again when you are ready.",
      primaryAction: "try_again",
      primaryActionLabel: TRY_AGAIN_ACTION,
    };
  }

  if (
    applyResultHasQuestionForPerson(
      visibleApplyResult,
      pausedQuestionCount,
      pausedQuestion,
    )
  ) {
    const question =
      pausedQuestion?.trim() || getPausedQuestionText(visibleApplyResult);
    const count = pausedQuestionCount ?? 0;
    return {
      state: "needs_answer",
      statusLine:
        count > 1
          ? "This application is waiting on your answers"
          : "This application is waiting on one answer",
      reasonSentence:
        count > 1
          ? `The form asks ${count} questions.`
          : question
            ? `The form asks: ${question}`
            : "The form asks something nothing in your profile, resume, or saved answers covers.",
      primaryAction: "answer_in_needs_you",
      primaryActionLabel: "Answer the questions",
    };
  }

  // A planned job is never "filling in": it waits its turn, waits on the
  // person's Resume, or was left behind by a batch that stopped.
  const plannedStanding = resolvePlannedApplyStanding(
    visibleApplyResult,
    input.run,
  );
  if (plannedStanding === "waiting_tab") {
    return {
      state: "preparing",
      statusLine: "Waiting for a browser tab",
      reasonSentence: visibleApplyResult?.detail ?? null,
      primaryAction: "close_finished_tabs",
      primaryActionLabel: "Close finished tabs",
    };
  }
  if (plannedStanding === "not_started") {
    return {
      state: "retry",
      statusLine: "Job Finder did not get to this application",
      reasonSentence: describeNotStartedApplication(input.run),
      primaryAction: "try_again",
      primaryActionLabel: TRY_AGAIN_ACTION,
    };
  }
  if (plannedStanding === "paused") {
    return {
      state: "preparing",
      statusLine: "Paused before this application",
      reasonSentence: PAUSED_BEFORE_APPLICATION_SENTENCE,
      primaryAction: "none",
      primaryActionLabel: null,
    };
  }
  if (plannedStanding === "waiting_turn") {
    return {
      state: "preparing",
      statusLine: "Waiting its turn",
      reasonSentence: null,
      primaryAction: "none",
      primaryActionLabel: null,
    };
  }

  // The run record, not a local pending flag: a seven-minute run kept the
  // flag for ninety seconds and then offered "Try again" beside itself.
  if (
    visibleApplyResult?.summary === WAITING_FOR_BROWSER_TAB_SUMMARY &&
    applyResultIsStillRunning(visibleApplyResult)
  ) {
    return {
      state: "preparing",
      statusLine: WAITING_FOR_BROWSER_TAB_SUMMARY,
      reasonSentence: visibleApplyResult.detail ?? null,
      primaryAction: "close_finished_tabs",
      primaryActionLabel: "Close finished tabs",
    };
  }
  if (
    (!visibleApplyResult && isApplyPending) ||
    applyResultIsStillRunning(visibleApplyResult)
  ) {
    const elapsed = applyResultIsStillRunning(visibleApplyResult)
      ? formatElapsedMinutes(visibleApplyResult?.startedAt, now)
      : null;
    return {
      state: "preparing",
      statusLine: elapsed
        ? `${FILLING_IN_THE_FORM_STATUS} (${elapsed})`
        : FILLING_IN_THE_FORM_STATUS,
      reasonSentence: null,
      primaryAction: "none",
      primaryActionLabel: null,
    };
  }

  if (applyResultNeedsResumeAttachment(visibleApplyResult)) {
    return {
      state: "reattach_resume",
      statusLine: "Your resume was not attached",
      reasonSentence:
        reasonSentence ??
        "The page did not accept the resume file, so preparation stopped before anything was sent.",
      primaryAction: "try_again",
      primaryActionLabel: TRY_AGAIN_ACTION,
    };
  }

  if (applyResultStoppedStructurally(visibleApplyResult)) {
    return {
      state: "structural_stop",
      statusLine: "Job Finder cannot apply to this one for you",
      reasonSentence:
        reasonSentence ??
        "This listing has no application Job Finder can fill in.",
      primaryAction: "open_listing",
      primaryActionLabel: OPEN_LISTING_ACTION,
    };
  }

  if (
    visibleApplyResult?.state === "awaiting_review" &&
    visibleApplyResult.automaticSendPending === true &&
    !visibleApplyResult.privacyReceipt?.submissionOutcome
  ) {
    return {
      state: "preparing",
      statusLine: "Waiting for automatic send",
      reasonSentence: visibleApplyResult.detail,
      primaryAction: "none",
      primaryActionLabel: null,
    };
  }

  // The form was worked to the end and nothing stopped it: the person reads
  // it over and sends it. This used to fall through to "stopped before
  // finishing" with a Try again button under a row that said Ready to send.
  if (
    visibleApplyResult?.state === "awaiting_review" &&
    !visibleApplyResult.blockerReason
  ) {
    return {
      state: "finish_in_browser",
      statusLine: "Ready for you to read over and send",
      reasonSentence:
        reasonSentence ??
        "Job Finder filled the form in and stopped before the send button.",
      primaryAction: "open_browser",
      primaryActionLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
    };
  }

  return {
    state: "retry",
    statusLine:
      visibleApplyResult?.state === "failed"
        ? "This application did not finish"
        : "Job Finder stopped before finishing this application",
    reasonSentence:
      reasonSentence ??
      "The run ended without reaching the end of the application.",
    primaryAction: "try_again",
    primaryActionLabel: TRY_AGAIN_ACTION,
  };
}
