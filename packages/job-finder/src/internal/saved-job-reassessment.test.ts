import { expect, test, vi } from "vitest";
import { createWorkspaceServiceHarness } from "../workspace-service.test-support";
import { createSeed } from "../workspace-service.test-fixtures";
import { reassessSavedJobs } from "./saved-job-reassessment";
import * as matching from "./matching";

test("saved-job reassessment reads the current Settings policy for its scorer", async () => {
  const { repository } = createWorkspaceServiceHarness();
  const settings = await repository.getSettings();
  await repository.saveSettings({
    ...settings,
    aiBehavior: {
      ...settings.aiBehavior!,
      jobSearch: {
        ...settings.aiBehavior!.jobSearch,
        remoteCountsAsAnyLocation: false,
      },
    },
  });
  const calculate = vi.spyOn(matching, "createMatchAssessment");
  try {
    await reassessSavedJobs(reassessmentContext(repository));
    expect(calculate.mock.calls.length).toBeGreaterThan(0);
    expect(
      calculate.mock.calls.every(
        ([, preferences]) =>
          preferences.discovery.remoteCountsAsAnyLocation === false,
      ),
    ).toBe(true);
  } finally {
    calculate.mockRestore();
  }
});

test("unchanged goals reuse validated rows without a whole-job delta or discovery commit", async () => {
  const { repository } = createWorkspaceServiceHarness();
  const persistDiscoveryState = vi.fn(
    repository.commitDiscoveryStateUpdate.bind(repository),
  );
  const context = {
    repository,
    persistDiscoveryState,
    getActiveCampaignId: () => Promise.resolve(null),
  };
  await reassessSavedJobs(context);
  const before = await repository.listSavedJobs();
  const full = vi.spyOn(repository, "listSavedJobs");
  const delta = vi.spyOn(repository, "commitSavedJobDelta");
  const discovery = vi.spyOn(repository, "getDiscoveryState");
  persistDiscoveryState.mockClear();
  await reassessSavedJobs(context);
  expect(full).not.toHaveBeenCalled();
  expect(discovery).not.toHaveBeenCalled();
  expect(delta).not.toHaveBeenCalled();
  expect(persistDiscoveryState).not.toHaveBeenCalled();
  expect(await repository.listSavedJobs()).toEqual(before);
});

function reassessmentContext(
  repository: ReturnType<typeof createWorkspaceServiceHarness>["repository"],
) {
  return {
    repository,
    persistDiscoveryState:
      repository.commitDiscoveryStateUpdate.bind(repository),
    getActiveCampaignId: () => Promise.resolve(null),
  };
}

test("an edit that leaves every score as it was rewrites no job", async () => {
  const { repository } = createWorkspaceServiceHarness();
  const context = reassessmentContext(repository);
  await reassessSavedJobs(context);
  const before = await repository.listSavedJobs();
  await repository.saveProfile({
    ...(await repository.getProfile()),
    phone: "+44 7700 900999",
  });
  const delta = vi.spyOn(repository, "commitSavedJobDelta");

  await expect(reassessSavedJobs(context)).resolves.toBe(false);

  expect(delta).not.toHaveBeenCalled();
  expect(await repository.listSavedJobs()).toEqual(before);
});

/** A minimum pay no seeded listing meets, which moves every rule score. */
function aboveEveryListing<
  T extends {
    minimumSalaryUsd: number | null;
    compensation: { minimum: number | null };
  },
>(preferences: T): T {
  return {
    ...preferences,
    minimumSalaryUsd: 900_000,
    compensation: { ...preferences.compensation, minimum: 900_000 },
  };
}

/** The seed's jobs as a search found them, so their scores follow the goals. */
function foundJobsHarness(options: { onSavedJobsRescored?: () => void } = {}) {
  const seed = createSeed();
  return createWorkspaceServiceHarness({
    ...options,
    seed: {
      ...seed,
      savedJobs: seed.savedJobs.map((job) => ({
        ...job,
        discoveryMethod: "browser_agent" as const,
      })),
    },
  });
}

test("an edit that moves scores rewrites the jobs it moved, restamped", async () => {
  const { repository } = foundJobsHarness();
  const context = reassessmentContext(repository);
  await reassessSavedJobs(context);
  const before = await repository.listSavedJobs();
  const preferences = await repository.getSearchPreferences();
  await repository.saveSearchPreferences(aboveEveryListing(preferences));

  await expect(reassessSavedJobs(context)).resolves.toBe(true);

  const after = await repository.listSavedJobs();
  const moved = after.filter((job) => {
    const previous = before.find((candidate) => candidate.id === job.id);
    return (
      JSON.stringify({
        ...job.matchAssessment,
        contextFingerprint: previous?.matchAssessment.contextFingerprint,
      }) !== JSON.stringify(previous?.matchAssessment)
    );
  });
  expect(moved.length).toBeGreaterThan(0);
  for (const job of moved) {
    const previous = before.find((candidate) => candidate.id === job.id);
    expect(job.matchAssessment.contextFingerprint).not.toBe(
      previous?.matchAssessment.contextFingerprint,
    );
  }
});

test("a goal save answers before its rescoring and tells the host when scores changed", async () => {
  const onSavedJobsRescored = vi.fn();
  const { workspaceService } = foundJobsHarness({ onSavedJobsRescored });
  const initial = await workspaceService.getWorkspaceSnapshot();
  // Stamp the stored scores with the current goals first.
  await workspaceService.saveSearchPreferences(initial.searchPreferences);
  const stamped = await workspaceService.getWorkspaceSnapshot();
  onSavedJobsRescored.mockClear();

  const saved = await workspaceService.saveSearchPreferences(
    aboveEveryListing(stamped.searchPreferences),
  );
  expect(saved.searchPreferences.minimumSalaryUsd).toBe(900_000);

  // A canonical read waits for the rescoring the save started.
  const settled = await workspaceService.getWorkspaceSnapshot();
  expect(onSavedJobsRescored).toHaveBeenCalledOnce();
  const scores = (snapshot: typeof initial) =>
    snapshot.discoveryJobs.map((job) => [
      job.id,
      job.matchAssessment.compensationFit.state,
    ]);
  expect(scores(settled)).not.toEqual(scores(stamped));
});

test("disabling a job site keeps job assessments and does not rescore saved jobs", async () => {
  const { repository, workspaceService, jobSites } = foundJobsHarness();
  await workspaceService.getWorkspaceSnapshot();
  const commit = vi.spyOn(repository, "commitSavedJobDelta");
  const site = jobSites.list({ filter: "enabled", limit: 1 }).rows[0]!;
  const before = await repository.listSavedJobs();
  jobSites.update({ id: site.id, enabled: false });
  const settled = await workspaceService.getWorkspaceSnapshot();
  expect(await repository.listSavedJobs()).toEqual(before);
  expect(commit).not.toHaveBeenCalled();
  expect(settled.siteCounts.enabled).toBe(0);
});

test("an unstamped score is stamped even when its content stays the same", async () => {
  const { repository } = foundJobsHarness();
  const context = reassessmentContext(repository);
  await reassessSavedJobs(context);
  const [stamped] = await repository.listSavedJobs();
  await repository.commitSavedJobDelta({
    updateJobIds: [stamped!.id],
    update: (job) => ({
      ...job,
      matchAssessment: { ...job.matchAssessment, contextFingerprint: null },
    }),
  });

  await expect(reassessSavedJobs(context)).resolves.toBe(true);

  const restored = (await repository.listSavedJobs()).find(
    (job) => job.id === stamped!.id,
  );
  expect(restored?.matchAssessment).toEqual(stamped!.matchAssessment);
});
