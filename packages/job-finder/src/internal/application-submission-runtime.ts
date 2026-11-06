import type {
  ApplicationAutomationMode,
  JobSource,
  SubmissionAnswerSnapshotIdentity,
  SubmissionFinalControlIdentity,
  SubmissionOutcomeRetryEligibility,
  SubmissionPreflightRecord,
} from "@nestor/contracts";
import {
  describeBrowserError,
  SubmissionFinalControlIdentitySchema,
  SubmissionObservationIdentitySchema,
} from "@nestor/contracts";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import type {
  ApplicationFinalActionResult,
  ApplicationFormObservation,
  ExecuteExactlyOneFinalActionInput,
} from "@nestor/browser-runtime";

import {
  buildSubmissionPreflightRecord,
  type SubmissionPreflightCapacityFacts,
  type SubmissionPreflightLineageFacts,
} from "./application-submission-preflight";
import {
  runSyntheticApplicationSubmission,
  type SyntheticSubmissionAuthorityRepository,
  type SyntheticSubmissionExecutorResult,
  type SyntheticSubmissionOrchestrationResult,
} from "./application-submission-orchestrator";
import type { CurrentApplicationSubmissionPolicyFacts } from "./application-submission-policy";

/**
 * The browser capability required by this composition seam. It is deliberately
 * structural and keeps Playwright's Page type inside browser-runtime.
 */
export type ApplicationSubmissionBrowserRuntime = {
  observeApplicationForm: NonNullable<
    BrowserSessionRuntime["observeApplicationForm"]
  >;
  executeExactlyOneFinalAction: NonNullable<
    BrowserSessionRuntime["executeExactlyOneFinalAction"]
  >;
};

/**
 * Main-process-only input for one authority-bound application attempt.
 *
 * `resumeBytes` must come from the trusted resume/export adapter. The
 * composition derives the preflight resume digest itself and never accepts a
 * caller-declared digest. Policy facts contain identities and finite stop
 * codes only; raw answers and page content do not cross this boundary.
 */
export interface ApplicationSubmissionRuntimeInput {
  readonly repository: SyntheticSubmissionAuthorityRepository;
  readonly browserRuntime: ApplicationSubmissionBrowserRuntime;
  readonly source: JobSource;
  readonly savedMode: ApplicationAutomationMode;
  readonly authorityEnvelopeId: SubmissionPreflightRecord["authorityEnvelopeId"];
  readonly authorityRevision: SubmissionPreflightRecord["authorityRevision"];
  readonly preflightId: SubmissionPreflightRecord["id"];
  readonly idempotencyKey: SubmissionPreflightRecord["idempotencyKey"];
  readonly lineage: SubmissionPreflightLineageFacts;
  readonly resumeBytes: Uint8Array;
  readonly answers: SubmissionAnswerSnapshotIdentity;
  readonly capacity: SubmissionPreflightCapacityFacts;
  readonly currentPolicyFacts: CurrentApplicationSubmissionPolicyFacts;
  readonly now: SubmissionPreflightRecord["createdAt"];
  readonly finalAction?: { actionRef: string; actionLabel: string };
  readonly executionGrantId?: string | null;
  /** The person pressed Send on an "Ask before sending" application. */
  readonly personConfirmation?: { grantedAt: string; expiresAt: string } | null;
  readonly signal?: AbortSignal;
}

export type ApplicationSubmissionRuntimeResult =
  SyntheticSubmissionOrchestrationResult;

function blockedResult(
  reason: Extract<
    SyntheticSubmissionOrchestrationResult,
    { status: "blocked" }
  >["reason"],
  detail: string,
): Extract<SyntheticSubmissionOrchestrationResult, { status: "blocked" }> {
  return {
    status: "blocked",
    reason,
    detail,
    decision: null,
    preflight: null,
    idempotency: null,
    executionGrant: null,
  };
}

function mapNotSubmittedRetry(input: {
  authorityVetoed: boolean;
}): SubmissionOutcomeRetryEligibility {
  return input.authorityVetoed
    ? { eligible: false, blockReason: "authority_no_longer_valid" }
    : { eligible: false, blockReason: "policy_decision" };
}

function mapBrowserActionResult(input: {
  result: ApplicationFinalActionResult;
  authorityVetoed: boolean;
  preflightId: string;
}): SyntheticSubmissionExecutorResult {
  const browserAction = {
    reason: input.result.reason,
    ...(input.result.outcome === "not_submitted" &&
    input.result.validationErrors?.length
      ? { detail: input.result.validationErrors.join(" ").slice(0, 500) }
      : {}),
    ...(input.result.outcome === "outcome_uncertain" && input.result.siteMessage
      ? { detail: input.result.siteMessage.slice(0, 500) }
      : {}),
    actionAttempted: input.result.facts.actionAttempted,
    actionIssued: input.result.facts.actionIssued,
    actionCompleted: input.result.facts.actionCompleted,
    requestsObservedDuringAction:
      input.result.facts.requestsObservedDuringAction,
    requestsAfterClick: [...input.result.facts.requestsAfterClick],
  };
  if (input.result.outcome === "submitted") {
    const { destination, observedAt, summary } = input.result.confirmation;
    if (destination.origin && destination.safePath) {
      return {
        outcome: "submitted",
        browserAction,
        verifiedAt: observedAt,
        evidence: [
          {
            id: `evidence_${input.preflightId}_employer_confirmation`,
            kind: "employer_site_state",
            observedAt,
            destination: {
              origin: destination.origin,
              safePath: destination.safePath,
            },
            artifactRefId: null,
            summary,
          },
        ],
      };
    }
    return { outcome: "outcome_uncertain", evidence: [], browserAction };
  }

  if (input.result.outcome === "not_submitted") {
    return {
      outcome: "not_submitted",
      browserAction,
      evidence: [],
      retry:
        input.result.reason === "form_validation_failed" &&
        !input.authorityVetoed
          ? { eligible: true, blockReason: null }
          : mapNotSubmittedRetry({ authorityVetoed: input.authorityVetoed }),
    };
  }

  // Click, URL, and request facts alone never establish a submitted outcome.
  return { outcome: "outcome_uncertain", evidence: [], browserAction };
}

export async function runApplicationSubmissionRuntime(
  input: ApplicationSubmissionRuntimeInput,
): Promise<ApplicationSubmissionRuntimeResult> {
  if (input.signal?.aborted) {
    return blockedResult(
      "immediate_recheck_failed",
      "The application submission was cancelled before browser observation; no action was attempted.",
    );
  }

  const previous = await input.repository.getSubmissionIdempotencyRecord(
    input.idempotencyKey,
  );
  if (previous && previous.status !== "available") {
    const recorded = await input.repository.getSubmissionPreflightRecord(
      previous.preflightId,
    );
    if (recorded)
      return runSyntheticApplicationSubmission({
        repository: input.repository,
        preflight: recorded,
        savedMode: input.savedMode,
        jobId: recorded.jobId,
        campaignId: recorded.campaignId,
        observation: {
          origin: recorded.origin!,
          formObservation: recorded.formObservation,
          resumeSha256: recorded.resumeSha256,
          answers: recorded.answers,
          finalControl: recorded.finalControl,
          remainingRunCapacity: recorded.remainingRunCapacityBefore,
          currentPolicyFacts: input.currentPolicyFacts,
        },
        now: input.now,
        executor: {
          execute: () =>
            Promise.reject(
              new Error("A recorded send call is never replayed."),
            ),
        },
      });
  }
  let observation: ApplicationFormObservation;
  try {
    observation = await input.browserRuntime.observeApplicationForm(
      input.source,
      {
        pageBindingKey: input.lineage.resultId,
        ...(input.finalAction
          ? {
              finalActionTargets: [
                {
                  ref: input.finalAction.actionRef,
                  label: input.finalAction.actionLabel,
                },
              ],
            }
          : {}),
      },
    );
  } catch {
    return blockedResult(
      "immediate_recheck_failed",
      "The current application form could not be observed safely; no action was attempted.",
    );
  }

  const pageOrigin = observation.page.origin;
  const control = observation.controls[0];
  if (!pageOrigin || !control)
    return blockedResult(
      "immediate_recheck_failed",
      "That control is stale or missing; observe again.",
    );

  let formObservation: ReturnType<
    typeof SubmissionObservationIdentitySchema.parse
  >;
  let finalControl: SubmissionFinalControlIdentity;
  let preflight: SubmissionPreflightRecord;
  try {
    formObservation = SubmissionObservationIdentitySchema.parse(
      observation.identity,
    );
    finalControl = SubmissionFinalControlIdentitySchema.parse(control.identity);
    preflight = buildSubmissionPreflightRecord({
      id: input.preflightId,
      idempotencyKey: input.idempotencyKey,
      lineage: input.lineage,
      authorityEnvelopeId: input.authorityEnvelopeId,
      authorityRevision: input.authorityRevision,
      decisionPolicy: input.currentPolicyFacts.policy,
      origin: pageOrigin,
      formObservation,
      resumeBytes: input.resumeBytes,
      answers: input.answers,
      finalControl,
      capacity: input.capacity,
      createdAt: input.now,
    });
  } catch {
    return blockedResult(
      "preflight_missing",
      "The exact application preflight could not be constructed safely; no action was attempted.",
    );
  }

  if (preflight.origin === null) {
    return blockedResult(
      "origin_not_allowed",
      "The exact application origin could not be canonicalized; no action was attempted.",
    );
  }
  const preflightOrigin = preflight.origin;
  const execute = async (executorInput: {
    preflight: SubmissionPreflightRecord;
  }): Promise<SyntheticSubmissionExecutorResult> => {
    if (input.signal?.aborted) {
      return {
        outcome: "not_submitted",
        evidence: [],
        retry: mapNotSubmittedRetry({ authorityVetoed: false }),
      };
    }

    const actionInput: ExecuteExactlyOneFinalActionInput = {
      pageBindingKey: input.lineage.resultId,
      callId: input.idempotencyKey,
      expectedObservation: executorInput.preflight.formObservation,
      expectedControl: executorInput.preflight.finalControl,
      expectedPageOrigin: preflightOrigin,
      allowedOrigins: [preflightOrigin],
      veto: () => !input.signal?.aborted,
      ...(input.signal ? { signal: input.signal } : {}),
    };

    try {
      const browserResult =
        await input.browserRuntime.executeExactlyOneFinalAction(
          input.source,
          actionInput,
        );
      return mapBrowserActionResult({
        result: browserResult,
        authorityVetoed: false,
        preflightId: executorInput.preflight.id,
      });
    } catch (error) {
      // Once the durable marker is armed, a browser hand failure is always
      // uncertain. The orchestrator records that state and permanently blocks
      // an automatic retry for this idempotency key.
      const detail = describeBrowserError(
        error,
        "The final browser action failed.",
      )
        .replace(/https?:\/\/[^\s)]+/gu, (url) => {
          try {
            const parsed = new URL(url);
            return `${parsed.origin}${parsed.pathname}`;
          } catch {
            return "the employer page";
          }
        })
        .slice(0, 500);
      return {
        outcome: "outcome_uncertain",
        evidence: [],
        browserAction: { reason: "runtime_exception", detail },
      };
    }
  };

  return runSyntheticApplicationSubmission({
    repository: input.repository,
    preflight,
    savedMode: input.savedMode,
    jobId: input.lineage.jobId,
    campaignId: input.lineage.campaignId,
    observation: {
      origin: preflight.origin,
      formObservation: preflight.formObservation,
      resumeSha256: preflight.resumeSha256,
      answers: preflight.answers,
      finalControl: preflight.finalControl,
      remainingRunCapacity: preflight.remainingRunCapacityBefore,
      currentPolicyFacts: input.currentPolicyFacts,
    },
    now: input.now,
    ...(input.executionGrantId !== undefined
      ? { executionGrantId: input.executionGrantId }
      : {}),
    ...(input.personConfirmation
      ? { personConfirmation: input.personConfirmation }
      : {}),
    executor: {
      execute: async () => execute({ preflight }),
    },
  });
}

/** Alias that emphasizes this module's composition role for local callers. */
export const composeApplicationSubmissionRuntime =
  runApplicationSubmissionRuntime;
