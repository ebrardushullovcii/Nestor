import type { JudgeJobFitsInput } from "@nestor/ai-providers";
import type {
  AgentDiscoveryOptions,
  BrowserSessionRuntime,
} from "@nestor/browser-runtime";
import {
  DiscoveryRunResultSchema,
  JobPostingSchema,
  SaveJobSearchCampaignInputSchema,
  type DiscoveryActivityEvent,
} from "@nestor/contracts";
import { createFileJobFinderRepository } from "@nestor/db";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createJobFinderWorkspaceService } from "./index";
import {
  createAgentAiClient,
  createAgentBrowserRuntime,
  createDocumentManager,
  createResearchAdapter,
  createSavedJob,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

function createCollectedJob(input: {
  token: string;
  title?: string;
  description?: string;
  responsibilities?: string[];
}): ReturnType<typeof JobPostingSchema.parse> {
  return JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: `job_${input.token}`,
    discoveryMethod: "browser_agent",
    canonicalUrl: `https://example.com/job/${input.token}`,
    title: input.title ?? "Principal Designer",
    company: "Acme",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "unknown",
    easyApplyEligible: false,
    postedAt: null,
    postedAtText: null,
    discoveredAt: "2026-03-20T10:00:00.000Z",
    salaryText: null,
    summary: input.description ? "Rich grounded summary" : "Grounded summary",
    description: input.description ?? "Grounded description",
    keySkills: ["React"],
    responsibilities: input.responsibilities ?? [],
    minimumQualifications: [],
    preferredQualifications: [],
    seniority: null,
    employmentType: null,
    department: null,
    team: null,
    employerWebsiteUrl: null,
    employerDomain: null,
    benefits: [],
  });
}

type RuntimeCheckpointInput = Parameters<
  NonNullable<AgentDiscoveryOptions["onCheckpoint"]>
>[0];

async function emitRuntimeCheckpoint(
  options: Pick<AgentDiscoveryOptions, "onCheckpoint">,
  checkpoint: RuntimeCheckpointInput,
): Promise<void> {
  const result = options.onCheckpoint?.(checkpoint);
  if (result) {
    await result;
  }
}

function createEmptyPhaseEvidence() {
  return {
    warnings: [],
    visibleControls: [],
    successfulInteractions: [],
    routeSignals: [],
    attemptedControls: [],
    visualFindings: [],
  };
}

function createIncrementalRuntime(input: {
  onStarted?: (options: AgentDiscoveryOptions) => Promise<void>;
  onCheckpointSaved?: (revision: number) => Promise<void>;
  checkpoints: Array<ReturnType<typeof JobPostingSchema.parse>[]>;
  finalJobs: ReturnType<typeof JobPostingSchema.parse>[];
  failAfterCheckpoints?: boolean;
  agentMetadata?: { pagesCovered: number; coveredPageUrls?: string[] };
}): BrowserSessionRuntime {
  return {
    ...createAgentBrowserRuntime([]),
    async runAgentDiscovery(source, options) {
      await input.onStarted?.(options);

      let revision = 0;
      const seen = new Set<string>();
      for (const collectedJobs of input.checkpoints) {
        for (const job of collectedJobs) {
          seen.add(job.sourceJobId);
        }
        await emitRuntimeCheckpoint(options, {
          revision: (revision += 1),
          savedAt: "2026-03-20T10:00:03.000Z",
          currentUrl: "https://example.com/jobs?page=2",
          lastStableUrl: "https://example.com/jobs?page=2",
          stepCount: revision * 2,
          collectedJobs,
          visitedUrls: ["https://example.com/jobs?page=2"],
          phaseEvidence: createEmptyPhaseEvidence(),
        });
        await input.onCheckpointSaved?.(revision);
      }

      if (input.failAfterCheckpoints) {
        throw new DOMException("Aborted", "AbortError");
      }

      return DiscoveryRunResultSchema.parse({
        source,
        startedAt: "2026-03-20T10:00:00.000Z",
        completedAt: "2026-03-20T10:00:05.000Z",
        querySummary: "Incremental checkpoint discovery test run",
        inventoryCompleteness: "partial" as const,
        warning: null,
        jobs: input.finalJobs,
        agentMetadata: input.agentMetadata ?? null,
      });
    },
  };
}

function createHarness(seedOverrides?: { discoveryOnly?: boolean }) {
  const seed = createSeed();
  seed.savedJobs = [];
  seed.discovery.pendingDiscoveryJobs = [];
  seed.discovery.discoveryLedger = [];
  if (seedOverrides?.discoveryOnly !== undefined) {
    seed.settings.discoveryOnly = seedOverrides.discoveryOnly;
  }
  seed.searchPreferences.targetRoles = ["Senior Product Designer"];
  seed.searchPreferences.companyWhitelist = [];
  seed.searchPreferences.discovery.targets = [
    {
      ...seed.searchPreferences.discovery.targets[0]!,
      id: "target_incremental",
      label: "Incremental Target",
      startingUrl: "https://example.com/jobs",
    },
  ];
  return { seed };
}

describe("discovery checkpoint incremental persistence", () => {
  test.each([
    {
      checkpoints: 1,
      agentMetadata: { pagesCovered: 2 },
    },
    {
      checkpoints: 1,
      agentMetadata: {
        pagesCovered: 2,
        coveredPageUrls: [
          "https://example.com/jobs",
          "https://example.com/jobs?page=2",
        ],
      },
    },
    { checkpoints: 2, agentMetadata: { pagesCovered: 2 } },
  ])(
    "finishes browser page accounting after frozen checkpoint saves: %j",
    async ({ checkpoints, agentMetadata }) => {
      const first = createCollectedJob({ token: "first-page" });
      const second = createCollectedJob({ token: "second-page" });
      const events: DiscoveryActivityEvent[] = [];
      const browserRuntime = createIncrementalRuntime({
        checkpoints: checkpoints === 1 ? [[first]] : [[first], [first, second]],
        finalJobs: checkpoints === 1 ? [first] : [first, second],
        agentMetadata,
        // Real browser tool calls give the queued checkpoint write time to
        // finish. A tight fixture loop otherwise accounts pages before save.
        onCheckpointSaved: async (revision) => {
          await vi.waitFor(() =>
            expect(
              events.filter(
                (event) =>
                  event.stage === "persistence" &&
                  (event.jobsPersisted ?? 0) > 0,
              ).length,
            ).toBeGreaterThanOrEqual(revision),
          );
        },
      });
      const { seed } = createHarness();
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "nestor-checkpoint-counts-"),
      );
      const repository = await createFileJobFinderRepository({
        filePath: path.join(directory, "workspace.sqlite"),
        seed,
      });
      try {
        const workspaceService = createJobFinderWorkspaceService({
          repository,
          browserRuntime,
          aiClient: createAgentAiClient(),
          documentManager: createDocumentManager(),
          researchAdapter: createResearchAdapter(),
          exportFileVerifier: { exists: () => Promise.resolve(true) },
        });
        const snapshot = await workspaceService.runDiscoveryForTarget(
          "target_incremental",
          (event) => events.push(event),
          new AbortController().signal,
        );
        const run = snapshot.recentDiscoveryRuns[0]!;
        expect(run.state).toBe("completed");
        expect(run.targetExecutions[0]!.state).toBe("completed");
        expect(
          run.targetExecutions[0]!.sourceCounts!.reduce(
            (n, row) => n + (row.pagesCovered ?? 0),
            0,
          ),
        ).toBe(2);
        expect(
          events.filter(
            (event) =>
              event.stage === "persistence" && (event.jobsPersisted ?? 0) > 0,
          ).length,
        ).toBeGreaterThanOrEqual(checkpoints);
      } finally {
        await repository.close();
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    },
  );
  test("reads a completed source while another collects, without applying facts early or reading twice", async () => {
    const job = createCollectedJob({ token: "read_ahead" });
    const { seed } = createHarness();
    seed.searchPreferences.discovery.targets.push({
      ...seed.searchPreferences.discovery.targets[0]!,
      id: "target_slow",
      label: "Slow target",
      startingUrl: "https://slow.example.test/jobs",
    });
    let readDone!: () => void;
    let slowRuns = 0;
    const prepared = new Promise<void>((resolve) => {
      readDone = resolve;
    });
    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      async runAgentDiscovery(source, options) {
        const slow = options.siteLabel === "Slow target";
        if (slow) {
          await prepared;
          if (++slowRuns === 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            const saved = await repository.listSavedJobs();
            expect(
              saved.find((row) => row.sourceJobId === job.sourceJobId)
                ?.description,
            ).toBe(job.description);
            expect(
              saved.find((row) => row.sourceJobId === job.sourceJobId)
                ?.listingDetailFetch,
            ).toBeNull();
          }
        }
        return {
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "Read ahead fixture",
          inventoryCompleteness: "complete",
          warning: null,
          jobs: slow ? [] : [job],
          agentMetadata: null,
        };
      },
    };
    const fetchListingHtml = vi.fn((url: string) =>
      Promise.resolve({
        status: 200,
        html: "<p>Build and operate a design system with product teams.</p>",
        finalUrl: url,
      }),
    );
    const aiClient = {
      ...createAgentAiClient(),
      extractJobsFromPage: () => {
        readDone();
        return Promise.resolve([
          {
            ...job,
            description:
              "Build and operate a design system with product teams. Own delivery, design reviews, accessibility and prototyping across web and native applications.",
          },
        ]);
      },
    };
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient,
      fetchListingHtml,
    });
    await workspaceService.runAgentDiscovery();
    const saved = await repository.listSavedJobs();
    expect(
      saved.find((row) => row.sourceJobId === job.sourceJobId)?.description,
    ).toContain("Own delivery");
    expect(fetchListingHtml).toHaveBeenCalledOnce();
    await workspaceService.runAgentDiscovery();
    expect(fetchListingHtml).toHaveBeenCalledOnce();
  }, 15_000);

  test("keeps checkpoint jobs and records a blocked source even when detail retrieval returns partial jobs", async () => {
    const job = createCollectedJob({ token: "before_bot_check" });
    const runtime = createIncrementalRuntime({
      checkpoints: [[job]],
      finalJobs: [job],
    });
    const run = runtime.runAgentDiscovery!.bind(runtime);
    const runAgentDiscovery = vi.fn<
      NonNullable<BrowserSessionRuntime["runAgentDiscovery"]>
    >(async (source, options) => {
      const partial = await run(source, options);
      return DiscoveryRunResultSchema.parse({
        ...partial,
        warning:
          "example.com is showing a bot check. Open it in the browser, get past the check, then search again.",
        agentMetadata: {
          incomplete: true,
          accessBlockerReason: "site_protection",
          parkedTab: {
            tabId: "tab_bot_check",
            url: "https://example.com/jobs/blocked",
            title: "Just a moment...",
          },
        },
      });
    });
    const { seed } = createHarness();
    const fetchListingHtml = vi.fn();
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...runtime, runAgentDiscovery },
      aiClient: createAgentAiClient(),
      fetchListingHtml,
    });
    await expect(
      workspaceService.runDiscoveryForTarget(
        "target_incremental",
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("example.com is showing a bot check");
    const snapshot = await workspaceService.getWorkspaceSnapshot();
    expect(runAgentDiscovery).toHaveBeenCalledOnce();
    expect(fetchListingHtml).not.toHaveBeenCalled();
    expect(
      (await repository.listSavedJobs()).map((saved) => saved.sourceJobId),
    ).toContain(job.sourceJobId);
    expect(snapshot.recentDiscoveryRuns[0]).toMatchObject({
      state: "failed",
      summary: {
        validJobsFound: 1,
        jobsPersisted: 1,
        sourceHealth: [{ health: "failed" }],
      },
      targetExecutions: [
        {
          state: "failed",
          accessBlockerReason: "site_protection",
          jobsFound: 1,
        },
      ],
    });
    expect(snapshot.recentDiscoveryRuns[0]?.summary.warnings).toContain(
      "example.com is showing a bot check. Open it in the browser, get past the check, then search again.",
    );
    const handoff = snapshot.userActionRequests.find(
      (request) =>
        request.scope.type === "discovery_source" &&
        request.scope.parkedTab?.tabId === "tab_bot_check",
    );
    expect(handoff?.scope).toMatchObject({
      type: "discovery_source",
      parkedTab: { tabId: "tab_bot_check" },
    });
  });

  test("read-ahead and final enrichment share sixty reads when a source keeps more jobs", async () => {
    const jobs = Array.from({ length: 75 }, (_, index) =>
      createCollectedJob({ token: `bounded_read_${index}` }),
    );
    const { seed } = createHarness();
    const older = Array.from({ length: 6 }, (_, index) =>
      createSavedJob({
        ...createSeed().savedJobs[0]!,
        id: `older_${index}`,
        sourceJobId: `older_${index}`,
        canonicalUrl: `https://archive.example.test/old/${index}`,
        status: "discovered",
        detailQuality: "card_only",
        listingDetailFetch: null,
        provenance: [],
      }),
    );
    seed.savedJobs = older;
    const byUrl = new Map(
      [...jobs, ...older].map((job) => [job.canonicalUrl, job]),
    );
    const fetchListingHtml = vi.fn((url: string) =>
      Promise.resolve({
        status: 200,
        html: "<p>Own a product design system and lead delivery across teams.</p>",
        finalUrl: url,
      }),
    );
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: createIncrementalRuntime({
        checkpoints: [],
        finalJobs: jobs,
      }),
      fetchListingHtml,
      aiClient: {
        ...createAgentAiClient(),
        extractJobsFromPage: (input) =>
          Promise.resolve([
            {
              ...byUrl.get(input.pageUrl)!,
              description:
                "Own the design system across web and native products. Lead design reviews, prototyping, accessibility, and delivery with engineers and product managers.",
            },
          ]),
      },
    });
    const initial = await workspaceService.getWorkspaceSnapshot();
    const plan = initial.campaigns[0]!;
    await repository.saveCampaignState({
      activeCampaignId: plan.id,
      notifications: [],
      campaigns: [{ ...plan, jobIds: older.map((job) => job.id) }],
    });
    await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );
    expect(fetchListingHtml).toHaveBeenCalledTimes(60);
    expect(new Set(fetchListingHtml.mock.calls.map(([url]) => url)).size).toBe(
      60,
    );
    const saved = await repository.listSavedJobs();
    expect(saved).toHaveLength(81);
    expect(saved.filter((job) => job.listingDetailFetch)).toHaveLength(60);
    expect(
      fetchListingHtml.mock.calls.every(([url]) => !url.includes("/old/")),
    ).toBe(true);
  }, 15_000);

  test("commits distinct checkpoint jobs mid-run and keeps final counts additive for repeated sources", async () => {
    const jobA = createCollectedJob({ token: "a" });
    const jobB = createCollectedJob({ token: "b" });
    const jobC = createCollectedJob({ token: "c" });

    const browserRuntime = createIncrementalRuntime({
      // The same source reports overlapping snapshots as extraction grows;
      // job A appears in both checkpoints and the final result.
      checkpoints: [[jobA], [jobA, jobB]],
      finalJobs: [jobA, jobB, jobC],
    });

    const { seed } = createHarness();
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const events: DiscoveryActivityEvent[] = [];
    const snapshot = await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      (event) => events.push(event),
      new AbortController().signal,
    );

    const savedUrls = snapshot.discoveryJobs.map((job) => job.canonicalUrl);
    expect(savedUrls).toHaveLength(3);
    expect(new Set(savedUrls).size).toBe(3);
    expect(savedUrls).toContain(jobC.canonicalUrl);

    const ledger = await repository.getDiscoveryState();
    const ledgerUrls = ledger.discoveryLedger.map(
      (entry) => entry.canonicalUrl,
    );
    expect(new Set(ledgerUrls).size).toBe(3);

    // Each incremental flush published its own non-terminal persistence
    // event with truthful deltas.
    const persistenceEvents = events.filter(
      (event) =>
        event.stage === "persistence" &&
        !event.terminalState &&
        (event.jobsPersisted ?? 0) > 0,
    );
    expect(persistenceEvents.length).toBeGreaterThanOrEqual(2);

    const run = snapshot.recentDiscoveryRuns[0]!;
    expect(run.summary.validJobsFound).toBe(3);
    expect(run.summary.jobsPersisted).toBe(3);
    expect(run.summary.duplicatesMerged).toBe(0);
    expect(run.summary.invalidSkipped).toBe(0);

    const execution = run.targetExecutions.find(
      (entry) => entry.targetId === "target_incremental",
    )!;
    expect(execution.state).toBe("completed");
    expect(execution.jobsFound).toBe(3);
    expect(execution.jobsPersisted).toBe(3);
    expect(execution.duplicatesMerged).toBe(0);
  });

  test("mid-run repository reads see checkpoint-committed jobs while the source is still running", async () => {
    const jobA = createCollectedJob({ token: "mid_run_a" });
    const jobB = createCollectedJob({ token: "mid_run_b" });
    let observedDuringRun: string[] | null = null;
    let observedMidRunHistory: {
      activeRunState: string | null;
      runningRunInRecentHistory: boolean;
    } | null = null;

    const browserRuntime = createIncrementalRuntime({
      checkpoints: [[jobA]],
      finalJobs: [jobA, jobB],
      onStarted: async () => {},
    });
    // Wrap the runtime so the second checkpoint observes durable state
    // between flushes, while runAgentDiscovery is still in flight.
    const wrapped: BrowserSessionRuntime = {
      ...browserRuntime,
      async runAgentDiscovery(source, options) {
        const originalOnCheckpoint = options.onCheckpoint?.bind(options);
        let callCount = 0;
        return browserRuntime.runAgentDiscovery!(source, {
          ...options,
          onCheckpoint: async (checkpoint) => {
            const originalResult = originalOnCheckpoint?.(checkpoint);
            if (originalResult) {
              await originalResult;
            }
            callCount += 1;
            if (callCount === 1) {
              const jobs = await repositoryRef.listSavedJobs();
              observedDuringRun = jobs.map((job) => job.canonicalUrl);
              const midRunState = await repositoryRef.getDiscoveryState();
              observedMidRunHistory = {
                activeRunState: midRunState.activeRun?.state ?? null,
                runningRunInRecentHistory: midRunState.recentRuns.some(
                  (run) => run.id === midRunState.activeRun?.id,
                ),
              };
            }
          },
        });
      },
    };

    const { seed } = createHarness();
    const { workspaceService, repository: repositoryRef } =
      createWorkspaceServiceHarness({
        seed,
        browserRuntime: wrapped,
        aiClient: createAgentAiClient(),
      });

    const snapshot = await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );

    expect(observedDuringRun).toEqual([jobA.canonicalUrl]);
    // A running run lives solely in activeRun; it never appears in history.
    expect(observedMidRunHistory).toMatchObject({
      activeRunState: "running",
      runningRunInRecentHistory: false,
    });
    expect(snapshot.discoveryJobs.map((job) => job.canonicalUrl)).toEqual([
      jobA.canonicalUrl,
      jobB.canonicalUrl,
    ]);
  });

  test("cancellation after a kept checkpoint leaves committed jobs visible and marks the run truthfully partial", async () => {
    const jobA = createCollectedJob({ token: "cancelled_a" });
    const jobB = createCollectedJob({ token: "cancelled_b" });

    const browserRuntime = createIncrementalRuntime({
      checkpoints: [[jobA]],
      finalJobs: [],
      failAfterCheckpoints: true,
    });

    const { seed } = createHarness();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    // Cancellation resolves with the current workspace snapshot (the desktop
    // treats a resolved cancelled run as its terminal state).
    const snapshot = await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );

    // The committed checkpoint job stays visible...
    expect(snapshot.discoveryJobs.map((job) => job.sourceJobId)).toEqual([
      jobA.sourceJobId,
    ]);
    // ...and never-persisted jobs do not appear.
    expect(
      snapshot.discoveryJobs.some(
        (job) => job.sourceJobId === jobB.sourceJobId,
      ),
    ).toBe(false);

    const run = snapshot.recentDiscoveryRuns[0]!;
    expect(run.state).toBe("cancelled");
    expect(run.summary.jobsPersisted).toBe(1);
    const execution = run.targetExecutions.find(
      (entry) => entry.targetId === "target_incremental",
    )!;
    expect(execution.state).toBe("cancelled");
    expect(execution.jobsPersisted).toBe(1);
    expect(execution.warning).toBeTruthy();
  });

  test("first useful-job timing tracks the first kept checkpoint instead of source completion", async () => {
    const jobA = createCollectedJob({ token: "timing_a" });
    const jobB = createCollectedJob({ token: "timing_b" });

    const browserRuntime = createIncrementalRuntime({
      checkpoints: [[jobA]],
      finalJobs: [jobA, jobB],
    });

    const { seed } = createHarness();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const events: DiscoveryActivityEvent[] = [];
    const snapshot = await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      (event) => events.push(event),
      new AbortController().signal,
    );

    const persistenceEvents = events.filter(
      (event) =>
        event.stage === "persistence" &&
        !event.terminalState &&
        (event.jobsPersisted ?? 0) + (event.jobsStaged ?? 0) > 0,
    );
    expect(persistenceEvents.length).toBeGreaterThanOrEqual(1);

    const execution = snapshot.recentDiscoveryRuns[0]!.targetExecutions.find(
      (entry) => entry.targetId === "target_incremental",
    )!;
    expect(execution.timing).not.toBeNull();
    expect(execution.timing?.firstDistinctUsefulJobMs).not.toBeNull();
    expect(execution.timing?.firstCandidateMs).not.toBeNull();
    expect(execution.timing!.firstDistinctUsefulJobMs!).toBeLessThanOrEqual(
      execution.timing!.totalDurationMs,
    );
  });

  test("discovery-only runs stage checkpoint jobs transactionally without touching saved jobs", async () => {
    const jobA = createCollectedJob({ token: "staged_a" });

    const browserRuntime = createIncrementalRuntime({
      checkpoints: [[jobA]],
      finalJobs: [jobA],
    });

    const { seed } = createHarness({ discoveryOnly: true });
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const events: DiscoveryActivityEvent[] = [];
    const snapshot = await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      (event) => events.push(event),
      new AbortController().signal,
    );

    // Staged pending jobs surface in the discovery projection, but the
    // saved-job collection stays untouched in discovery-only mode.
    const savedJobs = await repository.listSavedJobs();
    expect(savedJobs.map((job) => job.sourceJobId)).toEqual([]);
    const discoveryState = await repository.getDiscoveryState();
    expect(
      discoveryState.pendingDiscoveryJobs.map((job) => job.sourceJobId),
    ).toEqual([jobA.sourceJobId]);
    expect(snapshot.discoveryJobs.map((job) => job.sourceJobId)).toEqual([
      jobA.sourceJobId,
    ]);

    const run = snapshot.recentDiscoveryRuns[0]!;
    expect(run.summary.jobsStaged).toBe(1);
    expect(run.summary.jobsPersisted).toBe(0);
    const stagedEvent = events.find(
      (event) =>
        event.stage === "persistence" &&
        !event.terminalState &&
        (event.jobsStaged ?? 0) > 0,
    );
    expect(stagedEvent).toBeTruthy();
  });

  test("a richer later extraction of a known identity upgrades the kept checkpoint job without counting a second persisted job", async () => {
    const weak = createCollectedJob({ token: "upgrade_a" });
    const rich = createCollectedJob({
      token: "upgrade_a",
      description:
        "Grounded description with detailed scope, stakeholders, and delivery outcomes for the platform team.",
      responsibilities: [
        "Lead the design system roadmap",
        "Partner with engineering on delivery",
      ],
    });

    const browserRuntime = createIncrementalRuntime({
      checkpoints: [[weak], [rich]],
      finalJobs: [rich],
    });

    const { seed } = createHarness();
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );

    // Exactly one distinct job stays kept, and its content is the richer
    // version — the upgrade replaced the weaker first extraction.
    expect(snapshot.discoveryJobs).toHaveLength(1);
    expect(snapshot.discoveryJobs[0]?.sourceJobId).toBe(weak.sourceJobId);
    expect(snapshot.discoveryJobs[0]?.description).toBe(rich.description);
    expect(snapshot.discoveryJobs[0]?.responsibilities).toEqual(
      rich.responsibilities,
    );

    const ledger = await repository.getDiscoveryState();
    expect(ledger.discoveryLedger).toHaveLength(1);

    const run = snapshot.recentDiscoveryRuns[0]!;
    const execution = run.targetExecutions.find(
      (entry) => entry.targetId === "target_incremental",
    )!;
    // Truthful accounting under distinct-retained found semantics: two
    // reviewed observations of one identity, exactly one new/persisted job
    // counted as found, and one duplicate merge for the upgrade. No
    // double-counting of found/persisted.
    expect(execution.jobsReviewed).toBe(2);
    expect(execution.jobsFound).toBe(1);
    expect(execution.jobsPersisted).toBe(1);
    expect(run.summary.jobsPersisted).toBe(1);
    expect(execution.duplicatesMerged).toBe(1);
  });

  test("a richer final-remainder version upgrades an earlier checkpoint job without recounting it as new", async () => {
    const weak = createCollectedJob({ token: "final_upgrade" });
    const rich = createCollectedJob({
      token: "final_upgrade",
      description:
        "Final richer description including evidence-backed outcomes, scope, and collaboration detail.",
      responsibilities: ["Own the roadmap", "Mentor designers"],
    });

    const browserRuntime = createIncrementalRuntime({
      checkpoints: [[weak]],
      finalJobs: [rich],
    });

    const { seed } = createHarness();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );

    expect(snapshot.discoveryJobs).toHaveLength(1);
    expect(snapshot.discoveryJobs[0]?.description).toBe(rich.description);

    const run = snapshot.recentDiscoveryRuns[0]!;
    const execution = run.targetExecutions.find(
      (entry) => entry.targetId === "target_incremental",
    )!;
    expect(execution.jobsFound).toBe(1);
    expect(execution.jobsPersisted).toBe(1);
    expect(run.summary.jobsPersisted).toBe(1);
    expect(execution.duplicatesMerged).toBe(1);
  });

  test("non-abort source failure after partial checkpoint commits keeps cumulative execution truth matching durable jobs", async () => {
    const jobA = createCollectedJob({ token: "fail_partial_a" });

    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      async runAgentDiscovery(source, options) {
        if (options.siteLabel === "Failing Target") {
          await emitRuntimeCheckpoint(options, {
            revision: 1,
            savedAt: "2026-03-20T10:00:03.000Z",
            currentUrl: "https://example.com/failing?page=2",
            lastStableUrl: "https://example.com/failing?page=2",
            stepCount: 2,
            collectedJobs: [jobA],
            visitedUrls: ["https://example.com/failing?page=2"],
            phaseEvidence: createEmptyPhaseEvidence(),
          });
          throw new Error("extractor crashed mid-source");
        }

        return {
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "Healthy follow-on source",
          inventoryCompleteness: "partial" as const,
          warning: null,
          jobs: [],
          agentMetadata: null,
        };
      },
    };

    const { seed } = createHarness();
    seed.searchPreferences.discovery.targets = [
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_failing",
        label: "Failing Target",
        startingUrl: "https://example.com/failing",
      },
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_healthy",
        label: "Healthy Target",
        startingUrl: "https://example.com/healthy",
      },
    ];
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.runAgentDiscovery(
      () => {},
      new AbortController().signal,
    );

    // The committed checkpoint job stays durable and visible.
    expect(snapshot.discoveryJobs.map((job) => job.sourceJobId)).toEqual([
      jobA.sourceJobId,
    ]);

    const run = snapshot.recentDiscoveryRuns[0]!;
    const failedExecution = run.targetExecutions.find(
      (entry) => entry.targetId === "target_failing",
    )!;
    expect(failedExecution.state).toBe("failed");
    expect(failedExecution.warning).toBeTruthy();
    // Failure truth is cumulative, not zeroed.
    expect(failedExecution.jobsPersisted).toBe(1);
    expect(failedExecution.jobsFound).toBe(1);
    expect(run.summary.jobsPersisted).toBe(1);
  });

  test("a failed checkpoint persistence rolls back cleanly, disables mid-run saving, and the final pass persists exactly once", async () => {
    const jobA = createCollectedJob({
      token: "rollback_a",
      title: "Principal Designer A",
    });
    const jobB = createCollectedJob({
      token: "rollback_b",
      title: "Principal Designer B",
    });
    let savedDuringDisabledWindow: number | null = null;

    const baseRuntime = createIncrementalRuntime({
      checkpoints: [[jobA], [jobA, jobB]],
      finalJobs: [jobA, jobB],
    });
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      async runAgentDiscovery(source, options) {
        const originalOnCheckpoint = options.onCheckpoint?.bind(options);
        let callIndex = 0;
        return baseRuntime.runAgentDiscovery!(source, {
          ...options,
          onCheckpoint: async (checkpoint) => {
            const originalResult = originalOnCheckpoint?.(checkpoint);
            if (originalResult) {
              await originalResult;
            }
            callIndex += 1;
            if (callIndex === 2) {
              // Mid-run window after the rollback: nothing from either
              // attempt may be durably saved yet.
              const jobs = await repositoryRef.listSavedJobs();
              savedDuringDisabledWindow = jobs.length;
            }
          },
        });
      },
    };

    const { seed } = createHarness();
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });
    const repositoryRef = repository;

    const originalCommit = repository.commitSavedJobDelta.bind(repository);
    let simulatedFailures = 0;
    const commitSpy = vi
      .spyOn(repository, "commitSavedJobDelta")
      .mockImplementation(async (input) => {
        if (simulatedFailures === 0) {
          simulatedFailures += 1;
          throw new Error("simulated commit failure");
        }
        return originalCommit(input);
      });

    try {
      const events: DiscoveryActivityEvent[] = [];
      const snapshot = await workspaceService.runDiscoveryForTarget(
        "target_incremental",
        (event) => events.push(event),
        new AbortController().signal,
      );

      // The warning fallback fired instead of failing the run.
      expect(
        events.some(
          (event) =>
            event.kind === "warning" &&
            event.message.includes("Mid-run saving hit a problem"),
        ),
      ).toBe(true);

      // Rollback restored state: no jobs were durably saved during the
      // disabled window even though two checkpoints had arrived.
      expect(savedDuringDisabledWindow).toBe(0);

      // The final fallback retried everything and persisted each job once.
      expect(snapshot.discoveryJobs.map((job) => job.sourceJobId)).toEqual([
        jobA.sourceJobId,
        jobB.sourceJobId,
      ]);
      const ledger = await repository.getDiscoveryState();
      expect(ledger.discoveryLedger).toHaveLength(2);

      const run = snapshot.recentDiscoveryRuns[0]!;
      const execution = run.targetExecutions.find(
        (entry) => entry.targetId === "target_incremental",
      )!;
      expect(execution.jobsPersisted).toBe(2);
      expect(execution.duplicatesMerged).toBe(0);
      expect(run.summary.jobsPersisted).toBe(2);

      // One failed checkpoint, one successful retry and the campaign's
      // membership/count update. Terminal run-only saves do not visit rows.
      expect(commitSpy.mock.calls.length).toBe(3);
      expect(simulatedFailures).toBe(1);
    } finally {
      commitSpy.mockRestore();
    }
  });

  test("same-batch duplicate identities merge into one kept job with legacy duplicate accounting", async () => {
    // Two raw postings sharing one identity (same sourceJobId/canonicalUrl)
    // but differing titles arrive inside ONE checkpoint payload.
    const duplicateFirst = createCollectedJob({
      token: "dup_batch",
      title: "Principal Designer A",
    });
    const duplicateSecond = createCollectedJob({
      token: "dup_batch",
      title: "Principal Designer B",
    });

    const browserRuntime = createIncrementalRuntime({
      checkpoints: [[duplicateFirst, duplicateSecond]],
      finalJobs: [duplicateFirst, duplicateSecond],
    });

    const { seed } = createHarness();
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );

    const run = snapshot.recentDiscoveryRuns[0]!;
    const execution = run.targetExecutions.find(
      (entry) => entry.targetId === "target_incremental",
    )!;
    // One identity row survives; both observations were reviewed, but only
    // the distinct retained job counts as found under truthful semantics.
    expect(snapshot.discoveryJobs).toHaveLength(1);
    const ledger = await repository.getDiscoveryState();
    expect(ledger.discoveryLedger).toHaveLength(1);

    expect(execution.jobsReviewed).toBe(2);
    expect(execution.jobsFound).toBe(1);
    expect(execution.jobsPersisted).toBe(1);
    expect(execution.duplicatesMerged).toBe(1);
    expect(run.summary.validJobsFound).toBe(1);
    expect(run.summary.jobsPersisted).toBe(1);
  });

  test("budget exhaustion holds across flushes: the greedy first flush wins and later candidates cannot displace or overdraw", async () => {
    // Greedy incremental policy (documented tradeoff): each flush may spend
    // remaining budget immediately on its best-ranked candidates; later
    // flushes can add only while budget remains and can never displace an
    // already-persisted choice or exceed the target's requested budget.
    const jobA = createCollectedJob({
      token: "budget_a",
      title: "Principal Designer A",
    });
    const jobB = createCollectedJob({
      token: "budget_b",
      title: "Principal Designer B",
    });
    const jobC = createCollectedJob({
      token: "budget_c",
      title: "Principal Designer C",
    });

    const browserRuntime = createIncrementalRuntime({
      checkpoints: [
        [jobA, jobB],
        [jobA, jobB, jobC],
      ],
      finalJobs: [jobA, jobB, jobC],
    });

    const { seed } = createHarness();
    seed.searchPreferences.discovery.runJobBudget = 1;
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const events: DiscoveryActivityEvent[] = [];
    const snapshot = await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      (event) => events.push(event),
      new AbortController().signal,
    );

    const run = snapshot.recentDiscoveryRuns[0]!;
    const execution = run.targetExecutions.find(
      (entry) => entry.targetId === "target_incremental",
    )!;
    // Exactly one slot was ever allocated and exactly one job was kept.
    expect(execution.requestedJobBudget).toBe(1);
    expect(execution.jobsReviewed).toBe(1);
    expect(execution.jobsPersisted).toBe(1);
    expect(snapshot.discoveryJobs).toHaveLength(1);
    expect(run.summary.jobsPersisted).toBe(1);
    expect(run.summary.validJobsFound).toBe(1);

    // First flush consumed the budget; every later persistence-stage flush
    // reported zero newly kept jobs.
    const keptDeltas = events
      .filter(
        (event) =>
          event.stage === "persistence" &&
          !event.terminalState &&
          event.targetId === "target_incremental",
      )
      .map((event) => (event.jobsPersisted ?? 0) + (event.jobsStaged ?? 0));
    expect(keptDeltas[0]).toBe(1);
    expect(keptDeltas.slice(1).every((delta) => delta === 0)).toBe(true);
  });

  test("richer upgrades of a known identity merge even at zero remaining budget; other identities stay excluded", async () => {
    // Policy under test: upgrades of already-retained identities consume no
    // budget slot, so they remain eligible to merge after exhaustion, while
    // genuinely new identities stay excluded by the greedy cap.
    const weakA = createCollectedJob({
      token: "zero_budget_a",
      title: "Principal Designer A",
    });
    const richA = createCollectedJob({
      token: "zero_budget_a",
      title: "Principal Designer A",
      description:
        "Upgraded description with delivery outcomes, scope, and cross-team evidence for the same vacancy.",
      responsibilities: ["Lead roadmap", "Coach partners"],
    });
    const jobB = createCollectedJob({
      token: "zero_budget_b",
      title: "Principal Designer B",
    });

    const browserRuntime = createIncrementalRuntime({
      checkpoints: [[weakA], [richA, jobB]],
      finalJobs: [richA, jobB],
    });

    const { seed } = createHarness();
    seed.searchPreferences.discovery.runJobBudget = 1;
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );

    // Exactly one row survives and its content is the richer upgrade.
    expect(snapshot.discoveryJobs).toHaveLength(1);
    expect(snapshot.discoveryJobs[0]?.sourceJobId).toBe(weakA.sourceJobId);
    expect(snapshot.discoveryJobs[0]?.description).toBe(richA.description);

    const run = snapshot.recentDiscoveryRuns[0]!;
    const execution = run.targetExecutions.find(
      (entry) => entry.targetId === "target_incremental",
    )!;
    // Budget stayed consumed at exactly the one weak slot...
    expect(execution.requestedJobBudget).toBe(1);
    expect(execution.jobsPersisted).toBe(1);
    expect(run.summary.jobsPersisted).toBe(1);
    // ...while review truth counted both passes of the upgraded identity and
    // found stayed at the one distinct retained job (the upgrade merged as a
    // duplicate, never as a new found/kept job).
    expect(execution.jobsFound).toBe(1);
    expect(execution.duplicatesMerged).toBe(1);
    expect(execution.jobsReviewed).toBe(2);
    // The different identity never slipped in via the upgrade exemption.
    expect(
      snapshot.discoveryJobs.some(
        (job) => job.sourceJobId === jobB.sourceJobId,
      ),
    ).toBe(false);
  });

  test("the jobs a source keeps are judged for fit while it is still searching", async () => {
    const jobs = Array.from({ length: 20 }, (_, index) =>
      createCollectedJob({ token: `fit_live_${index}` }),
    );
    const judgeJobFits = vi.fn((input: JudgeJobFitsInput) =>
      Promise.resolve(
        input.jobs.map(({ jobId }) => ({
          jobId,
          score: 77,
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
    let judgedWhileSearching = 0;
    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      async runAgentDiscovery(source, options) {
        await emitRuntimeCheckpoint(options, {
          revision: 1,
          savedAt: "2026-03-20T10:00:03.000Z",
          currentUrl: "https://example.com/jobs",
          lastStableUrl: "https://example.com/jobs",
          stepCount: 2,
          collectedJobs: jobs,
          visitedUrls: ["https://example.com/jobs"],
          phaseEvidence: createEmptyPhaseEvidence(),
        });
        // The source keeps searching until the saved jobs carry verdicts.
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const saved = [
            ...(await repositoryRef.listSavedJobs()),
            ...(await repositoryRef.getDiscoveryState()).pendingDiscoveryJobs,
          ];
          judgedWhileSearching = saved.filter(
            (job) => job.matchAssessment.judgment?.score === 77,
          ).length;
          if (judgedWhileSearching === jobs.length) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return {
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "Fit while searching",
          inventoryCompleteness: "partial" as const,
          warning: null,
          jobs,
          agentMetadata: null,
        };
      },
    };
    const { seed } = createHarness();
    const { workspaceService, repository: repositoryRef } =
      createWorkspaceServiceHarness({
        seed,
        browserRuntime,
        aiClient: { ...createAgentAiClient(), judgeJobFits },
      });

    await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );

    expect(judgedWhileSearching).toBe(jobs.length);
    // One full batch while searching; nothing is asked again at the end.
    expect(judgeJobFits).toHaveBeenCalledTimes(1);
  });

  test("a checkpoint reads back only the saved jobs it changed", async () => {
    const jobA = createCollectedJob({ token: "scoped_a" });
    const jobB = createCollectedJob({ token: "scoped_b" });
    const { seed } = createHarness();
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: createIncrementalRuntime({
        checkpoints: [[jobA], [jobA, jobB]],
        finalJobs: [jobA, jobB],
      }),
      aiClient: createAgentAiClient(),
    });
    const commitSpy = vi.spyOn(repository, "commitSavedJobDelta");

    const snapshot = await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );

    const savedJobA = snapshot.discoveryJobs.find(
      (job) => job.sourceJobId === jobA.sourceJobId,
    );
    expect(savedJobA).toBeDefined();
    const jobBCommit = commitSpy.mock.calls.find(([input]) =>
      input.upserts?.some((job) => job.sourceJobId === jobB.sourceJobId),
    )?.[0];
    // The first checkpoint stored job A and the second left it as it was,
    // so the second commit does not read it back.
    expect(jobBCommit?.updateJobIds).toBeDefined();
    expect(jobBCommit?.updateJobIds).not.toContain(savedJobA!.id);
  });

  test("a later checkpoint upgrade preserves a person's concurrent saved-job edit", async () => {
    const { seed } = createHarness();
    const weak = createCollectedJob({ token: "user_edit_checkpoint" });
    const rich = createCollectedJob({
      token: "user_edit_checkpoint",
      description:
        "Grounded description with detailed scope, stakeholders, and delivery outcomes for the platform team.",
      responsibilities: [
        "Lead the design system roadmap",
        "Partner with engineering on delivery",
      ],
    });
    let keptId = "";
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: createIncrementalRuntime({
        checkpoints: [[weak], [rich]],
        finalJobs: [rich],
        onCheckpointSaved: async (revision) => {
          if (revision === 1) {
            keptId = (await repository.listSavedJobIds())[0]!;
            await repository.commitSavedJobDelta({
              updateJobIds: [keptId],
              update: (current) => ({ ...current, status: "shortlisted" }),
            });
          } else {
            expect(
              (await repository.listSavedJobsByIds([keptId]))[0],
            ).toMatchObject({
              status: "shortlisted",
              description: rich.description,
            });
          }
        },
      }),
      aiClient: createAgentAiClient(),
    });
    await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );
    expect((await repository.listSavedJobsByIds([keptId]))[0]?.status).toBe(
      "shortlisted",
    );
  });

  test("empty checkpoints skip saved-job delta commits while keeping resume-checkpoint durability", async () => {
    const jobA = createCollectedJob({ token: "empty_cp_a" });
    // Sampled inside the runtime between checkpoint phases; the spy is bound
    // after harness construction, before any checkpoint fires.
    let singletonCommitsAfterKeptBatch = 0;
    let singletonCommitsAfterDuplicatePhase = 0;

    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      async runAgentDiscovery(source, options) {
        const emitCheckpoint = (
          revision: number,
          collectedJobs: unknown[],
        ): Promise<void> =>
          emitRuntimeCheckpoint(options, {
            revision,
            savedAt: "2026-03-20T10:00:03.000Z",
            currentUrl: "https://example.com/jobs",
            lastStableUrl: "https://example.com/jobs",
            stepCount: revision * 2,
            collectedJobs: collectedJobs as never[],
            visitedUrls: ["https://example.com/jobs"],
            phaseEvidence: createEmptyPhaseEvidence(),
          });

        await emitCheckpoint(1, [jobA]);
        // The kept batch above armed checkpoint durability; record the
        // singleton-commit baseline before the duplicate-only phase.
        singletonCommitsAfterKeptBatch = discoveryCommitSpy.mock.calls.length;
        await emitCheckpoint(2, [jobA]);
        await emitCheckpoint(3, [jobA]);
        singletonCommitsAfterDuplicatePhase =
          discoveryCommitSpy.mock.calls.length;

        return {
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "Empty-checkpoint cost test",
          inventoryCompleteness: "partial" as const,
          warning: null,
          jobs: [jobA],
          agentMetadata: null,
        };
      },
    };

    const { seed } = createHarness();
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });
    // vi.spyOn preserves the original implementation and records calls.
    const commitSpy = vi.spyOn(repository, "commitSavedJobDelta");
    const discoveryCommitSpy = vi.spyOn(
      repository,
      "commitDiscoveryStateUpdate",
    );

    const snapshot = await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );

    // Job persisted once by the single job-bearing checkpoint.
    expect(snapshot.discoveryJobs).toHaveLength(1);

    // Only the kept batch and campaign membership touch saved rows. The
    // terminal pair persists run state without empty saved-job updates.
    const jobBearingCommits = commitSpy.mock.calls.filter(
      ([input]) => (input.upserts?.length ?? 0) > 0,
    );
    expect(jobBearingCommits).toHaveLength(1);
    expect(commitSpy.mock.calls.length).toBe(2);

    // Checkpoint-phase delta: the two identical duplicate-only checkpoints
    // moved the discovery-singleton commit count by exactly zero.
    expect(
      singletonCommitsAfterDuplicatePhase - singletonCommitsAfterKeptBatch,
    ).toBe(0);

    // Planning, session open/close and the terminal pair. Kept batches and
    // membership still pair their row changes with run state atomically.
    expect(discoveryCommitSpy.mock.calls.length).toBe(5);

    // Terminal saves still carry the freshest checkpoint record; a finished
    // source drops its copies of the postings, which the saved jobs hold.
    const execution = (
      await repository.getDiscoveryState()
    ).recentRuns[0]!.targetExecutions.find(
      (entry) => entry.targetId === "target_incremental",
    )!;
    expect(execution.agentCheckpoint?.revision).toBe(3);
    expect(execution.agentCheckpoint?.collectedJobs).toHaveLength(0);
  });

  test("duplicate-only checkpoint sequences collapse to bounded heartbeat singleton commits", async () => {
    const jobA = createCollectedJob({ token: "heartbeat_a" });
    // Sampled inside the runtime between checkpoint phases; the spy is bound
    // after harness construction, before any checkpoint fires.
    let singletonCommitsAfterKeptBatch = 0;
    let singletonCommitsAfterDuplicatePhase = 0;

    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      async runAgentDiscovery(source, options) {
        const emitCheckpoint = (
          revision: number,
          collectedJobs: unknown[],
        ): Promise<void> =>
          emitRuntimeCheckpoint(options, {
            revision,
            savedAt: "2026-03-20T10:00:03.000Z",
            currentUrl: "https://example.com/jobs",
            lastStableUrl: "https://example.com/jobs",
            stepCount: revision * 2,
            collectedJobs: collectedJobs as never[],
            visitedUrls: ["https://example.com/jobs"],
            phaseEvidence: createEmptyPhaseEvidence(),
          });

        // One kept batch arms durability at revision 1; every later payload
        // repeats the same identity so nothing new is processable — the
        // duplicate-heavy shape long agent runs produce between finds.
        await emitCheckpoint(1, [jobA]);
        singletonCommitsAfterKeptBatch = discoveryCommitSpy.mock.calls.length;
        for (let revision = 2; revision <= 20; revision += 1) {
          await emitCheckpoint(revision, [jobA]);
        }
        singletonCommitsAfterDuplicatePhase =
          discoveryCommitSpy.mock.calls.length;

        return {
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "Duplicate-only heartbeat cost test",
          inventoryCompleteness: "partial" as const,
          warning: null,
          jobs: [jobA],
          agentMetadata: null,
        };
      },
    };

    const { seed } = createHarness();
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });
    const discoveryCommitSpy = vi.spyOn(
      repository,
      "commitDiscoveryStateUpdate",
    );

    const snapshot = await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );

    expect(snapshot.discoveryJobs.map((job) => job.sourceJobId)).toEqual([
      jobA.sourceJobId,
    ]);

    // Checkpoint-phase delta: nineteen duplicate-only checkpoints collapsed
    // to exactly the two bounded heartbeat refreshes (revisions 9 and 17 at
    // heartbeat interval 8, counted from the kept batch's durability arm at
    // revision 1) instead of nineteen whole-state writes.
    expect(
      singletonCommitsAfterDuplicatePhase - singletonCommitsAfterKeptBatch,
    ).toBe(2);

    // Five fixed lifecycle commits (see above) plus two heartbeats.
    expect(discoveryCommitSpy.mock.calls.length).toBe(7);

    // Terminal saves still carry the freshest in-memory resume metadata, and
    // accounting stayed additive across the gated sequence. Checkpoints are
    // canonical persistence; mutation responses omit them from display.
    const run = (await repository.getDiscoveryState()).recentRuns[0]!;
    expect(run.state).toBe("completed");
    const execution = run.targetExecutions.find(
      (entry) => entry.targetId === "target_incremental",
    )!;
    expect(execution.jobsReviewed).toBe(1);
    expect(execution.jobsPersisted).toBe(1);
    expect(execution.duplicatesMerged).toBe(0);
    expect(execution.agentCheckpoint?.revision).toBe(20);
  });

  test("a completed run never seeds resume, a repeat search keeps only genuinely new jobs, and a duplicate-only upgrade run finds nothing", async () => {
    const jobA = createCollectedJob({ token: "repeat_a" });
    const jobB = createCollectedJob({ token: "repeat_b" });
    const jobC = createCollectedJob({ token: "repeat_c_new" });
    // A richer re-extraction of the already-retained A identity.
    const richA = createCollectedJob({
      token: "repeat_a",
      description:
        "Upgraded repeat description with delivery outcomes and cross-team scope.",
      responsibilities: ["Lead the roadmap", "Coach partner teams"],
    });

    const seenResumeCheckpoints: Array<
      Parameters<NonNullable<AgentDiscoveryOptions["onCheckpoint"]>>[0] | null
    > = [];
    let runCall = 0;
    const emitRepeatCheckpoint = async (
      options: AgentDiscoveryOptions,
      collectedJobs: ReturnType<typeof JobPostingSchema.parse>[],
      revision: number,
    ): Promise<void> => {
      await emitRuntimeCheckpoint(options, {
        revision,
        savedAt: "2026-03-20T10:00:03.000Z",
        currentUrl: "https://example.com/jobs",
        lastStableUrl: "https://example.com/jobs",
        stepCount: revision * 2,
        collectedJobs,
        visitedUrls: ["https://example.com/jobs"],
        phaseEvidence: createEmptyPhaseEvidence(),
      });
    };
    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      async runAgentDiscovery(source, options) {
        runCall += 1;
        seenResumeCheckpoints.push(options.resumeCheckpoint ?? null);

        if (runCall === 1) {
          await emitRepeatCheckpoint(options, [jobA], 1);
          return {
            source,
            startedAt: "2026-03-20T10:00:00.000Z",
            completedAt: "2026-03-20T10:00:05.000Z",
            querySummary: "First completed repeat-run fixture",
            inventoryCompleteness: "partial" as const,
            warning: null,
            jobs: [jobA, jobB],
            agentMetadata: null,
          };
        }

        if (runCall === 2) {
          // The repeated source lists the same A and B cards again plus one
          // newly available distinct job.
          await emitRepeatCheckpoint(options, [jobA], 1);
          return {
            source,
            startedAt: "2026-03-20T10:05:00.000Z",
            completedAt: "2026-03-20T10:05:05.000Z",
            querySummary: "Second completed repeat-run fixture",
            inventoryCompleteness: "partial" as const,
            warning: null,
            jobs: [jobA, jobB, jobC],
            agentMetadata: null,
          };
        }

        // Duplicate-only third run: just a richer version of retained A.
        return {
          source,
          startedAt: "2026-03-20T10:10:00.000Z",
          completedAt: "2026-03-20T10:10:05.000Z",
          querySummary: "Duplicate-only repeat-run fixture",
          inventoryCompleteness: "partial" as const,
          warning: null,
          jobs: [richA],
          agentMetadata: null,
        };
      },
    };

    const { seed } = createHarness();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );
    await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );
    const snapshot = await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );

    // No run received resume progress: every prior run had completed.
    expect(seenResumeCheckpoints).toEqual([null, null, null]);

    // Second run pinned semantics: two unchanged retained cards were skipped
    // by the ledger and only the one genuinely new job counts as found.
    const repeatRun = snapshot.recentDiscoveryRuns[1]!;
    const repeatExecution = repeatRun.targetExecutions.find(
      (entry) => entry.targetId === "target_incremental",
    )!;
    expect(repeatExecution.jobsSkippedByLedger).toBe(2);
    expect(repeatExecution.jobsFound).toBe(1);
    expect(repeatExecution.jobsPersisted).toBe(1);
    expect(repeatExecution.duplicatesMerged).toBe(0);
    expect(repeatRun.summary.validJobsFound).toBe(1);

    const previousRun = (await workspaceService.getWorkspaceSnapshot())
      .recentDiscoveryRuns[2]!;
    const previousExecution = previousRun.targetExecutions.find(
      (entry) => entry.targetId === "target_incremental",
    )!;
    // Collection finished in the first run: its checkpoint stays recorded for
    // durability but carries no resume rights into later runs.
    expect(previousExecution.state).toBe("completed");
    expect(previousExecution.agentCheckpoint).toMatchObject({ revision: 1 });

    // The second run explored beyond the first checkpoint and kept the newly
    // available distinct job alongside the retained ones; the duplicate-only
    // third run upgraded A in place without adding a row.
    expect(snapshot.discoveryJobs.map((job) => job.sourceJobId).sort()).toEqual(
      [jobA.sourceJobId, jobB.sourceJobId, jobC.sourceJobId].sort(),
    );
    expect(
      snapshot.discoveryJobs.find((job) => job.sourceJobId === jobA.sourceJobId)
        ?.description,
    ).toBe(richA.description);

    const run = snapshot.recentDiscoveryRuns[0]!;
    const execution = run.targetExecutions.find(
      (entry) => entry.targetId === "target_incremental",
    )!;
    // Duplicate-only run: the upgrade merged over the existing retained job
    // (duplicatesMerged), consumed no budget slot, and counted zero found or
    // persisted jobs under distinct-retained semantics.
    expect(execution.jobsReviewed).toBe(1);
    expect(execution.jobsFound).toBe(0);
    expect(execution.jobsPersisted).toBe(0);
    expect(execution.duplicatesMerged).toBe(1);
    expect(run.summary.validJobsFound).toBe(0);
    expect(run.summary.jobsPersisted).toBe(0);
    expect(run.summary.duplicatesMerged).toBe(1);
  });

  test("a cancelled run stays resumable and a resumed run counts only its own additions", async () => {
    const jobA = createCollectedJob({ token: "resume_a" });
    const jobB = createCollectedJob({ token: "resume_b_new" });

    const seenResumeCheckpoints: Array<
      Parameters<NonNullable<AgentDiscoveryOptions["onCheckpoint"]>>[0] | null
    > = [];
    let runCall = 0;
    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      async runAgentDiscovery(source, options) {
        runCall += 1;
        seenResumeCheckpoints.push(options.resumeCheckpoint ?? null);

        if (runCall === 1) {
          await emitRuntimeCheckpoint(options, {
            revision: 1,
            savedAt: "2026-03-20T10:00:03.000Z",
            currentUrl: "https://example.com/jobs?page=2",
            lastStableUrl: "https://example.com/jobs?page=2",
            stepCount: 2,
            collectedJobs: [jobA],
            visitedUrls: ["https://example.com/jobs?page=2"],
            phaseEvidence: createEmptyPhaseEvidence(),
          });
          throw new DOMException("Aborted", "AbortError");
        }

        // The resumed attempt replays the carried-over listing and finds one
        // newly available distinct job.
        await emitRuntimeCheckpoint(options, {
          revision: 2,
          savedAt: "2026-03-20T10:05:03.000Z",
          currentUrl: "https://example.com/jobs?page=2",
          lastStableUrl: "https://example.com/jobs?page=2",
          stepCount: 4,
          collectedJobs: [jobA],
          visitedUrls: ["https://example.com/jobs?page=2"],
          phaseEvidence: createEmptyPhaseEvidence(),
        });
        return {
          source,
          startedAt: "2026-03-20T10:05:00.000Z",
          completedAt: "2026-03-20T10:05:05.000Z",
          querySummary: "Resumed repeat-run fixture",
          inventoryCompleteness: "partial" as const,
          warning: null,
          jobs: [jobA, jobB],
          agentMetadata: null,
        };
      },
    };

    const { seed } = createHarness();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    // The cancelled run's own feedback summary already used the distinct
    // retained count: one checkpoint-committed job, zero duplicates.
    const cancelledSnapshot = await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );
    const cancelledRun = cancelledSnapshot.recentDiscoveryRuns[0]!;
    expect(cancelledRun.state).toBe("cancelled");
    expect(cancelledRun.summary.validJobsFound).toBe(1);
    expect(cancelledRun.summary.jobsPersisted).toBe(1);
    const cancelledExecution = cancelledRun.targetExecutions.find(
      (entry) => entry.targetId === "target_incremental",
    )!;
    expect(cancelledExecution.jobsFound).toBe(1);
    expect(cancelledExecution.duplicatesMerged).toBe(0);

    const snapshot = await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );

    // Only the interrupted prior run seeded process progress into the retry.
    expect(seenResumeCheckpoints[0]).toBeNull();
    expect(seenResumeCheckpoints[1]).toMatchObject({
      stepCount: 2,
      collectedJobs: [{ sourceJobId: jobA.sourceJobId }],
    });

    // The resumed run kept the newly available job without re-keeping or
    // double-counting the carried-over listing.
    expect(snapshot.discoveryJobs.map((job) => job.sourceJobId).sort()).toEqual(
      [jobA.sourceJobId, jobB.sourceJobId].sort(),
    );

    const run = snapshot.recentDiscoveryRuns[0]!;
    const execution = run.targetExecutions.find(
      (entry) => entry.targetId === "target_incremental",
    )!;
    expect(execution.state).toBe("completed");
    expect(execution.jobsSkippedByLedger).toBe(1);
    expect(execution.jobsFound).toBe(1);
    expect(execution.jobsPersisted).toBe(1);
    expect(execution.duplicatesMerged).toBe(0);
    expect(run.summary.validJobsFound).toBe(1);
    expect(run.summary.jobsPersisted).toBe(1);
  });

  // A search stopped long ago must not seed later searches: a later finished
  // search of the source replaces it, and another plan's stopped search was
  // never this plan's progress.
  function stoppedThenFinishingRuntime(seen: unknown[]): BrowserSessionRuntime {
    let runCall = 0;
    return {
      ...createAgentBrowserRuntime([]),
      async runAgentDiscovery(source, options) {
        runCall += 1;
        seen.push(options.resumeCheckpoint ?? null);
        if (runCall === 1) {
          await emitRuntimeCheckpoint(options, {
            revision: 1,
            savedAt: "2026-03-20T10:00:03.000Z",
            currentUrl: "https://example.com/jobs?page=2",
            lastStableUrl: "https://example.com/jobs?page=2",
            stepCount: 2,
            collectedJobs: [createCollectedJob({ token: "stale_a" })],
            visitedUrls: ["https://example.com/jobs?page=2"],
            phaseEvidence: createEmptyPhaseEvidence(),
          });
          throw new DOMException("Aborted", "AbortError");
        }
        return {
          source,
          startedAt: "2026-03-20T10:05:00.000Z",
          completedAt: "2026-03-20T10:05:05.000Z",
          querySummary: "Finished fixture",
          inventoryCompleteness: "partial" as const,
          warning: null,
          jobs: [],
          agentMetadata: null,
        };
      },
    };
  }

  test("a finished search of the source ends an older stopped search's resume", async () => {
    const seen: unknown[] = [];
    const { seed } = createHarness();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: stoppedThenFinishingRuntime(seen),
      aiClient: createAgentAiClient(),
    });
    for (let search = 0; search < 3; search += 1)
      await workspaceService.runDiscoveryForTarget(
        "target_incremental",
        () => {},
        new AbortController().signal,
      );
    expect(seen[1]).toMatchObject({ stepCount: 2 });
    expect(seen[2]).toBeNull();
  });

  test("another plan's stopped search never seeds this plan's search", async () => {
    const seen: unknown[] = [];
    const { seed } = createHarness();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: stoppedThenFinishingRuntime(seen),
      aiClient: createAgentAiClient(),
    });
    await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );
    const before = await workspaceService.getWorkspaceSnapshot();
    const created = await workspaceService.saveCampaign(
      SaveJobSearchCampaignInputSchema.parse({
        ...before.campaigns[0]!,
        id: null,
        name: "Another plan",
      }),
    );
    await workspaceService.selectCampaign(
      created.campaigns.find((plan) => plan.name === "Another plan")!.id,
    );
    await workspaceService.runDiscoveryForTarget(
      "target_incremental",
      () => {},
      new AbortController().signal,
    );
    expect(seen[1]).toBeNull();
  });
});
