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
import type {
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
  ResumeImportBenchmarkReport,
  ResumeImportBenchmarkCase,
  ResumeImportBenchmarkRequest,
  ResumeImportRun,
  RevealSavedFileResult,
  WriteClipboardTextResult,
  LaunchContext,
} from "@nestor/contracts";
import { LAUNCH_CONTEXT_CHANNEL } from "@nestor/contracts";
import { SYSTEM_THEME_CHANGE_EVENT } from "../shared/system-theme";
import type { JobFinderStartupResetRecoveryFact } from "@nestor/contracts";

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
      ) as Promise<unknown>,
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
    exportDiagnostics: () =>
      ipcRenderer.invoke(
        "job-finder:export-diagnostics",
      ) as Promise<JobFinderDiagnosticExportResult>,
    resetWorkspace: () =>
      ipcRenderer.invoke("job-finder:reset-workspace") as Promise<void>,
    getStartupResetRecovery: () =>
      ipcRenderer.invoke(
        "job-finder:get-startup-reset-recovery",
      ) as Promise<JobFinderStartupResetRecoveryFact>,
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
            importResumeFromPath: (
              sourcePath: string | { sourcePath: string; useVision?: boolean },
            ) =>
              ipcRenderer.invoke("job-finder:test-import-resume-from-path", {
                ...(typeof sourcePath === "string"
                  ? { sourcePath }
                  : sourcePath),
              }) as Promise<{
                profile: CandidateProfile;
                latestResumeImportRun: ResumeImportRun | null;
              }>,
          },
        }
      : {}),
  },
};

contextBridge.exposeInMainWorld("nestor", desktopApi);
