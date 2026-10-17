import { hasSubmissionConfirmationText } from "@nordri/browser-agent";
import {
  submissionConfirmationSummary,
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  type ApplyJobResult,
} from "@nordri/contracts";

import { reconcileApplyRunAfterConfirmedSubmission } from "./workspace-apply-run-support";
import type { WorkspaceServiceContext } from "./workspace-service-context";

const SENT_BY_PERSON_SUMMARY =
  "You sent this application yourself on the site.";
const SENT_BY_PERSON_DETAIL =
  "The site showed its confirmation after you sent the form Job Finder filled in. Job Finder did not press send.";

/**
 * The receipt of a send the person made: the site's own confirmation on the
 * kept page is the evidence, and the person, not an authority envelope, made
 * the send (so the envelope fields name the person's send, not a grant).
 * Every screen that reads "sent" from the receipt then agrees with the
 * result, and nothing offers Try again on an application already sent.
 */
function buildSentByPersonReceipt(
  result: ApplyJobResult,
  pageUrl: string | null | undefined,
  at: string,
  confirmationText: string,
): ApplyJobResult["privacyReceipt"] {
  const receipt = result.privacyReceipt;
  if (!receipt || !result.applicationRecordId) return receipt ?? null;
  let destination = receipt.destination;
  try {
    const url = new URL(pageUrl ?? "");
    if (url.protocol === "http:" || url.protocol === "https:")
      destination = { origin: url.origin, safePath: url.pathname || "/" };
  } catch {
    // The receipt's own destination stands.
  }
  const sendKey = `sent_by_person_${result.id}`;
  return {
    ...receipt,
    finalSubmitOccurred: true,
    submissionOutcome: {
      id: `submission_outcome_${sendKey}`,
      preflightId: sendKey,
      idempotencyKey: sendKey,
      authorityEnvelopeId: sendKey,
      authorityRevision: 1,
      runId: result.runId,
      jobId: result.jobId,
      resultId: result.id,
      applicationRecordId: result.applicationRecordId,
      outcome: "submitted",
      attemptedAt: at,
      verifiedAt: at,
      evidence: [
        {
          id: `evidence_${sendKey}`,
          kind: "employer_site_state",
          observedAt: at,
          destination,
          artifactRefId: null,
          summary: submissionConfirmationSummary(confirmationText),
        },
      ],
      retry: { eligible: false, blockReason: "submission_confirmed" },
    },
  };
}

/**
 * A filled-in application the person opened and sent themselves (ADR 0033).
 *
 * The page stays open to them after "Open the Job Finder browser"; when that
 * exact page shows the site's confirmation, the application is recorded as
 * sent. Without this it stayed "Ready to send", and once the app restarted it
 * turned into "Could not apply" with a Try again that would prepare it a
 * second time.
 *
 * Only pages the runtime says are handed to the person are read, so Job
 * Finder's own send, which records its outcome itself, is never counted
 * here. Returns how many applications were recorded.
 */
export async function recordApplicationsSentByPerson(
  ctx: Pick<WorkspaceServiceContext, "repository" | "browserRuntime">,
): Promise<number> {
  const readWithPerson = ctx.browserRuntime.readApplicationPageWithPerson?.bind(
    ctx.browserRuntime,
  );
  if (!readWithPerson) return 0;

  const results = await ctx.repository.listApplyJobResults();
  const newestByRecord = new Map<string, ApplyJobResult>();
  for (const result of results) {
    if (!result.applicationRecordId) continue;
    const previous = newestByRecord.get(result.applicationRecordId);
    if (!previous || previous.updatedAt < result.updatedAt) {
      newestByRecord.set(result.applicationRecordId, result);
    }
  }
  // A form the person was handed, with or without a question left for them,
  // counts once its page shows the site's confirmation: they may have
  // answered the last question and sent it themselves.
  const handedOver = [...newestByRecord.values()].filter(
    (result) =>
      result.state === "awaiting_review" || result.state === "blocked",
  );
  // This check runs on a timer and whenever a tab moves, which is all the
  // time during a search; it reads the saved jobs only when a form waits.
  if (handedOver.length === 0) return 0;
  const jobs = await ctx.repository.listSavedJobsByIds(
    handedOver.map((result) => result.jobId),
  );

  let recorded = 0;
  for (const result of handedOver) {
    const job = jobs.find((entry) => entry.id === result.jobId);
    if (!job) continue;
    const page = await readWithPerson(job.source, result.id).catch(() => null);
    if (
      !page ||
      page.loading ||
      !hasSubmissionConfirmationText(page.bodyText)
    ) {
      continue;
    }

    // The read awaited a page; record only if nothing moved meanwhile.
    const runResults = await ctx.repository.listApplyJobResults({
      runId: result.runId,
    });
    const current = runResults.find((entry) => entry.id === result.id);
    if (
      !current ||
      current.state !== result.state ||
      current.updatedAt !== result.updatedAt
    ) {
      continue;
    }

    let observedUrl: URL;
    try {
      observedUrl = new URL(page.url ?? "");
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(observedUrl.protocol)) continue;
    const at = new Date().toISOString();
    const sentResult = ApplyJobResultSchema.parse({
      ...current,
      state: "submitted",
      blockerReason: null,
      blockerSummary: null,
      summary: SENT_BY_PERSON_SUMMARY,
      detail: SENT_BY_PERSON_DETAIL,
      updatedAt: at,
      completedAt: at,
      latestQuestionCount: 0,
      privacyReceipt: buildSentByPersonReceipt(
        current,
        page.url,
        at,
        page.bodyText,
      ),
    });
    await ctx.repository.upsertApplyJobResult(sentResult);

    const record = (await ctx.repository.listApplicationRecords()).find(
      (entry) => entry.id === current.applicationRecordId,
    );
    if (record) {
      await ctx.repository.upsertApplicationRecord(
        ApplicationRecordSchema.parse({
          ...record,
          status: "submitted",
          personSendReceipt: {
            observedAt: at,
            origin: observedUrl.origin,
            safePath: observedUrl.pathname,
            summary: submissionConfirmationSummary(page.bodyText),
          },
          lastAttemptState: "submitted",
          lastActionLabel: SENT_BY_PERSON_SUMMARY,
          nextActionLabel: "View application",
          lastUpdatedAt: at,
          events: [
            ...record.events,
            {
              id: `event_sent_by_person_${current.id}`,
              at,
              title: "You sent it on the site",
              detail: SENT_BY_PERSON_DETAIL,
              emphasis: "positive",
            },
          ],
        }),
      );
    }

    const run = (await ctx.repository.listApplyRuns()).find(
      (entry) => entry.id === current.runId,
    );
    if (run) {
      await ctx.repository.upsertApplyRun(
        ApplyRunSchema.parse(
          reconcileApplyRunAfterConfirmedSubmission({
            run,
            results: runResults.map((entry) =>
              entry.id === sentResult.id ? sentResult : entry,
            ),
            submittedAt: at,
            submittedSummary: SENT_BY_PERSON_SUMMARY,
            submittedDetail: SENT_BY_PERSON_DETAIL,
          }),
        ),
      );
    }

    // Finished: the tab stays for the person but no longer counts against
    // the browser's tab limit.
    await ctx.browserRuntime
      .releaseApplicationPageBinding?.(job.source, current.id)
      .catch(() => undefined);
    recorded += 1;
  }
  return recorded;
}
