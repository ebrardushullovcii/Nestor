import {
  APPLICATION_SKIPPED_BY_PERSON_LABEL,
  PREPARED_PAGE_CLOSED_SUMMARY,
  isApplicationTrackedAsSentByPerson,
  isApplicationWithdrawnByPerson,
  type ApplicationRecord,
  type JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import type {
  ApplyJobStateKind,
  ApplyMode,
} from "../../lib/apply-mode-contracts-stub";
import {
  JOB_FINDER_BROWSER_NAME,
  OPEN_JOB_FINDER_BROWSER_ACTION,
} from "../../lib/job-finder-browser-handoff-copy";
import {
  applyResultBlockedBySiteSaves,
  applyResultIsStillRunning,
  applyResultHasQuestionForPerson,
  applyResultNeedsSecurityCheck,
  applyResultStoppedStructurally,
  describeNotStartedApplication,
  formatElapsedMinutes,
  getApplicationStopReasonSentence,
  looksLikeAccountWall,
  looksLikeSignInWall,
  PAUSED_BEFORE_APPLICATION_SENTENCE,
  resolvePlannedApplyStanding,
  TRY_AGAIN_ACTION,
  WAITING_FOR_BROWSER_TAB_SUMMARY,
  type ApplyRunContext,
  type PlannedApplyStanding,
} from "./applications-recovery-state";

type ApplyResult = JobFinderRendererWorkspaceSnapshot["applyJobResults"][number] | null;

/** The only button an apply state is ever allowed to draw. */
export type ApplyStateAction = "none" | "open_browser" | "try_again";

/**
 * The label for {@link ApplyStateAction} `open_browser`.
 *
 * ADR 0022 writes this parenthetically as "Open the browser"; the window has
 * one enforced name across the product (`job-finder-browser-name.guard`), so
 * the label comes from that one constant rather than adding a second name for
 * the same window.
 */
export const OPEN_THE_BROWSER_ACTION = OPEN_JOB_FINDER_BROWSER_ACTION;

/**
 * One state, one sentence, at most one button (ADR 0022).
 *
 * Applications, Home and the Tasks card all read this, so an application
 * cannot be "Needs follow-up" in one place and "Try again" in another.
 */
export interface ApplyStatePresentation {
  kind: ApplyJobStateKind;
  /** The state in plain words. */
  title: string;
  /** Why, in the run's own words, for the states that have a reason. */
  sentence: string | null;
  action: ApplyStateAction;
  actionLabel: string | null;
  /** "1 question left for you", when the run handed one back. */
  questionsLeftLabel: string | null;
  /**
   * For a job its batch has not started yet: waiting its turn, held by the
   * person's pause, or left behind by a batch that stopped. Null otherwise.
   */
  plannedStanding?: PlannedApplyStanding | null;
  /** The person stopped it: a neutral state, not an error. */
  cancelledByPerson?: true;
  /** The person marked it withdrawn in their tracker. */
  withdrawnByPerson?: true;
}

function formatQuestionsLeft(count: number): string | null {
  if (count < 1) {
    return null;
  }

  return count === 1
    ? "1 question left for you"
    : `${count} questions left for you`;
}

export { WAITING_FOR_BROWSER_TAB_SUMMARY };

/** What the service writes on a prepared result whose send was refused. */
export const NOT_SENT_RESULT_PREFIX = "Not sent";

/** "Not sent: <reason>. <detail>" for a refused send, else null. */
export function describeNotSentResult(
  result: { summary: string; detail?: string | null } | null | undefined,
): string | null {
  // Older and partial results can lack a summary; they were never refused.
  if (typeof result?.summary !== "string") return null;
  if (!result.summary.startsWith(NOT_SENT_RESULT_PREFIX)) return null;
  const detail = result.detail?.trim() ?? "";
  return detail ? `${result.summary}. ${detail}` : `${result.summary}.`;
}

/**
 * Decides the whole of an application's row and detail header from the run.
 *
 * `mode` only changes what a finished fill means: with the switch off a
 * filled form is Ready to send, and with it on a run that filled everything
 * and stopped short of sending is the person's to finish too — Job Finder
 * never claims a submission it did not verify.
 */
export function resolveApplyStatePresentation(input: {
  mode: ApplyMode;
  now?: number;
  pendingQuestionCount?: number;
  recordFailure?: {
    lastActionLabel: string;
    lastUpdatedAt: string;
  } | null;
  result: ApplyResult;
  /**
   * What the result's run is doing. Without it a planned job of a stopped
   * batch read "Filling in (N min)" for ever.
   */
  run?: ApplyRunContext | null;
  /** The record's last action; a person's skip is not a failure. */
  recordLastActionLabel?: string | null;
  /** The record's tracker, where the person may have recorded the send. */
  recordCrm?: ApplicationRecord["crm"] | undefined;
  recordLatestBlocker?: ApplicationRecord["latestBlocker"];
}): ApplyStatePresentation {
  const { mode, now = Date.now(), pendingQuestionCount = 0, result } = input;
  const questionsLeftLabel = formatQuestionsLeft(pendingQuestionCount);
  const reason = getApplicationStopReasonSentence(result);

  // The person recorded Applied (or a later stage) themselves. Their word is
  // not the site's confirmation, so it is named as theirs, but nothing asks
  // them to finish or retry an application they already sent (N-033).
  if (
    isApplicationTrackedAsSentByPerson(input.recordCrm) &&
    result?.state !== "submitted" &&
    result?.privacyReceipt?.submissionOutcome?.outcome !== "submitted"
  ) {
    return {
      kind: "applied",
      title: "Marked applied",
      sentence:
        "You marked this as applied in your tracker. Job Finder did not see the site's confirmation and will not fill it in again.",
      action: "none",
      actionLabel: null,
      questionsLeftLabel: null,
    };
  }
  if (
    isApplicationWithdrawnByPerson(input.recordCrm) &&
    result?.state !== "submitted"
  ) {
    return {
      kind: "could_not_apply",
      title: "Withdrawn",
      sentence:
        "You marked this application withdrawn. Job Finder will not work on it.",
      action: "none",
      actionLabel: null,
      questionsLeftLabel: null,
      cancelledByPerson: true,
      withdrawnByPerson: true,
    };
  }

  if (
    input.recordLastActionLabel === APPLICATION_SKIPPED_BY_PERSON_LABEL &&
    result?.state !== "submitted"
  ) {
    return {
      kind: "could_not_apply",
      title: "Skipped",
      sentence: "You asked to skip this one. Nothing was sent.",
      action: "try_again",
      actionLabel: "Apply again",
      questionsLeftLabel: null,
    };
  }

  if (result?.blockerReason === "application_closed") {
    return {
      kind: "could_not_apply",
      title: "Listing closed",
      sentence: reason,
      action: "none",
      actionLabel: null,
      questionsLeftLabel: null,
    };
  }

  const plannedStanding = resolvePlannedApplyStanding(result, input.run);
  if (plannedStanding === "waiting_tab") {
    return {
      kind: "filling_in",
      title: "Waiting for a browser tab",
      sentence: result?.detail ?? null,
      action: "none",
      actionLabel: null,
      questionsLeftLabel: null,
      plannedStanding,
    };
  }
  if (plannedStanding === "not_started") {
    return {
      kind: "could_not_apply",
      title: "Not started",
      sentence: describeNotStartedApplication(input.run),
      action: "try_again",
      actionLabel: TRY_AGAIN_ACTION,
      questionsLeftLabel: null,
      plannedStanding,
    };
  }
  if (plannedStanding === "paused") {
    return {
      kind: "filling_in",
      title: "Paused",
      sentence: PAUSED_BEFORE_APPLICATION_SENTENCE,
      action: "none",
      actionLabel: null,
      questionsLeftLabel: null,
      plannedStanding,
    };
  }
  if (plannedStanding === "waiting_turn") {
    return {
      kind: "filling_in",
      title: "Waiting its turn",
      sentence: formatElapsedMinutes(result?.startedAt, now),
      action: "none",
      actionLabel: null,
      questionsLeftLabel: null,
      plannedStanding,
    };
  }

  if (applyResultIsStillRunning(result)) {
    // The browser is full: say that it waits, and what frees a tab.
    if (result?.summary === WAITING_FOR_BROWSER_TAB_SUMMARY) {
      return {
        kind: "filling_in",
        title: `Waiting for a browser tab${formatElapsedMinutes(result?.startedAt, now) ? ` (${formatElapsedMinutes(result?.startedAt, now)})` : ""}`,
        sentence: result.detail ?? null,
        action: "none",
        actionLabel: null,
        questionsLeftLabel: null,
      };
    }
    const elapsed = formatElapsedMinutes(result?.startedAt, now);
    return {
      kind: "filling_in",
      title: elapsed ? `Preparing (${elapsed})` : "Preparing",
      sentence: result?.detail ?? null,
      action: "none",
      actionLabel: null,
      questionsLeftLabel: null,
    };
  }

  // Applied is only ever a verified employer-side outcome. An uncertain one
  // is never dressed up as a submission (ADR 0012).
  const submissionOutcome =
    result?.privacyReceipt?.submissionOutcome?.outcome ?? null;
  if (
    submissionOutcome === "submitted" ||
    (result?.state === "submitted" &&
      result.privacyReceipt?.finalSubmitOccurred !== false)
  ) {
    return {
      kind: "applied",
      title: "Applied",
      sentence: null,
      action: "none",
      actionLabel: null,
      questionsLeftLabel: null,
    };
  }

  if (
    submissionOutcome === "outcome_uncertain" ||
    result?.blockerReason === "submission_outcome_uncertain"
  ) {
    return {
      kind: "needs_you",
      title: "Needs you",
      sentence:
        "Job Finder could not confirm whether this application was sent. Check the employer site before trying to send it again.",
      action: "open_browser",
      actionLabel: OPEN_THE_BROWSER_ACTION,
      questionsLeftLabel: null,
    };
  }

  if (
    result?.state === "submitted" &&
    result.privacyReceipt?.finalSubmitOccurred === false
  ) {
    return {
      kind: "needs_you",
      title: "Send not confirmed",
      sentence:
        "The saved receipt does not confirm a send. Review this application's outcome before trying again.",
      action: "none",
      actionLabel: null,
      questionsLeftLabel: null,
    };
  }

  if (
    result?.state === "failed" &&
    result.summary === PREPARED_PAGE_CLOSED_SUMMARY
  ) {
    return {
      kind: "could_not_apply",
      title: "Could not apply",
      sentence:
        "The prepared form is no longer open. Prepare it again using your saved answers and files.",
      action: "try_again",
      actionLabel: "Prepare again",
      questionsLeftLabel: null,
    };
  }

  const recordFailureIsLatest =
    input.recordFailure !== null &&
    input.recordFailure !== undefined &&
    (!result ||
      Date.parse(input.recordFailure.lastUpdatedAt) >=
        Date.parse(result.updatedAt));
  if (recordFailureIsLatest) {
    return {
      kind: "could_not_apply",
      title: "Could not apply",
      sentence: input.recordFailure?.lastActionLabel ?? null,
      action: "try_again",
      actionLabel: TRY_AGAIN_ACTION,
      questionsLeftLabel: null,
    };
  }

  if (result?.state === "cancelled") {
    return {
      kind: "could_not_apply",
      title: "Cancelled by you",
      sentence: result.detail,
      action: "try_again",
      actionLabel: TRY_AGAIN_ACTION,
      questionsLeftLabel: null,
      cancelledByPerson: true,
    };
  }

  const needsPerson =
    (result?.state === "awaiting_review" &&
      Boolean(result.blockerReason || input.recordLatestBlocker)) ||
    applyResultNeedsSecurityCheck(result) ||
    looksLikeSignInWall({
      blockerCode: result?.blockerReason ?? null,
      text: `${result?.blockerSummary ?? ""} ${result?.detail ?? ""}`,
    }) ||
    looksLikeAccountWall({
      blockerCode: result?.blockerReason ?? null,
      text: `${result?.blockerSummary ?? ""} ${result?.detail ?? ""}`,
    });

  if (needsPerson) {
    return {
      kind: "needs_you",
      title: "Needs you",
      sentence:
        reason ??
        `This site wants you to sign in or make an account. Do that in ${JOB_FINDER_BROWSER_NAME} and Job Finder can carry on.`,
      action: "open_browser",
      actionLabel: OPEN_THE_BROWSER_ACTION,
      questionsLeftLabel,
    };
  }

  // The run worked the form to the end and handed back what only the
  // person can answer: a declaration, a question nothing on file covers.
  // That is theirs to finish, not a failure.
  if (applyResultHasQuestionForPerson(result, pendingQuestionCount)) {
    return {
      kind: "needs_you",
      title: "Needs you",
      sentence:
        reason ??
        "The form asks something only you can answer. Answer it here, or finish it in the browser.",
      action: "open_browser",
      actionLabel: OPEN_THE_BROWSER_ACTION,
      questionsLeftLabel,
    };
  }

  if (
    result?.state === "awaiting_review" &&
    result.automaticSendPending === true &&
    !result.privacyReceipt?.submissionOutcome
  ) {
    return {
      kind: "filling_in",
      title: "Waiting to send",
      sentence: result.detail,
      action: "none",
      actionLabel: null,
      questionsLeftLabel: null,
    };
  }

  if (
    result?.privacyReceipt?.submissionOutcome?.outcome === "not_submitted" &&
    result.privacyReceipt.submissionOutcome.browserAction?.reason ===
      "form_validation_failed"
  ) {
    return {
      kind: "ready_to_send",
      title: "Not sent",
      sentence:
        result.privacyReceipt.submissionOutcome.browserAction?.detail ??
        result.detail,
      action: "open_browser",
      actionLabel: "Correct the fields in the browser",
      questionsLeftLabel: null,
    };
  }
  if (result?.state === "awaiting_review") {
    // A send that was asked for and refused says why (the service writes
    // "Not sent: ..." on the result); the old row said nothing at all.
    const notSent = describeNotSentResult(result);
    return {
      kind: "ready_to_send",
      title: "Ready to send",
      sentence:
        notSent ??
        (mode === "apply_for_me"
          ? "Job Finder filled it in but did not send it. Read it over and click Apply on the site."
          : "Job Finder filled it in. Read it over and click Apply on the site."),
      action: "open_browser",
      actionLabel: OPEN_THE_BROWSER_ACTION,
      questionsLeftLabel,
    };
  }

  if (result?.state === "blocked" || result?.state === "failed") {
    // A retry only earns a button when a fresh run could genuinely differ.
    const retryCanDiffer =
      !applyResultStoppedStructurally(result) &&
      !applyResultBlockedBySiteSaves(result);
    return {
      kind: "could_not_apply",
      title: "Could not apply",
      sentence: reason ?? "The run ended before the application was finished.",
      action: retryCanDiffer ? "try_again" : "open_browser",
      actionLabel: retryCanDiffer ? TRY_AGAIN_ACTION : OPEN_THE_BROWSER_ACTION,
      questionsLeftLabel,
    };
  }

  // A job its batch stopped around (or one the person skipped) was never
  // filled in; it read "Ready to send" with nothing to send.
  if (result?.state === "skipped") {
    return {
      kind: "could_not_apply",
      title: "Could not apply",
      sentence: reason ?? "Job Finder did not get to this application.",
      action: "try_again",
      actionLabel: TRY_AGAIN_ACTION,
      questionsLeftLabel: null,
    };
  }

  return {
    kind: "ready_to_send",
    title: "Ready to send",
    sentence:
      "Job Finder filled it in. Read it over and click Apply on the site.",
    action: "open_browser",
    actionLabel: OPEN_THE_BROWSER_ACTION,
    questionsLeftLabel,
  };
}

/** The one per-job control in Shortlisted, named for what the mode does. */
export function applyActionLabel(mode: ApplyMode): string {
  return mode === "apply_for_me" ? "Apply" : "Apply";
}

/** The one list-level control in Shortlisted. */
export function applyAllActionLabel(mode: ApplyMode): string {
  return mode === "apply_for_me"
    ? "Apply to all shortlisted"
    : "Fill in all shortlisted";
}
