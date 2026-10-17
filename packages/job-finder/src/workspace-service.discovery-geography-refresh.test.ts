import { afterEach, expect, test, vi } from "vitest";
import { readPlanAssessment } from "./internal/plan-assessment";
import type { JudgeJobFitsInput } from "@nestor/ai-providers";
import { JobDiscoveryTargetSchema } from "@nestor/contracts";
import {
  createAiClient,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

/**
 * Stands in for the model: a remote job reaches the person only while they
 * count remote jobs as any location; Berlin is in their area either way.
 */
function placeJudge() {
  return vi.fn((input: JudgeJobFitsInput) => {
    const remoteCounts =
      input.searchPreferences.discovery.remoteCountsAsAnyLocation !== false;
    return Promise.resolve(
      input.jobs.map(({ jobId, posting }) => {
        const inArea = posting.location === "Berlin, Germany";
        const reach = inArea
          ? ("in_area" as const)
          : remoteCounts && posting.location.startsWith("Remote")
            ? ("remote_preferred" as const)
            : ("outside_area" as const);
        return {
          jobId,
          score: reach === "outside_area" ? 30 : 80,
          recommendation:
            reach === "outside_area"
              ? ("review_before_applying" as const)
              : ("strong_fit" as const),
          role: "exact" as const,
          roleExplanation: null,
          preferences: "aligned" as const,
          preferencesExplanation: null,
          locationReach: reach,
          reasons: [],
          gaps: [],
          listingClosed: false,
          listingClosedEvidence: null,
        };
      }),
    );
  });
}

afterEach(() => vi.restoreAllMocks());

test("changing remote geography has the model judge existing feed jobs again without duplicating them", async () => {
  const seed = createSeed();
  seed.savedJobs = [];
  seed.discovery.pendingDiscoveryJobs = [];
  seed.discovery.discoveryLedger = [];
  seed.settings.discoveryOnly = false;
  seed.searchPreferences.targetRoles = ["Product Designer"];
  seed.searchPreferences.locations = ["Berlin, Germany"];
  seed.searchPreferences.workModes = [];
  seed.searchPreferences.companyWhitelist = [];
  seed.searchPreferences.companyBlacklist = [];
  seed.searchPreferences.excludedLocations = [];
  seed.searchPreferences.discovery.collectOnlyHardCriteriaMatches = false;
  seed.searchPreferences.discovery.targets = [
    JobDiscoveryTargetSchema.parse({
      id: "geography",
      label: "Geography fixture",
      startingUrl: "https://job-boards.greenhouse.io/geography-fixture",
    }),
  ];
  const rows = [
    { id: 1, location: "Berlin, Germany" },
    { id: 2, location: "Paris, France" },
    { id: 3, location: "Remote, Europe" },
    { id: 4, location: "Remote, US" },
    { id: 5, location: "Remote, Worldwide" },
    { id: 6, location: "Location not stated" },
  ].map((row) => ({
    ...row,
    title: "Product Designer",
    location: { name: row.location },
    absolute_url: `https://job-boards.greenhouse.io/geography-fixture/jobs/${row.id}`,
    content:
      "Design accessible product interfaces and prototypes using Figma. Collaborate with product managers and engineers.",
    updated_at: "2026-09-25T09:00:00.000Z",
  }));
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(Response.json({ jobs: rows })),
  );
  const judgeJobFits = placeJudge();
  const { workspaceService, repository } = createWorkspaceServiceHarness({
    seed,
    aiClient: { ...createAiClient(), judgeJobFits },
  });
  const setRemote = async (remoteCountsAsAnyLocation: boolean) => {
    const w = await workspaceService.getWorkspaceSnapshot();
    await workspaceService.updateAiBehavior({
      aiBehavior: {
        ...w.settings.aiBehavior!,
        jobSearch: { selectivity: "balanced", remoteCountsAsAnyLocation },
      },
    });
  };
  await setRemote(true);
  await workspaceService.runAgentDiscovery();
  const planId = (await workspaceService.getWorkspaceSnapshot())
    .activeCampaignId;
  const before = (await repository.listSavedJobs()).map((job) =>
    readPlanAssessment(job, planId),
  );
  expect(before).toHaveLength(6);
  const byLocation = (jobs: typeof before, location: string) =>
    jobs.find((job) => job.location === location)!;
  await setRemote(false);
  const repeat = await workspaceService.runAgentDiscovery();
  const after = (await repository.listSavedJobs()).map((job) =>
    readPlanAssessment(job, planId),
  );
  expect(after.map((job) => job.id).sort()).toEqual(
    before.map((job) => job.id).sort(),
  );
  expect(repeat.recentDiscoveryRuns[0]?.summary.jobsPersisted).toBe(0);
  // The changed goal made every verdict stale, so the model was asked again.
  expect(judgeJobFits).toHaveBeenCalledTimes(2);
  for (const location of ["Remote, Europe", "Remote, Worldwide"]) {
    expect(byLocation(before, location).matchAssessment.locationReach).toBe(
      "remote_preferred",
    );
    expect(byLocation(after, location).matchAssessment.locationReach).toBe(
      "outside_area",
    );
  }
  expect(byLocation(after, "Berlin, Germany").matchAssessment.score).toBe(
    byLocation(before, "Berlin, Germany").matchAssessment.score,
  );
  expect(
    after.every(
      (job) =>
        job.postedAt === null &&
        job.providerUpdatedAt === "2026-09-25T09:00:00.000Z",
    ),
  ).toBe(true);
}, 30_000);
