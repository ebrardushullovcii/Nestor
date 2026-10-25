import { z } from "zod";
import {
  JobSearchPreferencesObjectSchema,
  CompensationPreferenceObjectSchema,
} from "./discovery";
import {
  JobFinderSettingsSchema,
  CoverLetterPreferenceSchema,
  AiProfileAssistantBehaviorSchema,
  AiJobSearchBehaviorSchema,
  AiApplyingBehaviorSchema,
} from "./workspace";
import { prefixFieldShape } from "./profile-store";

export const GoalFieldsSchema = z
  .object({
    ...JobSearchPreferencesObjectSchema.omit({
      targetRoles: true,
      jobFamilies: true,
      locations: true,
      excludedLocations: true,
      workModes: true,
      seniorityLevels: true,
      targetIndustries: true,
      targetCompanyStages: true,
      employmentTypes: true,
      companyBlacklist: true,
      companyWhitelist: true,
      discovery: true,
      compensation: true,
      weeklyHours: true,
    }).shape,
    ...prefixFieldShape(
      "compensation",
      CompensationPreferenceObjectSchema.shape,
    ),
    "weeklyHours.minimum": z.number().min(0).max(168).nullable(),
    "weeklyHours.maximum": z.number().min(0).max(168).nullable(),
  })
  .partial()
  .strict();
export type GoalFields = z.infer<typeof GoalFieldsSchema>;
export const GoalListsSchema = JobSearchPreferencesObjectSchema.pick({
  targetRoles: true,
  jobFamilies: true,
  locations: true,
  excludedLocations: true,
  workModes: true,
  seniorityLevels: true,
  targetIndustries: true,
  targetCompanyStages: true,
  employmentTypes: true,
  companyBlacklist: true,
  companyWhitelist: true,
})
  .partial()
  .strict();
export type GoalLists = z.infer<typeof GoalListsSchema>;
export const GoalValuesSchema = z.object({
  fields: GoalFieldsSchema,
  lists: GoalListsSchema,
});
export type GoalValues = z.infer<typeof GoalValuesSchema>;
export const PatchGoalsInputSchema = GoalValuesSchema.extend({
  fields: GoalFieldsSchema.default({}),
  lists: GoalListsSchema.default({}),
  expected: GoalFieldsSchema.optional(),
}).strict();
export type PatchGoalsInput = z.input<typeof PatchGoalsInputSchema>;

export const SettingsFieldsSchema = z
  .object({
    ...JobFinderSettingsSchema.omit({
      applicationCrm: true,
      coverLetter: true,
      aiBehavior: true,
    }).shape,
    ...prefixFieldShape("coverLetter", CoverLetterPreferenceSchema.shape),
    ...prefixFieldShape(
      "aiBehavior.profileAssistant",
      AiProfileAssistantBehaviorSchema.shape,
    ),
    ...prefixFieldShape(
      "aiBehavior.jobSearch",
      AiJobSearchBehaviorSchema.shape,
    ),
    ...prefixFieldShape(
      "aiBehavior.applying",
      AiApplyingBehaviorSchema.omit({ preApprovedDeclarations: true }).shape,
    ),
    "applicationCrm.noResponseAutomation.enabled": z.boolean(),
    "applicationCrm.noResponseAutomation.afterDays": z
      .number()
      .int()
      .min(1)
      .max(365),
  })
  .partial()
  .strict();
export type SettingsFields = z.infer<typeof SettingsFieldsSchema>;
export const SettingsListsSchema = z
  .object({
    "aiBehavior.applying.preApprovedDeclarations":
      AiApplyingBehaviorSchema.shape.preApprovedDeclarations,
  })
  .partial()
  .strict();
export type SettingsLists = z.infer<typeof SettingsListsSchema>;
export const SettingsValuesSchema = z.object({
  fields: SettingsFieldsSchema,
  lists: SettingsListsSchema,
});
export type SettingsValues = z.infer<typeof SettingsValuesSchema>;
export const PatchSettingsInputSchema = SettingsValuesSchema.extend({
  fields: SettingsFieldsSchema.default({}),
  lists: SettingsListsSchema.default({}),
  expected: SettingsFieldsSchema.optional(),
}).strict();
export type PatchSettingsInput = z.input<typeof PatchSettingsInputSchema>;
