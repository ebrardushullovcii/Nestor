import {
  APPLICATION_SENT_CANNOT_MOVE_BACK_MESSAGE,
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  isApplicationRecordSent,
  isApplicationReturnedToShortlist,
  type ApplicationRecord,
  type ApplyJobResult,
  type JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";
import { retireLostPreparedApplication } from "./application-page-lifecycle";
import {
  hasVerifiedApplicationSubmission,
  reconcileApplyRunAfterConfirmedSubmission,
} from "./workspace-apply-run-support";
import type { WorkspaceServiceContext } from "./workspace-service-context";

const RETURNED_SUMMARY = "Moved back to Shortlisted. Nothing was sent.";

/** States where a browser may be typing into the form right now. */
const WORKING_RESULT_STATES = new Set<ApplyJobResult["state"]>([
  "question_capture",
  "filling",
  "submitting",
]);

/** States that still hold a prepared form or a place in a run. */
const OPEN_RESULT_STATES = new Set<ApplyJobResult["state"]>([
  "planned",
  "awaiting_review",
  "blocked",
]);

function mayHaveBeenSent(result: ApplyJobResult): boolean {
  return (
    result.state === "submitted" ||
    hasVerifiedApplicationSubmission(result) ||
    result.privacyReceipt?.finalSubmitOccurred === true ||
    result.privacyReceipt?.submissionOutcome?.outcome === "outcome_uncertain" ||
    result.blockerReason === "submission_outcome_uncertain"
  );
}

/**
 * Applications -> Shortlisted for an application nothing was sent for. The
 * prepared form is released the way hiding a job releases it, its open
 * results end as skipped (so a later restart has nothing to recover and a
 * parked run does not wait on it), and the record is marked so Applications
 * leaves it out until the next Apply writes to it. Nothing is sent or
 * prepared again; events, answers and receipts stay.
 */
export function createReturnToShortlistMethods(input: {
  ctx: WorkspaceServiceContext;
  withApplyRunTransition: <T>(
    runId: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  withExactApplicationRecordTransition: <T>(
    applicationRecordId: string,
    jobId: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
}) {
  const { ctx } = input;

  async function readRecord(
    applicationRecordId: string,
  ): Promise<ApplicationRecord> {
    const record = (await ctx.repository.listApplicationRecords()).find(
      (entry) => entry.id === applicationRecordId,
    );
    if (!record)
      throw new Error("This application is no longer saved. Refresh the list.");
    return record;
  }

  return {
    async returnApplicationToShortlist(
      applicationRecordId: string,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const record = await readRecord(applicationRecordId);
      const results = await ctx.repository.listApplyJobResults({
        applicationRecordId,
      });
      if (isApplicationRecordSent(record) || results.some(mayHaveBeenSent))
        throw new Error(APPLICATION_SENT_CANNOT_MOVE_BACK_MESSAGE);
      if (
        record.lastAttemptState === "in_progress" ||
        results.some(
          (result) =>
            WORKING_RESULT_STATES.has(result.state) ||
            (result.state === "planned" &&
              ctx.activeApplyRunPromises.has(result.runId)),
        )
      )
        throw new Error(
          "Job Finder is filling this application in right now. Stop it first, then move it back.",
        );

      const occurredAt = new Date().toISOString();
      const job = (await ctx.repository.listSavedJobsByIds([record.jobId]))[0];
      for (const result of results) {
        if (!OPEN_RESULT_STATES.has(result.state)) continue;
        // Best effort, like hiding a job: a tab that will not close must
        // not keep the application in a list the person moved it out of.
        await ctx.browserRuntime
          .releaseApplicationPageBinding?.(
            job?.source ?? "target_site",
            result.id,
          )
          .catch(() => undefined);
        await input.withApplyRunTransition(result.runId, async () => {
          const [runs, runResults] = await Promise.all([
            ctx.repository.listApplyRuns({ id: result.runId }),
            ctx.repository.listApplyJobResults({ runId: result.runId }),
          ]);
          const current = runResults.find((entry) => entry.id === result.id);
          if (!current || !OPEN_RESULT_STATES.has(current.state)) return;
          const skipped = ApplyJobResultSchema.parse({
            ...current,
            state: "skipped",
            summary: RETURNED_SUMMARY,
            detail:
              "You moved this job back to Shortlisted. Its form was closed and nothing was sent.",
            updatedAt: occurredAt,
            completedAt: occurredAt,
          });
          await ctx.repository.upsertApplyJobResult(skipped);
          const run = runs.find((entry) => entry.id === result.runId);
          if (
            !run ||
            run.state === "completed" ||
            run.state === "cancelled" ||
            run.state === "failed"
          )
            return;
          await ctx.repository.upsertApplyRun(
            ApplyRunSchema.parse(
              reconcileApplyRunAfterConfirmedSubmission({
                run,
                results: runResults.map((entry) =>
                  entry.id === skipped.id ? skipped : entry,
                ),
                submittedAt: occurredAt,
                submittedSummary: "A job was moved back to Shortlisted",
                submittedDetail:
                  "Nothing was sent for it. Other jobs keep their own state.",
              }),
            ),
          );
        });
        // Sign-in, answer and resume steps waiting on that form close too.
        await retireLostPreparedApplication({
          repository: ctx.repository,
          applicationRecordId,
          resultId: result.id,
          occurredAt,
        });
      }

      await input.withExactApplicationRecordTransition(
        applicationRecordId,
        record.jobId,
        async () => {
          const latest = await readRecord(applicationRecordId);
          await ctx.repository.upsertApplicationRecord(
            ApplicationRecordSchema.parse({
              ...latest,
              lastAttemptState:
                latest.lastAttemptState === null ? null : "cancelled",
              latestBlocker: null,
              lastActionLabel: RETURNED_SUMMARY,
              nextActionLabel:
                "Press Apply on it in Shortlisted to start again.",
              lastUpdatedAt: occurredAt,
              returnedToShortlistAt: occurredAt,
              events: [
                ...latest.events,
                {
                  id: `event_${applicationRecordId}_returned_${occurredAt}`,
                  at: occurredAt,
                  title: "Moved back to Shortlisted",
                  detail:
                    "Its form was closed and nothing was sent. Its history stays here.",
                  emphasis: "neutral",
                },
              ],
            }),
          );
        },
      );
      return ctx.getWorkspaceSnapshot();
    },

    async undoReturnApplicationToShortlist(
      jobId: string,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const record = (await ctx.repository.listApplicationRecords())
        .filter(
          (entry) =>
            entry.jobId === jobId && isApplicationReturnedToShortlist(entry),
        )
        .sort((left, right) =>
          right.lastUpdatedAt.localeCompare(left.lastUpdatedAt),
        )[0];
      if (!record) throw new Error("It is in Applications again already.");
      await input.withExactApplicationRecordTransition(
        record.id,
        jobId,
        async () => {
          const latest = await readRecord(record.id);
          const occurredAt = new Date().toISOString();
          await ctx.repository.upsertApplicationRecord(
            ApplicationRecordSchema.parse({
              ...latest,
              lastActionLabel: "Moved back to Applications.",
              nextActionLabel:
                "Its form was closed. Apply again to fill it in.",
              lastUpdatedAt: occurredAt,
              returnedToShortlistAt: null,
              events: [
                ...latest.events,
                {
                  id: `event_${record.id}_back_in_applications_${occurredAt}`,
                  at: occurredAt,
                  title: "Moved back to Applications",
                  detail: "Nothing was sent.",
                  emphasis: "neutral",
                },
              ],
            }),
          );
        },
      );
      return ctx.getWorkspaceSnapshot();
    },
  };
}
