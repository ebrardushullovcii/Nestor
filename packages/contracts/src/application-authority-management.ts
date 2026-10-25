import { z } from "zod";

import {
  ApplicationAttestationKindSchema,
  ApplicationAutomationModeSchema,
  ApplicationSalaryDisclosureRuleSchema,
  ApplicationAuthorityEnvelopeSchema,
  ApplicationAuthorityOriginSchema,
  ApplicationAuthorityScopeSchema,
  ApplicationAuthorityStatusSchema,
  SubmissionIdempotencyRecordSchema,
  SubmissionOutcomeRecordSchema,
  applicationAuthorityMaxOrigins,
  applicationAuthorityMaxResumeDigests,
  Sha256HexSchema,
} from "./application-authority";
import { IsoDateTimeSchema, NonEmptyStringSchema } from "./base";

/**
 * The user-editable portion of an authority envelope.
 *
 * Lifecycle fields (id, revision, status, createdAt, and revokedAt) are
 * intentionally absent. Main-process code owns those fields so a renderer
 * cannot mint a historical revision, reactivate a revoked envelope, forge a
 * revocation timestamp, or supply a supposedly authoritative policy digest.
 * Elevated modes remain rejected by main until main owns policy
 * canonicalization, revisioning, and digest generation.
 */
const ApplicationAuthorityEnvelopePolicyInputObjectSchema = z
  .object({
    // The IPC input defaults only to the already-safe mode. Elevated modes are
    // rejected by the desktop management service until their answer-policy
    // and stop-condition contracts are complete.
    mode: ApplicationAutomationModeSchema.default("prepare_only"),
    scope: ApplicationAuthorityScopeSchema,
    maxApplicationsPerRun: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    maxApplicationsPerLocalDay: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER),
    intermediateMutationsAuthorized: z.boolean(),
    /**
     * The declarations the person approved in advance, by exact kind. Empty by
     * default, which means every declaration on a form pauses for them.
     */
    preApprovedAttestationKinds: z
      .array(ApplicationAttestationKindSchema)
      .max(6)
      .default([]),
    /** What to do when a form asks what pay they expect. */
    salaryDisclosure: ApplicationSalaryDisclosureRuleSchema.default(
      "pause_for_user",
    ),
    allowedResumeSha256: z
      .array(Sha256HexSchema)
      .max(applicationAuthorityMaxResumeDigests),
    allowedOrigins: z
      .array(ApplicationAuthorityOriginSchema)
      .min(1)
      .max(applicationAuthorityMaxOrigins),
    expiresAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

function addIntermediateMutationInputIssues(
  value: z.infer<typeof ApplicationAuthorityEnvelopePolicyInputObjectSchema>,
  ctx: z.RefinementCtx,
): void {
  if (!value.intermediateMutationsAuthorized) {
    return;
  }
  if (value.expiresAt === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Bounded ATS autosave requires an explicit expiry.",
      path: ["expiresAt"],
    });
  }
  if (
    (value.scope.campaignId === null && value.scope.jobIds.length === 0) ||
    (value.scope.campaignId !== null && value.scope.jobIds.length > 0)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Bounded ATS autosave requires either an explicit campaign or explicit jobs.",
      path: ["scope"],
    });
  }
  if (value.allowedResumeSha256.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Bounded ATS autosave requires at least one resume SHA-256 digest.",
      path: ["allowedResumeSha256"],
    });
  }
}

export const ApplicationAuthorityEnvelopePolicyInputSchema =
  ApplicationAuthorityEnvelopePolicyInputObjectSchema.superRefine(
    addIntermediateMutationInputIssues,
  );
export type ApplicationAuthorityEnvelopePolicyInput = z.infer<
  typeof ApplicationAuthorityEnvelopePolicyInputSchema
>;

/** Input for creating a new active envelope. Main stamps id/revision/time. */
export const CreateApplicationAuthorityEnvelopeInputSchema =
  ApplicationAuthorityEnvelopePolicyInputSchema;
export type CreateApplicationAuthorityEnvelopeInput = z.input<
  typeof CreateApplicationAuthorityEnvelopeInputSchema
>;

/** Input for a revision-guarded replacement of an active envelope. */
export const UpdateApplicationAuthorityEnvelopeInputSchema = z
  .object({
    id: NonEmptyStringSchema,
    expectedRevision: z.number().int().positive(),
    ...ApplicationAuthorityEnvelopePolicyInputObjectSchema.shape,
  })
  .strict()
  .superRefine(addIntermediateMutationInputIssues);
export type UpdateApplicationAuthorityEnvelopeInput = z.input<
  typeof UpdateApplicationAuthorityEnvelopeInputSchema
>;

/** Input for a revision-guarded terminal revocation. Main stamps revokedAt. */
export const RevokeApplicationAuthorityEnvelopeInputSchema = z
  .object({
    id: NonEmptyStringSchema,
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export type RevokeApplicationAuthorityEnvelopeInput = z.infer<
  typeof RevokeApplicationAuthorityEnvelopeInputSchema
>;

/** Exact id input used by the get endpoint. */
export const GetApplicationAuthorityEnvelopeInputSchema = z
  .object({ id: NonEmptyStringSchema })
  .strict();
export type GetApplicationAuthorityEnvelopeInput = z.infer<
  typeof GetApplicationAuthorityEnvelopeInputSchema
>;

/** Bounded, exact filters for the inspectable authority list. */
export const ListApplicationAuthorityEnvelopesInputSchema = z
  .object({
    id: NonEmptyStringSchema.optional(),
    status: ApplicationAuthorityStatusSchema.optional(),
  })
  .strict();
export type ListApplicationAuthorityEnvelopesInput = z.infer<
  typeof ListApplicationAuthorityEnvelopesInputSchema
>;

export const ApplicationAuthorityEnvelopeMutationResultSchema =
  z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("applied"),
        envelope: ApplicationAuthorityEnvelopeSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("stale"),
        current: ApplicationAuthorityEnvelopeSchema.nullable(),
      })
      .strict(),
    z
      .object({
        status: z.literal("missing"),
        current: z.null(),
      })
      .strict(),
  ]);
export type ApplicationAuthorityEnvelopeMutationResult = z.infer<
  typeof ApplicationAuthorityEnvelopeMutationResultSchema
>;

export const ListApplicationAuthorityEnvelopesResultSchema = z.array(
  ApplicationAuthorityEnvelopeSchema,
);
export type ListApplicationAuthorityEnvelopesResult = z.infer<
  typeof ListApplicationAuthorityEnvelopesResultSchema
>;

export const GetApplicationAuthorityEnvelopeResultSchema =
  ApplicationAuthorityEnvelopeSchema.nullable();
export type GetApplicationAuthorityEnvelopeResult = z.infer<
  typeof GetApplicationAuthorityEnvelopeResultSchema
>;

/**
 * Renderer-safe command for recording what the user independently verified
 * on the employer site. Main owns every lineage, timestamp, evidence, and
 * retry-policy field; the renderer can only choose the observed terminal fact.
 */
export const ResolveSubmissionOutcomeInputSchema = z
  .object({
    uncertainOutcomeId: NonEmptyStringSchema,
    resolution: z.enum(["submitted", "not_submitted"]),
    confirmedOnEmployerSite: z.literal(true),
  })
  .strict();
export type ResolveSubmissionOutcomeInput = z.infer<
  typeof ResolveSubmissionOutcomeInputSchema
>;

export const ResolveSubmissionOutcomeResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.enum(["recorded", "duplicate"]),
        outcome: SubmissionOutcomeRecordSchema,
        idempotency: SubmissionIdempotencyRecordSchema,
      })
      .strict(),
    z
      .object({
        status: z.enum(["stale", "blocked"]),
        outcome: SubmissionOutcomeRecordSchema.nullable(),
        idempotency: SubmissionIdempotencyRecordSchema.nullable(),
      })
      .strict(),
    z
      .object({
        status: z.literal("missing"),
        outcome: z.null(),
        idempotency: z.null(),
      })
      .strict(),
  ],
);
export type ResolveSubmissionOutcomeResult = z.infer<
  typeof ResolveSubmissionOutcomeResultSchema
>;
