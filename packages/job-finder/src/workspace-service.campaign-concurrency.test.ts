import { describe, expect, test, vi } from "vitest";

import type { BrowserSessionRuntime } from "@nordri/browser-runtime";
import {
  JobSearchCampaignScheduleSchema,
  type CampaignRunFacts,
  type JobDiscoveryTarget,
  type JobSearchCampaign,
  type JobSearchCampaignSchedule,
  type JobSearchPreferences,
  type SaveJobSearchCampaignInput,
} from "@nordri/contracts";
import {
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
  type JobFinderRepositorySeed,
} from "@nordri/db";

import { createJobFinderWorkspaceService } from "./index";
import { buildInstructionGuidance } from "./internal/workspace-helpers";
import {
  createSavedJob,
  createSavedJobDiscoveryProvenance,
  createSeed,
  createSourceInstructionArtifact,
} from "./workspace-service.test-fixtures";
import {
  createAgentAiClient,
  createAgentBrowserRuntime,
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
} from "./workspace-service.test-runtimes";
import { createStrongSourceDebugFindingsByPhase } from "./workspace-service.test-findings";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createSchedule(
  overrides: Partial<JobSearchCampaignSchedule> = {},
): JobSearchCampaignSchedule {
  return JobSearchCampaignScheduleSchema.parse({
    mode: "manual",
    enabled: false,
    daysOfWeek: [],
    localStartTime: null,
    timeZone: null,
    pauseWindows: [],
    runFacts: {},
    ...overrides,
  });
}

function createRunFacts(
  overrides: Partial<CampaignRunFacts> = {},
): CampaignRunFacts {
  return {
    nextRunAt: null,
    lastRunAt: null,
    lastRunOutcome: null,
    lastRunSummary: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function dueDailySchedule(nextRunAt: string): JobSearchCampaignSchedule {
  return createSchedule({
    mode: "daily",
    enabled: true,
    localStartTime: "09:00",
    timeZone: "UTC",
    runFacts: createRunFacts({ nextRunAt }),
  });
}

function toCampaignInput(
  campaign: JobSearchCampaign,
  overrides: Partial<SaveJobSearchCampaignInput> = {},
): SaveJobSearchCampaignInput {
  return {
    id: campaign.id,
    name: campaign.name,
    description: campaign.description,
    mode: campaign.mode,
    status: campaign.status,
    searchPreferences: campaign.searchPreferences,
    sourceTargetIds: campaign.sourceTargetIds,
    minimumFitScore: campaign.minimumFitScore,
    limits: campaign.limits,
    stopRules: campaign.stopRules,
    applicationPolicy: campaign.applicationPolicy,
    rules: campaign.rules,
    schedule: campaign.schedule,
    latestDigest: campaign.latestDigest,
    ...overrides,
  };
}

/**
 * Wraps the repository so a subsequent `getCampaignState` reader can be
 * parked on a gate after fetching state, and so campaign writes can be held in
 * a manually drained queue. Parking a read forces a tick to
 * iterate a stale snapshot; holding writes makes a save straddle everything
 * that runs while it is held — the two reachable interleaves behind the
 * campaign-state race.
 */
function createConcurrencyHarness(
  overrides: {
    browserRuntime?: BrowserSessionRuntime;
    aiClient?: ReturnType<typeof createAgentAiClient>;
    seed?: JobFinderRepositorySeed;
  } = {},
) {
  type CampaignPreferencesUpdate = Parameters<
    JobFinderRepository["commitCampaignPreferencesUpdate"]
  >[0];
  const baseRepository = createInMemoryJobFinderRepository(
    overrides.seed ?? createSeed(),
  );
  const readGate = createDeferred<void>();
  let parkNextRead = false;
  let holdSaves = false;
  let startedCampaignReads = 0;
  const beforeReadGates = new Map<
    number,
    { gate: ReturnType<typeof createDeferred<void>> }
  >();
  const heldSaves: Array<{
    kind: "state" | "preferences";
    commit: () => Promise<unknown>;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  const repository: JobFinderRepository = {
    ...baseRepository,
    getCampaignState: async () => {
      startedCampaignReads += 1;
      const pendingGate = beforeReadGates.get(startedCampaignReads);
      if (pendingGate) {
        await pendingGate.gate.promise;
      }
      const state = await baseRepository.getCampaignState();
      if (parkNextRead) {
        parkNextRead = false;
        await readGate.promise;
      }
      return state;
    },
    saveCampaignState: async (state) => {
      if (!holdSaves) return baseRepository.saveCampaignState(state);
      return new Promise<void>((resolve, reject) => {
        heldSaves.push({
          kind: "state",
          commit: () => baseRepository.saveCampaignState(state),
          resolve: () => resolve(),
          reject,
        });
      });
    },
    commitCampaignPreferencesUpdate: async <TResult>(
      update: CampaignPreferencesUpdate,
    ) => {
      if (!holdSaves) {
        return baseRepository.commitCampaignPreferencesUpdate(
          update,
        ) as Promise<TResult>;
      }
      return new Promise<TResult>((resolve, reject) => {
        heldSaves.push({
          kind: "preferences",
          commit: () => baseRepository.commitCampaignPreferencesUpdate(update),
          resolve: () => resolve(undefined as TResult),
          reject,
        });
      });
    },
  };
  const service = createJobFinderWorkspaceService({
    repository,
    browserRuntime: overrides.browserRuntime ?? createBrowserRuntime(),
    aiClient: overrides.aiClient ?? createAiClient(),
    documentManager: createDocumentManager(),
  });

  async function flushHeldSave(): Promise<boolean> {
    const entry = heldSaves.shift();
    if (!entry) return false;
    try {
      await entry.commit();
      entry.resolve();
    } catch (error) {
      entry.reject(error);
    }
    return true;
  }

  /**
   * Commits one held save by queue position, leaving any other held saves
   * parked. Out-of-order flushing exposes a stale write that an unserialized
   * implementation queued behind (or ahead of) a competing commit.
   */
  async function flushHeldSaveAt(index: number): Promise<boolean> {
    const entry = heldSaves[index];
    if (!entry) return false;
    heldSaves.splice(index, 1);
    try {
      await entry.commit();
      entry.resolve();
    } catch (error) {
      entry.reject(error);
    }
    return true;
  }

  return {
    baseRepository,
    repository,
    service,
    readGate,
    armReadPark: () => {
      parkNextRead = true;
    },
    /** Total campaign-state reads started across the whole test so far. */
    campaignReadsStarted: () => startedCampaignReads,
    /** Gates the `atIndex`-th campaign-state read before it fetches state. */
    armBeforeReadGate: (atIndex: number) => {
      beforeReadGates.set(atIndex, { gate: createDeferred<void>() });
    },
    resolveBeforeReadGate: (atIndex: number) => {
      const pendingGate = beforeReadGates.get(atIndex);
      if (!pendingGate) throw new Error(`No gate armed at ${atIndex}.`);
      pendingGate.gate.resolve();
    },
    holdSaves: () => {
      holdSaves = true;
    },
    heldSaveCount: () => heldSaves.length,
    /** Persist kinds of the currently held saves, in queue order. */
    heldSaveKinds: () => heldSaves.map((entry) => entry.kind),
    flushHeldSave,
    flushHeldSaveAt,
    releaseHeldSaves: async () => {
      holdSaves = false;
      while (heldSaves.length > 0) {
        await flushHeldSave();
      }
    },
    /** Waits until at least `count` saves are held, or the timeout elapses. */
    waitForHeldSaves: async (count: number, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (heldSaves.length < count && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      return heldSaves.length >= count;
    },
  };
}

/** Yields macrotasks so concurrently started work can settle. */
async function drainMacrotasks(rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function getActiveCampaign(
  service: ReturnType<typeof createJobFinderWorkspaceService>,
): Promise<JobSearchCampaign> {
  const snapshot = await service.getWorkspaceSnapshot();
  const active = snapshot.campaigns.find(
    (campaign) => campaign.id === snapshot.activeCampaignId,
  );
  if (!active) throw new Error("Expected an active campaign fixture.");
  return active;
}

function countDiscoveryRuns(campaign: JobSearchCampaign | undefined): number {
  return (
    campaign?.history.filter((entry) => entry.kind === "discovery_run")
      .length ?? 0
  );
}

/**
 * Writes a scheduled-terminal-commit-shaped collection straight to the store,
 * bypassing service locks: a fresh digest notification, advanced run facts
 * (`nextRunAt`, outcome), and a `discovery_run` history entry on the active
 * campaign. Returns the committed `nextRunAt`.
 */
async function commitScheduledRunFactsWhileParked(
  baseRepository: JobFinderRepository,
  committedAt: string,
): Promise<string> {
  const current = await baseRepository.getCampaignState();
  if (!current) throw new Error("Expected campaign state.");
  const nextRunAt = new Date(
    Date.parse(committedAt) + 30 * 60 * 1_000,
  ).toISOString();
  await baseRepository.saveCampaignState({
    ...current,
    notifications: [
      {
        id: "commit_notification_while_parked",
        campaignId: current.activeCampaignId,
        kind: "digest_ready",
        title: "Scheduled run committed.",
        body: null,
        createdAt: committedAt,
        readAt: null,
        unread: true,
        jobId: null,
        sourceTargetId: null,
      },
      ...current.notifications,
    ],
    campaigns: current.campaigns.map((campaign) =>
      campaign.id === current.activeCampaignId
        ? {
            ...campaign,
            schedule: {
              ...campaign.schedule,
              runFacts: {
                ...campaign.schedule.runFacts,
                nextRunAt,
                lastRunAt: committedAt,
                lastRunOutcome: "success",
                lastRunSummary: "Committed while a reader was parked.",
              },
            },
            history: [
              {
                id: "committed_history_while_parked",
                campaignId: campaign.id,
                kind: "discovery_run" as const,
                occurredAt: committedAt,
                summary: "Committed while a reader was parked.",
                discoveryRunId: "run_committed_while_parked",
              },
              ...campaign.history,
            ],
          }
        : campaign,
    ),
  });
  return nextRunAt;
}

/**
 * Writes a terminal-commit-shaped collection straight to the store, bypassing
 * service locks: everything `commitScheduledRunFactsWhileParked` writes plus
 * advanced progress timestamps (`lastRunAt`/`lastUpdatedAt`) exactly like
 * `commitCampaignRunTerminal` stamps them. Returns nothing; callers assert
 * against the exact `committedAt`.
 */
async function commitTerminalProgressWhileParked(
  baseRepository: JobFinderRepository,
  committedAt: string,
): Promise<void> {
  const current = await baseRepository.getCampaignState();
  if (!current) throw new Error("Expected campaign state.");
  const nextRunAt = new Date(
    Date.parse(committedAt) + 30 * 60 * 1_000,
  ).toISOString();
  await baseRepository.saveCampaignState({
    ...current,
    notifications: [
      {
        id: "commit_notification_terminal_progress",
        campaignId: current.activeCampaignId,
        kind: "digest_ready",
        title: "Scheduled run committed.",
        body: null,
        createdAt: committedAt,
        readAt: null,
        unread: true,
        jobId: null,
        sourceTargetId: null,
      },
      ...current.notifications,
    ],
    campaigns: current.campaigns.map((campaign) =>
      campaign.id === current.activeCampaignId
        ? {
            ...campaign,
            progress: {
              ...campaign.progress,
              lastRunAt: committedAt,
              lastUpdatedAt: committedAt,
            },
            schedule: {
              ...campaign.schedule,
              runFacts: {
                ...campaign.schedule.runFacts,
                nextRunAt,
                lastRunAt: committedAt,
                lastRunOutcome: "success" as const,
                lastRunSummary: "Committed while a reader was parked.",
              },
            },
            history: [
              {
                id: "committed_history_terminal_progress",
                campaignId: campaign.id,
                kind: "discovery_run" as const,
                occurredAt: committedAt,
                summary: "Committed while a reader was parked.",
                discoveryRunId: "run_committed_terminal_progress",
              },
              ...campaign.history,
            ],
          }
        : campaign,
    ),
  });
}

describe("workspace campaign state concurrency", () => {
  test("a save held mid-write across a scheduled commit cannot resurrect a consumed slot or drop committed facts", async () => {
    const harness = createConcurrencyHarness();
    const { repository, service } = harness;
    const active = await getActiveCampaign(service);
    const now = new Date().toISOString();
    const overdue = new Date(Date.parse(now) - 60 * 60 * 1_000).toISOString();
    await service.saveCampaign(
      toCampaignInput(active, { schedule: dueDailySchedule(overdue) }),
    );

    // Hold the save's collection WRITE so it straddles the tick's whole
    // lifecycle. An unserialized implementation lets the tick's commit land
    // in that gap and then overwrites the committed facts with the stale
    // snapshot; the serialized implementation cannot start the tick until
    // the save releases, so nothing can land in the gap.
    harness.holdSaves();
    const edited = service.saveCampaign(
      toCampaignInput(active, {
        name: "Renamed plan",
        schedule: dueDailySchedule(overdue),
      }),
    );
    await drainMacrotasks(5);
    expect(harness.heldSaveCount()).toBe(1);
    const tick = service.runDueScheduledCampaigns(now);

    // Give an unserialized tick room to enqueue its commit behind the held
    // save; a serialized tick stays blocked on the campaign transition until
    // the save releases, so this wait is a cheap no-op there.
    await harness.waitForHeldSaves(2, 400);
    if (harness.heldSaveCount() >= 2) {
      // The tick committed into the gap: persist its facts for real before
      // the stale save gets a chance to overwrite them.
      expect(await harness.flushHeldSave()).toBe(true);
    }
    await harness.releaseHeldSaves();
    await Promise.all([edited, tick]);

    // The slot must have been consumed exactly once. A stale save that
    // resurrected `overdue` would make this second tick execute a duplicate
    // scheduled run and add a second discovery_run history entry.
    await service.runDueScheduledCampaigns(now);

    const state = await repository.getCampaignState();
    const campaign = state?.campaigns.find((c) => c.id === active.id);
    expect(campaign?.name).toBe("Renamed plan");
    expect(campaign?.schedule.runFacts.lastRunOutcome).toBe("success");
    expect(countDiscoveryRuns(campaign)).toBe(1);
    const nextRunAt = campaign?.schedule.runFacts.nextRunAt;
    expect(nextRunAt).not.toBeNull();
    expect(Date.parse(nextRunAt!)).toBeGreaterThan(Date.parse(now));
  });

  test("an overlapping tick on a stale snapshot cannot re-run a consumed slot", async () => {
    const harness = createConcurrencyHarness();
    const { repository, service } = harness;
    const active = await getActiveCampaign(service);
    const now = new Date().toISOString();
    const overdue = new Date(Date.parse(now) - 60 * 60 * 1_000).toISOString();
    await service.saveCampaign(
      toCampaignInput(active, { schedule: dueDailySchedule(overdue) }),
    );

    // Park the first tick before it iterates campaigns, then let a second
    // overlapping tick claim and complete the due slot. When the parked tick
    // resumes, its snapshot still shows `overdue` as due; the claim's
    // compare-and-set must reject it.
    harness.armReadPark();
    const staleTick = service.runDueScheduledCampaigns(now);
    await drainMacrotasks(5);
    const freshTick = service.runDueScheduledCampaigns(now);
    await freshTick;
    harness.readGate.resolve();
    await staleTick;

    await service.runDueScheduledCampaigns(now);

    const state = await repository.getCampaignState();
    const campaign = state?.campaigns.find((c) => c.id === active.id);
    expect(campaign?.schedule.runFacts.lastRunOutcome).toBe("success");
    expect(countDiscoveryRuns(campaign)).toBe(1);
    const nextRunAt = campaign?.schedule.runFacts.nextRunAt;
    expect(nextRunAt).not.toBeNull();
    expect(Date.parse(nextRunAt!)).toBeGreaterThan(Date.parse(now));
  });

  test("a select that lands before a claimed scheduled commit keeps the active pointer", async () => {
    const harness = createConcurrencyHarness();
    const { repository, service } = harness;
    const active = await getActiveCampaign(service);
    const now = new Date().toISOString();
    const overdue = new Date(Date.parse(now) - 60 * 60 * 1_000).toISOString();
    await service.saveCampaign(
      toCampaignInput(active, { schedule: dueDailySchedule(overdue) }),
    );
    // Campaign B stays manual so the parked tick has exactly one due slot.
    const created = await service.saveCampaign(
      toCampaignInput(active, { id: null, name: "Campaign B" }),
    );
    const campaignB = created.campaigns.find(
      (campaign) => campaign.name === "Campaign B",
    );
    if (!campaignB) throw new Error("Expected campaign B.");

    // Park the ticker's initial snapshot, select campaign B while it is
    // parked, then let the ticker claim and commit its run. The commit is
    // derived from fresh state and must preserve the selection.
    harness.armReadPark();
    const tick = service.runDueScheduledCampaigns(now);
    await drainMacrotasks(5);
    await service.selectCampaign(campaignB.id);
    harness.readGate.resolve();
    await tick;

    const snapshot = await service.getWorkspaceSnapshot();
    expect(snapshot.activeCampaignId).toBe(campaignB.id);
    expect(await repository.getSearchPreferences()).toEqual(
      campaignB.searchPreferences,
    );
    const state = await repository.getCampaignState();
    const ran = state?.campaigns.find(
      (candidate) => candidate.id === active.id,
    );
    expect(ran?.schedule.runFacts.lastRunOutcome).toBe("success");
    expect(countDiscoveryRuns(ran)).toBe(1);
    const selected = state?.campaigns.find(
      (candidate) => candidate.id === campaignB.id,
    );
    expect(selected?.history[0]?.kind).toBe("activated");
    // The selected campaign's own schedule stays untouched by the other
    // campaign's committed run.
    expect(selected?.schedule.runFacts.lastRunAt).toBeNull();
    expect(selected?.schedule.runFacts.nextRunAt).toBeNull();
  });

  test("concurrent select and save keep the active pointer paired with global preferences", async () => {
    const harness = createConcurrencyHarness();
    const { baseRepository, service } = harness;
    const active = await getActiveCampaign(service);
    const created = await service.saveCampaign(
      toCampaignInput(active, { id: null, name: "Campaign B" }),
    );
    const campaignB = created.campaigns.find(
      (campaign) => campaign.name === "Campaign B",
    );
    if (!campaignB) throw new Error("Expected campaign B.");

    await Promise.all([
      service.selectCampaign(campaignB.id),
      service.saveCampaign(
        toCampaignInput(active, { name: "Renamed original" }),
      ),
    ]);

    const snapshot = await service.getWorkspaceSnapshot();
    const byId = new Map(
      snapshot.campaigns.map((campaign) => [campaign.id, campaign]),
    );
    // Both operations survive: neither may drop the other's campaign or edit.
    expect(byId.has(active.id)).toBe(true);
    expect(byId.has(campaignB.id)).toBe(true);
    expect(byId.get(active.id)?.name).toBe("Renamed original");

    // The pointer and global preferences are always one coherent pair.
    const pointer = snapshot.activeCampaignId;
    expect(pointer === active.id || pointer === campaignB.id).toBe(true);
    const pointed = byId.get(pointer);
    if (!pointed) throw new Error("Expected the pointed campaign.");
    expect(await baseRepository.getSearchPreferences()).toEqual(
      pointed.searchPreferences,
    );
  });

  test("a discovery started into a missing collection cannot stale-overwrite a concurrent creation", async () => {
    const harness = createConcurrencyHarness();
    const { repository, service } = harness;

    // Hold every campaign-state save so the scoped-discovery bootstrap parks
    // its unlocked default-creation write instead of committing before the
    // serialized writer reads.
    harness.holdSaves();
    const discovery = service.runAgentDiscovery(() => {});
    await vi.waitFor(() => expect(harness.heldSaveCount()).toBe(1));

    // A locked preferences-sync creates the collection it mutates. If the
    // bootstrap is unserialized, both writes end up held at once and the
    // synced one can be committed first, exposing any stale overwrite.
    const globalPreferences =
      await harness.baseRepository.getSearchPreferences();
    const sync = service.saveSearchPreferences({
      ...globalPreferences,
      targetRoles: ["Principal UX Engineer"],
    });
    if (await harness.waitForHeldSaves(2, 400)) {
      expect(await harness.flushHeldSaveAt(1)).toBe(true);
      // Commit the stale default LAST so the store observably regresses to
      // it; an unserialized bootstrap has already lost the synced creation.
      expect(await harness.flushHeldSaveAt(0)).toBe(true);
      const damagedState = await repository.getCampaignState();
      expect(damagedState?.campaigns[0]?.searchPreferences.targetRoles).toEqual(
        ["Principal UX Engineer"],
      );
    }
    await harness.releaseHeldSaves();
    await Promise.allSettled([discovery, sync]);
    await harness.releaseHeldSaves();

    // Exactly one default campaign survives, carrying the concurrent edit.
    const state = await repository.getCampaignState();
    expect(state?.activeCampaignId).toBe("campaign_default");
    expect(state?.campaigns).toHaveLength(1);
    expect(state?.campaigns[0]?.searchPreferences.targetRoles).toEqual([
      "Principal UX Engineer",
    ]);
  });

  test("a preparation guard started into a missing collection cannot stale-overwrite a concurrent creation", async () => {
    const harness = createConcurrencyHarness();
    const { repository, service } = harness;

    harness.holdSaves();
    const preparation = service.startApplyCopilotRun("job_ready");
    await vi.waitFor(() => expect(harness.heldSaveCount()).toBe(1));

    const globalPreferences =
      await harness.baseRepository.getSearchPreferences();
    const sync = service.saveSearchPreferences({
      ...globalPreferences,
      targetRoles: ["Principal UX Engineer"],
    });
    if (await harness.waitForHeldSaves(2, 400)) {
      expect(await harness.flushHeldSaveAt(1)).toBe(true);
      // Commit the stale default LAST so the store observably regresses to
      // it; an unserialized bootstrap has already lost the synced creation.
      expect(await harness.flushHeldSaveAt(0)).toBe(true);
      const damagedState = await repository.getCampaignState();
      expect(damagedState?.campaigns[0]?.searchPreferences.targetRoles).toEqual(
        ["Principal UX Engineer"],
      );
    }
    await harness.releaseHeldSaves();
    await preparation.catch(() => undefined);
    await sync;
    await harness.releaseHeldSaves();

    const state = await repository.getCampaignState();
    expect(state?.activeCampaignId).toBe("campaign_default");
    expect(state?.campaigns).toHaveLength(1);
    expect(state?.campaigns[0]?.searchPreferences.targetRoles).toEqual([
      "Principal UX Engineer",
    ]);
  });

  test("schedule initialization recomputes from fresh state so a concurrent edit survives", async () => {
    const harness = createConcurrencyHarness();
    const { repository, service } = harness;
    const active = await getActiveCampaign(service);
    const now = new Date().toISOString();
    const uninitializedDaily = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "09:00",
      timeZone: "UTC",
      runFacts: createRunFacts(),
    });
    await service.saveCampaign(
      toCampaignInput(active, { schedule: uninitializedDaily }),
    );

    // Park the ticker on its outer snapshot read, then edit the campaign
    // while that parked snapshot still shows the old name and no nextRunAt.
    harness.armReadPark();
    const tick = service.runDueScheduledCampaigns(now);
    await drainMacrotasks(5);
    await service.saveCampaign(
      toCampaignInput(active, {
        name: "Renamed while parked",
        schedule: uninitializedDaily,
      }),
    );
    harness.readGate.resolve();
    await tick;

    // Initialization must not resurrect the stale outer snapshot: the
    // concurrent rename survives AND the schedule gains a truthful due
    // instant computed from the edited state, without any immediate work.
    const state = await repository.getCampaignState();
    const campaign = state?.campaigns.find((c) => c.id === active.id);
    expect(campaign?.name).toBe("Renamed while parked");
    const nextRunAt = campaign?.schedule.runFacts.nextRunAt;
    expect(nextRunAt).not.toBeNull();
    expect(Date.parse(nextRunAt!)).toBeGreaterThan(Date.parse(now));
    expect(campaign?.schedule.runFacts.lastRunAt).toBeNull();
    expect(countDiscoveryRuns(campaign)).toBe(0);
  });

  test("a claimed scheduled run executes with the budget and preferences current at claim time", async () => {
    const base = createBrowserRuntime();
    const capturedTargetRoles: string[][] = [];
    const browserRuntime: BrowserSessionRuntime = {
      ...base,
      runAgentDiscovery: (source, options) => {
        capturedTargetRoles.push([...options.searchPreferences.targetRoles]);
        return base.runAgentDiscovery!(source, options);
      },
    };
    const harness = createConcurrencyHarness({ browserRuntime });
    const { repository, service } = harness;
    const active = await getActiveCampaign(service);
    const now = new Date().toISOString();
    const overdue = new Date(Date.parse(now) - 60 * 60 * 1_000).toISOString();
    await service.saveCampaign(
      toCampaignInput(active, {
        schedule: dueDailySchedule(overdue),
        limits: { ...active.limits, discoveryRunJobBudget: 7 },
      }),
    );

    // Park the ticker's outer snapshot, then raise the run budget and
    // retarget roles while it is parked. Both saves keep the same due
    // instant so the claim's compare-and-set still matches.
    harness.armReadPark();
    const tick = service.runDueScheduledCampaigns(now);
    await drainMacrotasks(5);
    await service.saveCampaign(
      toCampaignInput(active, {
        schedule: dueDailySchedule(overdue),
        limits: { ...active.limits, discoveryRunJobBudget: 21 },
        searchPreferences: {
          ...active.searchPreferences,
          targetRoles: ["Principal UX Engineer"],
        },
      }),
    );
    harness.readGate.resolve();
    await tick;

    // Discovery executed against the claimed snapshot, not the parked one.
    expect(capturedTargetRoles).toEqual([["Principal UX Engineer"]]);
    const discoveryState = await repository.getDiscoveryState();
    const scheduledRun = discoveryState.recentRuns.find(
      (candidate) => candidate.campaignId === active.id,
    );
    if (!scheduledRun) throw new Error("Expected a scheduled discovery run.");
    expect(
      scheduledRun.targetExecutions.map(
        (execution) => execution.requestedJobBudget,
      ),
    ).toEqual([21]);

    // The claimed slot committed exactly one terminal run and advanced;
    // a follow-up tick at the same instant stays single-run.
    const state = await repository.getCampaignState();
    const campaign = state?.campaigns.find((c) => c.id === active.id);
    expect(campaign?.schedule.runFacts.lastRunOutcome).toBe("success");
    const nextRunAt = campaign?.schedule.runFacts.nextRunAt;
    expect(nextRunAt).not.toBeNull();
    expect(Date.parse(nextRunAt!)).toBeGreaterThan(Date.parse(now));
    expect(countDiscoveryRuns(campaign)).toBe(1);

    await service.runDueScheduledCampaigns(now);
    const finalState = await repository.getCampaignState();
    const finalCampaign = finalState?.campaigns.find(
      (candidate) => candidate.id === active.id,
    );
    expect(countDiscoveryRuns(finalCampaign)).toBe(1);
  });

  test("an already-in-progress discovery releases the claimed slot back to the schedule", async () => {
    const base = createBrowserRuntime();
    const discoveryGate = createDeferred<void>();
    let discoveryCalls = 0;
    const browserRuntime: BrowserSessionRuntime = {
      ...base,
      runAgentDiscovery: (source, options) => {
        discoveryCalls += 1;
        if (discoveryCalls === 1) {
          return discoveryGate.promise.then(() =>
            base.runAgentDiscovery!(source, options),
          );
        }
        return base.runAgentDiscovery!(source, options);
      },
    };
    const harness = createConcurrencyHarness({ browserRuntime });
    const { repository, service } = harness;
    const active = await getActiveCampaign(service);
    const now = new Date().toISOString();
    const overdue = new Date(Date.parse(now) - 60 * 60 * 1_000).toISOString();
    await service.saveCampaign(
      toCampaignInput(active, { schedule: dueDailySchedule(overdue) }),
    );

    // A manual discovery owns the pipeline and parks mid-run...
    const manual = service.runCampaignNow();
    await vi.waitFor(() => expect(discoveryCalls).toBe(1));
    // ...so the scheduled tick's claim hits already-in-progress and must put
    // the slot back due instead of dropping it or double-running.
    await service.runDueScheduledCampaigns(now);

    let state = await repository.getCampaignState();
    let campaign = state?.campaigns.find((c) => c.id === active.id);
    expect(campaign?.schedule.runFacts.nextRunAt).toBe(overdue);
    expect(campaign?.schedule.runFacts.lastRunAt).toBeNull();
    expect(countDiscoveryRuns(campaign)).toBe(0);

    // Releasing the manual run commits exactly one terminal run; the
    // restored slot never produced a duplicate scheduled pass.
    discoveryGate.resolve();
    await manual;

    state = await repository.getCampaignState();
    campaign = state?.campaigns.find((c) => c.id === active.id);
    expect(campaign?.schedule.runFacts.lastRunOutcome).toBe("success");
    expect(countDiscoveryRuns(campaign)).toBe(1);
  });
});

describe("workspace snapshot and settings campaign durability", () => {
  test("a snapshot parked inside its progress rewrite preserves a concurrent scheduled commit", async () => {
    const harness = createConcurrencyHarness();
    const { baseRepository, repository, service } = harness;
    const active = await getActiveCampaign(service);

    // Make the projection dirty: an extra saved job is adopted by the
    // reconcile step inside the snapshot, so the rewrite will have something
    // to persist and will reach its locked fresh-state read.
    const savedJobsBeforeProbe = await baseRepository.listSavedJobs();
    const template = savedJobsBeforeProbe[0];
    if (!template) throw new Error("Expected a seeded saved job.");
    await baseRepository.commitSavedJobDelta({
      upserts: [
        createSavedJob({
          ...template,
          id: "job_progress_probe",
          sourceJobId: "progress_probe",
          canonicalUrl: "https://www.linkedin.com/jobs/view/progress_probe",
          applicationUrl:
            "https://www.linkedin.com/jobs/view/progress_probe/apply",
        }),
      ],
    });

    // Park the second campaign read of this snapshot: create/reconcile, then
    // the locked progress-rewrite read. Discovery recovery reads plan state
    // only when a search was running, and none is here.
    const readsBefore = harness.campaignReadsStarted();
    const rewriteReadIndex = readsBefore + 2;
    harness.armBeforeReadGate(rewriteReadIndex);
    const snapshotPromise = service.getWorkspaceSnapshot();
    await vi.waitFor(() =>
      expect(harness.campaignReadsStarted()).toBeGreaterThanOrEqual(
        rewriteReadIndex,
      ),
    );

    // A scheduled terminal commit lands while the stale snapshot sits parked
    // inside its campaign transition.
    const now = new Date().toISOString();
    const committedNextRunAt = await commitScheduledRunFactsWhileParked(
      baseRepository,
      now,
    );
    harness.resolveBeforeReadGate(rewriteReadIndex);
    const snapshot = await snapshotPromise;

    const state = await repository.getCampaignState();
    const campaign = state?.campaigns.find((c) => c.id === active.id);
    if (!campaign) throw new Error("Expected the active campaign.");
    expect(campaign.schedule.runFacts.nextRunAt).toBe(committedNextRunAt);
    expect(campaign.schedule.runFacts.lastRunOutcome).toBe("success");
    expect(
      campaign.history.some(
        (entry) => entry.id === "committed_history_while_parked",
      ),
    ).toBe(true);
    expect(
      state?.notifications.some(
        (notification) =>
          notification.id === "commit_notification_while_parked",
      ),
    ).toBe(true);

    // The projection delta landed on top of the committed collection instead
    // of resurrecting the stale pre-commit snapshot.
    expect(campaign.progress.jobsFound).toBe(savedJobsBeforeProbe.length + 1);
    const snapshotCampaign = snapshot.campaigns.find(
      (candidate) => candidate.id === active.id,
    );
    expect(snapshotCampaign?.schedule.runFacts.nextRunAt).toBe(
      committedNextRunAt,
    );
    expect(snapshotCampaign?.progress.jobsFound).toBe(
      savedJobsBeforeProbe.length + 1,
    );
    expect(
      snapshot.campaignNotifications.some(
        (notification) =>
          notification.id === "commit_notification_while_parked",
      ),
    ).toBe(true);
  });

  test("a snapshot parked before its progress rewrite cannot regress a terminal commit's progress timestamps", async () => {
    const harness = createConcurrencyHarness();
    const { baseRepository, repository, service } = harness;
    const active = await getActiveCampaign(service);

    // Make the projection dirty so the rewrite fires, exactly like the
    // parked-rewrite durability test above.
    const savedJobsBeforeProbe = await baseRepository.listSavedJobs();
    const template = savedJobsBeforeProbe[0];
    if (!template) throw new Error("Expected a seeded saved job.");
    await baseRepository.commitSavedJobDelta({
      upserts: [
        createSavedJob({
          ...template,
          id: "job_terminal_progress_probe",
          sourceJobId: "terminal_progress_probe",
          canonicalUrl:
            "https://www.linkedin.com/jobs/view/terminal_progress_probe",
          applicationUrl:
            "https://www.linkedin.com/jobs/view/terminal_progress_probe/apply",
        }),
      ],
    });

    // As above: create/reconcile, then the locked progress-rewrite read.
    const readsBefore = harness.campaignReadsStarted();
    const rewriteReadIndex = readsBefore + 2;
    harness.armBeforeReadGate(rewriteReadIndex);
    const snapshotPromise = service.getWorkspaceSnapshot();
    await vi.waitFor(() =>
      expect(harness.campaignReadsStarted()).toBeGreaterThanOrEqual(
        rewriteReadIndex,
      ),
    );

    // A terminal commit advances the campaign's progress timestamps while the
    // stale projection sits parked inside its campaign transition.
    const committedAt = new Date().toISOString();
    await commitTerminalProgressWhileParked(baseRepository, committedAt);
    harness.resolveBeforeReadGate(rewriteReadIndex);
    const snapshot = await snapshotPromise;

    const state = await repository.getCampaignState();
    const campaign = state?.campaigns.find((c) => c.id === active.id);
    if (!campaign) throw new Error("Expected the active campaign.");
    expect(campaign.schedule.runFacts.lastRunOutcome).toBe("success");
    expect(
      campaign.history.some(
        (entry) => entry.id === "committed_history_terminal_progress",
      ),
    ).toBe(true);
    expect(
      state?.notifications.some(
        (notification) =>
          notification.id === "commit_notification_terminal_progress",
      ),
    ).toBe(true);

    // The advanced terminal timestamps must win; the stale projection may
    // never regress them even though it truthfully updates job counts.
    expect(campaign.progress.lastRunAt).toBe(committedAt);
    expect(Date.parse(campaign.progress.lastUpdatedAt)).toBeGreaterThanOrEqual(
      Date.parse(committedAt),
    );
    expect(campaign.progress.jobsFound).toBe(savedJobsBeforeProbe.length + 1);

    const snapshotCampaign = snapshot.campaigns.find(
      (candidate) => candidate.id === active.id,
    );
    expect(snapshotCampaign?.progress.lastRunAt).toBe(committedAt);
    expect(snapshotCampaign?.progress.jobsFound).toBe(
      savedJobsBeforeProbe.length + 1,
    );
  });

  test.each([
    { label: "saveSearchPreferences", includeProfile: false },
    { label: "saveProfileAndSearchPreferences", includeProfile: true },
  ])(
    "$label keeps preferences paired with the pointed campaign across a concurrent scheduled commit",
    async ({ includeProfile }) => {
      const harness = createConcurrencyHarness();
      const { baseRepository, repository, service } = harness;
      const active = await getActiveCampaign(service);
      const baseline = await service.getWorkspaceSnapshot();
      const nextSearchPreferences = {
        ...baseline.searchPreferences,
        targetRoles: ["Principal UX Engineer"],
      };

      // The settings-sync path performs exactly one campaign read (the fresh
      // ensure read inside its transition); park it before it fetches.
      const readsBefore = harness.campaignReadsStarted();
      const syncReadIndex = readsBefore + 1;
      harness.armBeforeReadGate(syncReadIndex);
      const savePromise = includeProfile
        ? service.saveProfileAndSearchPreferences(
            baseline.profile,
            nextSearchPreferences,
          )
        : service.saveSearchPreferences(nextSearchPreferences);
      await vi.waitFor(() =>
        expect(harness.campaignReadsStarted()).toBeGreaterThanOrEqual(
          syncReadIndex,
        ),
      );

      const now = new Date().toISOString();
      const committedNextRunAt = await commitScheduledRunFactsWhileParked(
        baseRepository,
        now,
      );
      harness.resolveBeforeReadGate(syncReadIndex);
      await savePromise;

      // Pointer/preferences stay one coherent pair...
      const globalPreferences = await baseRepository.getSearchPreferences();
      expect(globalPreferences.targetRoles).toEqual(["Principal UX Engineer"]);
      const state = await repository.getCampaignState();
      const pointed = state?.campaigns.find(
        (candidate) => candidate.id === state.activeCampaignId,
      );
      if (!pointed) throw new Error("Expected the pointed campaign.");
      expect(state?.activeCampaignId).toBe(active.id);
      expect(pointed.searchPreferences.targetRoles).toEqual(
        globalPreferences.targetRoles,
      );
      expect(pointed.sourceTargetIds).toEqual(
        nextSearchPreferences.discovery.targets
          .filter((target) => target.enabled)
          .map((target) => target.id),
      );
      // ...and the concurrent scheduled commit survives the sync.
      expect(pointed.schedule.runFacts.nextRunAt).toBe(committedNextRunAt);
      expect(
        pointed.history.some(
          (entry) => entry.id === "committed_history_while_parked",
        ),
      ).toBe(true);
      expect(
        state?.notifications.some(
          (notification) =>
            notification.id === "commit_notification_while_parked",
        ),
      ).toBe(true);
    },
  );

  test("bootstrap projections stay read-only for campaign state", async () => {
    const baseRepository = createInMemoryJobFinderRepository(createSeed());
    let campaignStateSaves = 0;
    const repository: JobFinderRepository = {
      ...baseRepository,
      saveCampaignState: async (state) => {
        campaignStateSaves += 1;
        return baseRepository.saveCampaignState(state);
      },
    };
    const service = createJobFinderWorkspaceService({
      repository,
      browserRuntime: createBrowserRuntime(),
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
    });

    const bootstrap = await service.getWorkspaceBootstrap();
    const secondBootstrap = await service.getWorkspaceBootstrap();

    expect(campaignStateSaves).toBe(0);
    expect(await repository.getCampaignState()).toBeNull();
    expect(bootstrap.campaigns.map((campaign) => campaign.id)).toEqual([
      "campaign_default",
    ]);
    expect(secondBootstrap.activeCampaignId).toBe("campaign_default");
  });

  test("snapshot, settings sync, ticker, and notification flips stay live under contention", async () => {
    const harness = createConcurrencyHarness();
    const { baseRepository, repository, service } = harness;
    const active = await getActiveCampaign(service);
    const now = new Date().toISOString();

    const results = await Promise.allSettled([
      service.getWorkspaceSnapshot(),
      service.saveSearchPreferences({
        ...active.searchPreferences,
        targetRoles: ["Principal UX Engineer"],
      }),
      service.runDueScheduledCampaigns(now),
      service.markAllCampaignNotificationsRead({ readAt: now }),
      service.getWorkspaceBootstrap(),
    ]);

    // Every hot path shares the one campaign transition; none may deadlock.
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.reason).toBeUndefined();
    expect(results).toHaveLength(5);
    const state = await repository.getCampaignState();
    const pointed = state?.campaigns.find(
      (candidate) => candidate.id === state.activeCampaignId,
    );
    if (!pointed) throw new Error("Expected the pointed campaign.");
    expect(pointed.searchPreferences.targetRoles).toEqual([
      "Principal UX Engineer",
    ]);
    expect(await baseRepository.getSearchPreferences()).toEqual(
      pointed.searchPreferences,
    );
  });
});

describe("workspace source-target metadata mirror integrity", () => {
  const TARGET_ID = "target_linkedin_default";

  function createSourceDebugJobCatalog() {
    return [
      {
        source: "target_site" as const,
        sourceJobId: "linkedin_mirror_integrity_case",
        discoveryMethod: "catalog_seed" as const,
        canonicalUrl:
          "https://www.linkedin.com/jobs/view/linkedin_mirror_integrity_case",
        title: "Staff Product Designer",
        company: "Signal Systems",
        location: "Remote",
        workMode: ["remote"],
        applyPath: "easy_apply" as const,
        easyApplyEligible: true,
        postedAt: "2026-03-20T09:00:00.000Z",
        discoveredAt: "2026-03-20T10:04:00.000Z",
        salaryText: "$180k - $220k",
        summary: "Mirror integrity case.",
        description: "Mirror integrity case.",
        keySkills: ["Figma"],
      },
    ];
  }

  /** Wraps the agent runtime so every discovery call's inputs are captured in order. */
  function createCapturingAgentRuntime(
    captured: {
      siteLabel: string;
      startingUrls: readonly string[];
      siteInstructions: readonly string[];
    }[],
  ) {
    const agentBase = createAgentBrowserRuntime(createSourceDebugJobCatalog(), {
      debugFindingsByPhase: createStrongSourceDebugFindingsByPhase(),
    });
    const browserRuntime: BrowserSessionRuntime = {
      ...agentBase,
      runAgentDiscovery(source, options) {
        captured.push({
          siteLabel: options.siteLabel,
          startingUrls: options.startingUrls,
          siteInstructions: options.siteInstructions ?? [],
        });
        return agentBase.runAgentDiscovery!(source, options);
      },
    };
    return browserRuntime;
  }

  function targetIn(
    searchPreferences: JobSearchPreferences,
  ): JobDiscoveryTarget {
    const target = searchPreferences.discovery.targets.find(
      (candidate) => candidate.id === TARGET_ID,
    );
    if (!target) throw new Error(`Expected target '${TARGET_ID}'.`);
    return target;
  }

  /** The active pointer and global preferences must always be one stored pair. */
  async function expectActivePairIsStored(
    baseRepository: JobFinderRepository,
  ): Promise<JobSearchCampaign> {
    const [globalPreferences, state] = await Promise.all([
      baseRepository.getSearchPreferences(),
      baseRepository.getCampaignState(),
    ]);
    if (!state) throw new Error("Expected campaign state.");
    const pointed = state.campaigns.find(
      (candidate) => candidate.id === state.activeCampaignId,
    );
    if (!pointed) throw new Error("Expected the pointed campaign.");
    expect(globalPreferences).toEqual(pointed.searchPreferences);
    return pointed;
  }

  test("validated source guidance is mirrored into the active campaign and consumed by its next run", async () => {
    const captured: {
      siteLabel: string;
      startingUrls: readonly string[];
      siteInstructions: readonly string[];
    }[] = [];
    const harness = createConcurrencyHarness({
      browserRuntime: createCapturingAgentRuntime(captured),
      aiClient: createAgentAiClient(),
    });
    const { repository, service } = harness;
    await getActiveCampaign(service);
    // Commit one discovery run first: plans with committed runs are no longer
    // reconciled from the global mirror, so nothing else would carry the
    // validated guidance into this plan's stored preferences.
    await service.runCampaignNow();

    // Debug validation completes while the default plan owns the workspace.
    const validatedSnapshot = await service.runSourceDebug(TARGET_ID);
    const validatedTarget = targetIn(validatedSnapshot.searchPreferences);
    expect(validatedTarget.instructionStatus).toBe("validated");
    expect(validatedTarget.validatedInstructionId).not.toBeNull();

    // The validated guidance landed in the active plan's own snapshot, not
    // just the global preferences mirror of it.
    await expectActivePairIsStored(harness.baseRepository);
    const stateAfterValidation = await repository.getCampaignState();
    const activeAfterValidation = stateAfterValidation?.campaigns.find(
      (candidate) => candidate.id === stateAfterValidation.activeCampaignId,
    );
    expect(
      targetIn(activeAfterValidation!.searchPreferences).validatedInstructionId,
    ).toBe(validatedTarget.validatedInstructionId);

    // The next campaign run executes against the campaign's stored
    // preferences, so it must consume the validated instruction immediately:
    // the run's agent inputs carry guidance lines learned by validation.
    const artifacts = await repository.listSourceInstructionArtifacts();
    const validatedArtifact = artifacts.find(
      (candidate) =>
        candidate.id === validatedTarget.validatedInstructionId &&
        candidate.status === "validated",
    );
    if (!validatedArtifact) throw new Error("Expected a validated artifact.");
    // Discovery projects the bound instruction into prefixed agent guidance
    // lines; the campaign run must carry them.
    const expectedGuidanceLines = buildInstructionGuidance(validatedArtifact);
    expect(expectedGuidanceLines.length).toBeGreaterThan(0);
    const callsBeforeRun = captured.length;
    await service.runCampaignNow();
    const campaignRunCalls = captured.slice(callsBeforeRun);
    expect(campaignRunCalls.length).toBeGreaterThan(0);
    expect(
      campaignRunCalls.some((call) =>
        expectedGuidanceLines.every((line) =>
          call.siteInstructions.includes(line),
        ),
      ),
    ).toBe(true);
  });

  test("a plan switch away and back preserves the six validated-guidance fields (A→B→A)", async () => {
    const captured: {
      siteLabel: string;
      startingUrls: readonly string[];
      siteInstructions: readonly string[];
    }[] = [];
    const harness = createConcurrencyHarness({
      browserRuntime: createCapturingAgentRuntime(captured),
      aiClient: createAgentAiClient(),
    });
    const { repository, service } = harness;
    const active = await getActiveCampaign(service);
    // Commit one discovery run so plan A's stored preferences stop being
    // re-synced from the global mirror by snapshot reconciliation; only the
    // explicit mirror commit may keep them aligned from here on.
    await service.runCampaignNow();
    const created = await service.saveCampaign(
      toCampaignInput(active, { id: null, name: "Plan B" }),
    );
    const planB = created.campaigns.find(
      (campaign) => campaign.name === "Plan B",
    );
    if (!planB) throw new Error("Expected plan B.");

    const validatedSnapshot = await service.runSourceDebug(TARGET_ID);
    const validated = targetIn(validatedSnapshot.searchPreferences);
    expect(validated.instructionStatus).toBe("validated");

    // Switch away: the global mirror adopts plan B's own untouched snapshot...
    await service.selectCampaign(planB.id);
    let pointed = await expectActivePairIsStored(harness.baseRepository);
    expect(pointed.id).toBe(planB.id);
    expect(
      targetIn(pointed.searchPreferences).validatedInstructionId,
    ).not.toBeNull();

    // ...but plan A's stored snapshot kept the validation, so switching back
    // restores all six fields instead of reverting them.
    await service.selectCampaign(active.id);
    pointed = await expectActivePairIsStored(harness.baseRepository);
    expect(pointed.id).toBe(active.id);
    const restored = targetIn(pointed.searchPreferences);
    expect(restored.instructionStatus).toBe("validated");
    expect(restored.validatedInstructionId).toBe(
      validated.validatedInstructionId,
    );
    expect(restored.draftInstructionId).toBeNull();
    expect(restored.lastDebugRunId).toBe(validated.lastDebugRunId);
    expect(restored.lastVerifiedAt).toBe(validated.lastVerifiedAt);
    expect(restored.staleReason).toBeNull();

    const state = await repository.getCampaignState();
    const storedA = state?.campaigns.find(
      (candidate) => candidate.id === active.id,
    );
    expect(targetIn(storedA!.searchPreferences)).toEqual(restored);
  });

  test("a source-guidance update racing a plan switch stays serialized and keeps the pair coherent", async () => {
    const seed = createSeed();
    seed.searchPreferences.discovery.targets[0] = {
      ...seed.searchPreferences.discovery.targets[0]!,
      instructionStatus: "missing",
      draftInstructionId: "instruction_race_bound",
    };
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_race_bound",
        targetId: TARGET_ID,
        status: "draft",
        createdAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        acceptedAt: null,
        basedOnRunId: "race_run",
        basedOnAttemptIds: ["race_attempt"],
        notes: null,
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
        verification: null,
      }),
    ];
    const harness = createConcurrencyHarness({ seed });
    const { service } = harness;

    const active = await getActiveCampaign(service);
    const created = await service.saveCampaign(
      toCampaignInput(active, { id: null, name: "Plan B" }),
    );
    const planB = created.campaigns.find(
      (campaign) => campaign.name === "Plan B",
    );
    if (!planB) throw new Error("Expected plan B.");

    // Hold the guidance update inside its atomic commit, then start a plan
    // select. A serialized writer cannot even reach its commit while the
    // update holds the transition.
    harness.holdSaves();
    const update = service.acceptSourceInstructionDraft(
      TARGET_ID,
      "instruction_race_bound",
    );
    await vi.waitFor(() => expect(harness.heldSaveCount()).toBe(1));
    // The guidance update must reach the store through the atomic
    // campaign-preferences commit, not an unlocked global-preferences write.
    expect(harness.heldSaveKinds()).toEqual(["preferences"]);
    const select = service.selectCampaign(planB.id);
    await drainMacrotasks(5);
    expect(harness.heldSaveCount()).toBe(1);

    // Committing the update first must leave the update mirrored into the
    // still-active plan A; only then may the select land on top.
    expect(await harness.flushHeldSave()).toBe(true);
    await harness.waitForHeldSaves(1, 400);
    await harness.releaseHeldSaves();
    await update;
    await select;

    const pointed = await expectActivePairIsStored(harness.baseRepository);
    expect(pointed.id).toBe(planB.id);

    const state = await harness.baseRepository.getCampaignState();
    const storedA = state?.campaigns.find(
      (candidate) => candidate.id === active.id,
    );
    if (!storedA) throw new Error("Expected plan A.");
    // The update survived inside plan A's own snapshot even though the later
    // select replaced the global mirror with plan B's preferences.
    expect(targetIn(storedA.searchPreferences).instructionStatus).toBe("draft");
    expect(targetIn(storedA.searchPreferences).draftInstructionId).toBe(
      "instruction_race_bound",
    );
  });

  test("concurrent source-guidance update and plan select keep the pointer paired with mirrored preferences", async () => {
    const seed = createSeed();
    seed.searchPreferences.discovery.targets[0] = {
      ...seed.searchPreferences.discovery.targets[0]!,
      instructionStatus: "missing",
      draftInstructionId: "instruction_race_unordered",
    };
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_race_unordered",
        targetId: TARGET_ID,
        status: "draft",
        createdAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        acceptedAt: null,
        basedOnRunId: "race_run_unordered",
        basedOnAttemptIds: ["race_attempt_unordered"],
        notes: null,
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
        verification: null,
      }),
    ];
    const harness = createConcurrencyHarness({ seed });
    const { baseRepository, repository, service } = harness;

    const active = await getActiveCampaign(service);
    const created = await service.saveCampaign(
      toCampaignInput(active, { id: null, name: "Plan B" }),
    );
    const planB = created.campaigns.find(
      (campaign) => campaign.name === "Plan B",
    );
    if (!planB) throw new Error("Expected plan B.");

    await Promise.all([
      service.acceptSourceInstructionDraft(
        TARGET_ID,
        "instruction_race_unordered",
      ),
      service.selectCampaign(planB.id),
    ]);

    // Whichever operation commits last, the pointer and the global mirror
    // must stay one coherent stored pair.
    const pointed = await expectActivePairIsStored(baseRepository);
    expect(pointed.id).toBe(planB.id);
    const state = await repository.getCampaignState();
    const storedA = state?.campaigns.find(
      (candidate) => candidate.id === active.id,
    );
    if (!storedA) throw new Error("Expected plan A.");
    // The guidance update survives in at least the plan that owned the target
    // when it committed; it may never vanish from both snapshots.
    const updatedSnapshots = [storedA, pointed].filter(
      (campaign) =>
        targetIn(campaign.searchPreferences).instructionStatus === "draft",
    );
    expect(updatedSnapshots.length).toBeGreaterThanOrEqual(1);
  });

  test("Find jobs searches exactly the current plan's explicit two-of-five sources", async () => {
    const captured: {
      siteLabel: string;
      startingUrls: readonly string[];
      siteInstructions: readonly string[];
    }[] = [];
    const harness = createConcurrencyHarness({
      browserRuntime: createCapturingAgentRuntime(captured),
      aiClient: createAgentAiClient(),
    });
    const active = await getActiveCampaign(harness.service);
    const target = active.searchPreferences.discovery.targets[0]!;
    const targets = Array.from({ length: 5 }, (_, index) => ({
      ...target,
      id: index === 0 ? target.id : `subset_${index}`,
      label: `Source ${index}`,
      startingUrl: `https://sources.example.test/${index}`,
      enabled: true,
    }));
    await harness.service.saveSearchPreferences({
      ...active.searchPreferences,
      discovery: { ...active.searchPreferences.discovery, targets },
    });
    const updated = await getActiveCampaign(harness.service);
    await harness.service.saveCampaign({
      ...toCampaignInput(updated),
      sourceSelectionMode: "selected",
      sourceTargetIds: targets.slice(0, 2).map((source) => source.id),
      searchPreferences: {
        ...active.searchPreferences,
        discovery: { ...active.searchPreferences.discovery, targets },
      },
    });
    // Profile keeps all five enabled; it must not determine this plan's run.
    expect(
      (
        await harness.repository.getSearchPreferences()
      ).discovery.targets.filter((source) => source.enabled),
    ).toHaveLength(5);
    captured.length = 0;
    await harness.service.runAgentDiscovery();
    expect(captured.map((call) => call.siteLabel)).toEqual([
      "Source 0",
      "Source 1",
    ]);
    const run = (await harness.repository.getDiscoveryState()).recentRuns[0]!;
    expect(run.summary.targetsPlanned).toBe(2);
    expect(run.targetExecutions.map((execution) => execution.targetId)).toEqual(
      targets.slice(0, 2).map((source) => source.id),
    );
  });

  test("an excluded source is not discovered by the run owned by its plan", async () => {
    const captured: {
      siteLabel: string;
      startingUrls: readonly string[];
      siteInstructions: readonly string[];
    }[] = [];
    const harness = createConcurrencyHarness({
      browserRuntime: createCapturingAgentRuntime(captured),
      aiClient: createAgentAiClient(),
    });
    const { repository, service } = harness;
    const active = await getActiveCampaign(service);
    const disabledTarget: JobDiscoveryTarget = {
      id: "target_excluded_second",
      label: "Excluded careers page",
      startingUrl: "https://excluded.example.com/jobs",
      enabled: false,
      adapterKind: "auto",
      customInstructions: null,
      instructionStatus: "missing",
      validatedInstructionId: null,
      draftInstructionId: null,
      lastDebugRunId: null,
      lastVerifiedAt: null,
      staleReason: null,
    };

    // The plan's explicit sourceTargetIds own inclusion. The embedded target
    // metadata may carry an older enabled flag without changing that scope.
    const saved = await service.saveCampaign(
      toCampaignInput(active, {
        searchPreferences: {
          ...active.searchPreferences,
          discovery: {
            ...active.searchPreferences.discovery,
            targets: [
              ...active.searchPreferences.discovery.targets,
              disabledTarget,
            ],
          },
        },
      }),
    );
    const savedPlan = saved.campaigns.find(
      (campaign) => campaign.id === active.id,
    );
    if (!savedPlan) throw new Error("Expected the saved plan.");
    expect(savedPlan.sourceTargetIds).toEqual([TARGET_ID]);

    const callsBeforeRun = captured.length;
    await service.runCampaignNow();
    const runCalls = captured.slice(callsBeforeRun);
    // Only the included (enabled) source is discovered; the excluded one
    // never reaches the runtime.
    expect(runCalls.map((call) => call.siteLabel)).toEqual(["Primary target"]);
    expect(
      runCalls.some((call) =>
        call.startingUrls.some((url) => url.startsWith("https://excluded.")),
      ),
    ).toBe(false);

    const discoveryState = await repository.getDiscoveryState();
    const campaignRun = discoveryState.recentRuns.find(
      (candidate) => candidate.campaignId === active.id,
    );
    if (!campaignRun) throw new Error("Expected a campaign discovery run.");
    expect(
      campaignRun.targetExecutions.map((execution) => execution.targetId),
    ).toEqual([TARGET_ID]);
  });

  test("a source added in Profile appears in every plan without replacing each plan's existing on/off choices", async () => {
    const { repository, service } = createConcurrencyHarness();
    const planA = await getActiveCampaign(service);
    const existingTarget = planA.searchPreferences.discovery.targets[0];
    if (!existingTarget) throw new Error("Expected the initial source.");

    const created = await service.saveCampaign(
      toCampaignInput(planA, {
        id: null,
        name: "Plan B",
        sourceSelectionMode: "selected",
        sourceTargetIds: [],
        searchPreferences: {
          ...planA.searchPreferences,
          discovery: {
            ...planA.searchPreferences.discovery,
            targets: [{ ...existingTarget, enabled: false }],
          },
        },
      }),
    );
    expect(created.campaigns).toHaveLength(2);

    const addedTarget: JobDiscoveryTarget = {
      id: "target_new_profile_source",
      label: "New public careers page",
      startingUrl: "https://new-source.example.test/careers",
      enabled: true,
      adapterKind: "auto",
      customInstructions: null,
      instructionStatus: "missing",
      validatedInstructionId: null,
      draftInstructionId: null,
      lastDebugRunId: null,
      lastVerifiedAt: null,
      staleReason: null,
    };
    await service.saveSearchPreferences({
      ...planA.searchPreferences,
      discovery: {
        ...planA.searchPreferences.discovery,
        targets: [existingTarget, addedTarget],
      },
    });

    const state = await repository.getCampaignState();
    expect(state?.campaigns).toHaveLength(2);
    for (const campaign of state?.campaigns ?? []) {
      expect(
        campaign.searchPreferences.discovery.targets.map((target) => target.id),
      ).toEqual([existingTarget.id, addedTarget.id]);
      expect(
        campaign.searchPreferences.discovery.targets.find(
          (target) => target.id === addedTarget.id,
        )?.enabled,
      ).toBe(true);
    }
    expect(
      state?.campaigns.find((campaign) => campaign.name === "Plan B")
        ?.sourceTargetIds,
    ).toEqual([]);
  });

  test("profile edits keep both plans' explicit source scopes and their next runs", async () => {
    const captured: {
      siteLabel: string;
      startingUrls: readonly string[];
      siteInstructions: readonly string[];
    }[] = [];
    const seed = createSeed();
    const initial = seed.searchPreferences.discovery.targets[0];
    if (!initial) throw new Error("Expected a source.");
    seed.searchPreferences.discovery.targets = Array.from(
      { length: 31 },
      (_, index) => ({
        ...initial,
        id: `source_${index}`,
        label: `Source ${index}`,
        startingUrl: `https://source-${index}.example.test/jobs`,
        enabled: true,
      }),
    );
    const { repository, service } = createConcurrencyHarness({
      seed,
      browserRuntime: createCapturingAgentRuntime(captured),
      aiClient: createAgentAiClient(),
    });
    const planA = await getActiveCampaign(service);
    const selectedIds = planA.searchPreferences.discovery.targets
      .slice(0, 8)
      .map((target) => target.id);
    await service.saveCampaign(
      toCampaignInput(planA, { sourceTargetIds: selectedIds }),
    );
    const focusedIds = planA.searchPreferences.discovery.targets
      .slice(0, 28)
      .map((target) => target.id);
    await service.saveCampaign(
      toCampaignInput(planA, {
        id: null,
        name: "Focused plan",
        sourceTargetIds: focusedIds,
      }),
    );
    for (const patch of [
      { headline: "Synthetic backend engineer" },
      { skills: ["TypeScript", "Go"] },
      { experiences: [] },
    ]) {
      const current = await service.getWorkspaceSnapshot();
      await service.saveProfileAndSearchPreferences(
        { ...current.profile, ...patch },
        current.searchPreferences,
      );
      const state = await repository.getCampaignState();
      expect(
        state?.campaigns.find((campaign) => campaign.id === planA.id)
          ?.sourceTargetIds,
      ).toEqual(selectedIds);
      expect(
        state?.campaigns.find((campaign) => campaign.name === "Focused plan")
          ?.sourceTargetIds,
      ).toEqual(focusedIds);
    }
    const restarted = createJobFinderWorkspaceService({
      repository,
      browserRuntime: createCapturingAgentRuntime(captured),
      aiClient: createAgentAiClient(),
      documentManager: createDocumentManager(),
    });
    const callsBefore = captured.length;
    await restarted.runCampaignNow();
    const run = (await repository.getDiscoveryState()).recentRuns.find(
      (candidate) => candidate.campaignId === planA.id,
    );
    expect(
      run?.targetExecutions.map((execution) => execution.targetId).sort(),
    ).toEqual([...selectedIds].sort());
    expect(
      captured
        .slice(callsBefore)
        .map((call) => call.siteLabel)
        .sort(),
    ).toEqual(selectedIds.map((id) => `Source ${id.slice(7)}`).sort());
  });

  test("changing one plan's source selection leaves Profile and sibling plans unchanged", async () => {
    const { repository, service } = createConcurrencyHarness();
    const planA = await getActiveCampaign(service);
    const created = await service.saveCampaign(
      toCampaignInput(planA, { id: null, name: "Plan B" }),
    );
    const planB = created.campaigns.find(
      (campaign) => campaign.name === "Plan B",
    );
    if (!planB) throw new Error("Expected Plan B.");
    await service.selectCampaign(planA.id);

    const profileSourceBefore = (await repository.getSearchPreferences())
      .discovery.targets[0];
    await service.saveCampaign(
      toCampaignInput(planA, {
        sourceTargetIds: [],
        sourceSelectionMode: "selected",
      }),
    );

    const profileSourceAfter = (await repository.getSearchPreferences())
      .discovery.targets[0];
    const state = await repository.getCampaignState();
    expect(profileSourceAfter?.enabled).toBe(profileSourceBefore?.enabled);
    expect(
      state?.campaigns.find((campaign) => campaign.id === planA.id)
        ?.sourceTargetIds,
    ).toEqual([]);
    expect(
      state?.campaigns.find((campaign) => campaign.id === planB.id)
        ?.sourceTargetIds,
    ).toEqual(planB.sourceTargetIds);
  });
});

test("adding sources to a default plan preserves all Profile switches across plan changes", async () => {
  const { repository, service } = createConcurrencyHarness();
  const defaultPlan = await getActiveCampaign(service);
  const oldSource = defaultPlan.searchPreferences.discovery.targets[0]!;
  // Older callers omit sourceSelectionMode when changing only a plan name.
  const renamed = await service.saveCampaign(
    toCampaignInput(defaultPlan, { name: "Renamed default" }),
  );
  expect(
    renamed.campaigns.find((plan) => plan.id === defaultPlan.id)
      ?.sourceSelectionMode,
  ).toBe("profile");
  const added = Array.from({ length: 5 }, (_, index) => ({
    ...oldSource,
    id: `new_${index}`,
    startingUrl: `https://new-${index}.example.test/jobs`,
    enabled: true,
  }));
  await service.saveSearchPreferences({
    ...defaultPlan.searchPreferences,
    discovery: {
      ...defaultPlan.searchPreferences.discovery,
      targets: [oldSource, ...added],
    },
  });
  const snapshot = await service.getWorkspaceSnapshot();
  expect(
    snapshot.campaigns.find((plan) => plan.id === defaultPlan.id)
      ?.sourceTargetIds,
  ).toEqual([oldSource.id, ...added.map((source) => source.id)]);
  const second = await service.saveCampaign(
    toCampaignInput(
      snapshot.campaigns.find((plan) => plan.id === defaultPlan.id)!,
      {
        id: null,
        name: "Local only",
        sourceTargetIds: [added[0]!.id],
        sourceSelectionMode: "selected",
      },
    ),
  );
  const local = second.campaigns.find((plan) => plan.name === "Local only")!;
  await service.selectCampaign(local.id);
  await service.selectCampaign(defaultPlan.id);
  expect(
    (await repository.getSearchPreferences()).discovery.targets.map(
      (source) => source.enabled,
    ),
  ).toEqual(Array(6).fill(true));
  expect(
    (await repository.getCampaignState())?.campaigns.find(
      (plan) => plan.id === defaultPlan.id,
    )?.sourceTargetIds,
  ).toHaveLength(6);
});

test("removing a source retains its saved label and URL on existing jobs", async () => {
  const seed = createSeed();
  const source = seed.searchPreferences.discovery.targets[0]!;
  const original = seed.savedJobs[0]!;
  seed.savedJobs = [
    {
      ...original,
      provenance: [
        createSavedJobDiscoveryProvenance({
          targetId: source.id,
          startingUrl: source.startingUrl,
          adapterKind: "auto",
          discoveredAt: "2026-10-04T12:00:00.000Z",
        }),
      ],
    },
  ];
  const { repository, service } = createConcurrencyHarness({ seed });
  await service.saveProfileAndSearchPreferences(seed.profile, {
    ...seed.searchPreferences,
    discovery: { ...seed.searchPreferences.discovery, targets: [] },
  });
  expect(
    (await repository.listSavedJobs()).find((job) => job.id === original.id)
      ?.provenance[0],
  ).toMatchObject({
    sourceLabel: source.label,
    startingUrl: source.startingUrl,
  });
});
