import { afterEach, describe, expect, test, vi } from "vitest";

import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  DEFAULT_SCALE_CAMPAIGN_DISCOVERY_RUN_JOB_BUDGET,
  DISCOVERY_RUN_JOB_BUDGET_MAX,
  type DiscoveryActivityEvent,
  type JobSearchPreferences,
} from "@nestor/contracts";
import type { JobFinderRepositorySeed } from "@nestor/db";

import {
  resolveDiscoveryBudgetPlan,
  resolveDiscoveryTargetBudget,
} from "./internal/workspace-discovery-run-helpers";
import { createBrowserRuntime } from "./workspace-service.test-runtimes";
import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

afterEach(() => {
  vi.restoreAllMocks();
});

const fullYieldShares = (
  targetCount: number,
  runJobBudget?: number | null,
): number[] => {
  const shares: number[] = [];
  let foundSoFar = 0;
  for (let remaining = targetCount; remaining > 0; remaining -= 1) {
    const budget = resolveDiscoveryTargetBudget({
      targetsRemaining: remaining,
      validJobsFoundSoFar: foundSoFar,
      ...(runJobBudget !== undefined ? { runJobBudget } : {}),
    });
    shares.push(budget.targetJobCount);
    foundSoFar += budget.targetJobCount;
  }
  return shares;
};

describe("resolveDiscoveryTargetBudget", () => {
  test("keeps default browser planning hints and safety ceilings unchanged", () => {
    // Single-target runs use a 50-job planning hint, not a retention cap.
    expect(
      resolveDiscoveryTargetBudget({
        targetsRemaining: 1,
        validJobsFoundSoFar: 0,
      }),
    ).toEqual({ targetJobCount: 50, maxSteps: 120 });

    // Multi-target runs keep the legacy 100-job planning split and safety
    // ceiling; default retained counts are tested separately.
    const shares = fullYieldShares(3);
    expect(shares).toEqual([34, 33, 33]);
    expect(shares.reduce((total, share) => total + share, 0)).toBe(100);

    expect(
      resolveDiscoveryTargetBudget({
        targetsRemaining: 2,
        validJobsFoundSoFar: 0,
      }).maxSteps,
    ).toBe(120);
  });

  test("splits a configured budget exactly across targets with proportional step ceilings", () => {
    const single = resolveDiscoveryTargetBudget({
      targetsRemaining: 1,
      validJobsFoundSoFar: 0,
      runJobBudget: DEFAULT_SCALE_CAMPAIGN_DISCOVERY_RUN_JOB_BUDGET,
    });
    // A configured single-target run may use the whole explicit budget and
    // raises its crawl ceiling proportionally (hard-capped).
    expect(single.targetJobCount).toBe(1_000);
    expect(single.maxSteps).toBe(240);

    const shares = fullYieldShares(
      3,
      DEFAULT_SCALE_CAMPAIGN_DISCOVERY_RUN_JOB_BUDGET,
    );
    expect(shares.reduce((total, share) => total + share, 0)).toBe(1_000);
    expect(
      resolveDiscoveryTargetBudget({
        targetsRemaining: 2,
        validJobsFoundSoFar: 0,
        runJobBudget: DEFAULT_SCALE_CAMPAIGN_DISCOVERY_RUN_JOB_BUDGET,
      }).maxSteps,
    ).toBeLessThanOrEqual(240);

    const manyShares = fullYieldShares(7, DISCOVERY_RUN_JOB_BUDGET_MAX);
    expect(manyShares.reduce((total, share) => total + share, 0)).toBe(
      DISCOVERY_RUN_JOB_BUDGET_MAX,
    );
  });

  test("clamps out-of-range budgets defensively and rejects empty target lists", () => {
    expect(
      resolveDiscoveryTargetBudget({
        targetsRemaining: 1,
        validJobsFoundSoFar: 0,
        runJobBudget: DISCOVERY_RUN_JOB_BUDGET_MAX + 500,
      }).targetJobCount,
    ).toBe(DISCOVERY_RUN_JOB_BUDGET_MAX);

    expect(() =>
      resolveDiscoveryTargetBudget({
        targetsRemaining: 0,
        validJobsFoundSoFar: 0,
        runJobBudget: 1_000,
      }),
    ).toThrow(/at least one remaining target/);
  });

  test("grants scarce one-job units to the highest-priority position when the budget trails the target count", () => {
    // A one-job budget with several remaining targets funds this (leading)
    // position first.
    expect(
      resolveDiscoveryTargetBudget({
        targetsRemaining: 3,
        validJobsFoundSoFar: 0,
        runJobBudget: 1,
      }),
    ).toEqual({ targetJobCount: 1, maxSteps: 240 });

    // Once the scarce units are consumed, later positions receive zero
    // instead of stealing the remainder from earlier sources.
    expect(
      resolveDiscoveryTargetBudget({
        targetsRemaining: 2,
        validJobsFoundSoFar: 1,
        runJobBudget: 1,
      }),
    ).toEqual({ targetJobCount: 0, maxSteps: 240 });

    // A fully exhausted budget yields zero without going negative.
    expect(
      resolveDiscoveryTargetBudget({
        targetsRemaining: 4,
        validJobsFoundSoFar: 4,
        runJobBudget: 4,
      }),
    ).toEqual({ targetJobCount: 0, maxSteps: 240 });
  });
});

describe("resolveDiscoveryBudgetPlan", () => {
  test("allocates the positional full-yield shares with exact totals", () => {
    const shares = fullYieldShares(3, 1_000);
    const plan = resolveDiscoveryBudgetPlan({
      targetIds: ["board_a", "board_b", "board_c"],
      runJobBudget: 1_000,
    });

    expect(plan.get("board_a")?.targetJobCount).toBe(shares[0]);
    expect(plan.get("board_b")?.targetJobCount).toBe(shares[1]);
    expect(plan.get("board_c")?.targetJobCount).toBe(shares[2]);
    expect(
      [...plan.values()].reduce(
        (total, budget) => total + budget.targetJobCount,
        0,
      ),
    ).toBe(1_000);

    const defaultPlan = resolveDiscoveryBudgetPlan({
      targetIds: ["board_a", "board_b"],
    });
    expect(defaultPlan.get("board_a")?.targetJobCount).toBe(50);
    expect(defaultPlan.get("board_b")?.targetJobCount).toBe(50);
  });
});

function planShares(
  targetIds: readonly string[],
  runJobBudget?: number,
): number[] {
  const plan = resolveDiscoveryBudgetPlan({
    targetIds,
    ...(runJobBudget !== undefined ? { runJobBudget } : {}),
  });
  return targetIds.map((targetId) => {
    const entry = plan.get(targetId);
    if (!entry) {
      throw new Error(`Missing budget plan entry for ${targetId}.`);
    }
    return entry.targetJobCount;
  });
}

function planRetentionShares(
  targetIds: readonly string[],
  runJobBudget?: number,
): number[] {
  const plan = resolveDiscoveryBudgetPlan({
    targetIds,
    ...(runJobBudget !== undefined ? { runJobBudget } : {}),
  });
  return targetIds.map((targetId) => {
    const entry = plan.get(targetId);
    if (!entry) {
      throw new Error(`Missing budget plan entry for ${targetId}.`);
    }
    return entry.retentionJobCount;
  });
}

describe("resolveDiscoveryBudgetPlan exact-total semantics", () => {
  test("samples every source while retaining only the requested scarce total", () => {
    // A result request smaller than the selected source count still gives
    // every source an honest sample. The separate retention shares preserve
    // the exact run-wide result cap.
    expect(planShares(["board_a", "board_b", "board_c"], 1)).toEqual([1, 1, 1]);
    expect(planRetentionShares(["board_a", "board_b", "board_c"], 1)).toEqual([
      1, 0, 0,
    ]);
    expect(planShares(["board_a", "board_b", "board_c"], 2)).toEqual([1, 1, 1]);
    expect(planRetentionShares(["board_a", "board_b", "board_c"], 2)).toEqual([
      1, 1, 0,
    ]);
    expect(planShares(["board_a", "board_b", "board_c"], 3)).toEqual([1, 1, 1]);
    // At or above the target count the floor fair-share split with the
    // trailing remainder is unchanged.
    expect(planShares(["board_a", "board_b", "board_c"], 4)).toEqual([1, 1, 2]);
    expect(planShares(["solo_board"], 1)).toEqual([1]);
  });

  test("retains the existing interactive and scaled allocation contracts", () => {
    // The default collection planning hints remain [34,33,33].
    expect(fullYieldShares(3)).toEqual([34, 33, 33]);
    expect(planShares(["board_a", "board_b", "board_c"])).toEqual([34, 33, 33]);
    // Scaled budgets keep the floor-of-remaining positional split whenever
    // the budget can fund every target.
    expect(planShares(["board_a", "board_b", "board_c"], 100)).toEqual([
      33, 33, 34,
    ]);
    expect(planShares(["board_a", "board_b", "board_c"], 1_000)).toEqual([
      333, 333, 334,
    ]);
  });

  test("sums exactly to the configured budget across seeded ranges", () => {
    const budgets = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 50, 99, 333, 1_000];
    for (let targetCount = 1; targetCount <= 7; targetCount += 1) {
      const targetIds = Array.from(
        { length: targetCount },
        (_, index) => `board_${index}`,
      );
      for (const runJobBudget of budgets) {
        const shares = planShares(targetIds, runJobBudget);
        expect(
          shares.every((share) => Number.isInteger(share) && share >= 0),
        ).toBe(true);
        expect(
          planRetentionShares(targetIds, runJobBudget).reduce(
            (total, share) => total + share,
            0,
          ),
        ).toBe(runJobBudget);
        expect(planShares(targetIds, runJobBudget)).toEqual(shares);
      }
    }
  });

  test("allocates deterministically from the given target order", () => {
    const forward = resolveDiscoveryBudgetPlan({
      targetIds: ["board_a", "board_b", "board_c"],
      runJobBudget: 4,
    });
    const reversed = resolveDiscoveryBudgetPlan({
      targetIds: ["board_c", "board_b", "board_a"],
      runJobBudget: 4,
    });

    expect(planShares(["board_a", "board_b", "board_c"], 4)).toEqual([1, 1, 2]);
    expect(forward.get("board_a")?.targetJobCount).toBe(1);
    expect(forward.get("board_b")?.targetJobCount).toBe(1);
    expect(forward.get("board_c")?.targetJobCount).toBe(2);
    expect(reversed.get("board_a")?.targetJobCount).toBe(2);
    expect(reversed.get("board_b")?.targetJobCount).toBe(1);
    expect(reversed.get("board_c")?.targetJobCount).toBe(1);
  });

  test("fails fast on duplicate or empty target ids", () => {
    expect(() =>
      resolveDiscoveryBudgetPlan({
        targetIds: ["board_a", "board_b", "board_a"],
        runJobBudget: 10,
      }),
    ).toThrow(/Duplicate discovery target id "board_a"/);

    expect(() =>
      resolveDiscoveryBudgetPlan({
        targetIds: ["board_a", ""],
        runJobBudget: 10,
      }),
    ).toThrow(/non-empty target id at position 1/);
  });

  test("returns an explicit empty plan for an empty target list", () => {
    expect(
      resolveDiscoveryBudgetPlan({ targetIds: [], runJobBudget: 100 }).size,
    ).toBe(0);
    expect(resolveDiscoveryBudgetPlan({ targetIds: [] }).size).toBe(0);
  });
});

const BUDGET_TEST_TARGET_ROLES = ["Senior Product Designer"];

function createEmptyDiscoverySeed(): JobFinderRepositorySeed {
  const seed = createSeed();
  seed.savedJobs = [];
  seed.discovery.pendingDiscoveryJobs = [];
  seed.discovery.discoveryLedger = [];
  seed.settings.discoveryOnly = false;
  seed.searchPreferences.companyWhitelist = [];
  seed.searchPreferences.targetRoles = [...BUDGET_TEST_TARGET_ROLES];
  seed.searchPreferences.discovery.targets = [];
  return seed;
}

function createBrowserTarget(id: string, label: string) {
  return {
    id,
    label,
    startingUrl: "https://jobs.example.com/opportunities",
    enabled: true,
    adapterKind: "auto" as const,
    customInstructions: null,
    instructionStatus: "missing" as const,
    validatedInstructionId: null,
    draftInstructionId: null,
    lastDebugRunId: null,
    lastVerifiedAt: null,
    staleReason: null,
  };
}

function createScaleCampaignInput(input: {
  name: string;
  searchPreferences: JobSearchPreferences;
  discoveryRunJobBudget?: number | null;
}) {
  return {
    id: null,
    name: input.name,
    description: "",
    mode: "scale" as const,
    status: "active" as const,
    searchPreferences: input.searchPreferences,
    sourceTargetIds: input.searchPreferences.discovery.targets
      .filter((target) => target.enabled)
      .map((target) => target.id),
    minimumFitScore: null,
    limits: {
      retainedJobTarget: 1_000,
      analysisConcurrency: 6,
      preparationBatchSize: 25,
      dailyPreparationLimit: 100,
      discoveryRunJobBudget:
        input.discoveryRunJobBudget !== undefined
          ? input.discoveryRunJobBudget
          : DEFAULT_SCALE_CAMPAIGN_DISCOVERY_RUN_JOB_BUDGET,
    },
    stopRules: {
      pauseOnLoginRequired: false,
      pauseOnChangedForm: true,
      pauseOnUncertainEligibility: true,
      pauseOnFailureRatePercent: 20,
      failureRateMinimumSample: 10,
    },
    applicationPolicy: {
      resumeStrategy: "job_family_variants" as const,
      requireReviewBeforePreparation: false,
      requireReviewBeforeExternalWrite: true as const,
      finalSubmitAuthorized: false as const,
      qualityReviewSampleRatio: 0.2,
      simultaneousApplicationWindowDays: 1,
    },
    rules: [],
    schedule: {
      mode: "manual" as const,
      enabled: false,
      daysOfWeek: [],
      localStartTime: null,
      timeZone: null,
      pauseWindows: [],
      runFacts: {
        nextRunAt: null,
        lastRunAt: null,
        lastRunOutcome: null,
        lastRunSummary: null,
        consecutiveFailures: 0,
      },
    },
    latestDigest: null,
  };
}

async function saveScaleCampaign(
  harness: ReturnType<typeof createWorkspaceServiceHarness>,
  searchPreferences: JobSearchPreferences,
  discoveryRunJobBudget?: number | null,
): Promise<string> {
  const snapshot = await harness.workspaceService.saveCampaign(
    createScaleCampaignInput({
      name: "Budget Campaign",
      searchPreferences,
      ...(discoveryRunJobBudget !== undefined ? { discoveryRunJobBudget } : {}),
    }),
  );
  const created = snapshot.campaigns.find(
    (candidate) => candidate.name === "Budget Campaign",
  );
  if (!created) throw new Error("Expected the created campaign.");
  return created.id;
}

describe("campaign discovery run budgets", () => {
  test("routes campaign browser-only targets through the bounded agent runtime with scaled ceilings", async () => {
    const base = createBrowserRuntime();
    const agentCalls: Array<
      Parameters<NonNullable<BrowserSessionRuntime["runAgentDiscovery"]>>[1]
    > = [];
    const directCalls: unknown[] = [];
    const browserRuntime: BrowserSessionRuntime = {
      ...base,
      runAgentDiscovery: (source, options) => {
        agentCalls.push(options);
        return base.runAgentDiscovery!(source, options);
      },
      runDiscovery: (source, searchPreferences) => {
        directCalls.push({ source, searchPreferences });
        return base.runDiscovery(source, searchPreferences);
      },
    };

    const seed = createEmptyDiscoverySeed();
    seed.searchPreferences.discovery.targets = [
      createBrowserTarget("target_browser_only", "Browser Only Board"),
    ];
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
    });
    const { repository, workspaceService } = harness;

    const globalPreferences = await repository.getSearchPreferences();
    const campaignId = await saveScaleCampaign(harness, globalPreferences);
    await workspaceService.runCampaignNow({ campaignId });

    expect(agentCalls).toHaveLength(1);
    expect(directCalls).toHaveLength(0);

    // The scaled budget raises the bounded crawl ceilings proportionally while
    // keeping them hard-capped.
    const agentOptions = agentCalls[0];
    expect(agentOptions?.targetJobCount).toBe(1_000);
    expect(agentOptions?.searchMode).toBe("scale");
    expect(agentOptions?.maxSteps).toBe(240);
    expect(agentOptions?.runControl?.timeBudgetMs).toBe(60 * 60_000);
    expect(agentOptions?.runControl?.noProgressStepLimit).toBe(24);

    const discoveryState = await repository.getDiscoveryState();
    const run = discoveryState.recentRuns.at(-1);
    expect(run?.summary.outcome).toBe("completed");
    expect(run?.targetExecutions[0]?.requestedJobBudget).toBe(1_000);
  }, 60_000);

  test("passes a precision campaign's focus to the browser agent", async () => {
    const base = createBrowserRuntime();
    const agentCalls: Array<
      Parameters<NonNullable<BrowserSessionRuntime["runAgentDiscovery"]>>[1]
    > = [];
    const browserRuntime: BrowserSessionRuntime = {
      ...base,
      runAgentDiscovery: (source, options) => {
        agentCalls.push(options);
        return base.runAgentDiscovery!(source, options);
      },
    };
    const seed = createEmptyDiscoverySeed();
    seed.searchPreferences.discovery.targets = [
      createBrowserTarget("target_precision", "Precision Board"),
    ];
    const harness = createWorkspaceServiceHarness({ seed, browserRuntime });
    const preferences = await harness.repository.getSearchPreferences();
    const snapshot = await harness.workspaceService.saveCampaign({
      ...createScaleCampaignInput({
        name: "Precision Campaign",
        searchPreferences: preferences,
        discoveryRunJobBudget: null,
      }),
      mode: "precision",
    });
    const campaign = snapshot.campaigns.find(
      (candidate) => candidate.name === "Precision Campaign",
    );
    if (!campaign) throw new Error("Expected the precision campaign.");

    await harness.workspaceService.runCampaignNow({ campaignId: campaign.id });

    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]?.searchMode).toBe("precision");
    expect(agentCalls[0]?.retainAllFound).toBe(true);
    expect(agentCalls[0]?.runControl?.timeBudgetMs).toBe(60 * 60_000);
    expect(agentCalls[0]?.runControl?.noProgressStepLimit).toBe(24);
  }, 60_000);

  test("honors the run-scoped goal, breadth, freshness, and selected sources", async () => {
    const base = createBrowserRuntime();
    const agentCalls: Array<
      Parameters<NonNullable<BrowserSessionRuntime["runAgentDiscovery"]>>[1]
    > = [];
    const browserRuntime: BrowserSessionRuntime = {
      ...base,
      runAgentDiscovery: (source, options) => {
        agentCalls.push(options);
        return base.runAgentDiscovery!(source, options);
      },
    };
    const seed = createEmptyDiscoverySeed();
    seed.searchPreferences.discovery.targets = [
      createBrowserTarget("target_first", "First Board"),
      createBrowserTarget("target_selected", "Selected Board"),
    ];
    const harness = createWorkspaceServiceHarness({ seed, browserRuntime });
    const searchRequest = {
      intent: "around engineering",
      breadth: "wide" as const,
      freshness: "recent" as const,
      sourceIds: ["target_selected"],
    };

    await harness.workspaceService.runAgentDiscovery(
      undefined,
      undefined,
      undefined,
      searchRequest,
    );

    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]?.siteLabel).toBe("Selected Board");
    expect(agentCalls[0]?.searchMode).toBe("scale");
    expect(agentCalls[0]?.searchRequest).toEqual(searchRequest);
  }, 60_000);

  test("records a truthful warning when the bounded agent runtime is unavailable instead of a silent zero", async () => {
    const base = createBrowserRuntime();
    const stubBase = { ...base } as Partial<BrowserSessionRuntime>;
    delete stubBase.runAgentDiscovery;
    const productionLikeStubRuntime = {
      ...stubBase,
      runDiscovery: (source) =>
        Promise.resolve({
          source,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          querySummary: "direct stub",
          inventoryCompleteness: "unknown",
          warning:
            "Direct live discovery is not available for generic target flows. Use the agent discovery path instead.",
          jobs: [],
          agentMetadata: null,
        }),
    } as BrowserSessionRuntime;

    const seed = createEmptyDiscoverySeed();
    seed.searchPreferences.discovery.targets = [
      createBrowserTarget("target_browser_only", "Browser Only Board"),
    ];
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: productionLikeStubRuntime,
    });
    const { repository, workspaceService } = harness;

    const globalPreferences = await repository.getSearchPreferences();
    const campaignId = await saveScaleCampaign(harness, globalPreferences);
    // The only configured target fails truthfully, so the manual run rejects.
    await expect(
      workspaceService.runCampaignNow({ campaignId }),
    ).rejects.toThrow(/bounded browser agent runtime/);

    const discoveryState = await repository.getDiscoveryState();
    const run = discoveryState.recentRuns.at(-1);
    const execution = run?.targetExecutions[0];
    expect(execution?.state).toBe("failed");
    expect(execution?.jobsPersisted).toBe(0);
    expect(execution?.warning).toContain("bounded browser agent runtime");
    expect(execution?.warning).toContain("direct discovery");
    expect(run?.summary.warnings.length).toBeGreaterThan(0);
  }, 60_000);

  test("isolates a failing browser target while healthy targets complete, and schedules obey pause and cancellation", async () => {
    const healthyRuntime = createBrowserRuntime();
    const isolatedRuntime: BrowserSessionRuntime = {
      ...healthyRuntime,
      runAgentDiscovery: (source, options) =>
        options.siteLabel === "Broken Board"
          ? Promise.reject(new Error("browser navigation collapsed"))
          : healthyRuntime.runAgentDiscovery!(source, options),
    };

    const seed = createEmptyDiscoverySeed();
    seed.searchPreferences.discovery.targets = [
      createBrowserTarget("target_broken", "Broken Board"),
      createBrowserTarget("target_healthy", "Healthy Board"),
    ];
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: isolatedRuntime,
    });
    const { repository, workspaceService } = harness;

    const globalPreferences = await repository.getSearchPreferences();
    await workspaceService.saveCampaign(
      createScaleCampaignInput({
        name: "Isolation Campaign",
        searchPreferences: globalPreferences,
      }),
    );
    let snapshot = await workspaceService.getWorkspaceSnapshot();
    const campaignId = snapshot.activeCampaignId;

    // Give the campaign an enabled daily schedule that is already due.
    const stateWithSchedule = await repository.getCampaignState();
    const savedCampaign = stateWithSchedule?.campaigns.find(
      (candidate) => candidate.id === campaignId,
    );
    if (!savedCampaign) throw new Error("Expected the saved campaign.");
    const overdue = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    await workspaceService.saveCampaign({
      id: campaignId,
      name: savedCampaign.name,
      description: savedCampaign.description,
      mode: savedCampaign.mode,
      status: "active",
      searchPreferences: globalPreferences,
      sourceTargetIds: savedCampaign.sourceTargetIds,
      minimumFitScore: null,
      limits: savedCampaign.limits,
      stopRules: savedCampaign.stopRules,
      applicationPolicy: savedCampaign.applicationPolicy,
      rules: savedCampaign.rules,
      latestDigest: null,
      schedule: {
        mode: "daily" as const,
        enabled: true,
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        localStartTime: "09:00",
        timeZone: "UTC",
        pauseWindows: [],
        runFacts: {
          nextRunAt: overdue,
          lastRunAt: null,
          lastRunOutcome: null,
          lastRunSummary: null,
          consecutiveFailures: 0,
        },
      },
    });

    // While activity is paused, the due schedule never starts browser work.
    await workspaceService.setActivityControl({
      paused: true,
      reason: "qa pause",
    });
    await workspaceService.runDueScheduledCampaigns();
    const pausedState = await repository.getCampaignState();
    const pausedCampaign = pausedState?.campaigns.find(
      (candidate) => candidate.id === campaignId,
    );
    expect(pausedCampaign?.schedule.runFacts.lastRunAt).toBeNull();
    await workspaceService.setActivityControl({ paused: false });

    // A mid-run cancellation finalizes the run truthfully as cancelled.
    const controller = new AbortController();
    const cancelPromise = workspaceService.runAgentDiscovery(
      undefined,
      controller.signal,
    );
    controller.abort();
    snapshot = await cancelPromise;
    expect(snapshot.recentDiscoveryRuns.at(-1)?.summary.outcome).toBe(
      "cancelled",
    );

    // Per-target isolation inside one campaign run: the broken board records
    // its own failure warning while the healthy board completes.
    await workspaceService.runCampaignNow({ campaignId });
    const ranState = await repository.getCampaignState();
    const ranCampaign = ranState?.campaigns.find(
      (candidate) => candidate.id === campaignId,
    );
    expect(ranCampaign?.schedule.runFacts.lastRunOutcome).toBe("partial");

    const discoveryState = await repository.getDiscoveryState();
    const run = discoveryState.recentRuns.find(
      (candidate) => candidate.campaignId === campaignId,
    );
    expect(run?.summary.outcome).toBe("completed");
    const brokenExecution = run?.targetExecutions.find(
      (execution) => execution.targetId === "target_broken",
    );
    const healthyExecution = run?.targetExecutions.find(
      (execution) => execution.targetId === "target_healthy",
    );
    expect(brokenExecution?.state).toBe("failed");
    expect(brokenExecution?.warning).toContain("browser navigation collapsed");
    expect(brokenExecution?.requestedJobBudget).toBeNull();
    expect(healthyExecution?.state).toBe("completed");
    expect(healthyExecution?.jobsPersisted).toBeGreaterThan(0);
  }, 60_000);

  test("samples every API target while retaining only the run budget", async () => {
    const seed = createEmptyDiscoverySeed();
    // Under a scarce one-job result budget every board is still sampled.
    seed.searchPreferences.discovery.targets = (
      [
        ["funded_board", "Funded Board"],
        ["zero_budget_a", "Zero Budget Board A"],
        ["zero_budget_b", "Zero Budget Board B"],
      ] as const
    ).map(([id, label]) => ({
      id,
      label,
      startingUrl: `https://job-boards.greenhouse.io/${id}`,
      enabled: true,
      adapterKind: "auto" as const,
      customInstructions: null,
      instructionStatus: "missing" as const,
      validatedInstructionId: null,
      draftInstructionId: null,
      lastDebugRunId: null,
      lastVerifiedAt: null,
      staleReason: null,
    }));
    const harness = createWorkspaceServiceHarness({ seed });
    const { repository, workspaceService } = harness;

    const fetchUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((request) => {
      fetchUrls.push(resolveRequestUrl(request));
      return Promise.resolve(createBoardResponse("funded_board", 40));
    });

    const globalPreferences = await repository.getSearchPreferences();
    const campaignId = await saveScaleCampaign(harness, globalPreferences, 1);
    await workspaceService.runCampaignNow({ campaignId });

    expect(fetchUrls).toHaveLength(3);

    const savedJobs = await repository.listSavedJobs();
    expect(savedJobs).toHaveLength(1);

    const discoveryState = await repository.getDiscoveryState();
    const run = discoveryState.recentRuns.at(-1);
    expect(run?.summary.outcome).toBe("completed");
    const executions = Object.fromEntries(
      (run?.targetExecutions ?? []).map((execution) => [
        execution.targetId,
        execution,
      ]),
    );
    expect(executions.zero_budget_a?.state).toBe("completed");
    expect(executions.zero_budget_a?.requestedJobBudget).toBe(1);
    expect(executions.zero_budget_b?.state).toBe("completed");
    expect(executions.zero_budget_b?.requestedJobBudget).toBe(1);
    expect(executions.funded_board?.state).toBe("completed");
    expect(executions.funded_board?.requestedJobBudget).toBe(1);

    expect(
      (run?.activity ?? []).filter(
        (event) => event.terminalState === "skipped",
      ),
    ).toHaveLength(0);
  }, 60_000);

  test("samples every browser target while retaining only the run budget", async () => {
    const base = createBrowserRuntime();
    const agentCalls: Array<
      Parameters<NonNullable<BrowserSessionRuntime["runAgentDiscovery"]>>[1]
    > = [];
    const browserRuntime: BrowserSessionRuntime = {
      ...base,
      runAgentDiscovery: (source, options) => {
        agentCalls.push(options);
        return base.runAgentDiscovery!(source, options);
      },
    };

    const seed = createEmptyDiscoverySeed();
    // Under a scarce one-job result budget every board still gets a run.
    seed.searchPreferences.discovery.targets = [
      createBrowserTarget("funded_browser", "Funded Board"),
      createBrowserTarget("zero_budget_browser", "Skipped Board"),
    ];
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
    });
    const { repository, workspaceService } = harness;

    const globalPreferences = await repository.getSearchPreferences();
    const campaignId = await saveScaleCampaign(harness, globalPreferences, 1);
    await workspaceService.runCampaignNow({ campaignId });

    expect(agentCalls).toHaveLength(2);
    expect(agentCalls[0]?.siteLabel).toBe("Funded Board");
    expect(agentCalls[1]?.siteLabel).toBe("Skipped Board");

    const discoveryState = await repository.getDiscoveryState();
    const run = discoveryState.recentRuns.at(-1);
    expect(run?.summary.outcome).toBe("completed");
    const executions = Object.fromEntries(
      (run?.targetExecutions ?? []).map((execution) => [
        execution.targetId,
        execution,
      ]),
    );
    expect(executions.zero_budget_browser?.state).toBe("completed");
    expect(executions.zero_budget_browser?.requestedJobBudget).toBe(1);
    expect(executions.funded_browser?.state).toBe("completed");
    expect(executions.funded_browser?.jobsPersisted).toBeGreaterThan(0);
  }, 60_000);

  test("fails fast on duplicate target ids before any discovery work", async () => {
    const base = createBrowserRuntime();
    const agentCalls: Array<
      Parameters<NonNullable<BrowserSessionRuntime["runAgentDiscovery"]>>[1]
    > = [];
    const browserRuntime: BrowserSessionRuntime = {
      ...base,
      runAgentDiscovery: (source, options) => {
        agentCalls.push(options);
        return base.runAgentDiscovery!(source, options);
      },
    };

    const seed = createEmptyDiscoverySeed();
    seed.searchPreferences.discovery.targets = [
      {
        ...createBrowserTarget("dup_board", "Duplicate Board A"),
        startingUrl: "https://jobs.example.com/dup-a",
      },
      {
        ...createBrowserTarget("dup_board", "Duplicate Board B"),
        startingUrl: "https://jobs.example.com/dup-b",
      },
    ];
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
    });
    const { repository, workspaceService } = harness;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(workspaceService.runAgentDiscovery()).rejects.toThrow(
      /Duplicate discovery target id "dup_board"/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(agentCalls).toHaveLength(0);

    const discoveryState = await repository.getDiscoveryState();
    expect(
      discoveryState.recentRuns.some((run) =>
        run.targetExecutions.some(
          (execution) => execution.targetId === "dup_board",
        ),
      ),
    ).toBe(false);

    // The failed planning attempt must not leak an active-run controller:
    // a retry fails with the same explicit error instead of a busy-run error.
    await expect(workspaceService.runAgentDiscovery()).rejects.toThrow(
      /Duplicate discovery target id/,
    );
  }, 60_000);
});

interface DeferredResponse {
  promise: Promise<Response>;
  resolve(value: Response): void;
}

function createDeferredResponse(): DeferredResponse {
  let resolveValue: ((value: Response) => void) | null = null;
  const promise = new Promise<Response>((resolve) => {
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

function createBoardResponse(boardId: string, jobCount: number): Response {
  return Response.json({
    jobs: Array.from({ length: jobCount }, (_, index) => ({
      id: 10_000 + index,
      title: `Senior Product Designer ${index}`,
      absolute_url: `https://job-boards.greenhouse.io/${boardId}/jobs/${10_000 + index}`,
      location: { name: "Remote" },
      updated_at: "2026-08-09T10:00:00.000Z",
      content:
        "<p>Lead product design systems and resilient workflow platforms.</p>",
    })),
  });
}

function completedTargetIds(events: DiscoveryActivityEvent[]): string[] {
  return events.flatMap((event) =>
    event.stage === "target" &&
    event.terminalState === "completed" &&
    event.targetId
      ? [event.targetId]
      : [],
  );
}

describe("discovery budget allocation order independence", () => {
  const createOrderIndependentSeed = () => {
    const seed = createEmptyDiscoverySeed();
    seed.searchPreferences.discovery.targets = (
      [
        ["board_a", "Board A"],
        ["board_b", "Board B"],
        ["board_c", "Board C"],
      ] as const
    ).map(([id, label]) => ({
      id,
      label,
      startingUrl: `https://job-boards.greenhouse.io/${id}`,
      enabled: true,
      adapterKind: "auto" as const,
      customInstructions: null,
      instructionStatus: "missing" as const,
      validatedInstructionId: null,
      draftInstructionId: null,
      lastDebugRunId: null,
      lastVerifiedAt: null,
      staleReason: null,
    }));
    seed.searchPreferences.discovery.runJobBudget = 1_000;
    return seed;
  };

  async function runWithCompletionOrder(order: readonly string[]) {
    const pendingRequests = new Map(
      order.map((boardId) => [boardId, createDeferredResponse()]),
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((request) => {
        const url = resolveRequestUrl(request);
        const boardId = order.find((candidate) => url.includes(candidate));
        const deferred = boardId ? pendingRequests.get(boardId) : undefined;
        if (!deferred) {
          throw new Error(`Unexpected provider request: ${url}`);
        }
        return deferred.promise;
      });

    try {
      const events: DiscoveryActivityEvent[] = [];
      const { repository, workspaceService } = createWorkspaceServiceHarness({
        seed: createOrderIndependentSeed(),
      });
      const runPromise = workspaceService.runAgentDiscovery((event) =>
        events.push(event),
      );

      for (const boardId of order) {
        // Board B is deliberately low-yield so a found-so-far redistribution
        // would produce different budgets per completion order.
        pendingRequests
          .get(boardId)
          ?.resolve(
            createBoardResponse(boardId, boardId === "board_b" ? 5 : 120),
          );
        await vi.waitFor(() => {
          expect(completedTargetIds(events)).toContain(boardId);
        });
      }
      await runPromise;

      const discoveryState = await repository.getDiscoveryState();
      const run = discoveryState.recentRuns[0];
      if (!run) throw new Error("Expected a discovery run record.");
      return Object.fromEntries(
        run.targetExecutions.map((execution) => [
          execution.targetId,
          execution.requestedJobBudget,
        ]),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  }

  test("assigns identical per-target budgets regardless of readiness order", async () => {
    const configuredOrderBudgets = await runWithCompletionOrder([
      "board_a",
      "board_b",
      "board_c",
    ]);
    const reversedOrderBudgets = await runWithCompletionOrder([
      "board_c",
      "board_b",
      "board_a",
    ]);

    expect(reversedOrderBudgets).toEqual(configuredOrderBudgets);
    expect(configuredOrderBudgets).toEqual({
      board_a: 333,
      board_b: 333,
      board_c: 334,
    });
    expect(
      Object.values(configuredOrderBudgets)
        .map((budget) => budget ?? 0)
        .reduce((total, budget) => total + budget, 0),
    ).toBe(1_000);
  }, 120_000);
});
