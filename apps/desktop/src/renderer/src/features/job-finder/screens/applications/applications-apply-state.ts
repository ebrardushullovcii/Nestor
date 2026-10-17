import type { ApplicationRecord, ApplyJobResultListRow } from "@nestor/contracts";

import type { BadgeTone } from "../../lib/job-finder-types";

/**
 * Where one application actually stands, in one word.
 *
 * The question a person opens this screen to answer is always the same: is
 * anything of mine on that employer's site yet, and if not, what is stopping
 * it? These five answers are the whole vocabulary, and each one is only ever
 * reached from a recorded fact rather than an intention.
 *
 * `submitted_verified` is deliberately hard to reach. A browser click is not
 * proof an employer received anything, so an application counts as verified
 * only once the site itself, or the person checking it, has confirmed it.
 */
export type ApplicationApplyState =
  | "filled"
  | "awaiting_your_review"
  | "submitted_verified"
  | "submitted_unverified"
  | "paused";

export interface ApplicationApplyPresentation {
  state: ApplicationApplyState;
  /** The chip on the row. */
  label: string;
  tone: BadgeTone;
  /** One sentence saying what happened, in the person's words. */
  summary: string;
  /** What they can do next, or null when nothing is waiting on them. */
  nextStep: string | null;
}

function employerOf(record: ApplicationRecord): string | null {
  return record.company?.trim() || null;
}

function submissionOutcomeOf(
  applyResult: ApplyJobResultListRow | null | undefined,
): "submitted" | "outcome_uncertain" | "not_submitted" | null {
  const outcome = applyResult?.privacyReceipt?.submissionOutcome?.outcome;
  return outcome ?? null;
}

/**
 * Reads the state from what was recorded, never from what was attempted.
 *
 * Order matters here: a confirmed submission outranks everything, an uncertain
 * one outranks any local state, and anything still waiting on the person
 * outranks "filled in".
 */
export function getApplicationApplyPresentation(input: {
  record: ApplicationRecord;
  applyResult?: ApplyJobResultListRow | null;
}): ApplicationApplyPresentation {
  const { record, applyResult } = input;
  const employer = employerOf(record);
  const at = employer ? ` to ${employer}` : "";
  const outcome = submissionOutcomeOf(applyResult);

  // Only an attested external submission, or the person's own confirmation,
  // can say an application arrived.
  if (
    outcome === "submitted" ||
    record.lastAttemptState === "submitted" ||
    ["submitted", "assessment", "interview", "offer"].includes(record.status)
  ) {
    return {
      state: "submitted_verified",
      label: "Submitted",
      tone: "positive",
      summary: `This application was sent${at} and confirmed.`,
      nextStep: null,
    };
  }

  if (outcome === "outcome_uncertain") {
    return {
      state: "submitted_unverified",
      label: "Needs you",
      tone: "warning",
      summary: `Job Finder could not confirm whether this application was sent${at}. Check the employer site before sending it again.`,
      nextStep: `Open ${employer ?? "the site"} to check, then tell Job Finder what you found`,
    };
  }

  if (
    outcome === "not_submitted" &&
    applyResult?.privacyReceipt?.submissionOutcome?.browserAction?.reason ===
      "form_validation_failed"
  ) {
    return {
      state: "paused",
      label: "Not sent",
      tone: "warning",
      summary:
        applyResult.privacyReceipt.submissionOutcome.browserAction.detail ??
        applyResult.detail,
      nextStep: "Correct the fields in the browser",
    };
  }

  // A successful continuation can update the exact result and its review card
  // in the same repository transition that replaces an older person handoff.
  // Prefer that current, blocker-free result over a stale paused projection on
  // the application record so Ask before sending always exposes its review.
  if (
    applyResult?.state === "awaiting_review" &&
    applyResult.blockerReason == null &&
    record.automationMode === "confirm_before_submit"
  ) {
    return {
      state: "awaiting_your_review",
      label: "Ready to send",
      tone: "active",
      summary: `Job Finder filled this application in${at}. Look it over and send it when you are happy with it.`,
      nextStep: "Review it and send it",
    };
  }

  if (record.lastAttemptState === "paused" || record.latestBlocker) {
    const reason =
      record.latestBlocker?.summary?.trim() ||
      record.nextActionLabel?.trim() ||
      "Something on the form needs you.";
    return {
      state: "paused",
      label: "Needs you",
      tone: "warning",
      summary: reason,
      nextStep: record.nextActionLabel ?? "Open the application and finish it",
    };
  }

  // Read from what the person allowed when this was prepared, not from which
  // buttons happen to be wired up on the screen.
  if (record.automationMode === "confirm_before_submit") {
    return {
      state: "awaiting_your_review",
      label: "Ready to send",
      tone: "active",
      summary: `Job Finder filled this application in${at}. Look it over and send it when you are happy with it.`,
      nextStep: "Review it and send it",
    };
  }

  return {
    state: "filled",
    label: "Filled in",
    tone: "active",
    summary: `Job Finder filled this application in${at} and stopped. Nothing has been sent.`,
    nextStep: "Open the application and send it yourself",
  };
}
