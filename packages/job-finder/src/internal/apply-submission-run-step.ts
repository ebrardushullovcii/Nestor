import { readFile } from "node:fs/promises";

import type {
  ApplicationAuthorityEnvelope,
  ApplicationResumeArtifact,
  JobSource,
} from "@nestor/contracts";
import { isActiveApplicationAuthorityEnvelope } from "@nestor/contracts";

import type { SubmissionPreflightLineageFacts } from "./application-submission-preflight";
import {
  resolveApplicationAuthoritySuccessorId,
  withApplicationAuthorityGate,
} from "./application-authority-gate";
import { runApplicationSubmissionRuntime } from "./application-submission-runtime";
import {
  describeSubmissionOutcome,
  SITE_UNREACHABLE_REASON,
  submitPreparedApplication,
  type ApplySubmissionHandoff,
} from "./apply-submission-handoff";
import type { WorkspaceServiceContext } from "./workspace-service-context";
import { SITE_UNREACHABLE_SUMMARY } from "./workspace-application-user-action";

/**
 * Sending a prepared application from inside an apply run.
 *
 * Only reached when the person's saved permission covers sending this exact
 * application on its own. Everything else — filling in and stopping, or
 * filling in and waiting for them — never gets here.
 *
 * The browser must still be holding the page it just filled in. When it is
 * not, nothing is sent and the application stays as it was prepared, which is
 * the safe outcome rather than an error worth surfacing.
 */
export interface ApplySendAttempt {
  /** True only when a send was actually attempted. */
  sent: boolean;
  /** True only when the employer site confirmed receipt. */
  confirmedSubmitted: boolean;
  /**
   * True when the browser was no longer holding the page. Nothing was sent and
   * the application has to be prepared again before it can be.
   */
  pageClosed: boolean;
  /**
   * True when the send went out but the site could not be reached: nothing
   * was sent, and the form is gone (the tab shows the browser's error page),
   * so the application is prepared again rather than sent again.
   */
  formGone?: boolean;
  summary: string;
  detail: string;
  nextActionLabel: string;
}

/**
 * The browser let go of the page before this could be sent.
 *
 * Said plainly rather than swallowed: an application the person expected to go
 * out did not, and the reason is one they can act on.
 */
const PAGE_CLOSED_ATTEMPT: ApplySendAttempt = {
  sent: false,
  confirmedSubmitted: false,
  pageClosed: true,
  summary: "The application page was closed",
  detail:
    "The application page was closed before you reviewed it. Prepare it again to continue.",
  nextActionLabel: "Prepare again",
};

/** Every refusal to send starts with this, so the row and Home can say it. */
export const NOT_SENT_SUMMARY_PREFIX = "Not sent";

/**
 * A send that was asked for and did not happen, with the reason in plain
 * words. This used to come back as nothing at all, and the application sat
 * on "ready to send" with no word about why Send did nothing.
 */
export function notSentAttempt(reason: string, detail: string,
): ApplySendAttempt {
  return {
    sent: false,
    confirmedSubmitted: false,
    pageClosed: false,
    summary: `${NOT_SENT_SUMMARY_PREFIX}: ${reason}`,
    detail,
    nextActionLabel: "Try again",
  };
}

/** A send that threw, said the same way as a refusal. */
export function notSentAfterError(error: unknown): ApplySendAttempt {
  const message =
    error instanceof Error && error.message.trim()
      ? error.message.trim().slice(0, 300)
      : "The send failed before anything reached the site.";
  return notSentAttempt(
    "the send failed",
    `Nothing was sent. ${message} Try again sends it once more.`,
  );
}

/**
 * Writes a send that did not happen onto the prepared result, which stays
 * ready to send, so its row and Home say "Not sent: …" instead of nothing.
 */
export async function recordPreparedApplicationNotSent(input: {
  repository: Pick<
    WorkspaceServiceContext["repository"],
    "listApplyJobResults" | "upsertApplyJobResult"
  >;
  lineage: SubmissionPreflightLineageFacts;
  attempt: ApplySendAttempt | null;
}): Promise<void> {
  const attempt = input.attempt;
  if (!attempt || attempt.sent || attempt.pageClosed) return;
  const result = (
    await input.repository.listApplyJobResults({
      runId: input.lineage.runId,
      jobId: input.lineage.jobId,
    })
  ).find((entry) => entry.id === input.lineage.resultId);
  if (
    !result ||
    result.state !== "awaiting_review" ||
    result.privacyReceipt?.submissionOutcome?.outcome === "submitted" ||
    result.privacyReceipt?.submissionOutcome?.outcome === "outcome_uncertain"
  )
    return;
  const now = new Date().toISOString();
  await input.repository.upsertApplyJobResult(
    attempt.formGone
      ? {
          ...result,
          automaticSendPending: false,
          state: "failed",
          summary: attempt.summary,
          detail: attempt.detail,
          updatedAt: now,
          completedAt: now,
          blockerReason: "application_page_unreachable",
          blockerSummary: SITE_UNREACHABLE_SUMMARY,
        }
      : {
          ...result,
          automaticSendPending: false,
          summary: attempt.summary,
          detail: attempt.detail,
          updatedAt: now,
        },
  );
}

/** The name of the site the kept form lives on, from the prepared result. */
async function resolvePreparedFormSiteLabel(input: {
  repository: Pick<
    WorkspaceServiceContext["repository"],
    "listApplyJobResults"
  >;
  lineage: SubmissionPreflightLineageFacts;
  fallback: string;
}): Promise<string> {
  const result = (
    await input.repository.listApplyJobResults({
      runId: input.lineage.runId,
      jobId: input.lineage.jobId,
    })
  ).find((entry) => entry.id === input.lineage.resultId);
  const origin = result?.privacyReceipt?.destination?.origin;
  if (!origin) return input.fallback;
  try {
    return new URL(origin).host.replace(/^www\./iu, "") || input.fallback;
  } catch {
    return input.fallback;
  }
}

function currentEnvelopeCoversPreparedApplication(input: {
  repository: object;
  envelope: ApplicationAuthorityEnvelope;
  original: ApplicationAuthorityEnvelope;
  lineage: SubmissionPreflightLineageFacts;
  resumeArtifact: ApplicationResumeArtifact;
  now: string;
}): boolean {
  const { repository, envelope, original, lineage, resumeArtifact, now } =
    input;
  return (
    envelope.id ===
      resolveApplicationAuthoritySuccessorId(repository, original.id) &&
    isActiveApplicationAuthorityEnvelope(envelope, now) &&
    envelope.mode === original.mode &&
    envelope.scope.jobIds.includes(lineage.jobId) &&
    Boolean(
      resumeArtifact.sha256 &&
      envelope.allowedResumeSha256.includes(
        resumeArtifact.sha256.toLowerCase(),
      ),
    ) &&
    Boolean(envelope.decisionPolicy)
  );
}

export async function sendPreparedApplicationIfAllowed(input: {
  ctx: Pick<WorkspaceServiceContext, "repository" | "browserRuntime"> &
    Partial<
      Pick<
        WorkspaceServiceContext,
        "withIntelligenceTransition" | "documentManager"
      >
    >;
  handoff: ApplySubmissionHandoff | null;
  envelope: ApplicationAuthorityEnvelope | null;
  source: JobSource;
  lineage: SubmissionPreflightLineageFacts;
  resumeArtifact: ApplicationResumeArtifact;
  siteLabel: string;
  signal?: AbortSignal;
}): Promise<ApplySendAttempt | null> {
  const handoff = input.handoff;
  const originalEnvelope = input.envelope;
  if (handoff?.status !== "send_now" || !originalEnvelope) {
    return null;
  }
  const runtime = input.ctx.browserRuntime;
  if (
    runtime.hasApplicationPageBinding &&
    !(await runtime.hasApplicationPageBinding(
      input.source,
      input.lineage.resultId,
    ))
  )
    return PAGE_CLOSED_ATTEMPT;

  // The gate gives back nothing only when the send was stopped while waiting.
  const sendWithinAuthorityGate = async (): Promise<ApplySendAttempt> =>
    (await withApplicationAuthorityGate(
      input.ctx.repository,
      input.signal,
      async () => {
        const letterIsCurrent = async () => {
          const prepared = (
            await input.ctx.repository.listApplyJobResults({
              jobId: input.lineage.jobId,
            })
          ).find((entry) => entry.id === input.lineage.resultId);
          if (prepared?.reviewCard?.letter?.needsRefresh) return false;
          const approved =
            await input.ctx.documentManager?.getApprovedApplicationLetter?.(
              input.lineage.jobId,
              input.lineage.applicationRecordId ?? undefined,
            );
          return (
            !approved ||
            !prepared?.reviewCard?.letter ||
            prepared.reviewCard.letter.text === approved.content
          );
        };
        if (!(await letterIsCurrent())) {
          return {
            ...notSentAttempt(
              "the approved letter changed",
              "The form still holds the earlier letter. Prepare again to attach the letter you approved. Nothing was sent.",
            ),
            nextActionLabel: "Prepare again",
          };
        }
        const now = new Date().toISOString();
        const active =
          await input.ctx.repository.listApplicationAuthorityEnvelopes({
            status: "active",
          });
        // A newer grant may have been made while this job filled its form. It
        // must still cover this exact job and resume in the same chosen mode.
        const envelope = active.length === 1 ? active[0] : null;
        if (
          !envelope ||
          !currentEnvelopeCoversPreparedApplication({
            repository: input.ctx.repository,
            envelope,
            original: originalEnvelope,
            lineage: input.lineage,
            resumeArtifact: input.resumeArtifact,
            now,
          })
        ) {
          return notSentAttempt(
            "your permission to send changed",
            "Your permission to send changed after this application was filled in, and the current one does not cover it. Nothing was sent. Try again sends it under your current permission.",
          );
        }
        // The mode is read again right before each send, not only when the batch
        // started: switching Settings away from Send for me mid-batch must stop
        // the jobs not sent yet. They stay filled in and wait, as the new mode
        // says. A send the person confirmed themselves is theirs to make.
        if (!handoff.confirmedByPerson) {
          const settings = await input.ctx.repository.getSettings();
          if (settings.applicationAutomationMode !== "autonomous_submit") {
            return notSentAttempt(
              "Send for me is off",
              "Send for me was turned off after this form was filled in, so it waits for you. Nothing was sent.",
            );
          }
        }

        // The runtime keeps its own page; these stay bound to it.
        if (
          !runtime.observeApplicationForm ||
          !runtime.executeExactlyOneFinalAction
        ) {
          return PAGE_CLOSED_ATTEMPT;
        }
        if (
          runtime.hasApplicationPageBinding &&
          !(await runtime.hasApplicationPageBinding(
            input.source,
            input.lineage.resultId,
          ))
        ) {
          return PAGE_CLOSED_ATTEMPT;
        }

        const result = await submitPreparedApplication({
          repository: input.ctx.repository,
          browserRuntime: {
            observeApplicationForm: (source, options) =>
              runtime.observeApplicationForm!(source, options),
            executeExactlyOneFinalAction: (source, actionInput) =>
              runtime.executeExactlyOneFinalAction!(source, {
                ...actionInput,
                veto: async (facts) => {
                  return (
                    (await letterIsCurrent()) && (await actionInput.veto(facts))
                  );
                },
              }),
          },
          source: input.source,
          envelope,
          lineage: input.lineage,
          ...(handoff.confirmedByPerson ? { confirmedByPerson: true } : {}),
          loadResumeBytes: async () =>
            new Uint8Array(await readFile(input.resumeArtifact.filePath)),
          now,
          ...(input.signal ? { signal: input.signal } : {}),
          runSubmission: runApplicationSubmissionRuntime,
        });

        // Name the site the form is on (an employer's form reached from a
        // job board is the employer's), not the board the job was found on.
        const siteLabel = await resolvePreparedFormSiteLabel({
          repository: input.ctx.repository,
          lineage: input.lineage,
          fallback: input.siteLabel,
        }).catch(() => input.siteLabel);
        const told = describeSubmissionOutcome({ result, siteLabel });
        const formGone =
          result.status === "recorded_not_submitted" &&
          result.outcome.browserAction?.reason === SITE_UNREACHABLE_REASON;
        if (result.status === "submitted" || formGone) {
          // A sent application no longer needs its page kept; holding it would
          // count against the browser's tab limit for the rest of the session.
          await runtime
            .releaseApplicationPageBinding?.(
              input.source,
              input.lineage.resultId,
            )
            .catch(() => undefined);
        }
        return {
          sent:
            result.status === "submitted" ||
            result.status === "outcome_uncertain",
          confirmedSubmitted: result.status === "submitted",
          pageClosed: false,
          ...(formGone ? { formGone: true } : {}),
          ...told,
        };
      },
    )) ??
    notSentAttempt(
      "it was stopped",
      "The work was stopped before this application was sent. Nothing was sent.",
    );
  if (!runtime.withApplicationPageExecution) return sendWithinAuthorityGate();

  let operationEntered = false;
  try {
    return await runtime.withApplicationPageExecution(
      input.source,
      input.lineage.resultId,
      () => {
        operationEntered = true;
        return sendWithinAuthorityGate();
      },
      input.signal,
    );
  } catch (error) {
    if (
      !operationEntered &&
      error instanceof Error &&
      (error.message ===
        "The exact prepared application page is no longer open." ||
        error.message === "The prepared application page was closed.")
    )
      return PAGE_CLOSED_ATTEMPT;
    throw error;
  }
}
