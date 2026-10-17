import {
  createStarterJobDiscoveryTargets,
  type JobSearchCampaign,
  type JobSearchCampaignHistoryEntry,
  type JobSearchPreferences,
  type ProfileSetupState,
} from "@nestor/contracts";

/**
 * One-time adoption of disabled starter sources for legacy workspaces that
 * predate seeded first-run state: zero discovery targets and setup never
 * completed. The narrow predicate keeps every other workspace untouched, and
 * the write goes through the canonical save path so campaign preference
 * synchronization and setup-state derivation run exactly as they do for a
 * normal user edit.
 */

/** Only the campaign facts the established-workspace guard needs. */
export type AdoptionCampaignSignal = {
  history: ReadonlyArray<Pick<JobSearchCampaignHistoryEntry, "kind">>;
  id: JobSearchCampaign["id"];
};

export type PristineStarterSourceAdoptionInput = {
  campaigns: ReadonlyArray<AdoptionCampaignSignal>;
  profileSetupState: ProfileSetupState;
  searchPreferences: JobSearchPreferences;
};

/**
 * The auto-created default campaign is an adoption shell, not a deliberate
 * plan; it becomes established once it carries a committed discovery run.
 * User-created campaign ids are always random (`campaign_<uuid>`), so any
 * non-default id marks an established workspace that must not be mutated.
 */
function isUncommittedDefaultCampaign(
  campaign: AdoptionCampaignSignal,
): boolean {
  return (
    campaign.id === "campaign_default" &&
    !campaign.history.some((entry) => entry.kind === "discovery_run")
  );
}

export function shouldAdoptPristineStarterSources(
  input: PristineStarterSourceAdoptionInput,
): boolean {
  if (input.searchPreferences.discovery.targets.length > 0) {
    return false;
  }

  if (input.profileSetupState.status === "completed") {
    return false;
  }

  return input.campaigns.every(isUncommittedDefaultCampaign);
}

export async function adoptPristineWorkspaceStarterSources(input: {
  getCampaignState: () => Promise<{
    campaigns: ReadonlyArray<AdoptionCampaignSignal>;
  } | null>;
  getProfileSetupState: () => Promise<ProfileSetupState>;
  getSearchPreferences: () => Promise<JobSearchPreferences>;
  saveSearchPreferences: (next: JobSearchPreferences) => Promise<unknown>;
}): Promise<boolean> {
  const starterTargets = createStarterJobDiscoveryTargets();
  if (starterTargets.length === 0) {
    return false;
  }

  const [searchPreferences, profileSetupState, campaignState] =
    await Promise.all([
      input.getSearchPreferences(),
      input.getProfileSetupState(),
      input.getCampaignState(),
    ]);

  if (
    !shouldAdoptPristineStarterSources({
      campaigns: campaignState?.campaigns ?? [],
      profileSetupState,
      searchPreferences,
    })
  ) {
    return false;
  }

  // Starters seed disabled: readiness inputs do not change here, so the
  // canonical save path re-derives the same setup state and the active
  // default-campaign projection stays synchronized with no new target ids.
  await input.saveSearchPreferences({
    ...searchPreferences,
    discovery: {
      ...searchPreferences.discovery,
      targets: createStarterJobDiscoveryTargets(),
    },
  });

  return true;
}
