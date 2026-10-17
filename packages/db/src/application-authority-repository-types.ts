import type {
  ApplicationAuthorityEnvelope,
  ApplicationAuthorityStatus,
  SubmissionArmedMarker,
  SubmissionExecutionGrant,
  SubmissionExecutionGrantStatus,
  SubmissionIdempotencyRecord,
  SubmissionIdempotencyStatus,
  SubmissionOutcomeRecord,
  SubmissionOutcomeResolutionInput,
  SubmissionPreflightRecord,
} from "@nestor/contracts";

export type ApplicationAuthorityEnvelopeCommitResult =
  | {
      status: "applied";
      envelope: ApplicationAuthorityEnvelope;
    }
  | {
      status: "stale";
      current: ApplicationAuthorityEnvelope | null;
    }
  | {
      status: "missing";
      current: null;
    };

/**
 * Atomic authority rotation outcome.
 *
 * A replacement is a new envelope identity: the expected active predecessor
 * is revoked (including its still-available execution children) and the new
 * active envelope is inserted in the same repository transaction. Returning
 * both envelopes keeps the lifecycle boundary inspectable to callers without
 * exposing storage details.
 */
export type ApplicationAuthorityEnvelopeReplacementResult =
  | {
      status: "applied";
      previous: ApplicationAuthorityEnvelope;
      envelope: ApplicationAuthorityEnvelope;
    }
  | {
      status: "stale";
      current: ApplicationAuthorityEnvelope | null;
    }
  | {
      status: "missing";
      current: null;
    }
  | {
      status: "conflict";
      current: ApplicationAuthorityEnvelope;
    };

export interface ReplaceApplicationAuthorityEnvelopeInput {
  /** Identity of the active predecessor that must match the CAS revision. */
  currentId: string;
  expectedRevision: number;
  /** New identity to insert as the sole active envelope (revision must be 1). */
  replacement: ApplicationAuthorityEnvelope;
  revokedAt: string;
}

export type SubmissionPreflightCommitResult =
  | {
      status: "created";
      preflight: SubmissionPreflightRecord;
      idempotency: SubmissionIdempotencyRecord;
    }
  | {
      status: "duplicate";
      preflight: SubmissionPreflightRecord;
      idempotency: SubmissionIdempotencyRecord;
    }
  | {
      status: "conflict";
      current: SubmissionPreflightRecord | null;
    };

export type SubmissionExecutionGrantCommitResult =
  | {
      status: "created";
      grant: SubmissionExecutionGrant;
    }
  | {
      status: "duplicate";
      grant: SubmissionExecutionGrant;
    }
  | {
      status: "conflict";
      current: SubmissionExecutionGrant | null;
    }
  | {
      status: "missing_preflight";
    };

export type SubmissionExecutionGrantTransitionResult =
  | {
      status: "consumed" | "revoked" | "expired";
      grant: SubmissionExecutionGrant;
    }
  | {
      status: "missing";
      grant: null;
    }
  | {
      status: "stale";
      grant: SubmissionExecutionGrant;
    };

/**
 * The only two modes that may cross the durable final-action boundary. A
 * prepare-only envelope can still be persisted, but it can never be armed by
 * this transition.
 */
export type SubmissionAttemptArmMode =
  | "confirm_before_submit"
  | "autonomous_submit";

export type SubmissionAttemptArmBlockReason =
  | "invalid_input"
  | "authority_missing"
  | "authority_inactive"
  | "authority_mode_mismatch"
  | "authority_revision_mismatch"
  | "authority_policy_digest_invalid"
  | "preflight_missing"
  | "preflight_mismatch"
  | "decision_policy_mismatch"
  | "answer_snapshot_mismatch"
  | "scope_excluded"
  | "origin_not_allowed"
  | "resume_not_allowed"
  | "capacity_invalid"
  | "idempotency_missing"
  | "idempotency_lineage_mismatch"
  | "idempotency_revision_mismatch"
  | "idempotency_not_available"
  | "execution_grant_missing"
  | "execution_grant_mismatch"
  | "execution_grant_not_active"
  | "execution_grant_expired"
  | "execution_grant_required"
  | "unexpected_execution_grant"
  | "marker_mismatch"
  | "marker_conflict"
  | "armed_marker_missing"
  | "armed_marker_mismatch";

export interface AuthorizeAndArmSubmissionAttemptInput {
  preflight: SubmissionPreflightRecord;
  expectedIdempotencyRevision: number;
  mode: SubmissionAttemptArmMode;
  marker: SubmissionArmedMarker;
  /** Confirm mode supplies the exact grant; autonomous mode must supply null. */
  executionGrantId: string | null;
  now: string;
}

export type SubmissionAttemptArmResult =
  | {
      status: "armed" | "duplicate";
      idempotency: SubmissionIdempotencyRecord;
      marker: SubmissionArmedMarker;
      executionGrant: SubmissionExecutionGrant | null;
    }
  | {
      status: "blocked" | "stale" | "missing";
      reason: SubmissionAttemptArmBlockReason;
      idempotency: SubmissionIdempotencyRecord | null;
      marker: SubmissionArmedMarker | null;
      executionGrant: SubmissionExecutionGrant | null;
    };

export type SubmissionOutcomeCommitResult =
  | {
      status: "recorded";
      outcome: SubmissionOutcomeRecord;
      idempotency: SubmissionIdempotencyRecord;
    }
  | {
      status: "duplicate";
      outcome: SubmissionOutcomeRecord;
      idempotency: SubmissionIdempotencyRecord;
    }
  | {
      status: "stale" | "blocked";
      idempotency: SubmissionIdempotencyRecord;
      outcome: SubmissionOutcomeRecord | null;
    }
  | {
      status: "missing";
      idempotency: null;
      outcome: null;
    };

export type SubmissionOutcomeResolutionResult =
  | {
      status: "recorded" | "duplicate";
      previousOutcome: SubmissionOutcomeRecord;
      outcome: SubmissionOutcomeRecord;
      idempotency: SubmissionIdempotencyRecord;
    }
  | {
      status: "stale" | "blocked";
      previousOutcome: SubmissionOutcomeRecord | null;
      outcome: SubmissionOutcomeRecord | null;
      idempotency: SubmissionIdempotencyRecord | null;
    }
  | {
      status: "missing";
      previousOutcome: null;
      outcome: null;
      idempotency: null;
    };

export interface SubmissionPreflightQuery {
  id?: string;
  idempotencyKey?: string;
  runId?: string;
  jobId?: string;
  resultId?: string;
  applicationRecordId?: string;
}

export interface SubmissionExecutionGrantQuery {
  id?: string;
  preflightId?: string;
  idempotencyKey?: string;
  status?: SubmissionExecutionGrantStatus;
}

export interface SubmissionIdempotencyQuery {
  id?: string;
  idempotencyKey?: string;
  preflightId?: string;
  status?: SubmissionIdempotencyStatus;
}

export interface SubmissionOutcomeQuery {
  id?: string;
  preflightId?: string;
  idempotencyKey?: string;
  runId?: string;
  jobId?: string;
  resultId?: string;
  applicationRecordId?: string;
}

export interface ApplicationAuthorityRepository {
  listApplicationAuthorityEnvelopes(options?: {
    id?: string;
    status?: ApplicationAuthorityStatus;
  }): Promise<readonly ApplicationAuthorityEnvelope[]>;
  getApplicationAuthorityEnvelope(
    id: string,
  ): Promise<ApplicationAuthorityEnvelope | null>;
  commitApplicationAuthorityEnvelope(input: {
    envelope: ApplicationAuthorityEnvelope;
    expectedRevision: number | null;
  }): Promise<ApplicationAuthorityEnvelopeCommitResult>;
  /**
   * Atomically revokes one expected active envelope, propagates that
   * revocation to active grants and available idempotency records, and inserts
   * a distinct replacement envelope. No intermediate state is observable.
   */
  replaceApplicationAuthorityEnvelope(
    input: ReplaceApplicationAuthorityEnvelopeInput,
  ): Promise<ApplicationAuthorityEnvelopeReplacementResult>;
  revokeApplicationAuthorityEnvelope(input: {
    id: string;
    expectedRevision: number;
    revokedAt: string;
  }): Promise<ApplicationAuthorityEnvelopeCommitResult>;

  listSubmissionPreflightRecords(
    options?: SubmissionPreflightQuery,
  ): Promise<readonly SubmissionPreflightRecord[]>;
  getSubmissionPreflightRecord(
    id: string,
  ): Promise<SubmissionPreflightRecord | null>;
  commitSubmissionPreflight(
    preflight: SubmissionPreflightRecord,
  ): Promise<SubmissionPreflightCommitResult>;

  listSubmissionExecutionGrants(
    options?: SubmissionExecutionGrantQuery,
  ): Promise<readonly SubmissionExecutionGrant[]>;
  getSubmissionExecutionGrant(
    id: string,
  ): Promise<SubmissionExecutionGrant | null>;
  commitSubmissionExecutionGrant(
    grant: SubmissionExecutionGrant,
  ): Promise<SubmissionExecutionGrantCommitResult>;
  revokeSubmissionExecutionGrant(input: {
    id: string;
    revokedAt: string;
  }): Promise<SubmissionExecutionGrantTransitionResult>;
  expireSubmissionExecutionGrants(now: string): Promise<number>;

  listSubmissionIdempotencyRecords(
    options?: SubmissionIdempotencyQuery,
  ): Promise<readonly SubmissionIdempotencyRecord[]>;
  getSubmissionIdempotencyRecord(
    idempotencyKey: string,
  ): Promise<SubmissionIdempotencyRecord | null>;
  /**
   * Transaction-current authority gate and arm transition. The repository
   * re-reads all bound records inside one mutation, consumes a confirm grant
   * (when required), and writes the armed marker plus idempotency state as one
   * durable operation.
   */
  authorizeAndArmSubmissionAttempt(
    input: AuthorizeAndArmSubmissionAttemptInput,
  ): Promise<SubmissionAttemptArmResult>;
  listSubmissionArmedMarkers(options?: {
    id?: string;
    idempotencyKey?: string;
    preflightId?: string;
  }): Promise<readonly SubmissionArmedMarker[]>;

  listSubmissionOutcomeRecords(
    options?: SubmissionOutcomeQuery,
  ): Promise<readonly SubmissionOutcomeRecord[]>;
  getSubmissionOutcomeRecord(
    id: string,
  ): Promise<SubmissionOutcomeRecord | null>;
  commitSubmissionOutcome(input: {
    outcome: SubmissionOutcomeRecord;
    expectedIdempotencyRevision?: number;
  }): Promise<SubmissionOutcomeCommitResult>;
  /**
   * Atomically resolves one uncertain outcome through explicit operator
   * verification. The original uncertain outcome remains in history; the
   * replacement outcome shares its idempotency key and exact lineage.
   */
  resolveSubmissionOutcome(
    input: SubmissionOutcomeResolutionInput,
  ): Promise<SubmissionOutcomeResolutionResult>;
  recoverArmedSubmissionAttempts(input: {
    now: string;
  }): Promise<readonly SubmissionOutcomeRecord[]>;
}
