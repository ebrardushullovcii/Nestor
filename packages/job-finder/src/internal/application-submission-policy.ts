import type {
  ApplicationAuthorityEnvelope,
  ApplicationAuthorityDecisionPolicyIdentity,
  ApplicationAutomationMode,
  Sha256Hex,
  SubmissionAnswerSnapshotIdentity,
  SubmissionExecutionGrant,
  SubmissionFinalControlIdentity,
  SubmissionObservationIdentity,
  SubmissionPreflightRecord,
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
export type AuthorizableSubmissionMode = ApplicationAutomationMode;

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
