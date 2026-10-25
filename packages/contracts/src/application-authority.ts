import { z } from "zod";

import {
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  UrlStringSchema,
} from "./base";

/**
 * ADR 0012 / ADR 0013 application-authority contracts.
 *
 * These schemas are the durable foundation for user-scoped autonomous
 * application execution. They are additive only: current production remains
 * prepare-only and no runtime behavior changes until these contracts are wired
 * through an explicit vertical slice per mode.
 *
 * Layering note: this module intentionally depends only on `./base`. The
 * apply-flow module imports from here, so shared origin/path validators are
 * re-declared locally (structurally identical to the privacy-receipt rules)
 * instead of imported from `./apply`, which would create a circular module
 * dependency.
 */

/** Lowercase hex SHA-256 digest used for every content binding in this file. */
export const Sha256HexSchema = z
  .string()
  .regex(
    /^[a-f0-9]{64}$/,
    "SHA-256 must be 64 lowercase hexadecimal characters.",
  );
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;

/**
 * Durable application automation mode (ADR 0012).
 *
 * This is a separate axis from the `ApplyRunModeSchema` run strategy
 * (`copilot` / `single_job_auto` / `queue_auto`): a run strategy describes how
 * work is orchestrated, never whether final submission is authorized.
 */
export const applicationAutomationModeValues = [
  "prepare_only",
  "confirm_before_submit",
  "autonomous_submit",
] as const;
export const ApplicationAutomationModeSchema = z.enum(
  applicationAutomationModeValues,
);
export type ApplicationAutomationMode = z.infer<
  typeof ApplicationAutomationModeSchema
>;

export const applicationAuthorityStatusValues = [
  "active",
  "revoked",
  "expired",
] as const;
export const ApplicationAuthorityStatusSchema = z.enum(
  applicationAuthorityStatusValues,
);
export type ApplicationAuthorityStatus = z.infer<
  typeof ApplicationAuthorityStatusSchema
>;

/** Bounded collection sizes so no authority document grows unbounded. */
export const applicationAuthorityMaxScopedJobIds = 1000;
export const applicationAuthorityMaxResumeDigests = 1000;
export const applicationAuthorityMaxOrigins = 1000;

/**
 * Exact HTTP(S) origin scope. Structurally identical to the privacy-receipt
 * destination-origin rule; kept local to avoid a circular dependency on the
 * apply module.
 */
export const ApplicationAuthorityOriginSchema = UrlStringSchema.refine(
  (value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.username.length === 0 &&
        url.password.length === 0 &&
        url.pathname === "/" &&
        url.search.length === 0 &&
        url.hash.length === 0
      );
    } catch {
      return false;
    }
  },
  {
    message: "Allowed origin must contain only an HTTP(S) scheme and host.",
  },
);
export type ApplicationAuthorityOrigin = z.infer<
  typeof ApplicationAuthorityOriginSchema
>;

/**
 * Canonical HTTP(S) origin persisted on a preflight. Unlike the broader
 * envelope origin input, this value must already equal `URL.origin`, so
 * default ports, host casing, paths, queries, credentials, and fragments
 * cannot be smuggled into a transactional origin binding.
 */
export const ApplicationAuthorityCanonicalOriginSchema =
  ApplicationAuthorityOriginSchema.refine(
    (value) => {
      try {
        return value === new URL(value).origin;
      } catch {
        return false;
      }
    },
    {
      message:
        "Origin must be the canonical HTTP(S) origin without a path, query, fragment, credentials, or default port.",
    },
  );
export type ApplicationAuthorityCanonicalOrigin = z.infer<
  typeof ApplicationAuthorityCanonicalOriginSchema
>;

/** Redacted absolute path without query or fragment (privacy-receipt rule). */
const AuthoritySafePathSchema = z
  .string()
  .trim()
  .min(1)
  .regex(
    /^\/[^\s?#\\]*$/,
    "Safe path must be an absolute redacted path without a query or fragment.",
  );

export const ApplicationAuthorityScopeSchema = z
  .object({
    campaignId: NonEmptyStringSchema.nullable(),
    jobIds: z
      .array(NonEmptyStringSchema)
      .max(applicationAuthorityMaxScopedJobIds),
  })
  .strict();
export type ApplicationAuthorityScope = z.infer<
  typeof ApplicationAuthorityScopeSchema
>;

/** Digest-bound answer-set identity; raw answers never enter an authority record. */
export const SubmissionAnswerSnapshotIdentitySchema = z
  .object({
    revision: z.number().int().positive(),
    digest: Sha256HexSchema,
  })
  .strict();
export type SubmissionAnswerSnapshotIdentity = z.infer<
  typeof SubmissionAnswerSnapshotIdentitySchema
>;

/**
 * Kinds of declaration a form can ask the applicant to make about themselves.
 *
 * These are the statements a person signs rather than facts a product can
 * look up: equal-opportunity self-identification, consent to a background
 * check, a certification that every answer is true, acceptance of the
 * employer's terms, a privacy notice, and optional marketing contact. An
 * automated run answers one of these only when the saved authority document
 * names that exact kind; anything else pauses for the person.
 */
export const applicationAttestationKindValues = [
  "equal_opportunity_self_identification",
  "background_check_consent",
  "truthfulness_certification",
  "terms_acceptance",
  "privacy_notice_acknowledgement",
  "marketing_contact_consent",
] as const;
export const ApplicationAttestationKindSchema = z.enum(
  applicationAttestationKindValues,
);
export type ApplicationAttestationKind = z.infer<
  typeof ApplicationAttestationKindSchema
>;

/**
 * How an automated run may answer a question about pay.
 *
 * `pause_for_user` is the safe default: pay is a negotiating position, and a
 * saved number can cost the person money. `answer_from_profile` is only ever
 * a deliberate choice.
 */
export const applicationSalaryDisclosureRuleValues = [
  "pause_for_user",
  "answer_from_profile",
] as const;
export const ApplicationSalaryDisclosureRuleSchema = z.enum(
  applicationSalaryDisclosureRuleValues,
);
export type ApplicationSalaryDisclosureRule = z.infer<
  typeof ApplicationSalaryDisclosureRuleSchema
>;

/**
 * Explicit answer decisions for an elevated authority envelope.
 *
 * Every stop value is a literal rather than a configurable string. This keeps
 * guessing, skipping, silent continuation, and invented answers
 * structurally unrepresentable. The snapshot binds the authority to the
 * exact user-approved answer set; raw answers never cross this contract.
 *
 * `preApprovedAttestationKinds` is the one list the person can widen, and it
 * is an allowlist of exact kinds, never a blanket permission. An empty list
 * (the default) means every declaration pauses for the person.
 */
export const ApplicationAuthorityAnswerPolicySchema = z
  .object({
    approvedAnswerSnapshot: SubmissionAnswerSnapshotIdentitySchema,
    unknownRequiredQuestion: z.literal("pause_for_user"),
    unknownEligibility: z.literal("pause_for_user"),
    unknownLegalRequirement: z.literal("pause_for_user"),
    preApprovedAttestationKinds: z
      .array(ApplicationAttestationKindSchema)
      .max(applicationAttestationKindValues.length)
      .default([])
      .refine(
        (values) => new Set(values).size === values.length,
        "Pre-approved declaration kinds must be unique.",
      ),
    salaryDisclosure:
      ApplicationSalaryDisclosureRuleSchema.default("pause_for_user"),
  })
  .strict();
export type ApplicationAuthorityAnswerPolicy = z.infer<
  typeof ApplicationAuthorityAnswerPolicySchema
>;

/**
 * Explicit technical and outcome stops for elevated authority.
 *
 * These are intentionally fixed fail-closed actions. In particular,
 * credentials, authentication challenges, account creation, stale or
 * ambiguous controls, and origin drift always pause for a person. An
 * uncertain final outcome is permanently non-retryable.
 */
export const ApplicationAuthorityStopConditionsSchema = z
  .object({
    unavailableCredentials: z.literal("pause_for_user"),
    loginRequired: z.literal("pause_for_user"),
    mfaRequired: z.literal("pause_for_user"),
    captcha: z.literal("pause_for_user"),
    antiBot: z.literal("pause_for_user"),
    accountCreation: z.literal("pause_for_user"),
    staleObservation: z.literal("pause_for_user"),
    ambiguousFinalControl: z.literal("pause_for_user"),
    originDrift: z.literal("pause_for_user"),
    outcomeUncertain: z.literal("stop_no_retry"),
  })
  .strict();
export type ApplicationAuthorityStopConditions = z.infer<
  typeof ApplicationAuthorityStopConditionsSchema
>;

/** Schema version for the exact decision-policy document in force. */
export const ApplicationAuthorityDecisionPolicyVersionSchema = z.literal(1);
export type ApplicationAuthorityDecisionPolicyVersion = z.infer<
  typeof ApplicationAuthorityDecisionPolicyVersionSchema
>;

export const ApplicationAuthorityDecisionPolicyIdentitySchema = z
  .object({
    version: ApplicationAuthorityDecisionPolicyVersionSchema,
    revision: z.number().int().positive(),
    digest: Sha256HexSchema,
  })
  .strict();
export type ApplicationAuthorityDecisionPolicyIdentity = z.infer<
  typeof ApplicationAuthorityDecisionPolicyIdentitySchema
>;

/** The complete immutable decision-policy document when authority is elevated. */
export const ApplicationAuthorityDecisionPolicySchema = z
  .object({
    version: ApplicationAuthorityDecisionPolicyVersionSchema,
    revision: z.number().int().positive(),
    digest: Sha256HexSchema,
    answerPolicy: ApplicationAuthorityAnswerPolicySchema,
    stopConditions: ApplicationAuthorityStopConditionsSchema,
  })
  .strict();
export type ApplicationAuthorityDecisionPolicy = z.infer<
  typeof ApplicationAuthorityDecisionPolicySchema
>;

/**
 * Canonical privacy-safe bytes for the decision-policy digest.
 *
 * Revision and digest are identity metadata and are deliberately excluded.
 * The payload contains only the schema version, approved answer-snapshot
 * identity, and fixed fail-closed actions; it never contains raw answers,
 * credentials, page content, or DOM data. Callers hash this exact UTF-8 string
 * with SHA-256 at the trusted persistence boundary.
 */
const ApplicationAuthorityDecisionPolicyDigestPayloadSchema =
  ApplicationAuthorityDecisionPolicySchema.pick({
    version: true,
    answerPolicy: true,
    stopConditions: true,
  });

export function serializeApplicationAuthorityDecisionPolicyForDigest(
  policy: z.input<typeof ApplicationAuthorityDecisionPolicyDigestPayloadSchema>,
): string {
  const parsed =
    ApplicationAuthorityDecisionPolicyDigestPayloadSchema.parse(policy);
  return JSON.stringify(parsed);
}

/**
 * Explicit, inspectable, revocable, scoped authority envelope (ADR 0012).
 *
 * Every field is required and explicit — there are no hidden product defaults
 * beyond the v1-pinned false account-creation capability. Model output can
 * never mint or widen this envelope; only the saved document, checked against
 * its exact revision, grants authority.
 *
 * Fail-closed invariants (superRefine):
 * - revoked status and revokedAt always appear together, never separately
 * - expiresAt must be strictly after createdAt; expired status requires an
 *   expiry timestamp; revokedAt cannot precede creation
 * - confirm_before_submit and autonomous_submit require a non-empty scope
 *   (campaign or jobs) and a non-empty resume allowlist
 * - duplicate job IDs, resume digests, and origins are rejected
 *
 * An envelope whose status is not `active` parses as data but must fail
 * closed at every use site; see `isActiveApplicationAuthorityEnvelope`.
 */
export const ApplicationAuthorityEnvelopeSchema = z
  .object({
    id: NonEmptyStringSchema,
    mode: ApplicationAutomationModeSchema,
    status: ApplicationAuthorityStatusSchema,
    revision: z.number().int().positive(),
    scope: ApplicationAuthorityScopeSchema,
    maxApplicationsPerRun: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER),
    intermediateMutationsAuthorized: z.boolean(),
    // Pinned false for v1: autonomous authority never includes creating
    // employer accounts. Widening this requires an explicit contract change.
    accountCreationAuthorized: z.literal(false),
    allowedResumeSha256: z
      .array(Sha256HexSchema)
      .max(applicationAuthorityMaxResumeDigests),
    allowedOrigins: z
      .array(ApplicationAuthorityOriginSchema)
      .min(1)
      .max(applicationAuthorityMaxOrigins),
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema.nullable(),
    revokedAt: IsoDateTimeSchema.nullable(),
    // Legacy prepare-only envelopes may omit policy and normalize to null.
    // Elevated authority must carry this exact immutable policy document.
    decisionPolicy:
      ApplicationAuthorityDecisionPolicySchema.nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "revoked" && value.revokedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A revoked authority envelope must record revokedAt.",
        path: ["revokedAt"],
      });
    }
    if (value.status !== "revoked" && value.revokedAt !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "revokedAt may only be recorded on a revoked authority envelope.",
        path: ["status"],
      });
    }

    if (
      value.expiresAt !== null &&
      Date.parse(value.expiresAt) <= Date.parse(value.createdAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expiresAt must be strictly after createdAt.",
        path: ["expiresAt"],
      });
    }
    if (value.status === "expired" && value.expiresAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An expired authority envelope must record expiresAt.",
        path: ["status"],
      });
    }

    if (
      value.revokedAt !== null &&
      Date.parse(value.revokedAt) < Date.parse(value.createdAt)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "revokedAt cannot precede createdAt.",
        path: ["revokedAt"],
      });
    }

    if (
      value.mode === "confirm_before_submit" ||
      value.mode === "autonomous_submit"
    ) {
      const hasExplicitScope =
        value.scope.campaignId !== null || value.scope.jobIds.length > 0;
      if (!hasExplicitScope) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Confirm and autonomous authority require an explicit campaign or job scope.",
          path: ["scope"],
        });
      }
      if (value.allowedResumeSha256.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Confirm and autonomous authority require an exact resume SHA-256 allowlist.",
          path: ["allowedResumeSha256"],
        });
      }
      if (value.expiresAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Confirm and autonomous authority require an explicit expiry.",
          path: ["expiresAt"],
        });
      }
    }

    const hasDecisionPolicy = value.decisionPolicy !== null;
    const elevated =
      value.mode === "confirm_before_submit" ||
      value.mode === "autonomous_submit";
    if (elevated && !hasDecisionPolicy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Confirm and autonomous authority require an explicit decision-policy identity and rules.",
        path: ["decisionPolicy"],
      });
    }
    if (value.intermediateMutationsAuthorized && !hasDecisionPolicy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Intermediate external mutation capability requires an explicit decision-policy identity and rules.",
        path: ["decisionPolicy"],
      });
    }
    if (value.intermediateMutationsAuthorized && value.expiresAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Intermediate external mutation capability requires an explicit expiry.",
        path: ["expiresAt"],
      });
    }
    // Field saves on employer sites are on by default (ADR 0024), so one
    // grant covers every job, resume and origin the person applies with; the
    // old "exactly one of each" pin made the second application of a session
    // fail validation.

    if (new Set(value.scope.jobIds).size !== value.scope.jobIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Scoped job IDs must be unique.",
        path: ["scope", "jobIds"],
      });
    }
    if (
      new Set(value.allowedResumeSha256).size !==
      value.allowedResumeSha256.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Allowed resume digests must be unique.",
        path: ["allowedResumeSha256"],
      });
    }
    const canonicalOrigins = value.allowedOrigins.map((origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        // The element schema already reports the malformed origin. Preserve a
        // stable fallback here so semantic duplicate validation never throws.
        return origin;
      }
    });
    if (new Set(canonicalOrigins).size !== canonicalOrigins.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Allowed origins must be unique.",
        path: ["allowedOrigins"],
      });
    }
  });
export type ApplicationAuthorityEnvelope = z.infer<
  typeof ApplicationAuthorityEnvelopeSchema
>;

export type ApplicationAuthorityEnvelopeInput = z.input<
  typeof ApplicationAuthorityEnvelopeSchema
>;

/**
 * Exact answer-snapshot binding for a future policy executor. A null policy
 * (the compatibility shape for prepare-only workspaces) authorizes no
 * elevated answer set, and any revision or digest drift fails closed.
 */
export function isApprovedApplicationAnswerSnapshot(
  envelope: Pick<ApplicationAuthorityEnvelope, "decisionPolicy">,
  answers: SubmissionAnswerSnapshotIdentity,
): boolean {
  const approved = envelope.decisionPolicy?.answerPolicy.approvedAnswerSnapshot;
  return (
    approved !== undefined &&
    approved.revision === answers.revision &&
    approved.digest === answers.digest
  );
}

/**
 * Deterministic use-site gate: anything that is not explicitly active and
 * unexpired at the caller's clock fails closed. Expired and revoked envelopes
 * remain representable as data so history stays auditable, but they authorize
 * nothing.
 */
export function isActiveApplicationAuthorityEnvelope(
  envelope: Pick<ApplicationAuthorityEnvelope, "status" | "expiresAt">,
  now: string,
): boolean {
  if (envelope.status !== "active") {
    return false;
  }
  const nowTime = Date.parse(now);
  if (!Number.isFinite(nowTime)) {
    return false;
  }
  return (
    envelope.expiresAt === null || Date.parse(envelope.expiresAt) > nowTime
  );
}

/**
 * Observation identity bound into a submission preflight. A fresh deterministic
 * recheck must reproduce this exact id + revision + digest before any external
 * action; any mismatch means the page changed under us and the action stops.
 */
export const SubmissionObservationIdentitySchema = z
  .object({
    id: NonEmptyStringSchema,
    revision: z.number().int().positive(),
    digest: Sha256HexSchema,
  })
  .strict();
export type SubmissionObservationIdentity = z.infer<
  typeof SubmissionObservationIdentitySchema
>;

/** Stable final-control reference plus a digest signature of its identity. */
export const SubmissionFinalControlIdentitySchema = z
  .object({
    signature: Sha256HexSchema,
    ref: NonEmptyStringSchema,
  })
  .strict();
export type SubmissionFinalControlIdentity = z.infer<
  typeof SubmissionFinalControlIdentitySchema
>;

/**
 * One submission preflight record (ADR 0013 step 6).
 *
 * Carries every fact needed for a fresh deterministic recheck immediately
 * before the single external action: exact application lineage, exact
 * authority envelope id + revision, observation id/revision/digest, resume
 * digest, answer revision/digest, final-control signature/ref, and remaining
 * capacity captured before the attempt.
 *
 * Deliberately contains no raw answers, DOM snapshots, credentials, or URLs
 * with secrets — only digests, revisions, and stable references.
 */
export const SubmissionPreflightRecordSchema = z
  .object({
    id: NonEmptyStringSchema,
    idempotencyKey: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    jobId: NonEmptyStringSchema,
    resultId: NonEmptyStringSchema,
    applicationRecordId: NonEmptyStringSchema,
    // Nullable defaults keep legacy prepare-only records readable. New
    // authority execution must stamp the exact campaign and canonical page
    // origin so repository transactions can verify scope and origin without
    // retaining raw URLs.
    campaignId: NonEmptyStringSchema.nullable().default(null),
    origin: ApplicationAuthorityCanonicalOriginSchema.nullable().default(null),
    authorityEnvelopeId: NonEmptyStringSchema,
    authorityRevision: z.number().int().positive(),
    decisionPolicy:
      ApplicationAuthorityDecisionPolicyIdentitySchema.nullable().default(null),
    formObservation: SubmissionObservationIdentitySchema,
    resumeSha256: Sha256HexSchema,
    answers: SubmissionAnswerSnapshotIdentitySchema,
    finalControl: SubmissionFinalControlIdentitySchema,
    remainingRunCapacityBefore: z.number().int().nonnegative(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type SubmissionPreflightRecord = z.infer<
  typeof SubmissionPreflightRecordSchema
>;
export type SubmissionPreflightRecordInput = z.input<
  typeof SubmissionPreflightRecordSchema
>;

/**
 * Exact policy identity check for repository/executor transactions. Legacy
 * prepare-only preflights with no decision policy remain representable, while
 * a policy-bearing envelope can never match a preflight missing or changing
 * its revision/digest.
 */
export function isSubmissionPreflightBoundToDecisionPolicy(
  preflight: Pick<SubmissionPreflightRecord, "decisionPolicy">,
  envelope: Pick<ApplicationAuthorityEnvelope, "decisionPolicy">,
): boolean {
  const identity = envelope.decisionPolicy;
  if (identity === null) {
    return preflight.decisionPolicy === null;
  }
  return (
    preflight.decisionPolicy?.version === identity.version &&
    preflight.decisionPolicy.revision === identity.revision &&
    preflight.decisionPolicy.digest === identity.digest
  );
}

export const submissionExecutionGrantStatusValues = [
  "active",
  "revoked",
  "consumed",
  "expired",
] as const;
export const SubmissionExecutionGrantStatusSchema = z.enum(
  submissionExecutionGrantStatusValues,
);
export type SubmissionExecutionGrantStatus = z.infer<
  typeof SubmissionExecutionGrantStatusSchema
>;

/**
 * The exact one-time user grant for a single final-submission action in
 * `confirm_before_submit` mode (ADR 0012).
 *
 * The mode-bearing authority envelope never authorizes the final action in
 * this mode. Only this separate durable grant does, and it binds exactly one
 * preflight id + idempotency key + run/job/result/application-record lineage +
 * authority envelope id/revision tuple. `grantedBy` is pinned to the literal
 * `user`, so model output can never mint or widen a grant.
 *
 * Fail-closed invariants (superRefine), enforced in both directions:
 * - active grants record neither revokedAt nor consumedAt
 * - revoked grants require revokedAt and forbid consumedAt
 * - consumed grants require consumedAt and forbid revokedAt
 * - every grant has a bounded expiresAt; expired grants carry neither marker
 * - expiresAt must be strictly after grantedAt; revoke/consume cannot
 *   precede the grant
 *
 * Revoked, consumed, and expired grants stay representable for audit but
 * authorize nothing; see `isActiveSubmissionExecutionGrant`.
 */
export const SubmissionExecutionGrantSchema = z
  .object({
    id: NonEmptyStringSchema,
    preflightId: NonEmptyStringSchema,
    idempotencyKey: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    jobId: NonEmptyStringSchema,
    resultId: NonEmptyStringSchema,
    applicationRecordId: NonEmptyStringSchema,
    authorityEnvelopeId: NonEmptyStringSchema,
    authorityRevision: z.number().int().positive(),
    // Pinned: this grant exists only for the confirm-before-submit flow. An
    // envelope in any other mode can never pair with it, and autonomous runs
    // proceed from an active envelope plus policy/preflight checks instead of
    // any grant.
    mode: z.literal("confirm_before_submit"),
    status: SubmissionExecutionGrantStatusSchema,
    grantedBy: z.literal("user"),
    grantedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    revokedAt: IsoDateTimeSchema.nullable(),
    consumedAt: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const grantedAtTime = Date.parse(value.grantedAt);

    if (Date.parse(value.expiresAt) <= grantedAtTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expiresAt must be strictly after grantedAt.",
        path: ["expiresAt"],
      });
    }
    if (
      value.revokedAt !== null &&
      Date.parse(value.revokedAt) < grantedAtTime
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "revokedAt cannot precede grantedAt.",
        path: ["revokedAt"],
      });
    }
    if (
      value.consumedAt !== null &&
      Date.parse(value.consumedAt) < grantedAtTime
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "consumedAt cannot precede grantedAt.",
        path: ["consumedAt"],
      });
    }

    switch (value.status) {
      case "active":
        if (value.revokedAt !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "An active grant cannot record revokedAt.",
            path: ["revokedAt"],
          });
        }
        if (value.consumedAt !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "An active grant cannot record consumedAt.",
            path: ["consumedAt"],
          });
        }
        break;
      case "revoked":
        if (value.revokedAt === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A revoked grant must record revokedAt.",
            path: ["revokedAt"],
          });
        }
        if (value.consumedAt !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A revoked grant cannot also be consumed.",
            path: ["consumedAt"],
          });
        }
        break;
      case "consumed":
        if (value.consumedAt === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A consumed grant must record consumedAt.",
            path: ["consumedAt"],
          });
        }
        if (value.revokedAt !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A consumed grant cannot also be revoked.",
            path: ["revokedAt"],
          });
        }
        break;
      case "expired":
        if (value.revokedAt !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "An expired grant cannot also be revoked.",
            path: ["revokedAt"],
          });
        }
        if (value.consumedAt !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "An expired grant cannot also be consumed.",
            path: ["consumedAt"],
          });
        }
        break;
    }
  });
export type SubmissionExecutionGrant = z.infer<
  typeof SubmissionExecutionGrantSchema
>;
export type SubmissionExecutionGrantInput = z.input<
  typeof SubmissionExecutionGrantSchema
>;

/**
 * Deterministic use-site gate for the single final-submission action of a
 * `confirm_before_submit` attempt: true only when the grant is explicitly
 * active, unexpired at the caller-provided clock, and bound to exactly the
 * preflight id, idempotency key, run/job/result/application-record lineage,
 * and authority envelope id/revision the executor is about to act on.
 *
 * The caller must supply its own clock (`now`) and the typed expected
 * preflight facts; a boolean flag or the envelope's mode can never stand in
 * for the grant. Invalid clocks fail closed. Anything false means no external
 * action happens.
 */
export function isActiveSubmissionExecutionGrant(
  grant: Pick<
    SubmissionExecutionGrant,
    | "status"
    | "expiresAt"
    | "preflightId"
    | "idempotencyKey"
    | "runId"
    | "jobId"
    | "resultId"
    | "applicationRecordId"
    | "authorityEnvelopeId"
    | "authorityRevision"
  >,
  now: string,
  expectedPreflight: Pick<
    SubmissionPreflightRecord,
    | "id"
    | "idempotencyKey"
    | "runId"
    | "jobId"
    | "resultId"
    | "applicationRecordId"
    | "authorityEnvelopeId"
    | "authorityRevision"
  >,
): boolean {
  if (grant.status !== "active") {
    return false;
  }
  const nowTime = Date.parse(now);
  if (!Number.isFinite(nowTime)) {
    return false;
  }
  const expiresAtTime = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAtTime) || expiresAtTime <= nowTime) {
    return false;
  }
  return (
    grant.preflightId === expectedPreflight.id &&
    grant.idempotencyKey === expectedPreflight.idempotencyKey &&
    grant.runId === expectedPreflight.runId &&
    grant.jobId === expectedPreflight.jobId &&
    grant.resultId === expectedPreflight.resultId &&
    grant.applicationRecordId === expectedPreflight.applicationRecordId &&
    grant.authorityEnvelopeId === expectedPreflight.authorityEnvelopeId &&
    grant.authorityRevision === expectedPreflight.authorityRevision
  );
}

/**
 * Tri-state terminal outcome of one final-submission attempt (ADR 0013).
 *
 * Only fresh external evidence proves `submitted`; internal clicks and intents
 * are structurally unrepresentable here because every evidence entry is an
 * externally observed employer-site state, confirmation artifact, or operator
 * confirmation. `outcome_uncertain` permanently blocks automatic retry for the
 * bound idempotency key; resolution happens through a human and, when proven,
 * through a new outcome record sharing the same key.
 */
export const submissionOutcomeValues = [
  "submitted",
  "not_submitted",
  "outcome_uncertain",
] as const;
export const SubmissionOutcomeValueSchema = z.enum(submissionOutcomeValues);
export type SubmissionOutcomeValue = z.infer<
  typeof SubmissionOutcomeValueSchema
>;

/**
 * Durable lifecycle for one final-submission idempotency key.
 *
 * `armed` is the crash-recovery boundary: it is written immediately before
 * the executor gets permission to perform the one external action. An armed
 * record without a matching outcome is therefore never retryable; recovery
 * converts it to `outcome_uncertain`. The record is deliberately separate
 * from the outcome so an outcome can only be committed after the armed
 * transition has been durably observed.
 */
export const submissionIdempotencyStatusValues = [
  "available",
  "armed",
  "resolved",
  "outcome_uncertain",
  "revoked",
] as const;
export const SubmissionIdempotencyStatusSchema = z.enum(
  submissionIdempotencyStatusValues,
);
export type SubmissionIdempotencyStatus = z.infer<
  typeof SubmissionIdempotencyStatusSchema
>;

export const SubmissionIdempotencyRecordSchema = z
  .object({
    id: NonEmptyStringSchema,
    idempotencyKey: NonEmptyStringSchema,
    preflightId: NonEmptyStringSchema,
    authorityEnvelopeId: NonEmptyStringSchema,
    authorityRevision: z.number().int().positive(),
    runId: NonEmptyStringSchema,
    jobId: NonEmptyStringSchema,
    resultId: NonEmptyStringSchema,
    applicationRecordId: NonEmptyStringSchema,
    status: SubmissionIdempotencyStatusSchema,
    revision: z.number().int().positive(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    armedAt: IsoDateTimeSchema.nullable(),
    outcomeId: NonEmptyStringSchema.nullable(),
    outcome: SubmissionOutcomeValueSchema.nullable(),
    revokedAt: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const createdAt = Date.parse(value.createdAt);
    const updatedAt = Date.parse(value.updatedAt);
    if (updatedAt < createdAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "updatedAt cannot precede createdAt.",
        path: ["updatedAt"],
      });
    }
    if (value.armedAt !== null && Date.parse(value.armedAt) < createdAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "armedAt cannot precede createdAt.",
        path: ["armedAt"],
      });
    }
    if (value.revokedAt !== null && Date.parse(value.revokedAt) < createdAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "revokedAt cannot precede createdAt.",
        path: ["revokedAt"],
      });
    }

    switch (value.status) {
      case "available":
        if (
          value.armedAt !== null ||
          value.outcomeId !== null ||
          value.outcome !== null ||
          value.revokedAt !== null
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "An available idempotency record cannot carry lifecycle markers.",
            path: ["status"],
          });
        }
        break;
      case "armed":
        if (value.armedAt === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "An armed idempotency record must record armedAt.",
            path: ["armedAt"],
          });
        }
        if (
          value.outcomeId !== null ||
          value.outcome !== null ||
          value.revokedAt !== null
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "An armed idempotency record cannot carry an outcome or revocation.",
            path: ["status"],
          });
        }
        break;
      case "resolved":
        if (value.armedAt === null || value.outcomeId === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "A resolved idempotency record must bind its armed and outcome records.",
            path: ["status"],
          });
        }
        if (
          value.outcome !== "submitted" &&
          value.outcome !== "not_submitted"
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "A resolved idempotency record must carry a terminal outcome.",
            path: ["outcome"],
          });
        }
        if (value.revokedAt !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A resolved idempotency record cannot be revoked.",
            path: ["revokedAt"],
          });
        }
        break;
      case "outcome_uncertain":
        if (value.armedAt === null || value.outcomeId === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "An uncertain idempotency record must bind its armed and outcome records.",
            path: ["status"],
          });
        }
        if (value.outcome !== "outcome_uncertain") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "An uncertain idempotency record must carry outcome_uncertain.",
            path: ["outcome"],
          });
        }
        if (value.revokedAt !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "An uncertain idempotency record cannot be revoked.",
            path: ["revokedAt"],
          });
        }
        break;
      case "revoked":
        if (value.revokedAt === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A revoked idempotency record must record revokedAt.",
            path: ["revokedAt"],
          });
        }
        if (
          value.armedAt !== null ||
          value.outcomeId !== null ||
          value.outcome !== null
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "A revoked idempotency record cannot carry an armed or outcome marker.",
            path: ["status"],
          });
        }
        break;
    }
  });
export type SubmissionIdempotencyRecord = z.infer<
  typeof SubmissionIdempotencyRecordSchema
>;
export type SubmissionIdempotencyRecordInput = z.input<
  typeof SubmissionIdempotencyRecordSchema
>;

/**
 * The separate durable one-shot marker written alongside an `armed`
 * idempotency transition. It contains only lineage and authority bindings;
 * no page data, credentials, or raw answers are persisted.
 */
export const SubmissionArmedMarkerSchema = z
  .object({
    id: NonEmptyStringSchema,
    idempotencyKey: NonEmptyStringSchema,
    preflightId: NonEmptyStringSchema,
    authorityEnvelopeId: NonEmptyStringSchema,
    authorityRevision: z.number().int().positive(),
    runId: NonEmptyStringSchema,
    jobId: NonEmptyStringSchema,
    resultId: NonEmptyStringSchema,
    applicationRecordId: NonEmptyStringSchema,
    armedAt: IsoDateTimeSchema,
  })
  .strict();
export type SubmissionArmedMarker = z.infer<typeof SubmissionArmedMarkerSchema>;
export type SubmissionArmedMarkerInput = z.input<
  typeof SubmissionArmedMarkerSchema
>;

export const submissionOutcomeEvidenceKindValues = [
  "employer_site_state",
  "confirmation_artifact",
  "operator_confirmation",
] as const;
export const SubmissionOutcomeEvidenceKindSchema = z.enum(
  submissionOutcomeEvidenceKindValues,
);
export type SubmissionOutcomeEvidenceKind = z.infer<
  typeof SubmissionOutcomeEvidenceKindSchema
>;

export const submissionOutcomeMaxEvidenceEntries = 50;

export const SubmissionEvidenceDestinationSchema = z
  .object({
    origin: ApplicationAuthorityOriginSchema,
    safePath: AuthoritySafePathSchema,
  })
  .strict();
export type SubmissionEvidenceDestination = z.infer<
  typeof SubmissionEvidenceDestinationSchema
>;

export const SubmissionOutcomeEvidenceEntrySchema = z
  .object({
    id: NonEmptyStringSchema,
    kind: SubmissionOutcomeEvidenceKindSchema,
    observedAt: IsoDateTimeSchema,
    destination: SubmissionEvidenceDestinationSchema,
    artifactRefId: NonEmptyStringSchema.nullable(),
    summary: NonEmptyStringSchema.max(500),
  })
  .strict();
export type SubmissionOutcomeEvidenceEntry = z.infer<
  typeof SubmissionOutcomeEvidenceEntrySchema
>;

export const submissionRetryBlockReasonValues = [
  "submission_confirmed",
  "outcome_uncertain",
  "authority_no_longer_valid",
  "policy_decision",
] as const;
export const SubmissionRetryBlockReasonSchema = z.enum(
  submissionRetryBlockReasonValues,
);
export type SubmissionRetryBlockReason = z.infer<
  typeof SubmissionRetryBlockReasonSchema
>;

export const SubmissionOutcomeRetryEligibilitySchema = z
  .object({
    eligible: z.boolean(),
    blockReason: SubmissionRetryBlockReasonSchema.nullable(),
  })
  .strict();
export type SubmissionOutcomeRetryEligibility = z.infer<
  typeof SubmissionOutcomeRetryEligibilitySchema
>;

/** Browser execution diagnostics are not employer confirmation evidence. */
export const SubmissionBrowserActionDiagnosticsSchema = z
  .object({
    reason: NonEmptyStringSchema.max(80),
    detail: NonEmptyStringSchema.max(500).optional(),
    actionAttempted: z.boolean().optional(),
    actionIssued: z.boolean().optional(),
    actionCompleted: z.boolean().optional(),
    requestsObservedDuringAction: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SubmissionBrowserActionDiagnostics = z.infer<
  typeof SubmissionBrowserActionDiagnosticsSchema
>;

/**
 * Refinement matrix enforced here and relied upon by receipts/packets:
 * - `submitted`: retry permanently blocked as `submission_confirmed`,
 *   verifiedAt required, at least one external evidence entry required
 * - `outcome_uncertain`: retry permanently blocked as `outcome_uncertain`,
 *   verifiedAt forbidden (nothing was proven)
 * - `not_submitted`: retry is allowed only through an explicit
 *   `{ eligible: true, blockReason: null }`; blocking requires an explicit
 *   reason
 */
export const SubmissionOutcomeRecordSchema = z
  .object({
    id: NonEmptyStringSchema,
    preflightId: NonEmptyStringSchema,
    idempotencyKey: NonEmptyStringSchema,
    authorityEnvelopeId: NonEmptyStringSchema,
    authorityRevision: z.number().int().positive(),
    runId: NonEmptyStringSchema,
    jobId: NonEmptyStringSchema,
    resultId: NonEmptyStringSchema,
    applicationRecordId: NonEmptyStringSchema,
    outcome: SubmissionOutcomeValueSchema,
    attemptedAt: IsoDateTimeSchema,
    verifiedAt: IsoDateTimeSchema.nullable(),
    evidence: z
      .array(SubmissionOutcomeEvidenceEntrySchema)
      .max(submissionOutcomeMaxEvidenceEntries),
    retry: SubmissionOutcomeRetryEligibilitySchema,
    browserAction: SubmissionBrowserActionDiagnosticsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const attemptedAt = Date.parse(value.attemptedAt);
    if (
      value.verifiedAt !== null &&
      Date.parse(value.verifiedAt) < attemptedAt
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "verifiedAt cannot precede attemptedAt.",
        path: ["verifiedAt"],
      });
    }
    value.evidence.forEach((entry, index) => {
      if (Date.parse(entry.observedAt) < attemptedAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Submission outcome evidence cannot predate the attempt.",
          path: ["evidence", index, "observedAt"],
        });
      }
    });

    if (value.outcome === "submitted") {
      if (
        value.retry.eligible !== false ||
        value.retry.blockReason !== "submission_confirmed"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "A confirmed submission is never retryable; retry must be blocked as submission_confirmed.",
          path: ["retry"],
        });
      }
      if (value.verifiedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Only externally verified submissions may be marked submitted; verifiedAt is required.",
          path: ["verifiedAt"],
        });
      }
      if (value.evidence.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "A submitted outcome requires at least one externally observed evidence entry.",
          path: ["evidence"],
        });
      }
    }

    if (value.outcome === "outcome_uncertain") {
      if (
        value.retry.eligible !== false ||
        value.retry.blockReason !== "outcome_uncertain"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Outcome uncertainty permanently blocks automatic retry for this idempotency key.",
          path: ["retry"],
        });
      }
      if (value.verifiedAt !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "An uncertain outcome proved nothing, so verifiedAt must stay null.",
          path: ["verifiedAt"],
        });
      }
    }

    if (value.outcome === "not_submitted") {
      if (value.retry.eligible && value.retry.blockReason !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "An eligible retry must not declare a block reason; blocking must be explicit instead.",
          path: ["retry", "blockReason"],
        });
      }
      if (!value.retry.eligible && value.retry.blockReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Blocking a not_submitted retry requires an explicit block reason.",
          path: ["retry", "blockReason"],
        });
      }
    }
  });
export type SubmissionOutcomeRecord = z.infer<
  typeof SubmissionOutcomeRecordSchema
>;
export type SubmissionOutcomeRecordInput = z.input<
  typeof SubmissionOutcomeRecordSchema
>;

/**
 * Explicit operator transition for a previously uncertain outcome.
 *
 * This is intentionally separate from the executor-facing outcome commit:
 * only a human-supplied, externally observed resolution may move an
 * `outcome_uncertain` idempotency key to a terminal outcome. The original
 * uncertainty record remains in the durable history and the replacement
 * outcome must use a fresh identity while retaining the same key/lineage.
 */
export const SubmissionOutcomeResolutionInputSchema = z
  .object({
    expectedOutcomeId: NonEmptyStringSchema,
    expectedIdempotencyRevision: z.number().int().positive(),
    outcome: SubmissionOutcomeRecordSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.outcome.id === value.expectedOutcomeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "An operator resolution must append a new outcome record identity.",
        path: ["outcome", "id"],
      });
    }
    if (value.outcome.outcome === "outcome_uncertain") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "An operator resolution must establish submitted or not_submitted.",
        path: ["outcome", "outcome"],
      });
    }
    if (value.outcome.verifiedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An operator resolution requires a verification timestamp.",
        path: ["outcome", "verifiedAt"],
      });
    }
    if (value.outcome.evidence.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An operator resolution requires external evidence.",
        path: ["outcome", "evidence"],
      });
    }
    if (value.outcome.outcome === "not_submitted") {
      if (value.outcome.retry.eligible) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "An operator not_submitted resolution must not enable automatic retry.",
          path: ["outcome", "retry", "eligible"],
        });
      }
      if (value.outcome.retry.blockReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "A not_submitted operator resolution requires an explicit retry block reason.",
          path: ["outcome", "retry", "blockReason"],
        });
      }
    }
  });
export type SubmissionOutcomeResolutionInput = z.infer<
  typeof SubmissionOutcomeResolutionInputSchema
>;
