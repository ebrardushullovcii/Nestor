import { hasVerifiedApplicationSubmission } from "./workspace-apply-run-support";
import { reduceUserActionCommand } from "../user-action-domain";
import type { BrowserSessionRuntime } from "@nordri/browser-runtime";
import {
  ApplicationAttemptSchema,
  ApplicationRecordSchema,
  type ApplyJobResult,
  type JobSource,
} from "@nordri/contracts";
import type { JobFinderRepository } from "@nordri/db";

// Page cleanup is best effort: a tab that will not close must never turn a
// finished application, or the error that ended it, into a different result.

/** Replacement attempts inherit the exact application's live form, never a URL match. */
export async function reuseApplicationPage(
  input: Parameters<typeof transferApplicationPage>[0],
): Promise<void> {
  await transferApplicationPage(input).catch(() => undefined);
}

async function transferApplicationPage(input: {
  repository: JobFinderRepository;
  browserRuntime: BrowserSessionRuntime;
  source: JobSource;
  applicationRecordId: string;
  resultId: string;
}): Promise<void> {
  if (!input.browserRuntime.transferApplicationPageBinding) return;
  const results = await input.repository.listApplyJobResults({
    applicationRecordId: input.applicationRecordId,
  });
  const latest = [...results]
    .filter((result) => result.id !== input.resultId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (latest?.reviewCard?.letter?.needsRefresh) {
    // The letter may be on an earlier wizard step. A fresh form must receive
    // the approved revision instead of inheriting that stale attachment.
    await input.browserRuntime.releaseApplicationPageBinding?.(
      input.source,
      latest.id,
    );
    return;
  }
  for (const result of [...results].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )) {
    if (result.id === input.resultId || result.state === "submitted") continue;
    if (
      await input.browserRuntime.transferApplicationPageBinding(
        input.source,
        result.id,
        input.resultId,
      )
    )
      return;
  }
}

/** Releases only the requested results; review and resumable blockers stay live. */
export async function releaseFinishedApplicationPages(
  input: Parameters<typeof releaseApplicationPages>[0],
): Promise<void> {
  await releaseApplicationPages(input).catch(() => undefined);
}

async function releaseApplicationPages(input: {
  repository: JobFinderRepository;
  browserRuntime: BrowserSessionRuntime;
  runId?: string;
  jobId?: string;
  applicationRecordId?: string;
  removed?: boolean;
}): Promise<void> {
  if (!input.browserRuntime.releaseApplicationPageBinding) return;
  const results = await input.repository.listApplyJobResults({
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.applicationRecordId
      ? { applicationRecordId: input.applicationRecordId }
      : {}),
  });
  if (results.length === 0) return;
  const [jobs, runs] = await Promise.all([
    input.repository.listSavedJobsByIds([
      ...new Set(results.map((result) => result.jobId)),
    ]),
    input.repository.listApplyRuns(
      input.runId ? { id: input.runId } : undefined,
    ),
  ]);
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  for (const result of results) {
    const job = jobsById.get(result.jobId);
    const run = runsById.get(result.runId);
    const unfinishedInTerminalRun =
      (run?.state === "cancelled" || run?.state === "failed") &&
      ["planned", "question_capture", "filling", "submitting"].includes(
        result.state,
      );
    if (
      unfinishedInTerminalRun ||
      input.removed ||
      !job ||
      job.status === "archived" ||
      ["submitted", "skipped", "cancelled", "failed"].includes(result.state)
    ) {
      await input.browserRuntime
        .releaseApplicationPageBinding(job?.source ?? "target_site", result.id)
        .catch(() => undefined);
    }
  }
}

/** Prepared forms are in memory; none of these states survives without its exact page. */
export function isUnsentPreparedApplication(result: ApplyJobResult): boolean {
  return (
    (result.state === "awaiting_review" ||
      (result.state === "blocked" &&
        (result.privacyReceipt !== null ||
          result.reviewCard !== null ||
          [
            "auth_required",
            "signup_consent_required",
            "site_protection",
            "required_human_input",
          ].includes(result.blockerReason ?? "")))) &&
    result.applicationRecordId !== null &&
    result.privacyReceipt?.finalSubmitOccurred !== true &&
    result.privacyReceipt?.submissionOutcome?.outcome !== "submitted" &&
    result.privacyReceipt?.submissionOutcome?.outcome !== "outcome_uncertain" &&
    result.blockerReason !== "submission_outcome_uncertain"
  );
}

/** Retire stale controls but retain questions, answers and attachments for re-preparation. */
export async function retireLostPreparedApplication(input: {
  repository: JobFinderRepository;
  applicationRecordId: string;
  resultId: string;
  occurredAt: string;
}): Promise<void> {
  const results = await input.repository.listApplyJobResults({
    applicationRecordId: input.applicationRecordId,
  });
  if (results.some(hasVerifiedApplicationSubmission)) return;
  const records = await input.repository.listApplicationRecords();
  const record = records.find(
    (entry) => entry.id === input.applicationRecordId,
  );
  if (record?.lastAttemptState === "failed") {
    await input.repository.upsertApplicationRecord(
      ApplicationRecordSchema.parse({
        ...record,
        nextActionLabel: "Prepare again",
      }),
    );
  }
  const requests = await input.repository.listUserActionRequests({
    scopeType: "application",
  });
  for (const request of requests) {
    if (
      request.scope.type !== "application" ||
      request.scope.resultId !== input.resultId ||
      !["pending", "page_opened", "awaiting_user", "still_blocked"].includes(
        request.state,
      )
    )
      continue;
    const retired = reduceUserActionCommand(
      request,
      {
        requestId: request.id,
        commandId: `lost_page_${input.resultId}_${request.id}`,
        expectedRevision: request.revision,
        action: "cancel",
        reason:
          "The prepared page is no longer open. Prepare this application again.",
        credentialsPolicy: "browser_only",
        submitAuthorized: false,
        accountCreationAuthorized: false,
      },
      input.occurredAt,
    );
    if (retired.status === "applied")
      await input.repository.commitUserActionTransition({
        request: retired.request,
        event: retired.event,
      });
  }
  const attempts = await input.repository.listApplicationAttempts();
  for (const attempt of attempts) {
    if (
      attempt.applicationRecordId !== input.applicationRecordId ||
      attempt.userActionResumption?.resultId !== input.resultId ||
      !["paused", "ready"].includes(attempt.state)
    )
      continue;
    await input.repository.upsertApplicationAttempt(
      ApplicationAttemptSchema.parse({
        ...attempt,
        state: "failed",
        completedAt: input.occurredAt,
        summary: "The prepared page is no longer open.",
        nextActionLabel: "Prepare again",
      }),
    );
  }
}
