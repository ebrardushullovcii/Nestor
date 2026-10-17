import type { JobPosting } from "@nestor/contracts";

export const MATCH_ASSESSMENT_POSTING_INPUT_FIELDS = [
  "title",
  "company",
  "location",
  "workMode",
  "seniority",
  "employmentType",
  "applyPath",
  "easyApplyEligible",
  "salaryText",
  "detailQuality",
  "screeningHints",
  "summary",
  "description",
  "keySkills",
  "keywordSignals",
  "responsibilities",
  "minimumQualifications",
  "preferredQualifications",
  "department",
  "team",
  "benefits",
  "atsProvider",
] as const satisfies readonly (keyof JobPosting)[];

export type MatchAssessmentPostingInput = Pick<
  JobPosting,
  (typeof MATCH_ASSESSMENT_POSTING_INPUT_FIELDS)[number]
>;

export function createMatchAssessmentPostingInput(
  posting: MatchAssessmentPostingInput,
): MatchAssessmentPostingInput {
  return {
    title: posting.title,
    company: posting.company,
    location: posting.location,
    workMode: posting.workMode,
    seniority: posting.seniority,
    employmentType: posting.employmentType,
    applyPath: posting.applyPath,
    easyApplyEligible: posting.easyApplyEligible,
    salaryText: posting.salaryText,
    detailQuality: posting.detailQuality,
    screeningHints: posting.screeningHints,
    summary: posting.summary,
    description: posting.description,
    keySkills: posting.keySkills,
    keywordSignals: posting.keywordSignals,
    responsibilities: posting.responsibilities,
    minimumQualifications: posting.minimumQualifications,
    preferredQualifications: posting.preferredQualifications,
    department: posting.department,
    team: posting.team,
    benefits: posting.benefits,
    atsProvider: posting.atsProvider,
  };
}
