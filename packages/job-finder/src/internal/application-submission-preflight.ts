import { createHash } from "node:crypto";

import {
  ApplicationAuthorityCanonicalOriginSchema,
  ApplicationAuthorityDecisionPolicyIdentitySchema,
  Sha256HexSchema,
  SubmissionAnswerSnapshotIdentitySchema,
  SubmissionFinalControlIdentitySchema,
  SubmissionObservationIdentitySchema,
  SubmissionPreflightRecordSchema,
  type ApplicationAuthorityCanonicalOrigin,
  type ApplicationAuthorityDecisionPolicyIdentity,
  type Sha256Hex,
  type SubmissionAnswerSnapshotIdentity,
  type SubmissionFinalControlIdentity,
  type SubmissionObservationIdentity,
  type SubmissionPreflightRecord,
} from "@nestor/contracts";
import type {
  JobFinderRepository,
  SubmissionPreflightCommitResult,
} from "@nestor/db";

/**
 * The repository surface deliberately stops at preflight persistence. No
 * grant, arm, browser, or final-action method is available to this module.
 */
export type SubmissionPreflightCoordinatorRepository = Pick<
  JobFinderRepository,
  "commitSubmissionPreflight"
>;

/** Exact lineage that is carried into the durable preflight record. */
export interface SubmissionPreflightLineageFacts {
  readonly runId: SubmissionPreflightRecord["runId"];
  readonly jobId: SubmissionPreflightRecord["jobId"];
  readonly resultId: SubmissionPreflightRecord["resultId"];
  readonly applicationRecordId: SubmissionPreflightRecord["applicationRecordId"];
  readonly campaignId: SubmissionPreflightRecord["campaignId"];
}

/** Current finite capacity facts captured before an attempt. */
export interface SubmissionPreflightCapacityFacts {
  readonly remainingRunCapacity: number;
  readonly remainingDailyCapacity: number;
}

/**
 * Typed facts needed to construct one immutable preflight. The resume digest
 * is intentionally absent: the coordinator derives it from the supplied
 * bytes instead of accepting a caller-declared digest.
 */
export interface CreateSubmissionPreflightInput {
  readonly repository: SubmissionPreflightCoordinatorRepository;
  readonly id: SubmissionPreflightRecord["id"];
  readonly idempotencyKey: SubmissionPreflightRecord["idempotencyKey"];
  readonly lineage: SubmissionPreflightLineageFacts;
  readonly authorityEnvelopeId: SubmissionPreflightRecord["authorityEnvelopeId"];
  readonly authorityRevision: SubmissionPreflightRecord["authorityRevision"];
  readonly decisionPolicy: ApplicationAuthorityDecisionPolicyIdentity | null;
  /** Current page URL or origin; only its canonical HTTP(S) origin is stored. */
  readonly origin: string;
  readonly formObservation: SubmissionObservationIdentity;
  readonly resumeBytes: Uint8Array;
  readonly answers: SubmissionAnswerSnapshotIdentity;
  readonly finalControl: SubmissionFinalControlIdentity;
  readonly capacity: SubmissionPreflightCapacityFacts;
  readonly createdAt: SubmissionPreflightRecord["createdAt"];
}

function deriveResumeSha256(bytes: Uint8Array): Sha256Hex {
  // A copy makes the digest independent of later mutation of a caller-owned
  // view while this coordinator awaits the repository commit.
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("resumeBytes must be a Uint8Array.");
  }
  const snapshot = new Uint8Array(bytes);
  return Sha256HexSchema.parse(
    createHash("sha256").update(snapshot).digest("hex"),
  );
}

/**
 * Canonicalizes a current page URL to the origin accepted by the preflight
 * contract. Credentials and non-HTTP(S) schemes are rejected before URL.origin
 * could silently discard them.
 */
function canonicalizeOrigin(
  value: string,
): ApplicationAuthorityCanonicalOrigin {
  if (typeof value !== "string") {
    throw new TypeError("origin must be a string.");
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return ApplicationAuthorityCanonicalOriginSchema.parse(value);
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    return ApplicationAuthorityCanonicalOriginSchema.parse(value);
  }

  return ApplicationAuthorityCanonicalOriginSchema.parse(url.origin);
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeDeep(child);
  }
  return value;
}

/**
 * Builds and schema-validates the immutable persistence payload. This function
 * has no repository or browser side effects and is intentionally kept inside
 * Job Finder's internal module boundary.
 */
export function buildSubmissionPreflightRecord(
  input: Omit<CreateSubmissionPreflightInput, "repository">,
): SubmissionPreflightRecord {
  const policy =
    ApplicationAuthorityDecisionPolicyIdentitySchema.nullable().parse(
      input.decisionPolicy,
    );
  const answers = SubmissionAnswerSnapshotIdentitySchema.parse(input.answers);
  const formObservation = SubmissionObservationIdentitySchema.parse(
    input.formObservation,
  );
  const finalControl = SubmissionFinalControlIdentitySchema.parse(
    input.finalControl,
  );
  const origin = canonicalizeOrigin(input.origin);
  const resumeSha256 = deriveResumeSha256(input.resumeBytes);

  const record = SubmissionPreflightRecordSchema.parse({
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    runId: input.lineage.runId,
    jobId: input.lineage.jobId,
    resultId: input.lineage.resultId,
    applicationRecordId: input.lineage.applicationRecordId,
    campaignId: input.lineage.campaignId,
    origin,
    authorityEnvelopeId: input.authorityEnvelopeId,
    authorityRevision: input.authorityRevision,
    decisionPolicy: policy,
    formObservation,
    resumeSha256,
    answers,
    finalControl,
    remainingRunCapacityBefore: input.capacity.remainingRunCapacity,
    remainingDailyCapacityBefore: input.capacity.remainingDailyCapacity,
    createdAt: input.createdAt,
  });

  return freezeDeep(record);
}

/**
 * Persists exactly one preflight through the repository CAS/idempotency
 * boundary. The repository's created/duplicate/conflict truth is returned
 * unchanged; this coordinator never creates a grant or arms an attempt.
 */
export async function commitSubmissionPreflight(
  input: CreateSubmissionPreflightInput,
): Promise<SubmissionPreflightCommitResult> {
  const record = buildSubmissionPreflightRecord(input);
  return input.repository.commitSubmissionPreflight(record);
}
