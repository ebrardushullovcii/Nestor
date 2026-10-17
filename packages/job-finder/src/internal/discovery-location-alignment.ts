import type { JobSearchPreferences, SavedJob } from "@nestor/contracts";

const GLOBAL_REMOTE_PREFERENCE_PATTERN =
  /^(?:remote(?:\s*[,/-]\s*(?:anywhere|worldwide|global))?|anywhere|worldwide|global)$/iu;
/**
 * The person asked for local work only when they chose on-site or hybrid
 * themselves. Work modes left blank are not a goal: reading them as "on site
 * or hybrid in my city" marked every remote job down and told the person
 * they had asked for something they never chose.
 */
function requestedLocalWork(preferences: JobSearchPreferences): boolean {
  return (
    preferences.locations.length > 0 &&
    !preferences.locations.some((location) =>
      GLOBAL_REMOTE_PREFERENCE_PATTERN.test(location.trim()),
    ) &&
    !preferences.workModes.includes("remote") &&
    (preferences.workModes.includes("onsite") ||
      preferences.workModes.includes("hybrid"))
  );
}

function requestedLocationLabel(preferences: JobSearchPreferences): string {
  return preferences.locations.join(" or ");
}

/** Describe only this search's returned listings, not a source's full inventory. */
export function describeRemoteOnlySourceMismatch(
  jobs: readonly SavedJob[],
  preferences: JobSearchPreferences,
): string | null {
  // Every job is remote and the model judged none of them in the person's
  // places (ADR 0041). A job it has not judged leaves the question open, so
  // no warning is given on a guess.
  if (
    jobs.length === 0 ||
    !requestedLocalWork(preferences) ||
    !jobs.every((job) => {
      const judgment = job.matchAssessment.judgment;
      return (
        Boolean(judgment) &&
        job.workMode.includes("remote") &&
        judgment?.locationReach !== "in_area"
      );
    })
  ) {
    return null;
  }

  return `This search returned only remote jobs; try another search for jobs in ${requestedLocationLabel(
    preferences,
  )}.`;
}
