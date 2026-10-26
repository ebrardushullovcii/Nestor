import { createResumesBridge } from "./resumes";
import { createHomeBridge } from "./home";
import { createProfileWorkflowBridge } from "./profile-workflow";
import { createActivityBridge } from "./activity";
import { createNeedsYouBridge } from "./needs-you";
import { createTrackerBridge } from "./tracker";
import type {
  AnswerNeedsYouInput,
  AnswerNeedsYouResult,
  ApplicationDetails,
  ApplicationListPage,
  ApplicationListQuery,
  ApplicationRow,
  ApplicationStoreDemoResult,
  ApplicationTarget,
  ApplicationsForJobsInput,
  ApplyJobsInput,
  ApplyJobsResult,
  JobChange,
  NeedsYouListQuery,
  NeedsYouPage,
} from "@nestor/contracts";
import {
  contextBridge,
  ipcRenderer as nativeIpcRenderer,
  webUtils,
} from "electron";
import { browserBridge } from "./browser";
import { createAssistantBridge } from "./assistant";
import { createJobsBridge } from "./jobs";
import { createWorkspaceQueryBridge } from "./workspace-query";
import type {
  AppearanceTheme,
  CandidateAssetDeleteInput,
  CandidateAssetDeleteResult,
  CandidateAssetImportInput,
  CandidateAssetImportResult,
  CandidateAssetListInput,
  CandidateAssetListResult,
  CandidateAssetOpenInput,
  CandidateAssetOpenResult,
  CandidateAssetRestoreInput,
  CandidateAssetRestoreResult,
  CandidateProfile,
  DesktopPlatformPing,
  DesktopContextMenuInput,
  DesktopContextMenuResult,
  DesktopWindowCloseGuardState,
  DesktopWindowCloseResolution,
  DesktopWindowCloseRequest,
  EditableSourceInstructionArtifact,
  DesktopWindowControlsState,
  InterviewExportFormat,
  InterviewExportResult,
  JobFinderInterviewFollowUpInput,
  InterviewHotkeyAction,
  InterviewOverlayMoveInput,
  InterviewAudioTranscriptionInput,
  InterviewCaptionFileReadInput,
  InterviewCaptionFileTextResult,
  InterviewChatTurn,
  InterviewClipboardTextResult,
  InterviewClipboardWriteInput,
  InterviewPrepArtifactFromCueInput,
  InterviewTranscriptAnnotationInput,
  InterviewTranscriptSegmentInput,
  InterviewWorkspaceView,
  InterviewLiveSession,
  SaveInterviewSetupInput,
  SendInterviewChatMessageInput,
  UpdateInterviewOverlayPreferenceInput,
  JobFinderDiagnosticExportResult,
  JobFinderOpenBrowserSessionInput,
  ProfileCopilotContext,
  ProfileSetupReviewActionOptions,
  JobFinderPerformanceSnapshot,
  ResumeImportBenchmarkReport,
  ResumeImportBenchmarkCase,
  ResumeImportBenchmarkRequest,
  ResumeImportFieldCandidate,
  ResumeImportProgressEvent,
  ResumeImportRun,
  RevealSavedFileResult,
  ResumeTimelineRepairAction,
  ResumeDocumentBundle,
  JobFinderRepositoryState,
  JobFinderTestSaveSurface,
  JobFinderSettings,
  ProfileSetupState,
  SourceDebugProgressEvent,
  SourceDebugRunRecord,
  SourceDebugRunDetails,
  SaveJobFinderWorkspaceInput,
  JobFinderRendererWorkspaceSnapshot,
  JobFinderJobDetail,
  JobFinderWorkspaceEntityMutationInput,
  JobFinderWorkspaceSyncResult,
  JobSearchPreferences,
  SetJobFinderActivityControlInput,
  UpdateApplicationDefaultsInput,
  UpdateWorkspaceBehaviorInput,
  UpdateAiBehaviorInput,
  WorkspaceRevision,
  WriteClipboardTextResult,
  LaunchContext,
} from "@nestor/contracts";
import { LAUNCH_CONTEXT_CHANNEL } from "@nestor/contracts";
import { SYSTEM_THEME_CHANGE_EVENT } from "../shared/system-theme";
import type {
  JobFinderStartupDatabaseRecoveryFact,
  JobFinderStartupResetRecoveryFact,
} from "@nestor/contracts";

let activeResumeImportRequestId: string | null = null;
let activeSourceDebugRequestId: string | null = null;

const testApiEnabled =
  process.env.NESTOR_ENABLE_TEST_API === "1" ||
  process.env.NESTOR_ENABLE_TEST_API === "true";
const configuredSystemThemeOverride =
  process.env.NESTOR_TEST_SYSTEM_THEME === "dark" ||
  process.env.NESTOR_TEST_SYSTEM_THEME === "light"
    ? process.env.NESTOR_TEST_SYSTEM_THEME
    : null;
let currentSystemThemeOverride: "dark" | "light" | null =
  configuredSystemThemeOverride;

let jobFinderBootstrapRoutesReadyPromise: Promise<void> | null = null;
let jobFinderRoutesReadyPromise: Promise<void> | null = null;
let jobFinderAssetRoutesReadyPromise: Promise<void> | null = null;
let liveAssistantRoutesReadyPromise: Promise<void> | null = null;

function isDeferredFeatureChannel(channel: unknown): channel is string {
  return (
    typeof channel === "string" &&
    (channel.startsWith("job-finder:") || channel.startsWith("live-assistant:"))
  );
}

function ensureFeatureRoutesReady(channel: string): Promise<void> {
  if (channel.startsWith("job-finder:")) {
    if (
      channel === "job-finder:get-workspace" ||
      channel === "job-finder:get-workspace-bootstrap" ||
      channel === "job-finder:get-workspace-home"
    ) {
      jobFinderBootstrapRoutesReadyPromise ??= nativeIpcRenderer
        .invoke("system:job-finder-bootstrap-routes-ready")
        .then(() => undefined);
      return jobFinderBootstrapRoutesReadyPromise;
    }
    if (channel.startsWith("job-finder:candidate-assets:")) {
      jobFinderAssetRoutesReadyPromise ??= nativeIpcRenderer
        .invoke("system:job-finder-asset-routes-ready")
        .then(() => undefined);
      return jobFinderAssetRoutesReadyPromise;
    }
    jobFinderRoutesReadyPromise ??= nativeIpcRenderer
      .invoke("system:job-finder-routes-ready")
      .then(() => undefined);
    return jobFinderRoutesReadyPromise;
  }

  liveAssistantRoutesReadyPromise ??= nativeIpcRenderer
    .invoke("system:live-assistant-routes-ready")
    .then(() => undefined);
  return liveAssistantRoutesReadyPromise;
}

// Keep the public bridge implementation unchanged while serializing all
// feature IPC calls behind the deferred main-process route graph. System and
// window calls remain immediate so the shell can render while the graph is
// loading. Binding non-invoke methods preserves Electron's receiver contract.
const ipcRenderer = new Proxy(nativeIpcRenderer, {
  get(target, property, receiver) {
    if (property === "invoke") {
      return (channel: string, ...args: unknown[]) => {
        const invoke = target.invoke.bind(target);
        return isDeferredFeatureChannel(channel)
          ? ensureFeatureRoutesReady(channel).then(() =>
              invoke(channel, ...args),
            )
          : invoke(channel, ...args);
      };
    }

    if (property === "send") {
      return (channel: string, ...args: unknown[]) => {
        const send = target.send.bind(target);
        if (!isDeferredFeatureChannel(channel)) {
          return send(channel, ...args);
        }

        void ensureFeatureRoutesReady(channel).then(() =>
          send(channel, ...args),
        );
      };
    }

    const value: unknown = Reflect.get(target, property, receiver);
    if (typeof value === "function") {
      return (value as (...args: unknown[]) => unknown).bind(target);
    }
    return value;
  },
});

function applySystemThemeOverride(theme: "dark" | "light" | null) {
  currentSystemThemeOverride = theme;

  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SYSTEM_THEME_CHANGE_EVENT));
  }
}

function isSaveWorkspaceInputsPayload(
  profileOrInput: CandidateProfile | SaveJobFinderWorkspaceInput,
): profileOrInput is SaveJobFinderWorkspaceInput {
  return "profile" in profileOrInput && "searchPreferences" in profileOrInput;
}

function isInterviewWorkspaceView(
  value: unknown,
): value is InterviewWorkspaceView {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.module === "live-assistant" &&
    typeof candidate.generatedAt === "string" &&
    typeof candidate.setup === "object" &&
    typeof candidate.answerOverlay === "object" &&
    typeof candidate.transcriptOverlay === "object"
  );
}

function toSaveWorkspaceInputsPayload(
  profileOrInput: CandidateProfile | SaveJobFinderWorkspaceInput,
  searchPreferences?: JobSearchPreferences,
): SaveJobFinderWorkspaceInput {
  if (isSaveWorkspaceInputsPayload(profileOrInput)) {
    return profileOrInput;
  }

  if (!searchPreferences) {
    throw new Error(
      "Search preferences are required when saving workspace inputs.",
    );
  }

  return {
    profile: profileOrInput,
    searchPreferences,
  };
}

const assistantBridge = createAssistantBridge({
  // Deferred like every job-finder channel: calls wait for the routes.
  invoke: (channel, ...args) =>
    ipcRenderer.invoke(channel, ...args) as Promise<unknown>,
  on: (channel, listener) => {
    nativeIpcRenderer.on(channel, listener);
  },
  removeListener: (channel, listener) => {
    nativeIpcRenderer.removeListener(channel, listener);
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
});

const jobsBridge = createJobsBridge({
  invoke: (channel, ...args) =>
    nativeIpcRenderer.invoke(channel, ...args) as Promise<unknown>,
  on: (channel, listener) => {
    nativeIpcRenderer.on(channel, listener);
  },
  removeListener: (channel, listener) => {
    nativeIpcRenderer.removeListener(channel, listener);
  },
});

const desktopApi = {
  browser: browserBridge,
  assistant: assistantBridge,
  jobs: jobsBridge,
  resumes: createResumesBridge(nativeIpcRenderer),
  needsYou: createNeedsYouBridge(nativeIpcRenderer),
  tracker: createTrackerBridge(nativeIpcRenderer),
  home: createHomeBridge(nativeIpcRenderer),
  activity: createActivityBridge(nativeIpcRenderer),
  profileWorkflow: createProfileWorkflowBridge(nativeIpcRenderer),
  ping: () => ipcRenderer.invoke("system:ping") as Promise<DesktopPlatformPing>,
  firstScreenShown: () => ipcRenderer.send("system:first-screen-shown"),
  launchContext: () =>
    ipcRenderer.invoke(LAUNCH_CONTEXT_CHANNEL) as Promise<LaunchContext>,
  window: {
    close: () => ipcRenderer.invoke("window:close") as Promise<{ ok: true }>,
    showContextMenu: (input: DesktopContextMenuInput) =>
      ipcRenderer.invoke(
        "window:show-context-menu",
        input,
      ) as Promise<DesktopContextMenuResult>,
    getControlsState: () =>
      ipcRenderer.invoke(
        "window:get-controls-state",
      ) as Promise<DesktopWindowControlsState>,
    onControlsStateChange: (
      listener: (state: DesktopWindowControlsState) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        state: DesktopWindowControlsState,
      ) => {
        listener(state);
      };

      ipcRenderer.on("window:controls-state-changed", handler);

      return () => {
        ipcRenderer.off("window:controls-state-changed", handler);
      };
    },
    minimize: () =>
      ipcRenderer.invoke(
        "window:minimize",
      ) as Promise<DesktopWindowControlsState>,
    toggleMaximize: () =>
      ipcRenderer.invoke(
        "window:toggle-maximize",
      ) as Promise<DesktopWindowControlsState>,
    setCloseGuardState: (input: DesktopWindowCloseGuardState) =>
      ipcRenderer.invoke("window:set-close-guard-state", input) as Promise<{
        ok: true;
      }>,
    resolveCloseRequest: (input: DesktopWindowCloseResolution) =>
      ipcRenderer.invoke("window:resolve-close-request", input) as Promise<{
        ok: true;
      }>,
    onCloseRequest: (
      listener: (request: DesktopWindowCloseRequest) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        request: DesktopWindowCloseRequest,
      ) => {
        listener(request);
      };

      ipcRenderer.on("window:close-requested", handler);

      return () => {
        ipcRenderer.off("window:close-requested", handler);
      };
    },
  },
  liveAssistant: {
    getSession: (sessionId: string) =>
      ipcRenderer.invoke("live-assistant:get-session", {
        sessionId,
      }) as Promise<InterviewLiveSession | null>,
    getWorkspace: () =>
      ipcRenderer.invoke(
        "live-assistant:get-workspace",
      ) as Promise<InterviewWorkspaceView>,
    onWorkspaceChange: (
      listener: (workspace: InterviewWorkspaceView) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        workspace: unknown,
      ) => {
        if (isInterviewWorkspaceView(workspace)) listener(workspace);
      };

      ipcRenderer.on("live-assistant:workspace-changed", handler);

      return () => {
        ipcRenderer.off("live-assistant:workspace-changed", handler);
      };
    },
    saveSetup: (input: SaveInterviewSetupInput) =>
      ipcRenderer.invoke(
        "live-assistant:save-setup",
        input,
      ) as Promise<InterviewWorkspaceView>,
    runRehearsal: () =>
      ipcRenderer.invoke(
        "live-assistant:run-rehearsal",
      ) as Promise<InterviewWorkspaceView>,
    startSession: () =>
      ipcRenderer.invoke(
        "live-assistant:start-session",
      ) as Promise<InterviewWorkspaceView>,
    beginReconfiguration: () =>
      ipcRenderer.invoke(
        "live-assistant:begin-reconfiguration",
      ) as Promise<InterviewWorkspaceView>,
    finishReconfiguration: () =>
      ipcRenderer.invoke(
        "live-assistant:finish-reconfiguration",
      ) as Promise<InterviewWorkspaceView>,
    performAction: (action: InterviewHotkeyAction) =>
      ipcRenderer.invoke("live-assistant:perform-action", {
        action,
      }) as Promise<InterviewWorkspaceView>,
    moveOverlayWindow: (input: InterviewOverlayMoveInput) =>
      ipcRenderer.invoke(
        "live-assistant:move-overlay-window",
        input,
      ) as Promise<{ moved: boolean }>,
    updateOverlayPreference: (input: UpdateInterviewOverlayPreferenceInput) =>
      ipcRenderer.invoke(
        "live-assistant:update-overlay-preference",
        input,
      ) as Promise<InterviewWorkspaceView>,
    deleteSession: (sessionId: string) =>
      ipcRenderer.invoke("live-assistant:delete-session", {
        sessionId,
      }) as Promise<InterviewWorkspaceView>,
    saveCueAsPrepArtifact: (input: InterviewPrepArtifactFromCueInput) =>
      ipcRenderer.invoke(
        "live-assistant:save-cue-as-prep-artifact",
        input,
      ) as Promise<InterviewWorkspaceView>,
    addTranscriptAnnotation: (input: InterviewTranscriptAnnotationInput) =>
      ipcRenderer.invoke(
        "live-assistant:add-transcript-annotation",
        input,
      ) as Promise<InterviewWorkspaceView>,
    addTranscriptSegment: (input: InterviewTranscriptSegmentInput) =>
      ipcRenderer.invoke(
        "live-assistant:add-transcript-segment",
        input,
      ) as Promise<InterviewWorkspaceView>,
    sendChatMessage: (input: SendInterviewChatMessageInput) =>
      ipcRenderer.invoke(
        "live-assistant:send-chat-message",
        input,
      ) as Promise<InterviewChatTurn>,
    transcribeAudioChunk: (input: InterviewAudioTranscriptionInput) =>
      ipcRenderer.invoke(
        "live-assistant:transcribe-audio-chunk",
        input,
      ) as Promise<InterviewWorkspaceView>,
    verifyOverlayProtection: () =>
      ipcRenderer.invoke(
        "live-assistant:verify-overlay-protection",
      ) as Promise<InterviewWorkspaceView>,
    resetOverlayPreferences: () =>
      ipcRenderer.invoke(
        "live-assistant:reset-overlay-preferences",
      ) as Promise<InterviewWorkspaceView>,
    readClipboardText: () =>
      ipcRenderer.invoke(
        "live-assistant:read-clipboard-text",
      ) as Promise<InterviewClipboardTextResult>,
    writeClipboardText: (input: InterviewClipboardWriteInput) =>
      ipcRenderer.invoke(
        "live-assistant:write-clipboard-text",
        input,
      ) as Promise<{ written: true }>,
    selectCaptionFile: () =>
      ipcRenderer.invoke(
        "live-assistant:select-caption-file",
      ) as Promise<InterviewCaptionFileTextResult>,
    readCaptionFile: (input: InterviewCaptionFileReadInput) =>
      ipcRenderer.invoke(
        "live-assistant:read-caption-file",
        input,
      ) as Promise<InterviewCaptionFileTextResult>,
    exportSession: (
      sessionId: string,
      format: InterviewExportFormat = "markdown",
    ) =>
      ipcRenderer.invoke("live-assistant:export-session", {
        sessionId,
        format,
      }) as Promise<InterviewExportResult>,
    recordJobFinderFollowUp: (input: JobFinderInterviewFollowUpInput) =>
      ipcRenderer.invoke(
        "live-assistant:record-job-finder-follow-up",
        input,
      ) as Promise<JobFinderRendererWorkspaceSnapshot>,
  },
  jobFinder: {
    applyJobs: (input: ApplyJobsInput) =>
      ipcRenderer.invoke(
        "job-finder:apply-jobs",
        input,
      ) as Promise<ApplyJobsResult>,
    listApplications: (input: ApplicationListQuery = {}) =>
      ipcRenderer.invoke(
        "job-finder:list-applications",
        input,
      ) as Promise<ApplicationListPage>,
    applicationsForJobs: (input: ApplicationsForJobsInput) =>
      ipcRenderer.invoke("job-finder:applications-for-jobs", input) as Promise<
        ApplicationRow[]
      >,
    getApplicationDetails: (input: ApplicationTarget) =>
      ipcRenderer.invoke(
        "job-finder:get-application-details",
        input,
      ) as Promise<ApplicationDetails | null>,
    openApplication: (input: ApplicationTarget) =>
      ipcRenderer.invoke(
        "job-finder:open-application",
        input,
      ) as Promise<boolean>,
    stopApplication: (input: ApplicationTarget) =>
      ipcRenderer.invoke(
        "job-finder:stop-application",
        input,
      ) as Promise<boolean>,
    listNeedsYou: (input: NeedsYouListQuery = {}) =>
      ipcRenderer.invoke(
        "job-finder:list-needs-you",
        input,
      ) as Promise<NeedsYouPage>,
    answerNeedsYou: (input: AnswerNeedsYouInput) =>
      ipcRenderer.invoke(
        "job-finder:answer-needs-you",
        input,
      ) as Promise<AnswerNeedsYouResult>,
    onApplicationsChange: (listener: (change: JobChange) => void) => {
      const handler = (_event: unknown, value: unknown) =>
        listener(value as JobChange);
      ipcRenderer.on("job-finder:applications-changed", handler);
      return () =>
        ipcRenderer.removeListener("job-finder:applications-changed", handler);
    },
    queries: createWorkspaceQueryBridge(),
    getJobDetail: (jobId: string, planId: string | null) =>
      ipcRenderer.invoke("job-finder:get-job-detail", {
        jobId,
        planId,
      }) as Promise<JobFinderJobDetail>,
    listCandidateAssets: (
      input: CandidateAssetListInput = { includeDeleted: false },
    ) =>
      ipcRenderer.invoke(
        "job-finder:candidate-assets:list",
        input,
      ) as Promise<CandidateAssetListResult>,
    importCandidateAsset: (input: CandidateAssetImportInput) =>
      ipcRenderer.invoke(
        "job-finder:candidate-assets:import",
        input,
      ) as Promise<CandidateAssetImportResult>,
    deleteCandidateAsset: (input: CandidateAssetDeleteInput) =>
      ipcRenderer.invoke(
        "job-finder:candidate-assets:delete",
        input,
      ) as Promise<CandidateAssetDeleteResult>,
    openCandidateAsset: (input: CandidateAssetOpenInput) =>
      ipcRenderer.invoke(
        "job-finder:candidate-assets:open",
        input,
      ) as Promise<CandidateAssetOpenResult>,
    restoreCandidateAsset: (input: CandidateAssetRestoreInput) =>
      ipcRenderer.invoke(
        "job-finder:candidate-assets:restore",
        input,
      ) as Promise<CandidateAssetRestoreResult>,
    getWorkspace: () =>
      ipcRenderer.invoke(
        "job-finder:get-workspace",
      ) as Promise<JobFinderRendererWorkspaceSnapshot>,
    getWorkspaceBootstrap: () =>
      ipcRenderer.invoke(
        "job-finder:get-workspace-bootstrap",
      ) as Promise<JobFinderRendererWorkspaceSnapshot>,
    getWorkspaceHome: () =>
      ipcRenderer.invoke(
        "job-finder:get-workspace-home",
      ) as Promise<JobFinderRendererWorkspaceSnapshot | null>,
    syncWorkspace: (baseRevision: WorkspaceRevision | null) =>
      ipcRenderer.invoke("job-finder:sync-workspace", {
        baseRevision,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    // Queued in order with this window's later requests, so main sees the
    // revision before the change it answers.
    noteWorkspaceRevision: (revision: WorkspaceRevision) => {
      void ipcRenderer
        .invoke("job-finder:note-workspace-revision", { revision })
        .catch(() => undefined);
    },
    onWorkspaceUpdate: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on("job-finder:workspace-updated", handler);
      return () => {
        ipcRenderer.removeListener("job-finder:workspace-updated", handler);
      };
    },
    // A clicked "Search finished" notice opens the screen it is about.
    onOpenRoute: (listener: (route: string) => void) => {
      const handler = (_event: unknown, route: unknown) => {
        if (typeof route === "string" && route.startsWith("/job-finder/"))
          listener(route);
      };
      ipcRenderer.on("job-finder:open-route", handler);
      return () => {
        ipcRenderer.removeListener("job-finder:open-route", handler);
      };
    },
    mutateWorkspaceEntities: (input: JobFinderWorkspaceEntityMutationInput) =>
      ipcRenderer.invoke(
        "job-finder:mutate-workspace-entities",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    openBrowserSession: (input?: JobFinderOpenBrowserSessionInput) =>
      ipcRenderer.invoke(
        "job-finder:open-browser-session",
        input ?? {},
      ) as Promise<JobFinderWorkspaceSyncResult>,
    checkBrowserSession: () =>
      ipcRenderer.invoke(
        "job-finder:check-browser-session",
      ) as Promise<JobFinderWorkspaceSyncResult>,
    saveProfile: (profile: CandidateProfile) =>
      ipcRenderer.invoke(
        "job-finder:save-profile",
        profile,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    saveWorkspaceInputs: (
      profileOrInput: CandidateProfile | SaveJobFinderWorkspaceInput,
      searchPreferences?: JobSearchPreferences,
    ) =>
      ipcRenderer.invoke(
        "job-finder:save-workspace-inputs",
        toSaveWorkspaceInputsPayload(profileOrInput, searchPreferences),
      ) as Promise<JobFinderWorkspaceSyncResult>,
    analyzeProfileFromResume: () =>
      ipcRenderer.invoke(
        "job-finder:analyze-profile-from-resume",
      ) as Promise<JobFinderWorkspaceSyncResult>,
    saveSearchPreferences: (searchPreferences: JobSearchPreferences) =>
      ipcRenderer.invoke(
        "job-finder:save-search-preferences",
        searchPreferences,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    setActivityControl: (input: SetJobFinderActivityControlInput) =>
      ipcRenderer.invoke(
        "job-finder:set-activity-control",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    saveSettings: (settings: JobFinderSettings) =>
      ipcRenderer.invoke(
        "job-finder:save-settings",
        settings,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    updateApplicationDefaults: (input: UpdateApplicationDefaultsInput) =>
      ipcRenderer.invoke(
        "job-finder:update-application-defaults",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    updateWorkspaceBehavior: (input: UpdateWorkspaceBehaviorInput) =>
      ipcRenderer.invoke(
        "job-finder:update-workspace-behavior",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    updateAiBehavior: (input: UpdateAiBehaviorInput) =>
      ipcRenderer.invoke(
        "job-finder:update-ai-behavior",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    updateAppearanceTheme: (appearanceTheme: AppearanceTheme) =>
      ipcRenderer.invoke(
        "job-finder:update-appearance-theme",
        appearanceTheme,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    saveProfileSetupState: (profileSetupState: ProfileSetupState) =>
      ipcRenderer.invoke(
        "job-finder:save-profile-setup-state",
        profileSetupState,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    applyProfileSetupReviewAction: (
      reviewItemId: string,
      action: "confirm" | "dismiss" | "clear_value",
      options?: ProfileSetupReviewActionOptions,
    ) =>
      ipcRenderer.invoke("job-finder:apply-profile-setup-review-action", {
        reviewItemId,
        action,
        options,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    applyResumeTimelineRepairAction: (
      runId: string,
      proposalId: string,
      action: ResumeTimelineRepairAction,
    ) =>
      ipcRenderer.invoke("job-finder:apply-resume-timeline-repair-action", {
        runId,
        proposalId,
        action,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    sendProfileCopilotMessage: (
      content: string,
      context?: ProfileCopilotContext,
    ) =>
      ipcRenderer.invoke("job-finder:send-profile-copilot-message", {
        content,
        context: context ?? { surface: "general" },
      }) as Promise<JobFinderRendererWorkspaceSnapshot>,
    applyProfileCopilotPatchGroup: (patchGroupId: string) =>
      ipcRenderer.invoke("job-finder:apply-profile-copilot-patch-group", {
        patchGroupId,
      }) as Promise<JobFinderRendererWorkspaceSnapshot>,
    rejectProfileCopilotPatchGroup: (patchGroupId: string) =>
      ipcRenderer.invoke("job-finder:reject-profile-copilot-patch-group", {
        patchGroupId,
      }) as Promise<JobFinderRendererWorkspaceSnapshot>,
    undoProfileRevision: (revisionId: string) =>
      ipcRenderer.invoke("job-finder:undo-profile-revision", {
        revisionId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    importResume: (
      onProgress?: (event: ResumeImportProgressEvent) => void,
      options?: { retryInterrupted?: boolean },
    ) => {
      if (activeResumeImportRequestId) {
        return Promise.reject(new Error("A resume import is already running."));
      }

      const requestId = `resume_import_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const progressChannel = `job-finder:resume-import-progress:${requestId}`;
      activeResumeImportRequestId = requestId;
      const progressHandler = onProgress
        ? (
            _event: Electron.IpcRendererEvent,
            progress: ResumeImportProgressEvent,
          ) => {
            onProgress(progress);
          }
        : null;

      const cleanup = () => {
        if (progressHandler) {
          ipcRenderer.off(progressChannel, progressHandler);
        }
        if (activeResumeImportRequestId === requestId) {
          activeResumeImportRequestId = null;
        }
      };

      try {
        if (progressHandler) {
          ipcRenderer.on(progressChannel, progressHandler);
        }

        // Keep cleanup around the invoke itself as well as its promise. A
        // renderer teardown or a test double can throw synchronously before
        // Electron returns the IPC promise, which otherwise leaves the
        // module-level single-flight lock and listener stranded.
        return Promise.resolve(
          ipcRenderer.invoke("job-finder:import-resume", {
            requestId,
            ...(options?.retryInterrupted === true
              ? { retryInterrupted: true }
              : {}),
          }) as Promise<JobFinderWorkspaceSyncResult>,
        ).finally(cleanup);
      } catch (error) {
        cleanup();
        return Promise.reject(
          error instanceof Error
            ? error
            : new Error("Resume import could not start."),
        );
      }
    },
    cancelImportResume: (stopProcessing = false) => {
      const requestId = activeResumeImportRequestId;
      if (!requestId) {
        return;
      }

      // Keep the request identity in the payload so main can fence a late
      // native file choice. Release the renderer single-flight lock after the
      // send; the main handler will discard that old choice if the picker
      // returns later, and its finally cannot clear a newer request.
      ipcRenderer.send("job-finder:cancel-import-resume", {
        requestId,
        ...(stopProcessing ? { stopProcessing: true } : {}),
      });
      if (activeResumeImportRequestId === requestId) {
        activeResumeImportRequestId = null;
      }
    },
    runSourceDebug: (
      targetId: string,
      onProgress?: (event: SourceDebugProgressEvent) => void,
      options?: { readabilityTimeoutMs?: number },
    ) => {
      if (activeSourceDebugRequestId) {
        return Promise.reject(new Error("Source debug is already running."));
      }

      const requestId = `source_debug_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const progressChannel = `job-finder:source-debug-progress:${requestId}`;
      activeSourceDebugRequestId = requestId;
      const progressHandler = onProgress
        ? (
            _event: Electron.IpcRendererEvent,
            event: SourceDebugProgressEvent,
          ) => {
            onProgress(event);
          }
        : null;

      if (progressHandler) {
        ipcRenderer.on(progressChannel, progressHandler);
      }

      const cleanup = () => {
        if (progressHandler) {
          ipcRenderer.off(progressChannel, progressHandler);
        }
        if (activeSourceDebugRequestId === requestId) {
          activeSourceDebugRequestId = null;
        }
      };

      return ipcRenderer
        .invoke("job-finder:run-source-debug", {
          targetId,
          requestId,
          ...(options?.readabilityTimeoutMs
            ? { readabilityTimeoutMs: options.readabilityTimeoutMs }
            : {}),
        })
        .finally(cleanup) as Promise<JobFinderWorkspaceSyncResult>;
    },
    cancelSourceDebug: (runId: string) =>
      ipcRenderer.invoke("job-finder:cancel-source-debug", {
        runId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    getSourceDebugRun: (runId: string) =>
      ipcRenderer.invoke("job-finder:get-source-debug-run", {
        runId,
      }) as Promise<SourceDebugRunRecord>,
    getSourceDebugRunDetails: (runId: string) =>
      ipcRenderer.invoke("job-finder:get-source-debug-run-details", {
        runId,
      }) as Promise<SourceDebugRunDetails>,
    exportDiagnostics: () =>
      ipcRenderer.invoke(
        "job-finder:export-diagnostics",
      ) as Promise<JobFinderDiagnosticExportResult>,
    getPerformanceSnapshot: () =>
      ipcRenderer.invoke(
        "job-finder:get-performance-snapshot",
      ) as Promise<JobFinderPerformanceSnapshot>,
    saveSourceInstructionArtifact: (
      targetId: string,
      artifact: EditableSourceInstructionArtifact,
    ) =>
      ipcRenderer.invoke("job-finder:save-source-instruction-artifact", {
        targetId,
        artifact,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    listSourceDebugRuns: (targetId: string) =>
      ipcRenderer.invoke("job-finder:list-source-debug-runs", {
        targetId,
      }) as Promise<readonly SourceDebugRunRecord[]>,
    acceptSourceInstructionDraft: (targetId: string, instructionId: string) =>
      ipcRenderer.invoke("job-finder:accept-source-instruction-draft", {
        targetId,
        instructionId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    verifySourceInstructions: (targetId: string, instructionId: string) =>
      ipcRenderer.invoke("job-finder:verify-source-instructions", {
        targetId,
        instructionId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    resetBrowser: () =>
      ipcRenderer.invoke(
        "job-finder:reset-browser",
      ) as Promise<JobFinderWorkspaceSyncResult>,
    resetWorkspace: () =>
      ipcRenderer.invoke(
        "job-finder:reset-workspace",
      ) as Promise<JobFinderWorkspaceSyncResult>,
    getStartupResetRecovery: () =>
      ipcRenderer.invoke(
        "job-finder:get-startup-reset-recovery",
      ) as Promise<JobFinderStartupResetRecoveryFact>,
    getStartupDatabaseRecovery: () =>
      ipcRenderer.invoke(
        "job-finder:get-startup-database-recovery",
      ) as Promise<JobFinderStartupDatabaseRecoveryFact>,
    dismissStartupDatabaseRecoveryNotice: () =>
      ipcRenderer.invoke(
        "job-finder:dismiss-startup-database-recovery-notice",
      ) as Promise<JobFinderStartupDatabaseRecoveryFact>,
    queueJobForReview: (jobId: string) =>
      ipcRenderer.invoke("job-finder:queue-job-for-review", {
        jobId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    removeJobFromReview: (jobId: string) =>
      ipcRenderer.invoke("job-finder:remove-job-from-review", {
        jobId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    // Shows a file the app wrote in the OS file manager. It never opens or
    // runs the file, and the renderer keeps no filesystem access of its own.
    revealSavedFile: (path: string) =>
      ipcRenderer.invoke("job-finder:reveal-saved-file", {
        path,
      }) as Promise<RevealSavedFileResult>,
    writeClipboardText: (text: string) =>
      ipcRenderer.invoke("job-finder:write-clipboard-text", {
        text,
      }) as Promise<WriteClipboardTextResult>,
    ...(testApiEnabled
      ? {
          test: {
            loadApplicationsStoreDemo: (input: {
              sourceUrl: string;
              trackApplications?: boolean;
            }) =>
              ipcRenderer.invoke(
                "job-finder:test-load-applications-store-demo",
                input,
              ) as Promise<ApplicationStoreDemoResult>,
            getSystemThemeOverride: () => currentSystemThemeOverride,
            setSystemThemeOverride: (theme: "dark" | "light" | null) =>
              Promise.resolve().then(() => {
                applySystemThemeOverride(theme);
                return { ok: true as const };
              }),
            loadApplyQueueDemo: () =>
              ipcRenderer.invoke(
                "job-finder:test-load-apply-queue-demo",
              ) as Promise<JobFinderRendererWorkspaceSnapshot>,
            loadWorkHistoryReviewDemo: () =>
              ipcRenderer.invoke(
                "job-finder:test-load-work-history-review-demo",
              ) as Promise<JobFinderRendererWorkspaceSnapshot>,
            loadAgentOwnedBrowserDemo: (input: {
              sourceUrl: string;
              applicationUrl: string;
              secondaryApplicationUrl?: string;
              jobTitle?: string;
              jobCompany?: string;
              foundJobs?: {
                title: string;
                company: string;
                applicationUrl: string;
              }[];
            }) =>
              ipcRenderer.invoke(
                "job-finder:test-load-agent-owned-browser-demo",
                input,
              ) as Promise<JobFinderRendererWorkspaceSnapshot>,
            failNextSave: (surface: JobFinderTestSaveSurface) =>
              ipcRenderer.invoke(
                "job-finder:test-fail-next-save",
                surface,
              ) as Promise<{ ok: true }>,
            resetWorkspaceState: (state: JobFinderRepositoryState) =>
              ipcRenderer.invoke(
                "job-finder:test-reset-workspace-state",
                state,
              ) as Promise<JobFinderRendererWorkspaceSnapshot>,
            getPerformanceSnapshot: () =>
              ipcRenderer.invoke(
                "job-finder:test-get-performance-snapshot",
              ) as Promise<JobFinderPerformanceSnapshot>,
            runResumeImportBenchmark: (
              input?: Partial<ResumeImportBenchmarkRequest>,
            ) =>
              ipcRenderer.invoke(
                "job-finder:test-run-resume-import-benchmark",
                input ?? {},
              ) as Promise<ResumeImportBenchmarkReport>,
            getResumeImportBenchmarkCases: () =>
              ipcRenderer.invoke(
                "job-finder:test-get-resume-import-benchmark-cases",
              ) as Promise<readonly ResumeImportBenchmarkCase[]>,
            getResumeImportState: () =>
              ipcRenderer.invoke(
                "job-finder:test-get-resume-import-state",
              ) as Promise<{
                resumeImportRuns: readonly ResumeImportRun[];
                resumeImportDocumentBundles: readonly ResumeDocumentBundle[];
                resumeImportFieldCandidates: readonly ResumeImportFieldCandidate[];
              }>,
            importResumeFromPath: (
              sourcePath: string | { sourcePath: string; useVision?: boolean },
            ) =>
              ipcRenderer.invoke("job-finder:test-import-resume-from-path", {
                ...(typeof sourcePath === "string"
                  ? { sourcePath }
                  : sourcePath),
              }) as Promise<JobFinderRendererWorkspaceSnapshot>,
          },
        }
      : {}),
  },
};

contextBridge.exposeInMainWorld("nestor", desktopApi);
