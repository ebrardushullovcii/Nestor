import {
  clearUiResumeBatch,
  syncUiResumeBatch,
  stopUiResumeBatch,
} from "../services/assistant/ui-resume-batch";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IpcMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApplicationPacketSchema,
  ApplicationCrmSettingsSchema,
  AppearanceThemeSchema,
  ApplyRunSchema,
  DISCOVERY_NO_JOB_SITES_MESSAGE,
  getDefaultCampaignConfiguration,
  DiscoveryRunRecordSchema,
  DiscoveryJobViewSchema,
  JobFinderWorkspaceSyncResultSchema,
  JobFinderAgentDiscoveryReplySchema,
  type JobFinderWorkspaceEntityMutationInput,
  JobFinderProfileCopilotPatchGroupActionInputSchema,
  JobFinderResumePreviewSchema,
  JobFinderSetResumeClaimConfirmationInputSchema,
  JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema,
  JobFinderUndoProfileRevisionInputSchema,
  ResumeDraftSchema,
  TailoredAssetSchema,
  SavedJobSchema,
  JobFinderWorkspaceSnapshotSchema,
  MarkAllCampaignNotificationsReadInputSchema,
  MarkCampaignNotificationReadInputSchema,
  ResumeQualityBenchmarkReportSchema,
  SaveCampaignRuleRouteInputSchema,
  UpdateApplicationDefaultsInputSchema,
  UpdateWorkspaceBehaviorInputSchema,
  UpdateAiBehaviorInputSchema,
  resumeClaimOwnershipStatement,
} from "@nestor/contracts";
import { createEmptyJobFinderRepositoryState } from "../adapters/job-finder-initial-state";
import { createResumeWorkspaceDemoState } from "../adapters/job-finder-demo-state";

/**
 * A change route answers with a sync result. A window that never said which
 * revision it shows (every test sender) gets the whole view in it.
 */
function answeredView(result: unknown): unknown {
  const answer = result as { kind?: unknown; snapshot?: unknown };
  if (answer.kind !== "snapshot")
    throw new Error(
      `Expected a whole-view answer, got ${String(answer.kind)}.`,
    );
  return answer.snapshot;
}

function wholeViewAnswer(snapshot: unknown) {
  return {
    kind: "snapshot",
    currentRevision: expect.any(Number) as unknown,
    reason: "stale_base",
    snapshot,
  };
}

type RegisteredHandler = (
  event: { sender: object },
  payload: unknown,
) => Promise<unknown>;

const {
  mockApplyGroupedManualAnswer,
  mockBrowserWindowFromWebContents,
  mockBuildApplicationPacket,
  mockDeleteCampaignRule,
  mockExportResumePdf,
  mockFocusPreparedApplicationPage,
  mockGetResumeWorkspace,
  mockPreviewResumeDraft,
  mockGetWorkspaceBootstrap,
  mockGetWorkspaceProjection,
  mockGetJobFinderWorkspaceService,
  mockGetJobFinderRepositoryForWorkspaceService,
  mockGetJobFinderApplicationAuthorityService,
  mockImportResumeFromSourcePath,
  mockRetryInterruptedResumeImport,
  mockIsDesktopTestApiEnabled,
  mockMarkAllCampaignNotificationsRead,
  mockMarkCampaignNotificationRead,
  mockProjectCampaignRuleFunnel,
  mockProjectGroupedManualAnswer,
  mockProposeProfileCopilotChange,
  mockQueueJobForReview,
  mockRunCampaignNow,
  mockRunDesktopResumeQualityBenchmark,
  mockSaveCampaignRule,
  mockSetResumeClaimConfirmation,
  mockSetWorkHistoryReviewAcknowledgment,
  mockStartApplyCopilotRun,
  mockCancelApplyRun,
  mockGetApplyRunDetails,
  mockResolveApplyConsentRequest,
  mockShowOpenDialog,
  mockShowSaveDialog,
  mockSnoozeGroupedDecision,
  mockToggleCampaignRule,
  mockUpdateAppearanceTheme,
  mockUpdateApplicationDefaults,
  mockUpdateTrackerCrm,
  mockUpdateWorkspaceBehavior,
  mockUpdateAiBehavior,
} = vi.hoisted(() => ({
  mockApplyGroupedManualAnswer: vi.fn(),
  mockBrowserWindowFromWebContents: vi.fn(
    (): {
      id: string;
      focus: ReturnType<typeof vi.fn>;
      isDestroyed: ReturnType<typeof vi.fn>;
      show: ReturnType<typeof vi.fn>;
    } | null => null,
  ),
  mockBuildApplicationPacket: vi.fn(),
  mockDeleteCampaignRule: vi.fn(),
  mockExportResumePdf: vi.fn(),
  mockFocusPreparedApplicationPage: vi.fn(),
  mockGetResumeWorkspace: vi.fn(),
  mockPreviewResumeDraft: vi.fn(),
  mockGetWorkspaceBootstrap: vi.fn(),
  mockGetWorkspaceProjection: vi.fn(),
  mockGetJobFinderWorkspaceService: vi.fn(),
  mockGetJobFinderRepositoryForWorkspaceService: vi.fn(() => null),
  mockGetJobFinderApplicationAuthorityService: vi.fn(),
  mockImportResumeFromSourcePath: vi.fn(),
  mockRetryInterruptedResumeImport: vi.fn(),
  mockIsDesktopTestApiEnabled: vi.fn(() => false),
  mockMarkAllCampaignNotificationsRead: vi.fn(),
  mockMarkCampaignNotificationRead: vi.fn(),
  mockProjectCampaignRuleFunnel: vi.fn(),
  mockProjectGroupedManualAnswer: vi.fn(),
  mockProposeProfileCopilotChange: vi.fn(),
  mockQueueJobForReview: vi.fn(),
  mockRunCampaignNow: vi.fn(),
  mockRunDesktopResumeQualityBenchmark: vi.fn(),
  mockSaveCampaignRule: vi.fn(),
  mockSetResumeClaimConfirmation: vi.fn(),
  mockSetWorkHistoryReviewAcknowledgment: vi.fn(),
  mockStartApplyCopilotRun: vi.fn(),
  mockCancelApplyRun: vi.fn(),
  mockGetApplyRunDetails: vi.fn(),
  mockResolveApplyConsentRequest: vi.fn(),
  mockShowOpenDialog: vi.fn(),
  mockShowSaveDialog: vi.fn(),
  mockSnoozeGroupedDecision: vi.fn(),
  mockToggleCampaignRule: vi.fn(),
  mockUpdateAppearanceTheme: vi.fn(),
  mockUpdateApplicationDefaults: vi.fn(),
  mockUpdateTrackerCrm: vi.fn(),
  mockUpdateWorkspaceBehavior: vi.fn(),
  mockUpdateAiBehavior: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => process.cwd()),
  },
  BrowserWindow: {
    fromWebContents: mockBrowserWindowFromWebContents,
    getAllWindows: () => [],
  },
  dialog: {
    showOpenDialog: mockShowOpenDialog,
    showSaveDialog: mockShowSaveDialog,
  },
}));

vi.mock("../services/job-finder", () => ({
  defaultBenchmarkCases: [],
  getDesktopTestDelayMs: vi.fn(() => 0),
  getJobFinderApplicationAuthorityService:
    mockGetJobFinderApplicationAuthorityService,
  getJobFinderRepositoryForWorkspaceService:
    mockGetJobFinderRepositoryForWorkspaceService,
  getJobFinderWorkspaceService: mockGetJobFinderWorkspaceService,
  importResumeFromSourcePath: mockImportResumeFromSourcePath,
  isDesktopTestApiEnabled: mockIsDesktopTestApiEnabled,
  loadApplyQueueDemoState: vi.fn(),
  loadResumeWorkspaceDemoState: vi.fn(),
  parseResumeImportPathPayload: vi.fn(),
  resetJobFinderWorkspace: vi.fn(),
  retryInterruptedResumeImport: mockRetryInterruptedResumeImport,
  runDesktopResumeImportBenchmark: vi.fn(),
  runDesktopResumeQualityBenchmark: mockRunDesktopResumeQualityBenchmark,
  setJobFinderWorkspaceServiceTestEnv: vi.fn(),
}));

import {
  JOB_FINDER_WORKSPACE_UPDATED_CHANNEL,
  onJobFinderWorkspaceUpdate,
} from "../services/job-finder/workspace-updates";
import {
  RETIRED_CHAT_MESSAGE,
  approveApplicationResumes,
  registerJobFinderRouteHandlers,
  syncApplicationAuthorityForSavedMode,
} from "./job-finder";

const packet = ApplicationPacketSchema.parse({
  generatedAt: "2026-07-30T12:00:00.000Z",
  job: {
    id: "job-1",
    source: "target_site",
    title: "Senior Engineer",
    company: "Example",
    location: "Remote",
    listingDestination: {
      origin: "https://jobs.example.com",
      safePath: "/jobs/123",
    },
    applicationDestination: {
      origin: "https://apply.example.com",
      safePath: "/applications/123",
    },
    summary: "Build reliable systems.",
  },
  run: {
    id: "run-1",
    mode: "copilot",
    state: "paused_for_user_review",
  },
  result: {
    id: "result-1",
    applicationRecordId: "application-1",
    state: "awaiting_review",
    summary: "Prepared",
    detail: "Stopped before final submit.",
    blockerReason: null,
    blockerSummary: null,
    updatedAt: "2026-07-30T12:00:00.000Z",
  },
  resume: {
    source: "original_upload",
    sourceDocumentId: "document-1",
    exportArtifactId: null,
    fileName: "Original CV.pdf",
    sha256: null,
  },
  questions: [],
  consent: [],
  checkpoints: [],
  privacyReceipt: null,
  submissionOccurred: false,
});

describe("interactive routes use main workspace projections", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue(null);
  });

  function register(service: object) {
    mockGetJobFinderWorkspaceService.mockResolvedValue(service);
    const handlers = new Map<string, RegisteredHandler>();
    registerJobFinderRouteHandlers({
      handle: (channel: string, handler: RegisteredHandler) =>
        handlers.set(channel, handler),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcMain);
    return handlers;
  }

  it("uses small batch receipts and a transaction-independent trusted Stop predicate", async () => {
    clearUiResumeBatch();
    syncUiResumeBatch({
      id: "batch",
      jobIds: ["job"],
      activeJobIds: ["job"],
      completedJobIds: [],
      done: false,
      stopRequested: false,
      running: true,
    });
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
    const owner = {
      id: "window",
      focus: vi.fn(),
      show: vi.fn(),
      isDestroyed: vi.fn(),
      webContents: { id: 1 },
    };
    mockBrowserWindowFromWebContents.mockReturnValue(owner);
    const getWorkspaceSnapshot = vi.fn();
    const generateResumeForBatch = vi.fn(
      (
        jobId: string,
        options: {
          shouldStop: () => boolean;
          onStage: (stage: "writing") => void;
        },
      ) => {
        expect(options.shouldStop()).toBe(false);
        options.onStage("writing");
        stopUiResumeBatch();
        expect(options.shouldStop()).toBe(true);
        return Promise.resolve({ jobId, outcome: "written" });
      },
    );
    const handlers = register({ generateResumeForBatch, getWorkspaceSnapshot });
    expect(
      await handlers.get("job-finder:generate-resume-for-batch")!(
        { sender },
        { batchId: "batch", jobId: "job" },
      ),
    ).toEqual({ jobId: "job", outcome: "written" });
    expect(getWorkspaceSnapshot).not.toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledWith(
      "job-finder:resume-batch-progress",
      { batchId: "batch", jobId: "job", stage: "writing" },
    );
    expect(
      await handlers.get("job-finder:generate-resume-for-batch")!(
        { sender },
        { batchId: "batch", jobId: "job" },
      ),
    ).toEqual({ jobId: "job", outcome: "not_started" });
    expect(generateResumeForBatch).toHaveBeenCalledOnce();
    await expect(
      handlers.get("job-finder:generate-resume-for-batch")!(
        { sender },
        { batchId: "batch", jobId: "job", extra: true },
      ),
    ).rejects.toThrow();
    clearUiResumeBatch();
  });

  it("a typed provider rejection stops the main queue before any later dispatch", async () => {
    clearUiResumeBatch();
    syncUiResumeBatch({
      id: "funding-route",
      jobIds: ["one", "two"],
      activeJobIds: ["one"],
      completedJobIds: [],
      done: false,
      stopRequested: false,
      running: true,
    });
    const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
    const owner = {
      id: "window",
      focus: vi.fn(),
      show: vi.fn(),
      isDestroyed: vi.fn(),
      webContents: { id: 1 },
    };
    mockBrowserWindowFromWebContents.mockReturnValue(owner);
    const providerBlock = {
      reason: "funding" as const,
      message: "The AI service is unavailable: insufficient funds.",
    };
    const generateResumeForBatch = vi.fn(
      (
        jobId: string,
        options: {
          shouldStop: () => boolean;
          onProviderBlocked: (block: typeof providerBlock) => void;
        },
      ) => {
        expect(options.shouldStop()).toBe(false);
        options.onProviderBlocked(providerBlock);
        expect(options.shouldStop()).toBe(true);
        return Promise.resolve({ jobId, outcome: "blocked", providerBlock });
      },
    );
    const handlers = register({ generateResumeForBatch });
    const generate = handlers.get("job-finder:generate-resume-for-batch")!;
    expect(
      await generate({ sender }, { batchId: "funding-route", jobId: "one" }),
    ).toEqual({ jobId: "one", outcome: "blocked", providerBlock });
    expect(
      await generate({ sender }, { batchId: "funding-route", jobId: "two" }),
    ).toEqual({ jobId: "two", outcome: "not_started" });
    expect(generateResumeForBatch).toHaveBeenCalledOnce();
    clearUiResumeBatch();
  });

  it("reads only the selected complete tailored asset through typed detail IPC", async () => {
    const asset = TailoredAssetSchema.parse({
      id: "selected-asset",
      jobId: "job",
      kind: "resume",
      status: "ready",
      label: "Synthetic resume",
      version: "1",
      templateName: "Classic",
      compatibilityScore: 90,
      progressPercent: 100,
      updatedAt: "2026-10-13T10:00:00.000Z",
      contentText: "Complete selected document",
      previewSections: [
        { heading: "Summary", lines: ["Complete selected preview"] },
      ],
    });
    const getTailoredAssetById = vi.fn().mockResolvedValue(asset);
    mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue({
      getTailoredAssetById,
    } as never);
    const handlers = register({});
    const read = handlers.get("job-finder:get-tailored-asset")!;
    expect(await read({ sender: {} }, { assetId: asset.id })).toEqual(asset);
    expect(getTailoredAssetById).toHaveBeenCalledExactlyOnceWith(asset.id);
    await expect(read({ sender: {} }, { assetId: "" })).rejects.toThrow();
    expect(getTailoredAssetById).toHaveBeenCalledTimes(1);
  });

  function workspace() {
    const snapshot = createEmptyWorkspace("2026-10-13T12:00:00.000Z");
    const seed = createResumeWorkspaceDemoState().savedJobs[0];
    // Keep full listing evidence in main; the route builds the small IPC row.
    const job = DiscoveryJobViewSchema.parse({
      ...seed,
      id: "selected-job",
      title: "Synthetic role",
      company: "Synthetic employer",
      description: "Selected listing evidence that belongs only in main.",
      listingActivity: { status: "unknown" },
    });
    snapshot.discoveryJobs = [job];
    snapshot.selectedDiscoveryJobId = job.id;
    const getWorkspaceProjection = vi.fn().mockResolvedValue(snapshot);
    const getWorkspaceSnapshot = vi.fn(() => {
      throw new Error("Canonical reads are forbidden in interactive routes");
    });
    return { snapshot, job, getWorkspaceProjection, getWorkspaceSnapshot };
  }

  it("returns the saved profile and settings through the projection, with full evidence confined to main", async () => {
    mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue(null);
    const fixture = workspace();
    const saveProfileAndSearchPreferences = vi
      .fn()
      .mockResolvedValue(fixture.snapshot);
    const saveSettings = vi.fn().mockResolvedValue(fixture.snapshot);
    const handlers = register({
      ...fixture,
      saveProfileAndSearchPreferences,
      saveSettings,
    });
    const result = await handlers.get("job-finder:save-workspace-inputs")!(
      { sender: {} },
      {
        profile: fixture.snapshot.profile,
        searchPreferences: fixture.snapshot.searchPreferences,
        settings: fixture.snapshot.settings,
      },
    );
    expect(saveProfileAndSearchPreferences).toHaveBeenCalledWith(
      fixture.snapshot.profile,
      fixture.snapshot.searchPreferences,
    );
    expect(saveSettings).toHaveBeenCalledWith(fixture.snapshot.settings);
    expect(answeredView(result)).toMatchObject({
      profile: fixture.snapshot.profile,
      settings: fixture.snapshot.settings,
      selectedDiscoveryJobId: fixture.job.id,
      discoveryJobs: [{ id: fixture.job.id }],
    });
    expect(JSON.stringify(result)).not.toContain(fixture.job.description);
    expect(fixture.snapshot.discoveryJobs[0]?.description).toBe(
      fixture.job.description,
    );
    expect(fixture.getWorkspaceProjection).toHaveBeenCalledTimes(1);
    expect(fixture.getWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  it("returns the current selected state when a PDF export is cancelled without a canonical read or export", async () => {
    const fixture = workspace();
    const exportResumePdf = vi.fn();
    const getResumeWorkspace = vi.fn().mockResolvedValue({
      job: fixture.job,
      draft: { generationMethod: "ai" },
      tailoredAsset: null,
    });
    mockBrowserWindowFromWebContents.mockReturnValue(null);
    mockShowSaveDialog.mockResolvedValue({ canceled: true });
    const handlers = register({
      ...fixture,
      exportResumePdf,
      getResumeWorkspace,
    });
    await expect(
      handlers.get("job-finder:export-resume-pdf")!(
        { sender: {} },
        { jobId: fixture.job.id, intent: "download" },
      ),
    ).resolves.toMatchObject({
      outcome: "cancelled",
      outputPath: null,
      workspace: {
        kind: "snapshot",
        snapshot: { selectedDiscoveryJobId: fixture.job.id },
      },
    });
    expect(exportResumePdf).not.toHaveBeenCalled();
    expect(fixture.getWorkspaceProjection).toHaveBeenCalledTimes(1);
    expect(fixture.getWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  it("keeps an in-progress application batch unchanged on a second press and reads only its display projection", async () => {
    const fixture = workspace();
    const run = ApplyRunSchema.parse({
      id: "running-batch",
      mode: "queue_auto",
      state: "running",
      jobIds: [fixture.job.id],
      summary: "Synthetic application is running.",
      detail: "The repeated press must preserve this run.",
      createdAt: fixture.snapshot.generatedAt,
      updatedAt: fixture.snapshot.generatedAt,
    });
    fixture.snapshot.applyRuns = [run];
    fixture.snapshot.selectedApplyRunId = run.id;
    const startAutoApplyQueueRun = vi.fn();
    mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue({
      listApplyRuns: vi.fn().mockResolvedValue([run]),
      listApplyJobResults: vi.fn().mockResolvedValue([]),
    } as never);
    const handlers = register({ ...fixture, startAutoApplyQueueRun });
    await expect(
      handlers.get("job-finder:start-auto-apply-queue-run")!(
        { sender: {} },
        { jobIds: [fixture.job.id] },
      ),
    ).resolves.toMatchObject({
      kind: "snapshot",
      snapshot: { applyRuns: [run], selectedApplyRunId: run.id },
    });
    expect(startAutoApplyQueueRun).not.toHaveBeenCalled();
    expect(fixture.getWorkspaceProjection).toHaveBeenCalledTimes(1);
    expect(fixture.getWorkspaceSnapshot).not.toHaveBeenCalled();
  });
});

describe("job-finder profile copilot patch-group routes", () => {
  const mockApplyProfileCopilotPatchGroup = vi.fn();
  const mockRejectProfileCopilotPatchGroup = vi.fn();
  const mockUndoProfileRevision = vi.fn();

  afterEach(() => {
    vi.clearAllMocks();
  });

  function registerAndFindHandler(channel: string): RegisteredHandler {
    const handlers = new Map<string, RegisteredHandler>();
    const ipcMain = {
      handle: vi.fn((registeredChannel: string, handler: RegisteredHandler) => {
        handlers.set(registeredChannel, handler);
      }),
    } as unknown as IpcMain;
    registerJobFinderRouteHandlers(ipcMain);

    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error(
        `Profile Copilot patch-group handler was not registered: ${channel}`,
      );
    }
    return handler;
  }

  it("refuses the retired patch-group writes and still forwards undo", async () => {
    const snapshot = createEmptyWorkspace("2026-08-22T11:00:00.000Z");
    mockUndoProfileRevision.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      applyProfileCopilotPatchGroup: mockApplyProfileCopilotPatchGroup,
      rejectProfileCopilotPatchGroup: mockRejectProfileCopilotPatchGroup,
      undoProfileRevision: mockUndoProfileRevision,
    });

    const applyInput = JobFinderProfileCopilotPatchGroupActionInputSchema.parse(
      { patchGroupId: "profile_patch_group_1" },
    );
    await expect(
      registerAndFindHandler("job-finder:apply-profile-copilot-patch-group")(
        { sender: {} },
        applyInput,
      ),
    ).rejects.toThrow(RETIRED_CHAT_MESSAGE);
    await expect(
      registerAndFindHandler("job-finder:reject-profile-copilot-patch-group")(
        { sender: {} },
        applyInput,
      ),
    ).rejects.toThrow(RETIRED_CHAT_MESSAGE);
    expect(mockApplyProfileCopilotPatchGroup).not.toHaveBeenCalled();
    expect(mockRejectProfileCopilotPatchGroup).not.toHaveBeenCalled();

    const undoInput = JobFinderUndoProfileRevisionInputSchema.parse({
      revisionId: "profile_revision_3",
    });
    const undoResult = await registerAndFindHandler(
      "job-finder:undo-profile-revision",
    )({ sender: {} }, undoInput);
    expect(mockUndoProfileRevision).toHaveBeenCalledWith("profile_revision_3");
    expect(answeredView(undoResult)).toEqual(snapshot);
  });

  it("parses strict input schemas before touching the service", async () => {
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      applyProfileCopilotPatchGroup: mockApplyProfileCopilotPatchGroup,
      rejectProfileCopilotPatchGroup: mockRejectProfileCopilotPatchGroup,
      undoProfileRevision: mockUndoProfileRevision,
    });

    const applyHandler = registerAndFindHandler(
      "job-finder:apply-profile-copilot-patch-group",
    );
    const rejectHandler = registerAndFindHandler(
      "job-finder:reject-profile-copilot-patch-group",
    );
    const undoHandler = registerAndFindHandler(
      "job-finder:undo-profile-revision",
    );

    await expect(
      applyHandler({ sender: {} }, { patchGroupId: "" }),
    ).rejects.toThrow();
    await expect(
      applyHandler({ sender: {} }, { patchGroupId: "  " }),
    ).rejects.toThrow();
    await expect(rejectHandler({ sender: {} }, {})).rejects.toThrow();
    await expect(
      undoHandler({ sender: {} }, { revisionId: 42 }),
    ).rejects.toThrow();

    expect(mockApplyProfileCopilotPatchGroup).not.toHaveBeenCalled();
    expect(mockRejectProfileCopilotPatchGroup).not.toHaveBeenCalled();
    expect(mockUndoProfileRevision).not.toHaveBeenCalled();
  });

  // PERF-03 / F33. Mutation handlers used to run a full
  // `JobFinderWorkspaceSnapshotSchema.parse` on every response — a second deep
  // validation of a snapshot the workspace service had already parsed, paid
  // once per user action and growing with every job the user has discovered.
  // The response must now be handed through untouched, while a malformed
  // main-process value still fails closed.
  it("projects the service snapshot without re-validating its full collections", async () => {
    const snapshot = createEmptyWorkspace("2026-08-22T11:30:00.000Z");
    const parseSpy = vi.spyOn(JobFinderWorkspaceSnapshotSchema, "parse");
    mockUndoProfileRevision.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      undoProfileRevision: mockUndoProfileRevision,
    });

    const result = await registerAndFindHandler(
      "job-finder:undo-profile-revision",
    )({ sender: {} }, { revisionId: "profile_revision_9" });

    expect(answeredView(result)).toEqual(snapshot);
    expect((answeredView(result) as typeof snapshot).profile).toBe(
      snapshot.profile,
    );
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it("keeps mutation input validation ahead of any service call", async () => {
    const snapshot = createEmptyWorkspace("2026-08-22T11:45:00.000Z");
    mockUndoProfileRevision.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      undoProfileRevision: mockUndoProfileRevision,
    });

    await expect(
      registerAndFindHandler("job-finder:undo-profile-revision")(
        { sender: {} },
        { revisionId: 42 },
      ),
    ).rejects.toThrow();
    expect(mockUndoProfileRevision).not.toHaveBeenCalled();
  });

  // The deep parse is gone, but the fail-closed guarantee it provided is not:
  // a malformed main-process value must never reach the renderer.
  it("fails closed when the service returns a value that is not a workspace snapshot", async () => {
    mockUndoProfileRevision.mockResolvedValue({
      module: "job-finder",
    } as unknown as ReturnType<typeof createEmptyWorkspace>);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      undoProfileRevision: mockUndoProfileRevision,
    });

    await expect(
      registerAndFindHandler("job-finder:undo-profile-revision")(
        { sender: {} },
        { revisionId: "profile_revision_4" },
      ),
    ).rejects.toThrow();
    expect(mockUndoProfileRevision).toHaveBeenCalledWith("profile_revision_4");
  });
});

function createEmptyWorkspace(generatedAt: string) {
  const state = createEmptyJobFinderRepositoryState();
  const campaign = {
    id: "campaign-test",
    name: "Test campaign",
    description: "",
    mode: "precision" as const,
    status: "active" as const,
    createdAt: generatedAt,
    updatedAt: generatedAt,
    searchPreferences: state.searchPreferences,
    sourceTargetIds: [],
    jobIds: [],
    minimumFitScore: null,
    ...getDefaultCampaignConfiguration("precision"),
    schedule: {},
    progress: { lastUpdatedAt: generatedAt },
    history: [],
  };

  return JobFinderWorkspaceSnapshotSchema.parse({
    module: "job-finder",
    generatedAt,
    agentProvider: {
      kind: "deterministic",
      role: "chat",
      ready: true,
      label: "Test AI",
      model: null,
      baseUrl: null,
      modelContextWindowTokens: null,
      reservedHeadroomTokens: null,
      requestTimeoutMs: null,
      detail: "Test AI",
    },
    visionProvider: null,
    availableResumeTemplates: [],
    profile: state.profile,
    searchPreferences: state.searchPreferences,
    profileSetupState: state.profileSetupState,
    browserSession: {
      source: "target_site",
      status: "ready",
      driver: "catalog_seed",
      label: "Ready",
      detail: "Ready",
      lastCheckedAt: "2026-08-09T09:59:00.000Z",
    },
    sourceAccessPrompts: [],
    discoverySessions: [],
    discoveryRunState: "idle",
    activeDiscoveryRun: null,
    recentDiscoveryRuns: [],
    activeSourceDebugRun: null,
    recentSourceDebugRuns: [],
    discoveryJobs: [],
    dismissedDiscoveryJobs: [],
    selectedDiscoveryJobId: null,
    reviewQueue: [],
    selectedReviewJobId: null,
    tailoredAssets: [],
    resumeDrafts: [],
    resumeExportArtifacts: [],
    resumeResearchArtifacts: [],
    applyRuns: [],
    applyJobResults: [],
    applicationRecords: [],
    applicationAttempts: [],
    sourceInstructionArtifacts: [],
    latestResumeImportRun: null,
    latestResumeImportReviewCandidates: [],
    profileCopilotMessages: [],
    profileRevisions: [],
    selectedApplyRunId: null,
    selectedApplicationRecordId: null,
    settings: state.settings,
    userActionRequests: [],
    userActionEvents: [],
    campaigns: [campaign],
    activeCampaignId: campaign.id,
    dashboard: {
      generatedAt,
      activeCampaignId: campaign.id,
      activeCampaignCount: 1,
      jobsFoundToday: 0,
      jobsAwaitingReview: 0,
      applicationsReadyForApproval: 0,
      applicationsAppliedToday: 0,
      applicationsAppliedThisWeek: 0,
      needsYouCount: 0,
      upcomingInterviews: 0,
      upcomingFollowUps: 0,
      responseRate: null,
      interviewRate: null,
      sourceHealth: {
        healthy: 0,
        needsAttention: 0,
        running: 0,
        total: 0,
      },
      backgroundOperationCount: 0,
      recommendedNextAction: {
        label: "Review profile",
        detail: "Complete the profile before searching.",
        route: "/job-finder/profile",
      },
    },
    activityControl: { paused: false, pausedAt: null, reason: null },
  });
}

describe("job-finder Apply to all workspace updates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it.each(["completed", "failed"] as const)(
    "publishes a workspace update when background approval %s",
    async (outcome) => {
      const generatedAt = "2026-09-23T22:28:49.000Z";
      const staged = JobFinderWorkspaceSnapshotSchema.parse({
        ...createEmptyWorkspace(generatedAt),
        applyRuns: [
          {
            id: "run-1",
            mode: "queue_auto",
            state: "awaiting_submit_approval",
            jobIds: ["job-1"],
            createdAt: generatedAt,
            updatedAt: generatedAt,
            summary: "Waiting to start",
            detail: "Waiting to start",
          },
        ],
      });
      const repository = {
        listSavedJobs: vi
          .fn()
          .mockResolvedValue([
            { id: "job-1", resumeApplicationMode: "original_resume" },
          ]),
        getSettings: vi.fn().mockResolvedValue({
          applicationAutomationMode: "prepare_only",
          resumeApplicationMode: "original_resume",
        }),
        getSearchPreferences: vi.fn().mockResolvedValue({
          tailoringMode: "balanced",
        }),
        listApplyRuns: vi.fn(() =>
          Promise.resolve(runs.map((run) => ({ ...run }))),
        ),
      };
      // The press waits until the approved batch is running, then returns;
      // the rest of the batch finishes in the background.
      let runs: Array<(typeof staged.applyRuns)[number]> = [];
      mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue(
        repository as never,
      );
      mockGetJobFinderApplicationAuthorityService.mockReturnValue({
        list: vi.fn().mockResolvedValue([]),
      });

      let finishApproval!: (error?: Error) => void;
      const approval = new Promise<unknown>((resolve, reject) => {
        finishApproval = (error) => (error ? reject(error) : resolve(staged));
      });
      const approveApplyRun = vi.fn(() => {
        runs = runs.map((run) => ({ ...run, state: "running" as const }));
        return approval;
      });
      mockGetJobFinderWorkspaceService.mockResolvedValue({
        startAutoApplyQueueRun: vi.fn(() => {
          runs = [...staged.applyRuns];
          return Promise.resolve(staged);
        }),
        approveApplyRun,
        cancelApplyRun: vi.fn().mockResolvedValue(staged),
        getWorkspaceProjection: vi.fn().mockResolvedValue(staged),
      });
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const handlers = new Map<string, RegisteredHandler>();
      registerJobFinderRouteHandlers({
        handle: vi.fn((channel: string, handler: RegisteredHandler) => {
          handlers.set(channel, handler);
        }),
      } as unknown as IpcMain);
      const handler = handlers.get("job-finder:start-auto-apply-queue-run");
      if (!handler) throw new Error("Apply to all route was not registered.");
      const sender = { send: vi.fn(), isDestroyed: vi.fn(() => false) };

      await handler(
        { sender },
        { jobIds: ["job-1"], applicationAutomationMode: "prepare_only" },
      );
      expect(approveApplyRun).toHaveBeenCalledWith("run-1");
      expect(sender.send).not.toHaveBeenCalled();

      finishApproval(
        outcome === "failed" ? new Error("Approval failed") : undefined,
      );
      await vi.waitFor(() => {
        expect(sender.send).toHaveBeenCalledExactlyOnceWith(
          JOB_FINDER_WORKSPACE_UPDATED_CHANNEL,
        );
      });
      expect(consoleError).toHaveBeenCalledTimes(outcome === "failed" ? 1 : 0);
    },
  );
});

describe("job-finder resume import picker route", () => {
  let cancelImportResume: ((event: unknown, payload: unknown) => void) | null =
    null;

  function registerAndFindHandler(): RegisteredHandler {
    const handlers = new Map<string, RegisteredHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
      on: vi.fn(
        (
          channel: string,
          listener: (event: unknown, payload: unknown) => void,
        ) => {
          if (channel === "job-finder:cancel-import-resume") {
            cancelImportResume = listener;
          }
        },
      ),
      removeListener: vi.fn(),
    } as unknown as IpcMain;
    registerJobFinderRouteHandlers(ipcMain);

    const handler = handlers.get("job-finder:import-resume");
    if (!handler) {
      throw new Error("Resume import handler was not registered.");
    }
    return handler;
  }

  afterEach(() => {
    vi.clearAllMocks();
    mockBrowserWindowFromWebContents.mockReturnValue(null);
    cancelImportResume = null;
  });

  it("parents the picker to the invoking window and forwards valid progress", async () => {
    const snapshot = createEmptyWorkspace("2026-08-30T10:00:00.000Z");
    const parentWindow = {
      id: "main-window",
      focus: vi.fn(),
      isDestroyed: vi.fn(() => false),
      show: vi.fn(),
    };
    const sender = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    };
    mockBrowserWindowFromWebContents.mockReturnValue(parentWindow);
    mockShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/tmp/resume.pdf"],
    });
    mockImportResumeFromSourcePath.mockImplementation(
      (
        _sourcePath: string,
        options?: {
          onProgress?: (progress: unknown) => void;
        },
      ) => {
        options?.onProgress?.({
          stage: "saving_file",
          message: "Saving the selected resume.",
          occurredAt: "2026-08-30T10:00:01.000Z",
        });
        return Promise.resolve(snapshot);
      },
    );

    const result = await registerAndFindHandler()(
      { sender },
      { requestId: "resume_import_test" },
    );

    expect(mockBrowserWindowFromWebContents).toHaveBeenCalledWith(sender);
    expect(parentWindow.show).toHaveBeenCalledOnce();
    expect(parentWindow.focus).toHaveBeenCalledOnce();
    expect(mockShowOpenDialog).toHaveBeenCalledWith(
      parentWindow,
      expect.objectContaining({ properties: ["openFile"] }),
    );
    expect(sender.send).toHaveBeenCalledWith(
      "job-finder:resume-import-progress:resume_import_test",
      expect.objectContaining({ stage: "saving_file" }),
    );
    const importCall = mockImportResumeFromSourcePath.mock.calls.at(-1) as
      | [
          sourcePath: string,
          options: { onProgress?: (progress: unknown) => void },
        ]
      | undefined;
    expect(importCall?.[0]).toBe("/tmp/resume.pdf");
    expect(typeof importCall?.[1].onProgress).toBe("function");
    expect(answeredView(result)).toEqual(snapshot);
  });

  it("parses the request with its contract: a retry reads the stopped run, with no picker", async () => {
    const snapshot = createEmptyWorkspace("2026-08-30T10:00:30.000Z");
    const latestResumeImportRun = { id: "resume_import_cut_off" };
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      getWorkspaceProjection: vi
        .fn()
        .mockResolvedValue({ ...snapshot, latestResumeImportRun }),
    });
    mockRetryInterruptedResumeImport.mockResolvedValue(snapshot);
    const sender = { isDestroyed: vi.fn(() => false), send: vi.fn() };
    const handler = registerAndFindHandler();

    await expect(
      handler(
        { sender },
        { requestId: "resume_import_retry", retryInterrupted: true },
      ),
    ).resolves.toEqual(wholeViewAnswer(snapshot));
    expect(mockRetryInterruptedResumeImport).toHaveBeenCalledWith(
      latestResumeImportRun,
      expect.objectContaining({ onProgress: expect.any(Function) as unknown }),
    );
    expect(mockShowOpenDialog).not.toHaveBeenCalled();

    // An untyped flag is refused before anything runs.
    await expect(
      handler(
        { sender },
        { requestId: "resume_import_bad", retryInterrupted: "yes" },
      ),
    ).rejects.toThrow();
    expect(mockRetryInterruptedResumeImport).toHaveBeenCalledOnce();
    expect(mockShowOpenDialog).not.toHaveBeenCalled();
  });

  it("does not let a destroyed renderer abort persistence progress", async () => {
    const snapshot = createEmptyWorkspace("2026-08-30T10:01:00.000Z");
    const sender = {
      isDestroyed: vi.fn(() => true),
      send: vi.fn(),
    };
    mockShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/tmp/resume.pdf"],
    });
    mockImportResumeFromSourcePath.mockImplementation(
      (
        _sourcePath: string,
        options?: {
          onProgress?: (progress: unknown) => void;
        },
      ) => {
        options?.onProgress?.({
          stage: "saving_file",
          message: "Saving the selected resume.",
          occurredAt: "2026-08-30T10:01:01.000Z",
        });
        return Promise.resolve(snapshot);
      },
    );

    await expect(
      registerAndFindHandler()(
        { sender },
        { requestId: "resume_import_destroyed" },
      ),
    ).resolves.toEqual(wholeViewAnswer(snapshot));

    expect(sender.send).not.toHaveBeenCalled();
    expect(mockImportResumeFromSourcePath).toHaveBeenCalledOnce();
  });

  it("R3-163 cancels only the active processing import request", async () => {
    const snapshot = createEmptyWorkspace("2026-08-30T10:02:00.000Z");
    const sender = { isDestroyed: vi.fn(() => false), send: vi.fn() };
    const captured: { signal: AbortSignal | undefined } = {
      signal: undefined,
    };
    mockShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/tmp/synthetic-resume.md"],
    });
    mockImportResumeFromSourcePath.mockImplementation(
      (_path: string, options: { signal?: AbortSignal }) => {
        captured.signal = options.signal;
        return new Promise((resolve) => {
          captured.signal?.addEventListener("abort", () => resolve(snapshot), {
            once: true,
          });
        });
      },
    );
    const result = registerAndFindHandler()(
      { sender },
      { requestId: "processing_import" },
    );
    await vi.waitFor(() =>
      expect(mockImportResumeFromSourcePath).toHaveBeenCalled(),
    );
    cancelImportResume?.({ sender }, { requestId: "other_import" });
    expect(captured.signal?.aborted).toBe(false);
    cancelImportResume?.({ sender }, { requestId: "processing_import" });
    expect(captured.signal?.aborted).toBe(false);
    cancelImportResume?.(
      { sender },
      { requestId: "processing_import", stopProcessing: true },
    );
    expect(captured.signal?.aborted).toBe(true);
    await expect(result).resolves.toEqual(wholeViewAnswer(snapshot));
  });

  it("discards a late file choice after the renderer cancels the picker", async () => {
    const snapshot = createEmptyWorkspace("2026-08-30T10:02:00.000Z");
    const sender = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    };
    let resolvePicker!: (selection: {
      canceled: boolean;
      filePaths: string[];
    }) => void;
    mockShowOpenDialog.mockReturnValue(
      new Promise((resolve) => {
        resolvePicker = resolve;
      }),
    );
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      getWorkspaceProjection: vi.fn().mockResolvedValue(snapshot),
    });

    const importPromise = registerAndFindHandler()(
      { sender },
      { requestId: "resume_import_cancelled" },
    );
    await Promise.resolve();
    expect(cancelImportResume).toEqual(expect.any(Function));

    cancelImportResume?.({ sender }, { requestId: "resume_import_cancelled" });
    resolvePicker({ canceled: false, filePaths: ["/tmp/late-resume.pdf"] });

    await expect(importPromise).resolves.toEqual(wholeViewAnswer(snapshot));
    expect(mockImportResumeFromSourcePath).not.toHaveBeenCalled();
  });
});

describe("single application live workspace updates", () => {
  beforeEach(() => {
    mockGetJobFinderApplicationAuthorityService.mockReturnValue({
      list: vi.fn().mockResolvedValue([]),
      revoke: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue(null);
  });

  it.each([
    ["job-finder:start-apply-copilot-run", "startApplyCopilotRun"],
    ["job-finder:start-auto-apply-run", "startAutoApplyRun"],
  ])(
    "publishes progress while %s waits and stops after completion",
    async (channel, method) => {
      vi.useFakeTimers();
      let complete!: (value: ReturnType<typeof createEmptyWorkspace>) => void;
      const operation = new Promise<ReturnType<typeof createEmptyWorkspace>>(
        (resolve) => {
          complete = resolve;
        },
      );
      const start = vi.fn(() => operation);
      mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue({
        listSavedJobs: vi
          .fn()
          .mockResolvedValue([
            { id: "job-1", resumeApplicationMode: "original_resume" },
          ]),
        getSettings: vi
          .fn()
          .mockResolvedValue({ applicationAutomationMode: "prepare_only" }),
        getSearchPreferences: vi
          .fn()
          .mockResolvedValue({ tailoringMode: "balanced" }),
      } as never);
      mockGetJobFinderWorkspaceService.mockResolvedValue({ [method]: start });
      const handlers = new Map<string, RegisteredHandler>();
      registerJobFinderRouteHandlers({
        handle: vi.fn((key: string, handler: RegisteredHandler) => {
          handlers.set(key, handler);
        }),
      } as unknown as IpcMain);
      const send = vi.fn();
      const response = handlers.get(channel)!(
        { sender: { send } },
        { jobId: "job-1" },
      );
      await vi.advanceTimersByTimeAsync(3_000);
      expect(start).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(JOB_FINDER_WORKSPACE_UPDATED_CHANNEL);
      complete(createEmptyWorkspace("2026-09-26T10:00:00.000Z"));
      await response;
      // One push within a second of the start, one beat at 3 s, one at the end.
      expect(send).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(send).toHaveBeenCalledTimes(3);
    },
  );

  it("publishes fit scores while Judge fit waits on the model", async () => {
    vi.useFakeTimers();
    let complete!: (value: ReturnType<typeof createEmptyWorkspace>) => void;
    const judge = vi.fn(
      () =>
        new Promise<ReturnType<typeof createEmptyWorkspace>>((resolve) => {
          complete = resolve;
        }),
    );
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      judgeUnjudgedJobs: judge,
    });
    const handlers = new Map<string, RegisteredHandler>();
    registerJobFinderRouteHandlers({
      handle: vi.fn((key: string, handler: RegisteredHandler) => {
        handlers.set(key, handler);
      }),
    } as unknown as IpcMain);
    const send = vi.fn();
    const response = handlers.get("job-finder:judge-unjudged-jobs")!(
      { sender: { send } },
      undefined,
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(judge).toHaveBeenCalledTimes(1);
    // Within a second of the start and on the 3 s beat, before it finishes.
    expect(send).toHaveBeenCalledTimes(2);
    complete(createEmptyWorkspace("2026-09-26T10:00:00.000Z"));
    await response;
    const sent = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(send).toHaveBeenCalledTimes(sent);
  });

  it.each([false, true])(
    "cleans up a rejected preparation with destroyed sender=%s",
    async (destroyed) => {
      vi.useFakeTimers();
      let fail!: (error: Error) => void;
      const operation = new Promise<never>((_resolve, reject) => {
        fail = reject;
      });
      mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue({
        listSavedJobs: vi
          .fn()
          .mockResolvedValue([
            { id: "job-1", resumeApplicationMode: "original_resume" },
          ]),
        getSettings: vi
          .fn()
          .mockResolvedValue({ applicationAutomationMode: "prepare_only" }),
        getSearchPreferences: vi
          .fn()
          .mockResolvedValue({ tailoringMode: "balanced" }),
      } as never);
      mockGetJobFinderWorkspaceService.mockResolvedValue({
        startApplyCopilotRun: () => operation,
      });
      const handlers = new Map<string, RegisteredHandler>();
      registerJobFinderRouteHandlers({
        handle: vi.fn((key: string, handler: RegisteredHandler) => {
          handlers.set(key, handler);
        }),
      } as unknown as IpcMain);
      const send = vi.fn();
      const response = handlers.get("job-finder:start-apply-copilot-run")!(
        { sender: { send, isDestroyed: () => destroyed } },
        { jobId: "job-1" },
      );
      const rejected = expect(response).rejects.toThrow("Preparation failed");
      await vi.advanceTimersByTimeAsync(3_000);
      fail(new Error("Preparation failed"));
      await rejected;
      expect(send).toHaveBeenCalledTimes(destroyed ? 0 : 3);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(send).toHaveBeenCalledTimes(destroyed ? 0 : 3);
    },
  );
});

describe("job-finder apply entry-point resume approval and authority", () => {
  afterEach(() => {
    mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue(null);
    mockGetJobFinderApplicationAuthorityService.mockReset();
  });

  it.each(["prepare_only", "confirm_before_submit"] as const)(
    "preserves pay privacy when starting Fill-in only from %s",
    async (priorMode) => {
      const repository = {
        getSettings: vi.fn(() =>
          Promise.resolve({
            applicationAutomationMode: "prepare_only",
          }),
        ),
      };
      const active = {
        id: "existing_authority",
        revision: 1,
        mode: priorMode,
        maxApplicationsPerRun: 10,
        maxApplicationsPerLocalDay: 20,
        decisionPolicy: {
          answerPolicy: { salaryDisclosure: "answer_from_profile" },
        },
      };
      const authorityService = {
        list: vi.fn(() => Promise.resolve([active])),
        replaceUsed: vi.fn(() => Promise.resolve({ status: "applied" })),
        revoke: vi.fn(() => Promise.resolve({ status: "applied" })),
      };
      mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue(
        repository as never,
      );
      mockGetJobFinderApplicationAuthorityService.mockReturnValue(
        authorityService,
      );
      await syncApplicationAuthorityForSavedMode({} as never, ["job"]);
      expect(authorityService.replaceUsed).not.toHaveBeenCalled();
      if (priorMode === "prepare_only") {
        expect(authorityService.revoke).not.toHaveBeenCalled();
      } else {
        expect(authorityService.revoke).toHaveBeenCalledWith({
          id: active.id,
          expectedRevision: active.revision,
        });
      }
    },
  );

  it("keeps the pay choice when changing to Ask before sending without carrying over old job scope", async () => {
    const job = {
      id: "new_job",
      title: "Synthetic Analyst",
      resumeApplicationMode: "original_resume",
      applicationUrl: "https://jobs.example.test/new_job",
    };
    const repository = {
      getSettings: vi.fn(() =>
        Promise.resolve({
          applicationAutomationMode: "confirm_before_submit",
        }),
      ),
      getProfileWithRevision: vi.fn(() =>
        Promise.resolve({
          revision: 1,
          profile: { baseResume: { sha256: "a".repeat(64) } },
        }),
      ),
      listSavedJobs: vi.fn(() => Promise.resolve([job])),
    };
    const active = {
      id: "existing_authority",
      revision: 1,
      mode: "prepare_only",
      scope: { campaignId: null, jobIds: ["old_job"] },
      decisionPolicy: {
        answerPolicy: { salaryDisclosure: "answer_from_profile" },
      },
    };
    const authorityService = {
      list: vi.fn(() => Promise.resolve([active])),
      approveCurrentAnswers: vi.fn(() =>
        Promise.resolve({ status: "created" }),
      ),
      update: vi.fn(() => Promise.resolve({ status: "applied" })),
    };
    mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue(
      repository as never,
    );
    mockGetJobFinderApplicationAuthorityService.mockReturnValue(
      authorityService,
    );
    await syncApplicationAuthorityForSavedMode({} as never, [job.id]);
    expect(authorityService.update).toHaveBeenCalledWith(
      expect.objectContaining({
        salaryDisclosure: "answer_from_profile",
        mode: "confirm_before_submit",
        scope: { campaignId: null, jobIds: [job.id] },
      }),
    );
  });

  it.each(
    (
      ["prepare_only", "confirm_before_submit", "autonomous_submit"] as const
    ).flatMap((mode) =>
      (["queue", "retry", "resume_consent"] as const).map(
        (entryPoint) => [mode, entryPoint] as const,
      ),
    ),
  )(
    "exports and approves a fresh tailored resume before starting %s via %s",
    async (applicationAutomationMode, entryPoint) => {
      const callOrder: string[] = [];
      let exportCreated = false;
      let approved = false;
      const job = {
        id: "job_batch",
        title: "Batch Engineer",
        company: "Example",
        source: "target_site",
        canonicalUrl: "https://jobs.example.test/jobs/1",
        applicationUrl: "https://apply.example.test/apply/1",
        resumeApplicationMode: "tailored_per_job",
        resumeTailoringMode: "balanced",
      };
      const exportArtifact = {
        id: "export_batch",
        jobId: job.id,
        draftId: "draft_batch",
        exportedAt: "2026-09-22T16:00:00.000Z",
        filePath: path.resolve("package.json"),
        isApproved: false,
        sha256: "a".repeat(64),
      };
      const repository = {
        getProfileWithRevision: vi.fn().mockResolvedValue({
          profile: {
            baseResume: { sha256: "b".repeat(64) },
          },
          revision: 1,
        }),
        getSearchPreferences: vi.fn().mockResolvedValue({
          tailoringMode: "balanced",
        }),
        getSettings: vi.fn().mockResolvedValue({
          applicationAutomationMode:
            entryPoint === "resume_consent"
              ? applicationAutomationMode === "prepare_only"
                ? "autonomous_submit"
                : "prepare_only"
              : applicationAutomationMode,
          maxApplicationsPerLocalDay: 20,
          resumeApplicationMode: "tailored_per_job",
        }),
        listResumeExportArtifacts: vi
          .fn()
          .mockImplementation(() =>
            Promise.resolve(
              approved ? [{ ...exportArtifact, isApproved: true }] : [],
            ),
          ),
        listSavedJobs: vi.fn().mockResolvedValue([job]),
        listApplicationRecords: vi.fn().mockResolvedValue([
          {
            id: "existing_application",
            jobId: job.id,
            automationMode: applicationAutomationMode,
          },
        ]),
        listApplyRuns: vi.fn().mockResolvedValue([]),
      };
      const workspace = () => ({
        draft: {
          id: "draft_batch",
          jobId: job.id,
          status: approved ? "approved" : "needs_review",
          approvedExportId: approved ? exportArtifact.id : null,
        },
        exports: exportCreated
          ? [{ ...exportArtifact, isApproved: approved }]
          : [],
        job,
      });
      const startAutoApplyQueueRun = vi.fn().mockImplementation(() => {
        callOrder.push("start");
        return Promise.resolve(
          createEmptyWorkspace("2026-09-22T16:01:00.000Z"),
        );
      });
      const workspaceService = {
        approveResume: vi.fn().mockImplementation(() => {
          callOrder.push("approve");
          approved = true;
          return Promise.resolve(
            createEmptyWorkspace("2026-09-22T16:00:30.000Z"),
          );
        }),
        exportResumePdf: vi.fn().mockImplementation(() => {
          callOrder.push("export");
          exportCreated = true;
          return Promise.resolve(
            createEmptyWorkspace("2026-09-22T16:00:15.000Z"),
          );
        }),
        getResumeWorkspace: vi
          .fn()
          .mockImplementation(() => Promise.resolve(workspace())),
        getWorkspaceProjection: vi
          .fn()
          .mockResolvedValue(createEmptyWorkspace("2026-09-22T16:01:01.000Z")),
        startAutoApplyQueueRun,
        startApplyCopilotRun: startAutoApplyQueueRun,
        resolveApplyConsentRequest: vi.fn().mockImplementation(() => {
          callOrder.push("resolve");
          return Promise.resolve(
            createEmptyWorkspace("2026-09-22T16:01:00.000Z"),
          );
        }),
        getApplyRunDetails: vi.fn().mockResolvedValue({
          run: { mode: "copilot" },
          consentRequests: [
            { id: "resume_consent", kind: "resume_use", status: "pending" },
          ],
        }),
      };
      const authorityService = {
        approveCurrentAnswers: vi.fn().mockImplementation(() => {
          callOrder.push("answers");
          return Promise.resolve({ status: "created" });
        }),
        create: vi.fn().mockImplementation(() => {
          callOrder.push("authority");
          return Promise.resolve({ status: "applied" });
        }),
        list: vi.fn().mockResolvedValue([]),
        revoke: vi.fn(),
        update: vi.fn(),
      };
      mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue(
        repository as never,
      );
      mockGetJobFinderApplicationAuthorityService.mockReturnValue(
        authorityService,
      );
      mockGetJobFinderWorkspaceService.mockResolvedValue(workspaceService);

      const handlers = new Map<string, RegisteredHandler>();
      registerJobFinderRouteHandlers({
        handle: vi.fn((channel: string, handler: RegisteredHandler) => {
          handlers.set(channel, handler);
        }),
      } as unknown as IpcMain);
      const handler = handlers.get(
        entryPoint === "queue"
          ? "job-finder:start-auto-apply-queue-run"
          : entryPoint === "retry"
            ? "job-finder:start-apply-copilot-run"
            : "job-finder:resolve-apply-consent-request",
      );
      if (!handler) throw new Error("Apply to all route was not registered.");

      const payload =
        entryPoint === "queue"
          ? { jobIds: [job.id], applicationAutomationMode }
          : entryPoint === "retry"
            ? { jobId: job.id, applicationRecordId: "existing_application" }
            : {
                jobId: job.id,
                applicationRecordId: "existing_application",
                runId: "existing_run",
                requestId: "resume_consent",
                action: "approve",
              };
      await handler({ sender: {} }, payload);

      expect(callOrder.slice(0, 2)).toEqual(["export", "approve"]);
      if (entryPoint === "queue") {
        expect(startAutoApplyQueueRun).toHaveBeenCalledWith(
          [job.id],
          applicationAutomationMode,
        );
      } else if (entryPoint === "retry") {
        expect(startAutoApplyQueueRun).toHaveBeenCalledWith(
          job.id,
          { visualCheckpointsEnabled: false },
          "existing_application",
        );
      } else {
        expect(
          workspaceService.resolveApplyConsentRequest,
        ).toHaveBeenCalledWith("resume_consent", "approve");
        expect(startAutoApplyQueueRun).toHaveBeenCalledWith(
          job.id,
          undefined,
          "existing_application",
        );
      }
      expect(callOrder.at(-1)).toBe("start");
      // A press approves Light/Tailored only. An unreviewed Aggressive draft
      // must not be exported or started through any of these entry points.
      approved = false;
      job.resumeTailoringMode = "aggressive";
      await expect(handler({ sender: {} }, payload)).rejects.toThrow(
        "Read and approve the Aggressive resume",
      );
      expect(startAutoApplyQueueRun).toHaveBeenCalledTimes(1);
      expect(workspaceService.exportResumePdf).toHaveBeenCalledTimes(1);
      approved = true;
      job.resumeTailoringMode = "balanced";
      if (applicationAutomationMode === "prepare_only") {
        expect(authorityService.create).not.toHaveBeenCalled();
      } else {
        expect(authorityService.create).toHaveBeenCalledWith(
          expect.objectContaining({
            mode: applicationAutomationMode,
            scope: { campaignId: null, jobIds: [job.id] },
            allowedResumeSha256: [exportArtifact.sha256],
          }),
        );
        expect(callOrder).toEqual([
          "export",
          "approve",
          "answers",
          "authority",
          ...(entryPoint === "resume_consent" ? ["resolve"] : []),
          "start",
        ]);
        if (applicationAutomationMode === "autonomous_submit") {
          job.applicationUrl = "not-an-application-url";
          job.canonicalUrl = "not-a-listing-url";
          await expect(handler({ sender: {} }, payload)).rejects.toThrow(
            "application site",
          );
          expect(startAutoApplyQueueRun).toHaveBeenCalledTimes(1);
        }
      }

      // A deleted PDF must be rebuilt from the already-approved draft,
      // including approved Aggressive content, rather than looping through
      // the same missing-resume handoff on every retry or consent approval.
      job.applicationUrl = "https://apply.example.test/apply/1";
      job.canonicalUrl = "https://jobs.example.test/jobs/1";
      job.resumeTailoringMode = "aggressive";
      exportArtifact.filePath = path.join(
        os.tmpdir(),
        "nestor-missing-approved-pdf",
        `${applicationAutomationMode}-${entryPoint}.pdf`,
      );
      callOrder.length = 0;
      await handler({ sender: {} }, payload);
      expect(callOrder.slice(0, 2)).toEqual(["export", "approve"]);
      expect(workspaceService.exportResumePdf).toHaveBeenCalledTimes(2);
      expect(workspaceService.approveResume).toHaveBeenCalledTimes(2);
      expect(startAutoApplyQueueRun).toHaveBeenCalledTimes(2);
    },
  );
});

describe("job-finder Apply to all with a resume that waits on the person", () => {
  function setup(undecidedJobIds: readonly string[]) {
    const jobs = ["job_cedar", "job_dusk"].map((id) => ({
      id,
      title: id === "job_cedar" ? "Cedar Engineer" : "Dusk Engineer",
      company: "Example",
      source: "target_site",
      canonicalUrl: `https://jobs.example.test/${id}`,
      applicationUrl: `https://apply.example.test/${id}`,
      resumeApplicationMode: "tailored_per_job",
      resumeTailoringMode: "balanced",
    }));
    const exported = new Set<string>();
    const repository = {
      getProfileWithRevision: vi.fn().mockResolvedValue({
        profile: { baseResume: { sha256: "b".repeat(64) } },
        revision: 1,
      }),
      getSearchPreferences: vi
        .fn()
        .mockResolvedValue({ tailoringMode: "balanced" }),
      getSettings: vi.fn().mockResolvedValue({
        applicationAutomationMode: "prepare_only",
        maxApplicationsPerLocalDay: 20,
        resumeApplicationMode: "tailored_per_job",
      }),
      listResumeExportArtifacts: vi.fn().mockResolvedValue([]),
      listSavedJobs: vi.fn().mockResolvedValue(jobs),
      listApplicationRecords: vi.fn().mockResolvedValue([]),
      listApplyRuns: vi.fn().mockResolvedValue([]),
    };
    const startAutoApplyQueueRun = vi
      .fn()
      .mockResolvedValue(createEmptyWorkspace("2026-09-22T16:01:00.000Z"));
    const workspaceService = {
      approveResume: vi
        .fn()
        .mockResolvedValue(createEmptyWorkspace("2026-09-22T16:00:30.000Z")),
      exportResumePdf: vi.fn().mockImplementation((jobId: string) => {
        if (undecidedJobIds.includes(jobId)) {
          return Promise.reject(
            new Error(
              "Some lines in this resume still need your decision before it can be exported. Open the resume: they are listed under Lines to confirm.",
            ),
          );
        }
        exported.add(jobId);
        return Promise.resolve(
          createEmptyWorkspace("2026-09-22T16:00:15.000Z"),
        );
      }),
      getResumeWorkspace: vi.fn().mockImplementation((jobId: string) =>
        Promise.resolve({
          draft: {
            id: `draft_${jobId}`,
            jobId,
            status: "needs_review",
            approvedExportId: null,
          },
          exports: exported.has(jobId)
            ? [
                {
                  id: `export_${jobId}`,
                  jobId,
                  draftId: `draft_${jobId}`,
                  exportedAt: "2026-09-22T16:00:00.000Z",
                  filePath: path.resolve("package.json"),
                  isApproved: false,
                  sha256: "a".repeat(64),
                },
              ]
            : [],
        }),
      ),
      getWorkspaceProjection: vi
        .fn()
        .mockResolvedValue(createEmptyWorkspace("2026-09-22T16:01:01.000Z")),
      startAutoApplyQueueRun,
    };
    mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue(
      repository as never,
    );
    mockGetJobFinderApplicationAuthorityService.mockReturnValue({
      approveCurrentAnswers: vi.fn(),
      create: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      revoke: vi.fn(),
      update: vi.fn(),
    });
    mockGetJobFinderWorkspaceService.mockResolvedValue(workspaceService);
    const handlers = new Map<string, RegisteredHandler>();
    registerJobFinderRouteHandlers({
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain);
    const handler = handlers.get("job-finder:start-auto-apply-queue-run");
    if (!handler) throw new Error("Apply to all route was not registered.");
    return { handler, startAutoApplyQueueRun };
  }

  it("starts the ready job and holds back only the one with a line to decide", async () => {
    const { handler, startAutoApplyQueueRun } = setup(["job_cedar"]);
    await handler(
      { sender: {} },
      {
        jobIds: ["job_cedar", "job_dusk"],
        applicationAutomationMode: "prepare_only",
      },
    );
    expect(startAutoApplyQueueRun).toHaveBeenCalledWith(
      ["job_dusk"],
      "prepare_only",
    );
  });

  it("refuses with a sentence naming the job when every resume waits on the person", async () => {
    const { handler, startAutoApplyQueueRun } = setup(["job_cedar"]);
    await expect(
      handler(
        { sender: {} },
        { jobIds: ["job_cedar"], applicationAutomationMode: "prepare_only" },
      ),
    ).rejects.toThrow(
      "Nothing was started. The resume for 'Cedar Engineer' has a line waiting for your decision.",
    );
    expect(startAutoApplyQueueRun).not.toHaveBeenCalled();
  });
});

describe("bulk resume approval", () => {
  it("bounds concurrent approvals, deduplicates jobs and keeps failures local", async () => {
    const jobs = ["one", "two", "three", "four"].map((id) => ({
      id,
      title: id,
    }));
    mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue({
      listSavedJobs: () => Promise.resolve(jobs),
      getSettings: () => Promise.resolve({}),
      getSearchPreferences: () =>
        Promise.resolve({ tailoringMode: "aggressive" }),
    } as never);
    let active = 0;
    let maximum = 0;
    const approve = vi.fn(async (id: string) => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (id === "two") throw new Error("Some lines still need your decision.");
    });
    const service = {
      getResumeWorkspace: () =>
        Promise.resolve({
          draft: { id: "draft", status: "needs_review" },
          exports: [],
        }),
      approveCurrentResume: approve,
    };
    const progress = vi.fn<(done: number) => void>();
    const heldBack = await approveApplicationResumes(
      service as never,
      [...jobs.map((j) => j.id), "one"],
      { personApproved: true, onProgress: progress },
    );
    expect(maximum).toBe(2);
    expect(approve).toHaveBeenCalledTimes(4);
    expect(heldBack).toEqual([
      {
        jobId: "two",
        title: "two",
        reason: "The resume for 'two' has a line waiting for your decision.",
      },
    ]);
    expect(progress.mock.calls.map((c) => c[0])).toEqual([1, 2, 3, 4]);
  });
});

describe("job-finder resume Assistant edits", () => {
  it("refuses new writes to the retired resume chat (ADR 0037)", async () => {
    const resolve = vi.fn().mockResolvedValue([]);
    const send = vi.fn().mockResolvedValue([]);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      resolveResumeAssistantProposal: resolve,
      sendResumeAssistantMessage: send,
    });
    const handlers = new Map<string, RegisteredHandler>();
    registerJobFinderRouteHandlers({
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain);
    const sender = { send: vi.fn(), isDestroyed: () => false };
    await expect(
      handlers.get("job-finder:resolve-resume-assistant-proposal")!(
        { sender },
        {
          jobId: "job_paper",
          proposalId: "proposal_1",
          action: "accept",
          patchIds: ["patch_1"],
        },
      ),
    ).rejects.toThrow(RETIRED_CHAT_MESSAGE);
    await expect(
      handlers.get("job-finder:send-resume-assistant-message")!(
        { sender },
        { jobId: "job_paper", content: "Tighten the summary." },
      ),
    ).rejects.toThrow(RETIRED_CHAT_MESSAGE);
    expect(resolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("job-finder sending a form prepared earlier", () => {
  it.each(["autonomous_submit", "prepare_only"] as const)(
    "under %s, scopes one permission to the pressed jobs before sending each",
    async (applicationAutomationMode) => {
      const callOrder: string[] = [];
      const job = {
        id: "job_ready",
        title: "Ready Engineer",
        company: "Example",
        source: "target_site",
        canonicalUrl: "https://jobs.example.test/jobs/1",
        applicationUrl: "https://apply.example.test/apply/1",
        resumeApplicationMode: "tailored_per_job",
        resumeTailoringMode: "balanced",
      };
      const repository = {
        getProfileWithRevision: vi.fn().mockResolvedValue({
          profile: { baseResume: { sha256: "b".repeat(64) } },
          revision: 1,
        }),
        getSettings: vi.fn().mockResolvedValue({
          applicationAutomationMode,
          maxApplicationsPerLocalDay: 20,
          resumeApplicationMode: "tailored_per_job",
        }),
        listResumeExportArtifacts: vi.fn().mockResolvedValue([
          {
            id: "export_ready",
            jobId: job.id,
            exportedAt: "2026-09-22T16:00:00.000Z",
            isApproved: true,
            sha256: "a".repeat(64),
          },
        ]),
        listSavedJobs: vi
          .fn()
          .mockResolvedValue([job, { ...job, id: "job_other" }]),
        // Both forms were filled in by one run of three jobs.
        listApplyRuns: vi
          .fn()
          .mockResolvedValue([
            { id: "run_prepared", jobIds: [job.id, "job_other", "job_third"] },
          ]),
        listApplyJobResults: vi.fn().mockResolvedValue([
          {
            id: "result_a",
            runId: "run_prepared",
            jobId: job.id,
            state: "awaiting_review",
            updatedAt: "2026-09-22T16:00:00.000Z",
          },
          {
            id: "result_b",
            runId: "run_prepared",
            jobId: "job_other",
            state: "awaiting_review",
            updatedAt: "2026-09-22T16:00:00.000Z",
          },
        ]),
      };
      const workspaceService = {
        submitPreparedApplication: vi.fn().mockImplementation(() => {
          callOrder.push("send");
          return Promise.resolve(
            createEmptyWorkspace("2026-09-22T16:01:00.000Z"),
          );
        }),
      };
      const authorityService = {
        approveCurrentAnswers: vi.fn().mockResolvedValue({ status: "created" }),
        create: vi.fn().mockImplementation(() => {
          callOrder.push("authority");
          return Promise.resolve({ status: "applied" });
        }),
        list: vi.fn().mockResolvedValue([]),
        revoke: vi.fn(),
        update: vi.fn(),
      };
      mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue(
        repository as never,
      );
      mockGetJobFinderApplicationAuthorityService.mockReturnValue(
        authorityService,
      );
      mockGetJobFinderWorkspaceService.mockResolvedValue(workspaceService);
      const handlers = new Map<string, RegisteredHandler>();
      registerJobFinderRouteHandlers({
        handle: vi.fn((channel: string, handler: RegisteredHandler) => {
          handlers.set(channel, handler);
        }),
      } as unknown as IpcMain);

      await handlers.get("job-finder:send-prepared-applications")!(
        { sender: {} },
        { jobIds: [job.id, "job_other"] },
      );

      expect(callOrder).toEqual(
        applicationAutomationMode === "prepare_only"
          ? ["send", "send"]
          : ["authority", "send", "send"],
      );
      expect(workspaceService.submitPreparedApplication).toHaveBeenCalledWith(
        "job_other",
      );
      if (applicationAutomationMode !== "prepare_only") {
        // One permission for the press, sized for the run the forms came
        // from: a permission for one send stopped the second one with
        // "Remaining per-run capacity is exhausted".
        expect(authorityService.create).toHaveBeenCalledTimes(1);
        expect(authorityService.create).toHaveBeenCalledWith(
          expect.objectContaining({
            mode: "autonomous_submit",
            scope: { campaignId: null, jobIds: [job.id, "job_other"] },
            maxApplicationsPerRun: 3,
          }),
        );
      }
    },
  );
});

describe("job-finder sending forms that already went out", () => {
  it("says there is nothing left to send instead of sending again", async () => {
    const repository = {
      getSettings: vi.fn().mockResolvedValue({
        applicationAutomationMode: "autonomous_submit",
      }),
      listApplyJobResults: vi.fn().mockResolvedValue([
        {
          id: "result_old",
          runId: "run_prepared",
          jobId: "job_sent",
          state: "awaiting_review",
          updatedAt: "2026-09-22T16:00:00.000Z",
        },
        {
          id: "result_new",
          runId: "run_prepared",
          jobId: "job_sent",
          state: "submitted",
          updatedAt: "2026-09-22T16:05:00.000Z",
        },
      ]),
    };
    const workspaceService = { submitPreparedApplication: vi.fn() };
    mockGetJobFinderRepositoryForWorkspaceService.mockReturnValueOnce(
      repository as never,
    );
    mockGetJobFinderWorkspaceService.mockResolvedValue(workspaceService);
    const handlers = new Map<string, RegisteredHandler>();
    registerJobFinderRouteHandlers({
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain);

    await expect(
      handlers.get("job-finder:send-prepared-applications")!(
        { sender: {} },
        { jobIds: ["job_sent"] },
      ),
    ).rejects.toThrow(/Nothing left to send/);
    expect(workspaceService.submitPreparedApplication).not.toHaveBeenCalled();
  });
});

describe("job-finder application packet export route", () => {
  let temporaryDirectory: string;
  let exportHandler: RegisteredHandler;
  let resumePdfExportHandler: RegisteredHandler;
  let bootstrapHandler: RegisteredHandler;
  let syncHandler: RegisteredHandler;
  let entityMutationHandler: RegisteredHandler;
  let profileCopilotHandler: RegisteredHandler;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-application-packet-"),
    );
    mockBuildApplicationPacket.mockResolvedValue(packet);
    mockGetWorkspaceProjection.mockResolvedValue(
      createEmptyWorkspace("2026-08-09T10:00:00.000Z"),
    );
    mockGetWorkspaceBootstrap.mockResolvedValue(
      createEmptyWorkspace("2026-08-09T09:59:00.000Z"),
    );
    mockQueueJobForReview.mockResolvedValue(
      createEmptyWorkspace("2026-08-09T10:01:00.000Z"),
    );
    mockExportResumePdf.mockResolvedValue(
      createEmptyWorkspace("2026-08-09T10:02:00.000Z"),
    );
    mockGetResumeWorkspace.mockResolvedValue({
      job: { title: "Staff Engineer", company: "Example" },
      // The export route names the file from how the draft was produced, so
      // the double has to carry a draft the way the real workspace does.
      draft: { generationMethod: "ai" },
      tailoredAsset: null,
    });
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      buildApplicationPacket: mockBuildApplicationPacket,
      exportResumePdf: mockExportResumePdf,
      getResumeWorkspace: mockGetResumeWorkspace,
      getWorkspaceBootstrap: mockGetWorkspaceBootstrap,
      getWorkspaceProjection: mockGetWorkspaceProjection,
      proposeProfileCopilotChange: mockProposeProfileCopilotChange,
      queueJobForReview: mockQueueJobForReview,
    });

    const handlers = new Map<string, RegisteredHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;

    registerJobFinderRouteHandlers(ipcMain);
    const registeredHandler = handlers.get(
      "job-finder:export-application-packet",
    );
    if (!registeredHandler) {
      throw new Error("Application packet export handler was not registered.");
    }
    exportHandler = registeredHandler;
    const registeredResumePdfHandler = handlers.get(
      "job-finder:export-resume-pdf",
    );
    if (!registeredResumePdfHandler) {
      throw new Error("Resume PDF export handler was not registered.");
    }
    resumePdfExportHandler = registeredResumePdfHandler;
    const registeredBootstrapHandler = handlers.get(
      "job-finder:get-workspace-bootstrap",
    );
    const registeredSyncHandler = handlers.get("job-finder:sync-workspace");
    const registeredEntityMutationHandler = handlers.get(
      "job-finder:mutate-workspace-entities",
    );
    const registeredProfileCopilotHandler = handlers.get(
      "job-finder:send-profile-copilot-message",
    );
    if (
      !registeredSyncHandler ||
      !registeredEntityMutationHandler ||
      !registeredProfileCopilotHandler ||
      !registeredBootstrapHandler
    ) {
      throw new Error("Workspace delta handlers were not registered.");
    }
    syncHandler = registeredSyncHandler;
    entityMutationHandler = registeredEntityMutationHandler;
    profileCopilotHandler = registeredProfileCopilotHandler;
    bootstrapHandler = registeredBootstrapHandler;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(temporaryDirectory, { force: true, recursive: true });
  });

  it("serves the shell-safe workspace bootstrap through its dedicated route", async () => {
    const result = await bootstrapHandler({ sender: {} }, undefined);

    expect(result).toMatchObject({
      module: "job-finder",
      generatedAt: "2026-08-09T09:59:00.000Z",
    });
    expect(mockGetWorkspaceBootstrap).toHaveBeenCalledTimes(1);
  });

  it("returns cancelled without writing when the save dialog is cancelled", async () => {
    mockShowSaveDialog.mockResolvedValue({
      canceled: true,
      filePath: undefined,
    });

    const result = await exportHandler(
      { sender: {} },
      {
        runId: "run-1",
        jobId: "job-1",
        applicationRecordId: "application-1",
      },
    );

    expect(result).toEqual({ status: "cancelled" });
    expect(mockBuildApplicationPacket).toHaveBeenCalledWith(
      "run-1",
      "job-1",
      "application-1",
    );
    await expect(readdir(temporaryDirectory)).resolves.toEqual([]);
  });

  it("tells the person a cancelled resume export saved nothing", async () => {
    mockShowSaveDialog.mockResolvedValue({
      canceled: true,
      filePath: undefined,
    });

    const result = (await resumePdfExportHandler(
      { sender: {} },
      { intent: "download", jobId: "job-1" },
    )) as { outcome: string; outputPath: string | null };

    expect(result.outcome).toBe("cancelled");
    expect(result.outputPath).toBeNull();
    expect(mockExportResumePdf).not.toHaveBeenCalled();
  });

  it("reports where a saved resume PDF went", async () => {
    const selectedPath = path.join(temporaryDirectory, "resume");
    mockShowSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: selectedPath,
    });

    const result = (await resumePdfExportHandler(
      { sender: {} },
      { intent: "download", jobId: "job-1" },
    )) as { outcome: string; outputPath: string | null };

    expect(result.outcome).toBe("saved");
    expect(result.outputPath).toBe(`${selectedPath}.pdf`);
    expect(mockExportResumePdf).toHaveBeenCalledWith(
      "job-1",
      `${selectedPath}.pdf`,
    );
  });

  it("writes the exact schema-validated packet as formatted JSON", async () => {
    const selectedPath = path.join(temporaryDirectory, "application-packet");
    mockShowSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: selectedPath,
    });

    const result = await exportHandler(
      { sender: {} },
      {
        runId: "run-1",
        jobId: "job-1",
        applicationRecordId: "application-1",
      },
    );

    expect(result).toEqual({ status: "saved" });
    const savedContents = await readFile(`${selectedPath}.json`, "utf8");
    expect(savedContents).toBe(`${JSON.stringify(packet, null, 2)}\n`);
    expect(JSON.parse(savedContents)).toEqual(packet);
  });

  it("returns a typed delta for a bounded entity mutation", async () => {
    const initial = await syncHandler({ sender: {} }, { baseRevision: null });
    expect(initial).toMatchObject({
      kind: "snapshot",
      currentRevision: 1,
    });

    const result = await entityMutationHandler(
      { sender: {} },
      {
        baseRevision: 1,
        mutation: {
          type: "queue_job_for_review",
          jobId: "job-1",
        },
      },
    );

    expect(mockQueueJobForReview).toHaveBeenCalledWith("job-1");
    expect(result).toMatchObject({
      kind: "delta",
      delta: {
        baseRevision: 1,
        currentRevision: 2,
      },
    });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("refuses new messages to the retired Profile chat (ADR 0037)", async () => {
    await expect(
      profileCopilotHandler(
        { sender: {} },
        {
          content: "Look for jobs around New York",
          context: { surface: "profile", section: "preferences" },
        },
      ),
    ).rejects.toThrow(RETIRED_CHAT_MESSAGE);
    expect(mockProposeProfileCopilotChange).not.toHaveBeenCalled();
  });

  it("sends a changed untracked field as a replaced value in the mutation delta", async () => {
    await syncHandler({ sender: {} }, { baseRevision: null });
    const changed = createEmptyWorkspace("2026-08-09T10:01:00.000Z");
    mockQueueJobForReview.mockResolvedValueOnce(
      JobFinderWorkspaceSnapshotSchema.parse({
        ...changed,
        profile: {
          ...changed.profile,
          summary: "Changed outside a delta-backed entity slice.",
        },
      }),
    );

    const result = await entityMutationHandler(
      { sender: {} },
      {
        baseRevision: 1,
        mutation: {
          type: "queue_job_for_review",
          jobId: "job-1",
        },
      },
    );

    expect(result).toMatchObject({
      kind: "delta",
      delta: {
        currentRevision: 2,
        replaced: {
          profile: {
            summary: "Changed outside a delta-backed entity slice.",
          },
        },
      },
    });
  });
});

describe("job-finder employer exclusion routes", () => {
  it("validates preview and exact reversal payloads across IPC", async () => {
    const previewEmployerExclusion = vi.fn().mockResolvedValue({
      status: "available",
      jobId: "job-1",
      displayCompanyName: "Example Co",
      normalizedCompanyName: "example co",
      employerDomain: "example.test",
    });
    const removeEmployerExclusion = vi
      .fn()
      .mockResolvedValue(createEmptyWorkspace("2026-08-23T10:00:00.000Z"));
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      previewEmployerExclusion,
      removeEmployerExclusion,
    });
    const handlers = new Map<string, RegisteredHandler>();
    registerJobFinderRouteHandlers({
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain);

    await expect(
      handlers.get("job-finder:preview-employer-exclusion")?.(
        { sender: {} },
        { jobId: "job-1" },
      ),
    ).resolves.toMatchObject({ normalizedCompanyName: "example co" });
    await handlers.get("job-finder:remove-employer-exclusion")?.(
      { sender: {} },
      { jobId: "job-1", normalizedCompanyName: "example co" },
    );
    expect(removeEmployerExclusion).toHaveBeenCalledWith({
      jobId: "job-1",
      normalizedCompanyName: "example co",
    });
    await expect(
      handlers.get("job-finder:remove-employer-exclusion")?.(
        { sender: {} },
        { jobId: "job-1", normalizedCompanyName: "" },
      ),
    ).rejects.toThrow();
  });
});

describe("job-finder exact application lineage routes", () => {
  it("rejects omitted Applications identity and forwards exact start/cancel/consent targets", async () => {
    const snapshot = createEmptyWorkspace("2026-08-23T10:00:00.000Z");
    mockStartApplyCopilotRun.mockResolvedValue(snapshot);
    mockCancelApplyRun.mockResolvedValue(snapshot);
    mockResolveApplyConsentRequest.mockResolvedValue(snapshot);
    mockFocusPreparedApplicationPage.mockResolvedValue(snapshot);
    mockGetApplyRunDetails.mockResolvedValue({
      run: {
        id: "run-1",
        jobIds: ["job-1"],
      },
      consentRequests: [
        {
          id: "consent-1",
          runId: "run-1",
          jobId: "job-1",
          applicationRecordId: "application-1",
        },
      ],
    });
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      startApplyCopilotRun: mockStartApplyCopilotRun,
      cancelApplyRun: mockCancelApplyRun,
      getApplyRunDetails: mockGetApplyRunDetails,
      resolveApplyConsentRequest: mockResolveApplyConsentRequest,
      focusPreparedApplicationPage: mockFocusPreparedApplicationPage,
    });
    const handlers = new Map<string, RegisteredHandler>();
    registerJobFinderRouteHandlers({
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain);

    await expect(
      handlers.get("job-finder:get-apply-run-details")?.(
        { sender: {} },
        { runId: "run-1", jobId: "job-1" },
      ),
    ).rejects.toThrow();

    mockGetJobFinderRepositoryForWorkspaceService.mockReturnValueOnce({
      listSavedJobs: vi
        .fn()
        .mockResolvedValue([
          { id: "job-1", resumeApplicationMode: "original_resume" },
        ]),
      getSettings: vi
        .fn()
        .mockResolvedValue({ applicationAutomationMode: "prepare_only" }),
      getSearchPreferences: vi
        .fn()
        .mockResolvedValue({ tailoringMode: "balanced" }),
    } as never);
    await handlers.get("job-finder:start-apply-copilot-run")?.(
      { sender: {} },
      {
        jobId: "job-1",
        applicationRecordId: "application-1",
        visualCheckpointsEnabled: true,
      },
    );
    expect(mockStartApplyCopilotRun).toHaveBeenCalledWith(
      "job-1",
      { visualCheckpointsEnabled: true },
      "application-1",
    );

    const preparedPageTarget = {
      runId: "run-1",
      jobId: "job-1",
      resultId: "result-1",
      applicationRecordId: "application-1",
    };
    await handlers.get("job-finder:focus-prepared-application-page")?.(
      { sender: {} },
      preparedPageTarget,
    );
    expect(mockFocusPreparedApplicationPage).toHaveBeenCalledWith(
      preparedPageTarget,
    );
    await expect(
      handlers.get("job-finder:focus-prepared-application-page")?.(
        { sender: {} },
        { ...preparedPageTarget, resultId: "" },
      ),
    ).rejects.toThrow();

    const exactRunTarget = {
      runId: "run-1",
      jobId: "job-1",
      applicationRecordId: "application-1",
    };
    await handlers.get("job-finder:cancel-apply-run")?.(
      { sender: {} },
      exactRunTarget,
    );
    expect(mockGetApplyRunDetails).toHaveBeenCalledWith(
      "run-1",
      "job-1",
      "application-1",
    );
    expect(mockCancelApplyRun).toHaveBeenCalledWith("run-1");

    await handlers.get("job-finder:resolve-apply-consent-request")?.(
      { sender: {} },
      { ...exactRunTarget, requestId: "consent-1", action: "approve" },
    );
    expect(mockResolveApplyConsentRequest).toHaveBeenCalledWith(
      "consent-1",
      "approve",
    );
  });
});

describe("job-finder resume preview route", () => {
  const draft = ResumeDraftSchema.parse({
    id: "draft_preview",
    jobId: "job_preview",
    status: "needs_review",
    templateId: "classic_ats",
    createdAt: "2026-08-19T10:00:00.000Z",
    updatedAt: "2026-08-19T10:00:00.000Z",
  });
  const preview = JobFinderResumePreviewSchema.parse({
    draftId: draft.id,
    revisionKey: "resume_preview_draft_preview_latest",
    html: "<!doctype html><html><body>latest</body></html>",
    warnings: [],
    metadata: {
      templateId: draft.templateId,
      renderedAt: "2026-08-19T10:00:00.000Z",
      pageCount: null,
      sectionCount: 0,
      entryCount: 0,
    },
  });

  let previewHandler: RegisteredHandler;

  beforeEach(() => {
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      previewResumeDraft: mockPreviewResumeDraft,
    });

    const handlers = new Map<string, RegisteredHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    registerJobFinderRouteHandlers(ipcMain);

    const registeredHandler = handlers.get("job-finder:preview-resume-draft");
    if (!registeredHandler) {
      throw new Error("Resume preview handler was not registered.");
    }
    previewHandler = registeredHandler;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("aborts a superseded render and returns only the latest preview", async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<(value: typeof preview) => void> = [];
    const rejecters: Array<(reason: unknown) => void> = [];

    mockPreviewResumeDraft.mockImplementation(
      (_draft: unknown, signal?: AbortSignal) =>
        new Promise<typeof preview>((resolve, reject) => {
          if (!signal) {
            reject(new Error("Expected the route to pass an abort signal."));
            return;
          }

          signals.push(signal);
          resolvers.push(resolve);
          rejecters.push(reject);
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("superseded", "AbortError")),
            { once: true },
          );
        }),
    );

    const sender = {};
    const firstRequest = previewHandler(
      { sender },
      { draft, requestId: "resume_preview_1" },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPreviewResumeDraft).toHaveBeenCalledTimes(1);

    const secondRequest = previewHandler(
      { sender },
      { draft, requestId: "resume_preview_2" },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    resolvers[1]?.(preview);
    await expect(secondRequest).resolves.toEqual(preview);
    await expect(firstRequest).rejects.toMatchObject({ name: "AbortError" });
    expect(rejecters).toHaveLength(2);
  });
});

describe("job-finder work-history review acknowledgment route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function registerAndFindHandler(): RegisteredHandler {
    const handlers = new Map<string, RegisteredHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    registerJobFinderRouteHandlers(ipcMain);

    const handler = handlers.get(
      "job-finder:set-work-history-review-acknowledgment",
    );
    if (!handler) {
      throw new Error(
        "Work-history review acknowledgment handler was not registered.",
      );
    }
    return handler;
  }

  it("parses the typed command, forwards it to the service, and returns a parsed snapshot", async () => {
    const snapshot = createEmptyWorkspace("2026-08-19T10:05:00.000Z");
    mockSetWorkHistoryReviewAcknowledgment.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      setWorkHistoryReviewAcknowledgment:
        mockSetWorkHistoryReviewAcknowledgment,
    });

    const input = JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema.parse({
      intent: "acknowledge",
      jobId: "job_ready",
      draftId: "resume_draft_job_ready",
      expectedDraftUpdatedAt: "2026-08-19T10:00:00.000Z",
      suggestionId: "work_history_review_experience_sales_bridge",
      profileRecordId: "experience_sales_bridge",
      kind: "weak_fit",
      action: "consider_showing",
      messageContentHash: "fnv1a32:465fc3f2",
      reason: "intentional_omission",
    });
    const result = await registerAndFindHandler()({ sender: {} }, input);

    expect(mockSetWorkHistoryReviewAcknowledgment).toHaveBeenCalledOnce();
    expect(mockSetWorkHistoryReviewAcknowledgment).toHaveBeenCalledWith(input);
    expect(answeredView(result)).toEqual(snapshot);
  });

  it("forwards remove commands by acknowledgment id", async () => {
    const snapshot = createEmptyWorkspace("2026-08-19T10:06:00.000Z");
    mockSetWorkHistoryReviewAcknowledgment.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      setWorkHistoryReviewAcknowledgment:
        mockSetWorkHistoryReviewAcknowledgment,
    });

    const input = JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema.parse({
      intent: "remove",
      jobId: "job_ready",
      draftId: "resume_draft_job_ready",
      expectedDraftUpdatedAt: "2026-08-19T10:00:00.000Z",
      acknowledgmentId: "work_history_ack_experience_sales_bridge_1",
    });
    const result = await registerAndFindHandler()({ sender: {} }, input);

    expect(mockSetWorkHistoryReviewAcknowledgment).toHaveBeenCalledWith(input);
    expect(answeredView(result)).toEqual(snapshot);
  });

  it("rejects payloads that violate the strict discriminated schema before touching the service", async () => {
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      setWorkHistoryReviewAcknowledgment:
        mockSetWorkHistoryReviewAcknowledgment,
    });
    const handler = registerAndFindHandler();

    await expect(
      handler({ sender: {} }, { intent: "acknowledge" }),
    ).rejects.toThrow();
    await expect(
      handler(
        { sender: {} },
        {
          intent: "acknowledge",
          jobId: "job_ready",
          draftId: "resume_draft_job_ready",
          expectedDraftUpdatedAt: "2026-08-19T10:00:00.000Z",
          suggestionId: "work_history_review_x",
          profileRecordId: "experience_x",
          kind: "compact_recommended",
          action: "keep_compact",
          messageContentHash: "fnv1a32:465fc3f2",
          reason: "intentional_omission",
        },
      ),
    ).rejects.toThrow(/intentional_omission/);

    expect(mockSetWorkHistoryReviewAcknowledgment).not.toHaveBeenCalled();
  });
});

describe("job-finder resume claim confirmation route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function registerAndFindHandler(): RegisteredHandler {
    const handlers = new Map<string, RegisteredHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    registerJobFinderRouteHandlers(ipcMain);

    const handler = handlers.get("job-finder:set-resume-claim-confirmation");
    if (!handler) {
      throw new Error("Resume claim confirmation handler was not registered.");
    }
    return handler;
  }

  function buildValidAddInput(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      intent: "add",
      jobId: "job_ready",
      draftId: "resume_draft_job_ready",
      expectedDraftUpdatedAt: "2026-08-19T10:00:00.000Z",
      field: "entry_bullet",
      sectionId: "section_experience",
      entryId: "experience_1",
      bulletId: "experience_1_bullet_1",
      confirmedClaimContentHash: "fnv1a32:5678efab",
      ownershipStatement: resumeClaimOwnershipStatement,
      ...overrides,
    };
  }

  it("parses the typed command, forwards it to the service, and returns a parsed snapshot", async () => {
    const snapshot = createEmptyWorkspace("2026-08-19T10:07:00.000Z");
    mockSetResumeClaimConfirmation.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      setResumeClaimConfirmation: mockSetResumeClaimConfirmation,
    });

    const input =
      JobFinderSetResumeClaimConfirmationInputSchema.parse(
        buildValidAddInput(),
      );
    const result = await registerAndFindHandler()({ sender: {} }, input);

    expect(mockSetResumeClaimConfirmation).toHaveBeenCalledOnce();
    expect(mockSetResumeClaimConfirmation).toHaveBeenCalledWith(input);
    expect(answeredView(result)).toEqual(snapshot);
  });

  it("forwards remove commands by confirmation id", async () => {
    const snapshot = createEmptyWorkspace("2026-08-19T10:08:00.000Z");
    mockSetResumeClaimConfirmation.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      setResumeClaimConfirmation: mockSetResumeClaimConfirmation,
    });

    const input = JobFinderSetResumeClaimConfirmationInputSchema.parse({
      intent: "remove",
      jobId: "job_ready",
      draftId: "resume_draft_job_ready",
      expectedDraftUpdatedAt: "2026-08-19T10:00:00.000Z",
      confirmationId: "claim_confirmation_section_experience_abc",
    });
    const result = await registerAndFindHandler()({ sender: {} }, input);

    expect(mockSetResumeClaimConfirmation).toHaveBeenCalledWith(input);
    expect(answeredView(result)).toEqual(snapshot);
  });

  it("rejects payloads that violate the strict discriminated schema before touching the service", async () => {
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      setResumeClaimConfirmation: mockSetResumeClaimConfirmation,
    });
    const handler = registerAndFindHandler();

    await expect(handler({ sender: {} }, { intent: "add" })).rejects.toThrow();
    await expect(
      handler({ sender: {} }, buildValidAddInput({ bulletId: null })),
    ).rejects.toThrow(/bulletId/);
    await expect(
      handler(
        { sender: {} },
        {
          ...buildValidAddInput(),
          confirmedAt: "2026-08-19T10:05:00.000Z",
        },
      ),
    ).rejects.toThrow();

    expect(mockSetResumeClaimConfirmation).not.toHaveBeenCalled();
  });
});

describe("job-finder scoped settings routes", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function registerAndFindHandler(channel: string): RegisteredHandler {
    const handlers = new Map<string, RegisteredHandler>();
    const ipcMain = {
      handle: vi.fn((registeredChannel: string, handler: RegisteredHandler) => {
        handlers.set(registeredChannel, handler);
      }),
    } as unknown as IpcMain;
    registerJobFinderRouteHandlers(ipcMain);

    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error(`Scoped settings handler was not registered: ${channel}`);
    }
    return handler;
  }

  it("routes application-default payloads to updateApplicationDefaults without whole-object save", async () => {
    const snapshot = createEmptyWorkspace("2026-08-22T10:00:00.000Z");
    mockUpdateApplicationDefaults.mockResolvedValue(snapshot);
    // Only the scoped method exists on the mocked service, so any fallback to
    // saveSettings or another settings method would fail this route.
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      updateApplicationDefaults: mockUpdateApplicationDefaults,
    });

    const input = UpdateApplicationDefaultsInputSchema.parse({
      resumeApplicationMode: "original_resume",
      resumeTemplateId: "modern_split",
    });
    const result = await registerAndFindHandler(
      "job-finder:update-application-defaults",
    )({ sender: {} }, input);

    expect(mockUpdateApplicationDefaults).toHaveBeenCalledOnce();
    expect(mockUpdateApplicationDefaults).toHaveBeenCalledWith(input);
    expect(answeredView(result)).toEqual(snapshot);
  });

  it("answers a change with its delta and does not ask the same window to sync again", async () => {
    const snapshot = createEmptyWorkspace("2026-08-22T10:00:30.000Z");
    mockUpdateApplicationDefaults.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      updateApplicationDefaults: mockUpdateApplicationDefaults,
    });
    const send = vi.fn();
    await registerAndFindHandler("job-finder:update-application-defaults")(
      { sender: { send, isDestroyed: () => false } },
      UpdateApplicationDefaultsInputSchema.parse({
        resumeApplicationMode: "original_resume",
      }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("routes tracker CRM payloads to updateTrackerCrm and never through saveSettings", async () => {
    const snapshot = createEmptyWorkspace("2026-08-22T10:01:00.000Z");
    mockUpdateTrackerCrm.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      updateTrackerCrm: mockUpdateTrackerCrm,
    });

    const input = ApplicationCrmSettingsSchema.parse({
      noResponseAutomation: { enabled: true, afterDays: 7 },
    });
    const result = await registerAndFindHandler(
      "job-finder:update-tracker-crm",
    )({ sender: {} }, input);

    expect(mockUpdateTrackerCrm).toHaveBeenCalledOnce();
    expect(mockUpdateTrackerCrm).toHaveBeenCalledWith(input);
    expect(answeredView(result)).toEqual(snapshot);
  });

  it("routes workspace-behavior payloads to updateWorkspaceBehavior", async () => {
    const snapshot = createEmptyWorkspace("2026-08-22T10:02:00.000Z");
    mockUpdateWorkspaceBehavior.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      updateWorkspaceBehavior: mockUpdateWorkspaceBehavior,
    });

    const input = UpdateWorkspaceBehaviorInputSchema.parse({
      keepSessionAlive: true,
      discoveryOnly: true,
    });
    const result = await registerAndFindHandler(
      "job-finder:update-workspace-behavior",
    )({ sender: {} }, input);

    expect(mockUpdateWorkspaceBehavior).toHaveBeenCalledWith(input);
    expect(answeredView(result)).toEqual(snapshot);
  });

  it("routes AI-behavior payloads to updateAiBehavior", async () => {
    const snapshot = createEmptyWorkspace("2026-08-22T10:02:30.000Z");
    mockUpdateAiBehavior.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      updateAiBehavior: mockUpdateAiBehavior,
    });

    const input = UpdateAiBehaviorInputSchema.parse({
      aiBehavior: {
        profileAssistant: { initiative: "proactive", replyStyle: "brief" },
        jobSearch: {
          selectivity: "wide_net",
          remoteCountsAsAnyLocation: false,
        },
        applying: { coverLetterPolicy: "never", writtenAnswerLength: "full" },
      },
      resumeApproach: "aggressive",
    });
    const result = await registerAndFindHandler(
      "job-finder:update-ai-behavior",
    )({ sender: {} }, input);

    expect(mockUpdateAiBehavior).toHaveBeenCalledWith(input);
    expect(answeredView(result)).toEqual(snapshot);
  });

  it("routes appearance-theme payloads to updateAppearanceTheme with the parsed theme", async () => {
    const snapshot = createEmptyWorkspace("2026-08-22T10:03:00.000Z");
    mockUpdateAppearanceTheme.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      updateAppearanceTheme: mockUpdateAppearanceTheme,
    });

    const theme = AppearanceThemeSchema.parse("dark");
    const result = await registerAndFindHandler(
      "job-finder:update-appearance-theme",
    )({ sender: {} }, theme);

    expect(mockUpdateAppearanceTheme).toHaveBeenCalledWith("dark");
    expect(answeredView(result)).toEqual(snapshot);
  });

  it("rejects a malformed application-defaults payload before touching the service", async () => {
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      updateApplicationDefaults: mockUpdateApplicationDefaults,
    });
    const handler = registerAndFindHandler(
      "job-finder:update-application-defaults",
    );

    await expect(
      handler({ sender: {} }, { resumeTemplateId: 42 }),
    ).rejects.toThrow();

    expect(mockUpdateApplicationDefaults).not.toHaveBeenCalled();
  });

  it("propagates scoped service failures so renderer save state can report them", async () => {
    mockUpdateTrackerCrm.mockRejectedValue(
      new Error("Tracker settings could not be committed."),
    );
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      updateTrackerCrm: mockUpdateTrackerCrm,
    });

    const handler = registerAndFindHandler("job-finder:update-tracker-crm");

    await expect(
      handler(
        { sender: {} },
        ApplicationCrmSettingsSchema.parse({
          noResponseAutomation: { enabled: false, afterDays: 30 },
        }),
      ),
    ).rejects.toThrow(/could not be committed/);
  });
});

describe("job-finder resume quality benchmark route", () => {
  afterEach(() => {
    mockIsDesktopTestApiEnabled.mockReturnValue(false);
    vi.clearAllMocks();
  });

  it("forwards configured AI selection to the benchmark service", async () => {
    mockIsDesktopTestApiEnabled.mockReturnValue(true);
    const report = ResumeQualityBenchmarkReportSchema.parse({
      benchmarkVersion: "configured-route-regression",
      generatedAt: "2026-08-09T12:00:00.000Z",
      providerMode: "configured",
      templates: [],
      persistedArtifactsDirectory: null,
      cases: [],
      aggregate: {},
      notes: [],
    });
    mockRunDesktopResumeQualityBenchmark.mockResolvedValue(report);

    const handlers = new Map<string, RegisteredHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    registerJobFinderRouteHandlers(ipcMain);

    const handler = handlers.get(
      "job-finder:test-run-resume-quality-benchmark",
    );
    if (!handler) {
      throw new Error("Resume quality benchmark handler was not registered.");
    }

    await expect(
      handler(
        { sender: {} },
        {
          benchmarkVersion: "configured-route-regression",
          canaryOnly: true,
          useConfiguredAi: true,
        },
      ),
    ).resolves.toEqual(report);
    expect(mockRunDesktopResumeQualityBenchmark).toHaveBeenCalledWith({
      benchmarkVersion: "configured-route-regression",
      canaryOnly: true,
      useConfiguredAi: true,
    });
  });
});

describe("job-finder campaign run and notification read routes", () => {
  let runCampaignNowHandler: RegisteredHandler;
  let markNotificationReadHandler: RegisteredHandler;
  let markAllNotificationsReadHandler: RegisteredHandler;

  beforeEach(() => {
    mockRunCampaignNow.mockClear();
    mockMarkCampaignNotificationRead.mockClear();
    mockMarkAllCampaignNotificationsRead.mockClear();
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      markAllCampaignNotificationsRead: mockMarkAllCampaignNotificationsRead,
      markCampaignNotificationRead: mockMarkCampaignNotificationRead,
      runCampaignNow: mockRunCampaignNow,
    });
    mockRunCampaignNow.mockResolvedValue(
      createEmptyWorkspace("2026-08-09T11:00:00.000Z"),
    );
    mockMarkCampaignNotificationRead.mockResolvedValue(
      createEmptyWorkspace("2026-08-09T11:01:00.000Z"),
    );
    mockMarkAllCampaignNotificationsRead.mockResolvedValue(
      createEmptyWorkspace("2026-08-09T11:02:00.000Z"),
    );

    const handlers = new Map<string, RegisteredHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    registerJobFinderRouteHandlers(ipcMain);
    const runNow = handlers.get("job-finder:run-campaign-now");
    const markRead = handlers.get("job-finder:mark-campaign-notification-read");
    const markAllRead = handlers.get(
      "job-finder:mark-all-campaign-notifications-read",
    );
    if (!runNow || !markRead || !markAllRead) {
      throw new Error(
        "Campaign run and notification read handlers were not registered.",
      );
    }
    runCampaignNowHandler = runNow;
    markNotificationReadHandler = markRead;
    markAllNotificationsReadHandler = markAllRead;
  });

  it("parses an explicit campaign id for run-campaign-now", async () => {
    const result = await runCampaignNowHandler(
      { sender: {} },
      { campaignId: "campaign-1" },
    );

    expect(mockRunCampaignNow).toHaveBeenCalledWith(
      { campaignId: "campaign-1" },
      expect.any(Function),
    );
    expect(answeredView(result)).toMatchObject({ module: "job-finder" });
  });

  it("treats omitted or null campaign ids as the active campaign", async () => {
    await runCampaignNowHandler({ sender: {} }, undefined);
    expect(mockRunCampaignNow).toHaveBeenCalledWith({}, expect.any(Function));

    mockRunCampaignNow.mockClear();
    await runCampaignNowHandler({ sender: {} }, { campaignId: null });
    expect(mockRunCampaignNow).toHaveBeenCalledWith(
      { campaignId: null },
      expect.any(Function),
    );
  });

  it("still tells the renderer to refresh when the run refuses to start", async () => {
    // A plan whose sources are gone records a failed run and then throws the
    // reason. The throw skipped the workspace-updated publish, so the plan
    // card, its history and Home all kept the previous run's success as the
    // newest thing the app had said.
    mockRunCampaignNow.mockRejectedValueOnce(
      new Error(DISCOVERY_NO_JOB_SITES_MESSAGE),
    );
    const send = vi.fn();

    await expect(
      runCampaignNowHandler({ sender: { send } }, { campaignId: "campaign-1" }),
    ).rejects.toThrow(DISCOVERY_NO_JOB_SITES_MESSAGE);

    expect(send).toHaveBeenCalledWith(JOB_FINDER_WORKSPACE_UPDATED_CHANNEL);
  });

  it("rejects a malformed run-campaign-now payload", async () => {
    await expect(
      runCampaignNowHandler({ sender: {} }, { campaignId: 42 }),
    ).rejects.toThrow();
    expect(mockRunCampaignNow).not.toHaveBeenCalled();
  });

  it("supplies the ISO readAt for mark-campaign-notification-read", async () => {
    const result = await markNotificationReadHandler(
      { sender: {} },
      { notificationId: "notification-1" },
    );

    const input = MarkCampaignNotificationReadInputSchema.parse(
      mockMarkCampaignNotificationRead.mock.calls.at(-1)?.[0],
    );
    expect(input.notificationId).toBe("notification-1");
    expect(typeof input.readAt).toBe("string");
    expect(new Date(input.readAt).toISOString()).toBe(input.readAt);
    expect(answeredView(result)).toMatchObject({ module: "job-finder" });
  });

  it("rejects a mark-read payload without a notification id", async () => {
    await expect(
      markNotificationReadHandler({ sender: {} }, {}),
    ).rejects.toThrow();
    expect(mockMarkCampaignNotificationRead).not.toHaveBeenCalled();
  });

  it("routes mark-all-campaign-notifications-read to the service without extra payload", async () => {
    const result = await markAllNotificationsReadHandler(
      { sender: {} },
      undefined,
    );

    expect(mockMarkAllCampaignNotificationsRead).toHaveBeenCalledTimes(1);
    const rawInput: unknown =
      mockMarkAllCampaignNotificationsRead.mock.calls.at(-1)?.[0];
    const input = MarkAllCampaignNotificationsReadInputSchema.parse(rawInput);
    expect(new Date(input.readAt).toISOString()).toBe(input.readAt);
    expect(answeredView(result)).toMatchObject({ module: "job-finder" });
  });
});

describe("job-finder campaign rule mutation and funnel routes", () => {
  let saveRuleHandler: RegisteredHandler;
  let deleteRuleHandler: RegisteredHandler;
  let toggleRuleHandler: RegisteredHandler;
  let projectFunnelHandler: RegisteredHandler;

  const rulePayload = {
    id: null,
    kind: "must_have",
    field: "role",
    operator: "contains",
    value: "frontend",
    provenance: { source: "user", recordedAt: "2026-08-15T10:00:00.000Z" },
  };

  beforeEach(() => {
    mockSaveCampaignRule.mockClear();
    mockDeleteCampaignRule.mockClear();
    mockToggleCampaignRule.mockClear();
    mockProjectCampaignRuleFunnel.mockClear();
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      deleteCampaignRule: mockDeleteCampaignRule,
      projectCampaignRuleFunnel: mockProjectCampaignRuleFunnel,
      saveCampaignRule: mockSaveCampaignRule,
      toggleCampaignRule: mockToggleCampaignRule,
    });
    mockSaveCampaignRule.mockResolvedValue(
      createEmptyWorkspace("2026-08-09T11:02:00.000Z"),
    );
    mockDeleteCampaignRule.mockResolvedValue(
      createEmptyWorkspace("2026-08-09T11:03:00.000Z"),
    );
    mockToggleCampaignRule.mockResolvedValue(
      createEmptyWorkspace("2026-08-09T11:04:00.000Z"),
    );
    mockProjectCampaignRuleFunnel.mockResolvedValue({
      campaignId: "campaign-1",
      generatedAt: "2026-08-09T11:05:00.000Z",
      rules: [],
      disabledRuleIds: [],
      funnel: {
        sampleSize: 0,
        hardRemovedCount: 0,
        retainedCount: 0,
        preferDowngradedCount: 0,
        uncertainCount: 0,
        confirmedRetainedCount: 0,
        rankedJobIds: [],
        measuredAt: "2026-08-09T11:05:00.000Z",
      },
    });

    const handlers = new Map<string, RegisteredHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    registerJobFinderRouteHandlers(ipcMain);
    const saveRule = handlers.get("job-finder:save-campaign-rule");
    const deleteRule = handlers.get("job-finder:delete-campaign-rule");
    const toggleRule = handlers.get("job-finder:toggle-campaign-rule");
    const projectFunnel = handlers.get(
      "job-finder:project-campaign-rule-funnel",
    );
    if (!saveRule || !deleteRule || !toggleRule || !projectFunnel) {
      throw new Error("Campaign rule handlers were not registered.");
    }
    saveRuleHandler = saveRule;
    deleteRuleHandler = deleteRule;
    toggleRuleHandler = toggleRule;
    projectFunnelHandler = projectFunnel;
  });

  it("parses a save-campaign-rule payload and returns a snapshot", async () => {
    const result = await saveRuleHandler(
      { sender: {} },
      { campaignId: "campaign-1", rule: rulePayload },
    );

    const input = SaveCampaignRuleRouteInputSchema.parse(
      mockSaveCampaignRule.mock.calls.at(-1)?.[0],
    );
    expect(input.campaignId).toBe("campaign-1");
    expect(input.rule.kind).toBe("must_have");
    expect(input.rule.field).toBe("role");
    expect(input.rule.operator).toBe("contains");
    expect(input.rule.value).toBe("frontend");
    // The route input defaults the id, enabled state, and effect so the
    // service always receives a complete rule.
    expect(input.rule.id).toBeNull();
    expect(input.rule.enabled).toBe(true);
    expect(input.rule.effect.sampleSize).toBe(0);
    expect(answeredView(result)).toMatchObject({ module: "job-finder" });
  });

  it("rejects a save-campaign-rule payload without a campaign id", async () => {
    await expect(
      saveRuleHandler({ sender: {} }, { rule: rulePayload }),
    ).rejects.toThrow();
    expect(mockSaveCampaignRule).not.toHaveBeenCalled();
  });

  it("parses a delete-campaign-rule payload", async () => {
    const result = await deleteRuleHandler(
      { sender: {} },
      { campaignId: "campaign-1", ruleId: "rule_1" },
    );
    expect(mockDeleteCampaignRule).toHaveBeenCalledWith({
      campaignId: "campaign-1",
      ruleId: "rule_1",
    });
    expect(answeredView(result)).toMatchObject({ module: "job-finder" });
  });

  it("rejects a delete-campaign-rule payload without a rule id", async () => {
    await expect(
      deleteRuleHandler({ sender: {} }, { campaignId: "campaign-1" }),
    ).rejects.toThrow();
    expect(mockDeleteCampaignRule).not.toHaveBeenCalled();
  });

  it("parses a toggle-campaign-rule payload", async () => {
    const result = await toggleRuleHandler(
      { sender: {} },
      { campaignId: "campaign-1", ruleId: "rule_1", enabled: false },
    );
    expect(mockToggleCampaignRule).toHaveBeenCalledWith({
      campaignId: "campaign-1",
      ruleId: "rule_1",
      enabled: false,
    });
    expect(answeredView(result)).toMatchObject({ module: "job-finder" });
  });

  it("rejects a toggle-campaign-rule payload with a non-boolean enabled flag", async () => {
    await expect(
      toggleRuleHandler(
        { sender: {} },
        { campaignId: "campaign-1", ruleId: "rule_1", enabled: "yes" },
      ),
    ).rejects.toThrow();
    expect(mockToggleCampaignRule).not.toHaveBeenCalled();
  });

  it("returns a parsed funnel projection from project-campaign-rule-funnel", async () => {
    const result = await projectFunnelHandler(
      { sender: {} },
      { campaignId: "campaign-1" },
    );
    expect(mockProjectCampaignRuleFunnel).toHaveBeenCalledWith({
      campaignId: "campaign-1",
    });
    expect(result).toMatchObject({
      campaignId: "campaign-1",
      funnel: { sampleSize: 0 },
    });
  });

  it("rejects a project-campaign-rule-funnel payload without a campaign id", async () => {
    await expect(projectFunnelHandler({ sender: {} }, {})).rejects.toThrow();
    expect(mockProjectCampaignRuleFunnel).not.toHaveBeenCalled();
  });
});

describe("job-finder grouped manual-answer routes", () => {
  let projectHandler: RegisteredHandler;
  let applyHandler: RegisteredHandler;
  let snoozeHandler: RegisteredHandler;

  beforeEach(() => {
    const groupedSnapshot = createEmptyWorkspace("2026-08-15T10:00:00.000Z");
    mockProjectGroupedManualAnswer.mockResolvedValue(groupedSnapshot);
    mockApplyGroupedManualAnswer.mockResolvedValue(groupedSnapshot);
    mockSnoozeGroupedDecision.mockResolvedValue(groupedSnapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      applyGroupedManualAnswer: mockApplyGroupedManualAnswer,
      projectGroupedManualAnswer: mockProjectGroupedManualAnswer,
      snoozeGroupedDecision: mockSnoozeGroupedDecision,
    });

    const handlers = new Map<string, RegisteredHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    registerJobFinderRouteHandlers(ipcMain);
    const project = handlers.get("job-finder:project-grouped-manual-answer");
    const apply = handlers.get("job-finder:apply-grouped-manual-answer");
    const snooze = handlers.get("job-finder:snooze-grouped-decision");
    if (!project || !apply || !snooze) {
      throw new Error("Grouped manual-answer handlers were not registered.");
    }
    projectHandler = project;
    applyHandler = apply;
    snoozeHandler = snooze;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("projects a typed grouped manual-answer command and returns the parsed snapshot", async () => {
    const result = await projectHandler(
      { sender: {} },
      {
        groupKey: "group_1",
        requestId: "request_a",
        expectedRequestRevision: 1,
        answer: { type: "text", value: "5 years" },
        saveScope: "reusable_profile",
      },
    );

    expect(mockProjectGroupedManualAnswer).toHaveBeenCalledWith({
      groupKey: "group_1",
      requestId: "request_a",
      expectedRequestRevision: 1,
      answer: { type: "text", value: "5 years" },
      saveScope: "reusable_profile",
    });
    expect(answeredView(result)).toMatchObject({ module: "job-finder" });
  });

  it("rejects a project command whose answer is not reusable text", async () => {
    await expect(
      projectHandler(
        { sender: {} },
        {
          groupKey: "group_1",
          requestId: "request_a",
          expectedRequestRevision: 1,
          answer: { type: "single_choice", value: "Yes" },
        },
      ),
    ).rejects.toThrow();
    expect(mockProjectGroupedManualAnswer).not.toHaveBeenCalled();
  });

  it("applies a typed grouped manual-answer input and returns the parsed snapshot", async () => {
    const result = await applyHandler(
      { sender: {} },
      {
        decisionId: "group_1:abc123",
        requestIds: ["request_a", "request_b"],
        expectedRequestRevisions: { request_a: 1, request_b: 1 },
        answer: { type: "text", value: "5 years" },
      },
    );

    expect(mockApplyGroupedManualAnswer).toHaveBeenCalledWith({
      decisionId: "group_1:abc123",
      requestIds: ["request_a", "request_b"],
      expectedRequestRevisions: { request_a: 1, request_b: 1 },
      answer: { type: "text", value: "5 years" },
    });
    expect(answeredView(result)).toMatchObject({ module: "job-finder" });
  });

  it("rejects an apply input whose revisions do not cover every request id", async () => {
    await expect(
      applyHandler(
        { sender: {} },
        {
          decisionId: "group_1:abc123",
          requestIds: ["request_a", "request_b"],
          expectedRequestRevisions: { request_a: 1 },
          answer: { type: "text", value: "5 years" },
        },
      ),
    ).rejects.toThrow();
    expect(mockApplyGroupedManualAnswer).not.toHaveBeenCalled();
  });

  it("snoozes a grouped decision and defaults a missing reason to null", async () => {
    const result = await snoozeHandler(
      { sender: {} },
      {
        decisionId: "group_1:abc123",
        expectedRevision: 1,
        until: "2026-08-17T10:00:00.000Z",
      },
    );

    expect(mockSnoozeGroupedDecision).toHaveBeenCalledWith({
      decisionId: "group_1:abc123",
      expectedRevision: 1,
      until: "2026-08-17T10:00:00.000Z",
      reason: null,
    });
    expect(answeredView(result)).toMatchObject({ module: "job-finder" });
  });

  it("rejects a snooze payload without a decision id", async () => {
    await expect(
      snoozeHandler(
        { sender: {} },
        { expectedRevision: 1, until: "2026-08-17T10:00:00.000Z" },
      ),
    ).rejects.toThrow();
    expect(mockSnoozeGroupedDecision).not.toHaveBeenCalled();
  });
});

describe("job-finder outcome analytics routes", () => {
  let recordOutcomeHandler: RegisteredHandler;
  let setOutcomeSuggestionEnabledHandler: RegisteredHandler;
  const mockRecordOutcome = vi.fn();
  const mockSetOutcomeSuggestionEnabled = vi.fn();

  beforeEach(() => {
    mockRecordOutcome.mockClear();
    mockSetOutcomeSuggestionEnabled.mockClear();
    mockRecordOutcome.mockResolvedValue(
      createEmptyWorkspace("2026-08-09T12:00:00.000Z"),
    );
    mockSetOutcomeSuggestionEnabled.mockResolvedValue(
      createEmptyWorkspace("2026-08-09T12:01:00.000Z"),
    );
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      recordOutcome: mockRecordOutcome,
      setOutcomeSuggestionEnabled: mockSetOutcomeSuggestionEnabled,
    });

    const handlers = new Map<string, RegisteredHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    registerJobFinderRouteHandlers(ipcMain);
    const recordOutcome = handlers.get("job-finder:record-outcome");
    const setOutcomeSuggestionEnabled = handlers.get(
      "job-finder:set-outcome-suggestion-enabled",
    );
    if (!recordOutcome || !setOutcomeSuggestionEnabled) {
      throw new Error("Outcome analytics handlers were not registered.");
    }
    recordOutcomeHandler = recordOutcome;
    setOutcomeSuggestionEnabledHandler = setOutcomeSuggestionEnabled;
  });

  it("parses a record-outcome payload and returns a parsed snapshot", async () => {
    const result = await recordOutcomeHandler(
      { sender: {} },
      {
        jobId: "job-1",
        outcome: "interview",
        resumeStrategyId: "strategy-1",
        note: "Recruiter call went well",
      },
    );

    expect(mockRecordOutcome).toHaveBeenCalledWith({
      jobId: "job-1",
      outcome: "interview",
      resumeStrategyId: "strategy-1",
      note: "Recruiter call went well",
    });
    expect(answeredView(result)).toMatchObject({ module: "job-finder" });
  });

  it("defaults optional facts to null on a record-outcome payload", async () => {
    const result = await recordOutcomeHandler(
      { sender: {} },
      { jobId: "job-1", outcome: "applied" },
    );

    expect(mockRecordOutcome).toHaveBeenCalledWith({
      jobId: "job-1",
      outcome: "applied",
      resumeStrategyId: null,
      note: null,
    });
    expect(answeredView(result)).toMatchObject({ module: "job-finder" });
  });

  it("rejects a record-outcome payload with an unknown outcome", async () => {
    await expect(
      recordOutcomeHandler(
        { sender: {} },
        { jobId: "job-1", outcome: "submitted_without_approval" },
      ),
    ).rejects.toThrow();
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  it("parses a suggestion disable payload", async () => {
    const result = await setOutcomeSuggestionEnabledHandler(
      { sender: {} },
      { dimension: "source", key: "example", enabled: false },
    );

    expect(mockSetOutcomeSuggestionEnabled).toHaveBeenCalledWith({
      dimension: "source",
      key: "example",
      enabled: false,
      reset: false,
    });
    expect(answeredView(result)).toMatchObject({ module: "job-finder" });
  });

  it("parses a suggestion reset payload with the reset flag", async () => {
    const result = await setOutcomeSuggestionEnabledHandler(
      { sender: {} },
      { dimension: "campaign", key: "campaign-1", enabled: true, reset: true },
    );

    expect(mockSetOutcomeSuggestionEnabled).toHaveBeenCalledWith({
      dimension: "campaign",
      key: "campaign-1",
      enabled: true,
      reset: true,
    });
    expect(answeredView(result)).toMatchObject({ module: "job-finder" });
  });

  it("rejects a suggestion payload without a key", async () => {
    await expect(
      setOutcomeSuggestionEnabledHandler(
        { sender: {} },
        { dimension: "source", enabled: false },
      ),
    ).rejects.toThrow();
    expect(mockSetOutcomeSuggestionEnabled).not.toHaveBeenCalled();
  });
});

describe("job-finder resume strategy routes", () => {
  let recommendHandler: RegisteredHandler;
  let setCampaignDefaultHandler: RegisteredHandler;
  let saveHandler: RegisteredHandler;
  let disableHandler: RegisteredHandler;
  let selectHandler: RegisteredHandler;
  const mockRecommendResumeStrategy = vi.fn();
  const mockSetCampaignResumeStrategyDefault = vi.fn();
  const mockSaveResumeStrategy = vi.fn();
  const mockDisableResumeStrategy = vi.fn();
  const mockSelectResumeStrategy = vi.fn();

  beforeEach(() => {
    mockRecommendResumeStrategy.mockClear();
    mockSetCampaignResumeStrategyDefault.mockClear();
    mockSaveResumeStrategy.mockClear();
    mockDisableResumeStrategy.mockClear();
    mockSelectResumeStrategy.mockClear();
    const snapshot = createEmptyWorkspace("2026-08-15T10:00:00.000Z");
    const recommendation = {
      jobId: "job-1",
      campaignId: "campaign-test",
      roleFamily: "Backend Engineering",
      strategyId: "strategy-1",
      strategyName: "Backend",
      source: "role_family",
      reason: "Exact role family match.",
    };
    mockRecommendResumeStrategy.mockResolvedValue(recommendation);
    mockSetCampaignResumeStrategyDefault.mockResolvedValue(snapshot);
    mockSaveResumeStrategy.mockResolvedValue(snapshot);
    mockDisableResumeStrategy.mockResolvedValue(snapshot);
    mockSelectResumeStrategy.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      recommendResumeStrategy: mockRecommendResumeStrategy,
      setCampaignResumeStrategyDefault: mockSetCampaignResumeStrategyDefault,
      saveResumeStrategy: mockSaveResumeStrategy,
      disableResumeStrategy: mockDisableResumeStrategy,
      selectResumeStrategy: mockSelectResumeStrategy,
    });

    const handlers = new Map<string, RegisteredHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    registerJobFinderRouteHandlers(ipcMain);
    const recommend = handlers.get("job-finder:recommend-resume-strategy");
    const setCampaignDefault = handlers.get(
      "job-finder:set-campaign-resume-strategy-default",
    );
    const save = handlers.get("job-finder:save-resume-strategy");
    const disable = handlers.get("job-finder:disable-resume-strategy");
    const select = handlers.get("job-finder:select-resume-strategy");
    if (!recommend || !setCampaignDefault || !save || !disable || !select) {
      throw new Error("Resume strategy handlers were not registered.");
    }
    recommendHandler = recommend;
    setCampaignDefaultHandler = setCampaignDefault;
    saveHandler = save;
    disableHandler = disable;
    selectHandler = select;
  });

  it("returns a parsed recommendation for a job", async () => {
    const result = await recommendHandler(
      { sender: {} },
      { jobId: "job-1", campaignId: "campaign-test" },
    );

    expect(mockRecommendResumeStrategy).toHaveBeenCalledWith({
      jobId: "job-1",
      campaignId: "campaign-test",
    });
    expect(result).toMatchObject({
      jobId: "job-1",
      source: "role_family",
      strategyId: "strategy-1",
    });
  });

  it("rejects a recommendation payload without a job id", async () => {
    await expect(
      recommendHandler({ sender: {} }, { campaignId: "campaign-test" }),
    ).rejects.toThrow();
    expect(mockRecommendResumeStrategy).not.toHaveBeenCalled();
  });

  it("assigns a campaign resume strategy default", async () => {
    const result = await setCampaignDefaultHandler(
      { sender: {} },
      { campaignId: "campaign-test", strategyId: "strategy-1" },
    );

    expect(mockSetCampaignResumeStrategyDefault).toHaveBeenCalledWith({
      campaignId: "campaign-test",
      strategyId: "strategy-1",
    });
    expect(answeredView(result)).toMatchObject({ module: "job-finder" });
  });

  it("rejects a campaign default payload missing the strategy id field", async () => {
    await expect(
      setCampaignDefaultHandler(
        { sender: {} },
        { campaignId: "campaign-test" },
      ),
    ).rejects.toThrow();
    expect(mockSetCampaignResumeStrategyDefault).not.toHaveBeenCalled();
  });

  it("saves, disables, and selects strategies through typed payloads", async () => {
    const saveInput = {
      id: null,
      name: "Backend",
      roleFamily: "Backend Engineering",
      baseResumeDocumentId: "document-1",
      templateId: "classic_ats",
      headlinePolicy: "fixed",
      skillsPolicy: "base_only",
      coveragePolicy: "base_omissions",
      tailoringStrength: "conservative",
      evidenceBoundaries: {
        allowExactClaims: true,
        allowParaphrasedClaims: false,
        maxEvidenceRefsPerBullet: 3,
        requireVerifierPass: true,
      },
      enabled: true,
    };
    await saveHandler({ sender: {} }, saveInput);
    expect(mockSaveResumeStrategy).toHaveBeenCalledWith(saveInput);

    await disableHandler({ sender: {} }, "strategy-1");
    expect(mockDisableResumeStrategy).toHaveBeenCalledWith("strategy-1");

    const selectInput = {
      jobId: "job-1",
      campaignId: "campaign-test",
      strategyId: "strategy-1",
      source: "manual",
      reason: "Picked by the user.",
    };
    await selectHandler({ sender: {} }, selectInput);
    expect(mockSelectResumeStrategy).toHaveBeenCalledWith(selectInput);
  });

  it("rejects a selection with an empty reason so every selection stays inspectable", async () => {
    await expect(
      selectHandler(
        { sender: {} },
        {
          jobId: "job-1",
          campaignId: "campaign-test",
          strategyId: "strategy-1",
          source: "manual",
          reason: "   ",
        },
      ),
    ).rejects.toThrow();
    expect(mockSelectResumeStrategy).not.toHaveBeenCalled();
  });
});

describe("job-finder company intelligence routes", () => {
  let mutateHandler: RegisteredHandler;
  let preferenceHandler: RegisteredHandler;
  let mergeHandler: RegisteredHandler;
  let refreshHandler: RegisteredHandler;
  const mockMutateCompanyIntelligence = vi.fn();
  const mockSetCompanyPreference = vi.fn();
  const mockReviewCompanyMerge = vi.fn();
  const mockRefreshCompanyIntelligence = vi.fn();

  beforeEach(() => {
    mockMutateCompanyIntelligence.mockClear();
    mockSetCompanyPreference.mockClear();
    mockReviewCompanyMerge.mockClear();
    mockRefreshCompanyIntelligence.mockClear();
    const snapshot = createEmptyWorkspace("2026-08-15T10:00:00.000Z");
    mockMutateCompanyIntelligence.mockResolvedValue(snapshot);
    mockSetCompanyPreference.mockResolvedValue(snapshot);
    mockReviewCompanyMerge.mockResolvedValue(snapshot);
    mockRefreshCompanyIntelligence.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      mutateCompanyIntelligence: mockMutateCompanyIntelligence,
      setCompanyPreference: mockSetCompanyPreference,
      reviewCompanyMerge: mockReviewCompanyMerge,
      refreshCompanyIntelligence: mockRefreshCompanyIntelligence,
    });

    const handlers = new Map<string, RegisteredHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    registerJobFinderRouteHandlers(ipcMain);
    const mutate = handlers.get("job-finder:mutate-company-intelligence");
    const preference = handlers.get("job-finder:set-company-preference");
    const merge = handlers.get("job-finder:review-company-merge");
    const refresh = handlers.get("job-finder:refresh-company-intelligence");
    if (!mutate || !preference || !merge || !refresh) {
      throw new Error("Company intelligence handlers were not registered.");
    }
    mutateHandler = mutate;
    preferenceHandler = preference;
    mergeHandler = merge;
    refreshHandler = refresh;
  });

  it("applies a typed company intelligence mutation and returns the parsed snapshot", async () => {
    const result = await mutateHandler(
      { sender: {} },
      {
        companyId: "company_1",
        expectedUpdatedAt: "2026-08-15T10:00:00.000Z",
        mutation: {
          type: "upsert_contact",
          contact: {
            id: "contact_1",
            name: "Ada",
            role: null,
            email: null,
            phone: null,
            notes: null,
            createdAt: "2026-08-15T10:00:00.000Z",
            updatedAt: "2026-08-15T10:00:00.000Z",
          },
        },
      },
    );

    expect(mockMutateCompanyIntelligence).toHaveBeenCalledWith({
      companyId: "company_1",
      expectedUpdatedAt: "2026-08-15T10:00:00.000Z",
      mutation: {
        type: "upsert_contact",
        contact: {
          id: "contact_1",
          name: "Ada",
          role: null,
          email: null,
          phone: null,
          notes: null,
          createdAt: "2026-08-15T10:00:00.000Z",
          updatedAt: "2026-08-15T10:00:00.000Z",
        },
      },
    });
    expect(answeredView(result)).toMatchObject({ module: "job-finder" });
  });

  it("rejects a company mutation without the compare-and-swap timestamp", async () => {
    await expect(
      mutateHandler(
        { sender: {} },
        {
          companyId: "company_1",
          mutation: { type: "remove_note", noteId: "note_1" },
        },
      ),
    ).rejects.toThrow();
    expect(mockMutateCompanyIntelligence).not.toHaveBeenCalled();
  });

  it("sets a company preference and reviews a merge through typed payloads", async () => {
    await preferenceHandler(
      { sender: {} },
      { companyId: "company_1", preference: "exclude" },
    );
    expect(mockSetCompanyPreference).toHaveBeenCalledWith({
      companyId: "company_1",
      preference: "exclude",
    });

    await mergeHandler(
      { sender: {} },
      {
        companyId: "company_1",
        candidateId: "company_2",
        decision: "accepted",
      },
    );
    expect(mockReviewCompanyMerge).toHaveBeenCalledWith({
      companyId: "company_1",
      candidateId: "company_2",
      decision: "accepted",
    });
  });

  it("rejects a merge decision that is not accepted or rejected", async () => {
    await expect(
      mergeHandler(
        { sender: {} },
        { companyId: "company_1", candidateId: "company_2", decision: "maybe" },
      ),
    ).rejects.toThrow();
    expect(mockReviewCompanyMerge).not.toHaveBeenCalled();
  });

  it("refreshes company intelligence and returns the parsed snapshot", async () => {
    const result = await refreshHandler({ sender: {} }, undefined);
    expect(mockRefreshCompanyIntelligence).toHaveBeenCalledTimes(1);
    expect(answeredView(result)).toMatchObject({ module: "job-finder" });
  });
});

describe("job-finder safeguards route", () => {
  let mutateHandler: RegisteredHandler;
  const mockMutateSafeguards = vi.fn();

  beforeEach(() => {
    mockMutateSafeguards.mockClear();
    const snapshot = createEmptyWorkspace("2026-08-15T10:00:00.000Z");
    mockMutateSafeguards.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      mutateSafeguards: mockMutateSafeguards,
    });

    const handlers = new Map<string, RegisteredHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    registerJobFinderRouteHandlers(ipcMain);
    const mutate = handlers.get("job-finder:mutate-safeguards");
    if (!mutate) {
      throw new Error("Safeguards mutation handler was not registered.");
    }
    mutateHandler = mutate;
  });

  it("applies a typed listing-signal safeguard mutation and returns the parsed snapshot", async () => {
    const result = await mutateHandler(
      { sender: {} },
      {
        type: "record_listing_signal",
        signalId: "signal_1",
        jobId: "job_1",
        signal: "suspicious",
        detail: null,
        detectedAt: "2026-08-15T10:00:00.000Z",
        confidence: 0.9,
        provenance: "provider",
        explanation: "Provider reported the listing state.",
        recoveryGuidance: "Re-verify the listing.",
      },
    );

    expect(mockMutateSafeguards).toHaveBeenCalledWith({
      type: "record_listing_signal",
      signalId: "signal_1",
      jobId: "job_1",
      signal: "suspicious",
      detail: null,
      detectedAt: "2026-08-15T10:00:00.000Z",
      confidence: 0.9,
      provenance: "provider",
      explanation: "Provider reported the listing state.",
      recoveryGuidance: "Re-verify the listing.",
    });
    expect(answeredView(result)).toMatchObject({ module: "job-finder" });
  });

  it("rejects a safeguard mutation that attempts to carry submit authority", async () => {
    await expect(
      mutateHandler(
        { sender: {} },
        {
          type: "record_listing_signal",
          signalId: "signal_1",
          jobId: "job_1",
          signal: "stale",
          detail: null,
          detectedAt: "2026-08-15T10:00:00.000Z",
          confidence: 0.5,
          provenance: "provider",
          explanation: "Provider reported the listing state.",
          recoveryGuidance: "Re-verify the listing.",
          submitAuthorized: true,
        },
      ),
    ).rejects.toThrow();
    expect(mockMutateSafeguards).not.toHaveBeenCalled();
  });

  it("rejects an unknown safeguard mutation kind", async () => {
    await expect(
      mutateHandler({ sender: {} }, { type: "not_a_real_kind" }),
    ).rejects.toThrow();
    expect(mockMutateSafeguards).not.toHaveBeenCalled();
  });
});

describe("job-finder application CRM bulk stage route", () => {
  const mockMutateApplicationCrmBulkStage = vi.fn();

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("validates one batch payload and returns one parsed workspace snapshot", async () => {
    const snapshot = createEmptyWorkspace("2026-08-15T10:00:00.000Z");
    mockMutateApplicationCrmBulkStage.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      mutateApplicationCrmBulkStage: mockMutateApplicationCrmBulkStage,
    });

    const handlers = new Map<string, RegisteredHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    registerJobFinderRouteHandlers(ipcMain);
    const handler = handlers.get(
      "job-finder:mutate-application-crm-bulk-stage",
    );
    if (!handler) {
      throw new Error("Application CRM bulk stage handler was not registered.");
    }

    const result = await handler(
      { sender: {} },
      {
        items: [
          { applicationRecordId: "application_1", expectedRevision: 2 },
          { applicationRecordId: "application_2", expectedRevision: 0 },
        ],
        stage: "reviewing",
      },
    );

    expect(mockMutateApplicationCrmBulkStage).toHaveBeenCalledWith({
      items: [
        { applicationRecordId: "application_1", expectedRevision: 2 },
        { applicationRecordId: "application_2", expectedRevision: 0 },
      ],
      stage: "reviewing",
      customStageId: null,
      note: null,
    });
    expect(answeredView(result)).toMatchObject({ module: "job-finder" });
  });
});

describe("job-finder agent discovery outcome routes", () => {
  const mockRunAgentDiscovery = vi.fn();

  afterEach(() => {
    vi.clearAllMocks();
  });

  function registerAndFindDiscoveryHandler(
    channel = "job-finder:run-agent-discovery",
  ): RegisteredHandler {
    const handlers = new Map<string, RegisteredHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcMain;
    registerJobFinderRouteHandlers(ipcMain);

    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error("Agent discovery handler was not registered.");
    }
    return handler;
  }

  function workspaceWithRunState(
    generatedAt: string,
    runState: "completed" | "cancelled",
    validJobsFound: number,
  ) {
    const cancelledRun = DiscoveryRunRecordSchema.parse({
      id: `discovery_run_${runState}`,
      state: runState,
      startedAt: "2026-08-26T10:00:00.000Z",
      summary: { validJobsFound },
    });

    return JobFinderWorkspaceSnapshotSchema.parse({
      ...createEmptyWorkspace(generatedAt),
      discoveryRunState: runState,
      recentDiscoveryRuns: [cancelledRun],
    });
  }

  const sender = { id: 7, send: vi.fn() };

  it("answers command search and cancellation without requesting a workspace", async () => {
    const reply = { outcome: "completed", runId: "command_run", newJobs: 12 };
    const runAgentDiscoveryCommand = vi.fn().mockResolvedValue(reply);
    const cancelDiscoveryRunCommand = vi
      .fn()
      .mockResolvedValue({ runId: "command_run", accepted: true });
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      runAgentDiscoveryCommand,
      cancelDiscoveryRunCommand,
      getWorkspaceProjection: mockGetWorkspaceProjection,
    });
    expect(
      await registerAndFindDiscoveryHandler(
        "job-finder:run-agent-discovery-command",
      )(
        { sender },
        { requestId: "command_request", targetId: "target_example" },
      ),
    ).toEqual(reply);
    expect(runAgentDiscoveryCommand).toHaveBeenCalledWith(
      expect.any(Function),
      "target_example",
      undefined,
    );
    expect(
      await registerAndFindDiscoveryHandler(
        "job-finder:cancel-discovery-run-command",
      )({ sender }, { runId: "command_run" }),
    ).toEqual({ runId: "command_run", accepted: true });
    expect(mockGetWorkspaceProjection).not.toHaveBeenCalled();
    expect(mockRunAgentDiscovery).not.toHaveBeenCalled();
  });

  it("classifies a resolved cancel-after-partial-checkpoint run as cancelled", async () => {
    // The service finalizes a user-cancelled run as state `cancelled`,
    // persists incrementally committed jobs, and resolves — no rejection.
    const snapshot = workspaceWithRunState(
      "2026-08-26T10:05:00.000Z",
      "cancelled",
      3,
    );
    mockRunAgentDiscovery.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      runAgentDiscovery: mockRunAgentDiscovery,
      getWorkspaceProjection: mockGetWorkspaceProjection,
    });

    const result = await registerAndFindDiscoveryHandler()(
      { sender },
      { requestId: "agent_discovery_partial", targetId: null },
    );

    expect(result).toMatchObject({
      outcome: "cancelled",
      sync: { kind: "snapshot", snapshot },
    });
    // Derivation came from the returned run state; the abort fallback never
    // ran.
    expect(mockGetWorkspaceProjection).not.toHaveBeenCalled();
  });

  it("classifies an escaped AbortError before any result as cancelled", async () => {
    mockRunAgentDiscovery.mockRejectedValue(
      new DOMException("Aborted", "AbortError"),
    );
    const freshSnapshot = createEmptyWorkspace("2026-08-26T10:06:00.000Z");
    mockGetWorkspaceProjection.mockResolvedValue(freshSnapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      runAgentDiscovery: mockRunAgentDiscovery,
      getWorkspaceProjection: mockGetWorkspaceProjection,
    });

    const result = await registerAndFindDiscoveryHandler()(
      { sender },
      { requestId: "agent_discovery_abort", targetId: null },
    );

    expect(result).toMatchObject({
      outcome: "cancelled",
      sync: { kind: "snapshot", snapshot: freshSnapshot },
    });
    expect(mockGetWorkspaceProjection).toHaveBeenCalledTimes(1);
  });

  it("keeps outcome completed for a normally finished run", async () => {
    const snapshot = workspaceWithRunState(
      "2026-08-26T10:07:00.000Z",
      "completed",
      12,
    );
    mockRunAgentDiscovery.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      runAgentDiscovery: mockRunAgentDiscovery,
      getWorkspaceProjection: mockGetWorkspaceProjection,
    });

    const result = await registerAndFindDiscoveryHandler()(
      { sender },
      { requestId: "agent_discovery_done", targetId: null },
    );

    expect(result).toMatchObject({
      outcome: "completed",
      sync: { kind: "snapshot", snapshot },
    });
    expect(mockGetWorkspaceProjection).not.toHaveBeenCalled();
  });

  it("answers a window that holds a revision with only what the search changed", async () => {
    const before = workspaceWithRunState(
      "2026-08-26T10:07:00.000Z",
      "completed",
      0,
    );
    const after = workspaceWithRunState(
      "2026-08-26T10:08:00.000Z",
      "completed",
      12,
    );
    mockRunAgentDiscovery.mockResolvedValue(after);
    mockGetWorkspaceProjection.mockResolvedValue(before);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      runAgentDiscovery: mockRunAgentDiscovery,
      getWorkspaceProjection: mockGetWorkspaceProjection,
    });
    const handlers = new Map<string, RegisteredHandler>();
    registerJobFinderRouteHandlers(
      {
        handle: (channel: string, handler: RegisteredHandler) => {
          handlers.set(channel, handler);
        },
      } as unknown as IpcMain,
      { includeBootstrapRoutes: false },
    );
    const window = { id: 8, send: vi.fn() };
    const baseline = JobFinderWorkspaceSyncResultSchema.parse(
      await handlers.get("job-finder:sync-workspace")!(
        { sender: window },
        { baseRevision: null },
      ),
    );
    if (baseline.kind !== "snapshot")
      throw new Error("Expected an initial snapshot");
    await handlers.get("job-finder:note-workspace-revision")!(
      { sender: window },
      { revision: baseline.currentRevision },
    );

    const reply = JobFinderAgentDiscoveryReplySchema.parse(
      await handlers.get("job-finder:run-agent-discovery")!(
        { sender: window },
        { requestId: "agent_discovery_delta", targetId: null },
      ),
    );

    expect(reply.outcome).toBe("completed");
    expect(reply.sync.kind).toBe("delta");
    if (reply.sync.kind !== "delta") throw new Error("Expected a delta");
    expect(reply.sync.delta.baseRevision).toBe(baseline.currentRevision);
    expect(reply.sync.delta.recentDiscoveryRuns.upserts).toEqual(
      after.recentDiscoveryRuns,
    );
  });

  it("passes the person's search request to the discovery service", async () => {
    const snapshot = workspaceWithRunState(
      "2026-08-26T10:07:00.000Z",
      "completed",
      12,
    );
    mockRunAgentDiscovery.mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      runAgentDiscovery: mockRunAgentDiscovery,
      getWorkspaceProjection: mockGetWorkspaceProjection,
    });
    const searchRequest = {
      intent: "around engineering",
      breadth: "wide" as const,
      freshness: "recent" as const,
      sourceIds: ["target_example"],
    };

    await registerAndFindDiscoveryHandler()(
      { sender },
      {
        requestId: "agent_discovery_goal",
        targetId: null,
        searchRequest,
      },
    );

    expect(mockRunAgentDiscovery).toHaveBeenCalledWith(
      expect.any(Function),
      undefined,
      undefined,
      searchRequest,
    );
  });

  it("rethrows non-abort discovery failures instead of inventing an outcome", async () => {
    mockRunAgentDiscovery.mockRejectedValue(new Error("fetch failed"));
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      runAgentDiscovery: mockRunAgentDiscovery,
      getWorkspaceProjection: mockGetWorkspaceProjection,
    });

    await expect(
      registerAndFindDiscoveryHandler()(
        { sender },
        { requestId: "agent_discovery_failed", targetId: null },
      ),
    ).rejects.toThrow("fetch failed");
    expect(mockGetWorkspaceProjection).not.toHaveBeenCalled();
  });
});

describe("job-finder synthetic save failure route", () => {
  const originalTestApiFlag = process.env.NESTOR_ENABLE_TEST_API;

  function registerHandlers(): Map<string, RegisteredHandler> {
    const handlers = new Map<string, RegisteredHandler>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;
    registerJobFinderRouteHandlers(ipcMain);
    return handlers;
  }

  // The arm route answers synchronously; every save route stays async.
  type AnyRegisteredHandler = (
    event: { sender: object },
    payload: unknown,
  ) => unknown;

  function requireHandler(
    handlers: Map<string, RegisteredHandler>,
    channel: string,
  ): AnyRegisteredHandler {
    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error(`Handler was not registered: ${channel}`);
    }
    return handler as AnyRegisteredHandler;
  }

  afterEach(async () => {
    // Never leave an arm behind for another suite.
    process.env.NESTOR_ENABLE_TEST_API = "1";
    const handlers = registerHandlers();
    mockIsDesktopTestApiEnabled.mockReturnValue(true);
    requireHandler(handlers, "job-finder:test-fail-next-save")(
      { sender: {} },
      "profile",
    );
    try {
      await requireHandler(handlers, "job-finder:save-profile")(
        { sender: {} },
        {},
      );
    } catch {
      // Consuming the arm is the point; the save itself is irrelevant here.
    }

    if (originalTestApiFlag === undefined) {
      delete process.env.NESTOR_ENABLE_TEST_API;
    } else {
      process.env.NESTOR_ENABLE_TEST_API = originalTestApiFlag;
    }
    mockIsDesktopTestApiEnabled.mockReturnValue(false);
    vi.clearAllMocks();
  });

  it("refuses to arm a synthetic failure while the test API is disabled", () => {
    delete process.env.NESTOR_ENABLE_TEST_API;
    mockIsDesktopTestApiEnabled.mockReturnValue(false);

    expect(() =>
      requireHandler(registerHandlers(), "job-finder:test-fail-next-save")(
        { sender: {} },
        "profile",
      ),
    ).toThrow(/Desktop test API is disabled/);
  });

  it("fails one campaign save before persistence and allows retry", async () => {
    process.env.NESTOR_ENABLE_TEST_API = "1";
    mockIsDesktopTestApiEnabled.mockReturnValue(true);
    const snapshot = createEmptyWorkspace("2026-09-26T10:00:00.000Z");
    const saveCampaign = vi.fn().mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({ saveCampaign });
    const handlers = registerHandlers();
    requireHandler(handlers, "job-finder:test-fail-next-save")(
      { sender: {} },
      "campaign",
    );
    const save = requireHandler(handlers, "job-finder:save-campaign");
    const campaign = snapshot.campaigns[0];
    await expect(save({ sender: {} }, campaign)).rejects.toThrow(
      /could not write the campaign change/,
    );
    expect(saveCampaign).not.toHaveBeenCalled();
    await expect(save({ sender: {} }, campaign)).resolves.toEqual(
      wholeViewAnswer(snapshot),
    );
    expect(saveCampaign).toHaveBeenCalledTimes(1);
  });

  it("fails exactly one save on the armed surface and leaves other surfaces alone", async () => {
    process.env.NESTOR_ENABLE_TEST_API = "1";
    mockIsDesktopTestApiEnabled.mockReturnValue(true);
    const snapshot = createEmptyWorkspace("2026-09-03T10:00:00.000Z");
    const saveProfile = vi.fn().mockResolvedValue(snapshot);
    const updateAppearanceTheme = vi.fn().mockResolvedValue(snapshot);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      saveProfile,
      updateAppearanceTheme,
    });

    const handlers = registerHandlers();
    expect(
      requireHandler(handlers, "job-finder:test-fail-next-save")(
        { sender: {} },
        "profile",
      ),
    ).toEqual({ ok: true });

    // A settings save while `profile` is armed must still succeed.
    await expect(
      requireHandler(handlers, "job-finder:update-appearance-theme")(
        { sender: {} },
        AppearanceThemeSchema.parse("dark"),
      ),
    ).resolves.toEqual(wholeViewAnswer(snapshot));
    expect(updateAppearanceTheme).toHaveBeenCalledTimes(1);

    const profile = createEmptyJobFinderRepositoryState().profile;
    await expect(
      requireHandler(handlers, "job-finder:save-profile")(
        { sender: {} },
        profile,
      ),
    ).rejects.toThrow(/could not write the profile change/);
    expect(saveProfile).not.toHaveBeenCalled();

    // One-shot: the very next profile save runs normally again.
    await expect(
      requireHandler(handlers, "job-finder:save-profile")(
        { sender: {} },
        profile,
      ),
    ).resolves.toEqual(wholeViewAnswer(snapshot));
    expect(saveProfile).toHaveBeenCalledTimes(1);
  });
});

it("Fill-in only retries a changed permission revision and revokes the broader permission", async () => {
  const first = {
    id: "authority",
    revision: 1,
    mode: "confirm_before_submit",
    status: "active",
  };
  const latest = { ...first, revision: 2 };
  const authorityService = {
    list: vi
      .fn()
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([latest]),
    revoke: vi
      .fn()
      .mockResolvedValueOnce({ status: "stale", current: latest })
      .mockResolvedValueOnce({ status: "applied" }),
    replaceUsed: vi.fn(),
  };
  mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue({
    getSettings: () =>
      Promise.resolve({ applicationAutomationMode: "prepare_only" }),
  } as never);
  mockGetJobFinderApplicationAuthorityService.mockReturnValue(authorityService);
  await syncApplicationAuthorityForSavedMode({} as never, ["job"]);
  expect(authorityService.revoke).toHaveBeenNthCalledWith(2, {
    id: "authority",
    expectedRevision: 2,
  });
  expect(authorityService.replaceUsed).not.toHaveBeenCalled();
});

it("publishes one workspace refresh after a burst of answer draft saves", async () => {
  vi.useFakeTimers();
  const saveUserActionAnswerDraft = vi.fn().mockResolvedValue(undefined);
  mockGetJobFinderWorkspaceService.mockResolvedValue({
    saveUserActionAnswerDraft,
  });
  const handlers = new Map<string, RegisteredHandler>();
  registerJobFinderRouteHandlers({
    handle: (channel: string, handler: RegisteredHandler) =>
      handlers.set(channel, handler),
  } as unknown as IpcMain);
  const handler = handlers.get("job-finder:save-user-action-answer-draft")!;
  const listener = vi.fn();
  const stop = onJobFinderWorkspaceUpdate(listener);
  try {
    await handler(
      { sender: {} },
      {
        requestId: "request",
        expectedRevision: 1,
        editedAt: 1,
        draft: { answers: { Start: "Monday" } },
      },
    );
    await vi.advanceTimersByTimeAsync(100);
    await handler(
      { sender: {} },
      {
        requestId: "request",
        expectedRevision: 1,
        editedAt: 2,
        draft: { answers: { Start: "Friday" } },
      },
    );
    expect(saveUserActionAnswerDraft).toHaveBeenCalledTimes(2);
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(listener).toHaveBeenCalledTimes(1);
  } finally {
    stop();
    vi.useRealTimers();
  }
});

it("publishes a browser-bar shortlist immediately while listing checks run", async () => {
  const snapshot = createEmptyWorkspace("2026-10-05T10:00:00.000Z");
  const queueJobForReview = vi.fn().mockResolvedValue(snapshot);
  mockGetJobFinderWorkspaceService.mockResolvedValue({ queueJobForReview });
  const handlers = new Map<string, RegisteredHandler>();
  registerJobFinderRouteHandlers({
    handle: (channel: string, handler: RegisteredHandler) =>
      handlers.set(channel, handler),
  } as unknown as IpcMain);
  const sender = { isDestroyed: vi.fn(() => false), send: vi.fn() };
  await handlers.get("job-finder:queue-job-for-review")!(
    { sender },
    { jobId: "synthetic_job" },
  );
  expect(queueJobForReview).toHaveBeenCalledWith("synthetic_job");
  expect(sender.send).toHaveBeenCalled();
});

describe("local persisted job detail route", () => {
  afterEach(() => vi.clearAllMocks());
  function handler() {
    const handlers = new Map<string, RegisteredHandler>();
    registerJobFinderRouteHandlers(
      {
        handle: vi.fn((channel: string, read: RegisteredHandler) => {
          handlers.set(channel, read);
        }),
      } as unknown as IpcMain,
      { includeBootstrapRoutes: false },
    );
    return handlers.get("job-finder:get-job-detail")!;
  }
  it("reads only the requested persisted job, keeps its full text and resolves the selected plan without enrichment", async () => {
    const stored = SavedJobSchema.parse({
      id: "detail-1",
      source: "target_site",
      sourceJobId: "detail-1",
      canonicalUrl: "https://example.test/detail-1",
      title: "Engineer",
      company: "Example",
      location: "Remote",
      workMode: ["remote"],
      applyPath: "external_redirect",
      easyApplyEligible: false,
      salaryText: null,
      description: "Complete persisted listing text. ".repeat(400),
      responsibilities: ["Full narrative evidence"],
      discoveredAt: "2026-10-13T00:00:00.000Z",
      status: "discovered",
      matchAssessment: { score: 80 },
      planAssessments: { "other-plan": { score: 20 } },
    });
    const listSavedJobsByIds = vi.fn().mockResolvedValue([stored]);
    const readDiscoveryDisplayProjection = vi.fn();
    const getWorkspaceSnapshot = vi.fn();
    const assessJobListing = vi.fn();
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      getWorkspaceSnapshot,
      assessJobListing,
    });
    mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue({
      listSavedJobsByIds,
      readDiscoveryDisplayProjection,
    } as never);
    const result = await handler()(
      { sender: {} },
      { jobId: stored.id, planId: "other-plan" },
    );
    expect(listSavedJobsByIds).toHaveBeenCalledExactlyOnceWith([stored.id]);
    expect(readDiscoveryDisplayProjection).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      planId: "other-plan",
      job: {
        id: stored.id,
        description: stored.description,
        responsibilities: stored.responsibilities,
        matchAssessment: { score: 20 },
      },
    });
    expect(stored.matchAssessment.score).toBe(80);
    expect(getWorkspaceSnapshot).not.toHaveBeenCalled();
    expect(assessJobListing).not.toHaveBeenCalled();
  });
  it("reads a selected pending job's full body from the immutable display projection without enrichment", async () => {
    const pending = Object.freeze(
      SavedJobSchema.parse({
        id: "pending-1",
        source: "target_site",
        sourceJobId: "pending-1",
        canonicalUrl: "https://example.test/pending-1",
        title: "Engineer",
        company: "Example",
        location: "Remote",
        workMode: ["remote"],
        applyPath: "external_redirect",
        easyApplyEligible: false,
        salaryText: null,
        description: "Complete pending listing text. ".repeat(400),
        responsibilities: ["Complete pending narrative evidence"],
        discoveredAt: "2026-10-13T00:00:00.000Z",
        status: "discovered",
        matchAssessment: { score: 80 },
        planAssessments: { "pending-plan": { score: 20 } },
      }),
    );
    const listSavedJobsByIds = vi.fn().mockResolvedValue([]);
    const readDiscoveryDisplayProjection = vi.fn().mockResolvedValue(
      Object.freeze({
        pendingDiscoveryJobs: Object.freeze([pending]),
      }),
    );
    const getDiscoveryState = vi.fn();
    const getWorkspaceSnapshot = vi.fn();
    const assessJobListing = vi.fn();
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      getWorkspaceSnapshot,
      assessJobListing,
    });
    mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue({
      listSavedJobsByIds,
      readDiscoveryDisplayProjection,
      getDiscoveryState,
    } as never);
    const result = await handler()(
      { sender: {} },
      { jobId: pending.id, planId: "pending-plan" },
    );
    expect(result).toMatchObject({
      planId: "pending-plan",
      job: {
        id: pending.id,
        description: pending.description,
        responsibilities: pending.responsibilities,
        matchAssessment: { score: 20 },
      },
    });
    expect(listSavedJobsByIds).toHaveBeenCalledExactlyOnceWith([pending.id]);
    expect(readDiscoveryDisplayProjection).toHaveBeenCalledTimes(1);
    expect(getDiscoveryState).not.toHaveBeenCalled();
    expect(getWorkspaceSnapshot).not.toHaveBeenCalled();
    expect(assessJobListing).not.toHaveBeenCalled();
    expect(pending.matchAssessment.score).toBe(80);
  });
  it("rejects malformed and missing detail targets", async () => {
    const read = handler();
    mockGetJobFinderWorkspaceService.mockClear();
    await expect(
      read({ sender: {} }, { jobId: "", planId: null }),
    ).rejects.toThrow();
    expect(mockGetJobFinderWorkspaceService).not.toHaveBeenCalled();
    mockGetJobFinderWorkspaceService.mockResolvedValue({});
    mockGetJobFinderRepositoryForWorkspaceService.mockReturnValue({
      listSavedJobsByIds: vi.fn().mockResolvedValue([]),
      readDiscoveryDisplayProjection: vi
        .fn()
        .mockResolvedValue({ pendingDiscoveryJobs: [] }),
    } as never);
    await expect(
      read({ sender: {} }, { jobId: "missing", planId: null }),
    ).rejects.toThrow("no longer in your workspace");
  });
});

describe("typed bulk shortlist route at 3,003 jobs", () => {
  afterEach(() => vi.clearAllMocks());

  it("calls the batch service once and returns only 50 changed thin rows", async () => {
    const seed = DiscoveryJobViewSchema.parse({
      id: "job-0",
      source: "target_site",
      sourceJobId: "synthetic",
      canonicalUrl: "https://example.test/synthetic",
      title: "Engineer",
      company: "Example",
      location: "Remote",
      workMode: ["remote"],
      applyPath: "external_redirect",
      easyApplyEligible: false,
      salaryText: null,
      description: "Full stored synthetic listing. ".repeat(400),
      discoveredAt: "2026-10-13T00:00:00.000Z",
      status: "discovered",
      matchAssessment: { score: 80 },
    });
    const jobs = Array.from({ length: 3003 }, (_, index) =>
      Object.freeze({ ...seed, id: `job-${index}` }),
    );
    const initial = {
      ...createEmptyWorkspace("2026-10-13T00:00:00.000Z"),
      discoveryJobs: jobs,
    };
    const selectedIds = jobs.slice(75, 125).map(({ id }) => id);
    const selected = new Set(selectedIds);
    const updated = {
      ...initial,
      discoveryJobs: jobs.map((job) =>
        selected.has(job.id) ? { ...job, status: "shortlisted" as const } : job,
      ),
    };
    const queueJobsForReview = vi
      .fn()
      .mockResolvedValue({ queuedJobIds: selectedIds });
    const queueJobForReview = vi.fn();
    const getWorkspaceSnapshot = vi.fn();
    const getWorkspaceProjection = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(updated);
    mockGetJobFinderWorkspaceService.mockResolvedValue({
      queueJobsForReview,
      queueJobForReview,
      getWorkspaceSnapshot,
      getWorkspaceProjection,
    });
    const handlers = new Map<string, RegisteredHandler>();
    registerJobFinderRouteHandlers(
      {
        handle: (channel: string, read: RegisteredHandler) => {
          handlers.set(channel, read);
        },
      } as unknown as IpcMain,
      { includeBootstrapRoutes: false },
    );
    const baseline = JobFinderWorkspaceSyncResultSchema.parse(
      await handlers.get("job-finder:sync-workspace")!(
        { sender: {} },
        { baseRevision: null },
      ),
    );
    expect(baseline.kind).toBe("snapshot");
    if (baseline.kind !== "snapshot")
      throw new Error("Expected initial list snapshot");
    const input: JobFinderWorkspaceEntityMutationInput = {
      baseRevision: baseline.currentRevision,
      mutation: { type: "queue_jobs_for_review", jobIds: selectedIds },
    };
    const result = JobFinderWorkspaceSyncResultSchema.parse(
      await handlers.get("job-finder:mutate-workspace-entities")!(
        { sender: {} },
        input,
      ),
    );
    expect(queueJobsForReview).toHaveBeenCalledExactlyOnceWith(selectedIds);
    expect(queueJobForReview).not.toHaveBeenCalled();
    expect(getWorkspaceSnapshot).not.toHaveBeenCalled();
    expect(getWorkspaceProjection).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe("delta");
    if (result.kind !== "delta")
      throw new Error("Expected thin mutation delta");
    expect(result.delta.discoveryJobs.upserts.map(({ id }) => id)).toEqual(
      selectedIds,
    );
    expect(
      result.delta.discoveryJobs.upserts.every(
        ({ status }) => status === "shortlisted",
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain(seed.description);
    expect(jobs).toHaveLength(3003);
    expect(jobs[75]?.status).toBe("discovered");
    await expect(
      handlers.get("job-finder:mutate-workspace-entities")!(
        { sender: {} },
        {
          baseRevision: baseline.currentRevision,
          mutation: { type: "queue_jobs_for_review", jobIds: [] },
        },
      ),
    ).rejects.toThrow();
    expect(queueJobsForReview).toHaveBeenCalledTimes(1);
  });
});
