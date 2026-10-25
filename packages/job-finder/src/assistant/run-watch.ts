import type {
  AssistantRunRef,
  JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";

import { isApplicationTrackedAsSentByPerson } from "@nestor/contracts";

import { allJobs } from "./tools/format";

/**
 * Whether a background run a conversation waits on has ended, and what the
 * model is told about it. Read from the workspace, never from the model.
 */
export interface RunStatus {
  done: boolean;
  summary: string;
  details: unknown;
  /** The current application leg needs the person; keep following its run. */
  pendingHandoffKey?: string;
  /** Changes when the application's saved outcome actually changes. */
  resultKey?: string;
}

const APPLY_TERMINAL_STATES = new Set(["completed", "cancelled", "failed"]);

export function readRunStatus(
  snapshot: JobFinderWorkspaceSnapshot,
  run: AssistantRunRef,
): RunStatus {
  if (run.kind === "apply_queue") {
    const queue = snapshot.applyQueue;
    if (!queue || queue.id !== run.id) return { done: true, summary: "The Apply queue is no longer active.", details: null };
    return {
      done: queue.state === "done" || queue.state === "stopped",
      summary: `Apply queue ${queue.state.replaceAll("_", " ")}: ${queue.startedJobIds.length} started, ${queue.skipped.length} held back, ${queue.jobIds.length} chosen.${queue.pausedReason ? ` ${queue.pausedReason}` : ""}`,
      details: { state: queue.state, startedJobIds: queue.startedJobIds, skipped: queue.skipped },
    };
  }
  if (run.kind === "discovery") {
    // Searches run on the job store now; search_status reports them.
    return {
      done: true,
      summary: "Searches report through search_status.",
      details: null,
    };
  }
  if (run.kind === "apply_batch" || run.kind === "apply_run") {
    const record =
      snapshot.applyRuns.find((entry) => entry.id === run.id) ?? null;
    if (!record) {
      return {
        done: true,
        summary: `The application batch ${run.id} is no longer recorded.`,
        details: null,
      };
    }
    const results = snapshot.applyJobResults.filter(
      (result) => result.runId === run.id,
    );
    // An answer given to a Needs you step is still being put on the form:
    // the run has not ended yet, whatever its own state says. Reporting it
    // as ended then read as "it stopped again on the same question".
    const answerBeingApplied = (snapshot.userActionRequests ?? []).some(
      (request) =>
        request.state === "verifying" &&
        request.scope.type === "application" &&
        request.scope.runId === run.id,
    );
    const stillWorking =
      answerBeingApplied ||
      results.some((result) =>
        ["planned", "question_capture", "filling", "submitting"].includes(
          result.state,
        ),
      );
    const done =
      !stillWorking &&
      (APPLY_TERMINAL_STATES.has(record.state) ||
        (results.length > 0 && record.state !== "running"));
    if (!done) {
      return {
        done: false,
        summary: "Applications in progress.",
        details: null,
      };
    }
    const sendState = (result: (typeof results)[number]) => {
      const application = snapshot.applicationRecords?.find(
        (record) => record.jobId === result.jobId,
      );
      if (application?.personSendReceipt) return "submitted";
      if (isApplicationTrackedAsSentByPerson(application?.crm))
        return "marked sent by you";
      if (
        result.privacyReceipt?.submissionOutcome?.outcome ===
        "outcome_uncertain"
      )
        return "send unconfirmed";
      if (
        result.state === "submitted" &&
        result.privacyReceipt?.finalSubmitOccurred !== true
      )
        return "not confirmed";
      return result.state;
    };
    const byState = new Map<string, number>();
    for (const result of results) {
      const state = sendState(result);
      byState.set(state, (byState.get(state) ?? 0) + 1);
    }
    const pendingSteps =
      APPLY_TERMINAL_STATES.has(record.state) && record.state !== "completed"
        ? []
        : (snapshot.userActionRequests ?? []).filter((request) => {
            const scope = request.scope;
            return (
              scope.type === "application" &&
              scope.runId === run.id &&
              [
                "pending",
                "page_opened",
                "awaiting_user",
                "still_blocked",
              ].includes(request.state) &&
              results.some(
                (result) =>
                  result.jobId === scope.jobId &&
                  ["awaiting_review", "blocked"].includes(result.state),
              )
            );
          });
    const resultKey = JSON.stringify([
      record.state,
      results
        .map((result) => [
          result.jobId,
          result.state,
          result.blockerSummary,
          result.privacyReceipt?.submissionOutcome?.outcome ?? null,
        ])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    ]);
    return {
      done: true,
      summary: `The application batch ${pendingSteps.length ? "is waiting on the person" : "ended"} (${[...byState.entries()].map(([state, count]) => `${count} ${state.replaceAll("_", " ")}`).join(", ") || record.state}).`,
      resultKey,
      ...(pendingSteps.length
        ? {
            pendingHandoffKey: pendingSteps
              .map((request) => request.id)
              .sort()
              .join("|"),
          }
        : {}),
      details: {
        runId: record.id,
        state: record.state,
        results: results.map((result) => {
          const job = allJobs(snapshot).find(
            (entry) => entry.id === result.jobId,
          );
          return {
            jobId: result.jobId,
            title: job ? `${job.title} at ${job.company}` : null,
            // The address the application actually used, so the reply
            // names the real site.
            appliedOn: job?.applicationUrl ?? job?.canonicalUrl ?? null,
            state:
              sendState(result) === "not confirmed"
                ? "not_confirmed"
                : sendState(result),
            summary:
              sendState(result) === "not confirmed"
                ? "No receipt confirms this send."
                : result.summary,
            recovery:
              result.privacyReceipt?.submissionOutcome?.outcome ===
              "outcome_uncertain"
                ? "The send was attempted, but the site did not confirm receipt. Check the site and ask the person to record the outcome. Do not send again or change sending settings."
                : null,
            sendPermission:
              result.privacyReceipt?.submissionOutcome?.outcome ===
              "outcome_uncertain"
                ? "blocked_until_person_checks_outcome"
                : null,
            detail: result.detail,
            outcome: result.privacyReceipt?.submissionOutcome?.outcome ?? null,
            blocker: result.blockerSummary ?? null,
          };
        }),
        pendingSteps: pendingSteps.map((request) => ({
          id: request.id,
          kind: request.kind,
          title: request.title,
        })),
      },
    };
  }
  const running = snapshot.recentSourceDebugRuns.find(
    (entry) => entry.id === run.id,
  );
  return {
    done: !running || running.state !== "running",
    summary: running
      ? `The source check ${running.state}.`
      : "The source check ended.",
    details: null,
  };
}
