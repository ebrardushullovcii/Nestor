import { describe, expect, test } from "vitest";
import {
  ApplicationAttemptSchema,
  DiscoveryRunRecordSchema,
  JobFinderIntelligenceSafeguardsSchema,
  ApplicationRecordSchema,
  type ApplicationRecord,
  type ApplicationStatus,
  ApplyJobResultSchema,
  ApplyRunSchema,
  JobSearchPreferencesSchema,
  ResumeDraftSchema,
  SaveJobSearchCampaignInputSchema,
  TailoredAssetSchema,
  type ApplyRunState,
  type DiscoveryRunRecord,
  type JobFinderWorkspaceSnapshot,
  type JobSearchPreferences,
  type SaveJobSearchCampaignInput,
} from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "@nestor/db";

import {
  assertCampaignCanRun,
  createCampaign,
  deriveCampaignProgress,
  deriveDashboardSummary,
  ensureCampaignState,
  reconcileCampaignState,
} from "./campaign-dashboard";
import {
  createWorkspaceCampaignMethods,
  recordCampaignDiscoveryResult,
} from "./workspace-campaign-methods";
import type { WorkspaceServiceContext } from "./workspace-service-context";
import {
  createMatchAssessmentContextFingerprint,
  createMatchAssessmentPostingFingerprint,
} from "./match-assessment-session";
import { enrichSearchPreferencesFromProfile } from "./workspace-helpers";
import { withSavedJobSearchBehavior } from "./job-search-behavior";
import { createSavedJob, createSeed } from "../workspace-service.test-fixtures";
import { finalizeRunningTargetExecutions } from "./workspace-discovery-run-helpers";

function savedJob(id: string, score: number, planId = "campaign_precision") {
  const job = createSavedJob({
    id,
    source: "target_site",
    sourceJobId: id,
    discoveryMethod: "catalog_seed",
    canonicalUrl: `https://jobs.example.com/${id}`,
    applicationUrl: `https://jobs.example.com/${id}/apply`,
    title: `Engineer ${id}`,
    company: "Example",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    postedAt: null,
    postedAtText: null,
    discoveredAt: "2026-08-15T10:00:00.000Z",
    firstSeenAt: "2026-08-15T10:00:00.000Z",
    lastSeenAt: "2026-08-15T10:00:00.000Z",
    lastVerifiedActiveAt: "2026-08-15T10:00:00.000Z",
    salaryText: null,
    summary: "Engineering role.",
    description: "Engineering role.",
    keySkills: [],
    responsibilities: [],
    minimumQualifications: [],
    preferredQualifications: [],
    status: "discovered",
    // A model verdict, so the plan's minimum fit applies to it (ADR 0041).
    matchAssessment: {
      score,
      judgment: {
        source: "batch",
        judgedAt: "2026-08-15T10:00:00.000Z",
        score,
        recommendation: "review_before_applying",
      },
    },
  });
  const seed = createSeed();
  const preferences = withSavedJobSearchBehavior(
    enrichSearchPreferencesFromProfile(
      normalizedPreferences(seed.searchPreferences),
      seed.profile,
    ),
    seed.settings,
  );
  // A measured verdict for these exact goals and facts, rather than a legacy
  // fixture score without the context needed to assign it to a plan.
  job.matchAssessment.judgment = {
    ...job.matchAssessment.judgment!,
    contextFingerprint: createMatchAssessmentContextFingerprint(
      seed.profile,
      preferences,
    ),
    postingFingerprint: createMatchAssessmentPostingFingerprint(job),
  };
  job.planAssessments = { [planId]: job.matchAssessment };
  return job;
}

/**
 * Repository reads return schema-normalized preferences (defaults such as
 * `discovery.collectOnlyHardCriteriaMatches: false` are applied on write),
 * so expectations are compared against the parsed form of the same literal.
 */
function normalizedPreferences(
  preferences: JobSearchPreferences,
): JobSearchPreferences {
  return JobSearchPreferencesSchema.parse(preferences);
}

describe("dashboard summary recommendations", () => {
  test.each([false, true])(
    "counts safeguard attention before recommending a search (paused: %s)",
    (paused) => {
      const seed = createSeed();
      const campaign = createCampaign({
        id: "campaign_idle",
        name: "Idle plan",
        mode: "precision",
        searchPreferences: seed.searchPreferences,
        now: "2026-08-15T09:00:00.000Z",
      });

      const summary = deriveDashboardSummary({
        safeguards: JobFinderIntelligenceSafeguardsSchema.parse({
          abnormalFailurePauses: paused
            ? [
                {
                  id: `automatic_discovery_failures:${campaign.id}`,
                  windowStartedAt: "2026-08-15T09:00:00.000Z",
                  failuresInWindow: 3,
                  sampleSize: 8,
                  failureRatePercent: 37.5,
                  failureRateThresholdPercent: 30,
                  paused: true,
                  explanation: "Review failed searches.",
                  recoveryGuidance: "Open Safeguards",
                },
              ]
            : [],
        }),
        generatedAt: "2026-08-15T10:00:00.000Z",
        campaigns: {
          notifications: [],
          activeCampaignId: campaign.id,
          campaigns: [campaign],
        },
        savedJobs: [],
        reviewQueue: [],
        applicationRecords: [],
        applyRuns: [],
        userActionRequests: [],
        discovery: seed.discovery,
        searchPreferences: seed.searchPreferences,
      });

      expect(summary.needsYouCount).toBe(paused ? 1 : 0);
      if (paused) {
        expect(summary.recommendedNextAction.route).toBe("/job-finder/actions");
        return;
      }
      expect(summary.recommendedNextAction.label).toBe("Find jobs");
      expect(summary.recommendedNextAction.detail).toBe(
        "Run the active search plan to collect relevant openings.",
      );
      expect(summary.recommendedNextAction.detail).not.toContain("campaign");
    },
  );

  test("counts a never-verified source as healthy once its latest run completed", () => {
    const seed = createSeed();
    const campaign = createCampaign({
      id: "campaign_health",
      name: "Health plan",
      mode: "precision",
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T09:00:00.000Z",
    });
    const enabledTarget = seed.searchPreferences.discovery.targets.find(
      (target) => target.enabled,
    );
    if (!enabledTarget) throw new Error("Expected an enabled seed target.");
    expect(enabledTarget.lastVerifiedAt).toBeNull();
    const completedRun: DiscoveryRunRecord = {
      id: "run_health",
      campaignId: campaign.id,
      state: "completed",
      runPhase: "complete",
      scope: "run_all",
      startedAt: "2026-08-15T09:30:00.000Z",
      completedAt: "2026-08-15T09:31:00.000Z",
      targetIds: [enabledTarget.id],
      targetExecutions: [
        {
          targetId: enabledTarget.id,
          adapterKind: enabledTarget.adapterKind,
          resolvedAdapterKind: null,
          collectionMethod: null,
          sourceIntelligenceProvider: null,
          state: "completed",
          startedAt: "2026-08-15T09:30:00.000Z",
          completedAt: "2026-08-15T09:31:00.000Z",
          requestedJobBudget: null,
          jobsReviewed: 12,
          jobsFound: 12,
          jobsPersisted: 12,
          jobsStaged: 0,
          jobsSkippedByLedger: 0,
          jobsSkippedByTitleTriage: 0,
          duplicatesMerged: 0,
          invalidSkipped: 0,
          changeDigest: {
            new: 12,
            unchanged: 0,
            changed: 0,
            reactivated: 0,
            inactive: 0,
            known: 0,
            skipped: 0,
          },
          warning: null,
          compactionState: null,
          compactionUsedFallbackTrigger: false,
          timing: null,
          agentCheckpoint: null,
          encounteredJobIds: [],
        },
      ],
      activity: [],
      summary: {
        targetsPlanned: 1,
        targetsCompleted: 1,
        validJobsFound: 12,
        jobsPersisted: 12,
        jobsStaged: 0,
        jobsSkippedByLedger: 0,
        jobsSkippedByTitleTriage: 0,
        duplicatesMerged: 0,
        invalidSkipped: 0,
        changeDigest: {
          new: 12,
          unchanged: 0,
          changed: 0,
          reactivated: 0,
          inactive: 0,
          known: 0,
          skipped: 0,
        },
        sourceHealth: [],
        warnings: [],
        durationMs: 60_000,
        outcome: "completed",
        browserCloseout: null,
        report: null,
        timing: null,
      },
    };
    const input = {
      generatedAt: "2026-08-15T10:00:00.000Z",
      campaigns: {
        notifications: [],
        activeCampaignId: campaign.id,
        campaigns: [campaign],
      },
      savedJobs: [],
      reviewQueue: [],
      applicationRecords: [],
      applyRuns: [],
      userActionRequests: [],
      searchPreferences: seed.searchPreferences,
    };

    const beforeRun = deriveDashboardSummary({
      ...input,
      discovery: seed.discovery,
    });
    const afterRun = deriveDashboardSummary({
      ...input,
      discovery: { ...seed.discovery, recentRuns: [completedRun] },
    });
    const afterFailure = deriveDashboardSummary({
      ...input,
      discovery: {
        ...seed.discovery,
        recentRuns: [
          {
            ...completedRun,
            id: "run_health_failed",
            state: "failed",
            startedAt: "2026-08-15T09:40:00.000Z",
            completedAt: "2026-08-15T09:41:00.000Z",
            targetExecutions: completedRun.targetExecutions.map(
              (execution) => ({
                ...execution,
                state: "failed" as const,
                startedAt: "2026-08-15T09:40:00.000Z",
                completedAt: "2026-08-15T09:41:00.000Z",
              }),
            ),
          },
          completedRun,
        ],
      },
    });

    // Never checked is not a problem: checks are optional (ADR 0024).
    expect(beforeRun.sourceHealth).toMatchObject({
      healthy: 1,
      needsAttention: 0,
    });
    expect(afterRun.sourceHealth).toMatchObject({
      healthy: 1,
      needsAttention: 0,
    });
    // A later failed execution withdraws the proof again.
    expect(afterFailure.sourceHealth).toMatchObject({
      healthy: 0,
      needsAttention: 1,
    });
  });
});

describe("campaign workspace core", () => {
  test("rejects discovery while the active campaign is not active", () => {
    const seed = createSeed();
    const paused = {
      ...createCampaign({
        id: "paused",
        name: "Paused campaign",
        mode: "precision",
        searchPreferences: seed.searchPreferences,
        now: "2026-08-15T09:00:00.000Z",
      }),
      status: "paused" as const,
    };

    expect(() => assertCampaignCanRun(paused)).toThrow(
      "Set it to active before starting discovery",
    );
  });

  test("honors a paused campaign and drops source ids that are not in its catalog", async () => {
    const seed = createSeed();
    const repository = createInMemoryJobFinderRepository(seed);
    const methods = createWorkspaceCampaignMethods({
      ctx: {
        repository,
        withCampaignTransition: async <T>(operation: () => Promise<T>) =>
          operation(),
      } as WorkspaceServiceContext,
      getWorkspaceSnapshot: () =>
        Promise.resolve(null as unknown as JobFinderWorkspaceSnapshot),
      runCampaignDiscovery: () =>
        Promise.resolve(null as unknown as JobFinderWorkspaceSnapshot),
      afterCampaignRun: () =>
        Promise.resolve(null as unknown as JobFinderWorkspaceSnapshot),
    });

    await methods.saveCampaign({
      id: null,
      name: "Quiet scale search",
      description: "Created paused.",
      mode: "scale",
      status: "paused",
      searchPreferences: seed.searchPreferences,
      sourceTargetIds: ["stale_target_id"],
      minimumFitScore: 70,
      limits: {
        retainedJobTarget: 100,
        analysisConcurrency: 4,
        preparationBatchSize: 20,
        dailyPreparationLimit: 50,
      },
      stopRules: {
        pauseOnLoginRequired: true,
        pauseOnChangedForm: true,
        pauseOnUncertainEligibility: true,
        pauseOnFailureRatePercent: 20,
        failureRateMinimumSample: 10,
      },
      applicationPolicy: {
        resumeStrategy: "job_family_variants",
        requireReviewBeforePreparation: false,
        requireReviewBeforeExternalWrite: true,
        finalSubmitAuthorized: false,
        qualityReviewSampleRatio: 0.2,
        simultaneousApplicationWindowDays: 1,
      },
      schedule: {
        mode: "manual",
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
      rules: [],
      latestDigest: null,
    });

    const state = await repository.getCampaignState();
    const campaign = state?.campaigns.find(
      (candidate) => candidate.name === "Quiet scale search",
    );
    expect(campaign?.status).toBe("paused");
    expect(campaign?.sourceTargetIds).toEqual([]);
    expect(campaign?.limits.preparationBatchSize).toBe(20);
  });

  test("binds a completed run to its captured campaign and retains only its strongest eligible jobs", async () => {
    const seed = createSeed();
    const jobs = [
      savedJob("low", 40),
      savedJob("mid", 75),
      savedJob("high", 95),
    ];
    const target = seed.searchPreferences.discovery.targets[0];
    if (!target) throw new Error("Expected a saved source.");
    const repository = createInMemoryJobFinderRepository({
      ...seed,
      savedJobs: jobs,
      discovery: {
        ...seed.discovery,
        recentRuns: [
          DiscoveryRunRecordSchema.parse({
            id: "run_1",
            campaignId: "campaign_precision",
            state: "completed",
            runPhase: "complete",
            startedAt: "2026-08-15T10:00:00.000Z",
            completedAt: "2026-08-15T10:01:00.000Z",
            scope: "run_all",
            targetIds: [target.id],
            targetExecutions: [
              {
                targetId: target.id,
                adapterKind: target.adapterKind,
                state: "completed",
                agentCheckpoint: {
                  revision: 1,
                  savedAt: "2026-08-15T10:00:30.000Z",
                  currentUrl: target.startingUrl,
                  lastStableUrl: target.startingUrl,
                  stepCount: 1,
                  collectedJobs: jobs,
                  visitedUrls: [target.startingUrl],
                  phaseEvidence: {},
                },
              },
            ],
            activity: [],
            summary: {
              targetsPlanned: 0,
              targetsCompleted: 0,
              validJobsFound: 3,
              jobsPersisted: 3,
              jobsStaged: 0,
              jobsSkippedByLedger: 0,
              jobsSkippedByTitleTriage: 0,
              duplicatesMerged: 0,
              invalidSkipped: 0,
              changeDigest: {
                new: 0,
                unchanged: 0,
                changed: 0,
                reactivated: 0,
                inactive: 0,
                known: 0,
                skipped: 0,
              },
              sourceHealth: [],
              warnings: [],
              durationMs: 60_000,
              outcome: "completed",
              browserCloseout: null,
              report: null,
              timing: null,
            },
          }),
        ],
      },
    });
    const campaign = {
      ...createCampaign({
        id: "campaign_precision",
        name: "Precision",
        mode: "precision",
        searchPreferences: seed.searchPreferences,
        now: "2026-08-15T09:00:00.000Z",
      }),
      minimumFitScore: 70,
      limits: {
        ...createCampaign({
          id: "template",
          name: "Template",
          mode: "precision",
          searchPreferences: seed.searchPreferences,
          now: "2026-08-15T09:00:00.000Z",
        }).limits,
        retainedJobTarget: 2,
      },
    };
    await repository.saveCampaignState({
      notifications: [],
      activeCampaignId: campaign.id,
      campaigns: [campaign],
    });

    await recordCampaignDiscoveryResult({
      ctx: {
        repository,
        withCampaignTransition: async (operation) => operation(),
      } as WorkspaceServiceContext,
      campaignId: campaign.id,
      beforeJobProvenanceFingerprints: new Map(),
    });

    const state = await repository.getCampaignState();
    expect(state?.campaigns[0]?.jobIds).toEqual(["high", "mid"]);
    // The run saved three new jobs; the plan retained its strongest two.
    expect(state?.campaigns[0]?.latestDigest?.report).toMatchObject({
      new: 3,
      retained: 2,
    });
    expect(state?.campaigns[0]?.history[0]?.discoveryRunId).toBe("run_1");
  });

  test("retains discovery-only staged jobs so the active campaign can display them", async () => {
    const seed = createSeed();
    const jobs = [
      savedJob("staged_low", 40, "campaign_discovery_only"),
      savedJob("staged_mid", 75, "campaign_discovery_only"),
      savedJob("staged_high", 95, "campaign_discovery_only"),
    ];
    const target = seed.searchPreferences.discovery.targets[0];
    if (!target) throw new Error("Expected a saved source.");
    const repository = createInMemoryJobFinderRepository({
      ...seed,
      savedJobs: [],
      discovery: {
        ...seed.discovery,
        pendingDiscoveryJobs: jobs,
        recentRuns: [
          DiscoveryRunRecordSchema.parse({
            id: "run_discovery_only",
            campaignId: "campaign_discovery_only",
            state: "completed",
            runPhase: "complete",
            startedAt: "2026-08-15T10:00:00.000Z",
            completedAt: "2026-08-15T10:01:00.000Z",
            scope: "run_all",
            targetIds: [target.id],
            targetExecutions: [
              {
                targetId: target.id,
                adapterKind: target.adapterKind,
                state: "completed",
                agentCheckpoint: {
                  revision: 1,
                  savedAt: "2026-08-15T10:00:30.000Z",
                  currentUrl: target.startingUrl,
                  lastStableUrl: target.startingUrl,
                  stepCount: 1,
                  collectedJobs: jobs,
                  visitedUrls: [target.startingUrl],
                  phaseEvidence: {},
                },
              },
            ],
            activity: [],
            summary: {
              targetsPlanned: 0,
              targetsCompleted: 0,
              validJobsFound: 3,
              jobsPersisted: 0,
              jobsStaged: 3,
              jobsSkippedByLedger: 0,
              jobsSkippedByTitleTriage: 0,
              duplicatesMerged: 0,
              invalidSkipped: 0,
              changeDigest: {
                new: 3,
                unchanged: 0,
                changed: 0,
                reactivated: 0,
                inactive: 0,
                known: 0,
                skipped: 0,
              },
              sourceHealth: [],
              warnings: [],
              durationMs: 60_000,
              outcome: "completed",
              browserCloseout: null,
              report: null,
              timing: null,
            },
          }),
        ],
      },
    });
    const campaign = {
      ...createCampaign({
        id: "campaign_discovery_only",
        name: "Discovery only",
        mode: "precision",
        searchPreferences: seed.searchPreferences,
        now: "2026-08-15T09:00:00.000Z",
      }),
      minimumFitScore: 70,
      limits: {
        ...createCampaign({
          id: "discovery_only_template",
          name: "Template",
          mode: "precision",
          searchPreferences: seed.searchPreferences,
          now: "2026-08-15T09:00:00.000Z",
        }).limits,
        retainedJobTarget: 2,
      },
    };
    await repository.saveCampaignState({
      notifications: [],
      activeCampaignId: campaign.id,
      campaigns: [campaign],
    });

    await recordCampaignDiscoveryResult({
      ctx: {
        repository,
        withCampaignTransition: async (operation) => operation(),
      } as WorkspaceServiceContext,
      campaignId: campaign.id,
      beforeJobProvenanceFingerprints: new Map(),
    });

    expect((await repository.getCampaignState())?.campaigns[0]?.jobIds).toEqual(
      ["staged_high", "staged_mid"],
    );
    expect((await repository.listSavedJobs()).map((job) => job.id)).toEqual([]);
  });

  test("adds only the exactly identified duplicate instead of every historical source job", async () => {
    const seed = createSeed();
    const job = createSavedJob({
      ...savedJob("shared", 90),
      lastSeenAt: "2026-08-15T11:00:30.000Z",
    });
    const historicalJobs = Array.from({ length: 99 }, (_, index) =>
      savedJob(`historical_${index + 1}`, 89 - (index % 40)),
    );
    const target = seed.searchPreferences.discovery.targets[0];
    if (!target) throw new Error("Expected a saved source.");
    const repository = createInMemoryJobFinderRepository({
      ...seed,
      savedJobs: [job, ...historicalJobs],
      discovery: {
        ...seed.discovery,
        recentRuns: [
          DiscoveryRunRecordSchema.parse({
            id: "run_campaign_b",
            campaignId: "campaign_b",
            state: "completed",
            runPhase: "complete",
            scope: "run_all",
            startedAt: "2026-08-15T11:00:00.000Z",
            completedAt: "2026-08-15T11:01:00.000Z",
            targetIds: [target.id],
            targetExecutions: [
              {
                targetId: target.id,
                adapterKind: target.adapterKind,
                state: "completed",
                duplicatesMerged: 1,
                agentCheckpoint: {
                  revision: 1,
                  savedAt: "2026-08-15T11:00:30.000Z",
                  currentUrl: target.startingUrl,
                  lastStableUrl: target.startingUrl,
                  stepCount: 1,
                  collectedJobs: [job],
                  visitedUrls: [target.startingUrl],
                  phaseEvidence: {},
                },
              },
            ],
            activity: [],
            summary: {
              targetsPlanned: 0,
              targetsCompleted: 0,
              validJobsFound: 0,
              jobsPersisted: 0,
              jobsStaged: 0,
              jobsSkippedByLedger: 0,
              jobsSkippedByTitleTriage: 0,
              duplicatesMerged: 1,
              invalidSkipped: 0,
              changeDigest: {
                new: 0,
                unchanged: 0,
                changed: 0,
                reactivated: 0,
                inactive: 0,
                known: 0,
                skipped: 0,
              },
              sourceHealth: [],
              warnings: [],
              durationMs: 60_000,
              outcome: "completed",
              browserCloseout: null,
              report: null,
              timing: null,
            },
          }),
        ],
      },
    });
    const campaign = createCampaign({
      id: "campaign_b",
      name: "Campaign B",
      mode: "precision",
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T10:00:00.000Z",
    });
    await repository.saveCampaignState({
      notifications: [],
      activeCampaignId: campaign.id,
      campaigns: [campaign],
    });

    await recordCampaignDiscoveryResult({
      ctx: {
        repository,
        withCampaignTransition: async (operation) => operation(),
      } as WorkspaceServiceContext,
      campaignId: campaign.id,
      // Every stored row carries the same historical source timing/provenance;
      // only the checkpoint identity above belongs to this run.
      beforeJobProvenanceFingerprints: new Map([
        ...[job, ...historicalJobs].map(
          (candidate) =>
            [candidate.id, JSON.stringify(candidate.provenance)] as const,
        ),
      ]),
    });

    const stored = (await repository.getCampaignState())?.campaigns[0];
    expect(stored?.jobIds).toEqual(["shared"]);
    // "New" counts jobs new to this device; the plan keeping a job it
    // already had elsewhere shows up as retained, not new.
    expect(stored?.latestDigest?.report).toMatchObject({
      duplicates: 1,
      new: 0,
      retained: 1,
    });
  });
});

describe("campaign in-flight retention protection", () => {
  function savedJobWithStatus(
    id: string,
    score: number,
    status: "discovered" | "shortlisted" | "rejected",
  ) {
    return createSavedJob({
      ...savedJob(id, score),
      status,
    });
  }

  function completedRun(campaignId: string, runId: string): DiscoveryRunRecord {
    return {
      id: runId,
      campaignId,
      state: "completed",
      runPhase: "complete",
      scope: "run_all",
      startedAt: "2026-08-15T10:00:00.000Z",
      completedAt: "2026-08-15T10:01:00.000Z",
      targetIds: [],
      targetExecutions: [],
      activity: [],
      summary: {
        targetsPlanned: 0,
        targetsCompleted: 0,
        validJobsFound: 0,
        jobsPersisted: 0,
        jobsStaged: 0,
        jobsSkippedByLedger: 0,
        jobsSkippedByTitleTriage: 0,
        duplicatesMerged: 0,
        invalidSkipped: 0,
        changeDigest: {
          new: 0,
          unchanged: 0,
          changed: 0,
          reactivated: 0,
          inactive: 0,
          known: 0,
          skipped: 0,
        },
        sourceHealth: [],
        warnings: [],
        durationMs: 60_000,
        outcome: "completed",
        browserCloseout: null,
        report: null,
        timing: null,
      },
    };
  }

  async function commitRetentionRefresh(input: {
    repository: ReturnType<typeof createInMemoryJobFinderRepository>;
    campaignId: string;
  }) {
    await recordCampaignDiscoveryResult({
      ctx: {
        repository: input.repository,
        withCampaignTransition: async (operation) => operation(),
      } as WorkspaceServiceContext,
      campaignId: input.campaignId,
      // No provenance changed during the refresh, so candidacy comes purely
      // from the campaign's own retained membership.
      beforeJobProvenanceFingerprints: new Map(
        (await input.repository.listSavedJobs()).map((job) => [
          job.id,
          JSON.stringify(job.provenance),
        ]),
      ),
    });
  }

  test("an empty run reports zero kept while the plan keeps its older inventory", async () => {
    const seed = createSeed();
    const jobs = Array.from({ length: 15 }, (_, index) =>
      savedJob(`older_${index + 1}`, 80 - index),
    );
    const campaign = {
      ...createCampaign({
        id: "campaign_with_history",
        name: "Existing inventory",
        mode: "precision",
        searchPreferences: seed.searchPreferences,
        now: "2026-08-15T09:00:00.000Z",
      }),
      jobIds: jobs.map((job) => job.id),
    };
    const repository = createInMemoryJobFinderRepository({
      ...seed,
      savedJobs: jobs,
      discovery: {
        ...seed.discovery,
        recentRuns: [completedRun(campaign.id, "run_empty")],
      },
    });
    await repository.saveCampaignState({
      notifications: [],
      activeCampaignId: campaign.id,
      campaigns: [campaign],
    });

    await commitRetentionRefresh({ repository, campaignId: campaign.id });

    const stored = (await repository.getCampaignState())?.campaigns[0];
    expect(stored?.latestDigest?.report).toMatchObject({
      found: 0,
      new: 0,
      retained: 0,
    });
    expect(stored?.schedule.runFacts.lastRunSummary).toContain(
      "0 postings seen · 0 unique jobs · 0 new to you · 0 kept by this plan",
    );
    expect(stored?.jobIds).toHaveLength(15);
    expect(stored?.progress.jobsFound).toBe(15);
  });

  test("keeps shortlisted, prepared/approved, running apply, and application-record jobs beyond the ranked target while evicting untouched lower-fit jobs", async () => {
    const seed = createSeed();
    const jobs = [
      savedJob("arrival_high", 99),
      savedJob("kept_2", 90),
      savedJob("kept_3", 80),
      savedJob("evicted_low", 50),
      // Rejected is an explicit exit: higher fit than the protected jobs
      // below but still evicted because it is never protected.
      savedJobWithStatus("rejected_job", 45, "rejected"),
      savedJobWithStatus("shortlisted_job", 40, "shortlisted"),
      savedJob("prepared_asset_job", 35),
      savedJob("approved_draft_job", 30),
      savedJob("running_apply_job", 25),
      savedJob("record_attempt_job", 10),
    ];
    const repository = createInMemoryJobFinderRepository({
      ...seed,
      savedJobs: jobs,
      tailoredAssets: [
        TailoredAssetSchema.parse({
          id: "asset_prepared",
          jobId: "prepared_asset_job",
          kind: "resume",
          status: "generating",
          label: "Tailored Resume",
          version: "v1",
          templateName: "Chronology Classic",
          compatibilityScore: null,
          progressPercent: 40,
          updatedAt: "2026-08-15T10:00:00.000Z",
        }),
      ],
      resumeDrafts: [
        ResumeDraftSchema.parse({
          id: "draft_approved",
          jobId: "approved_draft_job",
          status: "approved",
          templateId: "classic_ats",
          createdAt: "2026-08-15T09:30:00.000Z",
          updatedAt: "2026-08-15T09:40:00.000Z",
        }),
      ],
      applyRuns: [
        ApplyRunSchema.parse({
          id: "apply_run_running",
          campaignId: "campaign_precision",
          state: "running",
          jobIds: ["running_apply_job"],
          createdAt: "2026-08-15T09:50:00.000Z",
          updatedAt: "2026-08-15T09:55:00.000Z",
          summary: "Apply run in progress.",
          detail: "Preparing and submitting applications.",
        }),
      ],
      applyJobResults: [
        ApplyJobResultSchema.parse({
          id: "result_blocked",
          runId: "apply_run_running",
          jobId: "running_apply_job",
          state: "blocked",
          summary: "Blocked at work authorization question.",
          detail: "Waiting on a user decision.",
          startedAt: "2026-08-15T09:51:00.000Z",
          updatedAt: "2026-08-15T09:56:00.000Z",
        }),
      ],
      applicationRecords: [
        ApplicationRecordSchema.parse({
          id: "application_record_1",
          jobId: "record_attempt_job",
          title: "Engineer record_attempt_job",
          company: "Example",
          status: "submitted",
          lastActionLabel: "Submitted",
          nextActionLabel: null,
          lastUpdatedAt: "2026-08-15T09:45:00.000Z",
        }),
      ],
      applicationAttempts: [
        ApplicationAttemptSchema.parse({
          id: "application_attempt_1",
          jobId: "record_attempt_job",
          state: "submitted",
          summary: "Application submitted.",
          detail: "External write completed with evidence.",
          startedAt: "2026-08-15T09:41:00.000Z",
          updatedAt: "2026-08-15T09:45:00.000Z",
          completedAt: "2026-08-15T09:45:00.000Z",
          outcome: "submitted",
          nextActionLabel: null,
        }),
      ],
      discovery: {
        ...seed.discovery,
        recentRuns: [completedRun("campaign_precision", "run_refresh")],
      },
    });
    const base = createCampaign({
      id: "campaign_precision",
      name: "Precision",
      mode: "precision",
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T09:00:00.000Z",
    });
    await repository.saveCampaignState({
      notifications: [],
      activeCampaignId: base.id,
      campaigns: [
        {
          ...base,
          limits: { ...base.limits, retainedJobTarget: 3 },
          jobIds: jobs.map((job) => job.id),
        },
      ],
    });

    await commitRetentionRefresh({
      repository,
      campaignId: base.id,
    });

    // The ranked top-3 survives, every in-flight job survives even though it
    // ranks below the cut, the untouched low-fit job and the rejected job are
    // evicted, and ordering stays deterministic (fit desc, then id).
    expect((await repository.getCampaignState())?.campaigns[0]?.jobIds).toEqual(
      [
        "arrival_high",
        "kept_2",
        "kept_3",
        "shortlisted_job",
        "prepared_asset_job",
        "approved_draft_job",
        "running_apply_job",
        "record_attempt_job",
      ],
    );
    // Retention never deletes workspace data; only campaign membership moves.
    expect(await repository.listSavedJobs()).toHaveLength(jobs.length);
  });

  test("scopes apply-run protection to the committing campaign while legacy unattributed runs stay workspace-level", async () => {
    const seed = createSeed();
    const jobs = [
      savedJob("baseline", 95),
      savedJob("own_run_job", 60),
      savedJob("foreign_run_job", 55),
      savedJob("legacy_run_job", 50),
    ];
    const repository = createInMemoryJobFinderRepository({
      ...seed,
      savedJobs: jobs,
      applyRuns: [
        ApplyRunSchema.parse({
          id: "apply_run_own",
          campaignId: "campaign_precision",
          jobIds: ["own_run_job"],
          createdAt: "2026-08-15T09:50:00.000Z",
          updatedAt: "2026-08-15T09:55:00.000Z",
          summary: "Own campaign run.",
          detail: "Completed under this campaign.",
        }),
        ApplyRunSchema.parse({
          id: "apply_run_foreign",
          campaignId: "campaign_other",
          jobIds: ["foreign_run_job"],
          createdAt: "2026-08-15T09:50:00.000Z",
          updatedAt: "2026-08-15T09:55:00.000Z",
          summary: "Foreign campaign run.",
          detail: "Completed under another campaign.",
        }),
        ApplyRunSchema.parse({
          id: "apply_run_legacy",
          campaignId: null,
          jobIds: ["legacy_run_job"],
          createdAt: "2026-08-15T09:50:00.000Z",
          updatedAt: "2026-08-15T09:55:00.000Z",
          summary: "Legacy unattributed run.",
          detail: "Pre-dates campaign attribution capture.",
        }),
      ],
      discovery: {
        ...seed.discovery,
        recentRuns: [completedRun("campaign_precision", "run_refresh")],
      },
    });
    const base = createCampaign({
      id: "campaign_precision",
      name: "Precision",
      mode: "precision",
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T09:00:00.000Z",
    });
    await repository.saveCampaignState({
      notifications: [],
      activeCampaignId: base.id,
      campaigns: [
        {
          ...base,
          limits: { ...base.limits, retainedJobTarget: 1 },
          jobIds: jobs.map((job) => job.id),
        },
      ],
    });

    await commitRetentionRefresh({ repository, campaignId: base.id });

    // Only baseline fits the target of one; the own-campaign run and the
    // legacy workspace-level run protect their jobs, the foreign-campaign
    // run does not leak its job into this campaign's retention.
    expect((await repository.getCampaignState())?.campaigns[0]?.jobIds).toEqual(
      ["baseline", "own_run_job", "legacy_run_job"],
    );
  });

  test("protection overrides the minimum fit bar so shortlisted work below it still survives", async () => {
    const seed = createSeed();
    const jobs = [
      savedJob("above_bar", 99),
      savedJobWithStatus("below_bar_shortlisted", 70, "shortlisted"),
      savedJob("below_bar_untouched", 30),
    ];
    const repository = createInMemoryJobFinderRepository({
      ...seed,
      savedJobs: jobs,
      discovery: {
        ...seed.discovery,
        recentRuns: [completedRun("campaign_precision", "run_refresh")],
      },
    });
    const base = createCampaign({
      id: "campaign_precision",
      name: "Precision",
      mode: "precision",
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T09:00:00.000Z",
    });
    await repository.saveCampaignState({
      notifications: [],
      activeCampaignId: base.id,
      campaigns: [
        {
          ...base,
          minimumFitScore: 96,
          jobIds: jobs.map((job) => job.id),
        },
      ],
    });

    await commitRetentionRefresh({ repository, campaignId: base.id });

    // Only above_bar clears the fit bar; the shortlisted job below it is
    // protected anyway, and the untouched discovered job is evicted.
    expect((await repository.getCampaignState())?.campaigns[0]?.jobIds).toEqual(
      ["above_bar", "below_bar_shortlisted"],
    );
  });
});

describe("campaign retention reconciliation", () => {
  function createAdoptedCampaign(seed: ReturnType<typeof createSeed>) {
    return {
      ...createCampaign({
        id: "campaign_default",
        name: "My job search",
        mode: "precision" as const,
        searchPreferences: seed.searchPreferences,
        now: "2026-08-15T09:00:00.000Z",
      }),
      history: [
        {
          id: "campaign_history_default_created",
          campaignId: "campaign_default",
          kind: "created" as const,
          occurredAt: "2026-08-15T09:00:00.000Z",
          summary: "Existing workspace moved into the default campaign.",
          discoveryRunId: null,
        },
      ],
    };
  }

  test("backfills empty retention on read so saved jobs stay reachable", async () => {
    const seed = createSeed();
    const repository = createInMemoryJobFinderRepository({
      ...seed,
      savedJobs: [savedJob("job_a", 90), savedJob("job_b", 80)],
    });
    await repository.saveCampaignState({
      notifications: [],
      activeCampaignId: "campaign_default",
      campaigns: [
        {
          ...createAdoptedCampaign(seed),
          sourceTargetIds: [],
          jobIds: [],
        },
      ],
    });

    const state = await ensureCampaignState({
      repository,
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T10:00:00.000Z",
    });

    const campaign = state.campaigns.find(
      (candidate) => candidate.id === state.activeCampaignId,
    );
    expect(campaign?.jobIds).toEqual(["job_a", "job_b"]);
    expect(campaign?.sourceTargetIds).toEqual(
      seed.searchPreferences.discovery.targets
        .filter((target) => target.enabled)
        .map((target) => target.id),
    );
    expect(campaign?.history[0]?.summary).toBe(
      "Reconciled retention with the current workspace.",
    );
    // The repair persists, so raw repository reads (apply-prep capacity)
    // see the same coherent retention.
    const persisted = await repository.getCampaignState();
    expect(persisted?.campaigns[0]?.jobIds).toEqual(["job_a", "job_b"]);
  });

  test("is idempotent once the workspace and retention agree", async () => {
    const seed = createSeed();
    const savedJobs = [savedJob("job_a", 90)];
    const repository = createInMemoryJobFinderRepository({
      ...seed,
      savedJobs,
    });
    await repository.saveCampaignState({
      notifications: [],
      activeCampaignId: "campaign_default",
      campaigns: [{ ...createAdoptedCampaign(seed), jobIds: [] }],
    });

    const first = await ensureCampaignState({
      repository,
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T10:00:00.000Z",
    });
    expect(first.campaigns[0]?.jobIds).toEqual(["job_a"]);

    const second = await ensureCampaignState({
      repository,
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T11:00:00.000Z",
    });

    expect(second).toEqual(first);
    expect(second.campaigns[0]?.updatedAt).toBe("2026-08-15T10:00:00.000Z");
    expect(
      second.campaigns[0]?.history.filter(
        (entry) => entry.id === "campaign_history_retention_reconciled",
      ),
    ).toHaveLength(1);
  });

  test("never rewrites explicit retention after a committed discovery run", () => {
    const seed = createSeed();
    const ranAndRetainedZero = {
      ...createAdoptedCampaign(seed),
      jobIds: [],
      history: [
        {
          id: "campaign_history_discovery_run_1",
          campaignId: "campaign_default",
          kind: "discovery_run" as const,
          occurredAt: "2026-08-15T10:00:00.000Z",
          summary: "Discovery completed: 0 jobs found.",
          discoveryRunId: "run_1",
        },
        ...createAdoptedCampaign(seed).history,
      ],
    };

    expect(
      reconcileCampaignState({
        state: {
          notifications: [],
          activeCampaignId: "campaign_default",
          campaigns: [ranAndRetainedZero],
        },
        savedJobs: [savedJob("job_a", 90)],
        searchPreferences: seed.searchPreferences,
        now: "2026-08-15T11:00:00.000Z",
      })?.campaigns[0]?.jobIds,
    ).toEqual([]);
  });

  test("leaves user-created empty campaigns untouched to keep zero-sample funnels honest", () => {
    const seed = createSeed();
    const createdEmpty = {
      ...createAdoptedCampaign(seed),
      jobIds: [],
    };

    expect(
      reconcileCampaignState({
        state: {
          notifications: [],
          activeCampaignId: "campaign_default",
          campaigns: [
            // Same record without the adoption marker: as if created fresh.
            { ...createdEmpty, history: [] },
          ],
        },
        savedJobs: [savedJob("job_a", 90)],
        searchPreferences: seed.searchPreferences,
        now: "2026-08-15T11:00:00.000Z",
      }),
    ).toBeNull();
  });

  test("leaves unselected campaigns untouched", () => {
    const seed = createSeed();
    const other = {
      ...createCampaign({
        id: "campaign_other",
        name: "Other",
        mode: "precision" as const,
        searchPreferences: seed.searchPreferences,
        now: "2026-08-15T09:00:00.000Z",
      }),
      jobIds: [],
    };

    expect(
      reconcileCampaignState({
        state: {
          notifications: [],
          activeCampaignId: "campaign_default",
          campaigns: [other],
        },
        savedJobs: [savedJob("job_a", 90)],
        searchPreferences: seed.searchPreferences,
        now: "2026-08-15T11:00:00.000Z",
      }),
    ).toBeNull();
  });

  test("repairs a selected paused campaign like an active one", () => {
    const seed = createSeed();
    const paused = {
      ...createAdoptedCampaign(seed),
      status: "paused" as const,
      jobIds: [],
    };

    const reconciled = reconcileCampaignState({
      state: {
        notifications: [],
        activeCampaignId: "campaign_default",
        campaigns: [paused],
      },
      savedJobs: [savedJob("job_a", 90)],
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T11:00:00.000Z",
    });

    expect(reconciled?.campaigns[0]?.jobIds).toEqual(["job_a"]);
  });

  test("collapses repeated reconciliations into one newest-first entry", () => {
    const seed = createSeed();
    const adopted = createAdoptedCampaign(seed);
    const withHistory = {
      ...adopted,
      jobIds: [],
      // Stored out of order, exactly as the card showed it.
      history: [
        {
          id: "campaign_history_discovery_run_1",
          campaignId: "campaign_default",
          kind: "updated" as const,
          occurredAt: "2026-08-15T09:30:00.000Z",
          summary: "A search finished.",
          discoveryRunId: "run_1",
        },
        {
          id: "campaign_history_retention_reconciled",
          campaignId: "campaign_default",
          kind: "updated" as const,
          occurredAt: "2026-08-15T10:12:00.000Z",
          summary: "Reconciled retention with the current workspace.",
          discoveryRunId: null,
        },
        ...adopted.history,
      ],
    };

    const reconciled = reconcileCampaignState({
      state: {
        notifications: [],
        activeCampaignId: "campaign_default",
        campaigns: [withHistory],
      },
      savedJobs: [savedJob("job_a", 90)],
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T10:13:00.000Z",
    });

    const history = reconciled?.campaigns[0]?.history ?? [];
    expect(
      history.filter(
        (entry) => entry.id === "campaign_history_retention_reconciled",
      ),
    ).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: "campaign_history_retention_reconciled",
      occurredAt: "2026-08-15T10:13:00.000Z",
    });
    expect(history.map((entry) => entry.occurredAt)).toEqual([
      "2026-08-15T10:13:00.000Z",
      "2026-08-15T09:30:00.000Z",
      "2026-08-15T09:00:00.000Z",
    ]);
  });

  test("repairs drifted targeting toward workspace sources", () => {
    const seed = createSeed();
    const driftedPreferences = {
      ...seed.searchPreferences,
      discovery: {
        ...seed.searchPreferences.discovery,
        targets: seed.searchPreferences.discovery.targets.map((target) => ({
          ...target,
          enabled: false,
        })),
      },
    };
    const repaired = reconcileCampaignState({
      state: {
        notifications: [],
        activeCampaignId: "campaign_default",
        campaigns: [
          {
            ...createAdoptedCampaign(seed),
            sourceTargetIds: [],
            searchPreferences: driftedPreferences,
          },
        ],
      },
      savedJobs: [],
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T11:00:00.000Z",
    });

    expect(repaired).not.toBeNull();
    expect(repaired?.campaigns[0]?.searchPreferences).toEqual(
      normalizedPreferences(seed.searchPreferences),
    );
    expect(repaired?.campaigns[0]?.sourceTargetIds).toEqual(
      seed.searchPreferences.discovery.targets
        .filter((target) => target.enabled)
        .map((target) => target.id),
    );
  });

  test("drops retention ids whose jobs no longer exist", () => {
    const seed = createSeed();
    const reconciled = reconcileCampaignState({
      state: {
        notifications: [],
        activeCampaignId: "campaign_default",
        campaigns: [
          {
            ...createAdoptedCampaign(seed),
            jobIds: ["job_removed", "job_kept"],
          },
        ],
      },
      savedJobs: [savedJob("job_kept", 90)],
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T11:00:00.000Z",
    });

    expect(reconciled?.campaigns[0]?.jobIds).toEqual(["job_kept"]);
  });

  test("requires selecting another campaign before archiving the active campaign", async () => {
    const seed = createSeed();
    const repository = createInMemoryJobFinderRepository(seed);
    const methods = createWorkspaceCampaignMethods({
      ctx: {
        repository,
        withCampaignTransition: async <T>(operation: () => Promise<T>) =>
          operation(),
      } as WorkspaceServiceContext,
      getWorkspaceSnapshot: () =>
        Promise.resolve(null as unknown as JobFinderWorkspaceSnapshot),
      runCampaignDiscovery: () =>
        Promise.resolve(null as unknown as JobFinderWorkspaceSnapshot),
      afterCampaignRun: () =>
        Promise.resolve(null as unknown as JobFinderWorkspaceSnapshot),
    });
    const current = createCampaign({
      id: "campaign_current",
      name: "Current plan",
      mode: "precision",
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T09:00:00.000Z",
    });
    const successor = createCampaign({
      id: "campaign_successor",
      name: "Successor plan",
      mode: "scale",
      searchPreferences: {
        ...seed.searchPreferences,
        targetRoles: ["Data platform engineer"],
      },
      now: "2026-08-15T09:05:00.000Z",
    });
    await repository.saveCampaignState({
      notifications: [],
      activeCampaignId: current.id,
      campaigns: [current, successor],
    });

    await expect(
      methods.saveCampaign(
        SaveJobSearchCampaignInputSchema.parse({
          ...current,
          status: "archived",
        }),
      ),
    ).rejects.toThrow(/Select another campaign before archiving/);

    const state = await repository.getCampaignState();
    expect(state?.activeCampaignId).toBe(current.id);
    expect(
      state?.campaigns.find((candidate) => candidate.id === current.id)?.status,
    ).toBe("active");
    expect(await repository.getSearchPreferences()).toEqual(
      normalizedPreferences(seed.searchPreferences),
    );
  });

  test("refuses to archive the only remaining campaign", async () => {
    const seed = createSeed();
    const repository = createInMemoryJobFinderRepository(seed);
    const methods = createWorkspaceCampaignMethods({
      ctx: {
        repository,
        withCampaignTransition: async <T>(operation: () => Promise<T>) =>
          operation(),
      } as WorkspaceServiceContext,
      getWorkspaceSnapshot: () =>
        Promise.resolve(null as unknown as JobFinderWorkspaceSnapshot),
      runCampaignDiscovery: () =>
        Promise.resolve(null as unknown as JobFinderWorkspaceSnapshot),
      afterCampaignRun: () =>
        Promise.resolve(null as unknown as JobFinderWorkspaceSnapshot),
    });
    const only = createCampaign({
      id: "campaign_only",
      name: "Only plan",
      mode: "precision",
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T09:00:00.000Z",
    });
    await repository.saveCampaignState({
      notifications: [],
      activeCampaignId: only.id,
      campaigns: [only],
    });

    await expect(
      methods.saveCampaign(
        SaveJobSearchCampaignInputSchema.parse({
          ...only,
          status: "archived",
        }),
      ),
    ).rejects.toThrow(/Select another campaign before archiving/);

    const state = await repository.getCampaignState();
    expect(state?.activeCampaignId).toBe(only.id);
    expect(state?.campaigns).toHaveLength(1);
    expect(state?.campaigns[0]?.status).toBe("active");
  });
});

describe("campaign create and delete active-pointer semantics", () => {
  function campaignMethodsWith(
    repository: ReturnType<typeof createInMemoryJobFinderRepository>,
  ) {
    return createWorkspaceCampaignMethods({
      ctx: {
        repository,
        withCampaignTransition: <T>(operation: () => Promise<T>) => operation(),
      } as WorkspaceServiceContext,
      getWorkspaceSnapshot: () =>
        Promise.resolve(null as unknown as JobFinderWorkspaceSnapshot),
      runCampaignDiscovery: () =>
        Promise.resolve(null as unknown as JobFinderWorkspaceSnapshot),
      afterCampaignRun: () =>
        Promise.resolve(null as unknown as JobFinderWorkspaceSnapshot),
    });
  }

  function newPlanInput(
    name: string,
    searchPreferences: JobSearchPreferences,
  ): SaveJobSearchCampaignInput {
    return SaveJobSearchCampaignInputSchema.parse({
      id: null,
      name,
      description: "",
      mode: "precision",
      status: "active",
      searchPreferences,
      sourceTargetIds: [],
      minimumFitScore: null,
      limits: {
        retainedJobTarget: 100,
        analysisConcurrency: 4,
        preparationBatchSize: 20,
        dailyPreparationLimit: 50,
      },
      stopRules: {
        pauseOnLoginRequired: true,
        pauseOnChangedForm: true,
        pauseOnUncertainEligibility: true,
        pauseOnFailureRatePercent: 20,
        failureRateMinimumSample: 10,
      },
      applicationPolicy: {
        resumeStrategy: "job_family_variants",
        requireReviewBeforePreparation: false,
        requireReviewBeforeExternalWrite: true,
        finalSubmitAuthorized: false,
        qualityReviewSampleRatio: 0.2,
        simultaneousApplicationWindowDays: 1,
      },
      schedule: {
        mode: "manual",
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
      rules: [],
      latestDigest: null,
    });
  }

  test("creating a campaign keeps a valid active pointer without syncing its preferences", async () => {
    const seed = createSeed();
    const repository = createInMemoryJobFinderRepository(seed);
    const methods = campaignMethodsWith(repository);
    const current = createCampaign({
      id: "campaign_current",
      name: "Current plan",
      mode: "precision",
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T09:00:00.000Z",
    });
    await repository.saveCampaignState({
      notifications: [],
      activeCampaignId: current.id,
      campaigns: [current],
    });

    await methods.saveCampaign(
      newPlanInput("Second plan", {
        ...seed.searchPreferences,
        targetRoles: ["Data platform engineer"],
      }),
    );

    const state = await repository.getCampaignState();
    expect(state?.activeCampaignId).toBe(current.id);
    expect(state?.campaigns.map((candidate) => candidate.name)).toEqual([
      "Current plan",
      "Second plan",
    ]);
    expect(await repository.getSearchPreferences()).toEqual(
      normalizedPreferences(seed.searchPreferences),
    );
  });

  test("creating a campaign adopts the new id when the pointer has no valid active plan", async () => {
    const seed = createSeed();
    const repository = createInMemoryJobFinderRepository(seed);
    const methods = campaignMethodsWith(repository);
    const archived = createCampaign({
      id: "campaign_archived",
      name: "Archived plan",
      mode: "scale",
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T09:00:00.000Z",
    });
    await repository.saveCampaignState({
      notifications: [],
      activeCampaignId: archived.id,
      campaigns: [{ ...archived, status: "archived" }],
    });

    const nextPreferences = {
      ...seed.searchPreferences,
      targetRoles: ["Data platform engineer"],
    };
    await methods.saveCampaign(newPlanInput("Fresh plan", nextPreferences));

    const state = await repository.getCampaignState();
    expect(state?.activeCampaignId).not.toBe(archived.id);
    const fresh = state?.campaigns.find(
      (candidate) => candidate.name === "Fresh plan",
    );
    expect(state?.activeCampaignId).toBe(fresh?.id);
    expect(await repository.getSearchPreferences()).toEqual(
      normalizedPreferences(nextPreferences),
    );
  });

  test("deleting a non-active campaign leaves the active pointer untouched", async () => {
    const seed = createSeed();
    const repository = createInMemoryJobFinderRepository(seed);
    const methods = campaignMethodsWith(repository);
    const active = createCampaign({
      id: "campaign_active",
      name: "Active plan",
      mode: "precision",
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T09:00:00.000Z",
    });
    const other = createCampaign({
      id: "campaign_other",
      name: "Other plan",
      mode: "scale",
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T09:05:00.000Z",
    });
    await repository.saveCampaignState({
      notifications: [],
      activeCampaignId: active.id,
      campaigns: [active, other],
    });

    await expect(
      methods.deleteCampaign({ campaignId: other.id }),
    ).resolves.toBe(true);

    const state = await repository.getCampaignState();
    expect(state?.campaigns.map((candidate) => candidate.id)).toEqual([
      active.id,
    ]);
    expect(state?.activeCampaignId).toBe(active.id);
    expect(await repository.getSearchPreferences()).toEqual(
      normalizedPreferences(seed.searchPreferences),
    );
  });

  test("deleting the active campaign hands the pointer to the first remaining non-archived plan", async () => {
    const seed = createSeed();
    const repository = createInMemoryJobFinderRepository(seed);
    const methods = campaignMethodsWith(repository);
    const active = createCampaign({
      id: "campaign_active",
      name: "Active plan",
      mode: "precision",
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T09:00:00.000Z",
    });
    const archivedFirst = {
      ...createCampaign({
        id: "campaign_archived_first",
        name: "Archived first",
        mode: "scale" as const,
        searchPreferences: seed.searchPreferences,
        now: "2026-08-15T09:01:00.000Z",
      }),
      status: "archived" as const,
    };
    const pausedSuccessor = {
      ...createCampaign({
        id: "campaign_paused_successor",
        name: "Paused successor",
        mode: "scale" as const,
        searchPreferences: {
          ...seed.searchPreferences,
          targetRoles: ["Data platform engineer"],
        },
        now: "2026-08-15T09:02:00.000Z",
      }),
      status: "paused" as const,
    };
    await repository.saveCampaignState({
      notifications: [],
      activeCampaignId: active.id,
      campaigns: [active, archivedFirst, pausedSuccessor],
    });

    await expect(
      methods.deleteCampaign({ campaignId: active.id }),
    ).resolves.toBe(true);

    const state = await repository.getCampaignState();
    expect(state?.campaigns.map((candidate) => candidate.id)).toEqual([
      archivedFirst.id,
      pausedSuccessor.id,
    ]);
    expect(state?.activeCampaignId).toBe(pausedSuccessor.id);
    expect(await repository.getSearchPreferences()).toEqual(
      normalizedPreferences(pausedSuccessor.searchPreferences),
    );
  });

  test("refuses to delete the last remaining campaign and keeps the pointer", async () => {
    const seed = createSeed();
    const repository = createInMemoryJobFinderRepository(seed);
    const methods = campaignMethodsWith(repository);
    const only = createCampaign({
      id: "campaign_only",
      name: "Only plan",
      mode: "precision",
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T09:00:00.000Z",
    });
    await repository.saveCampaignState({
      notifications: [],
      activeCampaignId: only.id,
      campaigns: [only],
    });

    await expect(methods.deleteCampaign({ campaignId: only.id })).resolves.toBe(
      false,
    );

    const state = await repository.getCampaignState();
    expect(state?.campaigns).toHaveLength(1);
    expect(state?.activeCampaignId).toBe(only.id);
    expect(state?.campaigns[0]?.status).toBe("active");
  });

  test("returns false for an unknown campaign id", async () => {
    const seed = createSeed();
    const repository = createInMemoryJobFinderRepository(seed);
    const methods = campaignMethodsWith(repository);
    const only = createCampaign({
      id: "campaign_only",
      name: "Only plan",
      mode: "precision",
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T09:00:00.000Z",
    });
    await repository.saveCampaignState({
      notifications: [],
      activeCampaignId: only.id,
      campaigns: [only],
    });

    await expect(
      methods.deleteCampaign({ campaignId: "campaign_missing" }),
    ).resolves.toBe(false);
    expect((await repository.getCampaignState())?.campaigns).toHaveLength(1);
  });
});

describe("campaign apply-run queue truth", () => {
  function queueRun(
    id: string,
    state: ApplyRunState,
    stalePendingJobs: number,
  ) {
    return ApplyRunSchema.parse({
      id,
      campaignId: "campaign_default",
      state,
      createdAt: "2026-08-15T09:00:00.000Z",
      updatedAt: "2026-08-15T09:30:00.000Z",
      summary: `Apply run ${id}.`,
      detail: "Queue counter fixture.",
      totalJobs: stalePendingJobs,
      pendingJobs: stalePendingJobs,
    });
  }

  function queueResult(
    id: string,
    runId: string,
    jobId: string,
    state:
      | "planned"
      | "question_capture"
      | "filling"
      | "awaiting_review"
      | "submitting"
      | "submitted"
      | "skipped"
      | "blocked"
      | "failed",
  ) {
    return ApplyJobResultSchema.parse({
      id,
      runId,
      jobId,
      queuePosition: 0,
      state,
      summary: `Result ${id}.`,
      detail: "Queue result fixture.",
      startedAt: "2026-08-15T09:10:00.000Z",
      updatedAt: "2026-08-15T09:20:00.000Z",
      completedAt: null,
    });
  }

  function progressFor(input: {
    applyRuns: ReturnType<typeof queueRun>[];
    applyJobResults: ReturnType<typeof queueResult>[];
  }) {
    const seed = createSeed();
    return deriveCampaignProgress({
      campaign: createCampaign({
        id: "campaign_default",
        name: "Default",
        mode: "precision",
        searchPreferences: seed.searchPreferences,
        now: "2026-08-15T09:00:00.000Z",
      }),
      savedJobs: [],
      reviewQueue: [],
      applicationRecords: [],
      applyRuns: input.applyRuns,
      applyJobResults: input.applyJobResults,
      unresolvedActions: 0,
      lastRunAt: null,
      now: "2026-08-15T10:00:00.000Z",
    });
  }

  test("keeps preserved review checkpoints outstanding across terminal runs and excludes resolved outcomes", () => {
    const progress = progressFor({
      applyRuns: [
        queueRun("run_failed", "failed", 50),
        queueRun("run_cancelled", "cancelled", 40),
        queueRun("run_completed", "completed", 30),
      ],
      applyJobResults: [
        // A preserved user-owned review checkpoint outlives its dead run and
        // still waits on a decision, so it stays queued.
        queueResult(
          "res_review_failed",
          "run_failed",
          "job_a",
          "awaiting_review",
        ),
        // Transient work stranded by a terminal run is history, not queue.
        queueResult("res_filling_failed", "run_failed", "job_b", "filling"),
        queueResult(
          "res_planned_cancelled",
          "run_cancelled",
          "job_c",
          "planned",
        ),
        queueResult(
          "res_review_cancelled",
          "run_cancelled",
          "job_d",
          "awaiting_review",
        ),
        // Terminal outcome rows are exits, never outstanding work.
        queueResult(
          "res_submitted_completed",
          "run_completed",
          "job_e",
          "submitted",
        ),
        queueResult(
          "res_skipped_completed",
          "run_completed",
          "job_f",
          "skipped",
        ),
        queueResult("res_failed_completed", "run_completed", "job_g", "failed"),
      ],
    });

    // Only the two awaiting_review checkpoints remain; the runs' stale
    // pendingJobs counters (120 combined) are ignored entirely.
    expect(progress.remainingQueueSize).toBe(2);
  });

  test("gates transient work behind genuinely active runs and dedupes by lineage", () => {
    const progress = progressFor({
      applyRuns: [
        queueRun("run_running", "running", 20),
        queueRun("run_staged", "awaiting_submit_approval", 15),
        queueRun("run_paused_review", "paused_for_user_review", 10),
        queueRun("run_paused_consent", "paused_for_consent", 5),
        queueRun("run_draft", "draft", 8),
      ],
      applyJobResults: [
        queueResult("res_planned_running", "run_running", "job_a", "planned"),
        queueResult(
          "res_capture_running",
          "run_running",
          "job_b",
          "question_capture",
        ),
        queueResult(
          "res_submitting_running",
          "run_running",
          "job_c",
          "submitting",
        ),
        // Blocked needs the user too, but it is surfaced as needs-you action
        // work rather than queued preparation, so it stays excluded here.
        queueResult("res_blocked_running", "run_running", "job_d", "blocked"),
        queueResult("res_planned_staged", "run_staged", "job_e", "planned"),
        queueResult(
          "res_review_paused",
          "run_paused_review",
          "job_f",
          "awaiting_review",
        ),
        queueResult(
          "res_filling_paused_consent",
          "run_paused_consent",
          "job_g",
          "filling",
        ),
        // Draft is a schema default, never genuinely active queue work.
        queueResult("res_planned_draft", "run_draft", "job_h", "planned"),
        // The same run/job lineage counts at most once, even if anomalous
        // duplicate rows ever share it.
        queueResult(
          "res_planned_staged_dupe",
          "run_staged",
          "job_e",
          "planned",
        ),
      ],
    });

    // Three running transients + one staged planned + one paused-review
    // checkpoint + one paused-consent transient = 6.
    expect(progress.remainingQueueSize).toBe(6);
  });
});

describe("dashboard applied-day metrics follow local calendar days", () => {
  /**
   * Built from local-time components so the fixture holds in every timezone
   * without hardcoding an offset; noon anchors stay clear of DST edges. The
   * exact-local-midnight sample is the discriminating case against UTC day
   * bounds in any timezone ahead of UTC.
   */
  function appliedRecord(id: string, appliedAtLocal: string) {
    return ApplicationRecordSchema.parse({
      id,
      jobId: `job_${id}`,
      title: `Engineer ${id}`,
      company: "Example",
      status: "submitted",
      lastActionLabel: "Submitted",
      nextActionLabel: null,
      lastUpdatedAt: appliedAtLocal,
    });
  }

  test("aligns today and the rolling week with local midnight boundaries", () => {
    const seed = createSeed();
    const atLocal = (day: number, hour: number, minute: number) =>
      new Date(2026, 7, day, hour, minute, 0, 0).toISOString();
    const generatedAt = atLocal(15, 12, 0);
    const campaign = createCampaign({
      id: "campaign_default",
      name: "Default",
      mode: "precision",
      searchPreferences: seed.searchPreferences,
      now: generatedAt,
    });

    const summary = deriveDashboardSummary({
      generatedAt,
      campaigns: {
        notifications: [],
        activeCampaignId: campaign.id,
        campaigns: [campaign],
      },
      savedJobs: [],
      reviewQueue: [],
      applicationRecords: [
        appliedRecord("applied_at_local_midnight_today", atLocal(15, 0, 0)),
        appliedRecord("applied_this_morning", atLocal(15, 9, 30)),
        appliedRecord("applied_yesterday_late_evening", atLocal(14, 23, 59)),
        appliedRecord("applied_six_days_ago_noon", atLocal(9, 12, 0)),
        appliedRecord("applied_eight_days_ago_noon", atLocal(7, 12, 0)),
        appliedRecord("applied_tomorrow_morning", atLocal(16, 9, 0)),
      ],
      applyRuns: [],
      userActionRequests: [],
      discovery: seed.discovery,
      searchPreferences: seed.searchPreferences,
    });

    // Local-midnight-inclusive today count; yesterday's 23:59 stays outside.
    expect(summary.applicationsAppliedToday).toBe(2);
    // Existing rolling seven-day window (Aug 9..15 local), re-anchored at
    // local midnight: eight days ago and future entries stay excluded.
    expect(summary.applicationsAppliedThisWeek).toBe(4);
  });
});

describe("ready-for-approval notification resolves once preparation begins", () => {
  function approvalRecord(lastAttemptState: string | null) {
    return ApplicationRecordSchema.parse({
      id: "application_record_approval",
      jobId: "job_approval",
      title: "Engineer job_approval",
      company: "Example",
      status: "approved",
      lastActionLabel: "Resume approved",
      nextActionLabel: null,
      lastUpdatedAt: "2026-08-15T09:45:00.000Z",
      lastAttemptState,
    });
  }

  function summaryFor(
    lastAttemptState: string | null,
    status: "approved" | "ready_for_review" = "approved",
  ) {
    const seed = createSeed();
    const campaign = createCampaign({
      id: "campaign_approval",
      name: "Approval plan",
      mode: "precision",
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T09:00:00.000Z",
    });

    return deriveDashboardSummary({
      generatedAt: "2026-08-15T10:00:00.000Z",
      campaigns: {
        notifications: [],
        activeCampaignId: campaign.id,
        campaigns: [campaign],
      },
      savedJobs: [],
      reviewQueue: [],
      applicationRecords: [{ ...approvalRecord(lastAttemptState), status }],
      applyRuns: [],
      userActionRequests: [],
      discovery: seed.discovery,
      searchPreferences: seed.searchPreferences,
    });
  }

  test("does not mistake resume approval or a ready form for pending approval", () => {
    expect(summaryFor(null).applicationsReadyForApproval).toBe(0);
    expect(summaryFor("not_started").applicationsReadyForApproval).toBe(0);
    expect(summaryFor("ready").applicationsReadyForApproval).toBe(0);
  });

  test("counts a real resume approval request before preparation", () => {
    expect(
      summaryFor(null, "ready_for_review").applicationsReadyForApproval,
    ).toBe(1);
  });

  test("stops counting once the application was prepared", () => {
    // The live walkthrough left Home saying "1 application is ready for your
    // approval" after the resume was approved and the application had already
    // been prepared and paused for the user on the employer page.
    expect(summaryFor("paused").applicationsReadyForApproval).toBe(0);
    expect(summaryFor("in_progress").applicationsReadyForApproval).toBe(0);
    expect(summaryFor("failed").applicationsReadyForApproval).toBe(0);
    expect(summaryFor("submitted").applicationsReadyForApproval).toBe(0);
    expect(summaryFor("unsupported").applicationsReadyForApproval).toBe(0);
  });

  test("drops the recommended approval step once preparation began", () => {
    expect(summaryFor(null).recommendedNextAction.label).not.toBe(
      "Review prepared applications",
    );
    expect(summaryFor("paused").recommendedNextAction.label).not.toBe(
      "Review prepared applications",
    );
  });

  test("keeps a still-preparing record out of the approval count", () => {
    const seed = createSeed();
    const campaign = createCampaign({
      id: "campaign_preparing",
      name: "Preparing plan",
      mode: "precision",
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T09:00:00.000Z",
    });
    const summary = deriveDashboardSummary({
      generatedAt: "2026-08-15T10:00:00.000Z",
      campaigns: {
        notifications: [],
        activeCampaignId: campaign.id,
        campaigns: [campaign],
      },
      savedJobs: [],
      reviewQueue: [],
      applicationRecords: [
        ApplicationRecordSchema.parse({
          id: "application_record_drafting",
          jobId: "job_drafting",
          title: "Engineer job_drafting",
          company: "Example",
          status: "drafting",
          lastActionLabel: "Preparing",
          nextActionLabel: null,
          lastUpdatedAt: "2026-08-15T09:45:00.000Z",
        }),
      ],
      applyRuns: [],
      userActionRequests: [],
      discovery: seed.discovery,
      searchPreferences: seed.searchPreferences,
    });

    expect(summary.applicationsReadyForApproval).toBe(0);
  });
});

describe("a plan card uses the application ledger", () => {
  function record(
    id: string,
    status: ApplicationStatus,
    lastAttemptState: ApplicationRecord["lastAttemptState"] = null,
  ) {
    return ApplicationRecordSchema.parse({
      id,
      jobId: `job_${id}`,
      title: `Engineer ${id}`,
      company: "Example",
      status,
      lastActionLabel: "Staged",
      nextActionLabel: null,
      lastUpdatedAt: "2026-08-15T09:00:00.000Z",
      lastAttemptState,
    });
  }

  test("counts every application record once", () => {
    const seed = createSeed();
    const progress = deriveCampaignProgress({
      campaign: createCampaign({
        id: "campaign_default",
        name: "Default",
        mode: "precision",
        searchPreferences: seed.searchPreferences,
        now: "2026-08-15T09:00:00.000Z",
      }),
      savedJobs: [],
      reviewQueue: [],
      applicationRecords: [
        record("a", "approved", "failed"),
        record("b", "approved", "paused"),
        record("c", "approved"),
        record("d", "ready_for_review"),
        record("e", "approved", "ready"),
      ],
      applyRuns: [],
      applyJobResults: [],
      unresolvedActions: 0,
      lastRunAt: null,
      now: "2026-08-15T10:00:00.000Z",
    });

    expect(progress.applicationsPrepared).toBe(5);
  });
});

test("the first search ignores unrelated live membership and the second keeps the same list", async () => {
  const seed = createSeed();
  const own = savedJob("own", 90, "one-source");
  const unrelated = savedJob("elsewhere", 90, "other-plan");
  const plan = createCampaign({
    id: "one-source",
    name: "One source",
    mode: "precision",
    searchPreferences: seed.searchPreferences,
    now: "2026-10-05T10:00:00.000Z",
  });
  const repository = createInMemoryJobFinderRepository({
    ...seed,
    savedJobs: [own, unrelated],
  });
  const ctx = {
    repository,
    withCampaignTransition: async <T>(operation: () => Promise<T>) =>
      operation(),
  } as WorkspaceServiceContext;
  for (const [index, priorIds] of [[], [own.id]].entries()) {
    await repository.saveCampaignState({
      activeCampaignId: plan.id,
      notifications: [],
      campaigns: [{ ...plan, jobIds: [own.id, unrelated.id] }],
    });
    const run = DiscoveryRunRecordSchema.parse({
      id: `search-${index}`,
      campaignId: plan.id,
      state: "completed",
      runPhase: "complete",
      scope: "run_all",
      startedAt: "2026-10-05T10:00:00.000Z",
      completedAt: "2026-10-05T10:01:00.000Z",
      targetIds: [plan.sourceTargetIds[0]!],
      targetExecutions: [
        {
          targetId: plan.sourceTargetIds[0]!,
          adapterKind: "target_site",
          state: "completed",
          encounteredJobIds: [own.id],
        },
      ],
    });
    await repository.commitDiscoveryStateUpdate(() => ({
      ...seed.discovery,
      recentRuns: [run],
    }));
    await recordCampaignDiscoveryResult({
      ctx,
      campaignId: plan.id,
      beforeCampaignJobIds: priorIds,
      beforeJobProvenanceFingerprints: new Map(),
    });
    expect((await repository.getCampaignState())!.campaigns[0]!.jobIds).toEqual(
      [own.id],
    );
  }
});

test("a one-site plan keeps only its listings when three sites reuse posting numbers", async () => {
  const seed = createSeed();
  const own = {
    ...savedJob("own", 90, "one-source"),
    sourceJobId: "2",
    canonicalUrl: "https://jobs.example.com/first/jobs/2",
  };
  const unrelated = {
    ...savedJob("elsewhere", 90, "other-plan"),
    sourceJobId: "2",
    canonicalUrl: "https://jobs.example.com/second/jobs/2",
  };
  const hidden = {
    ...savedJob("hidden", 90, "other-plan"),
    sourceJobId: "2",
    canonicalUrl: "https://jobs.example.com/third/jobs/2",
    status: "archived" as const,
  };
  const ownHidden = {
    ...hidden,
    id: "own-hidden",
    sourceJobId: "3",
    canonicalUrl: "https://jobs.example.com/first/jobs/3",
  };
  const plan = createCampaign({
    id: "one-source",
    name: "One source",
    mode: "precision",
    searchPreferences: seed.searchPreferences,
    now: "2026-10-05T10:00:00.000Z",
  });
  const repository = createInMemoryJobFinderRepository({
    ...seed,
    savedJobs: [own, unrelated, hidden, ownHidden],
  });
  const ctx = {
    repository,
    withCampaignTransition: async <T>(operation: () => Promise<T>) =>
      operation(),
  } as WorkspaceServiceContext;
  for (const [index, priorIds] of [[], [own.id]].entries()) {
    await repository.saveCampaignState({
      activeCampaignId: plan.id,
      notifications: [],
      campaigns: [
        { ...plan, jobIds: [own.id, unrelated.id, hidden.id, ownHidden.id] },
      ],
    });
    const run = DiscoveryRunRecordSchema.parse({
      id: `search-${index}`,
      campaignId: plan.id,
      state: "completed",
      runPhase: "complete",
      scope: "run_all",
      startedAt: "2026-10-05T10:00:00.000Z",
      completedAt: "2026-10-05T10:01:00.000Z",
      targetIds: [plan.sourceTargetIds[0]!],
      targetExecutions: [
        {
          targetId: plan.sourceTargetIds[0]!,
          adapterKind: "target_site",
          state: "completed",
          encounteredJobIds: [ownHidden.id],
          agentCheckpoint: {
            revision: 1,
            savedAt: "2026-10-05T10:01:00.000Z",
            currentUrl: "https://jobs.example.com/first",
            lastStableUrl: "https://jobs.example.com/first",
            stepCount: 3,
            collectedJobs: [own],
            visitedUrls: [],
            phaseEvidence: {},
          },
        },
      ],
    });
    await repository.commitDiscoveryStateUpdate(() => ({
      ...seed.discovery,
      recentRuns: [run],
    }));
    await recordCampaignDiscoveryResult({
      ctx,
      campaignId: plan.id,
      beforeCampaignJobIds: priorIds,
      beforeJobProvenanceFingerprints: new Map(),
    });
    expect((await repository.getCampaignState())!.campaigns[0]!.jobIds).toEqual(
      [own.id],
    );
  }
});

test.each(["cancelled", "failed"] as const)(
  "%s searches do not turn merely visited addresses into pages covered",
  (state) => {
    const target = createSeed().searchPreferences.discovery.targets[0]!;
    const run = DiscoveryRunRecordSchema.parse({
      id: "interrupted-search",
      state: "running",
      startedAt: "2026-10-06T10:00:00.000Z",
      targetIds: [target.id],
      targetExecutions: [
        {
          targetId: target.id,
          adapterKind: target.adapterKind,
          state: "running",
          agentCheckpoint: {
            revision: 1,
            savedAt: "2026-10-06T10:00:30.000Z",
            currentUrl: target.startingUrl,
            lastStableUrl: target.startingUrl,
            stepCount: 3,
            collectedJobs: [],
            visitedUrls: [
              "about:blank",
              target.startingUrl,
              `${target.startingUrl}/unread`,
            ],
            phaseEvidence: {},
          },
        },
      ],
    });
    const finished = finalizeRunningTargetExecutions(
      run,
      state,
      "2026-10-06T10:01:00.000Z",
    );
    expect(finished.targetExecutions[0]!.pagesCovered).toBeUndefined();
    const measured = finalizeRunningTargetExecutions(
      {
        ...run,
        targetExecutions: run.targetExecutions.map((execution) => ({
          ...execution,
          pagesCovered: 1,
        })),
      },
      state,
      "2026-10-06T10:01:00.000Z",
    );
    expect(measured.targetExecutions[0]!.pagesCovered).toBe(1);
  },
);
