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
