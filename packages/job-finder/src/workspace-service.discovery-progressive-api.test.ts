import type { JudgeJobFitsInput } from "@nestor/ai-providers";
import {
  DiscoveryAgentMetadataSchema,
  type DiscoveryActivityEvent,
} from "@nestor/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createAiClient,
  createSeed,
  createAgentBrowserRuntime,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

interface Deferred<TValue> {
  promise: Promise<TValue>;
  resolve(value: TValue): void;
}

function createDeferred<TValue>(): Deferred<TValue> {
  let resolvePromise: ((value: TValue) => void) | null = null;
  const promise = new Promise<TValue>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve(value) {
      if (!resolvePromise) {
        throw new Error("Deferred promise was not initialized.");
      }
      resolvePromise(value);
    },
  };
}

function createGreenhouseResponse(input: {
  id: number;
  title: string;
  board: string;
  malformed?: boolean;
}): Response {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        jobs: [
          ...(input.malformed ? [null] : []),
          {
            id: input.id,
            title: input.title,
            absolute_url: `https://job-boards.greenhouse.io/${input.board}/jobs/${input.id}`,
            location: { name: "Remote" },
            updated_at: "2026-08-09T10:00:00.000Z",
            content:
              "<p>Lead product design systems and resilient workflow platforms.</p>",
          },
        ],
      }),
  } as Response;
}

function createFailedResponse(status: number): Response {
  return {
    ok: false,
    status,
  } as Response;
}

function resolveRequestUrl(request: RequestInfo | URL): string {
  if (typeof request === "string") {
    return request;
  }
  if (request instanceof URL) {
    return request.toString();
  }
  return request.url;
}

function createProgressiveApiHarness() {
  const seed = createSeed();
  seed.savedJobs = [];
  seed.discovery.pendingDiscoveryJobs = [];
  seed.discovery.discoveryLedger = [];
  seed.settings.discoveryOnly = false;
  seed.searchPreferences.companyWhitelist = [];
  seed.searchPreferences.targetRoles = ["Senior Product Designer"];
  seed.searchPreferences.discovery.targets = [
    {
      id: "target_slow_api",
      label: "Slow Board",
      startingUrl: "https://job-boards.greenhouse.io/slowboard",
      enabled: true,
      adapterKind: "auto",
      customInstructions: null,
      instructionStatus: "missing",
      validatedInstructionId: null,
      draftInstructionId: null,
      lastDebugRunId: null,
      lastVerifiedAt: null,
      staleReason: null,
    },
    {
      id: "target_fast_api",
      label: "Fast Board",
      startingUrl: "https://job-boards.greenhouse.io/fastboard",
      enabled: true,
      adapterKind: "auto",
      customInstructions: null,
      instructionStatus: "missing",
      validatedInstructionId: null,
      draftInstructionId: null,
      lastDebugRunId: null,
      lastVerifiedAt: null,
      staleReason: null,
    },
  ];

  return createWorkspaceServiceHarness({ seed });
}

function completedTargetIds(
  events: readonly DiscoveryActivityEvent[],
): string[] {
  return events.flatMap((event) =>
    event.stage === "target" &&
    event.terminalState === "completed" &&
    event.targetId
      ? [event.targetId]
      : [],
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("progressive public API discovery", () => {
  test("cancels the service-owned run by its durable run id", async () => {
    const pendingResponse = createDeferred<Response>();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(pendingResponse.promise);
    const { workspaceService } = createProgressiveApiHarness();
    const runPromise = workspaceService.runAgentDiscovery();

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const running = await workspaceService.getWorkspaceSnapshot();
    const runId = running.activeDiscoveryRun?.id;
    expect(runId).toBeTruthy();

    const stopping = await workspaceService.cancelDiscoveryRun(runId ?? "");
    const acknowledgedRun =
      stopping.activeDiscoveryRun?.id === runId
        ? stopping.activeDiscoveryRun
        : stopping.recentDiscoveryRuns.find((run) => run.id === runId);
    expect(acknowledgedRun?.cancellationRequestedAt).toBeTruthy();
    expect(["running", "cancelled"]).toContain(acknowledgedRun?.state);

    const stopped = await runPromise;
    expect(stopped.activeDiscoveryRun).toBeNull();
    expect(stopped.recentDiscoveryRuns[0]).toMatchObject({
      id: runId,
      state: "cancelled",
    });
    expect(
      stopped.recentDiscoveryRuns[0]?.cancellationRequestedAt,
    ).not.toBeNull();

    pendingResponse.resolve(createFailedResponse(503));
  });

  test("aborts the in-flight pipeline for a run the stored state has not caught up to", async () => {
    const pendingResponse = createDeferred<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(pendingResponse.promise);
    const { workspaceService } = createProgressiveApiHarness();

    // The run id reaches the screen through live activity well before the run
    // record is persisted. Stopping on that id used to be acknowledged as a
    // request and never reach the pipeline, so the search kept working while
    // the toolbar counted "Stopping" upward.
    let liveRunId: string | null = null;
    const runPromise = workspaceService.runAgentDiscovery((event) => {
      liveRunId ??= event.runId;
    });

    await vi.waitFor(() => expect(liveRunId).toBeTruthy());
    await workspaceService.cancelDiscoveryRun(liveRunId ?? "");

    const stopped = await runPromise;
    expect(stopped.recentDiscoveryRuns[0]).toMatchObject({
      id: liveRunId,
      state: "cancelled",
    });

    pendingResponse.resolve(createFailedResponse(503));
  });

  test("limits large public API catalogs to 24 in-flight source requests", async () => {
    const seed = createSeed();
    seed.savedJobs = [];
    seed.discovery.pendingDiscoveryJobs = [];
    seed.discovery.discoveryLedger = [];
    seed.settings.discoveryOnly = false;
    seed.searchPreferences.companyWhitelist = [];
    seed.searchPreferences.targetRoles = ["Senior Product Designer"];
    seed.searchPreferences.discovery.targets = Array.from(
      { length: 36 },
      (_, index) => ({
        id: `target_board_${index}`,
        label: `Board ${index}`,
        startingUrl: `https://job-boards.greenhouse.io/board${index}`,
        enabled: true,
        adapterKind: "auto" as const,
        customInstructions: null,
        instructionStatus: "missing" as const,
        validatedInstructionId: null,
        draftInstructionId: null,
        lastDebugRunId: null,
        lastVerifiedAt: null,
        staleReason: null,
      }),
    );
    const pendingResponse = createDeferred<Response>();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(pendingResponse.promise);
    const { workspaceService } = createWorkspaceServiceHarness({ seed });
    const controller = new AbortController();
    const runPromise = workspaceService.runAgentDiscovery(
      undefined,
      controller.signal,
    );

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(24));
    controller.abort();
    const snapshot = await runPromise;

    expect(fetchSpy).toHaveBeenCalledTimes(24);
    expect(snapshot.recentDiscoveryRuns[0]?.summary.outcome).toBe("cancelled");
    pendingResponse.resolve(createFailedResponse(503));
  });

  test.each([
    {
      intent: "Find design systems roles",
      freshness: "any" as const,
      sourceIds: "all" as const,
    },
    { intent: "", freshness: "recent" as const, sourceIds: "all" as const },
    {
      intent: "Find design roles whose feed needs detail pages",
      freshness: "any" as const,
      sourceIds: "all" as const,
    },
    {
      intent: "Find customer support roles instead",
      freshness: "any" as const,
      sourceIds: "all" as const,
    },
  ])(
    "hands explicit search choices and the feed to the agent: %j",
    async (request) => {
      const strictConflict = request.intent.includes("customer support");
      const browserPages = request.intent.includes("detail pages") ? 2 : 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(
          createGreenhouseResponse({
            id: 42,
            title: strictConflict
              ? "Customer Support"
              : "Senior Product Designer",
            board: "test",
            malformed: request.freshness === "recent",
          }),
        ),
      );
      const seed = createSeed();
      seed.savedJobs = [];
      seed.discovery.pendingDiscoveryJobs = [];
      seed.discovery.discoveryLedger = [];
      seed.searchPreferences.companyWhitelist = [];
      seed.searchPreferences.discovery.collectOnlyHardCriteriaMatches =
        strictConflict;
      seed.searchPreferences.targetRoles = ["Senior Product Designer"];
      seed.searchPreferences.discovery.targets = [
        {
          ...seed.searchPreferences.discovery.targets[0]!,
          id: "feed",
          startingUrl: "https://job-boards.greenhouse.io/test",
        },
      ];
      const runtime = createAgentBrowserRuntime([]);
      const agent = vi.fn<NonNullable<typeof runtime.runAgentDiscovery>>(
        (source, options) =>
          Promise.resolve({
            source,
            startedAt: "2026-09-20T10:00:00Z",
            completedAt: "2026-09-20T10:01:00Z",
            querySummary: "Reviewed feed",
            inventoryCompleteness: "complete",
            warning: null,
            jobs: options.sourceCatalog ?? [],
            agentMetadata: DiscoveryAgentMetadataSchema.parse({
              pagesCovered: browserPages,
              coveredPageUrls: browserPages ? undefined : [],
              phaseCompletionReason: strictConflict
                ? "Customer support conflicts with your saved Product Designer role. Change the saved role or search selectivity to find support jobs."
                : "The catalog contains a matching design role.",
            }),
          }),
      );
      runtime.runAgentDiscovery = agent;
      const base = createAiClient();
      const { workspaceService } = createWorkspaceServiceHarness({
        seed,
        browserRuntime: runtime,
        // The model judges a support role against a saved designer role as
        // another occupation, so Best matches only does not keep it.
        aiClient: {
          ...base,
          judgeJobFits: (input: JudgeJobFitsInput) =>
            Promise.resolve(
              input.jobs.map(({ jobId, posting }) => {
                const fit = posting.title.includes("Designer");
                return {
                  jobId,
                  score: fit ? 85 : 10,
                  recommendation: fit
                    ? ("strong_fit" as const)
                    : ("skip" as const),
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
            ),
        },
      });
      const snapshot = await workspaceService.runAgentDiscovery(
        undefined,
        undefined,
        undefined,
        request,
      );
      expect(agent).toHaveBeenCalledOnce();
      // Keep the feed's page plus any browser detail reads, including readers
      // that report their actual count without individual page addresses.
      expect(
        snapshot.recentDiscoveryRuns[0]?.targetExecutions[0]?.pagesCovered,
      ).toBe(1 + browserPages);
      expect(
        snapshot.recentDiscoveryRuns[0]?.summary.report?.pagesCovered,
      ).toBe(1 + browserPages);
      expect(
        snapshot.recentDiscoveryRuns[0]?.summary.report?.sources?.reduce(
          (total, source) => total + (source.pagesCovered ?? 0),
          0,
        ),
      ).toBe(1 + browserPages);
      expect(
        snapshot.recentDiscoveryRuns[0]?.targetExecutions[0]?.sourceCounts?.reduce(
          (total, source) => total + (source.pagesCovered ?? 0),
          0,
        ),
      ).toBe(1 + browserPages);
      expect(agent.mock.calls[0]?.[1]).toMatchObject({
        searchRequest: request,
        retainAllFound: true,
        sourceCatalog: [
          {
            sourceJobId: "42",
            providerKey: "greenhouse",
            discoveryMethod: "public_api",
          },
        ],
      });
      if (strictConflict) {
        expect(snapshot.discoveryJobs).toEqual([]);
        expect(
          snapshot.recentDiscoveryRuns[0]?.targetExecutions[0]
            ?.jobsSkippedByTitleTriage,
        ).toBe(1);
        const run = snapshot.recentDiscoveryRuns[0];
        expect(run?.state).toBe("completed");
        expect(
          run?.activity.some(
            (event) =>
              event.terminalState === "completed" &&
              event.message.includes("Change the saved role"),
          ),
        ).toBe(true);
      } else {
        expect(snapshot.discoveryJobs[0]).toMatchObject({
          providerKey: "greenhouse",
          discoveryMethod: "public_api",
          collectionMethod: "api",
        });
      }
      if (request.freshness === "recent") {
        expect(
          snapshot.recentDiscoveryRuns[0]?.targetExecutions[0]?.warning,
        ).toContain("1 job in this board's list could not be read");
      }
    },
  );

  test("marks a run failed when every configured source fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(createFailedResponse(503));
    const { repository, workspaceService } = createProgressiveApiHarness();

    await expect(workspaceService.runDiscovery()).rejects.toThrow(/503/);

    const discoveryState = await repository.getDiscoveryState();
    const run = discoveryState.recentRuns[0];
    expect(run?.summary.outcome).toBe("failed");
    expect(run?.targetExecutions).toHaveLength(2);
    expect(
      run?.targetExecutions.every((target) => target.state === "failed"),
    ).toBe(true);
  });

  test("publishes a fast later API source while the first API source is still pending", async () => {
    const slowResponse = createDeferred<Response>();
    vi.spyOn(globalThis, "fetch").mockImplementation((request) => {
      const url = resolveRequestUrl(request);
      if (url.includes("slowboard")) {
        return slowResponse.promise;
      }
      if (url.includes("fastboard")) {
        return Promise.resolve(
          createGreenhouseResponse({
            id: 2002,
            title: "Senior Product Designer - Fast",
            board: "fastboard",
          }),
        );
      }
      throw new Error(`Unexpected provider request: ${url}`);
    });
    const { repository, workspaceService } = createProgressiveApiHarness();
    const events: DiscoveryActivityEvent[] = [];
    let runSettled = false;

    const runPromise = workspaceService
      .runAgentDiscovery((event) => events.push(event))
      .finally(() => {
        runSettled = true;
      });

    await vi.waitFor(() => {
      expect(completedTargetIds(events)).toEqual(["target_fast_api"]);
    });
    expect(runSettled).toBe(false);
    const liveJobs = await repository.listSavedJobs();
    expect(liveJobs.map((job) => job.sourceJobId)).toContain("2002");
    const livePlan = await repository.getCampaignState();
    expect(liveJobs.find((job) => job.sourceJobId === "2002")?.campaignIds)
      .toContain(livePlan?.activeCampaignId);

    slowResponse.resolve(
      createGreenhouseResponse({
        id: 1001,
        title: "Senior Product Designer - Slow",
        board: "slowboard",
      }),
    );
    const snapshot = await runPromise;

    expect(completedTargetIds(events)).toEqual([
      "target_fast_api",
      "target_slow_api",
    ]);
    expect(snapshot.discoveryJobs.map((job) => job.sourceJobId)).toEqual(
      expect.arrayContaining(["1001", "2002"]),
    );
    expect(snapshot.recentDiscoveryRuns[0]?.summary).toMatchObject({
      targetsCompleted: 2,
      jobsPersisted: 2,
      outcome: "completed",
    });
    expect((await repository.listSavedJobs()).every((job) =>
      job.campaignIds?.includes(livePlan.activeCampaignId ?? ""),
    )).toBe(true);
  });

  test("keeps a completed fast batch durable when a slower provider later fails", async () => {
    const slowResponse = createDeferred<Response>();
    vi.spyOn(globalThis, "fetch").mockImplementation((request) => {
      const url = resolveRequestUrl(request);
      if (url.includes("slowboard")) {
        return slowResponse.promise;
      }
      if (url.includes("fastboard")) {
        return Promise.resolve(
          createGreenhouseResponse({
            id: 3003,
            title: "Senior Product Designer - Durable",
            board: "fastboard",
          }),
        );
      }
      throw new Error(`Unexpected provider request: ${url}`);
    });
    const { repository, workspaceService } = createProgressiveApiHarness();
    const events: DiscoveryActivityEvent[] = [];
    const runPromise = workspaceService.runAgentDiscovery((event) =>
      events.push(event),
    );

    await vi.waitFor(() => {
      expect(completedTargetIds(events)).toEqual(["target_fast_api"]);
    });
    expect(
      (await repository.listSavedJobs()).map((job) => job.sourceJobId),
    ).toContain("3003");

    slowResponse.resolve(createFailedResponse(503));
    const snapshot = await runPromise;
    const run = snapshot.recentDiscoveryRuns[0];
    const slowExecution = run?.targetExecutions.find(
      (execution) => execution.targetId === "target_slow_api",
    );

    expect(snapshot.discoveryJobs.map((job) => job.sourceJobId)).toContain(
      "3003",
    );
    expect(slowExecution).toMatchObject({
      state: "failed",
      jobsPersisted: 0,
    });
    expect(slowExecution?.warning).toMatch(/HTTP 503/i);
    // A failed source is terminal but not completed: the campaign's terminal
    // commit persists the canonical denominator so nothing reports the 503
    // source inside "2 of 2 sources finished".
    expect(run?.summary).toMatchObject({
      targetsCompleted: 1,
      jobsPersisted: 1,
      outcome: "completed",
    });
  });

  test("cancels promptly while every prefetched API inventory is pending", async () => {
    const slowResponse = createDeferred<Response>();
    const fastResponse = createDeferred<Response>();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((request) =>
        resolveRequestUrl(request).includes("slowboard")
          ? slowResponse.promise
          : fastResponse.promise,
      );
    const { workspaceService } = createProgressiveApiHarness();
    const controller = new AbortController();
    const runPromise = workspaceService.runAgentDiscovery(
      undefined,
      controller.signal,
    );

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
    controller.abort();
    const snapshot = await runPromise;

    expect(snapshot.recentDiscoveryRuns[0]?.summary).toMatchObject({
      targetsCompleted: 0,
      jobsPersisted: 0,
      outcome: "cancelled",
    });

    slowResponse.resolve(
      createGreenhouseResponse({
        id: 4004,
        title: "Senior Product Designer - Cancelled Slow",
        board: "slowboard",
      }),
    );
    fastResponse.resolve(
      createGreenhouseResponse({
        id: 5005,
        title: "Senior Product Designer - Cancelled Fast",
        board: "fastboard",
      }),
    );
  });
});
