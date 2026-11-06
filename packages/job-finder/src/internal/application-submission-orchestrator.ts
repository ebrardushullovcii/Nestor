import type { SendGuards } from "@nestor/db/job-store";
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

import type {
  AuthorizedApplicationSubmission,
  BlockedApplicationSubmission,
  CurrentApplicationSubmissionPolicyFacts,
  SubmissionPolicyBlockReason,
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
export async function runSyntheticApplicationSubmission(input: RunSyntheticApplicationSubmissionInput): Promise<SyntheticSubmissionOrchestrationResult> {
  return withSubmissionTransition(input.repository, input.preflight.idempotencyKey, async () => {
    if (input.savedMode === "prepare_only") return blockedResult({reason:"prepare_only",detail:"This run is Fill in for me: leave the send to the person."});
    const authorization: AuthorizedApplicationSubmission = {status:"authorized", mode:input.savedMode, preflightId:input.preflight.id, idempotencyKey:input.preflight.idempotencyKey, runId:input.preflight.runId, jobId:input.preflight.jobId, resultId:input.preflight.resultId, applicationRecordId:input.preflight.applicationRecordId, authorityEnvelopeId:input.preflight.authorityEnvelopeId, authorityRevision:input.preflight.authorityRevision};
    const previous=await input.repository.getSubmissionIdempotencyRecord(input.preflight.idempotencyKey);
    if(previous && previous.status !== "available") {
      const existing=previous.outcomeId ? await input.repository.getSubmissionOutcomeRecord(previous.outcomeId) : null;
      if(existing) return resultFromOutcome(existing,authorization,null);
      const recovery=await recoverOutcomeByPreflight(input.repository,input.preflight,input.now);
      if(recovery.status==="recovered")return resultFromOutcome(recovery.outcome,authorization,null);
      return recoveryNeededResult({authorization,idempotency:previous,detail:recovery.detail});
    }
    const commit=await input.repository.commitSubmissionPreflight(input.preflight);
    if(commit.status==="conflict")return blockedResult({reason:"preflight_conflict",detail:"The send call ID is already recorded with different data. Read its ledger outcome; it was not replayed."});
    const preflight=commit.preflight;
    const marker=buildArmedMarker(preflight,input.now);
    const armed=await input.repository.authorizeAndArmSubmissionAttempt({preflight,marker,expectedIdempotencyRevision:commit.idempotency.revision,mode:input.savedMode,executionGrantId:null,now:input.now});
    if(armed.status!=="armed") {
      const recovery=await recoverOutcomeByPreflight(input.repository,preflight,input.now);
      if(recovery.status==="recovered")return resultFromOutcome(recovery.outcome,authorization,null);
      return recoveryNeededResult({authorization,detail:recovery.detail});
    }
    let outcome: SubmissionOutcomeRecord;
    try { outcome=buildOutcome(preflight,authorization,input.now,await input.executor.execute({authorization,preflight,now:input.now})); }
    catch { outcome=buildUncertainOutcome(preflight,authorization,input.now); }
    const recorded=await input.repository.commitSubmissionOutcome({outcome,expectedIdempotencyRevision:armed.idempotency.revision});
    if(recorded.status==="recorded"||recorded.status==="duplicate")return resultFromOutcome(recorded.outcome,authorization,null);
    return recoveryNeededResult({authorization,outcome,detail:"The send intent is durable but its outcome could not be saved. Do not replay this call; check the site first."});
  });
}
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
