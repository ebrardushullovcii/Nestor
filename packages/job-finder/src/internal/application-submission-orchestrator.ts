import type { SendGuards } from "@nestor/db/job-store";
import { SubmissionExecutionGrantSchema } from "@nestor/contracts";
import {
  SubmissionArmedMarkerSchema,
  SubmissionOutcomeRecordSchema,
  type ApplicationAutomationMode,
  type Sha256Hex,
  type SubmissionAnswerSnapshotIdentity,
  type SubmissionExecutionGrant,
  type SubmissionFinalControlIdentity,
  type SubmissionIdempotencyRecord,
  type SubmissionObservationIdentity,
  type SubmissionOutcomeEvidenceEntry,
  type SubmissionOutcomeRecord,
  type SubmissionOutcomeRetryEligibility,
  type SubmissionPreflightRecord,
} from "@nestor/contracts";

import {
  evaluateApplicationSubmissionPolicy,
  type AuthorizedApplicationSubmission,
  type BlockedApplicationSubmission,
  type CurrentApplicationSubmissionPolicyFacts,
  type SubmissionIdempotencyState,
  type SubmissionPolicyBlockReason,
} from "./application-submission-policy";

/**
 * The authority methods required by this synthetic slice. Keeping this
 * narrower than the send guards makes it impossible for the executor to
 * reach unrelated workspace state and documents the persistence boundary.
 */
export type SyntheticSubmissionAuthorityRepository = Pick<
  SendGuards,
  | "commitSubmissionPreflight"
  | "getApplicationAuthorityEnvelope"
  | "getSubmissionPreflightRecord"
  | "getSubmissionExecutionGrant"
  | "listSubmissionExecutionGrants"
  | "commitSubmissionExecutionGrant"
  | "getSubmissionIdempotencyRecord"
  | "getSubmissionOutcomeRecord"
  | "authorizeAndArmSubmissionAttempt"
  | "commitSubmissionOutcome"
  | "recoverArmedSubmissionAttempts"
>;

export interface SyntheticSubmissionObservation {
  origin: string;
  formObservation: SubmissionObservationIdentity;
  resumeSha256: Sha256Hex;
  answers: SubmissionAnswerSnapshotIdentity;
  finalControl: SubmissionFinalControlIdentity;
  remainingRunCapacity: number;
  currentPolicyFacts: CurrentApplicationSubmissionPolicyFacts;
}

/**
 * A synthetic executor has no page, browser, credentials, or navigation
 * primitive. It receives only the immutable binding that a future browser
 * hands implementation will consume. Its result is deliberately small so
 * malformed or unverifiable reports fail closed in the orchestrator.
 */
export interface SyntheticSubmissionExecutorInput {
  authorization: AuthorizedApplicationSubmission;
  preflight: SubmissionPreflightRecord;
  now: string;
}

export type SyntheticSubmissionExecutorResult = {
  browserAction?: SubmissionOutcomeRecord["browserAction"];
} & (
  | {
      outcome: "submitted";
      verifiedAt: string;
      evidence: readonly SubmissionOutcomeEvidenceEntry[];
    }
  | {
      outcome: "not_submitted";
      evidence?: readonly SubmissionOutcomeEvidenceEntry[];
      retry: SubmissionOutcomeRetryEligibility;
    }
  | {
      outcome: "outcome_uncertain";
      evidence?: readonly SubmissionOutcomeEvidenceEntry[];
    }
);

export interface SyntheticSubmissionExecutor {
  execute(
    input: SyntheticSubmissionExecutorInput,
  ): Promise<SyntheticSubmissionExecutorResult>;
}

export interface RunSyntheticApplicationSubmissionInput {
  repository: SyntheticSubmissionAuthorityRepository;
  preflight: SubmissionPreflightRecord;
  savedMode: ApplicationAutomationMode;
  jobId: string;
  campaignId: string | null;
  observation: SyntheticSubmissionObservation;
  now: string;
  executionGrantId?: string | null;
  /**
   * The person pressed Send on an "Ask before sending" application. That
   * press is the confirmation the mode asks for; it becomes the execution
   * grant, issued here right after the preflight it must bind to exists.
   */
  personConfirmation?: { grantedAt: string; expiresAt: string } | null;
  executor: SyntheticSubmissionExecutor;
}

export const syntheticSubmissionOrchestratorBlockReasons = [
  "preflight_conflict",
  "authority_missing",
  "preflight_missing",
  "preflight_changed",
  "idempotency_missing",
  "idempotency_lineage_mismatch",
  "execution_grant_missing",
  "execution_grant_stale",
  "immediate_recheck_failed",
  "arm_rejected",
  "outcome_commit_failed",
] as const;
export type SyntheticSubmissionOrchestratorBlockReason =
  (typeof syntheticSubmissionOrchestratorBlockReasons)[number];

export type SyntheticSubmissionBlockedResult = {
  status: "blocked";
  reason:
    | SubmissionPolicyBlockReason
    | SyntheticSubmissionOrchestratorBlockReason;
  detail: string;
  decision: BlockedApplicationSubmission | null;
  preflight: SubmissionPreflightRecord | null;
  idempotency: SubmissionIdempotencyRecord | null;
  executionGrant: SubmissionExecutionGrant | null;
};

export type SyntheticSubmissionRecordedNotSubmittedResult = {
  status: "recorded_not_submitted";
  authorization: AuthorizedApplicationSubmission;
  outcome: SubmissionOutcomeRecord;
  executionGrant: SubmissionExecutionGrant | null;
};

export type SyntheticSubmissionSubmittedResult = {
  status: "submitted";
  authorization: AuthorizedApplicationSubmission;
  outcome: SubmissionOutcomeRecord;
  executionGrant: SubmissionExecutionGrant | null;
};

export type SyntheticSubmissionUncertainResult = {
  status: "outcome_uncertain";
  authorization: AuthorizedApplicationSubmission;
  outcome: SubmissionOutcomeRecord;
  executionGrant: SubmissionExecutionGrant | null;
  cause:
    | "executor_reported_uncertain"
    | "executor_error"
    | "invalid_executor_result"
    | "post_arm_recheck_failed"
    | "outcome_commit_failed";
};

export type SyntheticSubmissionRecoveryNeededResult = {
  status: "recovery_needed";
  authorization: AuthorizedApplicationSubmission | null;
  outcome: SubmissionOutcomeRecord | null;
  executionGrant: SubmissionExecutionGrant | null;
  idempotency: SubmissionIdempotencyRecord | null;
  cause: "recovery_rejected" | "unsupported_durable_outcome";
  detail: string;
};

export type SyntheticSubmissionOrchestrationResult =
  | SyntheticSubmissionBlockedResult
  | SyntheticSubmissionSubmittedResult
  | SyntheticSubmissionRecordedNotSubmittedResult
  | SyntheticSubmissionUncertainResult
  | SyntheticSubmissionRecoveryNeededResult;

interface DurableSubmissionState {
  envelope: Awaited<
    ReturnType<
      SyntheticSubmissionAuthorityRepository["getApplicationAuthorityEnvelope"]
    >
  >;
  preflight: Awaited<
    ReturnType<
      SyntheticSubmissionAuthorityRepository["getSubmissionPreflightRecord"]
    >
  >;
  idempotency: Awaited<
    ReturnType<
      SyntheticSubmissionAuthorityRepository["getSubmissionIdempotencyRecord"]
    >
  >;
  executionGrant: SubmissionExecutionGrant | null;
  executionGrants: readonly SubmissionExecutionGrant[];
}

const submissionTransitionTails = new WeakMap<
  object,
  Map<string, Promise<void>>
>();

/** Serialize every synthetic attempt sharing one repository and idempotency key. */
async function withSubmissionTransition<T>(
  repository: object,
  idempotencyKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  let tails = submissionTransitionTails.get(repository);
  if (!tails) {
    tails = new Map<string, Promise<void>>();
    submissionTransitionTails.set(repository, tails);
  }

  const previous = tails.get(idempotencyKey) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  tails.set(idempotencyKey, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (tails.get(idempotencyKey) === tail) {
      tails.delete(idempotencyKey);
    }
  }
}

function blockedResult(input: {
  reason:
    | SubmissionPolicyBlockReason
    | SyntheticSubmissionOrchestratorBlockReason;
  detail: string;
  decision?: BlockedApplicationSubmission | null;
  preflight?: SubmissionPreflightRecord | null;
  idempotency?: SubmissionIdempotencyRecord | null;
  executionGrant?: SubmissionExecutionGrant | null;
}): SyntheticSubmissionBlockedResult {
  return {
    status: "blocked",
    reason: input.reason,
    detail: input.detail,
    decision: input.decision ?? null,
    preflight: input.preflight ?? null,
    idempotency: input.idempotency ?? null,
    executionGrant: input.executionGrant ?? null,
  };
}

function samePreflight(
  left: SubmissionPreflightRecord,
  right: SubmissionPreflightRecord,
): boolean {
  return (
    left.id === right.id &&
    left.idempotencyKey === right.idempotencyKey &&
    left.runId === right.runId &&
    left.jobId === right.jobId &&
    left.resultId === right.resultId &&
    left.applicationRecordId === right.applicationRecordId &&
    left.campaignId === right.campaignId &&
    left.origin === right.origin &&
    left.authorityEnvelopeId === right.authorityEnvelopeId &&
    left.authorityRevision === right.authorityRevision &&
    left.decisionPolicy?.version === right.decisionPolicy?.version &&
    left.decisionPolicy?.revision === right.decisionPolicy?.revision &&
    left.decisionPolicy?.digest === right.decisionPolicy?.digest &&
    left.formObservation.id === right.formObservation.id &&
    left.formObservation.revision === right.formObservation.revision &&
    left.formObservation.digest === right.formObservation.digest &&
    left.resumeSha256 === right.resumeSha256 &&
    left.answers.revision === right.answers.revision &&
    left.answers.digest === right.answers.digest &&
    left.finalControl.signature === right.finalControl.signature &&
    left.finalControl.ref === right.finalControl.ref &&
    left.remainingRunCapacityBefore === right.remainingRunCapacityBefore &&
    left.createdAt === right.createdAt
  );
}

function sameIdempotencyLineage(
  idempotency: SubmissionIdempotencyRecord,
  preflight: SubmissionPreflightRecord,
): boolean {
  return (
    idempotency.idempotencyKey === preflight.idempotencyKey &&
    idempotency.preflightId === preflight.id &&
    idempotency.authorityEnvelopeId === preflight.authorityEnvelopeId &&
    idempotency.authorityRevision === preflight.authorityRevision &&
    idempotency.runId === preflight.runId &&
    idempotency.jobId === preflight.jobId &&
    idempotency.resultId === preflight.resultId &&
    idempotency.applicationRecordId === preflight.applicationRecordId
  );
}

function toPolicyIdempotencyState(
  idempotency: SubmissionIdempotencyRecord,
): SubmissionIdempotencyState {
  switch (idempotency.status) {
    case "available":
      return "unused";
    case "outcome_uncertain":
      return "outcome_uncertain";
    case "armed":
    case "resolved":
    case "revoked":
      // A resolved, revoked, or unexpectedly armed key is never reusable.
      return "executed";
  }
}

function isSyntheticSubmissionExecutorResult(
  value: unknown,
): value is SyntheticSubmissionExecutorResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const outcome = (value as { outcome?: unknown }).outcome;
  return (
    outcome === "submitted" ||
    outcome === "not_submitted" ||
    outcome === "outcome_uncertain"
  );
}

async function readDurableSubmissionState(
  input: RunSyntheticApplicationSubmissionInput,
  preflightId: string,
): Promise<DurableSubmissionState> {
  const [envelope, preflight, idempotency, executionGrants, executionGrant] =
    await Promise.all([
      input.repository.getApplicationAuthorityEnvelope(
        input.preflight.authorityEnvelopeId,
      ),
      input.repository.getSubmissionPreflightRecord(preflightId),
      input.repository.getSubmissionIdempotencyRecord(
        input.preflight.idempotencyKey,
      ),
      input.repository.listSubmissionExecutionGrants({ preflightId }),
      input.executionGrantId
        ? input.repository.getSubmissionExecutionGrant(input.executionGrantId)
        : Promise.resolve(null),
    ]);

  return { envelope, preflight, idempotency, executionGrant, executionGrants };
}

function policyInput(
  input: RunSyntheticApplicationSubmissionInput,
  state: DurableSubmissionState,
  preflight: SubmissionPreflightRecord,
  idempotency: SubmissionIdempotencyState,
  executionGrant: SubmissionExecutionGrant | null,
) {
  if (!state.envelope) {
    return null;
  }

  // Autonomous authority must reject even a durable grant that was not
  // supplied by the caller. The repository list reread makes this symmetric
  // with the transaction-current arm operation.
  const currentExecutionGrant =
    executionGrant ??
    (input.savedMode === "autonomous_submit"
      ? (state.executionGrants[0] ?? null)
      : null);

  return {
    now: input.now,
    savedMode: input.savedMode,
    envelope: state.envelope,
    preflight,
    jobId: input.jobId,
    campaignId: input.campaignId,
    origin: input.observation.origin,
    formObservation: input.observation.formObservation,
    resumeSha256: input.observation.resumeSha256,
    answers: input.observation.answers,
    finalControl: input.observation.finalControl,
    remainingRunCapacity: input.observation.remainingRunCapacity,
    idempotency,
    executionGrant: currentExecutionGrant,
    currentPolicyFacts: input.observation.currentPolicyFacts,
  };
}

function buildArmedMarker(
  preflight: SubmissionPreflightRecord,
  armedAt: string,
) {
  return SubmissionArmedMarkerSchema.parse({
    id: `armed_${preflight.id}`,
    idempotencyKey: preflight.idempotencyKey,
    preflightId: preflight.id,
    authorityEnvelopeId: preflight.authorityEnvelopeId,
    authorityRevision: preflight.authorityRevision,
    runId: preflight.runId,
    jobId: preflight.jobId,
    resultId: preflight.resultId,
    applicationRecordId: preflight.applicationRecordId,
    armedAt,
  });
}

function buildOutcome(
  preflight: SubmissionPreflightRecord,
  authorization: AuthorizedApplicationSubmission,
  now: string,
  executorResult: SyntheticSubmissionExecutorResult,
): SubmissionOutcomeRecord {
  if (executorResult.outcome === "submitted") {
    return SubmissionOutcomeRecordSchema.parse({
      id: `outcome_${preflight.id}`,
      preflightId: authorization.preflightId,
      idempotencyKey: authorization.idempotencyKey,
      authorityEnvelopeId: authorization.authorityEnvelopeId,
      authorityRevision: authorization.authorityRevision,
      runId: authorization.runId,
      jobId: authorization.jobId,
      resultId: authorization.resultId,
      applicationRecordId: authorization.applicationRecordId,
      attemptedAt: now,
      verifiedAt: executorResult.verifiedAt,
      evidence: [...executorResult.evidence],
      ...(executorResult.browserAction
        ? { browserAction: executorResult.browserAction }
        : {}),
      retry: { eligible: false, blockReason: "submission_confirmed" },
      outcome: "submitted",
    });
  }

  if (executorResult.outcome === "not_submitted") {
    return SubmissionOutcomeRecordSchema.parse({
      id: `outcome_${preflight.id}`,
      preflightId: authorization.preflightId,
      idempotencyKey: authorization.idempotencyKey,
      authorityEnvelopeId: authorization.authorityEnvelopeId,
      authorityRevision: authorization.authorityRevision,
      runId: authorization.runId,
      jobId: authorization.jobId,
      resultId: authorization.resultId,
      applicationRecordId: authorization.applicationRecordId,
      attemptedAt: now,
      verifiedAt: null,
      evidence: [...(executorResult.evidence ?? [])],
      ...(executorResult.browserAction
        ? { browserAction: executorResult.browserAction }
        : {}),
      retry: executorResult.retry,
      outcome: "not_submitted",
    });
  }

  return SubmissionOutcomeRecordSchema.parse({
    id: `outcome_${preflight.id}`,
    preflightId: authorization.preflightId,
    idempotencyKey: authorization.idempotencyKey,
    authorityEnvelopeId: authorization.authorityEnvelopeId,
    authorityRevision: authorization.authorityRevision,
    runId: authorization.runId,
    jobId: authorization.jobId,
    resultId: authorization.resultId,
    applicationRecordId: authorization.applicationRecordId,
    attemptedAt: now,
    verifiedAt: null,
    evidence: [...(executorResult.evidence ?? [])],
    ...(executorResult.browserAction
      ? { browserAction: executorResult.browserAction }
      : {}),
    retry: { eligible: false, blockReason: "outcome_uncertain" },
    outcome: "outcome_uncertain",
  });
}

function buildUncertainOutcome(
  preflight: SubmissionPreflightRecord,
  authorization: AuthorizedApplicationSubmission,
  now: string,
): SubmissionOutcomeRecord {
  return SubmissionOutcomeRecordSchema.parse({
    id: `outcome_${preflight.id}`,
    preflightId: authorization.preflightId,
    idempotencyKey: authorization.idempotencyKey,
    authorityEnvelopeId: authorization.authorityEnvelopeId,
    authorityRevision: authorization.authorityRevision,
    runId: authorization.runId,
    jobId: authorization.jobId,
    resultId: authorization.resultId,
    applicationRecordId: authorization.applicationRecordId,
    outcome: "outcome_uncertain",
    attemptedAt: now,
    verifiedAt: null,
    evidence: [],
    retry: { eligible: false, blockReason: "outcome_uncertain" },
  });
}

async function recoverOutcomeByPreflight(
  repository: SyntheticSubmissionAuthorityRepository,
  preflight: SubmissionPreflightRecord,
  now: string,
): Promise<
  | { status: "recovered"; outcome: SubmissionOutcomeRecord }
  | { status: "recovery_needed"; detail: string }
> {
  try {
    const recovered = await repository.recoverArmedSubmissionAttempts({ now });
    const recoveredForKey = recovered.find(
      (outcome) => outcome.idempotencyKey === preflight.idempotencyKey,
    );
    if (recoveredForKey) {
      return { status: "recovered", outcome: recoveredForKey };
    }

    const existing = await repository.getSubmissionOutcomeRecord(
      `outcome_${preflight.id}`,
    );
    if (existing) {
      return { status: "recovered", outcome: existing };
    }

    return {
      status: "recovery_needed",
      detail:
        "Durable recovery completed without producing an outcome for the armed attempt; no executor call is permitted.",
    };
  } catch {
    return {
      status: "recovery_needed",
      detail:
        "Durable recovery was rejected or unavailable for the armed attempt; no executor call is permitted.",
    };
  }
}

function recoveryNeededResult(input: {
  authorization?: AuthorizedApplicationSubmission | null;
  outcome?: SubmissionOutcomeRecord | null;
  executionGrant?: SubmissionExecutionGrant | null;
  idempotency?: SubmissionIdempotencyRecord | null;
  cause?: "recovery_rejected" | "unsupported_durable_outcome";
  detail: string;
}): SyntheticSubmissionRecoveryNeededResult {
  return {
    status: "recovery_needed",
    authorization: input.authorization ?? null,
    outcome: input.outcome ?? null,
    executionGrant: input.executionGrant ?? null,
    idempotency: input.idempotency ?? null,
    cause: input.cause ?? "recovery_rejected",
    detail: input.detail,
  };
}

function resultFromOutcome(
  outcome: SubmissionOutcomeRecord,
  authorization: AuthorizedApplicationSubmission,
  executionGrant: SubmissionExecutionGrant | null,
  cause:
    | "executor_reported_uncertain"
    | "executor_error"
    | "invalid_executor_result"
    | "post_arm_recheck_failed"
    | "outcome_commit_failed"
    | null = null,
):
  | SyntheticSubmissionSubmittedResult
  | SyntheticSubmissionRecordedNotSubmittedResult
  | SyntheticSubmissionUncertainResult
  | SyntheticSubmissionRecoveryNeededResult {
  if (outcome.outcome === "submitted") {
    return {
      status: "submitted",
      authorization,
      outcome,
      executionGrant,
    };
  }

  if (outcome.outcome === "outcome_uncertain") {
    return {
      status: "outcome_uncertain",
      authorization,
      outcome,
      executionGrant,
      cause: cause ?? "outcome_commit_failed",
    };
  }

  if (outcome.outcome === "not_submitted") {
    return {
      status: "recorded_not_submitted",
      authorization,
      outcome,
      executionGrant,
    };
  }

  return recoveryNeededResult({
    authorization,
    executionGrant,
    cause: "unsupported_durable_outcome",
    detail: "The durable record contains an unsupported outcome.",
  });
}

/**
 * Runs one local synthetic authority attempt. This function is intentionally
 * not called by the production application routes; it is the typed seam for a
 * later browser-runtime executor and local acceptance fixtures only.
 */
export async function runSyntheticApplicationSubmission(
  input: RunSyntheticApplicationSubmissionInput,
): Promise<SyntheticSubmissionOrchestrationResult> {
  return withSubmissionTransition(
    input.repository,
    input.preflight.idempotencyKey,
    async () => {
      const committedPreflight =
        await input.repository.commitSubmissionPreflight(input.preflight);
      if (committedPreflight.status === "conflict") {
        return blockedResult({
          reason: "preflight_conflict",
          detail:
            "The idempotency key already belongs to a different immutable preflight; no synthetic action was attempted.",
          preflight: committedPreflight.current,
        });
      }

      const preflight = committedPreflight.preflight;
      // Issue the person's grant now that the preflight it binds to exists.
      let confirmedGrantId: string | null = null;
      if (
        input.personConfirmation &&
        input.savedMode === "confirm_before_submit"
      ) {
        const committedGrant =
          await input.repository.commitSubmissionExecutionGrant(
            SubmissionExecutionGrantSchema.parse({
              id: `grant_${preflight.id}`,
              preflightId: preflight.id,
              idempotencyKey: preflight.idempotencyKey,
              runId: preflight.runId,
              jobId: preflight.jobId,
              resultId: preflight.resultId,
              applicationRecordId: preflight.applicationRecordId,
              authorityEnvelopeId: preflight.authorityEnvelopeId,
              authorityRevision: preflight.authorityRevision,
              mode: "confirm_before_submit",
              status: "active",
              grantedBy: "user",
              grantedAt: input.personConfirmation.grantedAt,
              expiresAt: input.personConfirmation.expiresAt,
              revokedAt: null,
              consumedAt: null,
            }),
          );
        if (
          committedGrant.status === "created" ||
          committedGrant.status === "duplicate"
        ) {
          confirmedGrantId = committedGrant.grant.id;
        }
      }
      if (confirmedGrantId) {
        input = { ...input, executionGrantId: confirmedGrantId };
      }
      let durable = await readDurableSubmissionState(input, preflight.id);

      if (!durable.preflight) {
        return blockedResult({
          reason: "preflight_missing",
          detail:
            "The committed preflight could not be reread; no action was attempted.",
        });
      }
      if (!samePreflight(durable.preflight, preflight)) {
        return blockedResult({
          reason: "preflight_changed",
          detail:
            "The durable preflight changed after commit; no action was attempted.",
          preflight: durable.preflight,
          idempotency: durable.idempotency,
          executionGrant: durable.executionGrant,
        });
      }
      if (!durable.idempotency) {
        return blockedResult({
          reason: "idempotency_missing",
          detail:
            "The preflight has no durable idempotency record; no action was attempted.",
          preflight,
          executionGrant: durable.executionGrant,
        });
      }
      if (!sameIdempotencyLineage(durable.idempotency, preflight)) {
        return blockedResult({
          reason: "idempotency_lineage_mismatch",
          detail:
            "The durable idempotency record does not bind the exact preflight lineage; no action was attempted.",
          preflight,
          idempotency: durable.idempotency,
          executionGrant: durable.executionGrant,
        });
      }
      if (!durable.envelope) {
        return blockedResult({
          reason: "authority_missing",
          detail:
            "The authority envelope for this preflight could not be reread; no action was attempted.",
          preflight,
          idempotency: durable.idempotency,
          executionGrant: durable.executionGrant,
        });
      }

      // An armed key means the previous process may have crossed the action
      // boundary. Recover it before policy evaluation; never treat armed as
      // available and never retry it automatically.
      if (durable.idempotency.status === "armed") {
        const recovery = await recoverOutcomeByPreflight(
          input.repository,
          preflight,
          input.now,
        );
        if (recovery.status === "recovery_needed") {
          return recoveryNeededResult({
            idempotency: durable.idempotency,
            executionGrant: durable.executionGrant,
            detail: recovery.detail,
          });
        }
        durable = await readDurableSubmissionState(input, preflight.id);
      }

      if (!durable.preflight || !durable.idempotency || !durable.envelope) {
        return blockedResult({
          reason: "immediate_recheck_failed",
          detail:
            "Durable authority state disappeared during the immediate recheck; no action was attempted.",
          preflight: durable.preflight,
          idempotency: durable.idempotency,
          executionGrant: durable.executionGrant,
        });
      }

      const initialPolicyInput = policyInput(
        input,
        durable,
        durable.preflight,
        toPolicyIdempotencyState(durable.idempotency),
        durable.executionGrant,
      );
      if (!initialPolicyInput) {
        return blockedResult({
          reason: "authority_missing",
          detail:
            "No current authority envelope is available; no action was attempted.",
          preflight: durable.preflight,
          idempotency: durable.idempotency,
          executionGrant: durable.executionGrant,
        });
      }

      const initialDecision =
        evaluateApplicationSubmissionPolicy(initialPolicyInput);
      if (initialDecision.status === "blocked") {
        return blockedResult({
          reason: initialDecision.reason,
          detail: initialDecision.detail,
          decision: initialDecision,
          preflight: durable.preflight,
          idempotency: durable.idempotency,
          executionGrant: durable.executionGrant,
        });
      }

      // Read all durable authority state a second time immediately before the
      // grant/arm transitions. This catches envelope revocation, a changed
      // preflight, or a competing use of the idempotency key.
      durable = await readDurableSubmissionState(input, preflight.id);
      if (
        !durable.preflight ||
        !durable.idempotency ||
        !durable.envelope ||
        !samePreflight(durable.preflight, preflight) ||
        !sameIdempotencyLineage(durable.idempotency, preflight)
      ) {
        return blockedResult({
          reason: "immediate_recheck_failed",
          detail:
            "Durable authority state no longer matches the exact preflight lineage; no action was attempted.",
          preflight: durable.preflight,
          idempotency: durable.idempotency,
          executionGrant: durable.executionGrant,
        });
      }

      const secondPolicyInput = policyInput(
        input,
        durable,
        durable.preflight,
        toPolicyIdempotencyState(durable.idempotency),
        durable.executionGrant,
      );
      if (!secondPolicyInput) {
        return blockedResult({
          reason: "authority_missing",
          detail:
            "The authority envelope disappeared during the immediate recheck; no action was attempted.",
          preflight: durable.preflight,
          idempotency: durable.idempotency,
          executionGrant: durable.executionGrant,
        });
      }
      const secondDecision =
        evaluateApplicationSubmissionPolicy(secondPolicyInput);
      if (secondDecision.status === "blocked") {
        return blockedResult({
          reason: secondDecision.reason,
          detail: secondDecision.detail,
          decision: secondDecision,
          preflight: durable.preflight,
          idempotency: durable.idempotency,
          executionGrant: durable.executionGrant,
        });
      }

      const authorization = secondDecision;
      const grantBeforeArm = durable.executionGrant;
      if (authorization.mode === "confirm_before_submit") {
        if (!grantBeforeArm) {
          return blockedResult({
            reason: "execution_grant_missing",
            detail:
              "The confirm-before-submit attempt has no current durable execution grant; no action was attempted.",
            preflight: durable.preflight,
            idempotency: durable.idempotency,
          });
        }
      }

      let armed;
      try {
        armed = await input.repository.authorizeAndArmSubmissionAttempt({
          preflight: durable.preflight,
          expectedIdempotencyRevision: durable.idempotency.revision,
          mode: authorization.mode,
          marker: buildArmedMarker(durable.preflight, input.now),
          executionGrantId:
            authorization.mode === "confirm_before_submit"
              ? (grantBeforeArm?.id ?? null)
              : null,
          now: input.now,
        });
      } catch {
        const recovery = await recoverOutcomeByPreflight(
          input.repository,
          durable.preflight,
          input.now,
        );
        if (recovery.status === "recovery_needed") {
          return recoveryNeededResult({
            authorization,
            executionGrant: grantBeforeArm,
            idempotency: durable.idempotency,
            detail: recovery.detail,
          });
        }
        if (recovery.outcome) {
          return resultFromOutcome(
            recovery.outcome,
            authorization,
            grantBeforeArm,
            "post_arm_recheck_failed",
          );
        }
        return recoveryNeededResult({
          authorization,
          executionGrant: grantBeforeArm,
          idempotency: durable.idempotency,
          detail:
            "The compound authorize-and-arm transition failed ambiguously; recovery is required and no synthetic action was attempted.",
        });
      }

      if (armed.status !== "armed") {
        let detail: string;
        if ("reason" in armed) {
          detail = `The compound authorize-and-arm transition was rejected (${armed.reason}); no synthetic action was attempted.`;
        } else {
          detail =
            "The compound authorize-and-arm transition found an existing armed marker; no synthetic action was attempted.";
        }
        return blockedResult({
          reason: "arm_rejected",
          detail,
          preflight: durable.preflight,
          idempotency: armed.idempotency,
          executionGrant: armed.executionGrant,
        });
      }

      const armedExecutionGrant = armed.executionGrant;

      // Re-read after the armed boundary. A changed envelope or lineage now
      // resolves the armed attempt to uncertainty rather than allowing action.
      const armedState = await readDurableSubmissionState(input, preflight.id);
      const armedPolicyInput =
        armedState.preflight && armedState.idempotency && armedState.envelope
          ? policyInput(
              input,
              armedState,
              armedState.preflight,
              "unused",
              grantBeforeArm,
            )
          : null;
      const armedDecision = armedPolicyInput
        ? evaluateApplicationSubmissionPolicy(armedPolicyInput)
        : null;
      const armedStateMatches = Boolean(
        armedState.preflight &&
        armedState.idempotency &&
        armedState.envelope &&
        samePreflight(armedState.preflight, preflight) &&
        sameIdempotencyLineage(armedState.idempotency, preflight) &&
        armedState.idempotency.status === "armed" &&
        armedState.idempotency.revision === armed.idempotency.revision &&
        armedState.envelope.id === authorization.authorityEnvelopeId &&
        armedState.envelope.revision === authorization.authorityRevision &&
        (authorization.mode === "autonomous_submit" ||
          (armedExecutionGrant?.status === "consumed" &&
            armedState.executionGrant?.id === armedExecutionGrant.id &&
            armedState.executionGrant.status === "consumed")) &&
        armedDecision?.status === "authorized",
      );
      if (!armedStateMatches) {
        const recovery = await recoverOutcomeByPreflight(
          input.repository,
          preflight,
          input.now,
        );
        if (recovery.status === "recovery_needed") {
          return recoveryNeededResult({
            authorization,
            executionGrant: armedExecutionGrant,
            idempotency: armedState.idempotency,
            detail: recovery.detail,
          });
        }
        if (recovery.outcome) {
          return resultFromOutcome(
            recovery.outcome,
            authorization,
            armedExecutionGrant,
            "post_arm_recheck_failed",
          );
        }
        return blockedResult({
          reason: "immediate_recheck_failed",
          detail:
            "The armed attempt failed its immediate authority recheck; no synthetic action was attempted.",
          preflight: armedState.preflight,
          idempotency: armedState.idempotency,
          executionGrant: armedExecutionGrant,
        });
      }

      let executorResult: SyntheticSubmissionExecutorResult;
      let failureCause: "executor_error" | "invalid_executor_result" | null =
        null;
      try {
        const rawExecutorResult: unknown = await input.executor.execute({
          authorization,
          preflight,
          now: input.now,
        });
        if (!isSyntheticSubmissionExecutorResult(rawExecutorResult)) {
          executorResult = { outcome: "outcome_uncertain" };
          failureCause = "invalid_executor_result";
        } else {
          executorResult = rawExecutorResult;
        }
      } catch {
        executorResult = { outcome: "outcome_uncertain" };
        failureCause = "executor_error";
      }

      let outcome: SubmissionOutcomeRecord;
      try {
        outcome = buildOutcome(
          preflight,
          authorization,
          input.now,
          executorResult,
        );
      } catch {
        outcome = buildUncertainOutcome(preflight, authorization, input.now);
        failureCause = "invalid_executor_result";
      }

      let committed;
      try {
        committed = await input.repository.commitSubmissionOutcome({
          outcome,
          expectedIdempotencyRevision: armed.idempotency.revision,
        });
      } catch {
        committed = null;
      }

      if (
        committed &&
        (committed.status === "recorded" || committed.status === "duplicate")
      ) {
        return resultFromOutcome(
          committed.outcome,
          authorization,
          armedExecutionGrant,
          committed.outcome.outcome === "outcome_uncertain"
            ? (failureCause ?? "executor_reported_uncertain")
            : null,
        );
      }

      // The executor has crossed the armed boundary. If outcome persistence
      // fails, recover the key to durable uncertainty before returning.
      const recovery = await recoverOutcomeByPreflight(
        input.repository,
        preflight,
        input.now,
      );
      if (recovery.status === "recovery_needed") {
        return recoveryNeededResult({
          authorization,
          executionGrant: armedExecutionGrant,
          idempotency: armed.idempotency,
          detail: recovery.detail,
        });
      }
      return resultFromOutcome(
        recovery.outcome,
        authorization,
        armedExecutionGrant,
        "outcome_commit_failed",
      );
    },
  );
}

/** Explicit startup/restart hook for a local synthetic authority harness. */
export function recoverSyntheticApplicationSubmissions(
  repository: SyntheticSubmissionAuthorityRepository,
  now: string,
): Promise<
  | { status: "recovered"; outcomes: readonly SubmissionOutcomeRecord[] }
  | { status: "recovery_needed"; outcomes: readonly []; detail: string }
> {
  return repository
    .recoverArmedSubmissionAttempts({ now })
    .then((outcomes) => ({ status: "recovered" as const, outcomes }))
    .catch(() => ({
      status: "recovery_needed" as const,
      outcomes: [] as const,
      detail:
        "Durable recovery was rejected or unavailable; armed attempts remain recovery-needed and must not be retried.",
    }));
}
