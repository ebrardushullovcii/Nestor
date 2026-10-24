import { fnv1a64 } from "@nestor/core";
import type { JobPosting } from "./discovery";

export const MATCH_ASSESSMENT_LOGIC_REVISION = 16;

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

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

export function createMatchAssessmentInputFingerprint(
  prefix: string,
  value: unknown,
): string {
  return `${prefix}_${fnv1a64(stableSerialize(value))}`;
}

/** The unchanged fit evidence tuple, independent of its saved/prepared carrier. */
export function computeMatchAssessmentPostingFingerprint(
  posting: MatchAssessmentPostingInput,
): string {
  return createMatchAssessmentInputFingerprint(
    `match_posting_v4_logic${MATCH_ASSESSMENT_LOGIC_REVISION}`,
    createMatchAssessmentPostingInput(posting),
  );
}
