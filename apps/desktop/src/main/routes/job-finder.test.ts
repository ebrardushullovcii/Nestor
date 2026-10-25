import {
  AppearanceThemeSchema,
  ApplicationPacketSchema,
  DiscoveryJobViewSchema,
  JobFinderProfileCopilotPatchGroupActionInputSchema,
  JobFinderUndoProfileRevisionInputSchema,
  JobFinderWorkspaceSnapshotSchema,
  JobFinderWorkspaceSyncResultSchema,
  SavedJobSchema,
  UpdateAiBehaviorInputSchema,
  UpdateApplicationDefaultsInputSchema,
  UpdateWorkspaceBehaviorInputSchema,
  getDefaultCampaignConfiguration,
  type JobFinderWorkspaceEntityMutationInput,
} from "@nestor/contracts";
import type { IpcMain } from "electron";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as TestApiModule from "../services/job-finder/test-api";
import { createResumeWorkspaceDemoState } from "../adapters/job-finder-demo-state";
import { createEmptyJobFinderRepositoryState } from "../adapters/job-finder-initial-state";

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
  mockExportResumePdf,
  mockGetResumeWorkspace,
  mockGetWorkspaceBootstrap,
  mockGetWorkspaceProjection,
  mockGetJobFinderWorkspaceService,
  mockGetJobFinderRepositoryForWorkspaceService,
  mockGetJobFinderApplicationAuthorityService,
  mockImportResumeFromSourcePath,
  mockRetryInterruptedResumeImport,
  mockIsDesktopTestApiEnabled,
  mockProjectGroupedManualAnswer,
  mockProposeProfileCopilotChange,
  mockQueueJobForReview,
  mockRunDesktopResumeQualityBenchmark,
  mockShowOpenDialog,
  mockShowSaveDialog,
  mockGetPath,
  mockSnoozeGroupedDecision,
  mockUpdateAppearanceTheme,
  mockUpdateApplicationDefaults,
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
  mockExportResumePdf: vi.fn(),
  mockGetResumeWorkspace: vi.fn(),
  mockGetWorkspaceBootstrap: vi.fn(),
  mockGetWorkspaceProjection: vi.fn(),
  mockGetJobFinderWorkspaceService: vi.fn(),
  mockGetJobFinderRepositoryForWorkspaceService: vi.fn(() => null),
  mockGetJobFinderApplicationAuthorityService: vi.fn(),
  mockImportResumeFromSourcePath: vi.fn(),
  mockRetryInterruptedResumeImport: vi.fn(),
  mockIsDesktopTestApiEnabled: vi.fn(() => false),
  mockProjectGroupedManualAnswer: vi.fn(),
  mockProposeProfileCopilotChange: vi.fn(),
  mockQueueJobForReview: vi.fn(),
  mockRunDesktopResumeQualityBenchmark: vi.fn(),
  mockShowOpenDialog: vi.fn(),
  mockShowSaveDialog: vi.fn(),
  mockGetPath: vi.fn<(name: string) => string>(() => process.cwd()),
  mockSnoozeGroupedDecision: vi.fn(),
  mockUpdateAppearanceTheme: vi.fn(),
  mockUpdateApplicationDefaults: vi.fn(),
  mockUpdateWorkspaceBehavior: vi.fn(),
  mockUpdateAiBehavior: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: mockGetPath,
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

vi.mock("../services/job-finder/test-api", async (importOriginal) => ({
  ...(await importOriginal<typeof TestApiModule>()),
  isDesktopTestApiEnabled: mockIsDesktopTestApiEnabled,
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

import { onJobFinderWorkspaceUpdate } from "../services/job-finder/workspace-updates";
import {
  RETIRED_CHAT_MESSAGE,
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
    activeSourceDebugRun: null,
    recentSourceDebugRuns: [],
    discoveryJobs: [],
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
        .mockResolvedValue({}),
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
    const jobs = Array.from({ length: 76 }, (_, index) =>
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
    expect(jobs).toHaveLength(76);
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
