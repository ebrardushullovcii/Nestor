import type { JudgeJobFitsInput } from "@nordri/ai-providers";
import type { BrowserSessionRuntime } from "@nordri/browser-runtime";
import {
  JobPostingSchema,
  SavedJobSchema,
  type DiscoveryActivityEvent,
} from "@nordri/contracts";
import { describe, expect, test, vi } from "vitest";
import {
  createAgentAiClient,
  createAgentBrowserRuntime,
  createAiClient,
  createSeed,
  createSourceInstructionArtifact,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

/**
 * Stands in for the model judging jobs before "Best matches only" keeps them
 * (ADR 0041): a title it accepts is a fit; anything else is another role.
 */
function judgeByTitle(fits: (title: string) => boolean) {
  return (input: JudgeJobFitsInput) =>
    Promise.resolve(
      input.jobs.map(({ jobId, posting }) => {
        const fit = fits(posting.title);
        return {
          jobId,
          score: fit ? 80 : 15,
          recommendation: fit ? ("strong_fit" as const) : ("skip" as const),
          role: fit ? ("exact" as const) : ("conflict" as const),
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
    );
}

function createDiscoveryOnlySeed() {
  return {
    ...createSeed(),
    settings: {
      resumeFormat: "pdf" as const,
      resumeTemplateId: "classic_ats" as const,
      fontPreset: "inter_requisite" as const,
      appearanceTheme: "system" as const,
      humanReviewRequired: true,
      allowAutoSubmitOverride: false,
      keepSessionAlive: true,
      discoveryOnly: true,
    },
    savedJobs: [],
    tailoredAssets: [],
    resumeDrafts: [],
    resumeDraftRevisions: [],
    resumeExportArtifacts: [],
    resumeResearchArtifacts: [],
    resumeValidationResults: [],
    resumeAssistantMessages: [],
    applicationRecords: [],
    applicationAttempts: [],
  };
}

describe("createJobFinderWorkspaceService", () => {
  test("refreshes saved-job match evidence even when discovery does not rediscover that posting", async () => {
    const seed = createSeed();
    seed.profile.workEligibility = {
      ...seed.profile.workEligibility,
      remoteEligible: null,
    };
    seed.searchPreferences.workModes = ["remote"];
    const existingJob = seed.savedJobs[0]!;
    seed.savedJobs[0] = SavedJobSchema.parse({
      ...existingJob,
      location: "Remote",
      workMode: ["remote"],
      matchAssessment: {
        ...existingJob.matchAssessment,
        reasons: ["stale assessment sentinel"],
      },
    });

    const { workspaceService } = createWorkspaceServiceHarness({ seed });
    const snapshot = await workspaceService.runDiscovery();
    const refreshed = snapshot.discoveryJobs.find(
      (job) => job.id === existingJob.id,
    );
    expect(refreshed?.matchAssessment.reasons).not.toContain(
      "stale assessment sentinel",
    );
    // No model has judged it under the new goals yet, so it says so rather
    // than carrying a rule verdict (ADR 0041).
    expect(refreshed?.matchAssessment.recommendationRationale).toMatch(
      /^Not judged yet/u,
    );
  });

  test("starts independent public provider inventories concurrently", async () => {
    const seed = createDiscoveryOnlySeed();
    seed.searchPreferences.targetRoles = ["Software Engineer"];
    seed.searchPreferences.locations = [];
    seed.searchPreferences.workModes = [];
    seed.searchPreferences.discovery.targets = [
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_public_one",
        label: "Remote Greenhouse",
        startingUrl: "https://job-boards.greenhouse.io/remote",
      },
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_public_two",
        label: "Aircall Lever",
        startingUrl: "https://jobs.lever.co/aircall",
      },
    ];

    const responses: Array<(response: Response) => void> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          responses.push(resolve);
        }),
    );
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: createAgentBrowserRuntime([]),
      aiClient: createAiClient(),
    });

    try {
      const runPromise = workspaceService.runAgentDiscovery(
        () => {},
        new AbortController().signal,
      );

      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
      responses[0]!({
        ok: true,
        json: () =>
          Promise.resolve({
            jobs: [
              {
                id: "greenhouse_concurrent",
                title: "Software Engineer",
                absolute_url:
                  "https://job-boards.greenhouse.io/remote/jobs/greenhouse_concurrent",
                location: { name: "Remote" },
                content: "Build reliable software products.",
              },
            ],
          }),
      } as Response);
      responses[1]!({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              id: "lever_concurrent",
              text: "Software Engineer",
              hostedUrl: "https://jobs.lever.co/aircall/lever_concurrent",
              descriptionPlain: "Build reliable software products.",
              categories: { location: "Remote" },
            },
          ]),
      } as Response);

      const snapshot = await runPromise;
      expect(snapshot.discoveryJobs).toHaveLength(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("runs discovery and upserts saved jobs from the adapter", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        savedJobs: [],
        tailoredAssets: [],
        resumeDrafts: [],
        resumeDraftRevisions: [],
        resumeExportArtifacts: [],
        resumeResearchArtifacts: [],
        resumeValidationResults: [],
        resumeAssistantMessages: [],
        applicationRecords: [],
        applicationAttempts: [],
      },
    });

    const snapshot = await workspaceService.runDiscovery();

    expect(snapshot.discoveryJobs).toHaveLength(2);
    expect(
      snapshot.discoveryJobs.some((job) =>
        job.canonicalUrl.includes("linkedin_signal_ready"),
      ),
    ).toBe(true);
    expect(snapshot.discoveryJobs[0]?.matchAssessment.judgment ?? null).toBe(
      null,
    );
  });

  test("runDiscovery uses the non-agent browser runtime path even when agent discovery is available", async () => {
    let runDiscoveryCalls = 0;
    let runAgentDiscoveryCalls = 0;
    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      runDiscovery(source) {
        runDiscoveryCalls += 1;
        return Promise.resolve({
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "Standard discovery run",
          inventoryCompleteness: "complete",
          warning: null,
          jobs: [
            JobPostingSchema.parse({
              source: "target_site",
              sourceJobId: "standard_job_1",
              discoveryMethod: "catalog_seed",
              canonicalUrl: "https://example.com/jobs/standard-job-1",
              title: "Senior Product Designer",
              company: "Signal Systems",
              location: "Remote",
              workMode: ["remote"],
              applyPath: "easy_apply",
              easyApplyEligible: true,
              postedAt: "2026-03-20T09:00:00.000Z",
              postedAtText: null,
              discoveredAt: "2026-03-20T10:04:00.000Z",
              salaryText: "$180k - $220k",
              summary: "Own the design system.",
              description: "Own the design system and workflow platform.",
              keySkills: ["Figma", "Design Systems"],
              responsibilities: [],
              minimumQualifications: [],
              preferredQualifications: [],
              seniority: null,
              employmentType: null,
              department: null,
              team: null,
              employerWebsiteUrl: null,
              employerDomain: null,
              benefits: [],
            }),
          ],
          agentMetadata: null,
        });
      },
      runAgentDiscovery(source) {
        runAgentDiscoveryCalls += 1;
        return Promise.resolve({
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "Agent discovery run",
          inventoryCompleteness: "partial",
          warning: null,
          jobs: [],
          agentMetadata: {
            steps: 0,
            incomplete: false,
            transcriptMessageCount: 0,
            reviewTranscript: [],
            compactionState: null,
            compactionUsedFallbackTrigger: false,
            phaseCompletionMode: null,
            phaseCompletionReason: null,
            phaseEvidence: null,
            debugFindings: null,
          },
        });
      },
    };

    const { workspaceService } = createWorkspaceServiceHarness({
      seed: createDiscoveryOnlySeed(),
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.runDiscovery();

    expect(runDiscoveryCalls).toBe(1);
    expect(runAgentDiscoveryCalls).toBe(0);
    expect(snapshot.discoveryJobs).toHaveLength(1);
    expect(snapshot.discoveryJobs[0]?.sourceJobId).toBe("standard_job_1");
  });

  test("discovery-only mode treats jobs as pending and does not persist to saved jobs", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: createDiscoveryOnlySeed(),
    });

    const snapshot = await workspaceService.runDiscovery();

    expect(snapshot.discoveryJobs).toHaveLength(2);
    expect(snapshot.discoveryJobs[0]?.status).toBe("discovered");
    expect(snapshot.discoveryJobs[0]?.provenance).toHaveLength(1);
    expect(snapshot.reviewQueue).toHaveLength(0);
    await expect(repository.listSavedJobs()).resolves.toHaveLength(0);
    expect(snapshot.applicationRecords).toHaveLength(0);
    expect(snapshot.applicationAttempts).toHaveLength(0);

    const secondSnapshot = await workspaceService.runDiscovery();

    expect(secondSnapshot.discoveryJobs).toHaveLength(2);
    expect(
      secondSnapshot.discoveryJobs.filter(
        (job) => job.sourceJobId === "linkedin_signal_ready",
      ),
    ).toHaveLength(1);
    expect(secondSnapshot.discoveryJobs[0]?.provenance).toHaveLength(1);
    expect(secondSnapshot.reviewQueue).toHaveLength(0);
    await expect(repository.listSavedJobs()).resolves.toHaveLength(0);
  });

  test("removeJobFromReview moves a shortlisted review job back to Find jobs", async () => {
    const seed = createSeed();
    seed.savedJobs.push(
      SavedJobSchema.parse({
        source: "target_site",
        sourceJobId: "review_return_job",
        discoveryMethod: "catalog_seed",
        collectionMethod: "fallback_search",
        canonicalUrl: "https://example.com/jobs/review-return-job",
        applicationUrl: null,
        id: "job_review_return",
        title: "Staff Product Designer",
        company: "Signal Systems",
        location: "Remote",
        workMode: ["remote"],
        applyPath: "easy_apply",
        easyApplyEligible: true,
        postedAt: "2026-03-20T09:30:00.000Z",
        postedAtText: null,
        discoveredAt: "2026-03-20T10:04:00.000Z",
        firstSeenAt: null,
        lastSeenAt: null,
        lastVerifiedActiveAt: null,
        salaryText: "$185k - $210k",
        normalizedCompensation: {},
        summary: "Lead systems design work.",
        description: "Lead systems design work.",
        keySkills: ["Figma", "Systems Design"],
        responsibilities: [],
        minimumQualifications: [],
        preferredQualifications: [],
        seniority: "Staff",
        employmentType: "Full-time",
        department: null,
        team: null,
        employerWebsiteUrl: null,
        employerDomain: null,
        atsProvider: null,
        providerKey: null,
        providerBoardToken: null,
        providerIdentifier: null,
        titleTriageOutcome: "pass",
        sourceIntelligence: null,
        screeningHints: {},
        keywordSignals: [],
        benefits: [],
        status: "ready_for_review",
        matchAssessment: {
          score: 91,
          reasons: ["Strong systems match"],
          gaps: [],
        },
        provenance: [],
      }),
    );

    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
    });

    const snapshot =
      await workspaceService.removeJobFromReview("job_review_return");
    const savedJobs = await repository.listSavedJobs();

    expect(
      snapshot.reviewQueue.some((item) => item.jobId === "job_review_return"),
    ).toBe(false);
    expect(
      snapshot.discoveryJobs.some((job) => job.id === "job_review_return"),
    ).toBe(true);
    expect(
      savedJobs.find((job) => job.id === "job_review_return")?.status,
    ).toBe("shortlisted");
  });

  test("agent discovery streams activity and keeps discovery-only jobs pending", async () => {
    const seed = createDiscoveryOnlySeed();
    const catalog =
      await createWorkspaceServiceHarness().browserRuntime.runDiscovery(
        "target_site",
        createSeed().searchPreferences,
      );
    const baseAgentRuntime = createAgentBrowserRuntime(catalog.jobs);
    let openSessionCalls = 0;
    let closeSessionCalls = 0;
    const browserRuntime: BrowserSessionRuntime = {
      ...baseAgentRuntime,
      openSession(source, options) {
        openSessionCalls += 1;
        return baseAgentRuntime.openSession(source, options);
      },
      closeSession(source) {
        closeSessionCalls += 1;
        return baseAgentRuntime.closeSession(source);
      },
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });
    const streamedEvents: DiscoveryActivityEvent[] = [];

    const snapshot = await workspaceService.runAgentDiscovery((event) => {
      streamedEvents.push(event);
    }, new AbortController().signal);

    expect(streamedEvents.length).toBeGreaterThan(0);
    expect(streamedEvents.some((event) => event.kind === "progress")).toBe(
      true,
    );
    expect(snapshot.discoveryJobs).toHaveLength(2);
    expect(
      snapshot.discoveryJobs.every((job) => job.status === "discovered"),
    ).toBe(true);
    expect(snapshot.reviewQueue).toHaveLength(0);
    await expect(repository.listSavedJobs()).resolves.toHaveLength(0);
    expect(snapshot.applicationRecords).toHaveLength(0);
    expect(snapshot.applicationAttempts).toHaveLength(0);
    expect(openSessionCalls).toBe(1);
    expect(closeSessionCalls).toBe(0);
    expect(snapshot.recentDiscoveryRuns[0]?.summary.browserCloseout?.mode).toBe(
      "kept_alive",
    );
    expect(
      snapshot.recentDiscoveryRuns[0]?.summary.timing?.eventCount,
    ).toBeGreaterThan(0);
    expect(
      snapshot.recentDiscoveryRuns[0]?.summary.timing?.firstActivityMs,
    ).not.toBeNull();
    expect(
      snapshot.recentDiscoveryRuns[0]?.targetExecutions[0]?.timing?.eventCount,
    ).toBeGreaterThan(0);
  });

  test("strict discovery does not rescue technical titles outside the saved specialization", async () => {
    const seed = {
      ...createDiscoveryOnlySeed(),
      profile: {
        ...createDiscoveryOnlySeed().profile,
        headline: "Senior Full-Stack Software Engineer",
        targetRoles: ["Senior Full-Stack Software Engineer"],
        locations: ["Prishtina, Kosovo"],
      },
      searchPreferences: {
        ...createDiscoveryOnlySeed().searchPreferences,
        targetRoles: ["Senior Full-Stack Software Engineer"],
        locations: ["Prishtina, Kosovo"],
        discovery: {
          ...createDiscoveryOnlySeed().searchPreferences.discovery,
          collectOnlyHardCriteriaMatches: true,
        },
      },
    };
    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      runAgentDiscovery(source) {
        return Promise.resolve({
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "LinkedIn discovery triage sample run",
          inventoryCompleteness: "partial",
          warning: null,
          jobs: [
            JobPostingSchema.parse({
              source: "target_site",
              sourceJobId: "frontend_1",
              discoveryMethod: "browser_agent",
              collectionMethod: "listing_route",
              canonicalUrl: "https://www.linkedin.com/jobs/view/frontend_1",
              title: "Senior Frontend Engineer",
              company: "Fresha",
              location: "Prishtina, Kosovo",
              workMode: ["onsite"],
              applyPath: "unknown",
              easyApplyEligible: false,
              postedAt: "2026-03-20T09:00:00.000Z",
              postedAtText: null,
              discoveredAt: "2026-03-20T10:04:00.000Z",
              salaryText: null,
              summary: "Frontend role",
              description: "Frontend role",
              keySkills: [],
              responsibilities: [],
              minimumQualifications: [],
              preferredQualifications: [],
              seniority: null,
              employmentType: null,
              department: null,
              team: null,
              employerWebsiteUrl: null,
              employerDomain: null,
              benefits: [],
            }),
            JobPostingSchema.parse({
              source: "target_site",
              sourceJobId: "ai_1",
              discoveryMethod: "browser_agent",
              collectionMethod: "listing_route",
              canonicalUrl: "https://www.linkedin.com/jobs/view/ai_1",
              title: "Software Engineer - AI products",
              company: "Quik Hire Staffing",
              location: "Remote",
              workMode: ["remote"],
              applyPath: "unknown",
              easyApplyEligible: false,
              postedAt: "2026-03-20T09:00:00.000Z",
              postedAtText: null,
              discoveredAt: "2026-03-20T10:04:00.000Z",
              salaryText: null,
              summary: "AI role",
              description: "AI role",
              keySkills: [],
              responsibilities: [],
              minimumQualifications: [],
              preferredQualifications: [],
              seniority: null,
              employmentType: null,
              department: null,
              team: null,
              employerWebsiteUrl: null,
              employerDomain: null,
              benefits: [],
            }),
          ],
          agentMetadata: {
            steps: 4,
            incomplete: false,
            transcriptMessageCount: 4,
            reviewTranscript: [],
            compactionState: null,
            compactionUsedFallbackTrigger: false,
            phaseCompletionMode: null,
            phaseCompletionReason: null,
            phaseEvidence: null,
            debugFindings: null,
          },
        });
      },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      // The model judged both outside the saved full-stack specialization.
      aiClient: {
        ...createAgentAiClient(),
        judgeJobFits: judgeByTitle(() => false),
      },
    });
    const streamedEvents: DiscoveryActivityEvent[] = [];

    const snapshot = await workspaceService.runAgentDiscovery((event) => {
      streamedEvents.push(event);
    }, new AbortController().signal);

    const collectionEvent = streamedEvents.find(
      (event) =>
        event.stage === "extraction" &&
        event.message.includes("Collected 2 candidate jobs"),
    );
    const scoringEvent = streamedEvents.find(
      (event) => event.stage === "scoring",
    );

    expect(scoringEvent).toBeDefined();
    expect(collectionEvent?.message).toContain(
      '"Senior Frontend Engineer at Fresha"',
    );
    expect(collectionEvent?.message).toContain(
      '"Software Engineer - AI products at Quik Hire Staffing"',
    );
    expect(scoringEvent?.jobsFound).toBe(0);
    expect(snapshot.discoveryJobs).toHaveLength(0);
    expect(snapshot.recentDiscoveryRuns[0]?.targetExecutions[0]).toMatchObject({
      jobsFound: 0,
      jobsSkippedByTitleTriage: 2,
    });
  });

  test("agent discovery persists lightweight compaction metadata without persisting raw transcripts on target executions", async () => {
    const seed = createDiscoveryOnlySeed();
    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      runAgentDiscovery(source) {
        return Promise.resolve({
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "Compaction metadata discovery run",
          inventoryCompleteness: "partial",
          warning: null,
          jobs: [],
          agentMetadata: {
            steps: 6,
            incomplete: false,
            transcriptMessageCount: 5,
            reviewTranscript: ["assistant: hidden raw transcript line"],
            compactionState: {
              compactedAt: "2026-03-20T10:00:03.000Z",
              compactionCount: 1,
              triggerKind: "token_budget",
              estimatedTokensBefore: 132000,
              estimatedTokensAfter: 76000,
              summary: "Compacted worker transcript before budget exhaustion.",
              confirmedFacts: ["Visited 4 pages."],
              blockerNotes: [],
              avoidStrategyFingerprints: [
                "search_filter_probe:target_site:search filter probe",
              ],
              preservedContext: ["Principal Designer at Acme"],
              stickyWorkflowState: ["Phase goal: Find jobs"],
            },
            compactionUsedFallbackTrigger: false,
            phaseCompletionMode: null,
            phaseCompletionReason: null,
            phaseEvidence: null,
            debugFindings: null,
          },
        });
      },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.runAgentDiscovery(
      () => {},
      new AbortController().signal,
    );

    const targetExecution =
      snapshot.recentDiscoveryRuns[0]?.targetExecutions[0];
    expect(targetExecution?.compactionState?.compactionCount).toBe(1);
    expect(targetExecution?.compactionState?.triggerKind).toBe("token_budget");
    expect(targetExecution?.compactionUsedFallbackTrigger).toBe(false);
    expect(JSON.stringify(targetExecution)).not.toContain(
      "hidden raw transcript line",
    );
  });

  test("agent discovery abort keeps streamed activity and avoids persistence", async () => {
    const discoveryResult =
      await createWorkspaceServiceHarness().browserRuntime.runDiscovery(
        "target_site",
        createSeed().searchPreferences,
      );
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: createDiscoveryOnlySeed(),
      browserRuntime: createAgentBrowserRuntime(discoveryResult.jobs),
      aiClient: createAgentAiClient(),
    });
    const streamedEvents: DiscoveryActivityEvent[] = [];
    const controller = new AbortController();

    const snapshot = await workspaceService.runAgentDiscovery((event) => {
      streamedEvents.push(event);
      if (event.kind === "progress") {
        controller.abort();
      }
    }, controller.signal);

    expect(streamedEvents.some((event) => event.kind === "progress")).toBe(
      true,
    );
    expect(snapshot.discoveryJobs).toHaveLength(0);
    expect(snapshot.reviewQueue).toHaveLength(0);
    await expect(repository.listSavedJobs()).resolves.toHaveLength(0);
    expect(snapshot.applicationRecords).toHaveLength(0);
    expect(snapshot.applicationAttempts).toHaveLength(0);
  });

  test("shutdown aborts an in-flight discovery run before closing persistence", async () => {
    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      async runAgentDiscovery(source, options) {
        options.onProgress?.({
          currentUrl: options.startingUrls[0] ?? "https://example.com/jobs",
          jobsFound: 0,
          stepCount: 1,
          currentAction: "navigate",
          targetId: null,
          adapterKind: source,
        });

        if (!options.signal?.aborted) {
          await new Promise<void>((resolve) => {
            options.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        }

        throw new DOMException("Aborted", "AbortError");
      },
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: createDiscoveryOnlySeed(),
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const discoveryPromise = workspaceService.runAgentDiscovery(() => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await expect(workspaceService.shutdown()).resolves.toBeUndefined();

    const snapshot = await discoveryPromise;
    const discoveryState = await repository.getDiscoveryState();

    expect(snapshot.activeDiscoveryRun).toBeNull();
    expect(snapshot.recentDiscoveryRuns[0]?.state).toBe("cancelled");
    expect(discoveryState.activeRun).toBeNull();
    expect(discoveryState.recentRuns[0]?.state).toBe("cancelled");
  });

  test("agent discovery fails honestly when the configured AI client lacks tool calling", async () => {
    const discoveryResult =
      await createWorkspaceServiceHarness().browserRuntime.runDiscovery(
        "target_site",
        createSeed().searchPreferences,
      );
    const baseAgentRuntime = createAgentBrowserRuntime(discoveryResult.jobs);
    const browserRuntime: BrowserSessionRuntime = {
      ...baseAgentRuntime,
      runAgentDiscovery(source, options) {
        return Promise.resolve({
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "Agent discovery test run",
          inventoryCompleteness: "partial",
          warning: options.aiClient?.chatWithTools
            ? null
            : "AI client does not support tool calling. Cannot run agent discovery.",
          jobs: [],
          agentMetadata: null,
        });
      },
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: createDiscoveryOnlySeed(),
      browserRuntime,
      aiClient: createAiClient(),
    });

    await expect(
      workspaceService.runAgentDiscovery(
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      "AI client does not support tool calling. Cannot run agent discovery.",
    );

    const discoveryState = await repository.getDiscoveryState();
    expect(discoveryState.recentRuns[0]?.state).toBe("failed");
    expect(discoveryState.recentRuns[0]?.targetExecutions[0]?.warning).toBe(
      "AI client does not support tool calling. Cannot run agent discovery.",
    );
  });

  test("agent discovery budgets remaining jobs across multiple targets", async () => {
    const seed = createDiscoveryOnlySeed();
    seed.searchPreferences.discovery.targets = [
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_one",
        label: "Target One",
        startingUrl: "https://example.com/jobs/one",
      },
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_two",
        label: "Target Two",
        startingUrl: "https://example.com/jobs/two",
      },
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_three",
        label: "Target Three",
        startingUrl: "https://example.com/jobs/three",
      },
    ];

    const capturedBudgets: Array<{ targetJobCount: number; maxSteps: number }> =
      [];
    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      runAgentDiscovery(source, options) {
        capturedBudgets.push({
          targetJobCount: options.targetJobCount,
          maxSteps: options.maxSteps,
        });

        return Promise.resolve({
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "Budgeted discovery test run",
          inventoryCompleteness: "partial",
          warning: null,
          jobs: Array.from({ length: options.targetJobCount }, (_, index) =>
            JobPostingSchema.parse({
              source: "target_site",
              sourceJobId: `${options.startingUrls[0]}_${index}`,
              discoveryMethod: "browser_agent",
              canonicalUrl: `https://example.com/job/${capturedBudgets.length}-${index}`,
              title: `Principal Designer ${capturedBudgets.length}-${index}`,
              company: "Acme",
              location: "Remote",
              workMode: ["remote"],
              applyPath: "unknown",
              easyApplyEligible: false,
              postedAt: null,
              postedAtText: null,
              discoveredAt: "2026-03-20T10:00:00.000Z",
              salaryText: null,
              summary: "Grounded summary",
              description: "Grounded description",
              keySkills: ["React"],
              responsibilities: [],
              minimumQualifications: [],
              preferredQualifications: [],
              seniority: null,
              employmentType: null,
              department: null,
              team: null,
              employerWebsiteUrl: null,
              employerDomain: null,
              benefits: [],
            }),
          ),
          agentMetadata: {
            steps: 2,
            incomplete: false,
            transcriptMessageCount: 4,
            reviewTranscript: [],
            compactionState: null,
            compactionUsedFallbackTrigger: false,
            phaseCompletionMode: null,
            phaseCompletionReason: null,
            phaseEvidence: null,
            debugFindings: null,
          },
        });
      },
    };

    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAiClient(),
    });

    const snapshot = await workspaceService.runAgentDiscovery(
      () => {},
      new AbortController().signal,
    );

    expect(capturedBudgets).toEqual([
      { targetJobCount: 34, maxSteps: 120 },
      { targetJobCount: 33, maxSteps: 120 },
      { targetJobCount: 33, maxSteps: 120 },
    ]);
    expect(snapshot.recentDiscoveryRuns[0]?.summary.validJobsFound).toBe(100);
  });

  test("accounts for duplicate observations within explicit source budgets", async () => {
    const seed = createDiscoveryOnlySeed();
    seed.searchPreferences.discovery.runJobBudget = 100;
    seed.searchPreferences.discovery.targets = [
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_duplicate_heavy",
        label: "Duplicate-heavy source",
        startingUrl: "https://example.com/jobs/duplicates",
      },
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_later_new",
        label: "Later new source",
        startingUrl: "https://example.com/jobs/later-new",
      },
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_final_new",
        label: "Final new source",
        startingUrl: "https://example.com/jobs/final-new",
      },
    ];

    const capturedBudgets: number[] = [];
    let targetCall = 0;
    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      runAgentDiscovery(source, options) {
        targetCall += 1;
        capturedBudgets.push(options.targetJobCount);
        const jobs = Array.from(
          { length: options.targetJobCount },
          (_, index) => {
            const duplicateIdentity = targetCall === 1;
            const identity = duplicateIdentity
              ? "same-provider-identity"
              : `new-${targetCall}-${index}`;
            return JobPostingSchema.parse({
              source: "target_site",
              sourceJobId: identity,
              discoveryMethod: "browser_agent",
              canonicalUrl: `https://example.com/job/${identity}`,
              title: `Principal Designer ${targetCall}-${index}`,
              company: "Acme",
              location: "Remote",
              workMode: ["remote"],
              applyPath: "unknown",
              easyApplyEligible: false,
              postedAt: null,
              postedAtText: null,
              discoveredAt: "2026-03-20T10:00:00.000Z",
              salaryText: null,
              summary: "Grounded summary",
              description: "Lead product design and design systems work.",
              keySkills: ["Figma", "Design Systems"],
              responsibilities: [],
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
          },
        );

        return Promise.resolve({
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "Distinct-retained discovery budget regression",
          inventoryCompleteness: "partial",
          warning: null,
          jobs,
          agentMetadata: {
            steps: 2,
            incomplete: false,
            transcriptMessageCount: 4,
            reviewTranscript: [],
            compactionState: null,
            compactionUsedFallbackTrigger: false,
            phaseCompletionMode: null,
            phaseCompletionReason: null,
            phaseEvidence: null,
            debugFindings: null,
          },
        });
      },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAiClient(),
    });

    const snapshot = await workspaceService.runAgentDiscovery(
      () => {},
      new AbortController().signal,
    );
    const run = snapshot.recentDiscoveryRuns[0];

    expect(capturedBudgets).toEqual([33, 33, 34]);
    expect(
      run?.targetExecutions.map((target) => ({
        requestedJobBudget: target.requestedJobBudget,
        jobsReviewed: target.jobsReviewed,
        jobsFound: target.jobsFound,
        jobsStaged: target.jobsStaged,
        jobsSkippedByLedger: target.jobsSkippedByLedger,
        jobsSkippedByTitleTriage: target.jobsSkippedByTitleTriage,
        duplicatesMerged: target.duplicatesMerged,
        invalidSkipped: target.invalidSkipped,
      })),
    ).toEqual([
      {
        requestedJobBudget: 33,
        // jobsReviewed counts every scored/merged observation of the one
        // duplicate identity; jobsFound stays at the distinct retained job.
        jobsReviewed: 33,
        jobsFound: 1,
        jobsStaged: 1,
        jobsSkippedByLedger: 0,
        jobsSkippedByTitleTriage: 0,
        duplicatesMerged: 32,
        invalidSkipped: 0,
      },
      {
        requestedJobBudget: 33,
        jobsReviewed: 33,
        jobsFound: 33,
        jobsStaged: 33,
        jobsSkippedByLedger: 0,
        jobsSkippedByTitleTriage: 0,
        duplicatesMerged: 0,
        invalidSkipped: 0,
      },
      {
        requestedJobBudget: 34,
        jobsReviewed: 34,
        jobsFound: 34,
        jobsStaged: 34,
        jobsSkippedByLedger: 0,
        jobsSkippedByTitleTriage: 0,
        duplicatesMerged: 0,
        invalidSkipped: 0,
      },
    ]);
    expect(
      run?.targetExecutions.map(
        (target) =>
          target.jobsStaged +
          target.jobsPersisted +
          target.duplicatesMerged +
          target.invalidSkipped,
      ),
    ).toEqual(run?.targetExecutions.map((target) => target.jobsReviewed));
    expect(run?.summary).toMatchObject({
      validJobsFound: 68,
      jobsStaged: 68,
      duplicatesMerged: 32,
    });
    expect(snapshot.discoveryJobs).toHaveLength(68);
  });
  test("single-target agent discovery requests a useful batch of jobs", async () => {
    const capturedBudgets: Array<{ targetJobCount: number; maxSteps: number }> =
      [];
    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      runAgentDiscovery(source, options) {
        capturedBudgets.push({
          targetJobCount: options.targetJobCount,
          maxSteps: options.maxSteps,
        });

        return Promise.resolve({
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "Single-target budgeted discovery test run",
          inventoryCompleteness: "partial",
          warning: null,
          jobs: [],
          agentMetadata: {
            steps: 2,
            incomplete: false,
            transcriptMessageCount: 4,
            reviewTranscript: [],
            compactionState: null,
            compactionUsedFallbackTrigger: false,
            phaseCompletionMode: null,
            phaseCompletionReason: null,
            phaseEvidence: null,
            debugFindings: null,
          },
        });
      },
    };

    const { workspaceService } = createWorkspaceServiceHarness({
      seed: createDiscoveryOnlySeed(),
      browserRuntime,
      aiClient: createAiClient(),
    });

    await workspaceService.runAgentDiscovery(
      () => {},
      new AbortController().signal,
      "target_linkedin_default",
    );

    expect(capturedBudgets).toEqual([{ targetJobCount: 50, maxSteps: 120 }]);
  });

  test("single-target agent discovery passes the configured starting url without synthesizing a query route", async () => {
    const capturedStartingUrls: string[][] = [];
    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      runAgentDiscovery(source, options) {
        capturedStartingUrls.push([...options.startingUrls]);

        return Promise.resolve({
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "Configured starting url discovery test run",
          inventoryCompleteness: "partial",
          warning: null,
          jobs: [],
          agentMetadata: {
            steps: 2,
            incomplete: false,
            transcriptMessageCount: 4,
            reviewTranscript: [],
            compactionState: null,
            compactionUsedFallbackTrigger: false,
            phaseCompletionMode: null,
            phaseCompletionReason: null,
            phaseEvidence: null,
            debugFindings: null,
          },
        });
      },
    };
    const seed = createDiscoveryOnlySeed();
    const defaultTarget = seed.searchPreferences.discovery.targets[0];
    if (!defaultTarget) {
      throw new Error("Expected a default discovery target in the test seed.");
    }
    seed.searchPreferences.discovery.targets = [
      {
        ...defaultTarget,
        id: "target_configured_route",
        label: "Configured Board",
        startingUrl: "https://example.com/jobs/search/",
      },
    ];

    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAiClient(),
    });

    await workspaceService.runAgentDiscovery(
      () => {},
      new AbortController().signal,
      "target_configured_route",
    );

    expect(capturedStartingUrls).toEqual([
      ["https://example.com/jobs/search/"],
    ]);
  });

  test("agent discovery makes no single-listing fit calls", async () => {
    const browserRuntime = createAgentBrowserRuntime([
      {
        source: "target_site",
        sourceJobId: "job_alpha",
        discoveryMethod: "browser_agent",
        canonicalUrl: "https://example.com/jobs/alpha",
        title: "Senior Product Designer",
        company: "Signal Systems",
        location: "Remote",
        workMode: ["remote"],
        applyPath: "easy_apply",
        easyApplyEligible: true,
        postedAt: "2026-03-20T09:00:00.000Z",
        discoveredAt: "2026-03-20T10:04:00.000Z",
        salaryText: "$180k - $220k",
        summary: "Own the design system.",
        description: "Own the design system and workflow platform.",
        keySkills: ["Figma", "Design Systems"],
        responsibilities: [],
        minimumQualifications: [],
        preferredQualifications: [],
        seniority: null,
        employmentType: null,
        department: null,
        team: null,
        employerWebsiteUrl: null,
        employerDomain: null,
        benefits: [],
      },
    ]);
    let assessJobFitCalls = 0;
    const aiClient = {
      ...createAiClient(),
      assessJobFit() {
        assessJobFitCalls += 1;
        return Promise.resolve({
          score: 12,
          reasons: ["Should not be used"],
          gaps: [],
        });
      },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: createDiscoveryOnlySeed(),
      browserRuntime,
      aiClient,
    });

    const snapshot = await workspaceService.runAgentDiscovery(
      () => {},
      new AbortController().signal,
    );

    expect(assessJobFitCalls).toBe(0);
    expect(snapshot.discoveryJobs[0]?.matchAssessment.reasons).not.toContain(
      "Should not be used",
    );
  });

  test("agent discovery limits an over-producing source to its fair share and still runs later targets", async () => {
    const seed = createDiscoveryOnlySeed();
    seed.searchPreferences.discovery.runJobBudget = 100;
    seed.searchPreferences.discovery.targets = [
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_one",
        label: "Target One",
        startingUrl: "https://example.com/jobs/one",
      },
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_two",
        label: "Target Two",
        startingUrl: "https://example.com/jobs/two",
      },
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_three",
        label: "Target Three",
        startingUrl: "https://example.com/jobs/three",
      },
    ];

    let runAgentDiscoveryCalls = 0;
    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      runAgentDiscovery(source) {
        runAgentDiscoveryCalls += 1;
        const callNumber = runAgentDiscoveryCalls;

        return Promise.resolve({
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "Early-stop discovery test run",
          inventoryCompleteness: "partial",
          warning: null,
          jobs: Array.from({ length: 200 }, (_, index) =>
            JobPostingSchema.parse({
              source: "target_site",
              sourceJobId: `job_${callNumber}_${index}`,
              discoveryMethod: "browser_agent",
              canonicalUrl: `https://example.com/job/${callNumber}/${index}`,
              title: `Principal Designer ${callNumber}-${index}`,
              company: "Acme",
              location: "Remote",
              workMode: ["remote"],
              applyPath: "unknown",
              easyApplyEligible: false,
              postedAt: null,
              postedAtText: null,
              discoveredAt: "2026-03-20T10:00:00.000Z",
              salaryText: null,
              summary: "Grounded summary",
              description: "Grounded description",
              keySkills: ["React"],
              responsibilities: [],
              minimumQualifications: [],
              preferredQualifications: [],
              seniority: null,
              employmentType: null,
              department: null,
              team: null,
              employerWebsiteUrl: null,
              employerDomain: null,
              benefits: [],
            }),
          ),
          agentMetadata: {
            steps: 2,
            incomplete: false,
            transcriptMessageCount: 4,
            reviewTranscript: [],
            compactionState: null,
            compactionUsedFallbackTrigger: false,
            phaseCompletionMode: null,
            phaseCompletionReason: null,
            phaseEvidence: null,
            debugFindings: null,
          },
        });
      },
    };

    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAiClient(),
    });

    const snapshot = await workspaceService.runAgentDiscovery(
      () => {},
      new AbortController().signal,
    );

    expect(runAgentDiscoveryCalls).toBe(3);
    expect(
      snapshot.recentDiscoveryRuns[0]?.targetExecutions.map(
        (entry) => entry.state,
      ),
    ).toEqual(["completed", "completed", "completed"]);
    expect(
      snapshot.recentDiscoveryRuns[0]?.targetExecutions.map(
        (entry) => entry.jobsFound,
      ),
    ).toEqual([33, 33, 34]);
    expect(snapshot.recentDiscoveryRuns[0]?.summary.validJobsFound).toBe(100);
  });

  test("applies source budgets after title triage so relevant jobs later in a provider inventory survive", async () => {
    const seed = createDiscoveryOnlySeed();
    seed.searchPreferences.discovery.collectOnlyHardCriteriaMatches = true;
    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      runAgentDiscovery(source) {
        return Promise.resolve({
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "Provider inventory ordering regression",
          inventoryCompleteness: "partial",
          warning: null,
          jobs: Array.from({ length: 12 }, (_, index) =>
            JobPostingSchema.parse({
              source: "target_site",
              sourceJobId: `ordered_job_${index}`,
              discoveryMethod: "browser_agent",
              canonicalUrl: `https://example.com/job/ordered/${index}`,
              title:
                index < 8
                  ? `Account Executive ${index}`
                  : `Principal Designer ${index - 8}`,
              company: "Acme",
              location: "Remote",
              workMode: ["remote"],
              applyPath: "unknown",
              easyApplyEligible: false,
              postedAt: null,
              postedAtText: null,
              discoveredAt: "2026-03-20T10:00:00.000Z",
              salaryText: null,
              summary: "Grounded summary",
              description:
                index < 8
                  ? "Sell workflow software to engineering teams."
                  : "Lead product design and design systems work.",
              keySkills: index < 8 ? [] : ["Figma", "Design Systems"],
              responsibilities: [],
              minimumQualifications: [],
              preferredQualifications: [],
              seniority: null,
              employmentType: null,
              department: null,
              team: null,
              employerWebsiteUrl: null,
              employerDomain: null,
              benefits: [],
            }),
          ),
          agentMetadata: {
            steps: 2,
            incomplete: false,
            transcriptMessageCount: 4,
            reviewTranscript: [],
            compactionState: null,
            compactionUsedFallbackTrigger: false,
            phaseCompletionMode: null,
            phaseCompletionReason: null,
            phaseEvidence: null,
            debugFindings: null,
          },
        });
      },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: {
        ...createAiClient(),
        judgeJobFits: judgeByTitle((title) =>
          title.startsWith("Principal Designer"),
        ),
      },
    });

    const snapshot = await workspaceService.runAgentDiscovery(
      () => {},
      new AbortController().signal,
    );

    expect(snapshot.discoveryJobs).toHaveLength(4);
    expect(
      snapshot.discoveryJobs.every((job) =>
        job.title.startsWith("Principal Designer"),
      ),
    ).toBe(true);
  });

  test("run-all discovery isolates a source exception and continues with the next target", async () => {
    const seed = createDiscoveryOnlySeed();
    seed.searchPreferences.discovery.runJobBudget = 100;
    seed.searchPreferences.discovery.targets = [
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_failing",
        label: "Failing Target",
        startingUrl: "https://failing.example.com/jobs",
      },
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_healthy",
        label: "Healthy Target",
        startingUrl: "https://healthy.example.com/jobs",
      },
    ];

    let runAgentDiscoveryCalls = 0;
    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      runAgentDiscovery(source) {
        runAgentDiscoveryCalls += 1;
        if (runAgentDiscoveryCalls === 1) {
          throw new Error("source navigation failed");
        }

        return Promise.resolve({
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "Healthy source discovery test run",
          inventoryCompleteness: "partial",
          warning: null,
          jobs: [
            JobPostingSchema.parse({
              source: "target_site",
              sourceJobId: "healthy_job_1",
              discoveryMethod: "browser_agent",
              canonicalUrl: "https://healthy.example.com/jobs/healthy-job-1",
              title: "Principal Designer",
              company: "Healthy Co",
              location: "Remote",
              workMode: ["remote"],
              applyPath: "unknown",
              easyApplyEligible: false,
              discoveredAt: "2026-03-20T10:00:00.000Z",
              salaryText: null,
              summary: "Lead product design for a collaborative platform team.",
              description:
                "Lead product design for a collaborative platform team and work closely with engineering and product partners.",
              keySkills: ["Product Design", "Research"],
            }),
          ],
          agentMetadata: null,
        });
      },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAiClient(),
    });

    const snapshot = await workspaceService.runAgentDiscovery(
      () => {},
      new AbortController().signal,
    );
    const run = snapshot.recentDiscoveryRuns[0];

    expect(runAgentDiscoveryCalls).toBe(2);
    expect(run?.state).toBe("completed");
    expect(run?.targetExecutions.map((entry) => entry.state)).toEqual([
      "failed",
      "completed",
    ]);
    expect(run?.targetExecutions[0]?.warning).toContain(
      "source navigation failed",
    );
    expect(run?.targetExecutions[0]).toMatchObject({
      requestedJobBudget: 50,
      jobsReviewed: 0,
      jobsFound: 0,
      jobsPersisted: 0,
      jobsStaged: 0,
      jobsSkippedByLedger: 0,
      jobsSkippedByTitleTriage: 0,
      duplicatesMerged: 0,
      invalidSkipped: 0,
    });
    expect(
      run?.activity.some(
        (event) =>
          event.targetId === "target_failing" &&
          event.terminalState === "failed" &&
          event.kind === "error",
      ),
    ).toBe(true);
    expect(snapshot.discoveryJobs).toHaveLength(1);
  });

  test("discovery records card-only and detail-enriched jobs without overstating thin extraction", async () => {
    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      runAgentDiscovery(source) {
        return Promise.resolve({
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "Detail quality discovery test run",
          inventoryCompleteness: "partial",
          warning: null,
          jobs: [
            JobPostingSchema.parse({
              source: "target_site",
              sourceJobId: "card_only_job",
              discoveryMethod: "browser_agent",
              canonicalUrl: "https://example.com/jobs/card-only-job",
              title: "Principal Designer",
              company: "Card Co",
              location: "Remote",
              workMode: ["remote"],
              applyPath: "unknown",
              easyApplyEligible: false,
              discoveredAt: "2026-03-20T10:00:00.000Z",
              salaryText: null,
              summary: "Principal Designer role at Card Co",
              description: "Principal Designer role at Card Co",
              keySkills: [],
            }),
            JobPostingSchema.parse({
              source: "target_site",
              sourceJobId: "detail_enriched_job",
              discoveryMethod: "browser_agent",
              canonicalUrl: "https://example.com/jobs/detail-enriched-job",
              title: "Principal Product Designer",
              company: "Detail Co",
              location: "Remote",
              workMode: ["remote"],
              applyPath: "external_redirect",
              easyApplyEligible: false,
              discoveredAt: "2026-03-20T10:00:00.000Z",
              salaryText: null,
              summary:
                "Own product design from discovery through measured delivery.",
              description:
                "Own product design from discovery through measured delivery, partnering with product managers and engineers to define customer problems, evaluate alternatives, document interaction decisions, test prototypes, and improve shipped workflows using qualitative and quantitative evidence from real users.",
              keySkills: ["Product Design", "Research"],
              responsibilities: [
                "Lead discovery, prototyping, validation, and detailed interaction design for customer-facing workflows.",
                "Partner with engineering and product to scope delivery and measure outcomes after release.",
              ],
            }),
          ],
          agentMetadata: null,
        });
      },
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: createDiscoveryOnlySeed(),
      browserRuntime,
      aiClient: createAiClient(),
    });

    const snapshot = await workspaceService.runAgentDiscovery(
      () => {},
      new AbortController().signal,
    );
    const discoveryState = await repository.getDiscoveryState();
    const cardOnlyJob = snapshot.discoveryJobs.find(
      (job) => job.sourceJobId === "card_only_job",
    );
    const detailEnrichedJob = snapshot.discoveryJobs.find(
      (job) => job.sourceJobId === "detail_enriched_job",
    );
    const cardOnlyLedgerEntry = discoveryState.discoveryLedger.find(
      (entry) => entry.sourceJobId === "card_only_job",
    );
    const detailEnrichedLedgerEntry = discoveryState.discoveryLedger.find(
      (entry) => entry.sourceJobId === "detail_enriched_job",
    );

    expect(cardOnlyJob?.detailQuality).toBe("card_only");
    expect(cardOnlyLedgerEntry).toEqual(
      expect.objectContaining({
        detailQuality: "card_only",
        latestStatus: "seen",
        lastEnrichedAt: null,
      }),
    );
    expect(detailEnrichedJob?.detailQuality).toBe("detail_enriched");
    expect(detailEnrichedLedgerEntry).toEqual(
      expect.objectContaining({
        detailQuality: "detail_enriched",
        latestStatus: "enriched",
        lastEnrichedAt: expect.any(String) as string,
      }),
    );
  });

  test("agent discovery prioritizes API-backed and better-seeded targets before weaker browser targets", async () => {
    const seed = createDiscoveryOnlySeed();
    seed.searchPreferences.discovery.targets = [
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_browser_missing",
        label: "Missing Browser Target",
        startingUrl: "https://example.com/careers",
      },
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_greenhouse_remote",
        label: "Greenhouse Target",
        startingUrl: "https://job-boards.greenhouse.io/remote",
      },
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_browser_validated",
        label: "Validated Browser Target",
        startingUrl: "https://example.com/jobs/",
        instructionStatus: "validated",
        validatedInstructionId: "instruction_browser_validated",
      },
    ];
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_browser_validated",
        targetId: "target_browser_validated",
        status: "validated",
        createdAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        acceptedAt: "2026-03-20T10:06:00.000Z",
        basedOnRunId: "debug_run_browser_validated",
        basedOnAttemptIds: ["debug_attempt_browser_validated"],
        notes:
          "Use the learned jobs search route before the generic landing page.",
        navigationGuidance: [],
        searchGuidance: [],
        detailGuidance: [],
        applyGuidance: [],
        warnings: [],
        versionInfo: {
          promptProfileVersion: "v1",
          toolsetVersion: "v1",
          adapterVersion: "v1",
          appSchemaVersion: "v1",
        },
        verification: {
          id: "verification_browser_validated",
          replayRunId: "debug_run_browser_validated_replay",
          verifiedAt: "2026-03-20T10:07:00.000Z",
          outcome: "passed",
          proofSummary: "Replay succeeded.",
          reason: null,
          versionInfo: {
            promptProfileVersion: "v1",
            toolsetVersion: "v1",
            adapterVersion: "v1",
            appSchemaVersion: "v1",
          },
        },
        intelligence: {
          provider: null,
          collection: {
            preferredMethod: "listing_route",
            rankedMethods: ["listing_route", "careers_page", "fallback_search"],
            startingRoutes: [
              {
                url: "https://example.com/jobs/",
                label: "Jobs landing route",
                kind: "listing",
                confidence: 0.86,
              },
            ],
            searchRouteTemplates: [
              {
                url: "https://example.com/jobs/search",
                label: "Learned jobs search route",
                kind: "search",
                confidence: 0.95,
              },
            ],
            detailRoutePatterns: [],
            listingMarkers: [],
          },
          apply: {
            applyPath: "unknown",
            authMarkers: [],
            consentMarkers: [],
            questionSurfaceHints: [],
            resumeUploadHints: [],
          },
          reliability: {
            selectorFingerprints: [],
            stableControlNames: [],
            failureFingerprints: [],
            verifiedAt: null,
            freshnessNotes: [],
          },
          overrides: {
            forceMethod: null,
            deniedRoutePatterns: [],
            extraStartingRoutes: [],
          },
        },
      }),
    ];

    const baseAgentRuntime = createAgentBrowserRuntime([]);
    const requestedLabels: string[] = [];
    const browserRuntime: BrowserSessionRuntime = {
      ...baseAgentRuntime,
      runAgentDiscovery(source, options) {
        requestedLabels.push(options.siteLabel);
        return baseAgentRuntime.runAgentDiscovery!(source, options);
      },
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          jobs: [
            {
              id: 4622190,
              title: "API-first role",
              absolute_url:
                "https://job-boards.greenhouse.io/remote/jobs/4622190",
              location: { name: "Remote" },
              updated_at: "2026-03-20T10:00:00.000Z",
              content: "<p>Collect this through the provider API.</p>",
            },
          ],
        }),
        { status: 200 },
      ),
    );

    try {
      const { workspaceService } = createWorkspaceServiceHarness({
        seed,
        browserRuntime,
        aiClient: createAgentAiClient(),
      });

      const snapshot = await workspaceService.runAgentDiscovery(
        () => {},
        new AbortController().signal,
      );

      expect(snapshot.recentDiscoveryRuns[0]?.targetIds).toEqual([
        "target_greenhouse_remote",
        "target_browser_validated",
        "target_browser_missing",
      ]);
      expect(requestedLabels).toEqual([
        "Validated Browser Target",
        "Missing Browser Target",
      ]);
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("single-target discovery only runs the requested source", async () => {
    const seed = createDiscoveryOnlySeed();
    seed.searchPreferences.discovery.targets = [
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_one",
        label: "Target One",
        startingUrl: "https://example.com/jobs/one",
      },
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_two",
        label: "Target Two",
        startingUrl: "https://example.com/jobs/two",
      },
    ];

    const requestedLabels: string[] = [];
    const resumedRevisions: Array<number | null> = [];
    const browserRuntime: BrowserSessionRuntime = {
      ...createAgentBrowserRuntime([]),
      async runAgentDiscovery(source, options) {
        requestedLabels.push(options.siteLabel);
        resumedRevisions.push(options.resumeCheckpoint?.revision ?? null);
        await options.onCheckpoint?.({
          revision: 1,
          savedAt: "2026-03-20T10:00:03.000Z",
          currentUrl: "https://example.com/jobs/two?page=2",
          lastStableUrl: "https://example.com/jobs/two?page=2",
          stepCount: 3,
          collectedJobs: [],
          visitedUrls: ["https://example.com/jobs/two?page=2"],
          phaseEvidence: {
            warnings: [],
            visibleControls: [],
            successfulInteractions: [],
            routeSignals: [],
            attemptedControls: [],
            visualFindings: [],
          },
        });

        return {
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:00:05.000Z",
          querySummary: "Single-target discovery test run",
          inventoryCompleteness: "partial",
          warning: null,
          jobs: [
            JobPostingSchema.parse({
              source: "target_site",
              sourceJobId: `${options.siteLabel.toLowerCase().replace(/\s+/g, "_")}_job_1`,
              discoveryMethod: "browser_agent",
              canonicalUrl: `https://example.com/job/${options.siteLabel.toLowerCase().replace(/\s+/g, "-")}`,
              title: "Principal Designer",
              company: "Acme",
              location: "Remote",
              workMode: ["remote"],
              applyPath: "unknown",
              easyApplyEligible: false,
              postedAt: null,
              postedAtText: null,
              discoveredAt: "2026-03-20T10:00:00.000Z",
              salaryText: null,
              summary: "Grounded summary",
              description: "Grounded description",
              keySkills: ["React"],
              responsibilities: [],
              minimumQualifications: [],
              preferredQualifications: [],
              seniority: null,
              employmentType: null,
              department: null,
              team: null,
              employerWebsiteUrl: null,
              employerDomain: null,
              benefits: [],
            }),
          ],
          agentMetadata: null,
        };
      },
    };

    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.runDiscoveryForTarget(
      "target_two",
      () => {},
      new AbortController().signal,
    );

    expect(requestedLabels).toEqual(["Target Two"]);
    expect(snapshot.recentDiscoveryRuns[0]?.scope).toBe("single_target");
    expect(snapshot.recentDiscoveryRuns[0]?.targetIds).toEqual(["target_two"]);
    expect(snapshot.discoveryJobs).toHaveLength(1);
    expect(snapshot.discoveryJobs[0]?.provenance[0]?.targetId).toBe(
      "target_two",
    );
    // Stored for durability; the display snapshot leaves resume checkpoints
    // out because only main resumes a search.
    expect(
      (await repository.getDiscoveryState()).recentRuns[0]?.targetExecutions[0]
        ?.agentCheckpoint,
    ).toMatchObject({ revision: 1, stepCount: 3 });

    await workspaceService.runDiscoveryForTarget(
      "target_two",
      () => {},
      new AbortController().signal,
    );
    // The checkpoint stays recorded on the completed execution for durability,
    // but a completed run never seeds process progress into a fresh run: the
    // second single-target run starts exploring fresh instead of replaying
    // finished loop progress against a new budget.
    expect(resumedRevisions).toEqual([null, null]);
  });
});
