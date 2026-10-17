import type { z } from "zod";
import type {
  ProfileCompensationPreferencePatchFieldsSchema,
  ProfileCopilotPatchGroup,
  ProfileIdentityPatchFieldsSchema,
  ProfileNarrativePatchFieldsSchema,
  ProfileAnswerBankPatchFieldsSchema,
  ProfileApplicationIdentityPatchFieldsSchema,
  ProfileCoreListPatchFieldsSchema,
  ProfileProfessionalSummaryPatchFieldsSchema,
  ProfileSearchPreferencesPatchFieldsSchema,
  ProfileSkillGroupsPatchFieldsSchema,
  ProfileWorkEligibilityPatchFieldsSchema,
} from "@nestor/contracts";

import type { ReviseCandidateProfileInput } from "../shared";
import { contentFieldDescriptors } from "./profile-copilot-field-updates-content";
import { preferenceFieldDescriptors } from "./profile-copilot-field-updates-preferences";
import { profileFieldDescriptors } from "./profile-copilot-field-updates-profile";
import {
  buildGenericExplicitFieldPatchGroupsFromDescriptors,
  type PatchOperationName,
} from "./profile-copilot-field-updates-shared";

export const fieldDescriptors = [
  ...profileFieldDescriptors,
  ...contentFieldDescriptors,
  ...preferenceFieldDescriptors,
];

/**
 * Replacement fields that are intentionally NOT generic-descriptor owned.
 * Each group names the deterministic specialist that owns the phrasing so new
 * contract fields cannot silently lack an owner (see the coverage assertions
 * below and `getReplacementFieldOwnershipSnapshot`).
 */
export type ReplacementFieldOwner = "descriptor" | "specialist" | "model";

export interface ReplacementFieldOwnershipEntry {
  readonly field: string;
  readonly operation:
    | PatchOperationName
    | "replace_compensation_preferences_fields";
  readonly owner: ReplacementFieldOwner;
  readonly ownerDetail: string | null;
}

type SpecialistOwnershipGroup = {
  readonly fields: readonly string[];
  readonly sourceModule: string;
};

export const specialistOwnedReplacementFields = {
  replace_identity_fields: {
    sourceModule: "url patches and specialized patches",
    fields: [
      "yearsExperience",
      "githubUrl",
      "linkedinUrl",
      "portfolioUrl",
      "personalWebsiteUrl",
    ],
  },
  replace_work_eligibility_fields: {
    sourceModule: "specialized work-eligibility patches",
    fields: ["requiresVisaSponsorship", "remoteEligible"],
  },
  replace_profile_list_fields: {
    sourceModule:
      "import/setup flows; chat redirects location and role lists to search preferences",
    fields: ["targetRoles", "locations"],
  },
  replace_search_preferences_fields: {
    sourceModule: "job-source, salary, target-role, and work-mode specialists",
    fields: [
      "discovery",
      "minimumSalaryUsd",
      "targetRoles",
      "targetSalaryUsd",
      "workModes",
    ],
  },
  replace_compensation_preferences_fields: {
    sourceModule: "unified typed salary command parser",
    fields: ["minimum", "maximum", "interval", "currency", "currencyStatus"],
  },
} as const satisfies Partial<
  Record<
    PatchOperationName | "replace_compensation_preferences_fields",
    SpecialistOwnershipGroup
  >
>;

// Structured limits and pay intent are model-owned. The deterministic
// fallback must not guess them from wording or add keyword rules.
const modelOwnedPreferenceFields = {
  replace_work_eligibility_fields: ["limitedWorkPermissions"],
  replace_search_preferences_fields: [
    "shiftPreference",
    "weeklyHours",
    "searchSelectivity",
  ],
  replace_compensation_preferences_fields: ["basis"],
} as const;

export function getReplacementFieldOwnershipSnapshot(): ReplacementFieldOwnershipEntry[] {
  const descriptorEntries: ReplacementFieldOwnershipEntry[] =
    fieldDescriptors.map((descriptor) => ({
      field: descriptor.key,
      operation: descriptor.operation,
      owner: "descriptor",
      ownerDetail: null,
    }));
  const specialistEntries: ReplacementFieldOwnershipEntry[] = Object.entries(
    specialistOwnedReplacementFields,
  ).flatMap(([operation, ownership]) =>
    ownership.fields.map((field) => ({
      field,
      operation: operation as ReplacementFieldOwnershipEntry["operation"],
      owner: "specialist",
      ownerDetail: ownership.sourceModule,
    })),
  );

  const modelEntries: ReplacementFieldOwnershipEntry[] = Object.entries(
    modelOwnedPreferenceFields,
  ).flatMap(([operation, fields]) =>
    fields.map((field) => ({
      field,
      operation: operation as ReplacementFieldOwnershipEntry["operation"],
      owner: "model",
      ownerDetail:
        "structured preference facts; no deterministic language parser",
    })),
  );
  return [...descriptorEntries, ...specialistEntries, ...modelEntries];
}

export function buildGenericExplicitFieldPatchGroups(
  input: ReviseCandidateProfileInput,
): ProfileCopilotPatchGroup[] {
  return buildGenericExplicitFieldPatchGroupsFromDescriptors(
    input,
    fieldDescriptors,
  );
}

/*
 * Compile-time exhaustiveness checks. Every replacement field in the patch
 * contract must be covered by either a generic descriptor or a documented
 * specialist owner, and neither catalog may contain stale keys.
 */
type ContractFieldKeys<Schema extends z.ZodTypeAny> = keyof z.infer<Schema> &
  string;

type DescriptorReplacementKey =
  | (typeof profileFieldDescriptors)[number]["key"]
  | (typeof contentFieldDescriptors)[number]["key"]
  | (typeof preferenceFieldDescriptors)[number]["key"];

type SpecialistReplacementKey =
  (typeof specialistOwnedReplacementFields)[keyof typeof specialistOwnedReplacementFields]["fields"][number];

type ModelOwnedPreferenceKey =
  (typeof modelOwnedPreferenceFields)[keyof typeof modelOwnedPreferenceFields][number];

type ContractReplacementKey =
  | ContractFieldKeys<typeof ProfileIdentityPatchFieldsSchema>
  | ContractFieldKeys<typeof ProfileWorkEligibilityPatchFieldsSchema>
  | ContractFieldKeys<typeof ProfileProfessionalSummaryPatchFieldsSchema>
  | ContractFieldKeys<typeof ProfileNarrativePatchFieldsSchema>
  | ContractFieldKeys<typeof ProfileAnswerBankPatchFieldsSchema>
  | ContractFieldKeys<typeof ProfileApplicationIdentityPatchFieldsSchema>
  | ContractFieldKeys<typeof ProfileSkillGroupsPatchFieldsSchema>
  | ContractFieldKeys<typeof ProfileCoreListPatchFieldsSchema>
  | ContractFieldKeys<typeof ProfileSearchPreferencesPatchFieldsSchema>
  | ContractFieldKeys<typeof ProfileCompensationPreferencePatchFieldsSchema>;

// Each alias resolves to `true` when coverage is exhaustive; otherwise the
// uncovered or stale field names fail the typecheck right here.
type ExhaustiveCoverageCheck<FieldUnion> = [FieldUnion] extends [never]
  ? true
  : FieldUnion;
const everyReplacementFieldHasAnOwner: ExhaustiveCoverageCheck<
  Exclude<
    ContractReplacementKey,
    | DescriptorReplacementKey
    | SpecialistReplacementKey
    | ModelOwnedPreferenceKey
  >
> = true;
const noStaleDescriptorKeys: ExhaustiveCoverageCheck<
  Exclude<DescriptorReplacementKey, ContractReplacementKey>
> = true;
const noStaleSpecialistKeys: ExhaustiveCoverageCheck<
  Exclude<SpecialistReplacementKey, ContractReplacementKey>
> = true;

void everyReplacementFieldHasAnOwner;
void noStaleDescriptorKeys;
void noStaleSpecialistKeys;
