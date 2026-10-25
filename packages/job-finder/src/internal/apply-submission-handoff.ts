import type { ApplyAgentResult } from "@nestor/browser-agent";
import {
  ApplyExecutionResultSchema,
  type ApplicationAuthorityEnvelope,
  type ApplicationAutomationMode,
  type ApplyExecutionResult,
} from "@nestor/contracts";

import type {
  SubmissionPreflightCapacityFacts,
  SubmissionPreflightLineageFacts,
} from "./application-submission-preflight";
import type {
  ApplicationSubmissionBrowserRuntime,
  ApplicationSubmissionRuntimeInput,
  ApplicationSubmissionRuntimeResult,
} from "./application-submission-runtime";
import type { SyntheticSubmissionAuthorityRepository } from "./application-submission-orchestrator";

/**
 * Handing a filled-in application over to be sent.
 *
 * The loop that fills a form never presses send. When the form is complete and
 * the person's saved permission covers this exact application, the one
 * irreversible click goes through the submission path instead, which records
 * the attempt before it happens, refuses to repeat itself, and never claims an
 * outcome the employer's site did not give.
 *
 * This module decides whether that handover happens at all and builds the
 * facts it needs; it performs no browser action itself.
 */

export type ApplySubmissionHandoff =
  | {
      status: "not_ready";
      /** One plain sentence about why nothing was sent. */
      reason: string;
    }
  | {
      status: "awaiting_your_review";
      reason: string;
      finalAction: { actionRef: string; actionLabel: string };
    }
  | {
      status: "send_now";
      finalAction: { actionRef: string; actionLabel: string };
      envelope: ApplicationAuthorityEnvelope;
      /**
       * True when the person pressed Send themselves on an application
       * prepared under "Ask before sending". That press is the confirmation
       * the mode asks for, and it becomes the execution grant the submission
       * path requires.
       */
      confirmedByPerson?: boolean;
    };

/**
 * Whether this prepared application should be sent, left for the person, or
 * neither.
 *
 * `confirm_before_submit` deliberately stops here with the send button already
 * identified: the person opens the review, and pressing send runs the same
 * path this would have.
 */
export function decideApplySubmissionHandoff(input: {
  result: ApplyAgentResult;
  mode: ApplicationAutomationMode;
  envelope: ApplicationAuthorityEnvelope | null;
  siteLabel: string;
}): ApplySubmissionHandoff {
  const { result } = input;

  if (result.pauses.length > 0) {
    return {
      status: "not_ready",
      reason:
        result.pauses[0]?.summary ??
        "This application needs you before it can be sent.",
    };
  }

  if (!result.readyToSend) {
    return {
      status: "not_ready",
      reason: `Job Finder filled this application in on ${input.siteLabel} and stopped; nothing was sent.`,
    };
  }

  if (input.mode === "confirm_before_submit") {
    return {
      status: "awaiting_your_review",
      reason: `This application is filled in and ready. Look it over and send it when you are happy with it.`,
      finalAction: result.readyToSend,
    };
  }

  if (input.mode !== "autonomous_submit" || !input.envelope) {
    return {
      status: "not_ready",
      reason: `Job Finder filled this application in on ${input.siteLabel} and stopped; nothing was sent.`,
    };
  }

  return {
    status: "send_now",
    finalAction: result.readyToSend,
    envelope: input.envelope,
  };
}

export interface ApplySubmissionFacts {
  repository: SyntheticSubmissionAuthorityRepository;
  browserRuntime: ApplicationSubmissionBrowserRuntime;
  source: Parameters<
    ApplicationSubmissionBrowserRuntime["observeApplicationForm"]
  >[0];
  envelope: ApplicationAuthorityEnvelope;
  lineage: SubmissionPreflightLineageFacts;
  capacity: SubmissionPreflightCapacityFacts;
  resumeBytes: Uint8Array;
  idempotencyKey: string;
  preflightId: string;
  now: string;
  /** The person pressed Send on an "Ask before sending" application. */
  confirmedByPerson?: boolean;
  signal?: AbortSignal;
}

/** How long the person's press stays good for; the send starts at once. */
const PERSON_CONFIRMATION_GRANT_MS = 10 * 60_000;

/**
 * Runs the submission path for one prepared application.
 *
 * Everything that makes a submission safe already lives behind
 * `runApplicationSubmissionRuntime`: it rereads the saved permission at the
 * last instant, writes the preflight before acting, allows exactly one attempt
 * per key, and records an uncertain outcome as uncertain forever.
 */
export async function sendPreparedApplication(
  facts: ApplySubmissionFacts,
  runSubmission: (
    input: ApplicationSubmissionRuntimeInput,
  ) => Promise<ApplicationSubmissionRuntimeResult>,
): Promise<ApplicationSubmissionRuntimeResult> {
  const policy = facts.envelope.decisionPolicy;
  // "Ask before sending" needs the person's own press on record before the
  // runtime will act. The press is that record: the runtime issues a grant
  // bound to the exact attempt once its preflight exists, good for a few
  // minutes.
  const grantedAtMs = Date.parse(facts.now);
  const personConfirmation =
    facts.envelope.mode === "confirm_before_submit" &&
    facts.confirmedByPerson === true
      ? {
          grantedAt: facts.now,
          expiresAt: new Date(
            (Number.isFinite(grantedAtMs) ? grantedAtMs : Date.now()) +
              PERSON_CONFIRMATION_GRANT_MS,
          ).toISOString(),
        }
      : null;
  return runSubmission({
    repository: facts.repository,
    browserRuntime: facts.browserRuntime,
    source: facts.source,
    savedMode: facts.envelope.mode,
    authorityEnvelopeId: facts.envelope.id,
    authorityRevision: facts.envelope.revision,
    preflightId: facts.preflightId,
    idempotencyKey: facts.idempotencyKey,
    ...(personConfirmation ? { personConfirmation } : {}),
    lineage: facts.lineage,
    resumeBytes: facts.resumeBytes,
    answers: policy
      ? policy.answerPolicy.approvedAnswerSnapshot
      : { revision: 1, digest: "0".repeat(64) },
    capacity: facts.capacity,
    currentPolicyFacts: {
      policy: policy
        ? {
            version: policy.version,
            revision: policy.revision,
            digest: policy.digest,
          }
        : null,
      answers: policy
        ? policy.answerPolicy.approvedAnswerSnapshot
        : { revision: 1, digest: "0".repeat(64) },
      mandatoryStops: [],
    },
    now: facts.now,
    ...(facts.signal ? { signal: facts.signal } : {}),
  });
}

/**
 * What the person is told after a submission attempt.
 *
 * An employer-site receipt confirmation counts as submitted. A click without
 * that confirmation stays uncertain and is never retried automatically.
 */
/**
 * What a send that did not go out says, by the reason the browser gave.
 * Home reads the part after "Not sent: " as the reason, so it must name one.
 */
function describeNotSubmittedOutcome(input: {
  reason: string | null;
  siteLabel: string;
}): { summary: string; detail: string; nextActionLabel: string } {
  switch (input.reason) {
    case SITE_UNREACHABLE_REASON:
      return {
        summary: `Not sent: ${input.siteLabel} could not be reached`,
        detail: `The connection to ${input.siteLabel} was refused before the form went out, so nothing was sent. Try again prepares the application again once the site is back.`,
        nextActionLabel: "Try again",
      };
    case "action_error":
      return {
        summary: "Not sent: the send button could not be pressed",
        detail: `Job Finder could not press the send button on the form, so nothing was sent to ${input.siteLabel}. The form is still filled in; Send tries again.`,
        nextActionLabel: "Send it",
      };
    default:
      return {
        summary: input.reason
          ? `Not sent: the form was not ready to send (${input.reason.replace(/_/gu, " ")})`
          : "Not sent: the form was not ready to send",
        detail: `Nothing was sent to ${input.siteLabel}. The application is filled in and waiting for you.`,
        nextActionLabel: "Open the application and finish it",
      };
  }
}

/** The browser's reason when the site refused the connection before the send. */
export const SITE_UNREACHABLE_REASON = "site_unreachable";

export function describeSubmissionOutcome(input: {
  result: ApplicationSubmissionRuntimeResult;
  siteLabel: string;
}): { summary: string; detail: string; nextActionLabel: string } {
  switch (input.result.status) {
    case "submitted":
      return {
        summary: "Application submitted",
        detail: `${input.siteLabel} confirmed that it received this application. Job Finder will not send it again.`,
        nextActionLabel: "View application",
      };
    case "outcome_uncertain":
      if (
        input.result.outcome?.browserAction?.reason === "confirmation_timeout"
      ) {
        return {
          summary: "Send attempted; confirmation timed out",
          detail: `${input.siteLabel} did not confirm receipt in time. Check this application on the site before trying again.`,
          nextActionLabel: "Check the site and confirm",
        };
      }
      return {
        summary: "Check whether this application was sent",
        detail: `Job Finder attempted to send this application to ${input.siteLabel}. Its site did not confirm it arrived, and Job Finder will not send it again. Open ${input.siteLabel} to check, then tell Job Finder what you found.`,
        nextActionLabel: "Check the site and confirm",
      };
    case "recorded_not_submitted":
      if (
        input.result.outcome?.browserAction?.reason === "form_validation_failed"
      ) {
        return {
          summary: "Not sent: correct the marked fields",
          detail:
            input.result.outcome.browserAction.detail ??
            "The site rejected a field. Correct it in the browser, then send again.",
          nextActionLabel: "Correct the fields in the browser",
        };
      }
      return describeNotSubmittedOutcome({
        reason: input.result.outcome?.browserAction?.reason ?? null,
        siteLabel: input.siteLabel,
      });
    default: {
      // Say why. A bare "did not send" left the person, and the developer,
      // guessing which check refused; the orchestrator always knows.
      const why =
        "detail" in input.result && typeof input.result.detail === "string"
          ? input.result.detail.trim()
          : "";
      const reason =
        "reason" in input.result && typeof input.result.reason === "string"
          ? input.result.reason.replace(/_/gu, " ")
          : "";
      return {
        summary: reason
          ? `Not sent: ${reason}`
          : "Not sent: Job Finder stopped before sending",
        detail: `Job Finder did not send this application to ${input.siteLabel}, and nothing on the site was changed.${reason ? ` It stopped because: ${reason}.` : ""}${why ? ` ${why}` : ""}`,
        nextActionLabel: "Open the application and finish it",
      };
    }
  }
}

/**
 * The safety net around one prepared application's result.
 *
 * A run that was only allowed to fill the form in must never come back saying
 * it sent anything. A run that was allowed to send still comes back
 * unsubmitted from this path, because the sending itself happens afterwards,
 * through the submission runtime — so the same check holds either way.
 */
export function enforceResolvedApplyAuthorityResult(
  authority: { mode: ApplicationAutomationMode },
  result: ApplyExecutionResult,
): ApplyExecutionResult {
  const parsed = ApplyExecutionResultSchema.parse(result);
  if (
    parsed.state === "submitted" ||
    parsed.submittedAt !== null ||
    parsed.outcome === "submitted"
  ) {
    throw new Error(
      `An application preparation running as '${authority.mode}' reported a submitted outcome. Preparation never sends anything; only the submission path can.`,
    );
  }
  return parsed;
}

/** The stable name for one application's single submission attempt. */
export function applySubmissionIdempotencyKey(lineage: {
  runId: string;
  jobId: string;
  resultId: string;
}): string {
  return `submission_${lineage.runId}_${lineage.jobId}_${lineage.resultId}`;
}

export function applySubmissionPreflightId(lineage: {
  runId: string;
  jobId: string;
  resultId: string;
}): string {
  return `preflight_${lineage.runId}_${lineage.jobId}_${lineage.resultId}`;
}

/**
 * How much of the person's allowance is left.
 *
 * Counted from attempts that actually happened rather than from intentions, so
 * a run that was interrupted does not quietly spend a slot. A send on record
 * as not sent reached nothing, so it spends no slot either: counting it made
 * the person's Try again after a blocked send button fail with "capacity
 * invalid". Both numbers stop at zero: a negative allowance is still no
 * allowance.
 */
export function deriveApplySubmissionCapacity(input: {
  envelope: ApplicationAuthorityEnvelope;
  outcomes: readonly {
    runId: string;
    attemptedAt: string;
    outcome?: string;
  }[];
  runId: string;
  now: string;
}): SubmissionPreflightCapacityFacts {
  const outcomes = input.outcomes.filter(
    (outcome) => outcome.outcome !== "not_submitted",
  );
  input = { ...input, outcomes };

  const attemptedInRun = input.outcomes.filter(
    (outcome) => outcome.runId === input.runId,
  ).length;

  return {
    remainingRunCapacity: Math.max(
      0,
      input.envelope.maxApplicationsPerRun - attemptedInRun,
    ),
  };
}

export type SubmitPreparedApplicationRepository =
  SyntheticSubmissionAuthorityRepository & {
    listSubmissionOutcomeRecords: (options?: { jobId?: string }) => Promise<
      readonly {
        runId: string;
        attemptedAt: string;
        idempotencyKey: string;
        outcome: string;
      }[]
    >;
  };

/**
 * Sends one prepared application, gathering the facts the submission path
 * needs at the moment it is asked.
 *
 * Both ways of sending come through here: the run loop calls it itself when
 * the person allowed that, and the "Submit application" action calls it when
 * they chose to look first. Same checks, same record, same single attempt.
 */
/**
 * The key and preflight for this send. One per prepared result, so pressing
 * Send twice can never send twice. The one exception: when an earlier attempt
 * on this result is on record as not sent (nothing reached the site, for
 * example the button could not be clicked), the person's own Send press tries
 * again under the next key instead of replaying that refusal for ever. A sent
 * or uncertain attempt is never tried again.
 */
export function selectSubmissionAttemptIds(input: {
  lineage: { runId: string; jobId: string; resultId: string };
  outcomes: readonly { idempotencyKey: string; outcome: string }[];
  personRetry: boolean;
  /** Keys that already have a preflight, with their idempotency status. */
  attempts?: readonly { idempotencyKey: string; status: string }[];
}): { idempotencyKey: string; preflightId: string } {
  const baseKey = applySubmissionIdempotencyKey(input.lineage);
  const basePreflightId = applySubmissionPreflightId(input.lineage);
  if (!input.personRetry)
    return { idempotencyKey: baseKey, preflightId: basePreflightId };
  for (let retry = 0; retry < SUBMISSION_RETRY_KEY_LIMIT; retry += 1) {
    const suffix = retry === 0 ? "" : `_retry${retry}`;
    const key = `${baseKey}${suffix}`;
    const prior = input.outcomes.find(
      (outcome) => outcome.idempotencyKey === key,
    );
    if (prior?.outcome === "not_submitted") continue;
    // A key whose attempt stopped before it was armed never pressed
    // anything, and its preflight cannot be written again: use the next one.
    // An armed key is returned as it is, so its recovery decides.
    const used = prior
      ? null
      : input.attempts?.find((attempt) => attempt.idempotencyKey === key);
    if (used && (used.status === "available" || used.status === "revoked"))
      continue;
    return { idempotencyKey: key, preflightId: `${basePreflightId}${suffix}` };
  }
  return { idempotencyKey: baseKey, preflightId: basePreflightId };
}

const SUBMISSION_RETRY_KEY_LIMIT = 50;

async function listSubmissionAttemptKeys(
  repository: Pick<
    SyntheticSubmissionAuthorityRepository,
    "getSubmissionIdempotencyRecord"
  >,
  lineage: { runId: string; jobId: string; resultId: string },
): Promise<{ idempotencyKey: string; status: string }[]> {
  const baseKey = applySubmissionIdempotencyKey(lineage);
  const attempts: { idempotencyKey: string; status: string }[] = [];
  for (let retry = 0; retry < SUBMISSION_RETRY_KEY_LIMIT; retry += 1) {
    const key = retry === 0 ? baseKey : `${baseKey}_retry${retry}`;
    const record = await repository.getSubmissionIdempotencyRecord(key);
    if (!record) break;
    attempts.push({ idempotencyKey: key, status: record.status });
  }
  return attempts;
}

export async function submitPreparedApplication(input: {
  repository: SubmitPreparedApplicationRepository;
  browserRuntime: ApplicationSubmissionBrowserRuntime;
  source: ApplySubmissionFacts["source"];
  envelope: ApplicationAuthorityEnvelope;
  lineage: SubmissionPreflightLineageFacts;
  loadResumeBytes: () => Promise<Uint8Array>;
  now: string;
  confirmedByPerson?: boolean;
  signal?: AbortSignal;
  runSubmission: (
    runtimeInput: ApplicationSubmissionRuntimeInput,
  ) => Promise<ApplicationSubmissionRuntimeResult>;
}): Promise<ApplicationSubmissionRuntimeResult> {
  const outcomes = await input.repository.listSubmissionOutcomeRecords({ jobId: input.lineage.jobId });
  const capacity = deriveApplySubmissionCapacity({
    envelope: input.envelope,
    outcomes,
    runId: input.lineage.runId,
    now: input.now,
  });

  return sendPreparedApplication(
    {
      repository: input.repository,
      browserRuntime: input.browserRuntime,
      source: input.source,
      envelope: input.envelope,
      lineage: input.lineage,
      capacity,
      resumeBytes: await input.loadResumeBytes(),
      ...selectSubmissionAttemptIds({
        lineage: input.lineage,
        outcomes,
        personRetry: input.confirmedByPerson === true,
        ...(input.confirmedByPerson === true
          ? {
              attempts: await listSubmissionAttemptKeys(
                input.repository,
                input.lineage,
              ),
            }
          : {}),
      }),
      now: input.now,
      ...(input.confirmedByPerson ? { confirmedByPerson: true } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
    input.runSubmission,
  );
}
