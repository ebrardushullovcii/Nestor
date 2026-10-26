import { z } from "zod";

import {
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  ResumeApplicationModeSchema,
  TailoringModeSchema,
} from "./base";
import {
  AgentTaskExecutionReceiptSchema,
  AgentTaskMessageAttributionSchema,
} from "./agent-task";
import {
  CandidateAnswerBankSchema,
  CandidateApplicationIdentitySchema,
  CandidateCertificationSchema,
  CandidateEducationSchema,
  CandidateExperienceSchema,
  CandidateLanguageSchema,
  CandidateLinkSchema,
  CandidateProfessionalSummarySchema,
  CandidateProjectSchema,
  CandidateProofBankEntrySchema,
  CandidateReusableAnswerSchema,
  CandidateSkillGroupSchema,
  CandidateWorkEligibilitySchema,
  CandidateNarrativeSchema,
  CandidateProfileSchema,
} from "./profile";
import {
  ProfileReviewItemSchema,
  ProfileSetupStateSchema,
  ProfileSetupStepSchema,
} from "./profile-setup";
import {
  CompensationPreferenceObjectSchema,
  JobSearchPreferencesObjectSchema,
  JobSearchPreferencesSchema,
} from "./discovery";

export const profileCopilotRoleValues = ["user", "assistant"] as const;
export const ProfileCopilotRoleSchema = z.enum(profileCopilotRoleValues);
export type ProfileCopilotRole = z.infer<typeof ProfileCopilotRoleSchema>;

export const profileCopilotPatchApplyModeValues = [
  "applied",
  "needs_review",
  "rejected",
] as const;
export const ProfileCopilotPatchApplyModeSchema = z.enum(
  profileCopilotPatchApplyModeValues,
);
export type ProfileCopilotPatchApplyMode = z.infer<
  typeof ProfileCopilotPatchApplyModeSchema
>;

export const profileCopilotProfileSectionValues = [
  "basics",
  "experience",
  "background",
  "preferences",
] as const;
export const ProfileCopilotProfileSectionSchema = z.enum(
  profileCopilotProfileSectionValues,
);
export type ProfileCopilotProfileSection = z.infer<
  typeof ProfileCopilotProfileSectionSchema
>;

export const ProfileCopilotContextSchema = z.discriminatedUnion("surface", [
  z.object({
    surface: z.literal("general"),
  }),
  z.object({
    surface: z.literal("setup"),
    step: ProfileSetupStepSchema,
  }),
  z.object({
    surface: z.literal("profile"),
    section: ProfileCopilotProfileSectionSchema,
  }),
]);
export type ProfileCopilotContext = z.infer<typeof ProfileCopilotContextSchema>;

function requireAtLeastOneField<TSchema extends z.ZodRawShape>(
  schema: z.ZodObject<TSchema>,
  message: string,
) {
  return schema.refine(
    (value) =>
      Object.values(value).some((fieldValue) => fieldValue !== undefined),
    {
      message,
    },
  );
}

export const ProfileIdentityPatchFieldsSchema = requireAtLeastOneField(
  CandidateProfileSchema.pick({
    currentCity: true,
    currentCountry: true,
    currentLocation: true,
    currentRegion: true,
    email: true,
    firstName: true,
    fullName: true,
    githubUrl: true,
    headline: true,
    lastName: true,
    linkedinUrl: true,
    middleName: true,
    personalWebsiteUrl: true,
    phone: true,
    portfolioUrl: true,
    preferredDisplayName: true,
    secondaryEmail: true,
    summary: true,
    timeZone: true,
    yearsExperience: true,
  }).partial(),
  "Identity updates must include at least one field.",
);
export type ProfileIdentityPatchFields = z.infer<
  typeof ProfileIdentityPatchFieldsSchema
>;

export const ProfileWorkEligibilityPatchFieldsSchema = requireAtLeastOneField(
  CandidateWorkEligibilitySchema.partial(),
  "Work eligibility updates must include at least one field.",
);
export type ProfileWorkEligibilityPatchFields = z.infer<
  typeof ProfileWorkEligibilityPatchFieldsSchema
>;

export const ProfileProfessionalSummaryPatchFieldsSchema =
  requireAtLeastOneField(
    CandidateProfessionalSummarySchema.partial(),
    "Professional summary updates must include at least one field.",
  );
export type ProfileProfessionalSummaryPatchFields = z.infer<
  typeof ProfileProfessionalSummaryPatchFieldsSchema
>;

export const ProfileNarrativePatchFieldsSchema = requireAtLeastOneField(
  CandidateNarrativeSchema.partial(),
  "Narrative updates must include at least one field.",
);
export type ProfileNarrativePatchFields = z.infer<
  typeof ProfileNarrativePatchFieldsSchema
>;

export const ProfileAnswerBankPatchFieldsSchema = requireAtLeastOneField(
  CandidateAnswerBankSchema.omit({ customAnswers: true }).partial(),
  "Answer bank updates must include at least one field.",
);
export type ProfileAnswerBankPatchFields = z.infer<
  typeof ProfileAnswerBankPatchFieldsSchema
>;

export const ProfileApplicationIdentityPatchFieldsSchema =
  requireAtLeastOneField(
    CandidateApplicationIdentitySchema.partial(),
    "Application identity updates must include at least one field.",
  );
export type ProfileApplicationIdentityPatchFields = z.infer<
  typeof ProfileApplicationIdentityPatchFieldsSchema
>;

export const ProfileSkillGroupsPatchFieldsSchema = requireAtLeastOneField(
  CandidateSkillGroupSchema.partial(),
  "Skill-group updates must include at least one field.",
);
export type ProfileSkillGroupsPatchFields = z.infer<
  typeof ProfileSkillGroupsPatchFieldsSchema
>;

export const ProfileCoreListPatchFieldsSchema = requireAtLeastOneField(
  CandidateProfileSchema.pick({
    locations: true,
    skills: true,
    targetRoles: true,
  }).partial(),
  "Profile list updates must include at least one field.",
);
export type ProfileCoreListPatchFields = z.infer<
  typeof ProfileCoreListPatchFieldsSchema
>;

/**
 * The lists a removal may touch: one skill, one saved place, one target role.
 *
 * Deleting was the one thing the assistant could not do, because the only
 * list operation replaces a whole field — which means resending every entry
 * the person still wants. A removal names the entries it takes out and
 * nothing else, so it can be quoted back on the confirmation card and
 * replayed if the person undoes it.
 */
export const profileCopilotRemovableListFieldValues = [
  "locations",
  "skills",
  "targetRoles",
] as const;
export const ProfileCopilotRemovableListFieldSchema = z.enum(
  profileCopilotRemovableListFieldValues,
);
export type ProfileCopilotRemovableListField = z.infer<
  typeof ProfileCopilotRemovableListFieldSchema
>;

export const ProfileSearchPreferencesPatchFieldsSchema = requireAtLeastOneField(
  JobSearchPreferencesObjectSchema.pick({
    approvalMode: true,
    companyBlacklist: true,
    companyWhitelist: true,
    discovery: true,
    employmentTypes: true,
    shiftPreference: true,
    weeklyHours: true,
    searchSelectivity: true,
    excludedLocations: true,
    jobFamilies: true,
    locations: true,
    minimumSalaryUsd: true,
    salaryCurrency: true,
    seniorityLevels: true,
    tailoringMode: true,
    targetCompanyStages: true,
    targetIndustries: true,
    targetRoles: true,
    targetSalaryUsd: true,
    workModes: true,
  }).partial(),
  "Search-preference updates must include at least one field.",
);
export type ProfileSearchPreferencesPatchFields = z.infer<
  typeof ProfileSearchPreferencesPatchFieldsSchema
>;

export const ProfileCompensationPreferencePatchFieldsSchema =
  requireAtLeastOneField(
    CompensationPreferenceObjectSchema.partial(),
    "Compensation-preference updates must include at least one field.",
  );
export type ProfileCompensationPreferencePatchFields = z.infer<
  typeof ProfileCompensationPreferencePatchFieldsSchema
>;

export const ProfileCopilotReviewResolutionStatusSchema = z.enum([
  "confirmed",
  "edited",
  "dismissed",
]);
export type ProfileCopilotReviewResolutionStatus = z.infer<
  typeof ProfileCopilotReviewResolutionStatusSchema
>;

function createPartialRecordUpsertSchema<TShape extends z.ZodRawShape>(
  schema: z.ZodObject<TShape>,
  label: string,
) {
  return schema
    .partial()
    .extend({ id: NonEmptyStringSchema.nullable().default(null) })
    .superRefine((value, context) => {
      if (
        !Object.entries(value).some(
          ([key, fieldValue]) => key !== "id" && fieldValue !== undefined,
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} upserts must include at least one changed field.`,
        });
      }
    });
}

const UpsertCandidateExperienceInputSchema = createPartialRecordUpsertSchema(
  CandidateExperienceSchema,
  "Experience",
);
const UpsertCandidateEducationInputSchema = createPartialRecordUpsertSchema(
  CandidateEducationSchema,
  "Education",
);
const UpsertCandidateCertificationInputSchema = createPartialRecordUpsertSchema(
  CandidateCertificationSchema,
  "Certification",
);
const UpsertCandidateLinkInputSchema = createPartialRecordUpsertSchema(
  CandidateLinkSchema,
  "Link",
);
const UpsertCandidateProjectInputSchema = createPartialRecordUpsertSchema(
  CandidateProjectSchema,
  "Project",
);
const UpsertCandidateLanguageInputSchema = createPartialRecordUpsertSchema(
  CandidateLanguageSchema,
  "Language",
);
const UpsertCandidateProofBankEntryInputSchema =
  createPartialRecordUpsertSchema(CandidateProofBankEntrySchema, "Proof-point");
const UpsertCandidateReusableAnswerInputSchema =
  createPartialRecordUpsertSchema(
    CandidateReusableAnswerSchema,
    "Reusable-answer",
  );
const OrderedProfileRecordIdsSchema = z
  .array(NonEmptyStringSchema)
  .min(1)
  .max(50)
  .refine((recordIds) => new Set(recordIds).size === recordIds.length, {
    message: "Ordered record ids must not contain duplicates.",
  });

export const ProfileCopilotPatchOperationSchema = z.discriminatedUnion(
  "operation",
  [
    z.object({
      operation: z.literal("replace_identity_fields"),
      value: ProfileIdentityPatchFieldsSchema,
    }),
    z.object({
      operation: z.literal("replace_work_eligibility_fields"),
      value: ProfileWorkEligibilityPatchFieldsSchema,
    }),
    z.object({
      operation: z.literal("replace_professional_summary_fields"),
      value: ProfileProfessionalSummaryPatchFieldsSchema,
    }),
    z.object({
      operation: z.literal("replace_narrative_fields"),
      value: ProfileNarrativePatchFieldsSchema,
    }),
    z.object({
      operation: z.literal("replace_answer_bank_fields"),
      value: ProfileAnswerBankPatchFieldsSchema,
    }),
    z.object({
      operation: z.literal("replace_application_identity_fields"),
      value: ProfileApplicationIdentityPatchFieldsSchema,
    }),
    z.object({
      operation: z.literal("replace_skill_group_fields"),
      value: ProfileSkillGroupsPatchFieldsSchema,
    }),
    z.object({
      operation: z.literal("replace_profile_list_fields"),
      value: ProfileCoreListPatchFieldsSchema,
    }),
    z.object({
      operation: z.literal("remove_profile_list_entries"),
      field: ProfileCopilotRemovableListFieldSchema,
      /**
       * The exact entries being taken out, carried so the confirmation card
       * can quote them and so the removal can be replayed. A removal never
       * clears a whole list: the entries have to be named.
       */
      values: z.array(NonEmptyStringSchema).min(1).max(50),
    }),
    z.object({
      operation: z.literal("replace_search_preferences_fields"),
      value: ProfileSearchPreferencesPatchFieldsSchema,
    }),
    z.object({
      operation: z.literal("replace_compensation_preferences_fields"),
      value: ProfileCompensationPreferencePatchFieldsSchema,
    }),
    z.object({
      /**
       * The resume level for jobs shortlisted from now on, in the Settings
       * words: keep the imported file (`original_resume`, Original) or write
       * one at a strength (Light, Tailored, Aggressive). Applying it writes
       * what Settings > AI behavior > Resumes writes, so the Assistant can
       * move a person onto or off Original instead of sending them to
       * Settings.
       */
      operation: z.literal("set_resume_approach"),
      value: z.union([z.literal("original_resume"), TailoringModeSchema]),
    }),
    z.object({
      operation: z.literal("upsert_experience_record"),
      record: UpsertCandidateExperienceInputSchema,
    }),
    z.object({
      operation: z.literal("remove_experience_record"),
      recordId: NonEmptyStringSchema,
    }),
    z.object({
      operation: z.literal("upsert_education_record"),
      record: UpsertCandidateEducationInputSchema,
    }),
    z.object({
      operation: z.literal("remove_education_record"),
      recordId: NonEmptyStringSchema,
    }),
    z.object({
      operation: z.literal("reorder_education_records"),
      orderedRecordIds: OrderedProfileRecordIdsSchema,
    }),
    z.object({
      operation: z.literal("upsert_certification_record"),
      record: UpsertCandidateCertificationInputSchema,
    }),
    z.object({
      operation: z.literal("remove_certification_record"),
      recordId: NonEmptyStringSchema,
    }),
    z.object({
      operation: z.literal("upsert_project_record"),
      record: UpsertCandidateProjectInputSchema,
    }),
    z.object({
      operation: z.literal("remove_project_record"),
      recordId: NonEmptyStringSchema,
    }),
    z.object({
      operation: z.literal("upsert_link_record"),
      record: UpsertCandidateLinkInputSchema,
    }),
    z.object({
      operation: z.literal("remove_link_record"),
      recordId: NonEmptyStringSchema,
    }),
    z.object({
      operation: z.literal("upsert_language_record"),
      record: UpsertCandidateLanguageInputSchema,
    }),
    z.object({
      operation: z.literal("remove_language_record"),
      recordId: NonEmptyStringSchema,
    }),
    z.object({
      operation: z.literal("upsert_proof_point"),
      record: UpsertCandidateProofBankEntryInputSchema,
    }),
    z.object({
      operation: z.literal("remove_proof_point"),
      recordId: NonEmptyStringSchema,
    }),
    z.object({
      operation: z.literal("upsert_reusable_answer"),
      record: UpsertCandidateReusableAnswerInputSchema,
    }),
    z.object({
      operation: z.literal("remove_reusable_answer"),
      recordId: NonEmptyStringSchema,
    }),
    z.object({
      operation: z.literal("resolve_review_items"),
      reviewItemIds: z.array(NonEmptyStringSchema).min(1),
      resolutionStatus: ProfileCopilotReviewResolutionStatusSchema,
    }),
  ],
);
export type ProfileCopilotPatchOperation = z.infer<
  typeof ProfileCopilotPatchOperationSchema
>;

export const ProfileCopilotPatchGroupSchema = z.object({
  id: NonEmptyStringSchema,
  summary: NonEmptyStringSchema,
  applyMode: ProfileCopilotPatchApplyModeSchema.default("needs_review"),
  operations: z.array(ProfileCopilotPatchOperationSchema).min(1),
  createdAt: IsoDateTimeSchema,
});
export type ProfileCopilotPatchGroup = z.infer<
  typeof ProfileCopilotPatchGroupSchema
>;

export const ProfileCopilotMessageSchema = z.object({
  id: NonEmptyStringSchema,
  role: ProfileCopilotRoleSchema,
  content: NonEmptyStringSchema,
  context: ProfileCopilotContextSchema.default({ surface: "general" }),
  patchGroups: z.array(ProfileCopilotPatchGroupSchema).default([]),
  executionAttribution: AgentTaskMessageAttributionSchema.nullable().optional(),
  createdAt: IsoDateTimeSchema,
});
export type ProfileCopilotMessage = z.infer<typeof ProfileCopilotMessageSchema>;

export const profileRevisionTriggerValues = [
  "assistant_patch",
  "undo",
] as const;
export const ProfileRevisionTriggerSchema = z.enum(
  profileRevisionTriggerValues,
);
export type ProfileRevisionTrigger = z.infer<
  typeof ProfileRevisionTriggerSchema
>;

export const ProfileRevisionSchema = z.object({
  id: NonEmptyStringSchema,
  /**
   * Monotonic position in the log, so "undo back to here" has an order to
   * work with and two revisions written in the same millisecond still sort.
   * Zero means a revision recorded before sequences existed.
   */
  sequence: z.number().int().nonnegative().default(0),
  createdAt: IsoDateTimeSchema,
  reason: NonEmptyStringSchema.nullable().default(null),
  trigger: ProfileRevisionTriggerSchema,
  messageId: NonEmptyStringSchema.nullable().default(null),
  patchGroupId: NonEmptyStringSchema.nullable().default(null),
  restoredFromRevisionId: NonEmptyStringSchema.nullable().default(null),
  snapshotProfile: CandidateProfileSchema,
  snapshotSearchPreferences: JobSearchPreferencesSchema,
  snapshotProfileSetupState: ProfileSetupStateSchema,
  /**
   * What the assistant left behind, beside the state it found.
   *
   * Without it the log cannot tell an assistant change from a person's own
   * later edit — the next revision's "before" snapshot contains both — so an
   * undo reaching back past a manual edit would quietly discard it. Null on
   * revisions recorded before this field existed; the undo guard then says
   * it cannot check rather than pretending it did.
   */
  snapshotProfileAfter: CandidateProfileSchema.nullable().default(null),
  snapshotSearchPreferencesAfter:
    JobSearchPreferencesSchema.nullable().default(null),
  /**
   * `settings.resumeApplicationMode` before and after an assistant change of
   * the resume level. Original lives in Settings, not in the profile, so
   * without these an Undo put the tailoring strength back and left the
   * person off Original. Null when the change did not touch it.
   */
  snapshotResumeApplicationMode:
    ResumeApplicationModeSchema.nullable().default(null),
  snapshotResumeApplicationModeAfter:
    ResumeApplicationModeSchema.nullable().default(null),
});
export type ProfileRevision = z.infer<typeof ProfileRevisionSchema>;

export const ProfileRevisionSummarySchema = ProfileRevisionSchema.pick({
  id: true,
  sequence: true,
  createdAt: true,
  reason: true,
  trigger: true,
  messageId: true,
  patchGroupId: true,
  restoredFromRevisionId: true,
});
export type ProfileRevisionSummary = z.infer<
  typeof ProfileRevisionSummarySchema
>;

export const ProfileCopilotReplySchema = z.object({
  content: NonEmptyStringSchema,
  patchGroups: z.array(ProfileCopilotPatchGroupSchema).default([]),
  executionReceipt: AgentTaskExecutionReceiptSchema.nullable().optional(),
});
export type ProfileCopilotReply = z.infer<typeof ProfileCopilotReplySchema>;

export const ProfileCopilotRelevantReviewItemSchema = ProfileReviewItemSchema;
export type ProfileCopilotRelevantReviewItem = z.infer<
  typeof ProfileCopilotRelevantReviewItemSchema
>;
