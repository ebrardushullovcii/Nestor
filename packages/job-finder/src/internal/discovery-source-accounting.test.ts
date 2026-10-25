import { expect, it, vi } from "vitest";
import type { JudgeJobFitsInput } from "@nestor/ai-providers";
import {
  DiscoveryRunResultSchema,
  JobPostingSchema,
  SaveJobSearchCampaignInputSchema,
  JobSearchCampaignCollectionSchema,
  SavedJobSchema,
} from "@nestor/contracts";
import {
  createSeed,
  createAgentAiClient,
  createAgentBrowserRuntime,
  createWorkspaceServiceHarness,
} from "../workspace-service.test-support";
import { withSavedJobSearchBehavior } from "./job-search-behavior";
import { createMatchAssessmentSession } from "./match-assessment-session";
import { createMatchAssessment } from "./matching";
import { enrichSearchPreferencesFromProfile } from "./workspace-helpers";

function makeWorld(
  extra: Partial<Parameters<typeof createWorkspaceServiceHarness>[0]> = {},
) {
  const seed = createSeed();
  seed.savedJobs = [];
  seed.discovery.pendingDiscoveryJobs = [];
  seed.discovery.discoveryLedger = [];
  seed.searchPreferences.companyWhitelist = [];
  seed.searchPreferences.companyBlacklist = [];
  seed.searchPreferences.excludedLocations = [];
  seed.searchPreferences.discovery.collectOnlyHardCriteriaMatches = false;
  seed.searchPreferences.discovery.targets = [
    {
      ...seed.searchPreferences.discovery.targets[0]!,
      id: "board",
      label: "Example board",
      startingUrl: "https://jobs.example.test",
      enabled: true,
    },
  ];
  const template = createSeed().savedJobs[0]!;
  const posting = JobPostingSchema.parse({
    ...template,
    source: "target_site",
    sourceJobId: "one",
    canonicalUrl: "https://jobs.example.test/one",
    producingPageUrl: "https://jobs.example.test",
    title: "Product designer",
    company: "Synthetic employer",
  });
  const judge = vi.fn((input: JudgeJobFitsInput) =>
    Promise.resolve(
      input.jobs.map(({ jobId }) => ({
        jobId,
        score: input.searchPreferences.targetRoles.includes("Warehouse lead")
          ? 20
          : 90,
        recommendation: input.searchPreferences.targetRoles.includes(
          "Warehouse lead",
        )
          ? ("skip" as const)
          : ("strong_fit" as const),
        role: input.searchPreferences.targetRoles.includes("Warehouse lead")
          ? ("conflict" as const)
          : ("exact" as const),
        roleExplanation: "Judged against this plan's own roles",
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
  const runtime = {
    ...createAgentBrowserRuntime([]),
    runAgentDiscovery: vi.fn((source: typeof posting.source) =>
      Promise.resolve(
        DiscoveryRunResultSchema.parse({
          source,
          startedAt: "2026-10-05T10:00:00.000Z",
          completedAt: "2026-10-05T10:00:01.000Z",
          querySummary: "Example",
          warning: null,
          jobs: [
            posting,
            {
              ...posting,
              sourceJobId: "reject",
              canonicalUrl: "https://jobs.example.test/reject",
              title: "Unrelated role",
              searchRejection: {
                category: "role",
                reason: "This job is outside your roles.",
              },
            },
          ],
          agentMetadata: { pagesCovered: 2, duplicateListings: 1 },
        }),
      ),
    ),
  };
  return {
    ...createWorkspaceServiceHarness({
      seed,
      ...extra,
      browserRuntime: runtime,
      aiClient: { ...createAgentAiClient(), judgeJobFits: judge },
    }),
    judge,
    runtime,
  };
}
it("persists an exclusion reason and reconciles a populated source, including browser duplicates", async () => {
  const world = makeWorld();
  await world.workspaceService.runDiscoveryForTarget(
    "board",
    () => undefined,
    new AbortController().signal,
  );
  const run = (await world.repository.getDiscoveryState()).recentRuns.at(-1)!;
  const source = run.targetExecutions[0]!;
  expect(source).toMatchObject({
    jobsInspected: 3,
    rejectedListings: [
      expect.objectContaining({
        category: "role",
        reason: "This job is outside your roles.",
      }),
    ],
    pagesCovered: 2,
    duplicatesMerged: 1,
  });
  const report = run.summary.report!;
  expect(report.found).toBe(
    report.saved! + report.duplicates! + report.rejected! + report.deferred!,
  );
  expect(report.found).toBe(3);
  expect(report.new).toBeLessThanOrEqual(report.saved!);
});
it("rechecks a shared job for each plan and keeps the first plan's model verdict", async () => {
  const world = makeWorld();
  const before = await world.workspaceService.getWorkspaceSnapshot();
  const first = before.campaigns.find(
    (plan) => plan.id === before.activeCampaignId,
  )!;
  await world.workspaceService.runCampaignNow({ campaignId: first.id });
  const state = (await world.repository.getCampaignState())!;
  const jobId = state.campaigns.find((plan) => plan.id === first.id)!
    .jobIds[0]!;
  const created = await world.workspaceService.saveCampaign(
    SaveJobSearchCampaignInputSchema.parse({
      ...first,
      id: null,
      name: "Warehouse",
      searchPreferences: {
        ...first.searchPreferences,
        targetRoles: ["Warehouse lead"],
      },
    }),
  );
  const second = created.campaigns.find((plan) => plan.name === "Warehouse")!;
  await world.repository.saveCampaignState(
    JobSearchCampaignCollectionSchema.parse({
      ...(await world.repository.getCampaignState()),
      campaigns: (await world.repository.getCampaignState())!.campaigns.map(
        (plan) => (plan.id === second.id ? { ...plan, jobIds: [jobId] } : plan),
      ),
    }),
  );
  await world.workspaceService.runCampaignNow({ campaignId: second.id });
  const final = (await world.repository.getCampaignState())!;
  expect(
    final.campaigns.find((plan) => plan.id === second.id)?.jobIds,
  ).not.toContain(jobId);
  const discovery = await world.repository.getDiscoveryState();
  const job = [
    ...(await world.repository.listSavedJobs()),
    ...discovery.pendingDiscoveryJobs,
  ].find((job) => job.id === jobId)!;
  expect(job.planAssessments?.[first.id]?.score).toBe(90);
  expect(job.planAssessments?.[second.id]?.score).toBe(20);
  expect(
    world.judge.mock.calls.some(([input]) =>
      input.searchPreferences.targetRoles.includes("Warehouse lead"),
    ),
  ).toBe(true);
});

it("keeps the plan's own verdict through a search after a profile edit until the job is judged again", async () => {
  const world = makeWorld();
  const before = await world.workspaceService.getWorkspaceSnapshot();
  const plan = before.campaigns.find(
    (entry) => entry.id === before.activeCampaignId,
  )!;
  await world.workspaceService.runCampaignNow({ campaignId: plan.id });
  const jobId = (await world.repository.getCampaignState())!.campaigns.find(
    (entry) => entry.id === plan.id,
  )!.jobIds[0]!;
  // The person edits a fact the model reads; every verdict is now out of
  // date, and this search's judging does not answer for the job.
  const profile = await world.repository.getProfile();
  await world.repository.saveProfile({
    ...profile,
    summary: `${profile.summary ?? ""} Also leads synthetic design reviews.`,
  });
  world.judge.mockImplementation(() => Promise.resolve([]));
  await world.workspaceService.runCampaignNow({ campaignId: plan.id });
  const job = (await world.repository.listSavedJobs()).find(
    (entry) => entry.id === jobId,
  )!;
  // The older verdict stands until a new one arrives, rather than the job
  // dropping back to "Not judged yet" and being bought again.
  expect(job.planAssessments?.[plan.id]?.judgment?.score).toBe(90);
});

it("attributes listings and covered pages to the observed source rather than the starting source", async () => {
  const world = makeWorld();
  const preferences = await world.repository.getSearchPreferences();
  await world.repository.saveSearchPreferences({
    ...preferences,
    discovery: {
      ...preferences.discovery,
      targets: [
        ...preferences.discovery.targets,
        {
          ...preferences.discovery.targets[0]!,
          id: "other",
          label: "Other board",
          startingUrl: "https://other.example.test",
        },
      ],
    },
  });
  const original = await world.runtime.runAgentDiscovery("target_site");
  world.runtime.runAgentDiscovery.mockResolvedValue(
    DiscoveryRunResultSchema.parse({
      ...original,
      jobs: original.jobs.map((job) => ({
        ...job,
        producingPageUrl: "https://other.example.test/jobs",
      })),
      agentMetadata: {
        pagesCovered: 2,
        coveredPageUrls: [
          "https://jobs.example.test",
          "https://other.example.test/jobs",
        ],
        duplicateListings: 1,
        duplicateListingPageUrls: ["https://other.example.test/jobs"],
      },
    }),
  );
  await world.workspaceService.runDiscoveryForTarget(
    "board",
    () => undefined,
    new AbortController().signal,
  );
  const counts = (await world.repository.getDiscoveryState()).recentRuns.at(-1)!
    .targetExecutions[0]!.sourceCounts!;
  expect(counts.find((source) => source.sourceId === "other")).toMatchObject({
    inspected: 3,
    saved: 1,
    rejected: 1,
    duplicates: 1,
    pagesCovered: 1,
  });
  expect(counts.find((source) => source.sourceId === "board")).toMatchObject({
    inspected: 0,
    pagesCovered: 1,
  });
});

it.each([false, true])(
  "keeps older-job budgets and picked-job priority when refreshing a rubric: %s",
  async (olderRubric) => {
    const seed = createSeed();
    const base = seed.savedJobs[0]!;
    const jobs = Array.from({ length: 105 }, (_, index) =>
      SavedJobSchema.parse({
        ...base,
        id: `prior-${index}`,
        source: "target_site",
        sourceJobId: `prior-${index}`,
        canonicalUrl: `https://jobs.example.test/prior-${index}`,
        title: `Product designer ${index}`,
        status: index === 63 ? "shortlisted" : "discovered",
        personSupplied: index === 64,
        detailQuality: "card_only",
        listingDetailFetch: null,
        matchAssessment: {
          ...base.matchAssessment,
          score: index === 64 ? 10 : 90,
          judgment: null,
        },
      }),
    );
    const reads: string[] = [];
    const world = makeWorld({
      fetchListingHtml: (url) => {
        reads.push(url);
        return Promise.resolve({
          status: 200,
          html: "<main>Product designer. Lead design reviews and provide a portfolio.</main>",
          finalUrl: url,
        });
      },
    });
    if (olderRubric) {
      const profile = await world.repository.getProfile();
      const session = createMatchAssessmentSession({
        profile,
        searchPreferences: withSavedJobSearchBehavior(
          enrichSearchPreferencesFromProfile(
            await world.repository.getSearchPreferences(),
            profile,
          ),
          await world.repository.getSettings(),
        ),
        calculate: createMatchAssessment,
      });
      for (const job of jobs) {
        job.matchAssessment = session.assess(job, {
          source: "batch",
          judgedAt: "2026-10-20T10:00:00Z",
          contextFingerprint: session.verdictFingerprint,
          postingFingerprint: session.remember(job, job.matchAssessment)
            .postingFingerprint,
          score: 77,
          recommendation: "review_before_applying",
          role: "exact",
          roleExplanation: null,
          preferences: "aligned",
          preferencesExplanation: null,
          locationReach: "in_area",
          reasons: [],
          gaps: [],
          summary: null,
          listingClosed: false,
          listingClosedEvidence: null,
        });
        job.matchAssessment.scorerVersion = 17;
      }
    }
    await world.repository.commitSavedJobDelta({ upserts: jobs });
    await world.workspaceService.runDiscoveryForTarget(
      "board",
      () => undefined,
      new AbortController().signal,
    );
    expect(reads.slice(0, 2)).toEqual(
      expect.arrayContaining([jobs[63]!.canonicalUrl, jobs[64]!.canonicalUrl]),
    );
    // ADR 0041 budgets, scaled to the search: older jobs the search did not
    // find are read (6 per searched source, at most 60) and judged (10 per
    // source, at most 100); the rest wait for the next search. A shortlisted
    // job goes first but shares that allowance; only the job the person
    // supplied is outside it. This one searched a single source.
    const olderUrls = new Set(
      jobs.filter((_, index) => index !== 64).map((job) => job.canonicalUrl),
    );
    expect(reads.filter((url) => olderUrls.has(url))).toHaveLength(6);
    const judgedIds = world.judge.mock.calls.flatMap(([input]) =>
      input.jobs.map((job) => job.jobId),
    );
    const priorIds = new Set(jobs.map((job) => job.id));
    const olderJudged = judgedIds.filter(
      (jobId) => priorIds.has(jobId) && jobId !== jobs[64]!.id,
    );
    expect(olderJudged.length).toBe(10);
    expect(judgedIds).toEqual(
      expect.arrayContaining([jobs[63]!.id, jobs[64]!.id]),
    );
    expect(new Set(judgedIds).size).toBe(judgedIds.length);
  },
);

it("uses the selected plan's roles when a person assesses a listing", async () => {
  const world = makeWorld({
    fetchListingHtml: (url) =>
      Promise.resolve({
        status: 200,
        html: "<main>A complete synthetic job listing</main>",
        finalUrl: url,
      }),
  });
  const before = await world.workspaceService.getWorkspaceSnapshot();
  const plan = before.campaigns.find(
    (plan) => plan.id === before.activeCampaignId,
  )!;
  await world.workspaceService.saveCampaign(
    SaveJobSearchCampaignInputSchema.parse({
      ...plan,
      searchPreferences: {
        ...plan.searchPreferences,
        targetRoles: ["Warehouse lead"],
      },
    }),
  );
  const job = SavedJobSchema.parse({
    ...createSeed().savedJobs[0]!,
    detailQuality: "card_only",
    listingDetailFetch: null,
  });
  await world.repository.commitSavedJobDelta({ upserts: [job] });
  vi.spyOn(world.aiClient, "extractJobsFromPage").mockResolvedValue([job]);
  const assess = vi.spyOn(world.aiClient, "assessJobFit").mockResolvedValue({
    score: 80,
    recommendation: "strong_fit",
    reasons: [],
    gaps: [],
    role: "exact",
    requirements: [
      {
        id: "lead",
        label: "Leadership",
        category: "experience",
        importance: "required",
        status: "supported",
        explanation: "The saved work history supports it.",
        jobEvidence: "Lead a team",
        resumeEvidence: [],
      },
    ],
  });
  await world.workspaceService.assessJobListing(job.id);
  expect(assess.mock.calls[0]?.[0].searchPreferences.targetRoles).toEqual([
    "Warehouse lead",
  ]);
  expect(
    (await world.repository.listSavedJobs()).find(
      (saved) => saved.id === job.id,
    )?.planAssessments?.[plan.id],
  ).toBeDefined();
});

it("counts the same listing on two sources as one unique job", async () => {
  const world = makeWorld();
  const original = await world.runtime.runAgentDiscovery("target_site");
  world.runtime.runAgentDiscovery.mockResolvedValue(
    DiscoveryRunResultSchema.parse({
      ...original,
      jobs: [
        ...original.jobs,
        {
          ...original.jobs[0]!,
          sourceJobId: "other-id",
          canonicalUrl: original.jobs[0]!.canonicalUrl + "?ref=other",
          producingPageUrl: "https://other.example.test/jobs",
        },
      ],
    }),
  );
  await world.workspaceService.runDiscoveryForTarget(
    "board",
    () => undefined,
    new AbortController().signal,
  );
  const report = (await world.repository.getDiscoveryState()).recentRuns.at(-1)!
    .summary.report!;
  expect(report.found).toBe(4);
  expect(report.unique).toBe(2);
  expect(report.found).toBe(
    report.saved! + report.duplicates! + report.rejected! + report.deferred!,
  );
});

it("does not invent unique counts when the agent cannot identify every inspected listing", async () => {
  const world = makeWorld();
  const original = await world.runtime.runAgentDiscovery("target_site");
  world.runtime.runAgentDiscovery.mockResolvedValue(
    DiscoveryRunResultSchema.parse({
      ...original,
      agentMetadata: {
        ...original.agentMetadata,
        deferredListingPageUrls: ["https://jobs.example.test"],
      },
    }),
  );
  await world.workspaceService.runDiscoveryForTarget(
    "board",
    () => undefined,
    new AbortController().signal,
  );
  const report = (await world.repository.getDiscoveryState()).recentRuns.at(-1)!
    .summary.report!;
  expect(report.unique).toBeNull();
  expect(report.found).toBe(
    report.saved! + report.duplicates! + report.rejected! + report.deferred!,
  );
});
