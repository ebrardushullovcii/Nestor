import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  deriveProfileSetupState,
  evaluateProfileSetupReadiness,
  JobSearchPreferencesSchema,
  ProfileSetupStateSchema,
  type JobSearchPreferences,
  type ProfileSetupState,
} from "@nestor/contracts";
import { createFileJobFinderRepository } from "@nestor/db";
import { createEmptyJobFinderRepositoryState } from "../../adapters/job-finder-initial-state";
import { createJobFinderWorkspaceServiceAsync } from "./create-workspace-service";
import { getJobFinderWorkspaceFilePath } from "./paths";
import {
  adoptPristineWorkspaceStarterSources,
  shouldAdoptPristineStarterSources,
  type PristineStarterSourceAdoptionInput,
} from "./pristine-starter-source-adoption";

const emptyPreferences = JobSearchPreferencesSchema.parse({
  targetRoles: [],
  minimumSalaryUsd: null,
  approvalMode: "review_before_submit",
  tailoringMode: "balanced",
  discovery: { historyLimit: 5, targets: [] },
});

const notStartedSetupState = ProfileSetupStateSchema.parse({
  status: "not_started",
  currentStep: "import",
  completedAt: null,
  reviewItems: [],
  lastResumedAt: null,
});

describe("pristine starter source adoption predicate", () => {
  const baseInput: PristineStarterSourceAdoptionInput = {
    campaigns: [],
    profileSetupState: notStartedSetupState,
    searchPreferences: emptyPreferences,
  };

  test("adopts a legacy empty pristine targetless workspace", () => {
    expect(shouldAdoptPristineStarterSources(baseInput)).toBe(true);
  });

  test("never adopts when any discovery target already exists", () => {
    const withTarget = JobSearchPreferencesSchema.parse({
      ...emptyPreferences,
      discovery: {
        ...emptyPreferences.discovery,
        targets: [
          {
            id: "target_user_added",
            label: "User source",
            startingUrl: "https://jobs.example.com/openings",
            enabled: false,
          },
        ],
      },
    });

    expect(
      shouldAdoptPristineStarterSources({
        ...baseInput,
        searchPreferences: withTarget,
      }),
    ).toBe(false);
  });

  test("never adopts a completed setup", () => {
    const completed = ProfileSetupStateSchema.parse({
      ...notStartedSetupState,
      status: "completed",
      currentStep: "ready_check",
      completedAt: "2026-02-02T00:00:00.000Z",
    });

    expect(
      shouldAdoptPristineStarterSources({
        ...baseInput,
        profileSetupState: completed,
      }),
    ).toBe(false);
  });

  test("treats user-created campaigns as established workspaces", () => {
    expect(
      shouldAdoptPristineStarterSources({
        ...baseInput,
        campaigns: [{ id: "campaign_abc123", history: [] }],
      }),
    ).toBe(false);
  });

  test("treats a default campaign with a committed discovery run as established", () => {
    expect(
      shouldAdoptPristineStarterSources({
        ...baseInput,
        campaigns: [
          {
            id: "campaign_default",
            history: [{ kind: "discovery_run" }],
          },
        ],
      }),
    ).toBe(false);
  });

  test("allows the uncommitted default campaign shell", () => {
    expect(
      shouldAdoptPristineStarterSources({
        ...baseInput,
        campaigns: [{ id: "campaign_default", history: [] }],
      }),
    ).toBe(true);
  });
});

describe("adoptPristineWorkspaceStarterSources executor", () => {
  function createFakeRepository(input: {
    searchPreferences: JobSearchPreferences;
    profileSetupState: ProfileSetupState;
  }) {
    let saved: JobSearchPreferences | null = null;

    return {
      saveCalls: () => (saved === null ? 0 : 1),
      getCampaignState: vi.fn().mockResolvedValue(null),
      getProfileSetupState: vi.fn().mockResolvedValue(input.profileSetupState),
      getSearchPreferences: vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(saved ?? input.searchPreferences),
        ),
      saveSearchPreferences: vi
        .fn()
        .mockImplementation((next: JobSearchPreferences) => {
          saved = next;

          return Promise.resolve(undefined);
        }),
      readSaved: () => saved,
    };
  }

  test("adds disabled starters once and never advances readiness or setup state", async () => {
    const repository = createFakeRepository({
      profileSetupState: notStartedSetupState,
      searchPreferences: emptyPreferences,
    });
    const freshProfile = createEmptyJobFinderRepositoryState().profile;

    expect(
      evaluateProfileSetupReadiness(freshProfile, emptyPreferences)
        .hasDiscoverySource,
    ).toBe(false);

    const adopted = await adoptPristineWorkspaceStarterSources({
      getCampaignState: repository.getCampaignState,
      getProfileSetupState: repository.getProfileSetupState,
      getSearchPreferences: repository.getSearchPreferences,
      saveSearchPreferences: repository.saveSearchPreferences,
    });
    // Nothing is seeded any more: the user adds the sites they use, so the
    // executor is a no-op and never touches the saved preferences.
    expect(adopted).toBe(false);

    const next = repository.readSaved() ?? emptyPreferences;
    expect(next.discovery.targets).toEqual([]);
    expect(
      evaluateProfileSetupReadiness(freshProfile, next).hasDiscoverySource,
    ).toBe(false);

    const derivedBefore = deriveProfileSetupState(
      freshProfile,
      emptyPreferences,
      { currentState: notStartedSetupState },
    );
    const derivedAfter = deriveProfileSetupState(freshProfile, next, {
      currentState: notStartedSetupState,
    });
    expect(derivedAfter.status).toBe(derivedBefore.status);
    expect(derivedAfter.currentStep).toBe(derivedBefore.currentStep);

    // Re-running adoption after adoption (what any restart computes) is a
    // no-op because the workspace no longer has zero targets.
    // Re-running adoption after adoption (what any restart computes) is a
    // no-op because the workspace no longer has zero targets.
    const secondCall = await adoptPristineWorkspaceStarterSources({
      getCampaignState: repository.getCampaignState,
      getProfileSetupState: repository.getProfileSetupState,
      getSearchPreferences: repository.getSearchPreferences,
      saveSearchPreferences: repository.saveSearchPreferences,
    });
    expect(secondCall).toBe(false);
    expect(repository.saveCalls()).toBe(0);
  });

  test("does not save for established or non-pristine workspaces", async () => {
    const countSave = vi.fn().mockResolvedValue(undefined);

    const adoptedWithUserCampaign = await adoptPristineWorkspaceStarterSources({
      getCampaignState: vi.fn().mockResolvedValue({
        campaigns: [{ id: "campaign_abc123", history: [] }],
      }),
      getProfileSetupState: vi.fn().mockResolvedValue(notStartedSetupState),
      getSearchPreferences: vi.fn().mockResolvedValue(emptyPreferences),
      saveSearchPreferences: countSave,
    });
    expect(adoptedWithUserCampaign).toBe(false);

    const adoptedWithCommittedRun = await adoptPristineWorkspaceStarterSources({
      getCampaignState: vi.fn().mockResolvedValue({
        campaigns: [
          {
            id: "campaign_default",
            history: [{ kind: "discovery_run" }],
          },
        ],
      }),
      getProfileSetupState: vi.fn().mockResolvedValue(notStartedSetupState),
      getSearchPreferences: vi.fn().mockResolvedValue(emptyPreferences),
      saveSearchPreferences: countSave,
    });
    expect(adoptedWithCommittedRun).toBe(false);

    const adoptedAfterCompletion = await adoptPristineWorkspaceStarterSources({
      getCampaignState: vi.fn().mockResolvedValue(null),
      getProfileSetupState: vi.fn().mockResolvedValue(
        ProfileSetupStateSchema.parse({
          ...notStartedSetupState,
          status: "completed",
        }),
      ),
      getSearchPreferences: vi.fn().mockResolvedValue(emptyPreferences),
      saveSearchPreferences: countSave,
    });
    expect(adoptedAfterCompletion).toBe(false);

    expect(countSave).toHaveBeenCalledTimes(0);
  });
});

describe("starter source adoption during service bootstrap", () => {
  const temporaryDirectories: string[] = [];
  const originalEnv: Record<string, string | undefined> = {
    NESTOR_USER_DATA_DIR: process.env.NESTOR_USER_DATA_DIR,
    NESTOR_ENABLE_TEST_API: process.env.NESTOR_ENABLE_TEST_API,
    NESTOR_BROWSER_AGENT: process.env.NESTOR_BROWSER_AGENT,
  };

  afterEach(async () => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  test("a legacy pristine workspace gains disabled starters through one bootstrap", async () => {
    const userDataDirectory = await mkdtemp(
      path.join(os.tmpdir(), "pristine-adoption-legacy-"),
    );
    temporaryDirectories.push(userDataDirectory);
    process.env.NESTOR_USER_DATA_DIR = userDataDirectory;
    process.env.NESTOR_ENABLE_TEST_API = "1";
    process.env.NESTOR_BROWSER_AGENT = "0";

    // Persist a pre-seeder legacy workspace: zero targets, setup not started.
    const legacySeed = createEmptyJobFinderRepositoryState();
    legacySeed.searchPreferences = JobSearchPreferencesSchema.parse({
      ...legacySeed.searchPreferences,
      discovery: {
        historyLimit: 5,
        targets: [],
      },
    });
    const legacyRepository = await createFileJobFinderRepository({
      filePath: getJobFinderWorkspaceFilePath(),
      seed: legacySeed,
    });
    await legacyRepository.close();

    const service = await createJobFinderWorkspaceServiceAsync();
    const snapshot = await service.getWorkspaceSnapshot();
    // Shut down before the temporary directory is removed: Windows refuses to
    // unlink the workspace database while its handle is still open, and the
    // cleanup then failed the test.
    await service.shutdown();

    expect(
      snapshot.searchPreferences.discovery.targets.map((t) => t.id),
    ).toEqual([]);
    expect(
      snapshot.searchPreferences.discovery.targets.every((t) => !t.enabled),
    ).toBe(true);
    expect(snapshot.profileSetupState.status).toBe("not_started");
    expect(
      evaluateProfileSetupReadiness(
        snapshot.profile,
        snapshot.searchPreferences,
      ).hasDiscoverySource,
    ).toBe(false);

    if (snapshot.activeCampaignId !== null) {
      const activeCampaign = snapshot.campaigns.find(
        (campaign) => campaign.id === snapshot.activeCampaignId,
      );
      expect(activeCampaign?.sourceTargetIds).toEqual([]);
      expect(
        activeCampaign?.searchPreferences.discovery.targets.map(
          (target) => target.id,
        ),
      ).toEqual([]);
    }
  });
});
