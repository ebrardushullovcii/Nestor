import { JOB_FINDER_BROWSER_LABEL } from "@nestor/contracts";
import { isEmployerAbsenceLabel } from "./job-employer-location-display";

/**
 * One name for the browser, one name for each hand-off action.
 *
 * Round-eight review (F03, P0) found the same window called four different
 * things across four screens — "the open browser", "the Job Finder browser",
 * "the managed browser" and "SEARCH BROWSER" — while the action that confirms
 * the user came back had three names that changed in place: "I finished this
 * step" became "Check again" became "Step is complete". The app also never
 * said the window existed, where it was, or that the user had to switch to it
 * and come back.
 *
 * Every user-facing string that refers to that window or to the hand-off must
 * come from this module. Nothing here performs, authorizes or implies a
 * submission: Job Finder opens and fills the application, and the person
 * reviews and submits it themselves.
 */

/**
 * The window's bare name, for labels and headings that carry no article.
 * Every other form here is derived from it, so the app cannot drift back into
 * calling one window several things.
 *
 * It is defined in `@nestor/contracts` rather than here because
 * `@nestor/job-finder` writes user-facing copy about the same window and
 * cannot import from the desktop renderer — the dependency runs the other way.
 * Contracts is the one package both already depend on. This module keeps
 * ownership of every derived form and re-exports the label so renderer code has
 * a single import for all of it.
 */
export { JOB_FINDER_BROWSER_LABEL };

/**
 * The canonical name of the separate browser window Job Finder drives.
 * Used mid-sentence; {@link JOB_FINDER_BROWSER_NAME_SENTENCE_START} is the
 * capitalised form.
 */
export const JOB_FINDER_BROWSER_NAME = `the ${JOB_FINDER_BROWSER_LABEL}`;

/** Sentence-initial form of {@link JOB_FINDER_BROWSER_NAME}. */
export const JOB_FINDER_BROWSER_NAME_SENTENCE_START = `The ${JOB_FINDER_BROWSER_LABEL}`;

/**
 * Said once, at the moment the user is sent there, so the browser is never a
 * thing they are expected to already know about. It lives inside the app
 * (ADR 0017), behind the Browser button in the header.
 */
const JOB_FINDER_BROWSER_IS_IN_THE_APP = `${JOB_FINDER_BROWSER_NAME_SENTENCE_START} opens right here in the app, from the Browser button at the top.`;

/** Opens or focuses that window on the paused application page. */
export const OPEN_JOB_FINDER_BROWSER_ACTION = `Open ${JOB_FINDER_BROWSER_NAME}`;

/**
 * The same control after the hand-off has already happened. The window is
 * open, so the action is no longer "open" and is no longer the primary path —
 * confirming is.
 */
export const REOPEN_JOB_FINDER_BROWSER_ACTION = `Reopen ${JOB_FINDER_BROWSER_NAME}`;

/**
 * The single confirm action, in every place the user comes back to. Named for
 * its object (this step) so it is distinguishable at a glance from
 * {@link RUN_PREPARATION_AGAIN_ACTION}, which re-runs preparation from
 * scratch. It never changes its own name: while the check runs the control is
 * pending, and a failed check is reported beside it rather than by renaming
 * it.
 */
export const CONFIRM_STEP_DONE_ACTION = "Check whether this step is done";

/** In-flight label for {@link CONFIRM_STEP_DONE_ACTION}. */
export const CONFIRM_STEP_DONE_PENDING_LABEL = "Checking the application page…";

/**
 * Re-runs preparation. Deliberately not called "retry": the two controls sat
 * adjacent at two weights while their labels ("Check again" / "Retry
 * preparation later") did not say which object each acted on.
 */
export const RUN_PREPARATION_AGAIN_ACTION = "Run preparation again";

/**
 * Named the same way whether it is offered now or deferred, so the deferred
 * variant is recognisably the same action.
 */
export const RUN_PREPARATION_AGAIN_LATER_ACTION = "Run preparation again later";

/**
 * The instruction itself. Names the window, says where it is, says the user
 * must switch to it and come back, and states the prepare-only boundary in
 * the same breath so it cannot be read as "Job Finder will finish this".
 */
export const FINISH_IN_JOB_FINDER_BROWSER_INSTRUCTION =
  `Finish this application in ${JOB_FINDER_BROWSER_NAME}. ` +
  `${JOB_FINDER_BROWSER_IS_IN_THE_APP} Complete the step there, hide it, ` +
  `then choose "${CONFIRM_STEP_DONE_ACTION}".`;

/** Compact one-line variant for list rows, where the detail pane carries the rest. */
export const FINISH_IN_JOB_FINDER_BROWSER_LIST_NEXT_STEP = `Finish this application in ${JOB_FINDER_BROWSER_NAME}, then come back and confirm`;

/**
 * Status shown beside the confirm action once the window has been opened or
 * focused on this application. It states what is true now instead of
 * repeating the instruction a second way.
 */
export const JOB_FINDER_BROWSER_OPENED_STATUS =
  `Opened in ${JOB_FINDER_BROWSER_NAME}. Finish the step there, ` +
  `then hide it and come back here.`;

/**
 * Shown when the window cannot be opened from this screen. Still names the
 * window rather than describing a permission model.
 */
export const JOB_FINDER_BROWSER_UNAVAILABLE_NOTE =
  `${JOB_FINDER_BROWSER_NAME_SENTENCE_START} cannot be opened from here right now. ` +
  `Use the Browser button at the top, or open this step from Needs you.`;

/**
 * The hand-off opened the window but had no recorded step to reopen, so the
 * paused application page is not what came up. Saying "Opened in the Job
 * Finder browser. Switch to that window to finish the step" here would send
 * the user to a window that never showed the step.
 */
export const JOB_FINDER_BROWSER_OPENED_WITHOUT_PAGE_STATUS =
  `${JOB_FINDER_BROWSER_NAME_SENTENCE_START} is open, but this application page was not reopened ` +
  `from here, so the step may not be on screen there. Find the application in the browser, or ` +
  `open this step from Needs you.`;

/**
 * The hand-off did not open anything. States that plainly, carries the reason
 * when there is one, and restates that nothing was sent to the employer so a
 * failure is never read as a half-finished submission.
 */
export function formatJobFinderBrowserHandoffFailedStatus(
  reason?: string | null,
): string {
  const detail = reason?.trim();
  const because = detail
    ? ` ${detail.endsWith(".") ? detail : `${detail}.`}`
    : "";

  return (
    `${JOB_FINDER_BROWSER_NAME_SENTENCE_START} did not open, so nothing was opened for this ` +
    `application and nothing was sent to the employer.${because} Try again, or open this step from Needs you.`
  );
}

/**
 * The prepare-only boundary in one sentence, for the prepare dialog and the
 * Applications hand-off. Job Finder fills; the person submits.
 */
export const PREPARE_ONLY_BOUNDARY_SENTENCE =
  "Job Finder opens the application and fills it in. It never submits — " +
  "reviewing and sending the application stays yours.";

/**
 * Identity line for the prepare dialog, so the user can see which job they
 * are agreeing to before they agree. Falls back gracefully when the employer
 * is not known rather than printing an absence placeholder.
 */
export function formatPrepareApplicationSubject(input: {
  jobTitle: string | null;
  employerName: string | null;
}): string | null {
  const title = input.jobTitle?.trim() ?? "";
  // Discovery stores a readable placeholder when a listing names no employer.
  // It is an absence, not a company, and rendering it here produced
  // "Senior Engineer at Employer not stated" in the dialog the user agrees to.
  // The same shared test every other job surface uses decides that, so the app
  // keeps one notion of "absent" rather than a second, divergent one.
  const rawEmployer = input.employerName?.trim() ?? "";
  const employer = isEmployerAbsenceLabel(rawEmployer) ? "" : rawEmployer;

  if (title && employer) {
    return `${title} at ${employer}`;
  }
  if (title) {
    return title;
  }
  if (employer) {
    return employer;
  }
  return null;
}

/**
 * What the prepare dialog promises will happen, named for the exact job. The
 * dialog previously said only "Use visual checkpoints?" and named neither the
 * job nor the employer, so there was nothing on screen identifying what was
 * being agreed to.
 */
export function formatPrepareApplicationDescription(
  subject: string | null,
): string {
  const opening = subject
    ? `Job Finder will open ${subject} in ${JOB_FINDER_BROWSER_NAME} and fill in the application with your approved resume.`
    : `Job Finder will open this application in ${JOB_FINDER_BROWSER_NAME} and fill it in with your approved resume.`;

  return `${opening} It stops before the employer's submit control — reviewing and sending the application stays yours.`;
}
