import {
  AbnormalFailurePauseSchema,
  ApplicationConsentRequestSchema,
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  ApplySubmitApprovalSchema,
  JobFinderIntelligenceStateSchema,
  SavedJobSchema,
  type JobSearchCampaignLimits,
} from "@nestor/contracts";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import {
  MAX_BEGUN_EMPLOYER_APPLICATIONS_PER_LOCAL_DAY,
  MAX_EMPLOYER_APPLICATION_JOBS_PER_RUN,
} from "./workspace-service";
import {
  createBrowserRuntime,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

const FIXED_NOW = new Date(2026, 7, 23, 12);

function localTimeIso(dayOffset = 0): string {
  const now = FIXED_NOW;
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayOffset,
    9,
  ).toISOString();
}

const TODAY_AT = localTimeIso();
const YESTERDAY_AT = localTimeIso(-1);
const TODAY_LOCAL_DATE = [
  FIXED_NOW.getFullYear(),
  String(FIXED_NOW.getMonth() + 1).padStart(2, "0"),
  String(FIXED_NOW.getDate()).padStart(2, "0"),
].join("-");

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createCapacitySeed() {
  const seed = createSeed();
  seed.settings = {
    ...seed.settings,
    resumeApplicationMode: "original_resume",
  };
  return seed;
}

function applyRunFixture(input: {
  id: string;
  campaignId: string | null;
  jobIds: string[];
  createdAt?: string;
  state?:
    | "awaiting_submit_approval"
    | "running"
    | "paused_for_consent"
    | "completed"
    | "cancelled"
    | "failed";
  submitApprovalId?: string | null;
  pendingJobs?: number;
}) {
  return ApplyRunSchema.parse({
    id: input.id,
    campaignId: input.campaignId,
    mode: "queue_auto",
    state: input.state ?? "awaiting_submit_approval",
    jobIds: input.jobIds,
    currentJobId: input.jobIds[0] ?? null,
    submitApprovalId: input.submitApprovalId ?? null,
    createdAt: input.createdAt ?? TODAY_AT,
    updatedAt: input.createdAt ?? TODAY_AT,
    completedAt: null,
    summary: "Seeded capacity fixture run.",
    detail: "Seeded apply run used by preparation capacity tests.",
    totalJobs: input.jobIds.length,
    pendingJobs: input.pendingJobs ?? input.jobIds.length,
  });
}

function applyResultFixture(input: {
  id: string;
  runId: string;
  jobId: string;
  state:
    | "planned"
    | "question_capture"
    | "filling"
    | "awaiting_review"
    | "submitted"
    | "skipped"
    | "blocked"
    | "failed";
  createdAt?: string;
  preparationStarted?: boolean;
  applicationRecordId?: string | null;
}) {
  const at = input.createdAt ?? TODAY_AT;
  return ApplyJobResultSchema.parse({
    id: input.id,
    runId: input.runId,
    jobId: input.jobId,
    applicationRecordId: input.applicationRecordId ?? null,
    queuePosition: 0,
    state: input.state,
    summary: "Seeded capacity fixture result.",
    detail: "Seeded apply job result used by preparation capacity tests.",
    startedAt: at,
    updatedAt: at,
    applicationPreparationStartedAt:
      (input.preparationStarted ?? input.state !== "planned") ? at : null,
    applicationPreparationStartedLocalDate: !(
      input.preparationStarted ?? input.state !== "planned"
    )
      ? null
      : [
          new Date(at).getFullYear(),
          String(new Date(at).getMonth() + 1).padStart(2, "0"),
          String(new Date(at).getDate()).padStart(2, "0"),
        ].join("-"),
  });
}

function consentRequestFixture(input: {
  id: string;
  runId: string;
  resultId: string;
  jobId: string;
  applicationRecordId: string;
}) {
  return ApplicationConsentRequestSchema.parse({
    ...input,
    kind: "signup",
    label: "Create an account to continue",
    detail: "Consent is required before the safe queue can continue.",
    status: "pending",
    requestedAt: TODAY_AT,
  });
}

function applicationRecordFixture(input: {
  id: string;
  jobId: string;
  title: string;
}) {
  return ApplicationRecordSchema.parse({
    id: input.id,
    jobId: input.jobId,
    title: input.title,
    company: "Signal Systems",
    status: "ready_for_review",
    lastActionLabel: "Application paused for consent.",
    nextActionLabel: "Resolve the consent request.",
    lastUpdatedAt: TODAY_AT,
  });
}

function applyApprovalFixture(input: {
  id: string;
  runId: string;
  jobIds: string[];
  status?: "pending" | "approved";
}) {
  return ApplySubmitApprovalSchema.parse({
    id: input.id,
    runId: input.runId,
    mode: "queue_auto",
    jobIds: input.jobIds,
    status: input.status ?? "pending",
    createdAt: TODAY_AT,
    approvedAt: input.status === "approved" ? TODAY_AT : null,
    revokedAt: null,
    expiresAt: null,
    detail:
      "Queue-wide submit approval is recorded for this exact run scope only.",
  });
}

async function seedActiveCampaign(
  harness: ReturnType<typeof createWorkspaceServiceHarness>,
  overrides: {
    jobIds?: string[];
    limits?: Partial<JobSearchCampaignLimits>;
  } = {},
): Promise<string> {
  await harness.workspaceService.getWorkspaceSnapshot();
  const state = await harness.repository.getCampaignState();
  if (!state) throw new Error("Expected lazy default campaign state.");
  const active = state.campaigns.find(
    (campaign) => campaign.id === state.activeCampaignId,
  );
  if (!active) throw new Error("Expected an active default campaign.");

  await harness.repository.saveCampaignState({
    ...state,
    campaigns: state.campaigns.map((campaign) =>
      campaign.id === active.id
        ? {
            ...campaign,
            jobIds: overrides.jobIds ?? campaign.jobIds,
            limits: { ...campaign.limits, ...overrides.limits },
            history: campaign.history.filter(
              (entry) => entry.id !== "campaign_history_default_created",
            ),
          }
        : campaign,
    ),
  });
  return active.id;
}

function addClonedJobs(
  seed: ReturnType<typeof createCapacitySeed>,
  count: number,
): string[] {
  const template = seed.savedJobs[0];
  if (!template) throw new Error("Expected a seeded saved job.");
  const ids = Array.from(
    { length: count },
    (_, index) => `job_capacity_${index}`,
  );
  seed.savedJobs = [
    ...seed.savedJobs,
    ...ids.map((id, index) =>
      SavedJobSchema.parse({
        ...structuredClone(template),
        id,
        sourceJobId: `capacity_source_${index}`,
      }),
    ),
  ];
  return ids;
}

function seedBegunPreparations(
  seed: ReturnType<typeof createCapacitySeed>,
  count: number,
): void {
  seed.applyRuns = Array.from({ length: count }, (_, index) =>
    applyRunFixture({
      id: `run_concurrent_capacity_${index}`,
      campaignId: index % 2 === 0 ? null : "campaign_default",
      jobIds: ["job_ready"],
      state: "completed",
    }),
  );
  seed.applyJobResults = seed.applyRuns.map((run, index) =>
    applyResultFixture({
      id: `result_concurrent_capacity_${index}`,
      runId: run.id,
      jobId: "job_ready",
      state: "awaiting_review",
    }),
  );
}

describe("workspace campaign preparation capacity", () => {
  test("uses fixed product safeguards instead of persisted campaign limits", async () => {
    expect(MAX_EMPLOYER_APPLICATION_JOBS_PER_RUN).toBe(10);
    expect(MAX_BEGUN_EMPLOYER_APPLICATIONS_PER_LOCAL_DAY).toBe(20);

    const harness = createWorkspaceServiceHarness({
      seed: createCapacitySeed(),
    });
    await seedActiveCampaign(harness, {
      limits: { preparationBatchSize: 1, dailyPreparationLimit: 1 },
    });

    const snapshot = await harness.workspaceService.startAutoApplyQueueRun([
      "job_ready",
      "job_generating",
    ]);
    expect(
      snapshot.applyRuns.find((run) => run.state === "awaiting_submit_approval")
        ?.jobIds,
    ).toEqual(["job_ready", "job_generating"]);
  });

  test("rejects more than ten unique jobs at staging and approval", async () => {
    const seed = createCapacitySeed();
    const jobIds = addClonedJobs(seed, 11);
    const harness = createWorkspaceServiceHarness({ seed });
    await seedActiveCampaign(harness, { jobIds });

    await expect(
      harness.workspaceService.startAutoApplyQueueRun(jobIds),
    ).rejects.toThrow("limited to 10 unique jobs");

    await harness.repository.upsertApplyRun(
      applyRunFixture({
        id: "run_oversized",
        campaignId: "campaign_default",
        jobIds,
      }),
    );
    await expect(
      harness.workspaceService.approveApplyRun("run_oversized"),
    ).rejects.toThrow("limited to 10 unique jobs");

    const duplicateSnapshot =
      await harness.workspaceService.startAutoApplyQueueRun(
        Array.from({ length: 11 }, () => jobIds[0]!),
      );
    expect(
      duplicateSnapshot.applyRuns.find(
        (run) => run.id !== "run_oversized" && run.jobIds.includes(jobIds[0]!),
      )?.jobIds,
    ).toEqual([jobIds[0]]);
  });

  test("rejects the twenty-first begun preparation globally across campaign and legacy lineages", async () => {
    const seed = createCapacitySeed();
    seed.applyRuns = Array.from(
      { length: MAX_BEGUN_EMPLOYER_APPLICATIONS_PER_LOCAL_DAY },
      (_, index) =>
        applyRunFixture({
          id: `run_consumed_${index}`,
          campaignId:
            index % 3 === 0
              ? null
              : index % 2 === 0
                ? "campaign_other"
                : "campaign_default",
          jobIds: ["job_ready"],
          state: "completed",
        }),
    );
    seed.applyJobResults = seed.applyRuns.map((run, index) =>
      applyResultFixture({
        id: `result_consumed_${index}`,
        runId: run.id,
        jobId: "job_ready",
        state: index % 2 === 0 ? "awaiting_review" : "submitted",
      }),
    );
    const harness = createWorkspaceServiceHarness({ seed });
    await seedActiveCampaign(harness);

    await expect(
      harness.workspaceService.startAutoApplyRun("job_generating"),
    ).rejects.toThrow("up to 20 preparations per day");
  });

  test("refuses every application start while all work is paused and keeps the pause", async () => {
    const harness = createWorkspaceServiceHarness({
      seed: createCapacitySeed(),
    });
    await seedActiveCampaign(harness);
    await harness.workspaceService.setActivityControl({ paused: true });

    await expect(
      harness.workspaceService.startAutoApplyRun("job_generating"),
    ).rejects.toThrow("All work is paused");
    await expect(
      harness.workspaceService.startAutoApplyQueueRun(["job_ready"]),
    ).rejects.toThrow("All work is paused");
    expect((await harness.repository.getActivityControl()).paused).toBe(true);
  });

  test("enforces a configured daily application limit below the default", async () => {
    const seed = createCapacitySeed();
    seed.settings = {
      ...seed.settings,
      maxApplicationsPerLocalDay: 1,
    };
    seedBegunPreparations(seed, 1);
    const harness = createWorkspaceServiceHarness({ seed });
    await seedActiveCampaign(harness);

    await expect(
      harness.workspaceService.startAutoApplyRun("job_generating"),
    ).rejects.toThrow("up to 1 preparation per day");
  });

  test.each([
    "prepare_only",
    "confirm_before_submit",
    "autonomous_submit",
  ] as const)(
    "refuses a %s batch when today's application limit is spent",
    async (applicationAutomationMode) => {
      const seed = createCapacitySeed();
      seed.settings = {
        ...seed.settings,
        maxApplicationsPerLocalDay: 1,
      };
      seedBegunPreparations(seed, 1);
      const harness = createWorkspaceServiceHarness({ seed });
      await seedActiveCampaign(harness);

      await expect(
        harness.workspaceService.startAutoApplyQueueRun(
          ["job_ready"],
          applicationAutomationMode,
        ),
      ).rejects.toThrow("up to 1 preparation per day");
      expect(await harness.repository.listApplyRuns()).toHaveLength(1);
    },
  );

  test("does not count staged or cancelled-before-start work", async () => {
    const seed = createCapacitySeed();
    seed.applyRuns = Array.from({ length: 30 }, (_, index) =>
      applyRunFixture({
        id: `run_unbegun_${index}`,
        campaignId: index % 2 === 0 ? null : "campaign_default",
        jobIds: ["job_ready"],
        state: index % 2 === 0 ? "awaiting_submit_approval" : "cancelled",
      }),
    );
    seed.applyJobResults = seed.applyRuns.map((run, index) =>
      applyResultFixture({
        id: `result_unbegun_${index}`,
        runId: run.id,
        jobId: "job_ready",
        state: "planned",
      }),
    );
    const harness = createWorkspaceServiceHarness({ seed });
    await seedActiveCampaign(harness);

    const snapshot =
      await harness.workspaceService.startAutoApplyRun("job_generating");
    expect(snapshot.applyRuns).toHaveLength(31);
  });

  test("deduplicates exact run/job lineage but counts fresh runs separately", async () => {
    const seed = createCapacitySeed();
    seed.applyRuns = Array.from({ length: 19 }, (_, index) =>
      applyRunFixture({
        id: `run_lineage_${index}`,
        campaignId: index % 2 === 0 ? null : "campaign_default",
        jobIds: ["job_ready"],
        state: "completed",
      }),
    );
    seed.applyJobResults = [
      ...seed.applyRuns.flatMap((run, index) => [
        applyResultFixture({
          id: `result_lineage_${index}_first`,
          runId: run.id,
          jobId: "job_ready",
          state: "failed",
        }),
        applyResultFixture({
          id: `result_lineage_${index}_retry_duplicate`,
          runId: run.id,
          jobId: "job_ready",
          state: "filling",
        }),
      ]),
      applyResultFixture({
        id: "result_planned_same_run",
        runId: "run_lineage_0",
        jobId: "job_generating",
        state: "planned",
      }),
    ];
    const harness = createWorkspaceServiceHarness({ seed });
    await seedActiveCampaign(harness);

    const twentieth =
      await harness.workspaceService.startAutoApplyRun("job_generating");
    expect(
      twentieth.applyRuns.some(
        (run) =>
          run.mode === "single_job_auto" && run.jobIds[0] === "job_generating",
      ),
    ).toBe(true);

    const twentiethRun = twentieth.applyRuns.find(
      (run) =>
        run.mode === "single_job_auto" && run.jobIds[0] === "job_generating",
    );
    const twentiethResult = twentieth.applyJobResults.find(
      (result) => result.runId === twentiethRun?.id,
    );
    if (!twentiethResult) throw new Error("Expected staged twentieth result.");
    await harness.repository.markApplicationPreparationStarted({
      resultId: twentiethResult.id,
      runId: twentiethResult.runId,
      jobId: twentiethResult.jobId,
      startedAt: TODAY_AT,
      startedLocalDate: [
        new Date(TODAY_AT).getFullYear(),
        String(new Date(TODAY_AT).getMonth() + 1).padStart(2, "0"),
        String(new Date(TODAY_AT).getDate()).padStart(2, "0"),
      ].join("-"),
    });

    await expect(
      harness.workspaceService.startAutoApplyRun("job_ready"),
    ).rejects.toThrow(/Retries and failed attempts count.*Settings/);
  });

  test("uses the local calendar day and frees capacity from yesterday", async () => {
    const seed = createCapacitySeed();
    seed.applyRuns = Array.from({ length: 20 }, (_, index) =>
      applyRunFixture({
        id: `run_yesterday_${index}`,
        campaignId: null,
        jobIds: ["job_ready"],
        createdAt: YESTERDAY_AT,
        state: "completed",
      }),
    );
    seed.applyJobResults = seed.applyRuns.map((run, index) =>
      applyResultFixture({
        id: `result_yesterday_${index}`,
        runId: run.id,
        jobId: "job_ready",
        state: "submitted",
        createdAt: YESTERDAY_AT,
      }),
    );
    const harness = createWorkspaceServiceHarness({ seed });
    await seedActiveCampaign(harness);

    await expect(
      harness.workspaceService.startAutoApplyRun("job_generating"),
    ).resolves.toBeTruthy();
  });

  test("staged approval rechecks remaining global daily capacity", async () => {
    const seed = createCapacitySeed();
    seed.applyRuns = Array.from({ length: 20 }, (_, index) =>
      applyRunFixture({
        id: `run_before_approval_${index}`,
        campaignId: index % 2 === 0 ? null : "campaign_other",
        jobIds: ["job_ready"],
        state: "completed",
      }),
    );
    seed.applyJobResults = seed.applyRuns.map((run, index) =>
      applyResultFixture({
        id: `result_before_approval_${index}`,
        runId: run.id,
        jobId: "job_ready",
        state: "awaiting_review",
      }),
    );
    seed.applyRuns.push(
      applyRunFixture({
        id: "run_staged_recheck",
        campaignId: "campaign_default",
        jobIds: ["job_generating"],
        submitApprovalId: "approval_staged_recheck",
      }),
    );
    seed.applyJobResults.push(
      applyResultFixture({
        id: "result_staged_recheck",
        runId: "run_staged_recheck",
        jobId: "job_generating",
        state: "planned",
      }),
    );
    seed.applySubmitApprovals = [
      applyApprovalFixture({
        id: "approval_staged_recheck",
        runId: "run_staged_recheck",
        jobIds: ["job_generating"],
      }),
    ];
    const harness = createWorkspaceServiceHarness({ seed });
    await seedActiveCampaign(harness);

    await expect(
      harness.workspaceService.approveApplyRun("run_staged_recheck"),
    ).rejects.toThrow(/Retries and failed attempts count.*Settings/);
    const approvals = await harness.repository.listApplySubmitApprovals();
    expect(approvals[0]?.status).toBe("pending");
  });

  test.each(["approve", "decline"] as const)(
    "rejects consent %s at full capacity before persistence or relaunch",
    async (action) => {
      const seed = createCapacitySeed();
      seedBegunPreparations(seed, 19);
      seed.applyRuns.push(
        applyRunFixture({
          id: "run_consent_at_capacity",
          campaignId: "campaign_default",
          jobIds: ["job_ready", "job_generating"],
          state: "paused_for_consent",
          submitApprovalId: "approval_consent_at_capacity",
          pendingJobs: 2,
        }),
      );
      seed.applyJobResults.push(
        applyResultFixture({
          id: "result_consent_marked",
          runId: "run_consent_at_capacity",
          jobId: "job_ready",
          state: "blocked",
          preparationStarted: true,
          applicationRecordId: "application_job_ready",
        }),
        applyResultFixture({
          id: "result_consent_unmarked",
          runId: "run_consent_at_capacity",
          jobId: "job_generating",
          state: "planned",
        }),
      );
      seed.applicationConsentRequests = [
        consentRequestFixture({
          id: "consent_at_capacity",
          runId: "run_consent_at_capacity",
          resultId: "result_consent_marked",
          jobId: "job_ready",
          applicationRecordId: "application_job_ready",
        }),
      ];
      seed.applicationRecords = [
        applicationRecordFixture({
          id: "application_job_ready",
          jobId: "job_ready",
          title: "Senior Product Designer",
        }),
      ];
      const baseRuntime = createBrowserRuntime();
      const executeApplicationFlow = vi.fn(
        (...args: Parameters<typeof baseRuntime.executeApplicationFlow>) =>
          baseRuntime.executeApplicationFlow(...args),
      );
      const harness = createWorkspaceServiceHarness({
        seed,
        browserRuntime: { ...baseRuntime, executeApplicationFlow },
      });
      await seedActiveCampaign(harness);

      await expect(
        harness.workspaceService.resolveApplyConsentRequest(
          "consent_at_capacity",
          action,
        ),
      ).rejects.toThrow(/Retries and failed attempts count.*Settings/);

      expect(executeApplicationFlow).not.toHaveBeenCalled();
      expect(
        (await harness.repository.listApplicationConsentRequests())[0],
      ).toMatchObject({ status: "pending", decidedAt: null });
      expect(
        (await harness.repository.listApplyJobResults()).find(
          (result) => result.id === "result_consent_unmarked",
        ),
      ).toMatchObject({
        state: "planned",
        applicationPreparationStartedAt: null,
        applicationPreparationStartedLocalDate: null,
      });
    },
  );

  test("lets consent approval continue one newly unmarked job at nineteen used slots", async () => {
    const seed = createCapacitySeed();
    seedBegunPreparations(seed, 18);
    seed.applyRuns.push(
      applyRunFixture({
        id: "run_consent_twentieth",
        campaignId: "campaign_default",
        jobIds: ["job_ready", "job_generating"],
        state: "paused_for_consent",
        pendingJobs: 2,
        submitApprovalId: "approval_consent_twentieth",
      }),
    );
    seed.applyJobResults.push(
      applyResultFixture({
        id: "result_consent_nineteenth",
        runId: "run_consent_twentieth",
        jobId: "job_ready",
        state: "blocked",
        preparationStarted: true,
        applicationRecordId: "application_job_ready",
      }),
      applyResultFixture({
        id: "result_consent_twentieth",
        runId: "run_consent_twentieth",
        jobId: "job_generating",
        state: "planned",
        applicationRecordId: "application_job_generating",
      }),
    );
    seed.applicationConsentRequests = [
      consentRequestFixture({
        id: "consent_twentieth",
        runId: "run_consent_twentieth",
        resultId: "result_consent_nineteenth",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
      }),
    ];
    seed.applySubmitApprovals = [
      applyApprovalFixture({
        id: "approval_consent_twentieth",
        runId: "run_consent_twentieth",
        jobIds: ["job_ready", "job_generating"],
        status: "approved",
      }),
    ];
    seed.applicationRecords = [
      applicationRecordFixture({
        id: "application_job_ready",
        jobId: "job_ready",
        title: "Senior Product Designer",
      }),
      applicationRecordFixture({
        id: "application_job_generating",
        jobId: "job_generating",
        title: "Product Designer",
      }),
    ];
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      (...args: Parameters<typeof baseRuntime.executeApplicationFlow>) =>
        baseRuntime.executeApplicationFlow(...args),
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });
    await seedActiveCampaign(harness);

    const snapshot = await harness.workspaceService.resolveApplyConsentRequest(
      "consent_twentieth",
      "approve",
    );

    expect(executeApplicationFlow).toHaveBeenCalledTimes(1);
    const twentiethResult = snapshot.applyJobResults.find(
      (result) => result.id === "result_consent_twentieth",
    );
    expect(twentiethResult?.applicationPreparationStartedAt).toBeTruthy();
    expect(twentiethResult?.applicationPreparationStartedLocalDate).toBe(
      TODAY_LOCAL_DATE,
    );
    expect(
      snapshot.dashboard.globalDailyApplicationPreparationCapacity,
    ).toMatchObject({ used: 20, remaining: 0 });
  });

  test("serializes a parked legacy start against staged approval across campaigns", async () => {
    const seed = createCapacitySeed();
    seedBegunPreparations(seed, 19);
    seed.applyRuns.push(
      applyRunFixture({
        id: "run_cross_campaign_race",
        campaignId: "campaign_other",
        jobIds: ["job_generating"],
        submitApprovalId: "approval_cross_campaign_race",
      }),
    );
    seed.applyJobResults.push(
      applyResultFixture({
        id: "result_cross_campaign_race",
        runId: "run_cross_campaign_race",
        jobId: "job_generating",
        state: "planned",
      }),
    );
    seed.applySubmitApprovals = [
      applyApprovalFixture({
        id: "approval_cross_campaign_race",
        runId: "run_cross_campaign_race",
        jobIds: ["job_generating"],
      }),
    ];

    const browserGate = createDeferred<void>();
    const baseRuntime = createBrowserRuntime();
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      executeApplicationFlow: async (source, input, options) => {
        await browserGate.promise;
        return baseRuntime.executeApplicationFlow(source, input, options);
      },
    };
    const harness = createWorkspaceServiceHarness({ seed, browserRuntime });
    const defaultCampaignId = await seedActiveCampaign(harness);
    const state = await harness.repository.getCampaignState();
    const defaultCampaign = state?.campaigns.find(
      (campaign) => campaign.id === defaultCampaignId,
    );
    if (!state || !defaultCampaign)
      throw new Error("Expected default campaign.");
    await harness.repository.saveCampaignState({
      ...state,
      campaigns: [
        defaultCampaign,
        {
          ...defaultCampaign,
          id: "campaign_other",
          name: "Other campaign",
          jobIds: ["job_generating"],
        },
      ],
    });

    const legacyStart = harness.workspaceService.approveApply("job_ready");
    await vi.waitFor(async () => {
      const runs = await harness.repository.listApplyRuns();
      expect(
        runs.some(
          (run) =>
            run.mode === "copilot" &&
            run.state === "running" &&
            run.jobIds[0] === "job_ready",
        ),
      ).toBe(true);
      const result = (await harness.repository.listApplyJobResults()).find(
        (candidate) =>
          candidate.runId ===
          runs.find(
            (run) => run.mode === "copilot" && run.jobIds[0] === "job_ready",
          )?.id,
      );
      expect(result?.applicationPreparationStartedAt).toBeTruthy();
      expect(result?.applicationPreparationStartedLocalDate).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    });

    const stagedApproval = harness.workspaceService.approveApplyRun(
      "run_cross_campaign_race",
    );
    const concurrentOutcomes = Promise.allSettled([
      legacyStart,
      stagedApproval,
    ]);
    await expect(stagedApproval).rejects.toThrow(
      "up to 20 preparations per day",
    );
    browserGate.resolve();
    const outcomes = await concurrentOutcomes;
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);

    const approvals = await harness.repository.listApplySubmitApprovals();
    expect(
      approvals.find(
        (approval) => approval.id === "approval_cross_campaign_race",
      )?.status,
    ).toBe("pending");
  });

  test("releases a failed reservation before the next preparation start", async () => {
    const seed = createCapacitySeed();
    seedBegunPreparations(seed, 19);
    const harness = createWorkspaceServiceHarness({ seed });
    await seedActiveCampaign(harness);

    await expect(
      harness.workspaceService.startAutoApplyRun(
        "job_generating",
        "application_missing",
      ),
    ).rejects.toThrow(/application/i);

    await expect(
      harness.workspaceService.approveApply("job_ready"),
    ).resolves.toBeTruthy();
  });

  test("never crosses the browser boundary when the durable mark fails", async () => {
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      (
        ...args: Parameters<
          NonNullable<BrowserSessionRuntime["executeApplicationFlow"]>
        >
      ) => baseRuntime.executeApplicationFlow(...args),
    );
    const harness = createWorkspaceServiceHarness({
      seed: createCapacitySeed(),
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });
    await seedActiveCampaign(harness);
    vi.spyOn(
      harness.repository,
      "markApplicationPreparationStarted",
    ).mockRejectedValueOnce(new Error("mark persistence failed"));

    await expect(
      harness.workspaceService.approveApply("job_ready"),
    ).rejects.toThrow("mark persistence failed");
    expect(executeApplicationFlow).not.toHaveBeenCalled();
    const result = (await harness.repository.listApplyJobResults()).find(
      (candidate) => candidate.jobId === "job_ready",
    );
    expect(result?.applicationPreparationStartedAt).toBeNull();
    expect(result?.applicationPreparationStartedLocalDate).toBeNull();
  });

  test("keeps one exact daily charge when the browser rejects after the durable mark", async () => {
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(() =>
      Promise.reject(new Error("browser launch rejected")),
    );
    const harness = createWorkspaceServiceHarness({
      seed: createCapacitySeed(),
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });
    await seedActiveCampaign(harness);

    await expect(
      harness.workspaceService.approveApply("job_ready"),
    ).rejects.toThrow("browser launch rejected");

    const result = (await harness.repository.listApplyJobResults()).find(
      (candidate) => candidate.jobId === "job_ready",
    );
    expect(result?.applicationPreparationStartedAt).toBeTruthy();
    expect(result?.applicationPreparationStartedLocalDate).toBe(
      TODAY_LOCAL_DATE,
    );
    const snapshot = await harness.workspaceService.getWorkspaceSnapshot();
    expect(
      snapshot.dashboard.globalDailyApplicationPreparationCapacity,
    ).toMatchObject({ used: 1, remaining: 19 });
  });

  test("allows at most twenty concurrent durable browser launches", async () => {
    const seed = createCapacitySeed();
    const jobIds = addClonedJobs(seed, 21);
    const browserGate = createDeferred<void>();
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      async (
        ...args: Parameters<
          NonNullable<BrowserSessionRuntime["executeApplicationFlow"]>
        >
      ) => {
        await browserGate.promise;
        return baseRuntime.executeApplicationFlow(...args);
      },
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });
    await seedActiveCampaign(harness, { jobIds });

    const launches = jobIds.map((jobId) =>
      harness.workspaceService.approveApply(jobId),
    );
    const outcomesPromise = Promise.allSettled(launches);
    await vi.waitFor(() =>
      expect(executeApplicationFlow).toHaveBeenCalledTimes(20),
    );
    browserGate.resolve();
    const outcomes = await outcomesPromise;

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(20);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    expect(executeApplicationFlow).toHaveBeenCalledTimes(20);
  });

  test("preserves campaign membership and captured-run lineage", async () => {
    const harness = createWorkspaceServiceHarness({
      seed: createCapacitySeed(),
    });
    const capturedCampaignId = await seedActiveCampaign(harness, {
      jobIds: ["job_generating"],
    });

    await expect(
      harness.workspaceService.approveApply("job_ready"),
    ).rejects.toThrow("not retained in the active campaign");

    const staged =
      await harness.workspaceService.startAutoApplyRun("job_generating");
    const run = staged.applyRuns.find((candidate) =>
      candidate.jobIds.includes("job_generating"),
    );
    if (!run) throw new Error("Expected staged run.");
    expect(run.campaignId).toBe(capturedCampaignId);

    const state = await harness.repository.getCampaignState();
    const captured = state?.campaigns.find(
      (campaign) => campaign.id === capturedCampaignId,
    );
    if (!state || !captured) throw new Error("Expected captured campaign.");
    await harness.repository.saveCampaignState({
      ...state,
      activeCampaignId: "campaign_switched_to",
      campaigns: [
        captured,
        { ...captured, id: "campaign_switched_to", name: "Switched campaign" },
      ],
    });

    await expect(
      harness.workspaceService.approveApplyRun(run.id),
    ).resolves.toBeTruthy();
  });

  test("unknown and deleted captured runs are rejected by guarded approval", async () => {
    const harness = createWorkspaceServiceHarness({
      seed: createCapacitySeed(),
    });
    await seedActiveCampaign(harness);

    await expect(
      harness.workspaceService.approveApplyRun("run_missing"),
    ).rejects.toThrow("Unknown apply run 'run_missing'.");

    await harness.repository.upsertApplyRun(
      applyRunFixture({
        id: "run_foreign_scope",
        campaignId: "campaign_deleted",
        jobIds: ["job_ready"],
      }),
    );
    await expect(
      harness.workspaceService.approveApplyRun("run_foreign_scope"),
    ).rejects.toThrow(
      "campaign captured by this apply run is no longer available",
    );
  });

  test("legacy approveApply still enforces safeguards", async () => {
    const seed = createCapacitySeed();
    seed.intelligence = JobFinderIntelligenceStateSchema.parse({
      safeguards: {
        abnormalFailurePauses: [
          AbnormalFailurePauseSchema.parse({
            id: "pause_abnormal_failures",
            windowStartedAt: TODAY_AT,
            failuresInWindow: 5,
            sampleSize: 5,
            failureRatePercent: 100,
            paused: true,
            explanation: "Application preparation kept failing.",
            recoveryGuidance: "Review the failures before continuing.",
          }),
        ],
      },
    });
    const harness = createWorkspaceServiceHarness({ seed });
    await seedActiveCampaign(harness);

    await expect(
      harness.workspaceService.approveApply("job_ready"),
    ).rejects.toThrow(/Open Safeguards to resolve, dismiss, or retry/);
  });

  test("guarded legacy and queued paths retain prepare-only authority", async () => {
    const baseRuntime = createBrowserRuntime();
    const executionInputs: Parameters<
      BrowserSessionRuntime["executeApplicationFlow"]
    >[1][] = [];
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      executeApplicationFlow: (source, input, options) => {
        executionInputs.push(input);
        return baseRuntime.executeApplicationFlow(source, input, options);
      },
    };
    const harness = createWorkspaceServiceHarness({
      seed: createCapacitySeed(),
      browserRuntime,
    });
    await seedActiveCampaign(harness);

    await harness.workspaceService.approveApply("job_ready");
    expect(executionInputs.length).toBeGreaterThan(0);
    for (const input of executionInputs) {
      expect(input.mode).toBe("prepare_only");
      expect(input.submitAuthorized).toBe(false);
      expect(input.accountCreationAuthorized).toBe(false);
    }
  });

  // R2: "Prepare remaining jobs" did nothing, three times, because the batch
  // charged today's quota twice — once for its own reservation and again for
  // every job it began — so the daily safeguard refused it before the first
  // job opened, and the staged run was left parked in its paused state.
  test("a batch that reuses an existing approval charges today's limit once and begins every job", async () => {
    const seed = createCapacitySeed();
    seedBegunPreparations(seed, 18);
    seed.applyRuns.push(
      applyRunFixture({
        id: "run_first_batch",
        campaignId: "campaign_default",
        jobIds: ["job_ready", "job_generating"],
        state: "paused_for_consent",
        pendingJobs: 2,
        submitApprovalId: "approval_first_batch",
      }),
    );
    seed.applySubmitApprovals = [
      ApplySubmitApprovalSchema.parse({
        ...applyApprovalFixture({
          id: "approval_first_batch",
          runId: "run_first_batch",
          jobIds: ["job_ready", "job_generating"],
          status: "approved",
        }),
        batchId: "apply_batch_first",
        batchCampaignId: "campaign_default",
      }),
    ];
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      (...args: Parameters<typeof baseRuntime.executeApplicationFlow>) =>
        baseRuntime.executeApplicationFlow(...args),
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });
    await seedActiveCampaign(harness);

    const snapshot = await harness.workspaceService.startAutoApplyQueueRun([
      "job_ready",
      "job_generating",
    ]);

    expect(executeApplicationFlow).toHaveBeenCalledTimes(2);
    expect(
      snapshot.applyJobResults.filter(
        (result) => result.applicationPreparationStartedAt !== null,
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("a retry preserves the original approval deadline and asks again after it", async () => {
    const seed = createCapacitySeed();
    const originalApprovedAt = new Date(
      FIXED_NOW.getTime() - 23 * 60 * 60 * 1_000,
    ).toISOString();
    const originalExpiresAt = new Date(
      FIXED_NOW.getTime() + 60 * 60 * 1_000,
    ).toISOString();
    seed.applyRuns.push(
      applyRunFixture({
        id: "run_original_deadline",
        campaignId: "campaign_default",
        jobIds: ["job_ready"],
        state: "paused_for_consent",
        submitApprovalId: "approval_original_deadline",
      }),
    );
    seed.applySubmitApprovals = [
      ApplySubmitApprovalSchema.parse({
        ...applyApprovalFixture({
          id: "approval_original_deadline",
          runId: "run_original_deadline",
          jobIds: ["job_ready"],
          status: "approved",
        }),
        approvedAt: originalApprovedAt,
        expiresAt: originalExpiresAt,
        batchId: "apply_batch_deadline",
        batchCampaignId: "campaign_default",
      }),
    ];
    const harness = createWorkspaceServiceHarness({ seed });
    await seedActiveCampaign(harness);

    await harness.workspaceService.startAutoApplyQueueRun(["job_ready"]);
    const inherited = (
      await harness.repository.listApplySubmitApprovals()
    ).find(
      (candidate) =>
        candidate.reusedFromApprovalId === "approval_original_deadline",
    );
    expect(inherited).toMatchObject({
      status: "approved",
      approvedAt: originalApprovedAt,
      expiresAt: originalExpiresAt,
    });

    try {
      vi.setSystemTime(new Date(Date.parse(originalExpiresAt) + 1));
      await harness.workspaceService.startAutoApplyQueueRun(["job_ready"]);
      const newest = [
        ...(await harness.repository.listApplySubmitApprovals()),
      ].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      expect(newest).toMatchObject({
        status: "pending",
        approvedAt: null,
        reusedFromApprovalId: null,
      });
    } finally {
      vi.setSystemTime(FIXED_NOW);
    }
  });

  // The same staged run must never be left parked when the start is refused:
  // the paused task card would keep offering the button and every press would
  // leave one more paused run behind, with nothing saying why.
  test("a batch that cannot start closes with a plain sentence instead of staying paused", async () => {
    const seed = createCapacitySeed();
    seed.applyRuns.push(
      applyRunFixture({
        id: "run_first_batch",
        campaignId: "campaign_default",
        jobIds: ["job_ready"],
        state: "paused_for_consent",
        pendingJobs: 1,
        submitApprovalId: "approval_first_batch",
      }),
    );
    seed.applySubmitApprovals = [
      ApplySubmitApprovalSchema.parse({
        ...applyApprovalFixture({
          id: "approval_first_batch",
          runId: "run_first_batch",
          jobIds: ["job_ready"],
          status: "approved",
        }),
        batchId: "apply_batch_first",
        batchCampaignId: "campaign_default",
      }),
    ];
    const baseRuntime = createBrowserRuntime();
    const browserRuntime: BrowserSessionRuntime = { ...baseRuntime };
    delete (browserRuntime as { executeApplicationFlow?: unknown })
      .executeApplicationFlow;
    const harness = createWorkspaceServiceHarness({ seed, browserRuntime });
    await seedActiveCampaign(harness);

    await expect(
      harness.workspaceService.startAutoApplyQueueRun(["job_ready"]),
    ).rejects.toThrow();

    const runs = await harness.repository.listApplyRuns();
    const staged = runs.find((run) => run.id !== "run_first_batch");
    expect(staged?.state).toBe("failed");
    expect(staged?.summary).toBe(
      "Job Finder could not start preparing these jobs, so nothing was opened or filled. Try again, and if it keeps happening prepare one job at a time.",
    );
    expect(
      runs.filter((run) => run.state === "paused_for_user_review"),
    ).toEqual([]);
  });
});
