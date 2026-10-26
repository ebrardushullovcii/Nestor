import { z } from "zod";
import {
  CandidateProfileSchema,
  CandidateWorkEligibilitySchema,
  CandidateProfessionalSummarySchema,
  CandidateNarrativeSchema,
  CandidateApplicationIdentitySchema,
  CandidateSkillGroupSchema,
  CandidateExperienceSchema,
  CandidateEducationSchema,
  CandidateCertificationSchema,
  CandidateLinkSchema,
  CandidateProjectSchema,
  CandidateLanguageSchema,
  CandidateProofBankEntrySchema,
  ResumeSourceDocumentSchema,
} from "./profile";

/** Only the persisted Profile data; reusable form answers belong to Needs you. */
export const StoredProfileSchema = CandidateProfileSchema;
export type StoredProfile = z.infer<typeof StoredProfileSchema>;

type PrefixedShape<P extends string, S extends z.ZodRawShape> = {
  [K in keyof S & string as `${P}.${K}`]: S[K];
};
export function prefixFieldShape<P extends string, S extends z.ZodRawShape>(
  prefix: P,
  shape: S,
): PrefixedShape<P, S> {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [`${prefix}.${key}`, schema]),
  ) as PrefixedShape<P, S>;
}
const identity = CandidateProfileSchema.omit({
  id: true,
  resumeIdentityOwnership: true,
  baseResume: true,
  workEligibility: true,
  professionalSummary: true,
  narrative: true,
  applicationIdentity: true,
  skillGroups: true,
  targetRoles: true,
  locations: true,
  skills: true,
  experiences: true,
  education: true,
  certifications: true,
  links: true,
  projects: true,
  spokenLanguages: true,
  proofBank: true,
});
/** Whitelisted leaf fields. An edit carries only the fields the person changed. */
export const ProfileFieldsSchema = z
  .object({
    ...identity.shape,
    ...prefixFieldShape(
      "workEligibility",
      CandidateWorkEligibilitySchema.omit({
        authorizedWorkCountries: true,
        limitedWorkPermissions: true,
        preferredRelocationRegions: true,
      }).shape,
    ),
    ...prefixFieldShape(
      "professionalSummary",
      CandidateProfessionalSummarySchema.omit({
        careerThemes: true,
        strengths: true,
      }).shape,
    ),
    ...prefixFieldShape(
      "narrative",
      CandidateNarrativeSchema.omit({
        differentiators: true,
        motivationThemes: true,
      }).shape,
    ),
    ...prefixFieldShape(
      "applicationIdentity",
      CandidateApplicationIdentitySchema.omit({ preferredLinkIds: true }).shape,
    ),
  })
  .partial()
  .strict();
export type ProfileFields = z.infer<typeof ProfileFieldsSchema>;
export const ProfileListsSchema = z
  .object({
    targetRoles: CandidateProfileSchema.shape.targetRoles,
    locations: CandidateProfileSchema.shape.locations,
    skills: CandidateProfileSchema.shape.skills,
    ...prefixFieldShape(
      "workEligibility",
      CandidateWorkEligibilitySchema.pick({
        authorizedWorkCountries: true,
        preferredRelocationRegions: true,
      }).shape,
    ),
    ...prefixFieldShape(
      "professionalSummary",
      CandidateProfessionalSummarySchema.pick({
        careerThemes: true,
        strengths: true,
      }).shape,
    ),
    ...prefixFieldShape(
      "narrative",
      CandidateNarrativeSchema.pick({
        differentiators: true,
        motivationThemes: true,
      }).shape,
    ),
    ...prefixFieldShape(
      "applicationIdentity",
      CandidateApplicationIdentitySchema.pick({ preferredLinkIds: true }).shape,
    ),
    ...prefixFieldShape("skillGroups", CandidateSkillGroupSchema.shape),
  })
  .partial()
  .strict();
export type ProfileLists = z.infer<typeof ProfileListsSchema>;
export const PatchProfileInputSchema = z
  .object({
    fields: ProfileFieldsSchema.default({}),
    lists: ProfileListsSchema.default({}),
    expected: ProfileFieldsSchema.optional(),
    expectedLists: ProfileListsSchema.optional(),
  })
  .strict();
export type PatchProfileInput = z.input<typeof PatchProfileInputSchema>;

export const ProfileRecordSchemas = {
  experiences: CandidateExperienceSchema,
  education: CandidateEducationSchema,
  certifications: CandidateCertificationSchema,
  links: CandidateLinkSchema,
  projects: CandidateProjectSchema,
  spokenLanguages: CandidateLanguageSchema,
  proofBank: CandidateProofBankEntrySchema,
} as const;
export const ProfileRecordCollectionSchema = z.enum([
  "experiences",
  "education",
  "certifications",
  "links",
  "projects",
  "spokenLanguages",
  "proofBank",
]);
export type ProfileRecordCollection = z.infer<
  typeof ProfileRecordCollectionSchema
>;
export const ProfileRecordSchema = z.discriminatedUnion("collection", [
  z.object({
    collection: z.literal("experiences"),
    record: CandidateExperienceSchema,
  }),
  z.object({
    collection: z.literal("education"),
    record: CandidateEducationSchema,
  }),
  z.object({
    collection: z.literal("certifications"),
    record: CandidateCertificationSchema,
  }),
  z.object({ collection: z.literal("links"), record: CandidateLinkSchema }),
  z.object({
    collection: z.literal("projects"),
    record: CandidateProjectSchema,
  }),
  z.object({
    collection: z.literal("spokenLanguages"),
    record: CandidateLanguageSchema,
  }),
  z.object({
    collection: z.literal("proofBank"),
    record: CandidateProofBankEntrySchema,
  }),
]);
export type ProfileRecord = z.infer<typeof ProfileRecordSchema>;
export const ProfileRecordQuerySchema = z
  .object({
    collection: ProfileRecordCollectionSchema,
    text: z.string().trim().max(200).default(""),
    after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();
export type ProfileRecordQuery = z.input<typeof ProfileRecordQuerySchema>;
export const ProfileRecordPageSchema = z.object({
  rows: z.array(ProfileRecordSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.number().int().positive().nullable(),
});
export type ProfileRecordPage = z.infer<typeof ProfileRecordPageSchema>;
export const RemoveProfileRecordInputSchema = z
  .object({ collection: ProfileRecordCollectionSchema, id: z.string().min(1) })
  .strict();
export type RemoveProfileRecordInput = z.infer<
  typeof RemoveProfileRecordInputSchema
>;
/** Resume text and private file paths are main-process inputs, never a Profile list payload. */
export const ProfileResumeMetadataSchema = ResumeSourceDocumentSchema.omit({
  storagePath: true,
  textContent: true,
});
export const ProfileOverviewSchema = z.object({
  hasResumeText: z.boolean(),
  hasSavedResumeFile: z.boolean(),
  resumeIdentityOwnership: CandidateProfileSchema.shape.resumeIdentityOwnership,
  id: z.string(),
  fields: ProfileFieldsSchema,
  lists: ProfileListsSchema,
  counts: z.record(
    ProfileRecordCollectionSchema,
    z.number().int().nonnegative(),
  ),
  experienceRequired: z.object({
    filled: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  resume: ProfileResumeMetadataSchema,
  limitedWorkPermissions:
    CandidateWorkEligibilitySchema.shape.limitedWorkPermissions,
});
export type ProfileOverview = z.infer<typeof ProfileOverviewSchema>;
