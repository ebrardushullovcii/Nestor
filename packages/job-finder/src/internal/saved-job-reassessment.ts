import type { MatchAssessment, SavedJob } from "@nestor/contracts";

import { createMatchAssessmentSession } from "./match-assessment-session";
import { createMatchAssessment } from "./matching";
import { enrichSearchPreferencesFromProfile } from "./workspace-helpers";
import type { WorkspaceServiceContext } from "./workspace-service-context";

/** A listing getter may parse a large body; yield after each job. */
const JOBS_PER_TURN = 1;
/** Changed jobs written per transaction. */
const JOBS_PER_COMMIT = 1;

// Kept from load time: a yield is a real turn of the event loop even where
// a test has replaced the timers.
const realSetImmediate = globalThis.setImmediate;
const nextTurn = () =>
  new Promise<void>((resolve) => {
    realSetImmediate(resolve);
  });

/**
 * Whether a recalculated assessment says what the stored one says. One that
 * differs only in the stamp of the profile and goals it was made for is the
 * same: a stored model verdict already keeps its old stamp after an edit, and
 * a rule score the edit leaves unchanged now does too. Restamping them meant
 * rewriting every saved job (3,640 rows, ten seconds and more) for a headline
 * edit; the next change checks them again. An assessment with no stamp at all
 * is not bound to any profile and is shown without its score, so it is still
 * written to gain one.
 */
function sameAssessment(stored: MatchAssessment, next: MatchAssessment) {
  if (stored === next) return true;
  const storedStamp = stored.contextFingerprint;
  const restamped =
    storedStamp === next.contextFingerprint ||
    typeof storedStamp !== "string" ||
    storedStamp.trim().length === 0
      ? next
      : { ...next, contextFingerprint: storedStamp };
  return JSON.stringify(stored) === JSON.stringify(restamped);
}

/**
 * Re-scores saved and staged jobs against the profile and search goals as
 * they are now, without searching any site again. Changing a goal (Remote,
 * a country, a role) used to leave every saved score and explanation as it
 * was until the next search. Assessments whose profile and listing are
 * unchanged are reused, so this is cheap when nothing that matters changed.
 *
 * The work yields to the event loop between slices and commits in small
 * transactions, so a large workspace never holds the app still while it
 * runs. Returns whether any stored job changed.
 */
export async function reassessSavedJobs(
  ctx: Pick<
    WorkspaceServiceContext,
    "repository" | "persistDiscoveryState" | "getActiveCampaignId"
  > &
    Partial<Pick<WorkspaceServiceContext, "isWorkspaceClosing">>,
): Promise<boolean> {
  const closing = () => ctx.isWorkspaceClosing?.() === true;
  const [profile, searchPreferences, campaignState] = await Promise.all([
    ctx.repository.getProfile(),
    ctx.repository.getSearchPreferences(),
    ctx.repository.getCampaignState(),
  ]);
  const activeCampaignId = await ctx.getActiveCampaignId();
  const activeCampaign = campaignState?.campaigns.find(
    (campaign) => campaign.id === activeCampaignId,
  );
  const preferences = enrichSearchPreferencesFromProfile(
    activeCampaign?.searchPreferences ?? searchPreferences,
    profile,
  );
  const session = createMatchAssessmentSession({
    profile,
    searchPreferences: preferences,
    calculate: createMatchAssessment,
  });
  const reassess = <T extends SavedJob>(job: T): T => {
    const next = session.assessPersisted(job, job.matchAssessment);
    return sameAssessment(job.matchAssessment, next)
      ? job
      : { ...job, matchAssessment: next };
  };
  const savedJobs = await ctx.repository.readSavedJobsProjection();

  const changedIds: string[] = [];
  for (let start = 0; start < savedJobs.length; start += JOBS_PER_TURN) {
    if (start > 0) await nextTurn();
    if (closing()) return false;
    for (const job of savedJobs.slice(start, start + JOBS_PER_TURN)) {
      if (reassess(job) !== job) changedIds.push(job.id);
    }
  }
  for (let start = 0; start < changedIds.length; start += JOBS_PER_COMMIT) {
    await nextTurn();
    if (closing()) return true;
    await ctx.repository.commitSavedJobDelta({
      updateJobIds: changedIds.slice(start, start + JOBS_PER_COMMIT),
      update: reassess,
    });
  }

  return changedIds.length > 0;
}
