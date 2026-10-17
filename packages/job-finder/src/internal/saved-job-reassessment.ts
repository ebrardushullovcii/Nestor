import type { MatchAssessment, SavedJob } from "@nordri/contracts";

import { withSavedJobSearchBehavior } from "./job-search-behavior";
import { createMatchAssessmentSession } from "./match-assessment-session";
import { createMatchAssessment } from "./matching";
import { enrichSearchPreferencesFromProfile } from "./workspace-helpers";
import type { WorkspaceServiceContext } from "./workspace-service-context";

function sameAssessment(left: MatchAssessment, right: MatchAssessment) {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Re-scores saved and staged jobs against the profile and search goals as
 * they are now, without searching any site again. Changing a goal (Remote,
 * a country, a role) used to leave every saved score and explanation as it
 * was until the next search. Assessments whose profile and listing are
 * unchanged are reused, so this is cheap when nothing that matters changed.
 */
export async function reassessSavedJobs(
  ctx: Pick<
    WorkspaceServiceContext,
    "repository" | "persistDiscoveryState" | "getActiveCampaignId"
  >,
): Promise<void> {
  const [profile, searchPreferences, settings, campaignState] =
    await Promise.all([
      ctx.repository.getProfile(),
      ctx.repository.getSearchPreferences(),
      ctx.repository.getSettings(),
      ctx.repository.getCampaignState(),
    ]);
  const activeCampaignId = await ctx.getActiveCampaignId();
  const activeCampaign = campaignState?.campaigns.find(
    (campaign) => campaign.id === activeCampaignId,
  );
  const preferences = withSavedJobSearchBehavior(
    enrichSearchPreferencesFromProfile(
      activeCampaign?.searchPreferences ?? searchPreferences,
      profile,
    ),
    settings,
  );
  const session = createMatchAssessmentSession({
    profile,
    searchPreferences: preferences,
    calculate: createMatchAssessment,
  });
  const reassess = <T extends SavedJob>(job: T): T => {
    const next = session.assessPersisted(job, job.matchAssessment);
    return sameAssessment(next, job.matchAssessment)
      ? job
      : { ...job, matchAssessment: next };
  };
  const [savedJobs, discovery] = await Promise.all([
    ctx.repository.readSavedJobsProjection(),
    ctx.repository.readDiscoveryDisplayProjection(),
  ]);
  const changedIds = savedJobs
    .filter((job) => reassess(job) !== job)
    .map((job) => job.id);
  if (changedIds.length > 0)
    await ctx.repository.commitSavedJobDelta({
      updateJobIds: changedIds,
      update: reassess,
    });
  if (!discovery.pendingDiscoveryJobs.some((job) => reassess(job) !== job))
    return;
  await ctx.persistDiscoveryState((current) => {
    const pendingDiscoveryJobs = current.pendingDiscoveryJobs.map(reassess);
    return pendingDiscoveryJobs.every(
      (job, index) => job === current.pendingDiscoveryJobs[index],
    )
      ? current
      : { ...current, pendingDiscoveryJobs };
  });
}
