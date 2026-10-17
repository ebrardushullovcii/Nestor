import {
  isActiveApplicationAuthorityEnvelope,
  isActiveSubmissionExecutionGrant,
  ApplicationAuthorityDecisionPolicyIdentitySchema,
  SubmissionAnswerSnapshotIdentitySchema,
  type ApplicationAuthorityEnvelope,
  type ApplicationAuthorityDecisionPolicyIdentity,
  type ApplicationAutomationMode,
  type Sha256Hex,
  type SubmissionAnswerSnapshotIdentity,
  type SubmissionExecutionGrant,
  type SubmissionFinalControlIdentity,
  type SubmissionObservationIdentity,
  type SubmissionPreflightRecord,
} from "@nestor/contracts";

/**
 * ADR 0012 / ADR 0013 application submission policy gate.
 *
 * This is one pure, deterministic decision point between an observed
 * application form and the single final-submission external action. It owns
 * observe/propose/authorize/preflight checks only: no browser execution, no
 * persistence, no IPC, and no settings reads. Current production remains
 * prepare-only; a future executor consumes an `authorized` result later and
 * must still perform its own immediate recheck before acting.
 *
 * The function never throws for policy outcomes — every failure is a
 * `blocked` decision with an explicit reason enum and safe plain-text detail.
 * Malformed inputs that cannot even be compared (for example an unparseable
 * origin) fail closed instead of throwing.
 */

/** Tri-state idempotency observation for the preflight's bound key. */
export const submissionIdempotencyStateValues = [
  "unused",
  "executed",
  "outcome_uncertain",
] as const;
export type SubmissionIdempotencyState =
  (typeof submissionIdempotencyStateValues)[number];

/**
 * Explicit block reasons in the deterministic evaluation order. The first
 * failing check wins; reasons are mutually exclusive per decision.
 */
export const submissionPolicyBlockReasonValues = [
  "mode_mismatch",
  "prepare_only",
  "authority_inactive",
  "decision_policy_missing",
  "decision_policy_mismatch",
  "current_policy_facts_invalid",
  "answer_policy_mismatch",
  "preflight_authority_mismatch",
  "preflight_lineage_mismatch",
  "preflight_scope_mismatch",
  "preflight_origin_mismatch",
  "scope_excluded",
  "origin_not_allowed",
  "resume_not_allowed",
  "observation_stale",
  "ambiguous_final_control",
  "unavailable_credentials",
  "login_required",
  "mfa_required",
  "captcha",
  "anti_bot",
  "account_creation",
  "unknown_required_question",
  "unknown_eligibility",
  "unknown_legal_requirement",
  "origin_drift",
  "capacity_invalid",
  "idempotency_already_executed",
  "idempotency_outcome_uncertain",
  "execution_grant_invalid",
  "unexpected_execution_grant",
] as const;
export type SubmissionPolicyBlockReason =
  (typeof submissionPolicyBlockReasonValues)[number];

/**
 * Finite, content-free facts that can veto a final action. These values are
 * deliberately codes rather than page text, question text, credentials, or
 * model explanations. A caller may persist or transport them safely.
 */
export const submissionMandatoryStopCodeValues = [
  "unavailable_credentials",
  "login_required",
  "mfa_required",
  "captcha",
  "anti_bot",
  "account_creation",
  "unknown_required_question",
  "unknown_eligibility",
  "unknown_legal_requirement",
  "stale_observation",
  "ambiguous_final_control",
  "origin_drift",
  "outcome_uncertain",
] as const;
export type SubmissionMandatoryStopCode =
  (typeof submissionMandatoryStopCodeValues)[number];

export interface SubmissionMandatoryStopFact {
  code: SubmissionMandatoryStopCode;
}

/**
 * Current policy facts are intentionally exact: the current policy identity,
 * current answer identity, and finite mandatory-stop facts. No untrusted page
 * text, question text, credentials, or model explanation crosses this seam.
 */
export interface CurrentApplicationSubmissionPolicyFacts {
  policy: ApplicationAuthorityDecisionPolicyIdentity | null;
  answers: SubmissionAnswerSnapshotIdentity;
  mandatoryStops: readonly SubmissionMandatoryStopFact[];
}

/** Modes whose authorization this gate can ever produce. */
export type AuthorizableSubmissionMode = Extract<
  ApplicationAutomationMode,
  "confirm_before_submit" | "autonomous_submit"
>;

export interface EvaluateApplicationSubmissionPolicyInput {
  /** Explicit caller clock; the policy never reads a wall clock itself. */
  now: string;
  /** Exact saved automation mode from durable preferences or settings. */
  savedMode: ApplicationAutomationMode;
  /** Current authority envelope exactly as saved and revisioned. */
  envelope: ApplicationAuthorityEnvelope;
  /** Durable preflight record produced before this attempt. */
  preflight: SubmissionPreflightRecord;
  /** Current job identity under consideration. */
  jobId: string;
  /** Current campaign identity, or null when the job has no campaign. */
  campaignId: string | null;
  /** Freshly observed HTTP(S) origin of the page about to be acted on. */
  origin: string;
  /** Freshly re-observed form identity (id, revision, digest). */
  formObservation: SubmissionObservationIdentity;
  /** Current resume SHA-256 digest in effect. */
  resumeSha256: Sha256Hex;
  /** Current answer-set revision and digest. */
  answers: SubmissionAnswerSnapshotIdentity;
  /** Current final-control signature and stable reference. */
  finalControl: SubmissionFinalControlIdentity;
  /** Current remaining per-run capacity at the moment of the decision. */
  remainingRunCapacity: number;
  /** Current remaining per-local-day capacity at the moment of the decision. */
  remainingDailyCapacity: number;
  /** Idempotency state of the preflight's bound key. */
  idempotency: SubmissionIdempotencyState;
  /** Exact current policy identity, answer identity, and finite stop facts. */
  currentPolicyFacts: CurrentApplicationSubmissionPolicyFacts;
  /**
   * Optional one-time execution grant. Consulted only by
   * `confirm_before_submit`; autonomous authority ignores it entirely and is
   * never derived from it.
   */
  executionGrant: SubmissionExecutionGrant | null;
}

/** Exact immutable execution binding handed to a future executor. */
export interface AuthorizedApplicationSubmission {
  status: "authorized";
  mode: AuthorizableSubmissionMode;
  preflightId: string;
  idempotencyKey: string;
  runId: string;
  jobId: string;
  resultId: string;
  applicationRecordId: string;
  authorityEnvelopeId: string;
  authorityRevision: number;
}

export interface BlockedApplicationSubmission {
  status: "blocked";
  reason: SubmissionPolicyBlockReason;
  detail: string;
}

export type ApplicationSubmissionDecision =
  | AuthorizedApplicationSubmission
  | BlockedApplicationSubmission;

/**
 * Canonical HTTP(S) origin of a URL string, or null when the value is not a
 * parseable HTTP(S) URL. Semantic equality compares these canonical forms so
 * default ports, case, paths, query strings, and fragments never create a
 * false mismatch — and non-HTTP(S) schemes never sneak through.
 */
function canonicalHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function describeAuthorityInactivity(
  envelope: ApplicationAuthorityEnvelope,
): string {
  if (envelope.status !== "active") {
    return `Authority envelope is ${envelope.status}, so it authorizes nothing.`;
  }
  return `Authority envelope expired at ${envelope.expiresAt ?? "an unrecorded time"}.`;
}

function describeStaleObservations(
  input: EvaluateApplicationSubmissionPolicyInput,
): string {
  const stale: string[] = [];
  const { preflight } = input;
  if (input.formObservation.id !== preflight.formObservation.id) {
    stale.push("form observation id");
  }
  if (input.formObservation.revision !== preflight.formObservation.revision) {
    stale.push("form observation revision");
  }
  if (input.formObservation.digest !== preflight.formObservation.digest) {
    stale.push("form observation digest");
  }
  if (input.answers.revision !== preflight.answers.revision) {
    stale.push("answer revision");
  }
  if (input.answers.digest !== preflight.answers.digest) {
    stale.push("answer digest");
  }
  if (input.finalControl.signature !== preflight.finalControl.signature) {
    stale.push("final control signature");
  }
  if (input.finalControl.ref !== preflight.finalControl.ref) {
    stale.push("final control ref");
  }
  return `Fresh observations differ from the preflight record: ${stale.join("; ")}.`;
}

function describeCapacityProblem(
  input: EvaluateApplicationSubmissionPolicyInput,
): string {
  if (
    input.remainingRunCapacity !== input.preflight.remainingRunCapacityBefore ||
    input.remainingDailyCapacity !==
      input.preflight.remainingDailyCapacityBefore
  ) {
    return `Remaining capacity changed since preflight (run ${input.preflight.remainingRunCapacityBefore} -> ${input.remainingRunCapacity}, day ${input.preflight.remainingDailyCapacityBefore} -> ${input.remainingDailyCapacity}).`;
  }
  if (input.remainingRunCapacity <= 0) {
    return "Remaining per-run capacity is exhausted.";
  }
  return "Remaining per-local-day capacity is exhausted.";
}

/**
 * Deterministic plain-text description of why the confirm-mode grant failed
 * its contract gate. Only identifiers, revisions, statuses, and timestamps
 * are echoed — never raw page content or credentials.
 */
function describeGrantRejection(
  grant: SubmissionExecutionGrant | null,
  now: string,
): string {
  if (grant === null) {
    return "confirm_before_submit mode requires an active user execution grant and none was provided.";
  }
  if (grant.status !== "active") {
    return `Execution grant is ${grant.status}, so it authorizes nothing.`;
  }
  const nowTime = Date.parse(now);
  if (!Number.isFinite(nowTime)) {
    return "Execution grant cannot be evaluated against an invalid clock.";
  }
  const expiresAtTime = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAtTime)) {
    return "Execution grant has an invalid expiry and authorizes nothing.";
  }
  if (expiresAtTime <= nowTime) {
    return `Execution grant expired at ${grant.expiresAt}.`;
  }
  return "Execution grant does not bind this attempt's exact preflight, idempotency key, lineage, or authority revision.";
}

function collectMandatoryStopCodes(
  input: EvaluateApplicationSubmissionPolicyInput,
): readonly SubmissionMandatoryStopCode[] {
  return [
    ...new Set(
      input.currentPolicyFacts.mandatoryStops.map((fact) => fact.code),
    ),
  ];
}

function hasValidCurrentPolicyFacts(
  facts: unknown,
): facts is CurrentApplicationSubmissionPolicyFacts {
  if (typeof facts !== "object" || facts === null || Array.isArray(facts)) {
    return false;
  }
  try {
    const candidate = facts as Record<string, unknown>;
    if (
      Object.keys(candidate).length !== 3 ||
      !Object.prototype.hasOwnProperty.call(candidate, "policy") ||
      !Object.prototype.hasOwnProperty.call(candidate, "answers") ||
      !Object.prototype.hasOwnProperty.call(candidate, "mandatoryStops")
    ) {
      return false;
    }
    ApplicationAuthorityDecisionPolicyIdentitySchema.nullable().parse(
      candidate.policy,
    );
    SubmissionAnswerSnapshotIdentitySchema.parse(candidate.answers);
    if (!Array.isArray(candidate.mandatoryStops)) {
      return false;
    }
    return (candidate.mandatoryStops as readonly unknown[]).every(
      (fact: unknown) =>
        typeof fact === "object" &&
        fact !== null &&
        !Array.isArray(fact) &&
        Object.keys(fact).length === 1 &&
        submissionMandatoryStopCodeValues.includes(
          (fact as { code?: unknown }).code as SubmissionMandatoryStopCode,
        ),
    );
  } catch {
    return false;
  }
}

function decisionPolicyIdentityMatches(
  left: ApplicationAuthorityDecisionPolicyIdentity | null,
  right: ApplicationAuthorityDecisionPolicyIdentity | null,
): boolean {
  return (
    left?.version === right?.version &&
    left?.revision === right?.revision &&
    left?.digest === right?.digest
  );
}

function mandatoryStopReason(
  code: SubmissionMandatoryStopCode,
): SubmissionPolicyBlockReason {
  switch (code) {
    case "stale_observation":
      return "observation_stale";
    case "origin_drift":
      return "origin_drift";
    case "outcome_uncertain":
      return "idempotency_outcome_uncertain";
    default:
      return code;
  }
}

function mandatoryStopDetail(code: SubmissionMandatoryStopCode): string {
  switch (code) {
    case "stale_observation":
      return "The current form observation is stale; pause for user review.";
    case "origin_drift":
      return "The page origin changed; pause for user review.";
    case "outcome_uncertain":
      return "The prior submission outcome is uncertain; automatic retry is permanently blocked.";
    default:
      return `Mandatory stop ${code} is present; pause for user review.`;
  }
}

/**
 * One deterministic auditable decision point for the final-submission action.
 *
 * Checks fail closed in a fixed order (first failure wins):
 * 1. saved mode vs envelope mode
 * 2. prepare_only
 * 3. elevated authority carries the decision policy
 * 4. envelope active and unexpired at the caller's clock
 * 5. preflight binds the current envelope id + revision + policy identity
 * 6. current job matches the preflight lineage
 * 7. current campaign/origin match the preflight binding
 * 8. job or exact campaign scope
 * 9. semantic equality with an allowed canonical origin
 * 10. resume digest allowlist + preflight match
 * 11. approved answer snapshot and fresh observation identities match
 * 12. finite mandatory stop facts are absent
 * 13. capacity is integral, envelope-bounded, unchanged, and positive
 * 14. idempotency key unused (executed and uncertain block distinctly)
 * 15. confirm-mode only: the one-time user grant passes its contract gate
 *
 * Autonomous mode rejects any supplied grant so confirm-mode authority cannot
 * be confused with or used to strengthen an autonomous envelope.
 */
export function evaluateApplicationSubmissionPolicy(
  input: EvaluateApplicationSubmissionPolicyInput,
): ApplicationSubmissionDecision {
  const blocked = (
    reason: SubmissionPolicyBlockReason,
    detail: string,
  ): BlockedApplicationSubmission => ({ status: "blocked", reason, detail });

  if (input.savedMode !== input.envelope.mode) {
    return blocked(
      "mode_mismatch",
      `Saved automation mode ${input.savedMode} does not match authority envelope mode ${input.envelope.mode}.`,
    );
  }
  if (input.savedMode === "prepare_only") {
    return blocked(
      "prepare_only",
      "Prepare-only automation never authorizes final submission.",
    );
  }
  if (!isActiveApplicationAuthorityEnvelope(input.envelope, input.now)) {
    return blocked(
      "authority_inactive",
      describeAuthorityInactivity(input.envelope),
    );
  }
  if (!hasValidCurrentPolicyFacts(input.currentPolicyFacts)) {
    return blocked(
      "current_policy_facts_invalid",
      "Current policy facts are missing or contain an unsupported stop code.",
    );
  }
  const decisionPolicy = input.envelope.decisionPolicy;
  if (
    (input.savedMode === "confirm_before_submit" ||
      input.savedMode === "autonomous_submit") &&
    decisionPolicy === null
  ) {
    return blocked(
      "decision_policy_missing",
      "Elevated authority has no decision policy and authorizes nothing.",
    );
  }
  if (
    input.preflight.authorityEnvelopeId !== input.envelope.id ||
    input.preflight.authorityRevision !== input.envelope.revision
  ) {
    return blocked(
      "preflight_authority_mismatch",
      `Preflight binds authority ${input.preflight.authorityEnvelopeId}@${input.preflight.authorityRevision} but the current envelope is ${input.envelope.id}@${input.envelope.revision}.`,
    );
  }
  if (
    !decisionPolicyIdentityMatches(
      input.preflight.decisionPolicy,
      decisionPolicy,
    )
  ) {
    return blocked(
      "decision_policy_mismatch",
      "The preflight decision-policy identity does not match the current authority policy.",
    );
  }
  if (input.jobId !== input.preflight.jobId) {
    return blocked(
      "preflight_lineage_mismatch",
      `Current job ${input.jobId} does not match preflight job ${input.preflight.jobId}.`,
    );
  }

  const observedOrigin = canonicalHttpOrigin(input.origin);
  if (input.preflight.campaignId !== input.campaignId) {
    return blocked(
      "preflight_scope_mismatch",
      "The current campaign does not match the campaign bound in the preflight.",
    );
  }

  const jobInScope = input.envelope.scope.jobIds.includes(input.jobId);
  const campaignInScope =
    input.envelope.scope.campaignId !== null &&
    input.envelope.scope.campaignId === input.campaignId;
  if (!jobInScope && !campaignInScope) {
    return blocked(
      "scope_excluded",
      `Job ${input.jobId} is not in the scoped job list and campaign ${
        input.campaignId ?? "(none)"
      } is not the scoped campaign.`,
    );
  }

  const allowedCanonicalOrigins = new Set(
    input.envelope.allowedOrigins.flatMap((allowed) => {
      const canonical = canonicalHttpOrigin(allowed);
      return canonical === null ? [] : [canonical];
    }),
  );
  if (observedOrigin === null || !allowedCanonicalOrigins.has(observedOrigin)) {
    return blocked(
      "origin_not_allowed",
      "Current page origin is not semantically equal to any allowed canonical origin.",
    );
  }
  if (
    input.preflight.origin === null ||
    input.preflight.origin !== observedOrigin
  ) {
    return blocked(
      "preflight_origin_mismatch",
      "The current canonical page origin does not match the origin bound in the preflight.",
    );
  }

  if (
    decisionPolicy !== null &&
    !decisionPolicyIdentityMatches(
      input.currentPolicyFacts.policy,
      decisionPolicy,
    )
  ) {
    return blocked(
      "decision_policy_mismatch",
      "The current policy fact does not match the authority decision policy.",
    );
  }
  if (
    input.currentPolicyFacts.answers.revision !== input.answers.revision ||
    input.currentPolicyFacts.answers.digest !== input.answers.digest
  ) {
    return blocked(
      "answer_policy_mismatch",
      "The current answer identity does not match the answer identity being evaluated.",
    );
  }

  if (
    decisionPolicy !== null &&
    (decisionPolicy.answerPolicy.approvedAnswerSnapshot.revision !==
      input.answers.revision ||
      decisionPolicy.answerPolicy.approvedAnswerSnapshot.digest !==
        input.answers.digest)
  ) {
    return blocked(
      "answer_policy_mismatch",
      "The current answers are not the exact user-approved answer snapshot in the decision policy.",
    );
  }

  if (
    !input.envelope.allowedResumeSha256.includes(input.resumeSha256) ||
    input.preflight.resumeSha256 !== input.resumeSha256
  ) {
    return blocked(
      "resume_not_allowed",
      input.envelope.allowedResumeSha256.includes(input.resumeSha256)
        ? "Current resume digest differs from the digest bound in the preflight record."
        : "Current resume digest is absent from the authority resume allowlist.",
    );
  }

  const { preflight } = input;
  if (
    input.formObservation.id !== preflight.formObservation.id ||
    input.formObservation.revision !== preflight.formObservation.revision ||
    input.formObservation.digest !== preflight.formObservation.digest ||
    input.answers.revision !== preflight.answers.revision ||
    input.answers.digest !== preflight.answers.digest ||
    input.finalControl.signature !== preflight.finalControl.signature ||
    input.finalControl.ref !== preflight.finalControl.ref
  ) {
    return blocked("observation_stale", describeStaleObservations(input));
  }

  const stopCodes = collectMandatoryStopCodes(input);
  const firstMandatoryStop = stopCodes[0];
  if (firstMandatoryStop !== undefined) {
    return blocked(
      mandatoryStopReason(firstMandatoryStop),
      mandatoryStopDetail(firstMandatoryStop),
    );
  }

  if (
    !Number.isSafeInteger(input.remainingRunCapacity) ||
    !Number.isSafeInteger(input.remainingDailyCapacity) ||
    input.remainingRunCapacity > input.envelope.maxApplicationsPerRun ||
    input.remainingDailyCapacity > input.envelope.maxApplicationsPerLocalDay ||
    input.remainingRunCapacity !== preflight.remainingRunCapacityBefore ||
    input.remainingDailyCapacity !== preflight.remainingDailyCapacityBefore ||
    input.remainingRunCapacity <= 0 ||
    input.remainingDailyCapacity <= 0
  ) {
    return blocked("capacity_invalid", describeCapacityProblem(input));
  }

  if (input.idempotency === "executed") {
    return blocked(
      "idempotency_already_executed",
      `Idempotency key ${preflight.idempotencyKey} already executed a submission; retry is blocked.`,
    );
  }
  if (input.idempotency === "outcome_uncertain") {
    return blocked(
      "idempotency_outcome_uncertain",
      `A prior attempt for idempotency key ${preflight.idempotencyKey} ended outcome_uncertain; automatic retry is permanently blocked until resolved by a human.`,
    );
  }

  // Autonomous authority comes from the active envelope plus the checks
  // above; the optional grant is deliberately never consulted here.
  if (input.savedMode === "confirm_before_submit") {
    if (
      input.executionGrant === null ||
      !isActiveSubmissionExecutionGrant(
        input.executionGrant,
        input.now,
        input.preflight,
      )
    ) {
      return blocked(
        "execution_grant_invalid",
        describeGrantRejection(input.executionGrant, input.now),
      );
    }
  } else if (input.executionGrant !== null) {
    return blocked(
      "unexpected_execution_grant",
      "Autonomous authority cannot be strengthened by an execution grant.",
    );
  }

  return {
    status: "authorized",
    mode: input.savedMode,
    preflightId: preflight.id,
    idempotencyKey: preflight.idempotencyKey,
    runId: preflight.runId,
    jobId: preflight.jobId,
    resultId: preflight.resultId,
    applicationRecordId: preflight.applicationRecordId,
    authorityEnvelopeId: input.envelope.id,
    authorityRevision: input.envelope.revision,
  };
}
