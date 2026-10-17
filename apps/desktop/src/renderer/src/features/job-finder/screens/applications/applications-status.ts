import type {
  ApplicationAttemptListRow,
  ApplicationAttemptQuestion,
  ApplicationRecord,
  ApplyJobResultListRow,
} from "@nordri/contracts";
import {
  formatStatusLabel,
  getApplicationTone,
} from "../../lib/job-finder-utils";
import type { BadgeTone } from "../../lib/job-finder-types";
import { FINISH_IN_JOB_FINDER_BROWSER_LIST_NEXT_STEP } from "../../lib/job-finder-browser-handoff-copy";
import {
  SITE_BLOCKED_AUTOMATIC_PREP_LIST_NEXT_STEP,
  applicationRecordLooksSiteBlocked,
} from "./applications-detail-panel-helpers";
import {
  applicationRecordBlockedBySiteSaves,
  getApplicationHostLabel,
  looksLikeAccountWall,
  looksLikeSignInWall,
} from "./applications-recovery-state";

const SERVICE_WORKER_LIKE_NEXT_STEP = /service worker/i;

/**
 * The runtime records an autosave/attachment pause as "Complete the affected
 * step manually in the open application, or cancel". The detail panel already
 * says the truthful thing for that pause, so list rows must say it too instead
 * of exposing the raw runtime phrasing.
 */
const MANUAL_OPEN_APPLICATION_FINISH_NEXT_STEP =
  /complete the (?:affected|resume) step manually in the open application/i;

function shouldPresentConsentState(record: ApplicationRecord): boolean {
  return (
    record.status === "drafting" ||
    record.status === "ready_for_review" ||
    record.status === "approved"
  );
}

export function getApplicationLatestActivityLabel(
  record: ApplicationRecord,
): string {
  if (record.lastAttemptState === "unsupported") {
    return "Needs you on the site";
  }

  if (record.lastAttemptState === "failed") {
    return "Attempt failed";
  }

  if (record.lastAttemptState === "submitted") {
    return record.lastActionLabel || "Submitted";
  }

  if (
    shouldPresentConsentState(record) &&
    record.lastAttemptState === "paused" &&
    applicationRecordLooksSiteBlocked(record)
  ) {
    return "Automatic prep paused";
  }

  if (
    shouldPresentConsentState(record) &&
    record.lastAttemptState === "paused"
  ) {
    return record.nextActionLabel ?? "Needs follow-up";
  }

  if (
    shouldPresentConsentState(record) &&
    record.consentSummary.status === "requested"
  ) {
    return record.consentSummary.pendingCount > 1
      ? `${record.consentSummary.pendingCount} consent decisions waiting`
      : "Consent decision waiting";
  }

  if (
    shouldPresentConsentState(record) &&
    record.consentSummary.status === "approved"
  ) {
    return "Consent approved";
  }

  if (
    shouldPresentConsentState(record) &&
    record.consentSummary.status === "declined"
  ) {
    return "Consent declined";
  }

  if (!shouldPresentConsentState(record)) {
    return record.lastActionLabel;
  }

  return record.lastActionLabel;
}

/**
 * The plain answer to the question the record never answered: *did I apply,
 * and is anything of mine on that site?*
 *
 * The round-eight review found one application described by seven different
 * state words — NEEDS YOU five times, plus "Needs follow-up", plus a Tracker
 * stage of "Preparing" — and none of them said "Not submitted". This is the
 * one sentence that does, and it leads the detail pane uncollapsed.
 *
 * It is deliberately conservative: only a recorded submission says submitted.
 * Preparation, pauses and blockers do not establish a confirmed submission.
 */
export function getApplicationSubmissionAnswer(
  record: ApplicationRecord,
  employerName?: string | null,
  applyResult?: ApplyJobResultListRow | null,
): { headline: string; detail: string; submitted: boolean } {
  const employer = employerName?.trim() || record.company?.trim() || null;
  const submitted =
    record.lastAttemptState === "submitted" ||
    ["submitted", "assessment", "interview", "offer"].includes(record.status);

  if (submitted) {
    return {
      headline: "You recorded this as submitted.",
      detail: employer
        ? `Job Finder never sends an application — this is the outcome you recorded after sending it to ${employer} yourself.`
        : "Job Finder never sends an application — this is the outcome you recorded after sending it yourself.",
      submitted: true,
    };
  }

  if (applyResult) {
    const writes = applyResult.privacyReceipt?.externalWrites ?? [];
    const writeFact =
      writes.length === 0
        ? "Nothing was recorded as written to the site."
        : `${writes.length} prepared ${writes.length === 1 ? "field or file was" : "fields or files were"} recorded as written to the site.`;
    const didNotFinish = ["blocked", "failed", "skipped", "cancelled"].includes(
      applyResult.state,
    );
    return {
      headline: didNotFinish ? "Preparation did not finish." : "Not submitted.",
      detail: employer
        ? `${writeFact} This application has not been sent to ${employer}. Review the facts below before continuing in the Job Finder browser.`
        : `${writeFact} This application has not been sent. Review the facts below before continuing in the Job Finder browser.`,
      submitted: false,
    };
  }

  return {
    headline: "Not submitted.",
    detail: employer
      ? `This application has not been sent to ${employer}. Check the preparation details below, then review the fields and resume in the Job Finder browser before sending it.`
      : "This application has not been sent. Check the preparation details below, then review the fields and resume in the Job Finder browser before sending it.",
    submitted: false,
  };
}

export function getApplicationStagePresentation(record: ApplicationRecord): {
  label: string;
  tone: BadgeTone;
} {
  if (
    shouldPresentConsentState(record) &&
    record.lastAttemptState === "unsupported"
  ) {
    // Attention, not failure: the site cannot be prepared automatically, so
    // the user finishes it themselves. `warning` (F44) says that without the
    // failure hue that `critical` claimed before the tone existed.
    return { label: "Needs you on the site", tone: "warning" };
  }

  if (
    shouldPresentConsentState(record) &&
    record.lastAttemptState === "failed"
  ) {
    return { label: "Needs recovery", tone: "critical" };
  }

  // A paused run that recorded its own gate (sign in, finish a step in the
  // browser) files it as a "requested" consent, but the user is not being
  // asked to consent to anything: the site is waiting on them. When the run
  // saved what to do next, that is the stage.
  // "Ready to send" is not a problem to solve, so it keeps its own words
  // rather than borrowing the Needs you chip.
  if (
    shouldPresentConsentState(record) &&
    record.automationMode === "confirm_before_submit" &&
    record.lastAttemptState !== "paused" &&
    record.lastAttemptState !== "submitted"
  ) {
    return { label: "Ready to send", tone: "active" };
  }

  if (
    shouldPresentConsentState(record) &&
    record.consentSummary.status === "requested" &&
    record.lastAttemptState === "paused" &&
    record.nextActionLabel
  ) {
    return { label: "Needs you", tone: "active" };
  }

  if (
    shouldPresentConsentState(record) &&
    record.consentSummary.status === "requested"
  ) {
    return { label: "Waiting on consent", tone: "active" };
  }

  if (
    shouldPresentConsentState(record) &&
    record.lastAttemptState === "paused" &&
    record.consentSummary.status !== "declined"
  ) {
    // Site-blocked finish-yourself pauses need stronger list contrast than the
    // default active steel chip. `warning` (F44) supplies it without the
    // failure hue: nothing failed, the user has to finish on the site.
    return {
      label: "Needs you",
      tone: applicationRecordLooksSiteBlocked(record) ? "warning" : "active",
    };
  }

  if (
    shouldPresentConsentState(record) &&
    record.consentSummary.status === "approved"
  ) {
    if (record.lastAttemptState === "submitted") {
      return { label: "Submitted", tone: getApplicationTone("submitted") };
    }

    return { label: "Ready after consent", tone: "active" };
  }

  if (
    shouldPresentConsentState(record) &&
    record.consentSummary.status === "declined"
  ) {
    return { label: "Consent declined", tone: "critical" };
  }

  return {
    label: formatStatusLabel(record.status),
    tone: getApplicationTone(record.status),
  };
}

/** The exact words the Needs-you population and the row badge share. */
export const APPLICATION_NEEDS_YOU_STAGE_LABEL = "Needs you";

/**
 * One selector for "this application is waiting on the person".
 *
 * The Applications row badged an application NEEDS YOU while the global
 * "Needs you: 0 unresolved" counted only live browser-step requests, so the
 * same screen answered its own question two ways. Both now read this, derived
 * from the stage presentation itself, so a new stage rule cannot make them
 * drift apart again.
 */
export function applicationRecordAwaitsUser(
  record: ApplicationRecord,
): boolean {
  if (!shouldPresentConsentState(record)) return false;
  // An application filled in under "ask me before sending" is waiting on the
  // person just as much as a paused one: it will never go out until they read
  // it and press send, so it belongs in the same queue.
  if (
    record.automationMode === "confirm_before_submit" &&
    record.lastAttemptState !== "submitted"
  ) {
    return true;
  }
  if (record.lastAttemptState !== "paused") return false;
  const consent = record.consentSummary.status;
  if (consent === "declined") return false;
  // A requested consent with nothing saved to do next reads as "Waiting on
  // consent", not as work waiting on the person.
  if (consent === "requested" && !record.nextActionLabel) return false;
  return true;
}

/**
 * The row's "Next:" line, taken from the same evidence the detail panel's one
 * button is taken from. A row that said "Answer the question in Needs you"
 * beside a panel offering "Try again" — for a run with no question at all —
 * is what this exists to stop.
 */
export function getApplicationStateNextStepLabel(
  record: ApplicationRecord,
): string | null {
  if (record.lastAttemptState === "submitted") {
    return null;
  }

  const corpus = [
    record.latestBlocker?.summary,
    record.lastActionLabel,
    record.nextActionLabel,
  ]
    .filter(Boolean)
    .join(" ");
  // The site the run was actually on, never the employer: a Built In Chicago
  // listing signs in at accounts.builtin.com, and "Sign in on Caterpillar"
  // sent the reader to the wrong place entirely.
  const siteLabel =
    getApplicationHostLabel(record.replaySummary.lastUrl) ?? "the job site";

  if (applicationRecordBlockedBySiteSaves(record)) {
    return `Allow saving on ${siteLabel}`;
  }

  if (
    looksLikeAccountWall({
      blockerCode: record.latestBlocker?.code ?? null,
      text: corpus,
    })
  ) {
    return `Create an account on ${siteLabel}`;
  }

  if (
    looksLikeSignInWall({
      blockerCode: record.latestBlocker?.code ?? null,
      destinationUrl: record.replaySummary.lastUrl,
      text: corpus,
    })
  ) {
    return `Sign in on ${siteLabel}`;
  }

  return null;
}

/**
 * True when a question step actually exists for this application. Without it
 * the row happily told people to answer a question nothing had asked.
 */
export function applicationHasOpenQuestion(record: ApplicationRecord): boolean {
  return (
    record.questionSummary.unansweredRequired > 0 ||
    record.latestBlocker?.code === "missing_candidate_answer"
  );
}

const NEEDS_YOU_QUESTION_LABEL = /answer the question in needs you/i;

export function getApplicationNextStepLabel(record: ApplicationRecord): string {
  if (record.lastAttemptState === "submitted" || record.status === "submitted")
    return "View application";
  const stateNextStep = getApplicationStateNextStepLabel(record);
  if (stateNextStep) {
    return stateNextStep;
  }

  // A saved "answer the question" label is only true while a question is
  // actually open; otherwise the row falls through to the ordinary rules.
  if (
    record.nextActionLabel &&
    NEEDS_YOU_QUESTION_LABEL.test(record.nextActionLabel) &&
    !applicationHasOpenQuestion(record)
  ) {
    return record.lastAttemptState === "failed"
      ? "Try again"
      : "Open the Job Finder browser";
  }

  if (
    shouldPresentConsentState(record) &&
    record.lastAttemptState === "unsupported"
  ) {
    return record.nextActionLabel ?? "Needs you on the site";
  }

  if (
    shouldPresentConsentState(record) &&
    record.lastAttemptState === "failed"
  ) {
    return record.nextActionLabel ?? "Needs recovery";
  }

  if (
    shouldPresentConsentState(record) &&
    record.lastAttemptState === "paused" &&
    applicationRecordLooksSiteBlocked(record)
  ) {
    return SITE_BLOCKED_AUTOMATIC_PREP_LIST_NEXT_STEP;
  }

  if (
    shouldPresentConsentState(record) &&
    record.consentSummary.status === "requested" &&
    record.lastAttemptState === "paused" &&
    record.nextActionLabel
  ) {
    return record.nextActionLabel;
  }

  if (
    shouldPresentConsentState(record) &&
    record.consentSummary.status === "requested"
  ) {
    return "Choose continue or skip in Consent requests below.";
  }

  if (
    shouldPresentConsentState(record) &&
    record.consentSummary.status === "approved"
  ) {
    return (
      record.nextActionLabel ??
      "Review the prepared application before any later execution step."
    );
  }

  if (
    shouldPresentConsentState(record) &&
    record.consentSummary.status === "declined"
  ) {
    return (
      record.nextActionLabel ?? "Press Try again to have another go later."
    );
  }

  return record.nextActionLabel ?? "No next step saved";
}

export function getApplicationReadableNextStepLabel(
  label: string | null | undefined,
): string | null {
  const trimmed = label?.trim();

  if (!trimmed) {
    return null;
  }

  if (
    /inspect the application page manually|job site blocked|reset (?:the (?:job finder )?)?browser in safeguards/i.test(
      trimmed,
    ) ||
    SERVICE_WORKER_LIKE_NEXT_STEP.test(trimmed)
  ) {
    return SITE_BLOCKED_AUTOMATIC_PREP_LIST_NEXT_STEP;
  }

  if (/sign in manually,? then retry preparation/i.test(trimmed)) {
    return "Sign in on the site in the Job Finder browser, then run preparation again";
  }

  if (MANUAL_OPEN_APPLICATION_FINISH_NEXT_STEP.test(trimmed)) {
    // List rows get the compact one-line form; the detail pane carries the
    // full instruction naming the window and the confirm action.
    return FINISH_IN_JOB_FINDER_BROWSER_LIST_NEXT_STEP;
  }

  if (
    /review the prepared application and submit manually when ready/i.test(
      trimmed,
    )
  ) {
    return "Submit the prepared application manually";
  }

  if (
    /review the prepared application before any later execution step/i.test(
      trimmed,
    )
  ) {
    return "Submit the prepared application manually";
  }

  if (/review the pending submit approval in applications/i.test(trimmed)) {
    return "Review the pending safe preparation approval";
  }

  if (/review the queued run approval in applications/i.test(trimmed)) {
    return "Review the prepared run approval";
  }

  return trimmed;
}

/**
 * The exact pending questions Needs you renders for one application.
 *
 * Applications used to count the run summary's `unansweredRequired` while
 * Needs you rendered the detected question records, so the two screens said
 * "6 questions" and drew 4 controls. One selector, both screens.
 */
export function listPendingApplicationQuestions(input: {
  applicationAttempts: readonly ApplicationAttemptListRow[];
  applicationRecordId?: string | null;
  jobId: string;
}): readonly ApplicationAttemptQuestion[] {
  const { applicationAttempts, applicationRecordId, jobId } = input;
  const latestAttempt = [...applicationAttempts]
    .filter(
      (attempt) =>
        attempt.jobId === jobId &&
        (applicationRecordId === undefined ||
          attempt.applicationRecordId === applicationRecordId),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

  if (latestAttempt?.blocker?.code !== "missing_candidate_answer") {
    return [];
  }

  return (
    latestAttempt.questions.filter(
      (question) => question.status === "detected",
    ) ?? []
  );
}
