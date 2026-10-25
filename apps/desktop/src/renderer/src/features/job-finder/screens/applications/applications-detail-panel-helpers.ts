import type {
  ApplicationRecord,
  ApplicationPrivacyReceipt,
  ApplyRunDetails,
  ApplySubmitApproval,
  JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import {
  CONFIRM_STEP_DONE_ACTION,
  FINISH_IN_JOB_FINDER_BROWSER_INSTRUCTION,
  JOB_FINDER_BROWSER_NAME,
  JOB_FINDER_BROWSER_OPENED_STATUS,
  RUN_PREPARATION_AGAIN_ACTION,
} from "../../lib/job-finder-browser-handoff-copy";
import { formatApplicationEmployerAriaLabel } from "../../lib/job-employer-location-display";
import { formatStatusLabel } from "../../lib/job-finder-utils";
import {
  splitBlockedAttemptNote,
  TECHNICAL_DETAILS_LABEL,
} from "../../lib/describe-failure";

export { TECHNICAL_DETAILS_LABEL };

export type QueueEntry = {
  jobId: string;
  label: string;
  runResult:
    | JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]
    | null;
  includeInRecovery: boolean;
};

const ACTIONABLE_ANSWER_REQUEST_STATES = new Set([
  "pending",
  "page_opened",
  "awaiting_user",
  "verifying",
]);

/**
 * Finds the one manual-answer request the selected run can still continue.
 * A cancelled or older run for the same job must never leave an answer form
 * that saves successfully and then fails on Continue.
 */
export function findActionableApplicationAnswerRequest(input: {
  applicationRecordId: string;
  jobId: string;
  run: JobFinderRendererWorkspaceSnapshot["applyRuns"][number] | null;
  requests:
    | readonly JobFinderRendererWorkspaceSnapshot["userActionRequests"][number][]
    | undefined;
}) {
  const { applicationRecordId, jobId, run, requests } = input;
  if (
    !run ||
    run.state === "completed" ||
    run.state === "cancelled" ||
    run.state === "failed"
  ) {
    return null;
  }

  return (
    (requests ?? []).find(
      (request) =>
        request.kind === "manual_answer" &&
        ACTIONABLE_ANSWER_REQUEST_STATES.has(request.state) &&
        request.scope.type === "application" &&
        request.scope.runId === run.id &&
        request.scope.jobId === jobId &&
        (request.scope.applicationRecordId === applicationRecordId ||
          request.scope.applicationRecordId === null),
    ) ?? null
  );
}

const APPLY_TRANSPORT_LANGUAGE =
  /\b(?:post|xhr|xmlhttprequest|fetch|network request|mutating page action|prepare-only (?:safety )?guard)\b/i;

const SERVICE_WORKER_BLOCK_PATTERN = /service worker/i;

// "could not tell which control is safe" is the navigation pause: the page
// offered nothing Job Finder could press without risking a send. It ends the
// same way as a field conflict — the person opens the page and finishes the
// step — so it belongs on the same recovery path instead of being a dead end.
const MANUAL_FIELD_FINISH_PATTERN =
  /prefilled application values need manual review|conflicting (?:application )?fields|mismatched prefilled|could not safely save (?:a |this )?prepared (?:field|step)|complete the affected step manually|review the conflicting|finish (?:this |the )?application(?: step)? yourself|finish .+ manually in the open application|could not tell which control|choose the next application step manually|needs manual navigation|filled in what it could|questions? left for you|needs your answers? to \d+ questions?|open the browser and finish it/i;

/**
 * A prepare-only autosave / intermediate-write pause: the job site tried to
 * persist a field on its own and Job Finder had no authority for that write.
 * Nothing conflicted with the saved profile; the user simply finishes in the
 * open browser.
 */
const FIELD_SAVE_PAUSE_PATTERN =
  /could not safely save (?:a |this )?prepared (?:field|step)|did not have permission for that external save|tried to save .+ while it was being prepared|paused before the application field could be saved|intermediate[_ -]write|autosave|field[_ -]save/i;

const FIELD_CONFLICT_PATTERN =
  /prefilled application values need manual review|conflicting (?:application )?fields|mismatched prefilled|do not match the exact saved candidate profile|review the conflicting/i;

const BACKGROUND_PAGE_PAUSE_PATTERN =
  /blocked a background page request|blocked a form submission before your review/i;

export function applyResultIsBackgroundPagePause(
  result: JobFinderRendererWorkspaceSnapshot["applyJobResults"][number] | null,
): boolean {
  return Boolean(
    result && BACKGROUND_PAGE_PAUSE_PATTERN.test(getApplyResultCorpus(result)),
  );
}

export const BACKGROUND_PAGE_PAUSE_ACTION =
  "Open a fresh application page in the Job Finder browser. Review the fields and attach your approved resume there before sending it.";

const BACKGROUND_PAGE_PAUSE_REASON =
  "Job Finder could not continue preparing this page automatically. No application was sent.";

/** Plain-language next action when a job site blocks automatic preparation. */
export const SITE_BLOCKED_AUTOMATIC_PREP_NEXT_STEP = `This job site blocked automatic prep. Reset ${JOB_FINDER_BROWSER_NAME} in Safeguards, then finish the application on the site yourself.`;

/** Compact list-row next step for the same site-blocked pause. */
export const SITE_BLOCKED_AUTOMATIC_PREP_LIST_NEXT_STEP = `Open Safeguards to reset ${JOB_FINDER_BROWSER_NAME}, then finish on the site`;

export const SITE_BLOCKED_AUTOMATIC_PREP_GUIDANCE =
  SITE_BLOCKED_AUTOMATIC_PREP_NEXT_STEP;

/**
 * Detects site-blocked finish-yourself pauses from persisted application
 * record fields when the matching apply result is not in scope (list rows).
 */
export function applicationRecordLooksSiteBlocked(
  record: Pick<
    ApplicationRecord,
    "lastActionLabel" | "latestBlocker" | "nextActionLabel"
  >,
): boolean {
  const corpus = [
    record.nextActionLabel,
    record.lastActionLabel,
    record.latestBlocker?.summary,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ");

  return (
    SERVICE_WORKER_BLOCK_PATTERN.test(corpus) ||
    /job site blocked|inspect the application page manually|reset (?:the (?:job finder )?)?browser in safeguards/i.test(
      corpus,
    )
  );
}

/**
 * Plain-language next action when field conflicts or a blocked save need the
 * user. It names the window, says it is separate, and names the exact confirm
 * action they come back to — the round-eight review found the instruction
 * pointing at a window the user was never told existed.
 */
export const MANUAL_FIELD_FINISH_NEXT_STEP = `Review and fix the conflicting or unfinished fields in ${JOB_FINDER_BROWSER_NAME} — it opens right here in the app — then come back here and choose "${CONFIRM_STEP_DONE_ACTION}".`;

export const MANUAL_FIELD_FINISH_GUIDANCE = `${MANUAL_FIELD_FINISH_NEXT_STEP} Use "${RUN_PREPARATION_AGAIN_ACTION}" only if you want a fresh run after that.`;

/** One-line reason shown directly under the Next step heading for field conflicts. */
export const MANUAL_FIELD_CONFLICT_REASON =
  "Some prefilled values on the job site do not match your saved profile.";

/** One-line reason shown directly under the Next step heading for an autosave pause. */
export const FIELD_SAVE_PAUSE_REASON =
  "The job site tried to save a field automatically. Job Finder stopped to keep everything in your hands.";

/** The action that follows the autosave-pause reason. */
export const FIELD_SAVE_PAUSE_ACTION = FINISH_IN_JOB_FINDER_BROWSER_INSTRUCTION;

/**
 * One event, one cause. The runtime's own wording ("the page could not safely
 * save a prepared field") reads as a site failure, while Next step says the
 * site acted and Job Finder stopped it — and the blocker code renders as
 * "Requires manual review", a third phrasing. These two short labels keep the
 * fact strip on the exact story Next step tells.
 */
export const FIELD_SAVE_PAUSE_CAUSE =
  "The job site tried to save a field automatically";

export const FIELD_SAVE_PAUSE_ACTIVITY = "Job Finder stopped before that save";

/** Plain-language next action when the job site tried an automatic field save. */
export const FIELD_SAVE_PAUSE_NEXT_STEP = `${FIELD_SAVE_PAUSE_REASON} ${FINISH_IN_JOB_FINDER_BROWSER_INSTRUCTION}`;

export const FIELD_SAVE_PAUSE_GUIDANCE = `${FIELD_SAVE_PAUSE_NEXT_STEP} Use "${RUN_PREPARATION_AGAIN_ACTION}" only if you want a fresh run after that.`;

/**
 * Local status beside the action after the Job Finder browser was asked to show
 * the application page. The shell banner already confirms that the page
 * opened and where it went, so this line says what is true now rather than
 * restating the same sentence a second way.
 */
export const FINISH_IN_BROWSER_OPENED_STATUS = JOB_FINDER_BROWSER_OPENED_STATUS;

function getApplyResultCorpus(
  result: JobFinderRendererWorkspaceSnapshot["applyJobResults"][number],
): string {
  return [result.summary, result.detail, result.blockerSummary]
    .filter(Boolean)
    .join(" ");
}

/**
 * True only for the autosave / intermediate-write pause. Field conflicts
 * with the saved profile keep the existing conflicting-fields copy.
 */
export function applyResultIsFieldSavePause(
  result: JobFinderRendererWorkspaceSnapshot["applyJobResults"][number] | null,
): boolean {
  if (!result || !applyResultNeedsManualFieldFinish(result)) {
    return false;
  }

  const corpus = getApplyResultCorpus(result);
  if (FIELD_CONFLICT_PATTERN.test(corpus)) {
    return false;
  }

  return FIELD_SAVE_PAUSE_PATTERN.test(corpus);
}

/** One-line reason for a manual-finish pause, or null when not a manual finish. */
export function getManualFieldFinishReason(
  result: JobFinderRendererWorkspaceSnapshot["applyJobResults"][number] | null,
): string | null {
  if (!applyResultNeedsManualFieldFinish(result)) {
    return null;
  }

  if (applyResultIsBackgroundPagePause(result)) {
    return BACKGROUND_PAGE_PAUSE_REASON;
  }

  return applyResultIsFieldSavePause(result)
    ? FIELD_SAVE_PAUSE_REASON
    : MANUAL_FIELD_CONFLICT_REASON;
}

export function getManualFieldFinishNextStep(
  result: JobFinderRendererWorkspaceSnapshot["applyJobResults"][number] | null,
): string {
  if (applyResultIsBackgroundPagePause(result)) {
    return `${BACKGROUND_PAGE_PAUSE_REASON} ${BACKGROUND_PAGE_PAUSE_ACTION}`;
  }
  return applyResultIsFieldSavePause(result)
    ? FIELD_SAVE_PAUSE_NEXT_STEP
    : MANUAL_FIELD_FINISH_NEXT_STEP;
}

export function getManualFieldFinishGuidance(
  result: JobFinderRendererWorkspaceSnapshot["applyJobResults"][number] | null,
): string {
  if (applyResultIsBackgroundPagePause(result)) {
    return getManualFieldFinishNextStep(result);
  }
  return applyResultIsFieldSavePause(result)
    ? FIELD_SAVE_PAUSE_GUIDANCE
    : MANUAL_FIELD_FINISH_GUIDANCE;
}

/**
 * Query-free application destination recorded in the privacy receipt, or null
 * when the run never reached an employer page.
 */
export function getApplyResultDestinationUrl(
  receipt: ApplicationPrivacyReceipt | null | undefined,
): string | null {
  const destination = receipt?.destination;
  if (!destination?.origin) {
    return null;
  }

  try {
    return new URL(destination.safePath || "/", destination.origin).toString();
  } catch {
    return null;
  }
}

const APPLY_RUN_STATE_LABELS: Partial<
  Record<
    JobFinderRendererWorkspaceSnapshot["applyRuns"][number]["state"],
    string
  >
> = {
  paused_for_user_review: "Paused for your review",
  paused_for_consent: "Paused — needs something from you",
  awaiting_submit_approval: "Waiting for preparation approval",
};

const APPLY_RUN_MODE_LABELS: Partial<
  Record<
    JobFinderRendererWorkspaceSnapshot["applyRuns"][number]["mode"],
    string
  >
> = {
  // "Guided preparation" is a name used nowhere else in the product; every
  // other surface says preparation or "Fill it in".
  copilot: "Preparation",
  single_job_auto: "Automatic preparation",
  queue_auto: "Automatic preparation (several jobs)",
};

/** Sentence-case run state for people instead of a title-cased status code. */
export function formatApplyRunStateLabel(
  state: JobFinderRendererWorkspaceSnapshot["applyRuns"][number]["state"],
): string {
  return APPLY_RUN_STATE_LABELS[state] ?? formatStatusLabel(state);
}

/** Sentence-case run mode for people instead of a title-cased mode code. */
export function formatApplyRunModeLabel(
  mode: JobFinderRendererWorkspaceSnapshot["applyRuns"][number]["mode"],
): string {
  return APPLY_RUN_MODE_LABELS[mode] ?? formatStatusLabel(mode);
}

const EXTERNAL_WRITE_CATEGORY_LABELS: Record<
  ApplicationPrivacyReceipt["externalWrites"][number]["category"],
  string
> = {
  resume_attachment: "a resume attachment",
  profile_field: "profile fields",
  application_answer: "application answers",
  consent_control: "consent choices",
  other: "other prepared fields",
};

export function getVerifiedExternalWriteRecoveryText(
  receipt: ApplicationPrivacyReceipt | null | undefined,
): string {
  const verifiedCategories = [
    ...new Set(
      (receipt?.externalWrites ?? [])
        .filter((write) => write.verified)
        .map((write) => EXTERNAL_WRITE_CATEGORY_LABELS[write.category]),
    ),
  ];

  if (verifiedCategories.length === 0) {
    return "Nothing was written to the employer page in this run.";
  }

  return `Job Finder filled ${verifiedCategories.join(", ")} on the employer page. Check the page to see what the site kept.`;
}

/**
 * The recorded blocked-attempt line ("Blocked: xhr POST https://…") that the
 * runtime appends to a stop's detail. It is deliberate evidence and stays in
 * the record; every visible surface leads with the plain sentence and offers
 * this behind a {@link TECHNICAL_DETAILS_LABEL} disclosure instead.
 */
export function getApplyBlockedAttemptDetail(
  value: string | null | undefined,
): string | null {
  return splitBlockedAttemptNote(value).technicalDetails;
}

export function getCustomerFacingApplyText(
  value: string | null | undefined,
  /**
   * Kept for call-site compatibility. The recovery text it used to be stitched
   * into is gone: a stop reason is one sentence, not a paragraph of write
   * bookkeeping.
   */
  receipt?: ApplicationPrivacyReceipt | null,
): string | null {
  void receipt;
  const text = splitBlockedAttemptNote(value).message?.replace(
    /from chosen on the form(?! by Job Finder)/giu,
    "from a choice Job Finder made on the form",
  );
  if (!text) {
    return null;
  }

  if (SERVICE_WORKER_BLOCK_PATTERN.test(text)) {
    return SITE_BLOCKED_AUTOMATIC_PREP_NEXT_STEP;
  }

  if (!APPLY_TRANSPORT_LANGUAGE.test(text)) {
    return text;
  }

  // One sentence, said once. These used to be four stitched together — write
  // bookkeeping, a retry instruction, a no-submit reassurance and a "report
  // this" aside — and the whole paragraph was then printed again in the fact
  // strip under a different label.
  if (/\b(?:resume|cv|attachment|upload)\b/i.test(text)) {
    return "The resume file could not be attached.";
  }

  return "The application page would not keep what Job Finder filled in.";
}

export function applyResultNeedsResumeAttachment(
  result: JobFinderRendererWorkspaceSnapshot["applyJobResults"][number] | null,
): boolean {
  if (!result) {
    return false;
  }

  if (
    result.state === "blocked" ||
    result.state === "failed" ||
    // The real-CV guard can stop at review with a required human decision;
    // those results must still offer the CV-specific approve/retry CTA.
    (result.state === "awaiting_review" &&
      result.blockerReason === "required_human_input")
  ) {
    const text = [result.summary, result.detail, result.blockerSummary]
      .filter(Boolean)
      .join(" ");
    return (
      (/\b(?:resume|cv)\b/i.test(text) ||
        (Boolean(result.privacyReceipt?.resume?.fileName) &&
          /upload.*(?:pdf|docx|format)/i.test(text))) &&
      /\b(?:not attached|attach(?:ment)? needs|could not be attached|retry.*attach|upload.*failed|rejected|not accepted|unsupported (?:file|format)|upload a nonempty)\b/i.test(
        text,
      )
    );
  }

  return false;
}

export function applyResultIsServiceWorkerBlocked(
  result: JobFinderRendererWorkspaceSnapshot["applyJobResults"][number] | null,
): boolean {
  if (!result) {
    return false;
  }

  return SERVICE_WORKER_BLOCK_PATTERN.test(
    [result.summary, result.detail, result.blockerSummary]
      .filter(Boolean)
      .join(" "),
  );
}

/**
 * Paused because fields conflict with the saved profile or a prepare-only save
 * stopped for manual finish — not a site-block, and not a resume-attachment
 * retry path where preparation is still the right primary action.
 */
export function applyResultNeedsManualFieldFinish(
  result: JobFinderRendererWorkspaceSnapshot["applyJobResults"][number] | null,
): boolean {
  if (!result) {
    return false;
  }

  if (
    applyResultIsServiceWorkerBlocked(result) ||
    applyResultNeedsResumeAttachment(result)
  ) {
    return false;
  }

  return (
    applyResultIsBackgroundPagePause(result) ||
    MANUAL_FIELD_FINISH_PATTERN.test(
      [result.summary, result.detail, result.blockerSummary]
        .filter(Boolean)
        .join(" "),
    )
  );
}

/**
 * When preparation is paused or blocked and the user must act, recovery is the
 * primary Applications action — cover letters and other optional docs demote.
 */
export function applicationNeedsPrimaryRecovery(input: {
  lastAttemptState: ApplicationRecord["lastAttemptState"] | null | undefined;
  visibleApplyResult:
    | JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]
    | null;
}): boolean {
  const { lastAttemptState, visibleApplyResult } = input;

  if (applyResultIsServiceWorkerBlocked(visibleApplyResult)) {
    return true;
  }

  if (applyResultNeedsManualFieldFinish(visibleApplyResult)) {
    return true;
  }

  if (
    lastAttemptState === "paused" ||
    lastAttemptState === "failed" ||
    lastAttemptState === "cancelled" ||
    lastAttemptState === "unsupported"
  ) {
    return true;
  }

  const state = visibleApplyResult?.state;
  return (
    state === "blocked" ||
    state === "failed" ||
    state === "skipped" ||
    state === "cancelled"
  );
}

/**
 * A job of an apply run that "Prepare remaining jobs" would target.
 *
 * Applications and the Tasks card must offer that action on the same
 * evidence, so both read this one predicate rather than each listing the
 * unfinished result states for themselves.
 */
export function applyRunJobNeedsPreparation(
  runResult:
    | JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]
    | null
    | undefined,
): boolean {
  if (runResult?.state === "cancelled") return false;
  return (
    !runResult ||
    runResult.applicationRecordId === null ||
    runResult.state === "planned" ||
    runResult.state === "blocked" ||
    runResult.state === "failed" ||
    runResult.state === "skipped"
  );
}

export function buildQueueEntries(input: {
  applicationRecords: readonly ApplicationRecord[];
  applyJobResults: JobFinderRendererWorkspaceSnapshot["applyJobResults"];
  discoveryJobs: JobFinderRendererWorkspaceSnapshot["discoveryJobs"];
  selectedRun: JobFinderRendererWorkspaceSnapshot["applyRuns"][number] | null;
}): QueueEntry[] {
  const { applicationRecords, applyJobResults, discoveryJobs, selectedRun } =
    input;

  if (!selectedRun) {
    return [];
  }

  const selectedRunResults = applyJobResults.filter(
    (result) => result.runId === selectedRun.id,
  );
  const discoveryJobsById = new Map(
    discoveryJobs.map((job) => [job.id, job] as const),
  );

  return selectedRun.jobIds.map((jobId) => {
    const matchingResults = selectedRunResults.filter(
      (result) => result.jobId === jobId,
    );
    const runResult = matchingResults.length === 1 ? matchingResults[0]! : null;
    const relatedRecord = runResult?.applicationRecordId
      ? (applicationRecords.find(
          (record) => record.id === runResult.applicationRecordId,
        ) ?? null)
      : null;
    const relatedJobListRow = discoveryJobsById.get(jobId) ?? null;
    const includeInRecovery = applyRunJobNeedsPreparation(runResult);

    return {
      jobId,
      label: relatedRecord
        ? formatApplicationEmployerAriaLabel({
            title: relatedRecord.title,
            company: relatedRecord.company,
            ...(relatedJobListRow?.canonicalUrl
              ? { canonicalUrl: relatedJobListRow.canonicalUrl }
              : {}),
          })
        : relatedJobListRow
          ? formatApplicationEmployerAriaLabel({
              title: relatedJobListRow.title,
              company: relatedJobListRow.company,
              canonicalUrl: relatedJobListRow.canonicalUrl,
            })
          : jobId,
      runResult,
      includeInRecovery,
    };
  });
}

export function getApplyDetailsStatusBadge(
  status: "idle" | "loading" | "ready" | "error",
) {
  switch (status) {
    case "loading":
      return { tone: "active" as const, label: "Loading details" };
    case "error":
      return { tone: "critical" as const, label: "Details unavailable" };
    case "ready":
      return { tone: "positive" as const, label: "Details ready" };
    default:
      return { tone: "muted" as const, label: "Details idle" };
  }
}

export function getQueueRecoveryTone(
  state:
    | JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]["state"]
    | null,
) {
  if (state === "awaiting_review" || state === "submitted") {
    return "positive" as const;
  }

  if (
    state === "blocked" ||
    state === "failed" ||
    state === "skipped" ||
    state === "cancelled"
  ) {
    return "critical" as const;
  }

  if (state === "planned") {
    return "muted" as const;
  }

  return "active" as const;
}

export function getQueueStateExplanation(
  input: {
    runState: JobFinderRendererWorkspaceSnapshot["applyRuns"][number]["state"];
    selectedJobCount: number;
    blockedJobCount: number;
    skippedJobCount: number;
    failedJobCount: number;
    completedJobCount: number;
    waitingJobCount?: number;
    unfinishedJobCount: number;
    stopReason?: string | null;
  } | null,
) {
  if (!input) {
    return null;
  }

  if (input.runState === "running") {
    return "This run is still working through its jobs. Progress and outcomes update here as each application finishes.";
  }

  if ((input.waitingJobCount ?? 0) > 0) {
    return `${input.completedJobCount} sent. ${input.waitingJobCount} ${input.waitingJobCount === 1 ? "application needs" : "applications need"} your answers or review. Open each waiting application to continue.`;
  }

  if (input.runState === "paused_for_consent") {
    return "This application is paused until you deal with the item below — often signing in on the job site. Handle it in Needs you, then Job Finder carries on. You can also start again on just the jobs that stopped.";
  }

  // A stop-rule pause holds no pending decision to resolve, so the run can
  // never resume; finishing the remaining jobs requires a fresh recovery run.
  if (input.runState === "paused_for_user_review") {
    return input.unfinishedJobCount > 0
      ? `${input.stopReason?.trim() || "A safety limit paused this run."} It will not carry on by itself. Open Safeguards to see the limit, then press Try again on an unstarted job when the limit allows it.`
      : `${input.stopReason?.trim() || "A safety limit paused this run."} It will not carry on by itself. Review each job's outcome.`;
  }

  if (input.runState === "awaiting_submit_approval") {
    return "This has not started yet. Approve it to start the applications in the chosen apply mode, or pick a shorter list of jobs first.";
  }

  if (input.runState === "cancelled") {
    return "You stopped this before it finished. The jobs it did not get to can be prepared again whenever you want.";
  }

  if (input.failedJobCount > 0) {
    return "Some applications could not be prepared. Check each job below before trying again.";
  }

  if (input.blockedJobCount > 0 || input.skippedJobCount > 0) {
    return "This historical run hit blocked or skipped jobs. Applications keeps those outcomes and can prepare only the unfinished jobs without repeating completed work.";
  }

  if (input.completedJobCount === input.selectedJobCount) {
    return "Every job in this run already reached a review-ready or final outcome.";
  }

  return "This run still has unfinished jobs. Review the per-job outcomes below before deciding whether to prepare the remaining work.";
}

export function formatVisibleRunId(runId: string): string {
  return runId.length <= 8 ? runId : runId.slice(-8);
}

export function getAnswerTone(
  status: ApplyRunDetails["answerRecords"][number]["status"],
) {
  switch (status) {
    case "filled":
    case "submitted":
      return "positive" as const;
    case "rejected":
      return "critical" as const;
    // Skipped is something the run left for later, not a failure.
    case "skipped":
      return "warning" as const;
    default:
      return "active" as const;
  }
}

export function getConsentTone(
  status: ApplyRunDetails["consentRequests"][number]["status"],
) {
  switch (status) {
    case "approved":
      return "positive" as const;
    case "declined":
    case "expired":
      return "critical" as const;
    default:
      return "active" as const;
  }
}

export function getApprovalTone(status: ApplySubmitApproval["status"]) {
  switch (status) {
    case "approved":
      return "positive" as const;
    case "declined":
    case "revoked":
    case "expired":
      return "critical" as const;
    default:
      return "active" as const;
  }
}
