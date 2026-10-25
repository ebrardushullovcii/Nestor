import type { JudgeJobFitsInput } from "@nestor/ai-providers";
import { JobDiscoveryTargetSchema } from "@nestor/contracts";
import { afterEach, expect, test, vi } from "vitest";
import {
  createAiClient,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

afterEach(() => vi.restoreAllMocks());

function seedWithBoard() {
  const seed = createSeed();
  seed.savedJobs = [];
  seed.discovery.pendingDiscoveryJobs = [];
  seed.discovery.discoveryLedger = [];
  seed.settings.discoveryOnly = false;
  seed.searchPreferences.targetRoles = ["Product Designer"];
  seed.searchPreferences.locations = ["Berlin, Germany"];
  seed.searchPreferences.discovery.collectOnlyHardCriteriaMatches = false;
  seed.searchPreferences.discovery.targets = [
    JobDiscoveryTargetSchema.parse({
      id: "fit",
      label: "Fit fixture",
      startingUrl: "https://job-boards.greenhouse.io/fit-fixture",
    }),
  ];
  const rows = [
    { id: 1, title: "Product Designer", location: "Berlin, DE" },
    { id: 2, title: "Backend Engineer", location: "Berlin, DE" },
  ].map((row) => ({
    ...row,
    location: { name: row.location },
    absolute_url: `https://job-boards.greenhouse.io/fit-fixture/jobs/${row.id}`,
    content:
      "Work with product managers and engineers on a collaborative planning product.",
    updated_at: "2026-09-25T09:00:00.000Z",
  }));
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(Response.json({ jobs: rows })),
  );
  return seed;
}

test("a search has the model judge the jobs it found, and its verdict stands", async () => {
  const judgeJobFits = vi.fn((input: JudgeJobFitsInput) =>
    Promise.resolve(
      input.jobs.map(({ jobId, posting }) =>
        posting.title === "Product Designer"
          ? {
              jobId,
              score: 86,
              recommendation: "strong_fit" as const,
              role: "exact" as const,
              roleExplanation: "This is the design work you are looking for.",
              preferences: "aligned" as const,
              preferencesExplanation: "Berlin, Germany is one of your places.",
              locationReach: "in_area" as const,
              reasons: ["Berlin, Germany is one of your places"],
              gaps: [],
              listingClosed: false,
              listingClosedEvidence: null,
            }
          : {
              jobId,
              score: 12,
              recommendation: "skip" as const,
              role: "conflict" as const,
              roleExplanation: "This is engineering work, not design.",
              preferences: "aligned" as const,
              preferencesExplanation: null,
              locationReach: "in_area" as const,
              reasons: [],
              gaps: ["A different occupation"],
              listingClosed: false,
              listingClosedEvidence: null,
            },
      ),
    ),
  );
  const { workspaceService, repository } = createWorkspaceServiceHarness({
    seed: seedWithBoard(),
    aiClient: { ...createAiClient(), judgeJobFits },
  });

  await workspaceService.runAgentDiscovery();

  expect(judgeJobFits).toHaveBeenCalledTimes(1);
  const asked = judgeJobFits.mock.calls[0]![0];
  expect(asked.searchPreferences.targetRoles).toEqual(["Product Designer"]);
  expect(asked.jobs.map((job) => job.posting.title).sort()).toEqual([
    "Backend Engineer",
    "Product Designer",
  ]);
  const jobs = await repository.listSavedJobs();
  const designer = jobs.find((job) => job.title === "Product Designer")!;
  const engineer = jobs.find((job) => job.title === "Backend Engineer")!;
  expect(designer.matchAssessment).toMatchObject({
    score: 86,
    recommendation: "strong_fit",
    locationReach: "in_area",
    reasons: ["Berlin, Germany is one of your places"],
    judgment: { source: "batch", score: 86 },
  });
  expect(engineer.matchAssessment).toMatchObject({
    score: 12,
    recommendation: "skip",
    recommendationRationale: "A different occupation",
  });

  // Nothing changed, so a second search does not ask again.
  await workspaceService.runAgentDiscovery();
  expect(judgeJobFits).toHaveBeenCalledTimes(1);
  expect(
    (await repository.listSavedJobs()).find(
      (job) => job.title === "Product Designer",
    )?.matchAssessment.score,
  ).toBe(86);
}, 30_000);

test("jobs the model could not judge say so and are asked about next time", async () => {
  const judgeJobFits = vi
    .fn<(input: JudgeJobFitsInput) => Promise<never[]>>()
    .mockRejectedValueOnce(new Error("model unavailable"))
    .mockResolvedValue([]);
  const { workspaceService, repository } = createWorkspaceServiceHarness({
    seed: seedWithBoard(),
    aiClient: { ...createAiClient(), judgeJobFits },
  });

  await workspaceService.runAgentDiscovery();
  const jobs = await repository.listSavedJobs();
  expect(jobs).toHaveLength(2);
  expect(jobs.every((job) => !job.matchAssessment.judgment)).toBe(true);
  expect(
    jobs.every((job) =>
      job.matchAssessment.recommendationRationale.startsWith("Not judged yet"),
    ),
  ).toBe(true);

  // The first search asked once (the request layer does the retrying); the
  // second search asks again for the jobs still unjudged.
  await workspaceService.runAgentDiscovery();
  expect(judgeJobFits).toHaveBeenCalledTimes(2);
}, 30_000);

test("with a result limit, the model's best fits are kept rather than the newest jobs", async () => {
  const seed = createSeed();
  seed.savedJobs = [];
  seed.discovery.pendingDiscoveryJobs = [];
  seed.discovery.discoveryLedger = [];
  seed.settings.discoveryOnly = false;
  seed.searchPreferences.targetRoles = ["Product Designer"];
  seed.searchPreferences.locations = ["Berlin, Germany"];
  seed.searchPreferences.discovery.collectOnlyHardCriteriaMatches = false;
  seed.searchPreferences.discovery.runJobBudget = 2;
  seed.searchPreferences.discovery.targets = [
    JobDiscoveryTargetSchema.parse({
      id: "limited",
      label: "Limited fixture",
      startingUrl: "https://job-boards.greenhouse.io/limited-fixture",
    }),
  ];
  // The two engineering roles are the newest; the design roles fit.
  const rows = [
    {
      id: 1,
      title: "Backend Engineer",
      updated_at: "2026-09-29T09:00:00.000Z",
    },
    {
      id: 2,
      title: "Platform Engineer",
      updated_at: "2026-09-28T09:00:00.000Z",
    },
    {
      id: 3,
      title: "Product Designer",
      updated_at: "2026-09-20T09:00:00.000Z",
    },
    {
      id: 4,
      title: "Senior Product Designer",
      updated_at: "2026-09-19T09:00:00.000Z",
    },
  ].map((row) => ({
    ...row,
    location: { name: "Berlin, Germany" },
    absolute_url: `https://job-boards.greenhouse.io/limited-fixture/jobs/${row.id}`,
    content: "Work with a product team on a collaborative planning product.",
  }));
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(Response.json({ jobs: rows })),
  );
  const judgeJobFits = vi.fn((input: JudgeJobFitsInput) =>
    Promise.resolve(
      input.jobs.map(({ jobId, posting }) => {
        const fits = posting.title.includes("Designer");
        return {
          jobId,
          score: fits ? 85 : 10,
          recommendation: fits ? ("strong_fit" as const) : ("skip" as const),
          role: fits ? ("exact" as const) : ("conflict" as const),
          roleExplanation: null,
          preferences: "aligned" as const,
          preferencesExplanation: null,
          locationReach: "in_area" as const,
          reasons: [],
          gaps: [],
          listingClosed: false,
          listingClosedEvidence: null,
        };
      }),
    ),
  );
  const { workspaceService, repository } = createWorkspaceServiceHarness({
    seed,
    aiClient: { ...createAiClient(), judgeJobFits },
  });

  await workspaceService.runAgentDiscovery();

  const kept = (await repository.listSavedJobs()).map((job) => job.title);
  expect(kept.sort()).toEqual(["Product Designer", "Senior Product Designer"]);
  // The verdicts that chose them are kept; they are not asked for again.
  expect(judgeJobFits).toHaveBeenCalledTimes(1);
}, 30_000);
