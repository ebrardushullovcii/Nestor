import type { JobSearchPreferences } from "./discovery";

/** Search facts only; resume, application and persistence settings stay out. */
type OtherSearchGoals = Pick<
  JobSearchPreferences,
  | "jobFamilies"
  | "excludedLocations"
  | "workModes"
  | "seniorityLevels"
  | "targetIndustries"
  | "targetCompanyStages"
  | "employmentTypes"
  | "companyBlacklist"
  | "companyWhitelist"
  | "compensation"
  | "shiftPreference"
  | "weeklyHours"
>;

export type JobSearchGoals = Pick<
  JobSearchPreferences,
  "targetRoles" | "locations"
> & {
  [Key in keyof OtherSearchGoals]?: OtherSearchGoals[Key] | undefined;
};

/** The runner implements this with an indexed store lookup, one page at a time. */
export type KnownJobUrlLookup = (
  urls: readonly string[],
) => Promise<readonly string[]>;

export type ReadDiscoveryPostingPage = (
  url: string,
  options: {
    signal?: AbortSignal;
    rendered?: boolean;
    ready?: (html: string) => boolean;
  },
) => Promise<{ html: string; finalUrl: string }>;

/** Do not spread saved preferences: they also contain every source URL. */
export function toJobSearchGoals(preferences: JobSearchGoals): JobSearchGoals {
  const {
    targetRoles,
    locations,
    jobFamilies,
    excludedLocations,
    workModes,
    seniorityLevels,
    targetIndustries,
    targetCompanyStages,
    employmentTypes,
    companyBlacklist,
    companyWhitelist,
    compensation,
    shiftPreference,
    weeklyHours,
  } = preferences;
  return {
    targetRoles,
    locations,
    jobFamilies,
    excludedLocations,
    workModes,
    seniorityLevels,
    targetIndustries,
    targetCompanyStages,
    employmentTypes,
    companyBlacklist,
    companyWhitelist,
    compensation,
    shiftPreference,
    weeklyHours,
  };
}

export type ListingDetailExtractionMethod = "json_ld" | "page_text";

/**
 * What one listing page said. `json_ld` is the page's own structured record;
 * `page_text` is the model's reading of the page's text (ADR 0041).
 */
export interface ExtractedListingDetail {
  method: ListingDetailExtractionMethod;
  title: string | null;
  company: string | null;
  location: string | null;
  /** Plain text with paragraphs separated by blank lines and "• " bullets. */
  description: string;
  /** Length before this reader's safety cap was applied. */
  descriptionSourceLength?: number;
  /** The captured text ended at a cap or in a likely word fragment. */
  descriptionLikelyTruncated?: boolean;
  salaryText: string | null;
  employmentType: string | null;
  /** ISO timestamp when the record carried a parseable posting date. */
  postedAt: string | null;
  validThrough: string | null;
  workModeHints: string[];
  directApplyUrl: string | null;
  /** The model's reading of the listing's skills and requirements. */
  keySkills?: string[];
  responsibilities?: string[];
  minimumQualifications?: string[];
  preferredQualifications?: string[];
  seniority?: string | null;
}

export interface ExtractListingDetailInput {
  html: string;
  url: string;
  /** The title the card carried; used to pick among several records. */
  expectedTitle?: string | null;
}
