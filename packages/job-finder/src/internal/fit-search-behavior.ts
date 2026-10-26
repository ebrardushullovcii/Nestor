import {
  AiBehaviorPreferenceSchema,
  type JobFinderSettings,
  type JobSearchPreferences,
} from "@nestor/contracts";

/** Runtime-only policy for legacy fit readers; job_sites remains the source authority. */
export function withSettingsFitBehavior(
  preferences: JobSearchPreferences,
  settings: Pick<JobFinderSettings, "aiBehavior"> | null | undefined,
): JobSearchPreferences {
  const behavior = AiBehaviorPreferenceSchema.parse(
    settings?.aiBehavior ?? {},
  ).jobSearch;
  const discovery = { ...preferences.discovery };
  delete discovery.remoteCountsAsAnyLocation;
  if (!behavior.remoteCountsAsAnyLocation)
    discovery.remoteCountsAsAnyLocation = false;
  discovery.collectOnlyHardCriteriaMatches =
    (preferences.searchSelectivity ?? behavior.selectivity) === "best_matches";
  return { ...preferences, discovery };
}
