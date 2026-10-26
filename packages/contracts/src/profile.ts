import { z } from "zod";

import {
  AiProviderKindSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  ResumeExtractionStatusSchema,
  UrlStringSchema,
  WorkModeListSchema,
} from "./base";

export const ResumeSourceDocumentSchema = z.object({
  id: NonEmptyStringSchema,
  fileName: NonEmptyStringSchema,
  uploadedAt: IsoDateTimeSchema,
  storagePath: NonEmptyStringSchema.nullable().default(null),
  sha256: z
    .string()
    .regex(
      /^[a-f0-9]{64}$/i,
      "Resume SHA-256 must be 64 hexadecimal characters.",
    )
    .nullable()
    .optional(),
  textContent: NonEmptyStringSchema.nullable().default(null),
  textUpdatedAt: IsoDateTimeSchema.nullable().default(null),
  sourceIdentity: z
    .object({
      fullName: NonEmptyStringSchema.nullable(),
      email: NonEmptyStringSchema.nullable(),
    })
    .optional(),
  extractionStatus: ResumeExtractionStatusSchema.default("not_started"),
  lastAnalyzedAt: IsoDateTimeSchema.nullable().default(null),
  analysisProviderKind: AiProviderKindSchema.nullable().default(null),
  analysisProviderLabel: NonEmptyStringSchema.nullable().default(null),
  analysisWarnings: z.array(NonEmptyStringSchema).default([]),
});
export type ResumeSourceDocument = z.infer<typeof ResumeSourceDocumentSchema>;

export const CandidateExperienceSchema = z.object({
  id: NonEmptyStringSchema,
  companyName: NonEmptyStringSchema.nullable().default(null),
  companyUrl: NonEmptyStringSchema.nullable().default(null),
  title: NonEmptyStringSchema.nullable().default(null),
  employmentType: NonEmptyStringSchema.nullable().default(null),
  location: NonEmptyStringSchema.nullable().default(null),
  workMode: WorkModeListSchema,
  startDate: NonEmptyStringSchema.nullable().default(null),
  endDate: NonEmptyStringSchema.nullable().default(null),
  isCurrent: z.boolean().default(false),
  isDraft: z.boolean().default(false),
  summary: NonEmptyStringSchema.nullable().default(null),
  achievements: z.array(NonEmptyStringSchema).default([]),
  skills: z.array(NonEmptyStringSchema).default([]),
  domainTags: z.array(NonEmptyStringSchema).default([]),
  peopleManagementScope: NonEmptyStringSchema.nullable().default(null),
  ownershipScope: NonEmptyStringSchema.nullable().default(null),
});
export type CandidateExperience = z.infer<typeof CandidateExperienceSchema>;

export const CandidateEducationSchema = z.object({
  id: NonEmptyStringSchema,
  schoolName: NonEmptyStringSchema.nullable().default(null),
  degree: NonEmptyStringSchema.nullable().default(null),
  fieldOfStudy: NonEmptyStringSchema.nullable().default(null),
  location: NonEmptyStringSchema.nullable().default(null),
  startDate: NonEmptyStringSchema.nullable().default(null),
  endDate: NonEmptyStringSchema.nullable().default(null),
  isDraft: z.boolean().default(false),
  summary: NonEmptyStringSchema.nullable().default(null),
});
export type CandidateEducation = z.infer<typeof CandidateEducationSchema>;

export const CandidateCertificationSchema = z.object({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema.nullable().default(null),
  issuer: NonEmptyStringSchema.nullable().default(null),
  issueDate: NonEmptyStringSchema.nullable().default(null),
  expiryDate: NonEmptyStringSchema.nullable().default(null),
  credentialUrl: UrlStringSchema.nullable().default(null),
  isDraft: z.boolean().default(false),
});
export type CandidateCertification = z.infer<
  typeof CandidateCertificationSchema
>;

export const candidateLinkKindValues = [
  "portfolio",
  "linkedin",
  "github",
  "website",
  "repository",
  "case_study",
  "other",
] as const;
export const CandidateLinkKindSchema = z.enum(candidateLinkKindValues);
export type CandidateLinkKind = z.infer<typeof CandidateLinkKindSchema>;

export const CandidateLinkSchema = z.object({
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema.nullable().default(null),
  url: UrlStringSchema.nullable().default(null),
  kind: CandidateLinkKindSchema.nullable().default(null),
  isDraft: z.boolean().default(false),
});
export type CandidateLink = z.infer<typeof CandidateLinkSchema>;

export const CandidateProjectSchema = z.object({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  projectType: NonEmptyStringSchema.nullable().default(null),
  summary: NonEmptyStringSchema.nullable().default(null),
  role: NonEmptyStringSchema.nullable().default(null),
  skills: z.array(NonEmptyStringSchema).default([]),
  outcome: NonEmptyStringSchema.nullable().default(null),
  projectUrl: NonEmptyStringSchema.nullable().default(null),
  repositoryUrl: NonEmptyStringSchema.nullable().default(null),
  caseStudyUrl: NonEmptyStringSchema.nullable().default(null),
});
export type CandidateProject = z.infer<typeof CandidateProjectSchema>;

export const CandidateLanguageSchema = z.object({
  id: NonEmptyStringSchema,
  language: NonEmptyStringSchema,
  proficiency: NonEmptyStringSchema.nullable().default(null),
  interviewPreference: z.boolean().default(false),
  notes: NonEmptyStringSchema.nullable().default(null),
});
export type CandidateLanguage = z.infer<typeof CandidateLanguageSchema>;

export const CandidateWorkEligibilitySchema = z.object({
  authorizedWorkCountries: z.array(NonEmptyStringSchema).default([]),
  limitedWorkPermissions: z
    .array(
      z.object({
        country: NonEmptyStringSchema,
        conditions: NonEmptyStringSchema,
        requiresFutureSponsorship: z.boolean().nullable().default(null),
      }),
    )
    .optional(),
  requiresVisaSponsorship: z.boolean().nullable().default(null),
  willingToRelocate: z.boolean().nullable().default(null),
  preferredRelocationRegions: z.array(NonEmptyStringSchema).default([]),
  willingToTravel: z.boolean().nullable().default(null),
  remoteEligible: z.boolean().nullable().default(null),
  noticePeriodDays: z.number().int().min(0).nullable().default(null),
  availableStartDate: NonEmptyStringSchema.nullable().default(null),
  securityClearance: NonEmptyStringSchema.nullable().default(null),
});
export type CandidateWorkEligibility = z.infer<
  typeof CandidateWorkEligibilitySchema
>;

export const CandidateProfessionalSummarySchema = z.object({
  shortValueProposition: NonEmptyStringSchema.nullable().default(null),
  fullSummary: NonEmptyStringSchema.nullable().default(null),
  careerThemes: z.array(NonEmptyStringSchema).default([]),
  leadershipSummary: NonEmptyStringSchema.nullable().default(null),
  domainFocusSummary: NonEmptyStringSchema.nullable().default(null),
  strengths: z.array(NonEmptyStringSchema).default([]),
});
export type CandidateProfessionalSummary = z.infer<
  typeof CandidateProfessionalSummarySchema
>;

export const CandidateNarrativeSchema = z.object({
  professionalStory: NonEmptyStringSchema.nullable().default(null),
  nextChapterSummary: NonEmptyStringSchema.nullable().default(null),
  careerTransitionSummary: NonEmptyStringSchema.nullable().default(null),
  differentiators: z.array(NonEmptyStringSchema).default([]),
  motivationThemes: z.array(NonEmptyStringSchema).default([]),
});
export type CandidateNarrative = z.infer<typeof CandidateNarrativeSchema>;

export const CandidateProofBankEntrySchema = z.object({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  claim: NonEmptyStringSchema,
  heroMetric: NonEmptyStringSchema.nullable().default(null),
  supportingContext: NonEmptyStringSchema.nullable().default(null),
  roleFamilies: z.array(NonEmptyStringSchema).default([]),
  projectIds: z.array(NonEmptyStringSchema).default([]),
  linkIds: z.array(NonEmptyStringSchema).default([]),
});
export type CandidateProofBankEntry = z.infer<
  typeof CandidateProofBankEntrySchema
>;

export const candidateAnswerKindValues = [
  "work_authorization",
  "visa_sponsorship",
  "relocation",
  "travel",
  "notice_period",
  "availability",
  "salary_expectation",
  "self_intro",
  "career_transition",
  "other",
] as const;
export const CandidateAnswerKindSchema = z.enum(candidateAnswerKindValues);
export type CandidateAnswerKind = z.infer<typeof CandidateAnswerKindSchema>;

export const CandidateReusableAnswerSchema = z.object({
  needsConfirmation: z.boolean().optional(),
  id: NonEmptyStringSchema,
  kind: CandidateAnswerKindSchema.default("other"),
  label: NonEmptyStringSchema,
  question: NonEmptyStringSchema,
  answer: NonEmptyStringSchema,
  roleFamilies: z.array(NonEmptyStringSchema).default([]),
  proofEntryIds: z.array(NonEmptyStringSchema).default([]),
  applicationScope: z
    .object({
      resultId: NonEmptyStringSchema.nullable(),
      applicationRecordId: NonEmptyStringSchema.nullable(),
      location: NonEmptyStringSchema.nullable(),
      hiringCountry: NonEmptyStringSchema.optional(),
    })
    .optional(),
});
export type CandidateReusableAnswer = z.infer<
  typeof CandidateReusableAnswerSchema
>;

function migrateReusableAnswerScope(
  answer: CandidateReusableAnswer,
): CandidateReusableAnswer {
  // Migrate the exact suffix written by older versions; never infer a country.
  if (
    answer.applicationScope ||
    (answer.kind !== "work_authorization" && answer.kind !== "visa_sponsorship")
  )
    return answer;
  const legacy =
    /^(.*) \(Application location: (.*); reuse only for the same hiring country and permit conditions\)$/u.exec(
      answer.question,
    );
  if (!legacy) return answer;
  const question = legacy[1]!;
  return {
    ...answer,
    question,
    label: question.slice(0, 120),
    applicationScope: {
      resultId: null,
      applicationRecordId: null,
      location: legacy[2] === "unspecified" ? null : legacy[2]!,
    },
  };
}

export const CandidateAnswerBankSchema = z.object({
  workAuthorization: NonEmptyStringSchema.nullable().default(null),
  visaSponsorship: NonEmptyStringSchema.nullable().default(null),
  relocation: NonEmptyStringSchema.nullable().default(null),
  travel: NonEmptyStringSchema.nullable().default(null),
  noticePeriod: NonEmptyStringSchema.nullable().default(null),
  availability: NonEmptyStringSchema.nullable().default(null),
  salaryExpectations: NonEmptyStringSchema.nullable().default(null),
  selfIntroduction: NonEmptyStringSchema.nullable().default(null),
  careerTransition: NonEmptyStringSchema.nullable().default(null),
  customAnswers: z
    .array(CandidateReusableAnswerSchema)
    .transform((answers) => answers.map(migrateReusableAnswerScope))
    .default([]),
});
export type CandidateAnswerBank = z.infer<typeof CandidateAnswerBankSchema>;

export const CandidateApplicationIdentitySchema = z.object({
  preferredEmail: NonEmptyStringSchema.nullable().default(null),
  preferredPhone: NonEmptyStringSchema.nullable().default(null),
  preferredLinkIds: z.array(NonEmptyStringSchema).default([]),
});
export type CandidateApplicationIdentity = z.infer<
  typeof CandidateApplicationIdentitySchema
>;

export const CandidateSkillGroupSchema = z.object({
  coreSkills: z.array(NonEmptyStringSchema).default([]),
  tools: z.array(NonEmptyStringSchema).default([]),
  languagesAndFrameworks: z.array(NonEmptyStringSchema).default([]),
  softSkills: z.array(NonEmptyStringSchema).default([]),
  highlightedSkills: z.array(NonEmptyStringSchema).default([]),
});
export type CandidateSkillGroup = z.infer<typeof CandidateSkillGroupSchema>;

const FreshStartIdentityTextSchema =
  NonEmptyStringSchema.nullable().default(null);

/**
 * The person's own answer to "this document names someone else".
 *
 * A resume can genuinely carry two identities — a template header the writer
 * never replaced, a maiden name, a document written for someone else and
 * reused. The product used to treat that as a dead block: no draft, no
 * export, no way forward. The way forward is the person's explicit word that
 * the document is theirs and that their profile name is the right one.
 *
 * The exact source values they saw are recorded, so this is never a blanket
 * permission: importing a different document that names a third person raises
 * the block again.
 */
export const ResumeIdentityOwnershipAcknowledgementSchema = z.object({
  acknowledgedSourceFullName: NonEmptyStringSchema.nullable().default(null),
  acknowledgedSourceEmail: NonEmptyStringSchema.nullable().default(null),
  acknowledgedAt: IsoDateTimeSchema,
});
export type ResumeIdentityOwnershipAcknowledgement = z.infer<
  typeof ResumeIdentityOwnershipAcknowledgementSchema
>;

export const CandidateProfileSchema = z.object({
  id: NonEmptyStringSchema,
  /**
   * Set only when the person chose "this is my resume, use my profile name".
   * Absent or null means no such choice was made and the mismatch still
   * blocks: nothing here is ever inferred on their behalf.
   */
  resumeIdentityOwnership:
    ResumeIdentityOwnershipAcknowledgementSchema.nullable().optional(),
  firstName: FreshStartIdentityTextSchema,
  lastName: FreshStartIdentityTextSchema,
  middleName: NonEmptyStringSchema.nullable().default(null),
  fullName: FreshStartIdentityTextSchema,
  preferredDisplayName: NonEmptyStringSchema.nullable().default(null),
  headline: FreshStartIdentityTextSchema,
  summary: FreshStartIdentityTextSchema,
  currentLocation: FreshStartIdentityTextSchema,
  currentCity: NonEmptyStringSchema.nullable().default(null),
  currentRegion: NonEmptyStringSchema.nullable().default(null),
  currentCountry: NonEmptyStringSchema.nullable().default(null),
  timeZone: NonEmptyStringSchema.nullable().default(null),
  yearsExperience: z.number().int().min(0).nullable(),
  email: NonEmptyStringSchema.nullable().default(null),
  secondaryEmail: NonEmptyStringSchema.nullable().default(null),
  phone: NonEmptyStringSchema.nullable().default(null),
  portfolioUrl: NonEmptyStringSchema.nullable().default(null),
  linkedinUrl: NonEmptyStringSchema.nullable().default(null),
  githubUrl: NonEmptyStringSchema.nullable().default(null),
  personalWebsiteUrl: NonEmptyStringSchema.nullable().default(null),
  baseResume: ResumeSourceDocumentSchema,
  workEligibility: CandidateWorkEligibilitySchema.default({}),
  professionalSummary: CandidateProfessionalSummarySchema.default({}),
  narrative: CandidateNarrativeSchema.default({}),
  proofBank: z.array(CandidateProofBankEntrySchema).default([]),
  answerBank: CandidateAnswerBankSchema.default({}),
  applicationIdentity: CandidateApplicationIdentitySchema.default({}),
  skillGroups: CandidateSkillGroupSchema.default({}),
  targetRoles: z.array(NonEmptyStringSchema).default([]),
  locations: z.array(NonEmptyStringSchema).default([]),
  skills: z.array(NonEmptyStringSchema).default([]),
  experiences: z.array(CandidateExperienceSchema).default([]),
  education: z.array(CandidateEducationSchema).default([]),
  certifications: z.array(CandidateCertificationSchema).default([]),
  links: z.array(CandidateLinkSchema).default([]),
  projects: z.array(CandidateProjectSchema).default([]),
  spokenLanguages: z.array(CandidateLanguageSchema).default([]),
});
export type CandidateProfile = z.infer<typeof CandidateProfileSchema>;
