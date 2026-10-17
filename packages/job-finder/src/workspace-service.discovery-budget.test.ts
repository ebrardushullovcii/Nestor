import { afterEach, expect, test, vi } from "vitest";
import type { JudgeJobFitsInput } from "@nordri/ai-providers";
import { JobDiscoveryTargetSchema } from "@nordri/contracts";
import {
  createAiClient,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

afterEach(() => vi.restoreAllMocks());

test("a result limit judges every job found once and still judges the person's selected job", async () => {
  const seed = createSeed();
  const selected = seed.savedJobs[0]!;
  selected.personSupplied = true;
  selected.matchAssessment.judgment = null;
  selected.planAssessments = {};
  seed.savedJobs = [selected];
  seed.discovery.pendingDiscoveryJobs = [];
  seed.discovery.discoveryLedger = [];
  seed.settings.discoveryOnly = false;
  seed.searchPreferences.discovery.collectOnlyHardCriteriaMatches = false;
  seed.searchPreferences.discovery.runJobBudget = 2;
  seed.searchPreferences.discovery.targets = [
    JobDiscoveryTargetSchema.parse({
      id: "budget",
      label: "Budget fixture",
      startingUrl: "https://job-boards.greenhouse.io/budget-fixture",
    }),
  ];
  const rows = Array.from({ length: 105 }, (_, index) => ({
    id: index + 1,
    title: "Product Designer",
    location: { name: "Remote" },
    absolute_url: `https://job-boards.greenhouse.io/budget-fixture/jobs/${index + 1}`,
    content: "Design a collaborative planning product with the product team.",
  }));
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(Response.json({ jobs: rows })),
  );
  const judgeJobFits = vi.fn((input: JudgeJobFitsInput) =>
    Promise.resolve(
      input.jobs.map(({ jobId }) => ({
        jobId,
        score: 80,
        recommendation: "strong_fit" as const,
        role: "exact" as const,
        roleExplanation: null,
        preferences: "aligned" as const,
        preferencesExplanation: null,
        locationReach: "in_area" as const,
        reasons: [],
        gaps: [],
        listingClosed: false,
        listingClosedEvidence: null,
      })),
    ),
  );
  const { workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient: { ...createAiClient(), judgeJobFits },
  });

  await workspaceService.runAgentDiscovery();

  // The limit chooses among all 105 on the model's verdicts, and the
  // selected job is judged as well; nobody is asked about twice.
  const judged = judgeJobFits.mock.calls.flatMap(([input]) => input.jobs);
  expect(judged).toHaveLength(106);
  expect(judged.filter((job) => job.jobId === selected.id)).toHaveLength(1);
  expect(new Set(judged.map((job) => job.jobId)).size).toBe(106);
});
