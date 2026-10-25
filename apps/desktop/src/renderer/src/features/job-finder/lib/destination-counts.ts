import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import {
  isDiscoveryAlsoFoundResult,
  isDiscoveryDecidedJob,
} from "../screens/discovery/discovery-result-groups";
import { countWorkspaceNeedsYouItems } from "./needs-you-count";

/**
 * One exported owner per destination badge, named for the population it counts.
 *
 * The shell used to derive every badge inline with a private
 * `.filter(...).length`, so four badges counted a different population than the
 * page they pointed at and nothing could be tested against the page. Each
 * function here is the single source for its number; the shell renders it and
 * screens read the same function rather than re-deriving one.
 *
 * A count returned here is the raw population. `toDestinationBadgeCount` owns
 * the one zero rule: a badge never renders at 0.
 */

/**
 * Jobs belong to the active search plan when one is selected. With no plan the
 * whole discovery inventory is in scope, which is what the routes show too.
 */
export function selectCampaignJobIds(
  workspace: JobFinderRendererWorkspaceSnapshot,
): ReadonlySet<string> {
  const activeCampaign = workspace.campaigns?.find(
    (campaign) => campaign.id === workspace.activeCampaignId,
  );

  return new Set(
    activeCampaign?.jobIds ??
      (workspace.discoveryJobs ?? []).map((job) => job.id),
  );
}

/**
 * The rows Find jobs lists by default: the recommended band plus the
 * title-only band. The weaker and clearly mismatched rows stay out, because
 * including them made the badge oversell a search the app had already scored
 * below the user's targets.
 */
export function countDiscoveryVisibleJobs(
  workspace: JobFinderRendererWorkspaceSnapshot,
  campaignJobIds: ReadonlySet<string> = selectCampaignJobIds(workspace),
): number {
  // Exactly the rows Find jobs lists by default: every kept job the person
  // has not hidden or decided on, minus the weaker matches that sit behind
  // "Show weaker matches". The badge used to count those too, so Home and the
  // sidebar said 10 beside a page that said 9.
  return listFindJobsPool(workspace, campaignJobIds).filter(
    (job) => !isDiscoveryAlsoFoundResult(job),
  ).length;
}

/** Weaker matches Find jobs keeps behind "Show weaker matches". */
export function countDiscoveryWeakerJobs(
  workspace: JobFinderRendererWorkspaceSnapshot,
  campaignJobIds: ReadonlySet<string> = selectCampaignJobIds(workspace),
): number {
  return listFindJobsPool(workspace, campaignJobIds).filter(
    isDiscoveryAlsoFoundResult,
  ).length;
}

/** The plan's jobs still waiting on a decision: not hidden, not shortlisted. */
function listFindJobsPool(
  workspace: JobFinderRendererWorkspaceSnapshot,
  campaignJobIds: ReadonlySet<string>,
) {
  const shortlistedJobIds = new Set(
    (workspace.reviewQueue ?? []).map((item) => item.jobId),
  );
  return (workspace.discoveryJobs ?? []).filter(
    (job) =>
      campaignJobIds.has(job.id) &&
      !job.discoveryFeedback &&
      !isDiscoveryDecidedJob(job, shortlistedJobIds),
  );
}

export function countShortlistedJobs(
  workspace: JobFinderRendererWorkspaceSnapshot,
  campaignJobIds: ReadonlySet<string> = selectCampaignJobIds(workspace),
): number {
  return (workspace.reviewQueue ?? []).filter((item) =>
    campaignJobIds.has(item.jobId),
  ).length;
}

export function countApplicationRecords(
  workspace: JobFinderRendererWorkspaceSnapshot,
  campaignJobIds: ReadonlySet<string> = selectCampaignJobIds(workspace),
): number {
  return (workspace.applicationRecords ?? []).filter((record) =>
    campaignJobIds.has(record.jobId),
  ).length;
}

export function countNeedsYou(
  workspace: JobFinderRendererWorkspaceSnapshot,
): number {
  return countWorkspaceNeedsYouItems(workspace);
}

/**
 * The one zero rule for every destination badge: a count of 0 renders nothing.
 * A grey permanent "0" beside a destination name says "nothing is happening"
 * in the loudest available place.
 */
export function toDestinationBadgeCount(count: number): number | null {
  return count > 0 ? count : null;
}
