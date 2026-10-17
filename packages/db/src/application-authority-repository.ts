import {
  ApplyJobResultSchema,
  ApplicationAuthorityEnvelopeSchema,
  ApplicationRecordSchema,
  SubmissionArmedMarkerSchema,
  SubmissionExecutionGrantSchema,
  SubmissionIdempotencyRecordSchema,
  SubmissionOutcomeRecordSchema,
  SubmissionOutcomeResolutionInputSchema,
  SubmissionPreflightRecordSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  isApprovedApplicationAnswerSnapshot,
  isActiveApplicationAuthorityEnvelope,
  isActiveSubmissionExecutionGrant,
  isSubmissionPreflightBoundToDecisionPolicy,
  serializeApplicationAuthorityDecisionPolicyForDigest,
  type ApplicationAuthorityEnvelope,
  type ApplicationEvent,
  type ApplicationRecord,
  type ApplyJobResult,
  type SubmissionArmedMarker,
  type JobFinderRepositoryState,
  type SubmissionExecutionGrant,
  type SubmissionIdempotencyRecord,
  type SubmissionOutcomeRecord,
  type SubmissionPreflightRecord,
} from "@nestor/contracts";
import { createHash } from "node:crypto";

import type {
  ApplicationAuthorityRepository,
  SubmissionAttemptArmBlockReason,
  SubmissionAttemptArmResult,
  SubmissionOutcomeResolutionResult,
} from "./application-authority-repository-types";
import { cloneValue } from "./internal/state";

interface ApplicationAuthorityStateStore {
  read(): JobFinderRepositoryState;
  mutate<T>(operation: (state: JobFinderRepositoryState) => T): T;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const SUBMISSION_OUTCOME_UNCERTAIN_SUMMARY =
  "Submission outcome needs manual verification.";
const SUBMISSION_OUTCOME_UNCERTAIN_DETAIL =
  "The employer site did not provide enough external evidence to prove whether the final action completed. Automatic retry is blocked until a person verifies the employer-site state.";
const SUBMISSION_OUTCOME_UNCERTAIN_NEXT_ACTION =
  "Verify the application on the employer site before taking another submission action.";
const SUBMISSION_NOT_SUBMITTED_SUMMARY = "Final action not submitted.";
const SUBMISSION_NOT_SUBMITTED_RETRY_NEXT_ACTION =
  "Review the prepared application before trying the final action again.";
const SUBMISSION_NOT_SUBMITTED_BLOCKED_NEXT_ACTION =
  "Review the submission blocker before taking another submission action.";
const SUBMISSION_NOT_SUBMITTED_BLOCKED_SUMMARY =
  "Automatic retry is blocked for this submission outcome. Review the application and authority state before taking another submission action.";
const APPLICATION_AUTHORITY_EVENT_HISTORY_LIMIT = 100;

function mergeApplicationEvents(
  existingEvents: readonly ApplicationEvent[],
  additionalEvents: readonly ApplicationEvent[],
): ApplicationEvent[] {
  const byId = new Map(existingEvents.map((event) => [event.id, event]));
  for (const event of additionalEvents) {
    byId.set(event.id, event);
  }

  return [...byId.values()]
    .sort((left, right) => {
      const atDifference =
        new Date(right.at).getTime() - new Date(left.at).getTime();
      return atDifference === 0
        ? left.id.localeCompare(right.id)
        : atDifference;
    })
    .slice(0, APPLICATION_AUTHORITY_EVENT_HISTORY_LIMIT);
}

function replaceById<T extends { id: string }>(values: T[], next: T): void {
  const index = values.findIndex((value) => value.id === next.id);
  if (index === -1) {
    values.push(next);
  } else {
    values[index] = next;
  }
}

function matchesPreflightLineage(
  preflight: SubmissionPreflightRecord,
  value: Pick<
    SubmissionPreflightRecord,
    | "idempotencyKey"
    | "runId"
    | "jobId"
    | "resultId"
    | "applicationRecordId"
    | "authorityEnvelopeId"
    | "authorityRevision"
  >,
): boolean {
  return (
    preflight.idempotencyKey === value.idempotencyKey &&
    preflight.runId === value.runId &&
    preflight.jobId === value.jobId &&
    preflight.resultId === value.resultId &&
    preflight.applicationRecordId === value.applicationRecordId &&
    preflight.authorityEnvelopeId === value.authorityEnvelopeId &&
    preflight.authorityRevision === value.authorityRevision
  );
}

function matchesDecisionPolicyIdentity(
  expected: SubmissionPreflightRecord["decisionPolicy"],
  actual: SubmissionPreflightRecord["decisionPolicy"],
): boolean {
  if (expected === null || actual === null) {
    return expected === actual;
  }
  return (
    expected.version === actual.version &&
    expected.revision === actual.revision &&
    expected.digest === actual.digest
  );
}

function matchesExactPreflight(
  expected: SubmissionPreflightRecord,
  actual: SubmissionPreflightRecord,
): boolean {
  return (
    expected.id === actual.id &&
    expected.idempotencyKey === actual.idempotencyKey &&
    expected.runId === actual.runId &&
    expected.jobId === actual.jobId &&
    expected.resultId === actual.resultId &&
    expected.applicationRecordId === actual.applicationRecordId &&
    expected.campaignId === actual.campaignId &&
    expected.origin === actual.origin &&
    expected.authorityEnvelopeId === actual.authorityEnvelopeId &&
    expected.authorityRevision === actual.authorityRevision &&
    matchesDecisionPolicyIdentity(
      expected.decisionPolicy,
      actual.decisionPolicy,
    ) &&
    expected.resumeSha256 === actual.resumeSha256 &&
    expected.remainingRunCapacityBefore === actual.remainingRunCapacityBefore &&
    expected.remainingDailyCapacityBefore ===
      actual.remainingDailyCapacityBefore &&
    expected.createdAt === actual.createdAt &&
    expected.formObservation.id === actual.formObservation.id &&
    expected.formObservation.revision === actual.formObservation.revision &&
    expected.formObservation.digest === actual.formObservation.digest &&
    expected.answers.revision === actual.answers.revision &&
    expected.answers.digest === actual.answers.digest &&
    expected.finalControl.signature === actual.finalControl.signature &&
    expected.finalControl.ref === actual.finalControl.ref
  );
}

/**
 * Canonicalize an origin for the transactional allowlist comparison. The
 * preflight schema already requires its stored origin to be canonical, while
 * envelope origins intentionally accept the broader user-editable form. A
 * failed parse is a deny rather than an exception so malformed persisted
 * authority data cannot widen the final-action gate.
 */
function canonicalHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function hasCoherentDecisionPolicyDigest(
  authority: ApplicationAuthorityEnvelope,
): boolean {
  const policy = authority.decisionPolicy;
  if (policy === null) {
    return false;
  }

  try {
    const serialized = serializeApplicationAuthorityDecisionPolicyForDigest({
      version: policy.version,
      answerPolicy: policy.answerPolicy,
      stopConditions: policy.stopConditions,
    });
    const digest = createHash("sha256")
      .update(serialized, "utf8")
      .digest("hex");
    return digest === policy.digest;
  } catch {
    // The envelope was already schema-validated, but keep this use-site gate
    // fail-closed if a future schema/parser change makes serialization reject.
    return false;
  }
}

function validateCurrentAuthorityPreflight(
  authority: ApplicationAuthorityEnvelope,
  preflight: SubmissionPreflightRecord,
): SubmissionAttemptArmBlockReason | null {
  // Elevated envelopes must carry a policy whose digest is a hash of the
  // canonical rules-only document. Do this before consulting any child record
  // so a corrupted policy can never authorize a grant/idempotency transition.
  if (
    authority.decisionPolicy !== null &&
    !hasCoherentDecisionPolicyDigest(authority)
  ) {
    return "authority_policy_digest_invalid";
  }

  if (authority.decisionPolicy === null) {
    return "decision_policy_mismatch";
  }

  if (!isSubmissionPreflightBoundToDecisionPolicy(preflight, authority)) {
    return "decision_policy_mismatch";
  }

  if (!isApprovedApplicationAnswerSnapshot(authority, preflight.answers)) {
    return "answer_snapshot_mismatch";
  }

  const campaignInScope =
    authority.scope.campaignId !== null &&
    authority.scope.campaignId === preflight.campaignId;
  const jobInScope = authority.scope.jobIds.includes(preflight.jobId);
  if (!campaignInScope && !jobInScope) {
    return "scope_excluded";
  }

  const preflightOrigin =
    preflight.origin === null ? null : canonicalHttpOrigin(preflight.origin);
  const allowedOrigins = new Set(
    authority.allowedOrigins.flatMap((origin) => {
      const canonical = canonicalHttpOrigin(origin);
      return canonical === null ? [] : [canonical];
    }),
  );
  if (preflightOrigin === null || !allowedOrigins.has(preflightOrigin)) {
    return "origin_not_allowed";
  }

  if (!authority.allowedResumeSha256.includes(preflight.resumeSha256)) {
    return "resume_not_allowed";
  }

  if (
    !Number.isSafeInteger(preflight.remainingRunCapacityBefore) ||
    !Number.isSafeInteger(preflight.remainingDailyCapacityBefore) ||
    preflight.remainingRunCapacityBefore <= 0 ||
    preflight.remainingDailyCapacityBefore <= 0 ||
    preflight.remainingRunCapacityBefore > authority.maxApplicationsPerRun ||
    preflight.remainingDailyCapacityBefore >
      authority.maxApplicationsPerLocalDay
  ) {
    return "capacity_invalid";
  }

  return null;
}

function matchesMarkerLineage(
  marker: SubmissionArmedMarker,
  preflight: SubmissionPreflightRecord,
): boolean {
  return (
    marker.idempotencyKey === preflight.idempotencyKey &&
    marker.preflightId === preflight.id &&
    marker.runId === preflight.runId &&
    marker.jobId === preflight.jobId &&
    marker.resultId === preflight.resultId &&
    marker.applicationRecordId === preflight.applicationRecordId &&
    marker.authorityEnvelopeId === preflight.authorityEnvelopeId &&
    marker.authorityRevision === preflight.authorityRevision
  );
}

function matchesIdempotencyLineage(
  idempotency: SubmissionIdempotencyRecord,
  preflight: SubmissionPreflightRecord,
): boolean {
  return (
    idempotency.preflightId === preflight.id &&
    matchesPreflightLineage(preflight, idempotency)
  );
}

function hasAuthoritySubmissionLifecycle(
  state: JobFinderRepositoryState,
  authorityEnvelopeId: string,
): boolean {
  return (
    state.submissionPreflights.some(
      (value) => value.authorityEnvelopeId === authorityEnvelopeId,
    ) ||
    state.submissionExecutionGrants.some(
      (value) => value.authorityEnvelopeId === authorityEnvelopeId,
    ) ||
    state.submissionIdempotencyRecords.some(
      (value) => value.authorityEnvelopeId === authorityEnvelopeId,
    ) ||
    state.submissionArmedMarkers.some(
      (value) => value.authorityEnvelopeId === authorityEnvelopeId,
    ) ||
    state.submissionOutcomeRecords.some(
      (value) => value.authorityEnvelopeId === authorityEnvelopeId,
    )
  );
}

function findActiveAuthorityConflict(
  state: JobFinderRepositoryState,
  exceptId: string | null = null,
): ApplicationAuthorityEnvelope | null {
  return (
    state.applicationAuthorityEnvelopes.find(
      (value) => value.status === "active" && value.id !== exceptId,
    ) ?? null
  );
}

/**
 * Revoke only the children that are still capable of authorizing work. A
 * consumed grant, armed attempt, or terminal idempotency record remains
 * immutable history; the active/available states are the only revocable
 * capabilities and match the standalone envelope revocation semantics.
 */
function revokeAuthorityChildren(
  state: JobFinderRepositoryState,
  authorityEnvelopeId: string,
  revokedAt: string,
): void {
  // Build and schema-validate every child before assigning either collection.
  // This preserves the same all-or-nothing behavior in the in-memory store as
  // the SQLite BEGIN IMMEDIATE wrapper when a timestamp or persisted record is
  // malformed.
  const nextGrants = state.submissionExecutionGrants.map((grant) =>
    grant.authorityEnvelopeId === authorityEnvelopeId &&
    grant.status === "active"
      ? SubmissionExecutionGrantSchema.parse({
          ...grant,
          status: "revoked",
          revokedAt,
        })
      : grant,
  );
  const nextIdempotencyRecords = state.submissionIdempotencyRecords.map(
    (idempotency) =>
      idempotency.authorityEnvelopeId === authorityEnvelopeId &&
      idempotency.status === "available"
        ? SubmissionIdempotencyRecordSchema.parse({
            ...idempotency,
            status: "revoked",
            revision: idempotency.revision + 1,
            updatedAt: revokedAt,
            revokedAt,
          })
        : idempotency,
  );
  state.submissionExecutionGrants = nextGrants;
  state.submissionIdempotencyRecords = nextIdempotencyRecords;
}

function parseAuthorityReplacementInput(input: {
  currentId: string;
  expectedRevision: number;
  replacement: ApplicationAuthorityEnvelope;
  revokedAt: string;
}): {
  currentId: string;
  expectedRevision: number;
  replacement: ApplicationAuthorityEnvelope;
  revokedAt: string;
} {
  const currentId = NonEmptyStringSchema.parse(input.currentId);
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new TypeError(
      "Application authority replacement expectedRevision must be a positive integer.",
    );
  }
  const revokedAt = IsoDateTimeSchema.parse(input.revokedAt);
  const replacement = ApplicationAuthorityEnvelopeSchema.parse(
    cloneValue(input.replacement),
  );
  if (replacement.id === currentId) {
    throw new Error(
      "Application authority replacement must use a distinct envelope id.",
    );
  }
  if (
    replacement.status !== "active" ||
    replacement.revision !== 1 ||
    replacement.revokedAt !== null
  ) {
    throw new Error(
      "Application authority replacement must be a new active envelope at revision 1.",
    );
  }
  return {
    currentId,
    expectedRevision: input.expectedRevision,
    replacement,
    revokedAt,
  };
}

function armFailure(
  status: "blocked" | "stale" | "missing",
  reason: SubmissionAttemptArmBlockReason,
  idempotency: SubmissionIdempotencyRecord | null,
  marker: SubmissionArmedMarker | null = null,
  executionGrant: SubmissionExecutionGrant | null = null,
): SubmissionAttemptArmResult {
  return {
    status,
    reason,
    idempotency,
    marker,
    executionGrant,
  };
}

function matchesOutcomeLineage(
  idempotency: SubmissionIdempotencyRecord,
  outcome: SubmissionOutcomeRecord,
): boolean {
  return (
    idempotency.idempotencyKey === outcome.idempotencyKey &&
    idempotency.preflightId === outcome.preflightId &&
    idempotency.runId === outcome.runId &&
    idempotency.jobId === outcome.jobId &&
    idempotency.resultId === outcome.resultId &&
    idempotency.applicationRecordId === outcome.applicationRecordId &&
    idempotency.authorityEnvelopeId === outcome.authorityEnvelopeId &&
    idempotency.authorityRevision === outcome.authorityRevision
  );
}

function hasDurableFinalSubmitAuthorization(
  state: JobFinderRepositoryState,
  outcome: SubmissionOutcomeRecord,
): boolean {
  const preflight =
    state.submissionPreflights.find(
      (value) => value.id === outcome.preflightId,
    ) ?? null;
  const authority =
    state.applicationAuthorityEnvelopes.find(
      (value) =>
        value.id === outcome.authorityEnvelopeId &&
        value.revision === outcome.authorityRevision,
    ) ?? null;
  const marker =
    state.submissionArmedMarkers.find(
      (value) =>
        value.preflightId === outcome.preflightId &&
        value.idempotencyKey === outcome.idempotencyKey,
    ) ?? null;
  if (
    preflight === null ||
    authority === null ||
    marker === null ||
    !matchesPreflightLineage(preflight, outcome) ||
    !matchesMarkerLineage(marker, preflight)
  ) {
    return false;
  }
  if (authority.mode === "autonomous_submit") {
    return true;
  }
  if (authority.mode !== "confirm_before_submit") {
    return false;
  }
  return state.submissionExecutionGrants.some(
    (grant) =>
      grant.preflightId === preflight.id &&
      grant.status === "consumed" &&
      matchesPreflightLineage(preflight, grant),
  );
}

/**
 * A result whose last attempt is on record as not sent can take the outcome
 * of a later attempt under a different key: the person pressed Send again
 * after nothing reached the site. A sent or uncertain outcome is never
 * replaced.
 */
function isLaterAttemptAfterNotSubmitted(
  previous: SubmissionOutcomeRecord,
  outcome: SubmissionOutcomeRecord,
): boolean {
  return (
    previous.outcome === "not_submitted" &&
    previous.idempotencyKey !== outcome.idempotencyKey &&
    previous.preflightId !== outcome.preflightId
  );
}

interface ReconciledSubmissionOutcomeProjection {
  applicationRecord: ApplicationRecord;
  result: ApplyJobResult;
}

/**
 * Reconciles a terminal submission outcome into the already persisted
 * ApplyJobResult receipt and its exact ApplicationRecord. The authority
 * outcome, result receipt, and application projection are one durable fact,
 * so callers must never be able to commit only one of them. A projection is
 * accepted only when every persisted lineage field and both parent rows match
 * the outcome exactly.
 */
function buildReconciledSubmissionOutcomeProjection(
  state: JobFinderRepositoryState,
  outcome: SubmissionOutcomeRecord,
): ReconciledSubmissionOutcomeProjection | null {
  const current =
    state.applyJobResults.find((value) => value.id === outcome.resultId) ??
    null;
  if (
    current === null ||
    current.runId !== outcome.runId ||
    current.jobId !== outcome.jobId ||
    current.applicationRecordId !== outcome.applicationRecordId
  ) {
    return null;
  }

  const receipt = current.privacyReceipt;
  if (
    receipt === null ||
    receipt.finalSubmitOccurred !== false ||
    receipt.lineage.runId !== outcome.runId ||
    receipt.lineage.jobId !== outcome.jobId ||
    receipt.lineage.resultId !== outcome.resultId ||
    receipt.lineage.applicationRecordId !== outcome.applicationRecordId
  ) {
    return null;
  }

  if (
    receipt.submissionOutcome !== null &&
    !sameValue(receipt.submissionOutcome, outcome) &&
    !isLaterAttemptAfterNotSubmitted(receipt.submissionOutcome, outcome)
  ) {
    return null;
  }

  const currentApplicationRecord =
    state.applicationRecords.find(
      (value) => value.id === outcome.applicationRecordId,
    ) ?? null;
  if (
    currentApplicationRecord === null ||
    currentApplicationRecord.jobId !== outcome.jobId
  ) {
    return null;
  }

  try {
    const finalSubmitAuthorized = hasDurableFinalSubmitAuthorization(
      state,
      outcome,
    );
    if (outcome.outcome === "submitted") {
      const verifiedAt = outcome.verifiedAt;
      if (verifiedAt === null) return null;
      const applicationRecord = ApplicationRecordSchema.parse({
        ...currentApplicationRecord,
        status: "submitted",
        lastActionLabel: "Application submitted",
        nextActionLabel: null,
        lastUpdatedAt: verifiedAt,
        lastAttemptState: "submitted",
        latestBlocker: null,
        events: mergeApplicationEvents(currentApplicationRecord.events, [
          {
            id: `event_submission_outcome_${outcome.id}`,
            at: verifiedAt,
            title: "Application submitted",
            detail:
              "The employer site confirmed that it received the application.",
            emphasis: "positive",
          },
        ]),
      });
      const result = ApplyJobResultSchema.parse({
        ...current,
        automaticSendPending: false,
        state: "submitted",
        summary: "Application submitted",
        detail: "The employer site confirmed that it received the application.",
        updatedAt: verifiedAt,
        completedAt: verifiedAt,
        blockerReason: null,
        blockerSummary: null,
        privacyReceipt: {
          ...receipt,
          finalSubmitAuthorized,
          finalSubmitOccurred: true,
          submissionOutcome: outcome,
        },
      });
      return { applicationRecord, result };
    }

    const uncertain = outcome.outcome === "outcome_uncertain";
    const applicationRecord = ApplicationRecordSchema.parse({
      ...currentApplicationRecord,
      lastActionLabel: uncertain
        ? SUBMISSION_OUTCOME_UNCERTAIN_SUMMARY
        : SUBMISSION_NOT_SUBMITTED_SUMMARY,
      nextActionLabel: uncertain
        ? SUBMISSION_OUTCOME_UNCERTAIN_NEXT_ACTION
        : outcome.retry.eligible
          ? SUBMISSION_NOT_SUBMITTED_RETRY_NEXT_ACTION
          : SUBMISSION_NOT_SUBMITTED_BLOCKED_NEXT_ACTION,
      lastUpdatedAt: outcome.attemptedAt,
      lastAttemptState:
        uncertain || !outcome.retry.eligible ? "paused" : "ready",
      latestBlocker:
        uncertain || !outcome.retry.eligible
          ? {
              code: "requires_manual_review" as const,
              summary: uncertain
                ? SUBMISSION_OUTCOME_UNCERTAIN_NEXT_ACTION
                : SUBMISSION_NOT_SUBMITTED_BLOCKED_SUMMARY,
            }
          : null,
      events: mergeApplicationEvents(currentApplicationRecord.events, [
        {
          id: `event_submission_outcome_${outcome.id}`,
          at: outcome.attemptedAt,
          title: uncertain
            ? SUBMISSION_OUTCOME_UNCERTAIN_SUMMARY
            : SUBMISSION_NOT_SUBMITTED_SUMMARY,
          detail: uncertain
            ? SUBMISSION_OUTCOME_UNCERTAIN_DETAIL
            : outcome.retry.eligible
              ? "The final action was not submitted. The prepared application remains available for review before another attempt."
              : SUBMISSION_NOT_SUBMITTED_BLOCKED_SUMMARY,
          emphasis:
            uncertain || !outcome.retry.eligible ? "warning" : "neutral",
        },
      ]),
    });
    const result = ApplyJobResultSchema.parse({
      ...current,
      automaticSendPending: false,
      ...(uncertain
        ? {
            state: "blocked" as const,
            summary: SUBMISSION_OUTCOME_UNCERTAIN_SUMMARY,
            detail: SUBMISSION_OUTCOME_UNCERTAIN_DETAIL,
            updatedAt: outcome.attemptedAt,
            completedAt: outcome.attemptedAt,
            blockerReason: "submission_outcome_uncertain" as const,
            blockerSummary: SUBMISSION_OUTCOME_UNCERTAIN_NEXT_ACTION,
          }
        : {}),
      privacyReceipt: {
        ...receipt,
        finalSubmitAuthorized,
        submissionOutcome: outcome,
      },
    });
    return { applicationRecord, result };
  } catch {
    // An absent/cross-lineage application record or any future schema
    // incompatibility is not safe to reconcile.
    return null;
  }
}

interface ResolvedSubmissionOutcomeProjection {
  applicationRecord: ApplicationRecord;
  result: ApplyJobResult;
}

function buildResolvedSubmissionOutcomeProjection(
  state: JobFinderRepositoryState,
  previousOutcome: SubmissionOutcomeRecord,
  outcome: SubmissionOutcomeRecord,
): ResolvedSubmissionOutcomeProjection | null {
  const current =
    state.applyJobResults.find((value) => value.id === outcome.resultId) ??
    null;
  const currentApplicationRecord =
    state.applicationRecords.find(
      (value) => value.id === outcome.applicationRecordId,
    ) ?? null;
  if (
    current === null ||
    current.runId !== outcome.runId ||
    current.jobId !== outcome.jobId ||
    current.applicationRecordId !== outcome.applicationRecordId ||
    currentApplicationRecord === null ||
    currentApplicationRecord.jobId !== outcome.jobId
  ) {
    return null;
  }

  const receipt = current.privacyReceipt;
  if (
    receipt === null ||
    receipt.finalSubmitOccurred !== false ||
    receipt.lineage.runId !== outcome.runId ||
    receipt.lineage.jobId !== outcome.jobId ||
    receipt.lineage.resultId !== outcome.resultId ||
    receipt.lineage.applicationRecordId !== outcome.applicationRecordId ||
    !sameValue(receipt.submissionOutcome, previousOutcome)
  ) {
    return null;
  }

  const submitted = outcome.outcome === "submitted";
  const verificationTime = outcome.verifiedAt;
  if (verificationTime === null) {
    return null;
  }

  try {
    const finalSubmitAuthorized =
      receipt.finalSubmitAuthorized ||
      hasDurableFinalSubmitAuthorization(state, outcome);
    const applicationRecord = ApplicationRecordSchema.parse({
      ...currentApplicationRecord,
      status: submitted ? "submitted" : currentApplicationRecord.status,
      lastActionLabel: submitted
        ? "Application submission externally verified."
        : SUBMISSION_NOT_SUBMITTED_SUMMARY,
      nextActionLabel: submitted
        ? null
        : "Any new submission attempt requires explicit user approval.",
      lastUpdatedAt: verificationTime,
      lastAttemptState: submitted ? "submitted" : "paused",
      latestBlocker: submitted
        ? null
        : {
            code: "requires_manual_review" as const,
            summary:
              "External verification confirmed that the final action was not submitted. Automatic retry remains disabled.",
          },
      events: mergeApplicationEvents(currentApplicationRecord.events, [
        {
          id: `event_submission_outcome_resolution_${outcome.id}`,
          at: verificationTime,
          title: submitted
            ? "Application submission externally verified."
            : SUBMISSION_NOT_SUBMITTED_SUMMARY,
          detail: submitted
            ? "A person verified the employer-site state using external evidence."
            : "A person verified the employer-site state. No automatic retry was enabled.",
          emphasis: submitted ? "neutral" : "warning",
        },
      ]),
    });
    const result = ApplyJobResultSchema.parse({
      ...current,
      automaticSendPending: false,
      state: submitted ? "submitted" : "blocked",
      summary: submitted
        ? "Application submission externally verified."
        : SUBMISSION_NOT_SUBMITTED_SUMMARY,
      detail: submitted
        ? "External evidence verified that the final action completed on the employer site."
        : "External evidence verified that the final action did not complete. Automatic retry remains disabled.",
      updatedAt: verificationTime,
      completedAt: verificationTime,
      blockerReason: null,
      blockerSummary: null,
      privacyReceipt: {
        ...receipt,
        finalSubmitAuthorized,
        finalSubmitOccurred: submitted,
        submissionOutcome: outcome,
      },
    });
    return { applicationRecord, result };
  } catch {
    return null;
  }
}

function replaceApplyJobResult(
  state: JobFinderRepositoryState,
  result: ApplyJobResult,
): void {
  const index = state.applyJobResults.findIndex(
    (value) => value.id === result.id,
  );
  if (index < 0) {
    throw new Error("Apply result disappeared during outcome reconciliation.");
  }
  state.applyJobResults[index] = result;
}

function replaceApplicationRecord(
  state: JobFinderRepositoryState,
  applicationRecord: ApplicationRecord,
): void {
  const index = state.applicationRecords.findIndex(
    (value) => value.id === applicationRecord.id,
  );
  if (index < 0) {
    throw new Error(
      "Application record disappeared during outcome reconciliation.",
    );
  }
  state.applicationRecords[index] = applicationRecord;
}

function sortById<T extends { id: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => left.id.localeCompare(right.id));
}

export function createApplicationAuthorityRepositoryMethods(
  store: ApplicationAuthorityStateStore,
): ApplicationAuthorityRepository {
  return {
    async listApplicationAuthorityEnvelopes(options) {
      await Promise.resolve();
      return cloneValue(
        sortById(
          store
            .read()
            .applicationAuthorityEnvelopes.filter(
              (value) =>
                (options?.id === undefined || value.id === options.id) &&
                (options?.status === undefined ||
                  value.status === options.status),
            ),
        ),
      );
    },
    async getApplicationAuthorityEnvelope(id) {
      await Promise.resolve();
      return cloneValue(
        store
          .read()
          .applicationAuthorityEnvelopes.find((value) => value.id === id) ??
          null,
      );
    },
    async commitApplicationAuthorityEnvelope(input) {
      await Promise.resolve();
      const envelope = ApplicationAuthorityEnvelopeSchema.parse(
        cloneValue(input.envelope),
      );
      return cloneValue(
        store.mutate((state) => {
          const current =
            state.applicationAuthorityEnvelopes.find(
              (value) => value.id === envelope.id,
            ) ?? null;
          if (input.expectedRevision === null) {
            if (current) {
              return { status: "stale" as const, current };
            }
            // Terminal envelopes are created only by their dedicated
            // lifecycle transitions. Allowing a caller to seed a revoked or
            // expired envelope would make a non-authority write look like a
            // legitimate revocation history entry.
            if (envelope.revision !== 1 || envelope.status !== "active") {
              return { status: "stale" as const, current: null };
            }
            const activeConflict = findActiveAuthorityConflict(state);
            if (activeConflict) {
              return { status: "stale" as const, current: activeConflict };
            }
          } else {
            if (!current) {
              return { status: "missing" as const, current: null };
            }
            if (
              current.revision !== input.expectedRevision ||
              envelope.revision !== input.expectedRevision + 1
            ) {
              return { status: "stale" as const, current };
            }
            // Revisions that have already been used by a preflight or any
            // downstream lifecycle record must move through the dedicated
            // revoke/expiry path. A generic replacement cannot safely
            // propagate a status/revision change to those children.
            if (
              current.status !== "active" ||
              envelope.status !== "active" ||
              hasAuthoritySubmissionLifecycle(state, envelope.id)
            ) {
              return { status: "stale" as const, current };
            }
            const activeConflict = findActiveAuthorityConflict(
              state,
              current.id,
            );
            if (activeConflict) {
              return { status: "stale" as const, current: activeConflict };
            }
          }
          replaceById(state.applicationAuthorityEnvelopes, envelope);
          return { status: "applied" as const, envelope };
        }),
      );
    },
    async replaceApplicationAuthorityEnvelope(input) {
      await Promise.resolve();
      const parsedInput = parseAuthorityReplacementInput(input);
      return cloneValue(
        store.mutate((state) => {
          const current =
            state.applicationAuthorityEnvelopes.find(
              (value) => value.id === parsedInput.currentId,
            ) ?? null;
          if (current === null) {
            return { status: "missing" as const, current: null };
          }
          if (
            current.status !== "active" ||
            current.revision !== parsedInput.expectedRevision
          ) {
            return { status: "stale" as const, current };
          }

          const existingReplacement =
            state.applicationAuthorityEnvelopes.find(
              (value) => value.id === parsedInput.replacement.id,
            ) ?? null;
          if (existingReplacement !== null) {
            return {
              status: "conflict" as const,
              current: existingReplacement,
            };
          }

          // A duplicate active envelope indicates a pre-existing invariant
          // violation. Refuse to rotate rather than silently choosing which
          // authority should survive.
          const activeConflict = findActiveAuthorityConflict(state, current.id);
          if (activeConflict !== null) {
            return { status: "conflict" as const, current: activeConflict };
          }

          const revoked = ApplicationAuthorityEnvelopeSchema.parse({
            ...current,
            status: "revoked",
            revision: current.revision + 1,
            revokedAt: parsedInput.revokedAt,
          });
          revokeAuthorityChildren(state, current.id, parsedInput.revokedAt);
          replaceById(state.applicationAuthorityEnvelopes, revoked);
          replaceById(
            state.applicationAuthorityEnvelopes,
            parsedInput.replacement,
          );
          return {
            status: "applied" as const,
            previous: revoked,
            envelope: parsedInput.replacement,
          };
        }),
      );
    },
    async revokeApplicationAuthorityEnvelope(input) {
      await Promise.resolve();
      return cloneValue(
        store.mutate((state) => {
          const current =
            state.applicationAuthorityEnvelopes.find(
              (value) => value.id === input.id,
            ) ?? null;
          if (!current) {
            return { status: "missing" as const, current: null };
          }
          if (
            current.revision !== input.expectedRevision ||
            current.status !== "active"
          ) {
            return { status: "stale" as const, current };
          }
          const envelope = ApplicationAuthorityEnvelopeSchema.parse({
            ...current,
            status: "revoked",
            revision: current.revision + 1,
            revokedAt: input.revokedAt,
          });
          revokeAuthorityChildren(state, envelope.id, input.revokedAt);
          replaceById(state.applicationAuthorityEnvelopes, envelope);
          return { status: "applied" as const, envelope };
        }),
      );
    },

    async listSubmissionPreflightRecords(options) {
      await Promise.resolve();
      return cloneValue(
        sortById(
          store
            .read()
            .submissionPreflights.filter(
              (value) =>
                (options?.id === undefined || value.id === options.id) &&
                (options?.idempotencyKey === undefined ||
                  value.idempotencyKey === options.idempotencyKey) &&
                (options?.runId === undefined ||
                  value.runId === options.runId) &&
                (options?.jobId === undefined ||
                  value.jobId === options.jobId) &&
                (options?.resultId === undefined ||
                  value.resultId === options.resultId) &&
                (options?.applicationRecordId === undefined ||
                  value.applicationRecordId === options.applicationRecordId),
            ),
        ),
      );
    },
    async getSubmissionPreflightRecord(id) {
      await Promise.resolve();
      return cloneValue(
        store.read().submissionPreflights.find((value) => value.id === id) ??
          null,
      );
    },
    async commitSubmissionPreflight(input) {
      await Promise.resolve();
      const preflight = SubmissionPreflightRecordSchema.parse(
        cloneValue(input),
      );
      return cloneValue(
        store.mutate((state) => {
          const current =
            state.submissionPreflights.find(
              (value) =>
                value.id === preflight.id ||
                value.idempotencyKey === preflight.idempotencyKey,
            ) ?? null;
          const currentIdempotency =
            state.submissionIdempotencyRecords.find(
              (value) =>
                value.idempotencyKey === preflight.idempotencyKey ||
                value.preflightId === preflight.id,
            ) ?? null;
          if (current || currentIdempotency) {
            if (
              current &&
              currentIdempotency &&
              sameValue(current, preflight)
            ) {
              return {
                status: "duplicate" as const,
                preflight: current,
                idempotency: currentIdempotency,
              };
            }
            return { status: "conflict" as const, current };
          }
          const idempotency = SubmissionIdempotencyRecordSchema.parse({
            id: `submission_idempotency_${preflight.id}`,
            idempotencyKey: preflight.idempotencyKey,
            preflightId: preflight.id,
            authorityEnvelopeId: preflight.authorityEnvelopeId,
            authorityRevision: preflight.authorityRevision,
            runId: preflight.runId,
            jobId: preflight.jobId,
            resultId: preflight.resultId,
            applicationRecordId: preflight.applicationRecordId,
            status: "available",
            revision: 1,
            createdAt: preflight.createdAt,
            updatedAt: preflight.createdAt,
            armedAt: null,
            outcomeId: null,
            outcome: null,
            revokedAt: null,
          });
          state.submissionPreflights.push(preflight);
          state.submissionIdempotencyRecords.push(idempotency);
          return { status: "created" as const, preflight, idempotency };
        }),
      );
    },

    async listSubmissionExecutionGrants(options) {
      await Promise.resolve();
      return cloneValue(
        sortById(
          store
            .read()
            .submissionExecutionGrants.filter(
              (value) =>
                (options?.id === undefined || value.id === options.id) &&
                (options?.preflightId === undefined ||
                  value.preflightId === options.preflightId) &&
                (options?.idempotencyKey === undefined ||
                  value.idempotencyKey === options.idempotencyKey) &&
                (options?.status === undefined ||
                  value.status === options.status),
            ),
        ),
      );
    },
    async getSubmissionExecutionGrant(id) {
      await Promise.resolve();
      return cloneValue(
        store
          .read()
          .submissionExecutionGrants.find((value) => value.id === id) ?? null,
      );
    },
    async commitSubmissionExecutionGrant(input) {
      await Promise.resolve();
      const grant = SubmissionExecutionGrantSchema.parse(cloneValue(input));
      return cloneValue(
        store.mutate((state) => {
          const preflight = state.submissionPreflights.find(
            (value) => value.id === grant.preflightId,
          );
          if (!preflight || !matchesPreflightLineage(preflight, grant)) {
            return { status: "missing_preflight" as const };
          }
          const current =
            state.submissionExecutionGrants.find(
              (value) =>
                value.id === grant.id ||
                value.preflightId === grant.preflightId ||
                value.idempotencyKey === grant.idempotencyKey,
            ) ?? null;
          if (current) {
            return sameValue(current, grant)
              ? { status: "duplicate" as const, grant: current }
              : { status: "conflict" as const, current };
          }
          state.submissionExecutionGrants.push(grant);
          return { status: "created" as const, grant };
        }),
      );
    },
    async revokeSubmissionExecutionGrant(input) {
      await Promise.resolve();
      return cloneValue(
        store.mutate((state) => {
          const current =
            state.submissionExecutionGrants.find(
              (value) => value.id === input.id,
            ) ?? null;
          if (!current) {
            return { status: "missing" as const, grant: null };
          }
          if (current.status !== "active") {
            return { status: "stale" as const, grant: current };
          }
          const grant = SubmissionExecutionGrantSchema.parse({
            ...current,
            status: "revoked",
            revokedAt: input.revokedAt,
          });
          replaceById(state.submissionExecutionGrants, grant);
          return { status: "revoked" as const, grant };
        }),
      );
    },
    async expireSubmissionExecutionGrants(now) {
      await Promise.resolve();
      return store.mutate((state) => {
        let count = 0;
        state.submissionExecutionGrants = state.submissionExecutionGrants.map(
          (current): SubmissionExecutionGrant => {
            if (
              current.status === "active" &&
              Date.parse(current.expiresAt) <= Date.parse(now)
            ) {
              count += 1;
              return SubmissionExecutionGrantSchema.parse({
                ...current,
                status: "expired",
              });
            }
            return current;
          },
        );
        return count;
      });
    },

    async listSubmissionIdempotencyRecords(options) {
      await Promise.resolve();
      return cloneValue(
        sortById(
          store
            .read()
            .submissionIdempotencyRecords.filter(
              (value) =>
                (options?.id === undefined || value.id === options.id) &&
                (options?.idempotencyKey === undefined ||
                  value.idempotencyKey === options.idempotencyKey) &&
                (options?.preflightId === undefined ||
                  value.preflightId === options.preflightId) &&
                (options?.status === undefined ||
                  value.status === options.status),
            ),
        ),
      );
    },
    async getSubmissionIdempotencyRecord(idempotencyKey) {
      await Promise.resolve();
      return cloneValue(
        store
          .read()
          .submissionIdempotencyRecords.find(
            (value) => value.idempotencyKey === idempotencyKey,
          ) ?? null,
      );
    },
    async authorizeAndArmSubmissionAttempt(input) {
      await Promise.resolve();
      const preflight = SubmissionPreflightRecordSchema.parse(
        cloneValue(input.preflight),
      );
      const marker = SubmissionArmedMarkerSchema.parse(
        cloneValue(input.marker),
      );
      if (
        (input.mode !== "confirm_before_submit" &&
          input.mode !== "autonomous_submit") ||
        !Number.isInteger(input.expectedIdempotencyRevision) ||
        input.expectedIdempotencyRevision < 1 ||
        !Number.isFinite(Date.parse(input.now))
      ) {
        return armFailure("blocked", "invalid_input", null);
      }

      return cloneValue(
        store.mutate((state): SubmissionAttemptArmResult => {
          const authority =
            state.applicationAuthorityEnvelopes.find(
              (value) => value.id === preflight.authorityEnvelopeId,
            ) ?? null;
          if (!authority) {
            return armFailure("missing", "authority_missing", null);
          }
          if (!isActiveApplicationAuthorityEnvelope(authority, input.now)) {
            return armFailure("blocked", "authority_inactive", null);
          }
          if (authority.mode !== input.mode) {
            return armFailure("blocked", "authority_mode_mismatch", null);
          }
          if (authority.revision !== preflight.authorityRevision) {
            return armFailure("stale", "authority_revision_mismatch", null);
          }

          const persistedPreflightById =
            state.submissionPreflights.find(
              (value) => value.id === preflight.id,
            ) ?? null;
          const persistedPreflightByKey =
            state.submissionPreflights.find(
              (value) => value.idempotencyKey === preflight.idempotencyKey,
            ) ?? null;
          if (!persistedPreflightById || !persistedPreflightByKey) {
            return armFailure("missing", "preflight_missing", null);
          }
          if (
            persistedPreflightById.id !== persistedPreflightByKey.id ||
            !matchesExactPreflight(preflight, persistedPreflightById)
          ) {
            return armFailure("blocked", "preflight_mismatch", null);
          }

          const currentPreflightValidation = validateCurrentAuthorityPreflight(
            authority,
            persistedPreflightById,
          );
          if (currentPreflightValidation !== null) {
            return armFailure("blocked", currentPreflightValidation, null);
          }

          const idempotency =
            state.submissionIdempotencyRecords.find(
              (value) => value.idempotencyKey === preflight.idempotencyKey,
            ) ?? null;
          if (!idempotency) {
            return armFailure("missing", "idempotency_missing", null);
          }
          if (!matchesIdempotencyLineage(idempotency, preflight)) {
            return armFailure(
              "blocked",
              "idempotency_lineage_mismatch",
              idempotency,
            );
          }

          const existingMarker =
            state.submissionArmedMarkers.find(
              (value) =>
                value.idempotencyKey === preflight.idempotencyKey ||
                value.preflightId === preflight.id,
            ) ?? null;

          if (idempotency.status === "armed") {
            if (!existingMarker) {
              return armFailure("blocked", "armed_marker_missing", idempotency);
            }
            if (
              !matchesMarkerLineage(existingMarker, preflight) ||
              existingMarker.armedAt !== idempotency.armedAt
            ) {
              return armFailure(
                "blocked",
                "armed_marker_mismatch",
                idempotency,
                existingMarker,
              );
            }

            if (input.mode === "autonomous_submit") {
              if (
                input.executionGrantId !== null ||
                state.submissionExecutionGrants.some(
                  (value) => value.preflightId === preflight.id,
                )
              ) {
                return armFailure(
                  "blocked",
                  "unexpected_execution_grant",
                  idempotency,
                  existingMarker,
                );
              }
              return {
                status: "duplicate",
                idempotency,
                marker: existingMarker,
                executionGrant: null,
              };
            }

            if (input.executionGrantId === null) {
              return armFailure(
                "blocked",
                "execution_grant_required",
                idempotency,
                existingMarker,
              );
            }
            const duplicateGrant =
              state.submissionExecutionGrants.find(
                (value) => value.id === input.executionGrantId,
              ) ?? null;
            if (!duplicateGrant) {
              return armFailure(
                "missing",
                "execution_grant_missing",
                idempotency,
                existingMarker,
              );
            }
            if (
              !matchesPreflightLineage(preflight, duplicateGrant) ||
              duplicateGrant.preflightId !== preflight.id
            ) {
              return armFailure(
                "blocked",
                "execution_grant_mismatch",
                idempotency,
                existingMarker,
                duplicateGrant,
              );
            }
            if (duplicateGrant.status !== "consumed") {
              return armFailure(
                "blocked",
                "execution_grant_not_active",
                idempotency,
                existingMarker,
                duplicateGrant,
              );
            }
            return {
              status: "duplicate",
              idempotency,
              marker: existingMarker,
              executionGrant: duplicateGrant,
            };
          }

          if (existingMarker) {
            return armFailure(
              "blocked",
              "marker_conflict",
              idempotency,
              existingMarker,
            );
          }
          if (idempotency.status !== "available") {
            return armFailure(
              "blocked",
              "idempotency_not_available",
              idempotency,
            );
          }
          if (idempotency.revision !== input.expectedIdempotencyRevision) {
            return armFailure(
              "stale",
              "idempotency_revision_mismatch",
              idempotency,
            );
          }
          if (
            !matchesMarkerLineage(marker, preflight) ||
            marker.idempotencyKey !== idempotency.idempotencyKey
          ) {
            return armFailure("blocked", "marker_mismatch", idempotency);
          }
          if (
            state.submissionArmedMarkers.some((value) => value.id === marker.id)
          ) {
            return armFailure("blocked", "marker_conflict", idempotency);
          }

          let consumedGrant: SubmissionExecutionGrant | null = null;
          if (input.mode === "autonomous_submit") {
            if (
              input.executionGrantId !== null ||
              state.submissionExecutionGrants.some(
                (value) => value.preflightId === preflight.id,
              )
            ) {
              return armFailure(
                "blocked",
                "unexpected_execution_grant",
                idempotency,
              );
            }
          } else {
            if (input.executionGrantId === null) {
              return armFailure(
                "blocked",
                "execution_grant_required",
                idempotency,
              );
            }
            const grant =
              state.submissionExecutionGrants.find(
                (value) => value.id === input.executionGrantId,
              ) ?? null;
            if (!grant) {
              return armFailure(
                "missing",
                "execution_grant_missing",
                idempotency,
              );
            }
            if (
              grant.preflightId !== preflight.id ||
              !matchesPreflightLineage(preflight, grant)
            ) {
              return armFailure(
                "blocked",
                "execution_grant_mismatch",
                idempotency,
                null,
                grant,
              );
            }
            if (grant.status !== "active") {
              return armFailure(
                "blocked",
                Date.parse(grant.expiresAt) <= Date.parse(input.now)
                  ? "execution_grant_expired"
                  : "execution_grant_not_active",
                idempotency,
                null,
                grant,
              );
            }
            if (
              !isActiveSubmissionExecutionGrant(grant, input.now, preflight)
            ) {
              return armFailure(
                "blocked",
                "execution_grant_expired",
                idempotency,
                null,
                grant,
              );
            }
            consumedGrant = SubmissionExecutionGrantSchema.parse({
              ...grant,
              status: "consumed",
              consumedAt: marker.armedAt,
            });
          }

          const armedIdempotency = SubmissionIdempotencyRecordSchema.parse({
            ...idempotency,
            status: "armed",
            revision: idempotency.revision + 1,
            updatedAt: marker.armedAt,
            armedAt: marker.armedAt,
          });
          if (consumedGrant) {
            replaceById(state.submissionExecutionGrants, consumedGrant);
          }
          replaceById(state.submissionIdempotencyRecords, armedIdempotency);
          state.submissionArmedMarkers.push(marker);
          return {
            status: "armed",
            idempotency: armedIdempotency,
            marker,
            executionGrant: consumedGrant,
          };
        }),
      );
    },
    async listSubmissionArmedMarkers(options) {
      await Promise.resolve();
      return cloneValue(
        sortById(
          store
            .read()
            .submissionArmedMarkers.filter(
              (value) =>
                (options?.id === undefined || value.id === options.id) &&
                (options?.idempotencyKey === undefined ||
                  value.idempotencyKey === options.idempotencyKey) &&
                (options?.preflightId === undefined ||
                  value.preflightId === options.preflightId),
            ),
        ),
      );
    },

    async listSubmissionOutcomeRecords(options) {
      await Promise.resolve();
      return cloneValue(
        sortById(
          store
            .read()
            .submissionOutcomeRecords.filter(
              (value) =>
                (options?.id === undefined || value.id === options.id) &&
                (options?.preflightId === undefined ||
                  value.preflightId === options.preflightId) &&
                (options?.idempotencyKey === undefined ||
                  value.idempotencyKey === options.idempotencyKey) &&
                (options?.runId === undefined ||
                  value.runId === options.runId) &&
                (options?.jobId === undefined ||
                  value.jobId === options.jobId) &&
                (options?.resultId === undefined ||
                  value.resultId === options.resultId) &&
                (options?.applicationRecordId === undefined ||
                  value.applicationRecordId === options.applicationRecordId),
            ),
        ),
      );
    },
    async getSubmissionOutcomeRecord(id) {
      await Promise.resolve();
      return cloneValue(
        store
          .read()
          .submissionOutcomeRecords.find((value) => value.id === id) ?? null,
      );
    },
    async commitSubmissionOutcome(input) {
      await Promise.resolve();
      const outcome = SubmissionOutcomeRecordSchema.parse(
        cloneValue(input.outcome),
      );
      return cloneValue(
        store.mutate((state) => {
          const existing =
            state.submissionOutcomeRecords.find(
              (value) =>
                value.id === outcome.id ||
                value.idempotencyKey === outcome.idempotencyKey,
            ) ?? null;
          const idempotency =
            state.submissionIdempotencyRecords.find(
              (value) => value.idempotencyKey === outcome.idempotencyKey,
            ) ?? null;
          if (!idempotency) {
            return {
              status: "missing" as const,
              idempotency: null,
              outcome: null,
            };
          }

          // Resolve and validate the existing result before changing any
          // authority state. This keeps an absent, cross-lineage, or stale
          // receipt from leaving an outcome record without its parent result.
          const reconciledProjection =
            buildReconciledSubmissionOutcomeProjection(state, outcome);
          if (reconciledProjection === null) {
            return {
              status: "blocked" as const,
              outcome: existing,
              idempotency,
            };
          }

          if (existing) {
            if (!sameValue(existing, outcome)) {
              return {
                status: "blocked" as const,
                outcome: existing,
                idempotency,
              };
            }
            replaceApplyJobResult(state, reconciledProjection.result);
            replaceApplicationRecord(
              state,
              reconciledProjection.applicationRecord,
            );
            return {
              status: "duplicate" as const,
              outcome: existing,
              idempotency,
            };
          }
          if (
            !matchesOutcomeLineage(idempotency, outcome) ||
            idempotency.status !== "armed"
          ) {
            return { status: "blocked" as const, outcome: null, idempotency };
          }
          if (
            input.expectedIdempotencyRevision !== undefined &&
            idempotency.revision !== input.expectedIdempotencyRevision
          ) {
            return { status: "stale" as const, outcome: null, idempotency };
          }
          const resolved = SubmissionIdempotencyRecordSchema.parse({
            ...idempotency,
            status:
              outcome.outcome === "outcome_uncertain"
                ? "outcome_uncertain"
                : "resolved",
            revision: idempotency.revision + 1,
            updatedAt: outcome.verifiedAt ?? outcome.attemptedAt,
            outcomeId: outcome.id,
            outcome: outcome.outcome,
          });
          replaceApplyJobResult(state, reconciledProjection.result);
          replaceApplicationRecord(
            state,
            reconciledProjection.applicationRecord,
          );
          state.submissionOutcomeRecords.push(outcome);
          replaceById(state.submissionIdempotencyRecords, resolved);
          return {
            status: "recorded" as const,
            outcome,
            idempotency: resolved,
          };
        }),
      );
    },
    async resolveSubmissionOutcome(input) {
      await Promise.resolve();
      const resolution = SubmissionOutcomeResolutionInputSchema.parse(
        cloneValue(input),
      );
      return cloneValue(
        store.mutate((state): SubmissionOutcomeResolutionResult => {
          const idempotency =
            state.submissionIdempotencyRecords.find(
              (value) =>
                value.idempotencyKey === resolution.outcome.idempotencyKey,
            ) ?? null;
          if (idempotency === null) {
            return {
              status: "missing",
              previousOutcome: null,
              outcome: null,
              idempotency: null,
            };
          }

          const previousOutcome =
            state.submissionOutcomeRecords.find(
              (value) => value.id === resolution.expectedOutcomeId,
            ) ?? null;
          const alreadyResolved =
            state.submissionOutcomeRecords.find(
              (value) => value.id === resolution.outcome.id,
            ) ?? null;
          if (
            previousOutcome !== null &&
            alreadyResolved !== null &&
            sameValue(alreadyResolved, resolution.outcome) &&
            idempotency.outcomeId === alreadyResolved.id &&
            idempotency.status === "resolved"
          ) {
            return {
              status: "duplicate",
              previousOutcome,
              outcome: alreadyResolved,
              idempotency,
            };
          }

          if (
            previousOutcome === null ||
            previousOutcome.outcome !== "outcome_uncertain" ||
            idempotency.status !== "outcome_uncertain" ||
            idempotency.outcomeId !== previousOutcome.id ||
            idempotency.outcome !== "outcome_uncertain" ||
            idempotency.revision !== resolution.expectedIdempotencyRevision ||
            alreadyResolved !== null
          ) {
            return {
              status:
                idempotency.revision !== resolution.expectedIdempotencyRevision
                  ? "stale"
                  : "blocked",
              previousOutcome,
              outcome: alreadyResolved,
              idempotency,
            };
          }

          const lineageMatches =
            previousOutcome.preflightId === resolution.outcome.preflightId &&
            previousOutcome.idempotencyKey ===
              resolution.outcome.idempotencyKey &&
            previousOutcome.authorityEnvelopeId ===
              resolution.outcome.authorityEnvelopeId &&
            previousOutcome.authorityRevision ===
              resolution.outcome.authorityRevision &&
            previousOutcome.runId === resolution.outcome.runId &&
            previousOutcome.jobId === resolution.outcome.jobId &&
            previousOutcome.resultId === resolution.outcome.resultId &&
            previousOutcome.applicationRecordId ===
              resolution.outcome.applicationRecordId &&
            matchesOutcomeLineage(idempotency, resolution.outcome);
          if (!lineageMatches) {
            return {
              status: "blocked",
              previousOutcome,
              outcome: null,
              idempotency,
            };
          }

          const projection = buildResolvedSubmissionOutcomeProjection(
            state,
            previousOutcome,
            resolution.outcome,
          );
          if (projection === null) {
            return {
              status: "blocked",
              previousOutcome,
              outcome: null,
              idempotency,
            };
          }

          const resolvedIdempotency = SubmissionIdempotencyRecordSchema.parse({
            ...idempotency,
            status: "resolved",
            revision: idempotency.revision + 1,
            updatedAt: resolution.outcome.verifiedAt,
            outcomeId: resolution.outcome.id,
            outcome: resolution.outcome.outcome,
          });
          replaceApplyJobResult(state, projection.result);
          replaceApplicationRecord(state, projection.applicationRecord);
          state.submissionOutcomeRecords.push(resolution.outcome);
          replaceById(state.submissionIdempotencyRecords, resolvedIdempotency);
          return {
            status: "recorded",
            previousOutcome,
            outcome: resolution.outcome,
            idempotency: resolvedIdempotency,
          };
        }),
      );
    },
    async recoverArmedSubmissionAttempts(input) {
      await Promise.resolve();
      return cloneValue(
        store.mutate((state) => {
          const armed = state.submissionIdempotencyRecords.filter(
            (value) => value.status === "armed",
          );
          const recovered: SubmissionOutcomeRecord[] = [];
          const prepared: Array<{
            outcome: SubmissionOutcomeRecord;
            resolved: SubmissionIdempotencyRecord;
            projection: ReconciledSubmissionOutcomeProjection | null;
          }> = [];
          const resultIds = new Set<string>();

          // Build every recovery mutation first. A malformed timestamp must
          // fail before any earlier armed attempt is converted, preserving the
          // transaction's all-or-nothing promise in the in-memory
          // implementation as well.
          for (const current of armed) {
            const outcome = SubmissionOutcomeRecordSchema.parse({
              id: `recovery_outcome_${current.id}_${current.revision}`,
              preflightId: current.preflightId,
              idempotencyKey: current.idempotencyKey,
              authorityEnvelopeId: current.authorityEnvelopeId,
              authorityRevision: current.authorityRevision,
              runId: current.runId,
              jobId: current.jobId,
              resultId: current.resultId,
              applicationRecordId: current.applicationRecordId,
              outcome: "outcome_uncertain",
              attemptedAt: current.armedAt ?? input.now,
              verifiedAt: null,
              evidence: [],
              retry: { eligible: false, blockReason: "outcome_uncertain" },
            });
            const built = buildReconciledSubmissionOutcomeProjection(
              state,
              outcome,
            );
            // One attempt whose result cannot carry the outcome (the result
            // is gone, was sent by the person meanwhile, or already holds
            // another attempt's outcome) is closed as uncertain on its own,
            // leaving that result as it is. It never stops the others from
            // recovering, and it never stops the workspace from opening.
            const projection =
              built !== null && !resultIds.has(built.result.id) ? built : null;
            if (projection) resultIds.add(projection.result.id);
            const resolved = SubmissionIdempotencyRecordSchema.parse({
              ...current,
              status: "outcome_uncertain",
              revision: current.revision + 1,
              updatedAt: input.now,
              outcomeId: outcome.id,
              outcome: "outcome_uncertain",
            });
            prepared.push({ outcome, resolved, projection });
          }

          const revokedGrants = state.submissionExecutionGrants.map((grant) => {
            const belongsToArmedAttempt = armed.some(
              (current) => current.idempotencyKey === grant.idempotencyKey,
            );
            if (!belongsToArmedAttempt || grant.status !== "active") {
              return grant;
            }
            return SubmissionExecutionGrantSchema.parse({
              ...grant,
              status: "revoked",
              revokedAt: input.now,
            });
          });

          // All parsing and exact-lineage checks succeeded, so the durable
          // authority records and their matching receipts can now be swapped
          // together.
          for (const entry of prepared) {
            if (entry.projection) {
              replaceApplyJobResult(state, entry.projection.result);
              replaceApplicationRecord(
                state,
                entry.projection.applicationRecord,
              );
            }
            state.submissionOutcomeRecords.push(entry.outcome);
            replaceById(state.submissionIdempotencyRecords, entry.resolved);
            recovered.push(entry.outcome);
          }
          state.submissionExecutionGrants = revokedGrants;
          return recovered;
        }),
      );
    },
  };
}
