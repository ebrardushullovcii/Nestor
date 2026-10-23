import type {
  CandidateProfile,
  JobFinderSettings,
  JobSearchCampaignCollection,
  JobSearchPreferences,
  MatchAssessment,
  SavedJob,
} from "@nestor/contracts";

import { searchPreferencesForCampaignRun } from "./campaign-dashboard";
import { withSavedJobSearchBehavior } from "./job-search-behavior";
import {
  createFitVerdictFingerprint,
  createMatchAssessmentContextFingerprint,
  rebindLegacyVerdict,
} from "./match-assessment-session";
import { enrichSearchPreferencesFromProfile } from "./workspace-helpers";
import type { WorkspaceServiceContext } from "./workspace-service-context";

/**
 * Legacy verdict stamp to verdict fingerprint, for every set of goals a
 * verdict can have been given against: the saved goals and each plan's, as
 * given (resume workspace) and as a search or the backlog judge builds them.
 */
export function buildLegacyVerdictFingerprintMap(input: {
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  settings: Pick<JobFinderSettings, "aiBehavior"> | null | undefined;
  campaignState:
    | Pick<JobSearchCampaignCollection, "campaigns">
    | null
    | undefined;
}): Map<string, string> {
  const goals = [
    input.searchPreferences,
    ...(input.campaignState?.campaigns ?? []).map(
      searchPreferencesForCampaignRun,
    ),
  ];
  const map = new Map<string, string>();
  for (const raw of goals) {
    for (const preferences of [
      raw,
      withSavedJobSearchBehavior(
        enrichSearchPreferencesFromProfile(raw, input.profile),
        input.settings,
      ),
    ]) {
      const context = createMatchAssessmentContextFingerprint(
        input.profile,
        preferences,
      );
      const verdict = createFitVerdictFingerprint(input.profile, preferences);
      map.set(context, verdict);
      map.set(context.replace("_logic16_", "_logic15_"), verdict);
    }
  }
  return map;
}

function rebindWithMap(
  assessment: MatchAssessment,
  map: ReadonlyMap<string, string>,
): MatchAssessment {
  const stored = assessment.judgment?.contextFingerprint;
  const verdictFingerprint = stored ? map.get(stored) : undefined;
  return stored && verdictFingerprint
    ? rebindLegacyVerdict(assessment, {
        verdictFingerprint,
        legacyVerdictFingerprint: stored,
      })
    : assessment;
}

/** The job with every legacy-stamped verdict re-stamped; the same object when none was. */
export function rebindJobLegacyVerdicts<T extends SavedJob>(
  job: T,
  map: ReadonlyMap<string, string>,
): T {
  const matchAssessment = rebindWithMap(job.matchAssessment, map);
  let planAssessments = job.planAssessments;
  for (const [planId, assessment] of Object.entries(
    job.planAssessments ?? {},
  )) {
    const rebound = rebindWithMap(assessment, map);
    if (rebound !== assessment)
      planAssessments = { ...planAssessments, [planId]: rebound };
  }
  return matchAssessment === job.matchAssessment &&
    planAssessments === job.planAssessments
    ? job
    : { ...job, matchAssessment, planAssessments };
}

/**
 * Re-stamps fit verdicts an earlier build stamped with the whole-input
 * fingerprint, while the profile and goals they were given on are still the
 * saved ones. Runs once a process, before the person edits anything: after an
 * edit the old stamp of the new inputs no longer matches, and a verdict that
 * was current would be judged again for nothing. Writes only changed jobs.
 */
export async function rebindLegacyFitVerdicts(
  ctx: Pick<WorkspaceServiceContext, "repository" | "persistDiscoveryState">,
  /** Jobs the caller already read; the writes still apply to current rows. */
  loaded?: {
    savedJobs: readonly SavedJob[];
    pendingDiscoveryJobs: readonly SavedJob[];
  },
): Promise<number> {
  const [profile, searchPreferences, settings, campaignState] =
    await Promise.all([
      ctx.repository.getProfile(),
      ctx.repository.getSearchPreferences(),
      ctx.repository.getSettings(),
      ctx.repository.getCampaignState(),
    ]);
  const map = buildLegacyVerdictFingerprintMap({
    profile,
    searchPreferences,
    settings,
    campaignState,
  });
  const rebind = <T extends SavedJob>(job: T) =>
    rebindJobLegacyVerdicts(job, map);
  const [savedJobs, pendingDiscoveryJobs] = loaded
    ? [loaded.savedJobs, loaded.pendingDiscoveryJobs]
    : await Promise.all([
        ctx.repository.readSavedJobsProjection(),
        ctx.repository
          .readDiscoveryDisplayProjection()
          .then((discovery) => discovery.pendingDiscoveryJobs),
      ]);
  const changedIds = savedJobs
    .filter((job) => rebind(job) !== job)
    .map((job) => job.id);
  if (changedIds.length > 0)
    await ctx.repository.commitSavedJobDelta({
      updateJobIds: changedIds,
      update: rebind,
    });
  const pendingChanged = pendingDiscoveryJobs.filter(
    (job) => rebind(job) !== job,
  ).length;
  if (pendingChanged > 0)
    await ctx.persistDiscoveryState((current) => {
      const pendingDiscoveryJobs = current.pendingDiscoveryJobs.map(rebind);
      return pendingDiscoveryJobs.every(
        (job, index) => job === current.pendingDiscoveryJobs[index],
      )
        ? current
        : { ...current, pendingDiscoveryJobs };
    });
  return changedIds.length + pendingChanged;
}
