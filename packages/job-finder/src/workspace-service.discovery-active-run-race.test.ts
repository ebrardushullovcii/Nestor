import type { DiscoveryActivityEvent } from "@nestor/contracts";
import {
  DiscoveryLedgerEntrySchema,
  type DiscoveryLedgerEntry,
} from "@nestor/contracts";
import {
  createFileJobFinderRepository,
  createInMemoryJobFinderRepository,
} from "@nestor/db";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createDiscoveryListingFingerprints } from "./internal/workspace-discovery-ledger";
import {
  overlayTouchedPendingJobs,
  rebaseRunLedgerOntoPersisted,
} from "./internal/workspace-discovery-state-helpers";
import {
  DiscoveryRunAlreadyActiveError,
  createJobFinderWorkspaceService,
} from "./index";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createSavedJob,
  createSeed,
} from "./workspace-service.test-support";
import * as discoverySavedJobWriter from "./internal/discovery-saved-job-writer";

interface Deferred<TValue> {
  promise: Promise<TValue>;
  resolve(value: TValue): void;
}

function createDeferred<TValue>(): Deferred<TValue> {
  let resolveValue: ((value: TValue) => void) | null = null;
  const promise = new Promise<TValue>((resolve) => {
    resolveValue = resolve;
  });
  if (!resolveValue) throw new Error("Deferred promise was not initialized.");
  return { promise, resolve: resolveValue };
}

function resolveRequestUrl(request: RequestInfo | URL): string {
  if (typeof request === "string") return request;
  if (request instanceof URL) return request.toString();
  return request.url;
}

function createBoardResponse(
  boardId: string,
  jobIds: readonly number[],
): Response {
  return Response.json({
    jobs: jobIds.map((id) => ({
      id,
      title: `Senior Product Designer ${id}`,
      absolute_url: `https://job-boards.greenhouse.io/${boardId}/jobs/${id}`,
      location: { name: "Remote" },
      updated_at: "2026-08-09T10:00:00.000Z",
      content:
        "<p>Lead product design systems and resilient workflow platforms.</p>",
    })),
  });
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

const DISMISSED_PENDING_SOURCE_JOB_ID = "slow_9001";
const RESTORED_SAVED_SOURCE_JOB_ID = "slow_8001";
const STAGED_NEW_SOURCE_JOB_ID = "9002";

function createRaceSeed(): ReturnType<typeof createSeed> {
  const seed = createSeed();
  seed.savedJobs = [];
  seed.settings.discoveryOnly = true;
  seed.searchPreferences.companyWhitelist = [];
  seed.searchPreferences.targetRoles = ["Senior Product Designer"];
  seed.searchPreferences.discovery.targets = [
    {
      id: "target_fast_board",
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
    {
      id: "target_slow_board",
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
  ];

  const dismissedPendingJob = createSavedJob({
    id: "job_pending_race",
    source: "target_site",
    sourceJobId: DISMISSED_PENDING_SOURCE_JOB_ID,
    discoveryMethod: "public_api",
    collectionMethod: "api",
    canonicalUrl: "https://job-boards.greenhouse.io/slowboard/jobs/9001",
    applicationUrl: "https://job-boards.greenhouse.io/slowboard/jobs/9001",
    title: "Senior Product Designer 9001",
    company: "Slow Board Co",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    postedAt: "2026-08-01T09:00:00.000Z",
    postedAtText: null,
    discoveredAt: "2026-08-08T09:00:00.000Z",
    firstSeenAt: "2026-08-08T09:00:00.000Z",
    lastSeenAt: "2026-08-08T09:00:00.000Z",
    lastVerifiedActiveAt: "2026-08-08T09:00:00.000Z",
    salaryText: "$180k - $220k",
    summary: null,
    description:
      "<p>Lead product design systems and resilient workflow platforms.</p>",
    keySkills: [],
    responsibilities: [],
    minimumQualifications: [],
    preferredQualifications: [],
    seniority: "Senior",
    employmentType: null,
    department: null,
    team: null,
    employerWebsiteUrl: null,
    employerDomain: null,
    atsProvider: null,
    screeningHints: {
      sponsorshipText: null,
      requiresSecurityClearance: null,
      relocationText: null,
      travelText: null,
      remoteGeographies: [],
      requiresConsentInterrupt: null,
      requiresConsentInterruptKind: null,
    },
    keywordSignals: [],
    benefits: [],
    status: "discovered",
    matchAssessment: { score: 72, reasons: ["Role overlap"], gaps: [] },
    provenance: [
      {
        targetId: "target_slow_board",
        adapterKind: "auto",
        resolvedAdapterKind: "target_site",
        startingUrl: "https://job-boards.greenhouse.io/slowboard",
        discoveredAt: "2026-08-08T09:00:00.000Z",
        collectionMethod: "api",
        providerKey: "greenhouse",
        providerBoardToken: "slowboard",
        titleTriageOutcome: "pass",
      },
    ],
  });

  const restoredSavedJob = createSavedJob({
    ...dismissedPendingJob,
    id: "job_saved_restore",
    sourceJobId: RESTORED_SAVED_SOURCE_JOB_ID,
    canonicalUrl: "https://job-boards.greenhouse.io/slowboard/jobs/8001",
    applicationUrl: "https://job-boards.greenhouse.io/slowboard/jobs/8001",
    title: "Senior Product Designer 8001",
    status: "archived" as const,
    discoveryFeedback: {
      version: 1,
      revision: 1,
      reasons: ["company"],
      recordedAt: "2026-08-07T09:00:00.000Z",
      priorStatus: "ready_for_review",
    },
  });
  seed.savedJobs = [restoredSavedJob];

  const raceLedgerEntry = (input: {
    id: string;
    job: typeof dismissedPendingJob;
    latestStatus: DiscoveryLedgerEntry["latestStatus"];
    skipReason: string | null;
  }): DiscoveryLedgerEntry =>
    DiscoveryLedgerEntrySchema.parse({
      id: input.id,
      canonicalUrl: input.job.canonicalUrl,
      applicationUrl: null,
      source: input.job.source,
      sourceJobId: input.job.sourceJobId,
      providerKey: "greenhouse",
      providerBoardToken: "slowboard",
      providerIdentifier: null,
      providerUpdatedAt: null,
      title: input.job.title,
      company: input.job.company,
      location: input.job.location,
      postedAt: input.job.postedAt,
      postedAtText: null,
      targetId: "target_slow_board",
      collectionMethod: "api",
      detailQuality: "card_only",
      fingerprints: createDiscoveryListingFingerprints(input.job),
      firstSeenAt: input.job.firstSeenAt,
      lastSeenAt: input.job.lastSeenAt,
      lastAppliedAt: null,
      lastEnrichedAt: null,
      inactiveAt: null,
      latestStatus: input.latestStatus,
      skipReason: input.skipReason,
      titleTriageOutcome: "pass",
    });

  seed.discovery.pendingDiscoveryJobs = [dismissedPendingJob];
  seed.discovery.discoveryLedger = [
    raceLedgerEntry({
      id: "ledger_pending_race",
      job: dismissedPendingJob,
      latestStatus: "seen",
      skipReason: null,
    }),
    raceLedgerEntry({
      id: "ledger_restore_race",
      job: restoredSavedJob,
      latestStatus: "skipped",
      skipReason: "Not interested: company.",
    }),
  ];

  return seed;
}

type RaceHarness = Awaited<ReturnType<typeof createRaceHarness>>;

type RaceRepository = Parameters<
  typeof createJobFinderWorkspaceService
>[0]["repository"];

function createRaceHarness(repository: RaceRepository) {
  const slowResponse = createDeferred<Response>();
  const events: DiscoveryActivityEvent[] = [];
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((request) => {
      const url = resolveRequestUrl(request);
      if (url.includes("slowboard")) return slowResponse.promise;
      if (url.includes("fastboard")) {
        return Promise.resolve(createBoardResponse("fastboard", [7001]));
      }
      return Promise.reject(new Error(`Unexpected provider request: ${url}`));
    });

  const workspaceService = createJobFinderWorkspaceService({
    repository,
    browserRuntime: createBrowserRuntime(),
    aiClient: createAiClient(),
    documentManager: createDocumentManager(),
  });

  return {
    repository,
    workspaceService,
    events,
    slowResponse,
    finishRun: () => {
      slowResponse.resolve(
        createBoardResponse("slowboard", [8001, 9001, 9002]),
      );
    },
    cleanup: () => {
      fetchSpy.mockRestore();
    },
  };
}

async function runRaceScenario(
  harness: RaceHarness,
  midRun: (raceHarness: RaceHarness) => Promise<void>,
) {
  const runPromise = harness.workspaceService.runAgentDiscovery((event) =>
    harness.events.push(event),
  );

  await vi.waitFor(() => {
    expect(completedTargetIds(harness.events)).toContain("target_fast_board");
  });
  await midRun(harness);
  harness.finishRun();
  const snapshot = await runPromise;

  return { snapshot, state: await harness.repository.getDiscoveryState() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("active-run concurrent user decisions", () => {
  test("keeps a mid-run dismissal durable and never reinserts the removed pending job", async () => {
    const harness = createRaceHarness(
      createInMemoryJobFinderRepository(createRaceSeed()),
    );
    try {
      const { snapshot, state } = await runRaceScenario(
        harness,
        async (race) => {
          await race.workspaceService.dismissDiscoveryJob({
            jobId: "job_pending_race",
            reasons: ["compensation"],
          });
        },
      );

      expect(snapshot.recentDiscoveryRuns[0]?.summary.outcome).toBe(
        "completed",
      );

      const pendingSourceJobIds = state.pendingDiscoveryJobs.map(
        (job) => job.sourceJobId,
      );
      expect(pendingSourceJobIds).not.toContain(
        DISMISSED_PENDING_SOURCE_JOB_ID,
      );
      expect(pendingSourceJobIds).toContain(STAGED_NEW_SOURCE_JOB_ID);

      const dismissedEntry = state.discoveryLedger.find(
        (entry) => entry.sourceJobId === DISMISSED_PENDING_SOURCE_JOB_ID,
      );
      expect(dismissedEntry?.latestStatus).toBe("skipped");
      expect(dismissedEntry?.skipReason).toMatch(/^Not interested:/);

      const dismissedSavedJob = (await harness.repository.listSavedJobs()).find(
        (job) => job.sourceJobId === DISMISSED_PENDING_SOURCE_JOB_ID,
      );
      expect(dismissedSavedJob).toMatchObject({
        status: "archived",
        discoveryFeedback: { reasons: ["compensation"] },
      });
    } finally {
      harness.cleanup();
    }
  }, 60_000);

  test("keeps a mid-run restore (seen) intact against the stale skipped ledger echo", async () => {
    const harness = createRaceHarness(
      createInMemoryJobFinderRepository(createRaceSeed()),
    );
    try {
      const { state } = await runRaceScenario(harness, async (race) => {
        await race.workspaceService.restoreDismissedDiscoveryJob(
          "job_saved_restore",
        );
      });

      const restoredEntry = state.discoveryLedger.find(
        (entry) => entry.sourceJobId === RESTORED_SAVED_SOURCE_JOB_ID,
      );
      expect(restoredEntry?.latestStatus).toBe("seen");
      expect(restoredEntry?.skipReason).toBeNull();

      const restoredSavedJob = (await harness.repository.listSavedJobs()).find(
        (job) => job.sourceJobId === RESTORED_SAVED_SOURCE_JOB_ID,
      );
      expect(restoredSavedJob).toMatchObject({
        status: "ready_for_review",
        discoveryFeedback: null,
      });
    } finally {
      harness.cleanup();
    }
  }, 60_000);

  test("mid-run dismissal decisions survive an app restart on the file repository", async () => {
    const temporaryDirectories = new Set<string>();
    try {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "nestor-discovery-race-"),
      );
      temporaryDirectories.add(directory);
      const filePath = path.join(directory, "job-finder-state.sqlite");

      let repository = await createFileJobFinderRepository({
        filePath,
        seed: createRaceSeed(),
      });
      const harness = createRaceHarness(repository);
      const { state } = await runRaceScenario(harness, async (race) => {
        await race.workspaceService.dismissDiscoveryJob({
          jobId: "job_pending_race",
          reasons: ["compensation"],
        });
      });
      expect(
        state.pendingDiscoveryJobs.map((job) => job.sourceJobId),
      ).not.toContain(DISMISSED_PENDING_SOURCE_JOB_ID);
      await repository.close();

      repository = await createFileJobFinderRepository({
        filePath,
        seed: createRaceSeed(),
      });
      const restartedState = await repository.getDiscoveryState();
      expect(
        restartedState.pendingDiscoveryJobs.map((job) => job.sourceJobId),
      ).not.toContain(DISMISSED_PENDING_SOURCE_JOB_ID);
      const dismissedEntry = restartedState.discoveryLedger.find(
        (entry) => entry.sourceJobId === DISMISSED_PENDING_SOURCE_JOB_ID,
      );
      expect(dismissedEntry?.latestStatus).toBe("skipped");
      expect(dismissedEntry?.skipReason).toMatch(/^Not interested:/);

      await repository.close();
    } finally {
      await Promise.all(
        [...temporaryDirectories].map((directory) =>
          rm(directory, { recursive: true, force: true }),
        ),
      );
    }
  }, 60_000);
});

describe("paired completion commits", () => {
  test.each([false, true])(
    "delayed source writes keep counters paired with durable jobs (cancel: %s)",
    async (cancel) => {
      const seed = createRaceSeed();
      seed.settings.discoveryOnly = false;
      seed.savedJobs = [];
      seed.discovery.pendingDiscoveryJobs = [];
      seed.discovery.discoveryLedger = [];
      const baseRepository = createInMemoryJobFinderRepository(seed);
      const firstStarted = createDeferred<void>();
      const secondQueued = createDeferred<void>();
      const secondStarted = createDeferred<void>();
      const releaseFirst = createDeferred<void>();
      const releaseSecond = createDeferred<void>();
      const upsertIds: string[] = [];
      let sourceWrites = 0;
      const repository: RaceRepository = {
        ...baseRepository,
        async commitSavedJobDelta(input) {
          if ((input.upserts?.length ?? 0) > 0) {
            sourceWrites += 1;
            if (sourceWrites === 1) {
              firstStarted.resolve();
              await releaseFirst.promise;
            } else if (sourceWrites === 2) {
              secondStarted.resolve();
              await releaseSecond.promise;
            }
            upsertIds.push(...(input.upserts ?? []).map((job) => job.id));
          }
          return baseRepository.commitSavedJobDelta(input);
        },
      };
      const createWriter =
        discoverySavedJobWriter.createDiscoverySavedJobWriter;
      const writerSpy = vi
        .spyOn(discoverySavedJobWriter, "createDiscoverySavedJobWriter")
        .mockImplementation((input) => {
          const writer = createWriter(input);
          return {
            ...writer,
            persist(update) {
              const result = writer.persist(update);
              // Synchronize with the second source's queued boundary, before
              // either durable write is released. Assertions below read storage.
              if (
                update?.(seed.discovery).activeRun?.summary.jobsPersisted === 4
              )
                secondQueued.resolve();
              return result;
            },
          };
        });
      const harness = createRaceHarness(repository);
      const controller = new AbortController();
      const runPromise = harness.workspaceService.runAgentDiscovery(
        (event) => harness.events.push(event),
        controller.signal,
      );
      try {
        await firstStarted.promise;
        harness.finishRun();
        await secondQueued.promise;
        expect(await baseRepository.listSavedJobIds()).toEqual([]);
        expect(
          (await baseRepository.getDiscoveryState()).activeRun?.summary
            .jobsPersisted,
        ).toBe(0);

        releaseFirst.resolve();
        await secondStarted.promise;
        const firstState = await baseRepository.getDiscoveryState();
        expect(await baseRepository.listSavedJobIds()).toHaveLength(1);
        expect(firstState.activeRun?.summary.jobsPersisted).toBe(1);
        expect(firstState.discoveryLedger).toHaveLength(1);
        expect(
          firstState.activeRun?.targetExecutions.find(
            (target) => target.targetId === "target_fast_board",
          ),
        ).toMatchObject({ state: "completed", jobsPersisted: 1 });
        expect(
          firstState.activeRun?.targetExecutions.find(
            (target) => target.targetId === "target_slow_board",
          )?.jobsPersisted,
        ).toBe(0);

        if (cancel) controller.abort();
        releaseSecond.resolve();
        const snapshot = await runPromise;
        const finalState = await baseRepository.getDiscoveryState();
        expect(await baseRepository.listSavedJobIds()).toHaveLength(4);
        expect(new Set(upsertIds).size).toBe(4);
        expect(upsertIds).toHaveLength(4);
        expect(finalState.discoveryLedger).toHaveLength(4);
        expect(snapshot.recentDiscoveryRuns[0]).toMatchObject({
          state: cancel ? "cancelled" : "completed",
          summary: { jobsPersisted: 4, validJobsFound: 4 },
        });
      } finally {
        releaseFirst.resolve();
        releaseSecond.resolve();
        harness.finishRun();
        await runPromise.catch(() => {});
        harness.cleanup();
        writerSpy.mockRestore();
      }
    },
    30_000,
  );

  test("per-target and final completions pair saved-job deltas with discovery updates in one commit", async () => {
    const baseRepository = createInMemoryJobFinderRepository(createRaceSeed());
    let pairedDeltaCount = 0;
    let bareDeltaCount = 0;
    const repository: RaceRepository = {
      ...baseRepository,
      commitSavedJobDelta(input) {
        if (input.updateDiscoveryState) {
          pairedDeltaCount += 1;
        } else {
          bareDeltaCount += 1;
        }
        return baseRepository.commitSavedJobDelta(input);
      },
    };
    const harness = createRaceHarness(repository);
    try {
      const { snapshot } = await runRaceScenario(harness, async () => {});

      expect(snapshot.recentDiscoveryRuns[0]?.summary.outcome).toBe(
        "completed",
      );
      // Revalidated rows and final plan membership remain paired with run
      // state. The two run-only completions do not issue empty row updates.
      expect(pairedDeltaCount).toBe(2);
      expect(bareDeltaCount).toBe(0);
    } finally {
      harness.cleanup();
    }
  }, 60_000);

  test("a dismissal landing behind an in-flight per-target paired commit stays durable", async () => {
    const baseRepository = createInMemoryJobFinderRepository(createRaceSeed());
    const releaseHeldCommit = createDeferred<void>();
    let heldPairedCommit = false;
    const repository: RaceRepository = {
      ...baseRepository,
      commitSavedJobDelta(input) {
        if (!heldPairedCommit && input.updateDiscoveryState) {
          heldPairedCommit = true;
          return releaseHeldCommit.promise.then(() =>
            baseRepository.commitSavedJobDelta(input),
          );
        }
        return baseRepository.commitSavedJobDelta(input);
      },
    };
    const harness = createRaceHarness(repository);
    try {
      const runPromise = harness.workspaceService.runAgentDiscovery((event) =>
        harness.events.push(event),
      );

      await vi.waitFor(() => {
        expect(heldPairedCommit).toBe(true);
      });

      await harness.workspaceService.dismissDiscoveryJob({
        jobId: "job_pending_race",
        reasons: ["compensation"],
      });

      releaseHeldCommit.resolve();
      harness.finishRun();
      const snapshot = await runPromise;
      const state = await harness.repository.getDiscoveryState();

      expect(snapshot.recentDiscoveryRuns[0]?.summary.outcome).toBe(
        "completed",
      );
      expect(
        snapshot.recentDiscoveryRuns[0]?.targetExecutions.find(
          (target) => target.targetId === "target_fast_board",
        ),
      ).toMatchObject({ state: "completed", jobsStaged: 1 });

      const pendingSourceJobIds = state.pendingDiscoveryJobs.map(
        (job) => job.sourceJobId,
      );
      expect(pendingSourceJobIds).not.toContain(
        DISMISSED_PENDING_SOURCE_JOB_ID,
      );
      expect(pendingSourceJobIds).toContain(STAGED_NEW_SOURCE_JOB_ID);

      const dismissedEntry = state.discoveryLedger.find(
        (entry) => entry.sourceJobId === DISMISSED_PENDING_SOURCE_JOB_ID,
      );
      expect(dismissedEntry?.latestStatus).toBe("skipped");
      expect(dismissedEntry?.skipReason).toMatch(/^Not interested:/);
    } finally {
      harness.cleanup();
    }
  }, 60_000);
});

describe("rebaseRunLedgerOntoPersisted ownership rules", () => {
  const createEntryFixture = (input: {
    id: string;
    latestStatus: DiscoveryLedgerEntry["latestStatus"];
    skipReason?: string | null;
  }): DiscoveryLedgerEntry =>
    DiscoveryLedgerEntrySchema.parse({
      id: input.id,
      canonicalUrl: `https://job-boards.example.com/jobs/${input.id}`,
      applicationUrl: null,
      source: "target_site",
      sourceJobId: input.id,
      providerKey: null,
      providerBoardToken: null,
      providerIdentifier: null,
      providerUpdatedAt: null,
      title: `Role ${input.id}`,
      company: "Example Co",
      location: "Remote",
      postedAt: null,
      postedAtText: null,
      targetId: "target_slow_board",
      collectionMethod: "api",
      detailQuality: "card_only",
      fingerprints: createDiscoveryListingFingerprints({
        applicationUrl: null,
        title: `Role ${input.id}`,
        company: "Example Co",
        location: "Remote",
        workMode: ["remote"],
        applyPath: "external_redirect",
        easyApplyEligible: false,
        postedAt: null,
        postedAtText: null,
        providerUpdatedAt: null,
        salaryText: null,
        employmentType: null,
        department: null,
        team: null,
        detailQuality: "card_only",
        summary: null,
        description:
          "<p>Lead product design systems and resilient workflow platforms.</p>",
        keySkills: [],
        responsibilities: [],
        minimumQualifications: [],
        preferredQualifications: [],
        seniority: null,
        screeningHints: {
          sponsorshipText: null,
          requiresSecurityClearance: null,
          relocationText: null,
          travelText: null,
          remoteGeographies: [],
          requiresConsentInterrupt: null,
          requiresConsentInterruptKind: null,
        },
        benefits: [],
      }),
      firstSeenAt: "2026-08-01T00:00:00.000Z",
      lastSeenAt: "2026-08-01T00:00:00.000Z",
      lastAppliedAt: null,
      lastEnrichedAt: null,
      inactiveAt: null,
      latestStatus: input.latestStatus,
      skipReason: input.skipReason ?? null,
      titleTriageOutcome: "pass",
    });

  test("preserves a mid-run dismissal (skipped) over the run's stale seen echo", () => {
    const baseline = createEntryFixture({ id: "a", latestStatus: "seen" });
    const working = createEntryFixture({ id: "a", latestStatus: "seen" });
    const persisted = createEntryFixture({
      id: "a",
      latestStatus: "skipped",
      skipReason: "Not interested: compensation.",
    });

    expect(
      rebaseRunLedgerOntoPersisted({
        baselineLedger: [baseline],
        workingLedger: [working],
        persistedLedger: [persisted],
      }),
    ).toEqual([persisted]);
  });

  test("preserves a mid-run applied decision over a run observation", () => {
    const baseline = createEntryFixture({ id: "a", latestStatus: "seen" });
    const working = createEntryFixture({ id: "a", latestStatus: "enriched" });
    const persisted = createEntryFixture({ id: "a", latestStatus: "applied" });

    expect(
      rebaseRunLedgerOntoPersisted({
        baselineLedger: [baseline],
        workingLedger: [working],
        persistedLedger: [persisted],
      }),
    ).toEqual([persisted]);
  });

  test("preserves a mid-run restore (seen) against the stale skipped echo", () => {
    const baseline = createEntryFixture({
      id: "a",
      latestStatus: "skipped",
      skipReason: "Not interested: company.",
    });
    const working = createEntryFixture({
      id: "a",
      latestStatus: "skipped",
      skipReason: "Not interested: company.",
    });
    const persisted = createEntryFixture({ id: "a", latestStatus: "seen" });

    expect(
      rebaseRunLedgerOntoPersisted({
        baselineLedger: [baseline],
        workingLedger: [working],
        persistedLedger: [persisted],
      }),
    ).toEqual([persisted]);
  });

  test("lets run-owned transitions through when nothing external moved", () => {
    const baseline = createEntryFixture({ id: "a", latestStatus: "seen" });
    const working = createEntryFixture({ id: "a", latestStatus: "inactive" });
    const persisted = createEntryFixture({ id: "a", latestStatus: "seen" });

    expect(
      rebaseRunLedgerOntoPersisted({
        baselineLedger: [baseline],
        workingLedger: [working],
        persistedLedger: [persisted],
      }),
    ).toEqual([working]);
  });

  test("appends run-discovered entries and keeps untouched persisted entries", () => {
    const untouched = createEntryFixture({
      id: "untouched",
      latestStatus: "enriched",
    });
    const discovered = createEntryFixture({
      id: "fresh",
      latestStatus: "seen",
    });

    expect(
      rebaseRunLedgerOntoPersisted({
        baselineLedger: [],
        workingLedger: [discovered],
        persistedLedger: [untouched],
      }),
    ).toEqual([untouched, discovered]);
  });
});

describe("overlayTouchedPendingJobs removal guard", () => {
  const baseJob = createSeed().savedJobs[0];

  test("drops a baseline pending job removed externally while the run was in flight", () => {
    if (!baseJob) throw new Error("Expected a saved job fixture.");
    const removed = { ...baseJob, id: "job_removed_mid_run" };
    const staged = { ...baseJob, id: "job_staged_by_run" };
    const refreshed = { ...baseJob, id: "job_still_present" };
    const baselineIds = new Set([removed.id, refreshed.id]);

    const result = overlayTouchedPendingJobs(
      [refreshed],
      [removed, staged, refreshed],
      new Set([removed.id, staged.id, refreshed.id]),
      baselineIds,
    );

    expect(result.map((job) => job.id).sort()).toEqual(
      ["job_staged_by_run", "job_still_present"].sort(),
    );
  });

  test("behaves unchanged when no baseline ids are supplied", () => {
    if (!baseJob) throw new Error("Expected a saved job fixture.");
    const removed = { ...baseJob, id: "job_removed_mid_run" };

    expect(
      overlayTouchedPendingJobs([], [removed], new Set([removed.id])),
    ).toEqual([removed]);
  });
});

describe("second-run guard", () => {
  test("a second search over the same plan returns the live run id, not a new run", async () => {
    const harness = createRaceHarness(
      createInMemoryJobFinderRepository(createRaceSeed()),
    );
    try {
      const runPromise = harness.workspaceService.runAgentDiscovery((event) =>
        harness.events.push(event),
      );
      await vi.waitFor(() => {
        expect(completedTargetIds(harness.events)).toContain(
          "target_fast_board",
        );
      });

      const second = await harness.workspaceService
        .runAgentDiscovery()
        .then(() => null)
        .catch((error: unknown) => error);

      expect(second).toBeInstanceOf(DiscoveryRunAlreadyActiveError);
      const guard = second as DiscoveryRunAlreadyActiveError;
      expect(guard.message).toBe("A search is already running for this plan.");
      expect(guard.activeRunId).toMatch(/^discovery_run/);

      harness.finishRun();
      await runPromise;

      const state = await harness.repository.getDiscoveryState();
      // One run started, so exactly one run record exists for it.
      expect(
        state.recentRuns.filter((run) => run.id === guard.activeRunId),
      ).toHaveLength(1);
    } finally {
      harness.cleanup();
    }
  });
});
