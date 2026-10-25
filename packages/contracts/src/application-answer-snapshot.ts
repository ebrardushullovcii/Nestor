import { z } from "zod";

import { IsoDateTimeSchema, NonEmptyStringSchema } from "./base";
import { Sha256HexSchema } from "./application-authority";
import {
  CandidateAnswerKindSchema,
  type CandidateReusableAnswer,
  type CandidateAnswerKind,
} from "./profile";

export const approvedApplicationAnswerSnapshotVersion = 1 as const;
export const approvedApplicationAnswerSnapshotMaxEntries = 200;

/**
 * One immutable, user-reviewed reusable answer. Main derives these entries from
 * the Needs-you saved-answer store; renderer input can never supply answer text
 * or identity metadata to the approval boundary.
 */
export const ApprovedApplicationAnswerSnapshotEntrySchema = z
  .object({
    id: NonEmptyStringSchema.max(240),
    kind: CandidateAnswerKindSchema,
    label: NonEmptyStringSchema.max(240),
    question: NonEmptyStringSchema.max(1_000),
    answer: NonEmptyStringSchema.max(20_000),
    roleFamilies: z.array(NonEmptyStringSchema.max(240)).max(100),
    proofEntryIds: z.array(NonEmptyStringSchema.max(240)).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [field, values] of [
      ["roleFamilies", value.roleFamilies],
      ["proofEntryIds", value.proofEntryIds],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} must not contain duplicates.`,
          path: [field],
        });
      }
    }
  });
export type ApprovedApplicationAnswerSnapshotEntry = z.infer<
  typeof ApprovedApplicationAnswerSnapshotEntrySchema
>;

const approvedApplicationAnswerSnapshotContentShape = {
  schemaVersion: z.literal(approvedApplicationAnswerSnapshotVersion),
  profileId: NonEmptyStringSchema,
  // A profile with no saved answers yet is still a profile the person can
  // approve: an empty snapshot says "nothing on file", which lets sending
  // start and hand any eligibility question back at the form.
  entries: z
    .array(ApprovedApplicationAnswerSnapshotEntrySchema)
    .max(approvedApplicationAnswerSnapshotMaxEntries),
} as const;

function requireUniqueAnswerEntryIds(
  value: { entries: readonly ApprovedApplicationAnswerSnapshotEntry[] },
  context: z.RefinementCtx,
): void {
  const ids = value.entries.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Approved answer entry ids must be unique.",
      path: ["entries"],
    });
  }
}

export const ApprovedApplicationAnswerSnapshotContentSchema = z
  .object(approvedApplicationAnswerSnapshotContentShape)
  .strict()
  .superRefine(requireUniqueAnswerEntryIds);
export type ApprovedApplicationAnswerSnapshotContent = z.infer<
  typeof ApprovedApplicationAnswerSnapshotContentSchema
>;

export const requiredApprovedApplicationAnswerKinds = [
  "work_authorization",
  "visa_sponsorship",
] as const satisfies readonly CandidateAnswerKind[];

/**
 * Canonical reusable-answer projection shared by trusted main management and
 * the Job Finder execution recheck. Keeping the projection here prevents the
 * saved policy and its last-instant use gate from hashing different content.
 */
export function deriveApprovedApplicationAnswerSnapshotContent(
  profile: { id: string },
  savedAnswers: readonly CandidateReusableAnswer[] = [],
): {
  content: ApprovedApplicationAnswerSnapshotContent | null;
  entries: ApprovedApplicationAnswerSnapshotEntry[];
  kinds: CandidateAnswerKind[];
  missingRequiredKinds: CandidateAnswerKind[];
} {
  const entries: ApprovedApplicationAnswerSnapshotEntry[] = [];
  for (const custom of savedAnswers) {
    const answer = custom.answer.trim();
    const question = custom.question.trim();
    if (custom.needsConfirmation || !answer || !question) {
      continue;
    }
    entries.push({
      id: custom.id,
      kind: custom.kind,
      label: custom.label.trim() || question,
      question,
      answer,
      roleFamilies: [
        ...new Set(custom.roleFamilies.map((value) => value.trim())),
      ]
        .filter(Boolean)
        .sort(),
      proofEntryIds: [
        ...new Set(custom.proofEntryIds.map((value) => value.trim())),
      ]
        .filter(Boolean)
        .sort(),
    });
  }

  const content = ApprovedApplicationAnswerSnapshotContentSchema.parse({
    schemaVersion: approvedApplicationAnswerSnapshotVersion,
    profileId: profile.id,
    entries,
  });
  const kinds = [...new Set(entries.map((entry) => entry.kind))];
  return {
    content,
    entries,
    kinds,
    missingRequiredKinds: requiredApprovedApplicationAnswerKinds.filter(
      (kind) => !kinds.includes(kind),
    ),
  };
}

export const ApprovedApplicationAnswerSnapshotSchema = z
  .object({
    ...approvedApplicationAnswerSnapshotContentShape,
    id: NonEmptyStringSchema,
    revision: z.number().int().positive(),
    digest: Sha256HexSchema,
    sourceProfileRevision: z.number().int().positive(),
    approvedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine(requireUniqueAnswerEntryIds);
export type ApprovedApplicationAnswerSnapshot = z.infer<
  typeof ApprovedApplicationAnswerSnapshotSchema
>;

/**
 * Canonical UTF-8 payload for trusted SHA-256 generation. Lifecycle identity
 * is excluded so unrelated profile writes do not invalidate unchanged answer
 * content. Entry and nested-reference order are normalized deterministically.
 */
export function serializeApprovedApplicationAnswerSnapshotForDigest(
  content: ApprovedApplicationAnswerSnapshotContent,
): string {
  const parsed = ApprovedApplicationAnswerSnapshotContentSchema.parse(content);
  return JSON.stringify({
    schemaVersion: parsed.schemaVersion,
    profileId: parsed.profileId,
    entries: parsed.entries
      .map((entry) => ({
        ...entry,
        roleFamilies: [...entry.roleFamilies].sort(),
        proofEntryIds: [...entry.proofEntryIds].sort(),
      }))
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      ),
  });
}
