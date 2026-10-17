import {
  clearUiResumeBatch,
  blockUiResumeBatch,
  stopUiResumeBatch,
  syncUiResumeBatch,
} from "../../../main/services/assistant/ui-resume-batch";
import type {
  AssistantResumeBatchState,
  ResumeBatchGenerationResult,
  ResumeBatchGenerationProgress,
} from "@nestor/contracts";
import {
  ApplicationCrmBulkStageMutationInputSchema,
  JobFinderIntelligenceStateSchema,
  RESUME_PIPELINE_CAPACITY,
} from "@nestor/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject, SetStateAction } from "react";
import type {
  ActionState,
  JobFinderShellActions,
} from "@renderer/features/job-finder/lib/job-finder-types";
import type { PendingActionState } from "./job-finder-pending-actions";
import { jobFinderPendingActions } from "./job-finder-pending-actions";
import { buildJobFinderPageContext } from "./use-job-finder-page-controller-context";
import type {
  JobFinderSetResumeClaimConfirmationInput,
  JobFinderRendererWorkspaceSnapshot,
  ReviewQueueItem,
} from "@nestor/contracts";
import type { TailoredDraftPreparationViewState } from "@renderer/features/job-finder/screens/review-queue/review-queue-status";
import type { DiscoveryRunFeedback } from "@renderer/features/job-finder/screens/discovery/discovery-run-feedback";
import { buildJobFinderTaskCenterModel } from "@renderer/features/job-finder/components/task-center/job-finder-task-center-model";
import { createJobFinderSaveCoordinator } from "./job-finder-save-state";
import { runJobFinderApplicationBrowserHandoff } from "./job-finder-page-routes";
import { formatJobFinderBrowserHandoffFailedStatus } from "@renderer/features/job-finder/lib/job-finder-browser-handoff-copy";

type BatchGenerate = Window["nestor"]["jobFinder"]["generateResumeForBatch"];
type BatchProgressListener = (progress: ResumeBatchGenerationProgress) => void;
const progressListeners = new Set<BatchProgressListener>();
const unsubscribeProgress = vi.fn();

beforeEach(() => {
  clearUiResumeBatch();
  progressListeners.clear();
  unsubscribeProgress.mockClear();
  vi.stubGlobal("window", {
    nestor: {
      jobFinder: {
        onResumeBatchProgress: (listener: BatchProgressListener) => {
          progressListeners.add(listener);
          return () => {
            progressListeners.delete(listener);
            unsubscribeProgress();
          };
        },
      },
      assistant: {
        syncResumeBatch: (state: AssistantResumeBatchState) =>
          Promise.resolve(syncUiResumeBatch(state)),
      },
    },
  });
});
async function flushBatchDispatch() {
  for (let count = 0; count < 24; count += 1) await Promise.resolve();
}

function createIdleTailoredDraftPreparation(): TailoredDraftPreparationViewState {
  return {
    attemptedCount: 0,
    completedCount: 0,
    currentIndex: null,
    eligibleRemainingCount: 0,
    failedCount: 0,
    status: "idle",
    totalCount: 0,
  };
}

function buildContext(overrides: {
  actions: Partial<JobFinderShellActions>;
  batchGenerate?: BatchGenerate;
  workspace?: JobFinderRendererWorkspaceSnapshot;
  tailoredDraftPreparationRunRef?: MutableRefObject<boolean>;
  tailoredDraftPreparationStopRequestedRef?: MutableRefObject<boolean>;
  tailoredDraftPreparationDisposedRef?: MutableRefObject<boolean>;
  latestWorkspaceRef?: MutableRefObject<JobFinderRendererWorkspaceSnapshot | null>;
}) {
  let actionState: ActionState = { message: null };
  const actionMessages: (string | null)[] = [];
  let pendingActionState: PendingActionState = {};
  let tailoredDraftPreparation = createIdleTailoredDraftPreparation();
  let discoveryRunFeedback: DiscoveryRunFeedback | null = null;
  let tailoredDraftPreparationWriteCount = 0;
  const workspace =
    overrides.workspace ??
    ({
      activeCampaignId: "campaign_active",
    } as JobFinderRendererWorkspaceSnapshot);
  // Existing command stubs represent the service's work. The controller talks
  // only to the new typed receipt bridge and receives no workspace per job.
  const generateResumeForBatch = vi.fn<BatchGenerate>(
    overrides.batchGenerate ??
      (async ({ jobId }) => {
        if (!overrides.actions.generateResume)
          throw new Error("This test must provide a batch generation stub.");
        await overrides.actions.generateResume(jobId);
        return { jobId, outcome: "written" };
      }),
  );
  if (window.nestor.jobFinder)
    window.nestor.jobFinder.generateResumeForBatch = generateResumeForBatch;
  const setActionState = (next: SetStateAction<ActionState>) => {
    actionState = typeof next === "function" ? next(actionState) : next;
    actionMessages.push(actionState.message);
  };
  const setTailoredDraftPreparation = (
    next: SetStateAction<TailoredDraftPreparationViewState>,
  ) => {
    tailoredDraftPreparationWriteCount += 1;
    tailoredDraftPreparation =
      typeof next === "function" ? next(tailoredDraftPreparation) : next;
  };
  const setPendingActionState = (next: SetStateAction<PendingActionState>) => {
    pendingActionState =
      typeof next === "function" ? next(pendingActionState) : next;
  };
  const setDiscoveryRunFeedback = (
    next: SetStateAction<DiscoveryRunFeedback | null>,
  ) => {
    discoveryRunFeedback =
      typeof next === "function" ? next(discoveryRunFeedback) : next;
  };
  const saveCoordinator = createJobFinderSaveCoordinator({
    onStateChange: vi.fn(),
  });
  const context = buildJobFinderPageContext({
    actionState,
    actions: overrides.actions as JobFinderShellActions,
    activeRouteResumeAssistantMessages: [],
    activeRouteResumeAssistantPending: false,
    activeRouteResumeWorkspace: null,
    canImportResume: true,
    confirmLeaveDirtyResumeWorkspace: () => Promise.resolve(true),
    importResumeGuardMessage: null,
    isAnyPendingAction: () => false,
    isPendingAction: () => false,
    isCurrentResumeAssistantRequest: () => false,
    isCurrentResumeWorkspaceJob: () => false,
    liveDiscoveryEvents: [],
    latestWorkspaceRef: overrides.latestWorkspaceRef ?? { current: workspace },
    locationPathname: "/job-finder/home",
    navigate: vi.fn(),
    navigateSafely: vi.fn(),
    profileCopilotBusy: false,
    resumeImportProgress: null,
    profileCopilotPendingContextKey: null,
    profileCopilotRequestTokenRef: { current: 0 },
    requestApplyCopilotVisualCheckpoints: vi.fn(),
    profileSetupState: null,
    saveCoordinator,
    saveState: { state: "idle", version: 0 },
    refreshResumeWorkspace: () => Promise.resolve(false),
    resumeAssistantRequestTokenRef: { current: 0 },
    selectedApplicationAttempt: null,
    selectedApplicationRecord: null,
    selectedDiscoveryJob: null,
    selectedReviewItem: null,
    selectedReviewJob: null,
    selectedTailoredAsset: null,
    setPendingActionState,
    setActionState,
    setDiscoveryRunFeedback,
    setLiveDiscoveryEvents: vi.fn(),
    setOptimisticProfileCopilotMessages: vi.fn(),
    setProfileCopilotBusy: vi.fn(),
    setProfileCopilotPendingContextKey: vi.fn(),
    setProfileSurfaceDirty: vi.fn(),
    setSearchPlanSurfaceDirty: vi.fn(),
    setResumeAssistantMessages: vi.fn(),
    setResumeAssistantPending: vi.fn(),
    setResumeWorkspace: vi.fn(),
    clearResumeWorkspaceState: vi.fn(),
    setResumeWorkspaceDirty: vi.fn(),
    setSelectedApplicationRecordId: vi.fn(),
    setSelectedDiscoveryJobId: vi.fn(),
    setSelectedReviewJobId: vi.fn(),
    setTailoredDraftPreparation,
    sourceDebugRunIdRef: { current: 0 },
    tailoredDraftPreparation,
    tailoredDraftPreparationRunRef:
      overrides.tailoredDraftPreparationRunRef ?? { current: false },
    tailoredDraftPreparationStopRequestedRef:
      overrides.tailoredDraftPreparationStopRequestedRef ?? { current: false },
    tailoredDraftPreparationDisposedRef:
      overrides.tailoredDraftPreparationDisposedRef ?? { current: false },
    workspace,
  } as unknown as Parameters<typeof buildJobFinderPageContext>[0]);

  return {
    context,
    getActionState: () => actionState,
    getActionMessages: () => actionMessages,
    getPendingActionState: () => pendingActionState,
    getDiscoveryRunFeedback: () => discoveryRunFeedback,
    getTailoredDraftPreparation: () => tailoredDraftPreparation,
    getTailoredDraftPreparationWriteCount: () =>
      tailoredDraftPreparationWriteCount,
    generateResumeForBatch,
  };
}

describe("buildJobFinderPageContext campaign schedule and notifications", () => {
  it("exposes onRunCampaignNow through the page controller with a pending scope", async () => {
    const runCampaignNow = vi
      .fn<JobFinderShellActions["runCampaignNow"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const { context, getPendingActionState, getActionState } = buildContext({
      actions: { runCampaignNow },
    });

    const completed = await context.onRunCampaignNow("campaign_b");

    expect(runCampaignNow).toHaveBeenCalledWith("campaign_b");
    expect(completed).toBe(true);
    expect(getPendingActionState()).toEqual({});
    expect(getActionState().message).toMatch(/searches and reads listings/i);
    expect(getActionState().message).toMatch(
      /does not fill application forms/i,
    );
  });

  it("defaults run-now to the active campaign when no id is supplied", async () => {
    const runCampaignNow = vi
      .fn<JobFinderShellActions["runCampaignNow"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const { context } = buildContext({
      actions: { runCampaignNow },
      workspace: {
        activeCampaignId: "campaign_active",
      } as JobFinderRendererWorkspaceSnapshot,
    });

    await context.onRunCampaignNow();

    expect(runCampaignNow).toHaveBeenCalledWith(undefined);
  });

  it("freezes campaign-run feedback from that plan's own completed ledger", async () => {
    const runCampaignNow = vi
      .fn<JobFinderShellActions["runCampaignNow"]>()
      .mockResolvedValue({
        recentDiscoveryRuns: [
          {
            id: "run_campaign_b",
            campaignId: "campaign_b",
            state: "completed",
            startedAt: "2026-09-12T10:00:00.000Z",
            summary: {
              report: {
                measuredAt: "2026-09-12T10:01:00.000Z",
                found: 5,
                new: 0,
                retained: 15,
                duplicates: 5,
                worthOpening: 5,
              },
            },
          },
        ],
      } as unknown as JobFinderRendererWorkspaceSnapshot);
    const { context, getDiscoveryRunFeedback } = buildContext({
      actions: { runCampaignNow },
    });

    await context.onRunCampaignNow("campaign_b");

    expect(getDiscoveryRunFeedback()?.headline).toContain(
      "5 found · 0 new · 15 kept · 5 already here",
    );
  });

  it("keeps the campaign-run scope pending while the action runs", async () => {
    let resolveRun: () => void = () => undefined;
    const runCampaignNow = vi
      .fn<JobFinderShellActions["runCampaignNow"]>()
      .mockImplementation(
        () =>
          new Promise<JobFinderRendererWorkspaceSnapshot>((resolve) => {
            resolveRun = () =>
              resolve({} as JobFinderRendererWorkspaceSnapshot);
          }),
      );
    const { context, getPendingActionState } = buildContext({
      actions: { runCampaignNow },
    });

    const actionPromise = context.onRunCampaignNow("campaign_b");
    expect(getPendingActionState()).toEqual({
      [jobFinderPendingActions.campaignRun("campaign_b")]: 1,
    });

    resolveRun();
    await actionPromise;
    expect(getPendingActionState()).toEqual({});
  });

  it("exposes mark-read and mark-all-read through the page controller", async () => {
    const markCampaignNotificationRead = vi
      .fn<JobFinderShellActions["markCampaignNotificationRead"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const markAllCampaignNotificationsRead = vi
      .fn<JobFinderShellActions["markAllCampaignNotificationsRead"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const { context, getActionState } = buildContext({
      actions: {
        markCampaignNotificationRead,
        markAllCampaignNotificationsRead,
      },
    });
    const pageContext = context;

    pageContext.onMarkCampaignNotificationRead("n_1");
    await vi.waitFor(() => {
      expect(markCampaignNotificationRead).toHaveBeenCalledWith("n_1");
    });

    pageContext.onMarkAllCampaignNotificationsRead();
    await vi.waitFor(() => {
      expect(markAllCampaignNotificationsRead).toHaveBeenCalledTimes(1);
      expect(getActionState().message).toMatch(/marked as read/i);
    });
  });
});

describe("buildJobFinderPageContext outcome recording and suggestions", () => {
  it("records a manual outcome through the shell action with a pending scope", async () => {
    const recordOutcome = vi
      .fn<JobFinderShellActions["recordOutcome"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const { context, getPendingActionState, getActionState } = buildContext({
      actions: { recordOutcome },
    });
    const pageContext = context;

    const completed = await pageContext.onRecordOutcome({
      jobId: "job_1",
      outcome: "interview",
      resumeStrategyId: null,
      note: "Recruiter call went well",
    });

    expect(recordOutcome).toHaveBeenCalledWith({
      jobId: "job_1",
      outcome: "interview",
      resumeStrategyId: null,
      note: "Recruiter call went well",
    });
    expect(completed).toBe(true);
    expect(getPendingActionState()).toEqual({});
    expect(getActionState().message).toMatch(/local tracking/i);
    expect(getActionState().message).not.toMatch(/nothing was submitted/i);
  });

  it("keeps the record-outcome scope pending while the action runs", async () => {
    let resolveRecord: () => void = () => undefined;
    const recordOutcome = vi
      .fn<JobFinderShellActions["recordOutcome"]>()
      .mockImplementation(
        () =>
          new Promise<JobFinderRendererWorkspaceSnapshot>((resolve) => {
            resolveRecord = () =>
              resolve({} as JobFinderRendererWorkspaceSnapshot);
          }),
      );
    const { context, getPendingActionState } = buildContext({
      actions: { recordOutcome },
    });
    const actionPromise = context.onRecordOutcome({
      jobId: "job_1",
      outcome: "applied",
      resumeStrategyId: null,
      note: null,
    });

    expect(getPendingActionState()).toEqual({
      [jobFinderPendingActions.recordOutcome("job_1")]: 1,
    });

    resolveRecord();
    await actionPromise;
    expect(getPendingActionState()).toEqual({});
  });

  it("surfaces a failed outcome record as a thrown error for the form", async () => {
    const recordOutcome = vi
      .fn<JobFinderShellActions["recordOutcome"]>()
      .mockRejectedValue(new Error("That job is no longer available."));
    const { context } = buildContext({ actions: { recordOutcome } });
    const pageContext = context;

    await expect(
      pageContext.onRecordOutcome({
        jobId: "job_1",
        outcome: "offer",
        resumeStrategyId: null,
        note: null,
      }),
    ).rejects.toThrow("That job is no longer available.");
  });

  it("disables a suggestion through the shell action with a pending scope", async () => {
    const setOutcomeSuggestionEnabled = vi
      .fn<JobFinderShellActions["setOutcomeSuggestionEnabled"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const { context, getPendingActionState, getActionState } = buildContext({
      actions: { setOutcomeSuggestionEnabled },
    });
    const pageContext = context;

    const completed = await pageContext.onSetOutcomeSuggestionEnabled({
      dimension: "source",
      key: "example",
      enabled: false,
      reset: false,
    });

    expect(setOutcomeSuggestionEnabled).toHaveBeenCalledWith({
      dimension: "source",
      key: "example",
      enabled: false,
      reset: false,
    });
    expect(completed).toBe(true);
    expect(getPendingActionState()).toEqual({});
    expect(getActionState().message).toMatch(/stays off until you reset it/i);
  });

  it("resets a suggestion with the reset flag and re-evaluation message", async () => {
    const setOutcomeSuggestionEnabled = vi
      .fn<JobFinderShellActions["setOutcomeSuggestionEnabled"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const { context, getActionState } = buildContext({
      actions: { setOutcomeSuggestionEnabled },
    });
    const pageContext = context;

    const completed = await pageContext.onSetOutcomeSuggestionEnabled({
      dimension: "campaign",
      key: "campaign_1",
      enabled: true,
      reset: true,
    });

    expect(setOutcomeSuggestionEnabled).toHaveBeenCalledWith({
      dimension: "campaign",
      key: "campaign_1",
      enabled: true,
      reset: true,
    });
    expect(completed).toBe(true);
    expect(getActionState().message).toMatch(/re-evaluate it/i);
  });
});

function createReviewQueueItem(
  jobId: string,
  overrides: Partial<ReviewQueueItem> = {},
): ReviewQueueItem {
  return {
    jobId,
    title: `Role ${jobId}`,
    company: "Acme",
    location: "Remote",
    matchScore: 80,
    applicationStatus: "shortlisted",
    assetStatus: "not_started",
    progressPercent: null,
    resumeAssetId: null,
    resumeApplicationMode: "tailored_per_job",
    resumeReview: { status: "not_started" },
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  } as ReviewQueueItem;
}

function createBatchWorkspace(
  reviewQueue: readonly ReviewQueueItem[],
): JobFinderRendererWorkspaceSnapshot {
  return {
    activeCampaignId: "campaign_1",
    campaigns: [
      { id: "campaign_1", jobIds: reviewQueue.map((item) => item.jobId) },
    ],
    reviewQueue,
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

function createLargeBatchWorkspace() {
  return createBatchWorkspace(
    Array.from({ length: RESUME_PIPELINE_CAPACITY + 1 }, (_, index) =>
      createReviewQueueItem(`job_${index + 1}`),
    ),
  );
}

function admittedJobIds() {
  return Array.from(
    { length: RESUME_PIPELINE_CAPACITY },
    (_, index) => `job_${index + 1}`,
  );
}

describe("buildJobFinderPageContext tailored draft batch", () => {
  it("stops a UI-started queue through the assistant's main-process stop flag", async () => {
    const resolvers: (() => void)[] = [];
    const generateResume = vi
      .fn<JobFinderShellActions["generateResume"]>()
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            resolvers.push(() =>
              resolve({} as JobFinderRendererWorkspaceSnapshot),
            ),
          ),
      );
    const run = buildContext({
      actions: { generateResume },
      workspace: createLargeBatchWorkspace(),
    });
    run.context.onPrepareTailoredDrafts();
    await vi.waitFor(() =>
      expect(generateResume).toHaveBeenCalledTimes(RESUME_PIPELINE_CAPACITY),
    );
    expect(stopUiResumeBatch()?.activeJobIds).toEqual(admittedJobIds());
    resolvers.forEach((resolve) => resolve());
    await vi.waitFor(() =>
      expect(run.getTailoredDraftPreparation().status).toBe("stopped"),
    );
    expect(generateResume.mock.calls.map(([id]) => id)).toEqual(
      admittedJobIds(),
    );
    expect(run.getTailoredDraftPreparation()).toMatchObject({
      completedCount: RESUME_PIPELINE_CAPACITY,
      failedCount: 0,
    });
  });

  it("limits generation and remaining counts to selected eligible jobs in the original campaign", async () => {
    let finish: (() => void) | undefined;
    const generateResume = vi
      .fn<JobFinderShellActions["generateResume"]>()
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({} as JobFinderRendererWorkspaceSnapshot);
          }),
      );
    const workspace = createBatchWorkspace([
      createReviewQueueItem("one"),
      createReviewQueueItem("two"),
      createReviewQueueItem("ready", { assetStatus: "ready" }),
    ]);
    const latestWorkspaceRef = { current: workspace };
    const { context, getTailoredDraftPreparation } = buildContext({
      actions: { generateResume },
      workspace,
      latestWorkspaceRef,
    });
    context.onPrepareTailoredDrafts([
      "two",
      "two",
      "ready",
      "outside-campaign",
    ]);
    await flushBatchDispatch();
    expect(generateResume.mock.calls).toEqual([["two"]]);
    latestWorkspaceRef.current = {
      ...workspace,
      activeCampaignId: "other",
      campaigns: [
        ...workspace.campaigns,
        { ...workspace.campaigns[0]!, id: "other", jobIds: ["one"] },
      ],
    };
    finish?.();
    await vi.waitFor(() =>
      expect(getTailoredDraftPreparation().status).toBe("completed"),
    );
    expect(getTailoredDraftPreparation()).toMatchObject({
      totalCount: 1,
      completedCount: 1,
      eligibleRemainingCount: 0,
    });
    context.onPrepareTailoredDrafts([]);
    await flushBatchDispatch();
    expect(generateResume).toHaveBeenCalledTimes(1);
  });

  it("runs eligible jobs with bounded parallelism with quiet pending scopes and one final aggregate message", async () => {
    const generateResume = vi
      .fn<JobFinderShellActions["generateResume"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const {
      context,
      getActionMessages,
      getPendingActionState,
      getTailoredDraftPreparation,
    } = buildContext({
      actions: { generateResume },
      workspace: createBatchWorkspace([
        createReviewQueueItem("job_1"),
        createReviewQueueItem("job_2"),
        createReviewQueueItem("job_3"),
      ]),
    });

    context.onPrepareTailoredDrafts();

    await vi.waitFor(() =>
      expect(getTailoredDraftPreparation().status).toBe("completed"),
    );

    expect(generateResume.mock.calls.map(([jobId]) => jobId)).toEqual([
      "job_1",
      "job_2",
      "job_3",
    ]);
    const batchMessages = getActionMessages().filter(
      (message) =>
        message !== null && /^(Wrote|Stopped after) \d+ resume/i.test(message),
    );
    expect(batchMessages).toHaveLength(1);
    expect(getTailoredDraftPreparation()).toMatchObject({
      attemptedCount: 3,
      completedCount: 3,
      failedCount: 0,
      status: "completed",
      totalCount: 3,
    });
    expect(getPendingActionState()).toEqual({});
    expect(batchMessages[0]).not.toMatch(/nothing was sent/i);
  });

  it("keeps per-job pending scopes active without touching review selection", async () => {
    let resolveFirst: (() => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    const generateResume = vi
      .fn<JobFinderShellActions["generateResume"]>()
      .mockImplementation((jobId: string) => {
        if (jobId === "job_1") {
          return new Promise<JobFinderRendererWorkspaceSnapshot>((resolve) => {
            resolveFirst = () =>
              resolve({} as JobFinderRendererWorkspaceSnapshot);
          });
        }
        return new Promise<JobFinderRendererWorkspaceSnapshot>((resolve) => {
          resolveSecond = () =>
            resolve({} as JobFinderRendererWorkspaceSnapshot);
        });
      });
    const {
      context,
      getActionState,
      getPendingActionState,
      getTailoredDraftPreparation,
    } = buildContext({
      actions: { generateResume },
      workspace: createBatchWorkspace([
        createReviewQueueItem("job_1"),
        createReviewQueueItem("job_2"),
      ]),
    });

    context.onPrepareTailoredDrafts();
    await flushBatchDispatch();

    expect(generateResume).toHaveBeenCalledTimes(2);
    expect(getPendingActionState()).toEqual({
      [jobFinderPendingActions.resumeJob("job_1")]: 1,
      [jobFinderPendingActions.resumeJob("job_2")]: 1,
    });
    expect(getActionState().message).toBeNull();

    resolveFirst?.();
    await vi.waitFor(() =>
      expect(getPendingActionState()).toEqual({
        [jobFinderPendingActions.resumeJob("job_2")]: 1,
      }),
    );
    expect(getPendingActionState()).toEqual({
      [jobFinderPendingActions.resumeJob("job_2")]: 1,
    });
    expect(getActionState().message).toBeNull();

    resolveSecond?.();
    await vi.waitFor(() => expect(getPendingActionState()).toEqual({}));
    expect(getTailoredDraftPreparation().status).toBe("completed");
  });

  it("ignores a duplicate start while running, including after a context rebuild with the same controller refs", async () => {
    let resolveFirst: (() => void) | undefined;
    const generateResume = vi
      .fn<JobFinderShellActions["generateResume"]>()
      .mockImplementation((jobId: string) => {
        if (jobId === "job_1") {
          return new Promise<JobFinderRendererWorkspaceSnapshot>((resolve) => {
            resolveFirst = () =>
              resolve({} as JobFinderRendererWorkspaceSnapshot);
          });
        }
        return Promise.resolve({} as JobFinderRendererWorkspaceSnapshot);
      });
    // The page controller owns these refs once and passes the same objects to
    // every context rebuild; a route change reuses them instead of resetting.
    const sharedRunRef = { current: false };
    const sharedStopRef = { current: false };
    const workspace = createBatchWorkspace([
      createReviewQueueItem("job_1"),
      createReviewQueueItem("job_2"),
    ]);
    const first = buildContext({
      actions: { generateResume },
      workspace,
      tailoredDraftPreparationRunRef: sharedRunRef,
      tailoredDraftPreparationStopRequestedRef: sharedStopRef,
    });
    const rebuilt = buildContext({
      actions: { generateResume },
      workspace,
      tailoredDraftPreparationRunRef: sharedRunRef,
      tailoredDraftPreparationStopRequestedRef: sharedStopRef,
    });

    first.context.onPrepareTailoredDrafts();
    await flushBatchDispatch();
    expect(generateResume).toHaveBeenCalledTimes(2);

    first.context.onPrepareTailoredDrafts();
    rebuilt.context.onPrepareTailoredDrafts();
    await flushBatchDispatch();
    expect(generateResume).toHaveBeenCalledTimes(2);

    resolveFirst?.();
    await vi.waitFor(() => expect(sharedRunRef.current).toBe(false));

    expect(generateResume.mock.calls.map(([jobId]) => jobId)).toEqual([
      "job_1",
      "job_2",
    ]);
  });

  it("continues past a failed job and reports it in one aggregate message", async () => {
    const generateResume = vi
      .fn<JobFinderShellActions["generateResume"]>()
      .mockImplementation((jobId: string) =>
        jobId === "job_2"
          ? Promise.reject(new Error("generation failed"))
          : Promise.resolve({} as JobFinderRendererWorkspaceSnapshot),
      );
    const { context, getActionMessages, getTailoredDraftPreparation } =
      buildContext({
        actions: { generateResume },
        workspace: createBatchWorkspace([
          createReviewQueueItem("job_1"),
          createReviewQueueItem("job_2"),
          createReviewQueueItem("job_3"),
        ]),
      });

    context.onPrepareTailoredDrafts();

    await vi.waitFor(() =>
      expect(getTailoredDraftPreparation().status).toBe("failed"),
    );

    expect(generateResume).toHaveBeenCalledTimes(3);
    expect(getTailoredDraftPreparation()).toMatchObject({
      attemptedCount: 3,
      completedCount: 2,
      failedCount: 1,
      totalCount: 3,
    });
    const batchMessage = getActionMessages().find(
      (message) =>
        message !== null && /^(Wrote|Stopped after) \d+ resume/i.test(message),
    );
    expect(batchMessage).toMatch(/Wrote 2 resumes/);
    expect(batchMessage).toMatch(/1 failed/);
    expect(batchMessage).toMatch(/run it again to retry the failed job/i);
  });

  it("finishes admitted resumes after Stop and leaves the next job unstarted", async () => {
    const activeResolvers: (() => void)[] = [];
    const generateResume = vi
      .fn<JobFinderShellActions["generateResume"]>()
      .mockImplementation(() => {
        return new Promise<JobFinderRendererWorkspaceSnapshot>((resolve) => {
          activeResolvers.push(() =>
            resolve({} as JobFinderRendererWorkspaceSnapshot),
          );
        });
      });
    const { context, getActionMessages, getTailoredDraftPreparation } =
      buildContext({
        actions: { generateResume },
        workspace: createLargeBatchWorkspace(),
      });

    context.onPrepareTailoredDrafts();
    await flushBatchDispatch();
    expect(generateResume).toHaveBeenCalledTimes(RESUME_PIPELINE_CAPACITY);

    context.onStopTailoredDraftPreparation();
    activeResolvers.forEach((resolve) => resolve());

    await vi.waitFor(() =>
      expect(getTailoredDraftPreparation().status).toBe("stopped"),
    );

    expect(generateResume).toHaveBeenCalledTimes(RESUME_PIPELINE_CAPACITY);
    expect(getTailoredDraftPreparation()).toMatchObject({
      attemptedCount: RESUME_PIPELINE_CAPACITY,
      completedCount: RESUME_PIPELINE_CAPACITY,
      failedCount: 0,
      status: "stopped",
      totalCount: RESUME_PIPELINE_CAPACITY + 1,
    });
    const batchMessage = getActionMessages().find(
      (message) => message !== null && /stopped after/i.test(message),
    );
    expect(batchMessage).toContain(
      `Stopped after ${RESUME_PIPELINE_CAPACITY} resumes`,
    );
  });

  it("accepts Stop from a remounted controller whose refs are fresh", async () => {
    const activeResolvers: (() => void)[] = [];
    const generateResume = vi
      .fn<JobFinderShellActions["generateResume"]>()
      .mockImplementation(
        () =>
          new Promise<JobFinderRendererWorkspaceSnapshot>((resolve) => {
            activeResolvers.push(() =>
              resolve({} as JobFinderRendererWorkspaceSnapshot),
            );
          }),
      );
    const workspace = createLargeBatchWorkspace();
    const started = buildContext({ actions: { generateResume }, workspace });

    started.context.onPrepareTailoredDrafts();
    await flushBatchDispatch();
    expect(generateResume).toHaveBeenCalledTimes(RESUME_PIPELINE_CAPACITY);

    // A remount builds a controller with its own refs, all back to false. The
    // batch is still running on the module-level guard, so its Stop has to
    // reach it: testers saw preparation advance to "Writing resume 8 of 10"
    // forty-five seconds after pressing Stop.
    const remounted = buildContext({ actions: { generateResume }, workspace });
    remounted.context.onStopTailoredDraftPreparation();
    activeResolvers.forEach((resolve) => resolve());

    await vi.waitFor(() =>
      expect(started.getTailoredDraftPreparation().status).toBe("stopped"),
    );
    expect(generateResume).toHaveBeenCalledTimes(RESUME_PIPELINE_CAPACITY);
  });

  it("keeps the batch alive across route changes: the task center tracks it away from Shortlisted and Stop from any route finishes only the active jobs", async () => {
    const activeResolvers: (() => void)[] = [];
    const generateResume = vi
      .fn<JobFinderShellActions["generateResume"]>()
      .mockImplementation(() => {
        return new Promise<JobFinderRendererWorkspaceSnapshot>((resolve) => {
          activeResolvers.push(() =>
            resolve({} as JobFinderRendererWorkspaceSnapshot),
          );
        });
      });
    // Route changes rebuild the page context but reuse the controller's refs,
    // so the run, its progress state, and cooperative stop survive navigation.
    const sharedRunRef = { current: false };
    const sharedStopRef = { current: false };
    const sharedDisposedRef = { current: false };
    const workspace = createLargeBatchWorkspace();
    const reviewQueueRoute = buildContext({
      actions: { generateResume },
      workspace,
      tailoredDraftPreparationRunRef: sharedRunRef,
      tailoredDraftPreparationStopRequestedRef: sharedStopRef,
      tailoredDraftPreparationDisposedRef: sharedDisposedRef,
    });
    const discoveryRoute = buildContext({
      actions: { generateResume },
      workspace,
      tailoredDraftPreparationRunRef: sharedRunRef,
      tailoredDraftPreparationStopRequestedRef: sharedStopRef,
      tailoredDraftPreparationDisposedRef: sharedDisposedRef,
    });

    reviewQueueRoute.context.onPrepareTailoredDrafts();
    await flushBatchDispatch();
    expect(generateResume).toHaveBeenCalledTimes(RESUME_PIPELINE_CAPACITY);

    // Away from Shortlisted, the task center still reports the active batch
    // and routes its Stop control through the same controller refs.
    const taskModel = buildJobFinderTaskCenterModel({
      isDiscoveryPending: false,
      isResumeImportPending: false,
      tailoredDraftPreparation: reviewQueueRoute.getTailoredDraftPreparation(),
      workspace,
    });
    expect(taskModel.items.map((item) => item.kind)).toEqual([
      "tailored_drafts",
    ]);
    expect(taskModel.items[0]).toMatchObject({
      status: "active",
      countLabel: `0 of ${RESUME_PIPELINE_CAPACITY + 1} prepared`,
      canCancel: true,
      cancelKind: "tailored_drafts",
      resumeRoute: "/job-finder/review-queue",
    });

    discoveryRoute.context.onStopTailoredDraftPreparation();
    activeResolvers.forEach((resolve) => resolve());

    await vi.waitFor(() =>
      expect(reviewQueueRoute.getTailoredDraftPreparation().status).toBe(
        "stopped",
      ),
    );

    // Returning to Shortlisted shows accurate final state; no next item ran.
    expect(generateResume).toHaveBeenCalledTimes(RESUME_PIPELINE_CAPACITY);
    expect(sharedRunRef.current).toBe(false);
    expect(sharedDisposedRef.current).toBe(false);
    expect(reviewQueueRoute.getTailoredDraftPreparation()).toMatchObject({
      attemptedCount: RESUME_PIPELINE_CAPACITY,
      completedCount: RESUME_PIPELINE_CAPACITY,
      currentIndex: null,
      status: "stopped",
      totalCount: RESUME_PIPELINE_CAPACITY + 1,
    });
    const batchMessage = reviewQueueRoute
      .getActionMessages()
      .find((message) => message !== null && /stopped after/i.test(message));
    expect(batchMessage).toContain(
      `Stopped after ${RESUME_PIPELINE_CAPACITY} resumes`,
    );
    const settledTaskModel = buildJobFinderTaskCenterModel({
      isDiscoveryPending: false,
      isResumeImportPending: false,
      tailoredDraftPreparation: reviewQueueRoute.getTailoredDraftPreparation(),
      workspace,
    });
    expect(
      settledTaskModel.items.some((item) => item.kind === "tailored_drafts"),
    ).toBe(false);
  });

  it("reruns only still-eligible jobs from durable workspace state, keeping failed jobs retryable under the cap", async () => {
    const generateResume = vi
      .fn<JobFinderShellActions["generateResume"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const firstRun = buildContext({
      actions: { generateResume },
      workspace: createBatchWorkspace([
        createReviewQueueItem("job_1"),
        createReviewQueueItem("job_2"),
        createReviewQueueItem("job_3"),
      ]),
    });

    firstRun.context.onPrepareTailoredDrafts();
    await vi.waitFor(() =>
      expect(firstRun.getTailoredDraftPreparation().status).toBe("completed"),
    );
    expect(generateResume).toHaveBeenCalledTimes(3);

    // Durable post-batch state: job_1/job_3 have ready artifacts, job_2's
    // generation failed and stays eligible, job_4 was shortlisted afterwards.
    const rerun = buildContext({
      actions: { generateResume },
      workspace: createBatchWorkspace([
        createReviewQueueItem("job_1", { assetStatus: "ready" }),
        createReviewQueueItem("job_2", { assetStatus: "failed" }),
        createReviewQueueItem("job_3", { assetStatus: "ready" }),
        createReviewQueueItem("job_4"),
      ]),
    });

    rerun.context.onPrepareTailoredDrafts();
    await vi.waitFor(() =>
      expect(rerun.getTailoredDraftPreparation().status).toBe("completed"),
    );

    expect(generateResume).toHaveBeenCalledTimes(5);
    expect(generateResume.mock.calls.slice(3).map(([jobId]) => jobId)).toEqual([
      "job_2",
      "job_4",
    ]);
    expect(rerun.getTailoredDraftPreparation()).toMatchObject({
      completedCount: 2,
      failedCount: 0,
      status: "completed",
      totalCount: 2,
    });
  });

  it("queues all missing resumes in one run", async () => {
    const generateResume = vi
      .fn<JobFinderShellActions["generateResume"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const { context, getActionMessages, getTailoredDraftPreparation } =
      buildContext({
        actions: { generateResume },
        workspace: createBatchWorkspace(
          Array.from({ length: 12 }, (_, index) =>
            createReviewQueueItem(`job_${index}`),
          ),
        ),
      });

    context.onPrepareTailoredDrafts();

    await vi.waitFor(() =>
      expect(getTailoredDraftPreparation().status).toBe("completed"),
    );

    expect(generateResume).toHaveBeenCalledTimes(12);
    expect(getTailoredDraftPreparation()).toMatchObject({
      completedCount: 12,
      eligibleRemainingCount: 0,
      totalCount: 12,
    });
    const batchMessage = getActionMessages().find(
      (message) =>
        message !== null && /^(Wrote|Stopped after) \d+ resume/i.test(message),
    );
    expect(batchMessage).toMatch(/Wrote 12 resumes/);
    expect(batchMessage).not.toMatch(/more jobs still need a resume/);
  });

  it("treats a start with no eligible jobs as a deterministic no-op", async () => {
    const generateResume = vi
      .fn<JobFinderShellActions["generateResume"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const { context, getActionMessages, getTailoredDraftPreparation } =
      buildContext({
        actions: { generateResume },
        workspace: createBatchWorkspace([
          createReviewQueueItem("job_ready", { assetStatus: "ready" }),
        ]),
      });

    context.onPrepareTailoredDrafts();
    await flushBatchDispatch();
    context.onStopTailoredDraftPreparation();

    expect(generateResume).not.toHaveBeenCalled();
    expect(getTailoredDraftPreparation().status).toBe("idle");
    expect(getActionMessages().filter((message) => message !== null)).toEqual(
      [],
    );
  });

  it("stops a disposed controller's batch tail after the active items settle without any further writes", async () => {
    const activeResolvers: (() => void)[] = [];
    const generateResume = vi
      .fn<JobFinderShellActions["generateResume"]>()
      .mockImplementation(
        () =>
          new Promise<JobFinderRendererWorkspaceSnapshot>((resolve) => {
            activeResolvers.push(() =>
              resolve({} as JobFinderRendererWorkspaceSnapshot),
            );
          }),
      );

    // Teardown happens while every admitted receipt is still in flight.
    const runRef = { current: false };
    const disposedRef = { current: false };
    const mounted = buildContext({
      actions: { generateResume },
      workspace: createLargeBatchWorkspace(),
      tailoredDraftPreparationRunRef: runRef,
      tailoredDraftPreparationDisposedRef: disposedRef,
    });
    mounted.context.onPrepareTailoredDrafts();
    await flushBatchDispatch();
    expect(generateResume).toHaveBeenCalledTimes(RESUME_PIPELINE_CAPACITY);

    disposedRef.current = true;
    const messagesAtDisposal = mounted.getActionMessages().length;
    const writesAtDisposal = mounted.getTailoredDraftPreparationWriteCount();
    const batchId = mounted.generateResumeForBatch.mock.calls[0]![0].batchId;
    for (const listener of progressListeners)
      listener({ batchId, jobId: "job_1", stage: "processing" });
    expect(mounted.getTailoredDraftPreparationWriteCount()).toBe(
      writesAtDisposal,
    );

    // Admitted jobs settle, then the loop must not schedule the next job, and the
    // orphaned run must stay silent instead of writing into dead state.
    activeResolvers.forEach((resolve) => resolve());
    await vi.waitFor(() => expect(runRef.current).toBe(false));

    expect(generateResume.mock.calls.map(([jobId]) => jobId)).toEqual(
      admittedJobIds(),
    );
    expect(unsubscribeProgress).toHaveBeenCalledOnce();
    expect(progressListeners.size).toBe(0);
    expect(mounted.getActionMessages()).toHaveLength(messagesAtDisposal);
    expect(mounted.getTailoredDraftPreparationWriteCount()).toBe(
      writesAtDisposal,
    );
  });

  it("blocks a replacement-controller start while a disposed run is parked and releases the global guard once it stops", async () => {
    const parked: (() => void)[] = [];
    const resolveParked = () => parked.forEach((resolve) => resolve());
    let hasParkedFirstCall = false;
    const generateResume = vi
      .fn<JobFinderShellActions["generateResume"]>()
      .mockImplementation(() => {
        if (!hasParkedFirstCall) {
          return new Promise<JobFinderRendererWorkspaceSnapshot>((resolve) => {
            parked.push(() => {
              hasParkedFirstCall = true;
              resolve({} as JobFinderRendererWorkspaceSnapshot);
            });
          });
        }
        return Promise.resolve({} as JobFinderRendererWorkspaceSnapshot);
      });

    // The first controller owns the refs while every admitted job is parked.
    const firstRunRef = { current: false };
    const firstStopRef = { current: false };
    const firstDisposedRef = { current: false };
    const mounted = buildContext({
      actions: { generateResume },
      workspace: createLargeBatchWorkspace(),
      tailoredDraftPreparationRunRef: firstRunRef,
      tailoredDraftPreparationStopRequestedRef: firstStopRef,
      tailoredDraftPreparationDisposedRef: firstDisposedRef,
    });
    mounted.context.onPrepareTailoredDrafts();
    await flushBatchDispatch();
    expect(generateResume).toHaveBeenCalledTimes(RESUME_PIPELINE_CAPACITY);
    expect(firstRunRef.current).toBe(true);

    // True teardown disposes the owning controller; a later remount builds a
    // brand-new controller whose refs are fresh and cannot see the parked
    // run, so only the module-scope guard can prevent a second batch here.
    firstDisposedRef.current = true;
    const remountedRunRef = { current: false };
    const remountedStopRef = { current: false };
    const remountedDisposedRef = { current: false };
    const remounted = buildContext({
      actions: { generateResume },
      workspace: createLargeBatchWorkspace(),
      tailoredDraftPreparationRunRef: remountedRunRef,
      tailoredDraftPreparationStopRequestedRef: remountedStopRef,
      tailoredDraftPreparationDisposedRef: remountedDisposedRef,
    });

    remounted.context.onPrepareTailoredDrafts();
    await flushBatchDispatch();
    expect(generateResume).toHaveBeenCalledTimes(RESUME_PIPELINE_CAPACITY);
    expect(remountedRunRef.current).toBe(false);
    expect(remounted.getTailoredDraftPreparation().status).toBe("idle");
    expect(
      remounted.getActionMessages().filter((message) => message !== null),
    ).toEqual([]);

    // Settling all admitted jobs ends the disposed run without starting its tail.
    resolveParked?.();
    await vi.waitFor(() => expect(firstRunRef.current).toBe(false));
    expect(generateResume.mock.calls.map(([jobId]) => jobId)).toEqual(
      admittedJobIds(),
    );

    // Guard released by the stopped orphan: the fresh controller runs again.
    remounted.context.onPrepareTailoredDrafts();
    await flushBatchDispatch();
    expect(remountedRunRef.current).toBe(true);
    await vi.waitFor(() =>
      expect(remounted.getTailoredDraftPreparation().status).toBe("completed"),
    );
    expect(generateResume.mock.calls.map(([jobId]) => jobId)).toEqual([
      ...admittedJobIds(),
      ...createLargeBatchWorkspace().reviewQueue.map((item) => item.jobId),
    ]);
    await vi.waitFor(() => expect(remountedRunRef.current).toBe(false));
  });

  it("recomputes the final eligible remainder from the latest workspace after jobs change while the run is parked", async () => {
    let resolveParked: (() => void) | undefined;
    const generateResume = vi
      .fn<JobFinderShellActions["generateResume"]>()
      .mockImplementation((jobId: string) => {
        if (jobId === "job_1") {
          return new Promise<JobFinderRendererWorkspaceSnapshot>((resolve) => {
            resolveParked = () =>
              resolve({} as JobFinderRendererWorkspaceSnapshot);
          });
        }
        return Promise.resolve({} as JobFinderRendererWorkspaceSnapshot);
      });

    const latestWorkspaceRef: MutableRefObject<JobFinderRendererWorkspaceSnapshot | null> =
      { current: null };
    const startWorkspace = createBatchWorkspace([
      createReviewQueueItem("job_1"),
      createReviewQueueItem("job_2"),
      createReviewQueueItem("job_3"),
    ]);
    latestWorkspaceRef.current = startWorkspace;

    const run = buildContext({
      actions: { generateResume },
      workspace: startWorkspace,
      latestWorkspaceRef,
    });

    run.context.onPrepareTailoredDrafts();
    await flushBatchDispatch();
    expect(run.getTailoredDraftPreparation()).toMatchObject({
      status: "running",
      eligibleRemainingCount: 0,
      totalCount: 3,
    });

    // Operator edits land while the run is parked: job_3 leaves the queue,
    // job_2 is switched to original resume, job_4 is shortlisted. A rerender
    // publishes the newer snapshot through the ref instead of mutating the
    // captured array.
    latestWorkspaceRef.current = createBatchWorkspace([
      createReviewQueueItem("job_1"),
      createReviewQueueItem("job_2", {
        resumeApplicationMode: "original_resume",
      }),
      createReviewQueueItem("job_4"),
    ]);

    resolveParked?.();
    await vi.waitFor(() =>
      expect(run.getTailoredDraftPreparation().status).toBe("completed"),
    );

    expect(generateResume.mock.calls.map(([jobId]) => jobId)).toEqual([
      "job_1",
      "job_2",
      "job_3",
    ]);
    expect(run.getTailoredDraftPreparation()).toMatchObject({
      completedCount: 3,
      eligibleRemainingCount: 1,
      failedCount: 0,
      status: "completed",
      totalCount: 3,
    });
    const batchMessage = run
      .getActionMessages()
      .find(
        (message) =>
          message !== null &&
          /^(Wrote|Stopped after) \d+ resume/i.test(message),
      );
    expect(batchMessage).toMatch(/Wrote 3 resumes/);
    expect(batchMessage).not.toMatch(/more job still needs a resume/);
  });

  it("counts phase events and out-of-order typed receipts without loading a workspace per job", async () => {
    const settle = new Map<
      string,
      (result: ResumeBatchGenerationResult) => void
    >();
    const batchGenerate = vi.fn<BatchGenerate>(
      ({ jobId }) => new Promise((resolve) => settle.set(jobId, resolve)),
    );
    const generateResume = vi.fn<JobFinderShellActions["generateResume"]>();
    const regenerateResumeDraft =
      vi.fn<JobFinderShellActions["regenerateResumeDraft"]>();
    const run = buildContext({
      actions: { generateResume, regenerateResumeDraft },
      batchGenerate,
      workspace: createBatchWorkspace([
        createReviewQueueItem("job_1"),
        createReviewQueueItem("job_2"),
        createReviewQueueItem("job_3"),
      ]),
    });
    run.context.onPrepareTailoredDrafts();
    await flushBatchDispatch();
    expect(batchGenerate).toHaveBeenCalledTimes(3);
    const batchId = batchGenerate.mock.calls[0]![0].batchId;
    const emit = (
      jobId: string,
      stage: ResumeBatchGenerationProgress["stage"],
      id = batchId,
    ) => {
      for (const listener of progressListeners)
        listener({ batchId: id, jobId, stage });
    };
    emit("job_1", "queued");
    emit("job_1", "writing");
    emit("job_2", "writing");
    emit("job_1", "processing");
    emit("job_1", "processing");
    emit("job_3", "queued");
    emit("other", "writing", "another_batch");
    expect(run.getTailoredDraftPreparation()).toMatchObject({
      writingCount: 1,
      processingCount: 1,
      waitingCount: 1,
      completedCount: 0,
      failedCount: 0,
    });
    emit("job_2", "finished");
    settle.get("job_2")!({
      jobId: "job_2",
      outcome: "failed",
      failureMessage: "Synthetic failure",
    });
    await vi.waitFor(() =>
      expect(run.getTailoredDraftPreparation()).toMatchObject({
        writingCount: 0,
        processingCount: 1,
        waitingCount: 1,
        completedCount: 0,
        failedCount: 1,
        status: "running",
      }),
    );
    emit("job_3", "finished");
    settle.get("job_3")!({ jobId: "job_3", outcome: "fallback" });
    await vi.waitFor(() =>
      expect(run.getTailoredDraftPreparation()).toMatchObject({
        completedCount: 1,
        fallbackCount: 1,
        failedCount: 1,
      }),
    );
    emit("job_1", "finished");
    settle.get("job_1")!({ jobId: "job_1", outcome: "written" });
    await vi.waitFor(() =>
      expect(run.getTailoredDraftPreparation()).toMatchObject({
        status: "failed",
        attemptedCount: 3,
        completedCount: 2,
        failedCount: 1,
        fallbackCount: 1,
        eligibleRemainingCount: 1,
      }),
    );
    await flushBatchDispatch();
    expect(generateResume).not.toHaveBeenCalled();
    expect(regenerateResumeDraft).not.toHaveBeenCalled();
    expect(batchGenerate.mock.calls.map(([input]) => input.jobId)).toEqual([
      "job_1",
      "job_2",
      "job_3",
    ]);
    expect(unsubscribeProgress).toHaveBeenCalledOnce();
    expect(progressListeners.size).toBe(0);
    const writes = run.getTailoredDraftPreparationWriteCount();
    emit("job_1", "writing");
    expect(run.getTailoredDraftPreparationWriteCount()).toBe(writes);
  });

  it("does not retry a not-started receipt or admit the batch tail after it stops", async () => {
    const settle = new Map<
      string,
      (result: ResumeBatchGenerationResult) => void
    >();
    const batchGenerate = vi.fn<BatchGenerate>(
      ({ jobId }) => new Promise((resolve) => settle.set(jobId, resolve)),
    );
    const run = buildContext({
      actions: {},
      batchGenerate,
      workspace: createLargeBatchWorkspace(),
    });
    run.context.onPrepareTailoredDrafts();
    await flushBatchDispatch();
    expect(batchGenerate).toHaveBeenCalledTimes(RESUME_PIPELINE_CAPACITY);
    settle.get("job_57")!({ jobId: "job_57", outcome: "not_started" });
    await flushBatchDispatch();
    for (const [jobId, resolve] of settle)
      if (jobId !== "job_57") resolve({ jobId, outcome: "written" });
    await vi.waitFor(() =>
      expect(run.getTailoredDraftPreparation()).toMatchObject({
        status: "stopped",
        attemptedCount: RESUME_PIPELINE_CAPACITY - 1,
        completedCount: RESUME_PIPELINE_CAPACITY - 1,
        failedCount: 0,
        eligibleRemainingCount: 2,
        totalCount: RESUME_PIPELINE_CAPACITY + 1,
      }),
    );
    expect(batchGenerate.mock.calls.map(([input]) => input.jobId)).toEqual(
      admittedJobIds(),
    );
    expect(unsubscribeProgress).toHaveBeenCalledOnce();
  });
});

describe("buildJobFinderPageContext scoped settings saves", () => {
  it("saves application tracker settings through updateTrackerCrm without a whole-settings merge", async () => {
    const snapshot = {} as JobFinderRendererWorkspaceSnapshot;
    const saveSettings = vi.fn<JobFinderShellActions["saveSettings"]>();
    const updateTrackerCrm = vi
      .fn<JobFinderShellActions["updateTrackerCrm"]>()
      .mockResolvedValue(snapshot);
    const { context } = buildContext({
      actions: { saveSettings, updateTrackerCrm },
    });

    const completed = await context.onUpdateTrackerCrm({
      noResponseAutomation: { enabled: true, afterDays: 7 },
      customStages: [],
    });

    expect(completed).toBe(true);
    expect(updateTrackerCrm).toHaveBeenCalledOnce();
    expect(updateTrackerCrm).toHaveBeenCalledWith({
      noResponseAutomation: { enabled: true, afterDays: 7 },
      customStages: [],
    });
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("marks tracker settings saves as failed when the scoped method fails", async () => {
    const failingUpdate = vi
      .fn<JobFinderShellActions["updateTrackerCrm"]>()
      .mockRejectedValue(new Error("commit refused"));
    const { context, getActionState } = buildContext({
      actions: { updateTrackerCrm: failingUpdate },
    });

    const completed = await context.onUpdateTrackerCrm({
      noResponseAutomation: { enabled: false, afterDays: 30 },
      customStages: [],
    });

    expect(completed).toBe(false);
    expect(getActionState().message).toBe("commit refused");
  });
});

describe("buildJobFinderPageContext resume claim confirmation passthrough", () => {
  it("exposes the fenced shell command unchanged for the Resume workspace", async () => {
    const snapshot = {} as JobFinderRendererWorkspaceSnapshot;
    const setResumeClaimConfirmation = vi
      .fn<JobFinderShellActions["setResumeClaimConfirmation"]>()
      .mockResolvedValue(snapshot);
    const { context } = buildContext({
      actions: { setResumeClaimConfirmation },
    });

    const input: JobFinderSetResumeClaimConfirmationInput = {
      intent: "remove",
      jobId: "job_1",
      draftId: "resume_draft_job_1",
      expectedDraftUpdatedAt: "2026-08-26T10:00:00.000Z",
      confirmationId: "claim_confirmation_section_experience_abc",
    };
    const returned = await context.onSetResumeClaimConfirmation(input);

    expect(returned).toBe(snapshot);
    expect(setResumeClaimConfirmation).toHaveBeenCalledOnce();
    expect(setResumeClaimConfirmation).toHaveBeenCalledWith(input);
  });
});

describe("Applications browser hand-off failure reporting", () => {
  /**
   * The hand-off status is composed from what the REAL action wrapper hands
   * back, so these drive `buildJobFinderPageContext`'s own
   * `onPerformUserAction` / `onOpenBrowserSession` with a rejecting IPC double.
   * Calling the composer directly with a fabricated error would have passed
   * before the fix as well: the whole defect was that the wrapper reports its
   * failure as a bare `false` and the cause never reached the sentence.
   */
  const target = {
    jobId: "job_a",
    resultId: "result_a",
    runId: "run_a",
    applicationRecordId: "record_a",
    destinationUrl: "https://jobs.example.com/apply/1",
  };

  function pendingRequests() {
    return [
      {
        id: "request_a",
        revision: 3,
        state: "pending",
        scope: {
          type: "application",
          runId: "run_a",
          jobId: "job_a",
          applicationRecordId: "record_a",
        },
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["userActionRequests"];
  }

  it("carries the real cause into the failed status when the open-page command rejects", async () => {
    const performUserAction = vi
      .fn<JobFinderShellActions["performUserAction"]>()
      .mockRejectedValue(new Error("The browser runtime is disabled"));
    const { context } = buildContext({ actions: { performUserAction } });

    const outcome = await runJobFinderApplicationBrowserHandoff({
      onOpenBrowserSession: () =>
        context.onOpenBrowserSession(undefined, { rethrowError: true }),
      onPerformUserAction: (command) =>
        context.onPerformUserAction(command, { rethrowError: true }),
      requests: pendingRequests(),
      target,
    });

    expect(outcome).toEqual({
      kind: "failed",
      reason: "The browser runtime is disabled",
    });
    expect(performUserAction).toHaveBeenCalledTimes(1);

    const status = formatJobFinderBrowserHandoffFailedStatus(
      outcome.kind === "failed" ? outcome.reason : null,
    );

    expect(status).toBe(
      "The Job Finder browser did not open, so nothing was opened for this " +
        "application and nothing was sent to the employer. The browser runtime " +
        "is disabled. Try again, or open this step from Needs you.",
    );
  });

  it("reports a closed prepared page after the refreshed workspace exposes Try again", async () => {
    const performUserAction = vi
      .fn<JobFinderShellActions["performUserAction"]>()
      .mockResolvedValue({
        userActionRequests: [],
        applicationRecords: [
          {
            id: "record_a",
            lastAttemptState: "failed",
            lastActionLabel: "The prepared application page is no longer open.",
          },
        ],
      } as unknown as JobFinderRendererWorkspaceSnapshot);
    const { context } = buildContext({
      actions: { performUserAction },
      workspace: {
        activeCampaignId: "campaign_active",
        userActionRequests: pendingRequests(),
      } as JobFinderRendererWorkspaceSnapshot,
    });

    const outcome = await runJobFinderApplicationBrowserHandoff({
      onOpenBrowserSession: () =>
        context.onOpenBrowserSession(undefined, { rethrowError: true }),
      onPerformUserAction: (command) =>
        context.onPerformUserAction(command, { rethrowError: true }),
      requests: pendingRequests(),
      target,
    });

    expect(outcome).toEqual({
      kind: "failed",
      reason:
        "That prepared application page is no longer open. Choose Prepare again in Applications to rebuild it.",
    });
  });

  it("shows the application page expanded after opening it, not minimized", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {
      ...globalThis.window,
      nestor: { browser: { command, getState: vi.fn() } },
    });
    try {
      const performUserAction = vi
        .fn<JobFinderShellActions["performUserAction"]>()
        .mockResolvedValue({
          userActionRequests: pendingRequests(),
          applicationRecords: [],
        } as unknown as JobFinderRendererWorkspaceSnapshot);
      const { context } = buildContext({
        actions: { performUserAction },
        workspace: {
          activeCampaignId: "campaign_active",
          userActionRequests: pendingRequests(),
        } as JobFinderRendererWorkspaceSnapshot,
      });

      await context.onPerformUserAction(
        {
          action: "open_page",
          requestId: "request_a",
          commandId: "open_a",
          expectedRevision: 3,
          credentialsPolicy: "browser_only",
          submitAuthorized: false,
          accountCreationAuthorized: false,
        },
        { rethrowError: true },
      );

      expect(command).toHaveBeenCalledWith({ type: "expand", expanded: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens a parked sign-in whose tab is gone through main, then shows it", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    const getState = vi.fn().mockResolvedValue({
      activeTabId: "tab_before_restart",
      tabs: [{ id: "tab_before_restart", url: "http://localhost/authboard/" }],
    });
    vi.stubGlobal("window", {
      ...globalThis.window,
      nestor: { browser: { command, getState } },
    });
    try {
      const requests = [
        {
          id: "request_sign_in",
          revision: 2,
          state: "pending",
          scope: {
            type: "discovery_source",
            discoveryRunId: "run_1",
            parkedTab: {
              tabId: "tab_before_restart",
              url: "http://localhost/authboard/",
              title: null,
            },
          },
        },
      ] as unknown as JobFinderRendererWorkspaceSnapshot["userActionRequests"];
      const performUserAction = vi
        .fn<JobFinderShellActions["performUserAction"]>()
        .mockResolvedValue({
          userActionRequests: requests,
        } as unknown as JobFinderRendererWorkspaceSnapshot);
      const { context } = buildContext({
        actions: { performUserAction },
        workspace: {
          activeCampaignId: "campaign_active",
          userActionRequests: requests,
        } as JobFinderRendererWorkspaceSnapshot,
      });

      await context.onPerformUserAction(
        {
          action: "open_page",
          requestId: "request_sign_in",
          commandId: "open_sign_in",
          expectedRevision: 2,
          credentialsPolicy: "browser_only",
          submitAuthorized: false,
          accountCreationAuthorized: false,
        },
        { rethrowError: true },
      );

      // Main reopens the tab first (the renderer no longer refuses when the
      // tab is missing from its view), then it is selected and expanded.
      expect(performUserAction).toHaveBeenCalledOnce();
      expect(command).toHaveBeenCalledWith({
        type: "select_tab",
        tabId: "tab_before_restart",
      });
      expect(command).toHaveBeenCalledWith({ type: "expand", expanded: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("carries the real cause when only the window could be opened", async () => {
    const openBrowserSession = vi
      .fn<JobFinderShellActions["openBrowserSession"]>()
      .mockRejectedValue(new Error("No browser session could be started"));
    const { context } = buildContext({ actions: { openBrowserSession } });

    const outcome = await runJobFinderApplicationBrowserHandoff({
      onOpenBrowserSession: () =>
        context.onOpenBrowserSession(undefined, { rethrowError: true }),
      onPerformUserAction: (command) =>
        context.onPerformUserAction(command, { rethrowError: true }),
      requests:
        [] as unknown as JobFinderRendererWorkspaceSnapshot["userActionRequests"],
      target,
    });

    expect(outcome).toEqual({
      kind: "failed",
      reason: "No browser session could be started",
    });
    expect(
      formatJobFinderBrowserHandoffFailedStatus(
        outcome.kind === "failed" ? outcome.reason : null,
      ),
    ).toContain("No browser session could be started.");
  });

  it("still reports the failure once at the route and leaves other callers resolving false", async () => {
    // The banner is unchanged, and a caller that does not ask for the cause
    // keeps the wrapper's own fire-and-forget contract.
    const performUserAction = vi
      .fn<JobFinderShellActions["performUserAction"]>()
      .mockRejectedValue(new Error("The browser runtime is disabled"));
    const { context, getActionState } = buildContext({
      actions: { performUserAction },
    });

    await expect(
      context.onPerformUserAction({
        requestId: "request_a",
        commandId: "command_a",
        expectedRevision: 3,
        action: "confirm_done",
        credentialsPolicy: "browser_only",
        submitAuthorized: false,
        accountCreationAuthorized: false,
      }),
    ).resolves.toBe(false);

    expect(getActionState().message).toContain(
      "The browser runtime is disabled",
    );
  });
});

it("does not count a removed in-flight job as a written resume", async () => {
  const generateResume = vi.fn<JobFinderShellActions["generateResume"]>();
  const { context, getTailoredDraftPreparation, getActionState } = buildContext(
    {
      actions: { generateResume },
      batchGenerate: ({ jobId }) =>
        Promise.resolve<ResumeBatchGenerationResult>({
          jobId,
          outcome: "cancelled",
        }),
      workspace: createBatchWorkspace([createReviewQueueItem("removed")]),
    },
  );
  context.onPrepareTailoredDrafts();
  await vi.waitFor(() =>
    expect(getTailoredDraftPreparation().status).toBe("completed"),
  );
  expect(getTailoredDraftPreparation().cancelledCount).toBe(1);
  expect(generateResume).not.toHaveBeenCalled();
  expect(getActionState().message).toBe(
    "Wrote 0 resumes · 1 removed from the shortlist.",
  );
});

describe("tracker bulk notices and reset completion", () => {
  it.each(["stage", "tags", "archive"] as const)(
    "leaves %s success to the tracker toast",
    async (action) => {
      const mutateApplicationCrmBulkStage = vi
        .fn<JobFinderShellActions["mutateApplicationCrmBulkStage"]>()
        .mockResolvedValue({
          activeCampaignId: null,
        } as unknown as JobFinderRendererWorkspaceSnapshot);
      const { context, getActionMessages } = buildContext({
        actions: { mutateApplicationCrmBulkStage },
      });
      const command = ApplicationCrmBulkStageMutationInputSchema.parse({
        action,
        stage: "reviewing",
        tags: ["Priority"],
        items: [
          { applicationRecordId: "synthetic_application", expectedRevision: 0 },
        ],
      });
      await context.onMutateApplicationCrmBulkStage(command);
      expect(mutateApplicationCrmBulkStage).toHaveBeenCalledWith(command);
      expect(getActionMessages().filter((message) => message !== null)).toEqual(
        [],
      );
    },
  );

  it("returns reset failure to the pending confirmation", async () => {
    const resetWorkspace = vi.fn(() =>
      Promise.reject(new Error("Your workspace was not deleted.")),
    );
    const { context } = buildContext({ actions: { resetWorkspace } });
    await expect(context.onResetWorkspace()).rejects.toThrow(
      "Your workspace was not deleted.",
    );
    expect(resetWorkspace).toHaveBeenCalledOnce();
  });
});

it("R3-183 continues an interrupted existing rewrite with its saved level and language request", async () => {
  const workspace = createBatchWorkspace([
    createReviewQueueItem("old", {
      assetStatus: "ready",
      resumeApplicationMode: "original_resume",
      resumeReview: { status: "draft" },
    }),
  ]);
  workspace.resumeDrafts = [
    { jobId: "old" },
  ] as JobFinderRendererWorkspaceSnapshot["resumeDrafts"];
  workspace.intelligence = JobFinderIntelligenceStateSchema.parse({
    resumeBatchCheckpoint: {
      id: "assistant_batch",
      jobIds: ["old"],
      activeJobIds: ["old"],
      completedJobIds: [],
      done: false,
      stopRequested: false,
      running: false,
      requests: [
        { jobId: "old", regenerate: true, level: "light", language: "German" },
      ],
      durationsMs: [150000, 180000],
    },
  });
  const regenerateResumeDraft = vi
    .fn<JobFinderShellActions["regenerateResumeDraft"]>()
    .mockResolvedValue(workspace);
  const setJobResumeApplicationMode = vi
    .fn<JobFinderShellActions["setJobResumeApplicationMode"]>()
    .mockResolvedValue(workspace);
  const generateResume = vi.fn<JobFinderShellActions["generateResume"]>();
  const sync = vi.fn((batch: AssistantResumeBatchState) =>
    Promise.resolve(syncUiResumeBatch(batch)),
  );
  window.nestor.assistant.syncResumeBatch = sync;
  const run = buildContext({
    workspace,
    batchGenerate: ({ jobId }) =>
      Promise.resolve<ResumeBatchGenerationResult>({
        jobId,
        outcome: "written",
      }),
    actions: {
      regenerateResumeDraft,
      setJobResumeApplicationMode,
      generateResume,
    },
  });
  run.context.onPrepareTailoredDrafts(["old"]);
  await vi.waitFor(() =>
    expect(run.getTailoredDraftPreparation().status).toBe("completed"),
  );
  expect(run.generateResumeForBatch).toHaveBeenCalledWith({
    batchId: sync.mock.calls[0]![0].id,
    jobId: "old",
    regenerate: true,
  });
  expect(regenerateResumeDraft).not.toHaveBeenCalled();
  expect(generateResume).not.toHaveBeenCalled();
  expect(setJobResumeApplicationMode).not.toHaveBeenCalled();
  expect(sync.mock.calls[0]![0]).toMatchObject({
    resumedBatchIds: ["assistant_batch"],
    requests: [
      { jobId: "old", language: "German", level: "light", regenerate: true },
    ],
  });
});

it("keeps failed first drafts and failed existing rewrites unfinished with their saved retry choices", async () => {
  for (const rewriting of [false, true]) {
    clearUiResumeBatch();
    const workspace = createBatchWorkspace([
      createReviewQueueItem(
        "retry",
        rewriting
          ? { assetStatus: "ready", resumeReview: { status: "draft" } }
          : {},
      ),
    ]);
    if (rewriting) {
      workspace.resumeDrafts = [
        { jobId: "retry" },
      ] as JobFinderRendererWorkspaceSnapshot["resumeDrafts"];
      workspace.intelligence = JobFinderIntelligenceStateSchema.parse({
        resumeBatchCheckpoint: {
          id: "failed_rewrite",
          jobIds: ["retry"],
          activeJobIds: [],
          completedJobIds: [],
          done: false,
          stopRequested: false,
          running: false,
          requests: [
            {
              jobId: "retry",
              regenerate: true,
              level: "light",
              language: "German",
            },
          ],
        },
      });
    }
    const sync = vi.fn((batch: AssistantResumeBatchState) =>
      Promise.resolve(syncUiResumeBatch(batch)),
    );
    window.nestor.assistant.syncResumeBatch = sync;
    const run = buildContext({
      workspace,
      actions: {},
      batchGenerate: ({ jobId }) =>
        Promise.resolve<ResumeBatchGenerationResult>({
          jobId,
          outcome: "failed",
        }),
    });
    run.context.onPrepareTailoredDrafts(rewriting ? ["retry"] : undefined);
    await vi.waitFor(() =>
      expect(run.getTailoredDraftPreparation().status).toBe("failed"),
    );
    await vi.waitFor(() =>
      expect(sync.mock.calls.at(-1)?.[0].running).toBe(false),
    );
    const saved = sync.mock.calls.at(-1)![0];
    expect(saved).toMatchObject({
      jobIds: ["retry"],
      completedJobIds: [],
      done: false,
      running: false,
    });
    if (rewriting)
      expect(saved.requests).toEqual([
        {
          jobId: "retry",
          regenerate: true,
          level: "light",
          language: "German",
        },
      ]);
  }
});

it("pauses a200-job provider-blocked queue, persists its reason, and continues only on another explicit action", async () => {
  const items = Array.from({ length: 200 }, (_, index) =>
    createReviewQueueItem(`provider_${index}`),
  );
  const workspace = createBatchWorkspace(items);
  const providerBlock = {
    reason: "funding" as const,
    message:
      "The AI service is unavailable because its provider rejected the request for insufficient funds. Try again after the service is restored.",
  };
  const sync = vi.fn((batch: AssistantResumeBatchState) =>
    Promise.resolve(syncUiResumeBatch(batch)),
  );
  window.nestor.assistant.syncResumeBatch = sync;
  const run = buildContext({
    workspace,
    actions: {},
    batchGenerate: ({ batchId, jobId }) => {
      blockUiResumeBatch(batchId, providerBlock);
      return Promise.resolve<ResumeBatchGenerationResult>({
        jobId,
        outcome: "blocked",
        providerBlock,
      });
    },
  });
  run.context.onPrepareTailoredDrafts();
  await vi.waitFor(() =>
    expect(run.getTailoredDraftPreparation().status).toBe("stopped"),
  );
  await vi.waitFor(() =>
    expect(sync.mock.calls.at(-1)?.[0].running).toBe(false),
  );
  expect(run.getTailoredDraftPreparation()).toMatchObject({
    completedCount: 0,
    failedCount: 0,
    totalCount: 200,
    providerBlock,
  });
  expect(run.generateResumeForBatch.mock.calls.length).toBeLessThanOrEqual(100);
  const saved = sync.mock.calls.at(-1)![0];
  expect(saved).toMatchObject({
    done: false,
    running: false,
    stopRequested: true,
    completedJobIds: [],
    providerBlock,
  });
  expect(saved.jobIds).toHaveLength(200);
  expect(run.getActionMessages().at(-1)).toBeNull();
  expect(
    run.getActionMessages().some((message) => message?.includes("200 failed")),
  ).toBe(false);
  clearUiResumeBatch();
  workspace.resumeDrafts = [];
  workspace.intelligence = JobFinderIntelligenceStateSchema.parse({
    resumeBatchCheckpoint: saved,
  });
  const continued = buildContext({
    workspace,
    actions: {},
    batchGenerate: ({ jobId }) =>
      Promise.resolve<ResumeBatchGenerationResult>({
        jobId,
        outcome: "written",
      }),
  });
  expect(continued.generateResumeForBatch).not.toHaveBeenCalled();
  continued.context.onPrepareTailoredDrafts(saved.jobIds);
  await vi.waitFor(() =>
    expect(continued.getTailoredDraftPreparation().status).toBe("completed"),
  );
  await vi.waitFor(() =>
    expect(sync.mock.calls.at(-1)?.[0].running).toBe(false),
  );
  expect(continued.generateResumeForBatch).toHaveBeenCalledTimes(200);
  expect(sync.mock.calls.at(-1)![0]).toMatchObject({
    done: true,
    completedJobIds: saved.jobIds,
  });
  expect(sync.mock.calls.at(-1)![0].providerBlock).toBeUndefined();
});
