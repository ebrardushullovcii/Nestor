import type {
  ApplicationAutomationMode,
  JobSource,
  SubmissionAnswerSnapshotIdentity,
  SubmissionFinalControlIdentity,
  SubmissionOutcomeRetryEligibility,
  SubmissionPreflightRecord,
} from "@nestor/contracts";
import {
  isActiveApplicationAuthorityEnvelope,
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

function samePolicyIdentity(
  left: CurrentApplicationSubmissionPolicyFacts["policy"],
  right: CurrentApplicationSubmissionPolicyFacts["policy"],
): boolean {
  return (
    left?.version === right?.version &&
    left?.revision === right?.revision &&
    left?.digest === right?.digest
  );
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

function hasExactOneFinalControl(
  observation: ApplicationFormObservation,
): boolean {
  return observation.complete && observation.controls.length === 1;
}

/**
 * Compose the generic browser hands with Job Finder's durable authority
 * orchestrator for one local attempt. This is intentionally an internal seam:
 * it has no renderer/IPC caller and is not used by the legacy prepare-only
 * application flow.
 *
 * The sequence is observe -> exact-one preflight -> durable authority
 * orchestrator -> one browser hand. The veto callback rereads the envelope on
 * every browser-hands last-instant check, so revocation or revision drift
 * prevents the action from crossing the browser boundary.
 */
export async function runApplicationSubmissionRuntime(
  input: ApplicationSubmissionRuntimeInput,
): Promise<ApplicationSubmissionRuntimeResult> {
  if (input.signal?.aborted) {
    return blockedResult(
      "immediate_recheck_failed",
      "The application submission was cancelled before browser observation; no action was attempted.",
    );
  }

  // Prepare-only is a hard boundary. Do not even observe a final control or
  // persist a preflight when the saved mode cannot authorize final action.
  if (input.savedMode === "prepare_only") {
    return blockedResult(
      "prepare_only",
      "Prepare-only automation never authorizes a final browser action.",
    );
  }

  let initialEnvelope: Awaited<
    ReturnType<
      SyntheticSubmissionAuthorityRepository["getApplicationAuthorityEnvelope"]
    >
  >;
  try {
    initialEnvelope = await input.repository.getApplicationAuthorityEnvelope(
      input.authorityEnvelopeId,
    );
  } catch {
    return blockedResult(
      "authority_missing",
      "The current authority envelope could not be read; no browser action was attempted.",
    );
  }
  if (initialEnvelope === null) {
    return blockedResult(
      "authority_missing",
      "The current authority envelope is missing; no browser action was attempted.",
    );
  }
  if (
    initialEnvelope.id !== input.authorityEnvelopeId ||
    initialEnvelope.revision !== input.authorityRevision ||
    initialEnvelope.mode !== input.savedMode ||
    !isActiveApplicationAuthorityEnvelope(initialEnvelope, input.now) ||
    !samePolicyIdentity(
      initialEnvelope.decisionPolicy,
      input.currentPolicyFacts.policy,
    )
  ) {
    return blockedResult(
      "preflight_authority_mismatch",
      "The current authority mode, revision, policy, or lifecycle no longer matches this attempt; no browser observation or action was attempted.",
    );
  }

  if (
    typeof input.browserRuntime.observeApplicationForm !== "function" ||
    typeof input.browserRuntime.executeExactlyOneFinalAction !== "function"
  ) {
    return blockedResult(
      "immediate_recheck_failed",
      "The configured browser runtime does not expose the main-process application hands; no action was attempted.",
    );
  }

  let observation: ApplicationFormObservation;
  try {
    observation = await input.browserRuntime.observeApplicationForm(
      input.source,
      { pageBindingKey: input.lineage.resultId },
    );
  } catch {
    return blockedResult(
      "immediate_recheck_failed",
      "The current application form could not be observed safely; no action was attempted.",
    );
  }

  if (!hasExactOneFinalControl(observation)) {
    return blockedResult(
      "ambiguous_final_control",
      "The current application page did not expose exactly one complete final control; no action was attempted.",
    );
  }

  const pageOrigin = observation.page.origin;
  const control = observation.controls[0];
  if (!pageOrigin || !control) {
    return blockedResult(
      "origin_not_allowed",
      "The current application form has no safe HTTP(S) origin or final control; no action was attempted.",
    );
  }

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

  let authorityVetoed = false;
  const veto = async (): Promise<boolean> => {
    if (input.signal?.aborted) {
      return false;
    }

    let currentEnvelope: NonNullable<typeof initialEnvelope> | null;
    try {
      currentEnvelope = await input.repository.getApplicationAuthorityEnvelope(
        preflight.authorityEnvelopeId,
      );
    } catch {
      authorityVetoed = true;
      return false;
    }

    const authorityStillMatches = Boolean(
      currentEnvelope &&
      currentEnvelope.id === preflight.authorityEnvelopeId &&
      currentEnvelope.revision === preflight.authorityRevision &&
      currentEnvelope.mode === input.savedMode &&
      isActiveApplicationAuthorityEnvelope(currentEnvelope, input.now) &&
      samePolicyIdentity(
        currentEnvelope.decisionPolicy,
        input.currentPolicyFacts.policy,
      ),
    );
    if (!authorityStillMatches) {
      authorityVetoed = true;
    }
    return authorityStillMatches;
  };

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
      expectedObservation: executorInput.preflight.formObservation,
      expectedControl: executorInput.preflight.finalControl,
      expectedPageOrigin: preflightOrigin,
      allowedOrigins: initialEnvelope.allowedOrigins,
      veto,
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
        authorityVetoed,
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
