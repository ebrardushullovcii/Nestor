import {
  ResumeBatchGenerationResultSchema,
  ResumeBatchGenerationProgressSchema,
  type ResumeBatchGenerationInput,
  type ResumeBatchGenerationProgress,
} from "@nestor/contracts";
import {
  contextBridge,
  ipcRenderer as nativeIpcRenderer,
  webUtils,
} from "electron";
import { browserBridge } from "./browser";
import { createAssistantBridge } from "./assistant";
import type {
  PersonalWorkspaceRestorePreview,
  PersonalWorkspaceRestoreResult,
  ApplicationCrmBulkStageMutationInput,
  ApplicationCrmExportInput,
  ApplicationCrmFileExportResult,
  ApplicationCrmMutationInput,
  ApplicationCrmSettings,
  ApplicationDocumentExportResult,
  ApplicationDocumentListResult,
  ApplicationDocumentRevision,
  AppearanceTheme,
  ApproveApplicationDocumentInput,
  ApplyGroupedManualAnswerInput,
  ApplyRunDetails,
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
  CampaignRuleFunnelProjection,
  CandidateProfile,
  ClearApplicationAnswerCommandInput,
  CompanyIntelligenceMutationInput,
  EditApplicationDocumentInput,
  ExportApplicationDocumentInput,
  DesktopPlatformPing,
  DesktopWindowCloseGuardState,
  DesktopWindowCloseResolution,
  DesktopWindowCloseRequest,
  EditableSourceInstructionArtifact,
  EmployerExclusionPreview,
  DesktopWindowControlsState,
  DiscoveryActivityEvent,
  DiscoveryFeedbackReason,
  ApplicationAuthorityReadiness,
  ApproveCurrentApplicationAnswersInput,
  ApproveCurrentApplicationAnswersResult,
  CreateApplicationAuthorityEnvelopeInput,
  GetApplicationAuthorityEnvelopeInput,
  GetApplicationAuthorityReadinessInput,
  InterviewExportFormat,
  InterviewExportResult,
  JobFinderInterviewFollowUpInput,
  ListApplicationDocumentsInput,
  ListApplicationAuthorityEnvelopesInput,
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
  JobFinderApplicationPacketExportResult,
  JobFinderDiagnosticExportResult,
  JobFinderApplyCopilotActionInput,
  JobFinderApplyConsentActionInput,
  JobFinderApplyQueueActionInput,
  JobFinderApplyRunActionInput,
  JobFinderApplyRunDetailsQuery,
  JobFinderApplicationStartTarget,
  JobFinderPreparedApplicationPageInput,
  JobFinderDiscoveryCancellationInput,
  JobFinderOpenBrowserSessionInput,
  JobFinderSetResumeClaimConfirmationInput,
  JobFinderSetWorkHistoryReviewAcknowledgmentInput,
  ProfileCopilotContext,
  ProfileSetupReviewActionOptions,
  ProposeApplicationDocumentInput,
  JobFinderPerformanceSnapshot,
  JobFinderResumePreview,
  ResumeQualityBenchmarkReport,
  ResumeQualityBenchmarkRequest,
  SaveApplicationAnswerCommandInput,
  SaveCampaignRuleInput,
  ResumeImportBenchmarkReport,
  ResumeImportBenchmarkCase,
  ResumeImportBenchmarkRequest,
  ResumeImportFieldCandidate,
  ResumeImportProgressEvent,
  ResumeImportRun,
  ResumeApplicationMode,
  TailoringMode,
  JobFinderResumePdfExportReply,
  RevealSavedFileResult,
  ResumePdfExportIntent,
  RemoveEmployerExclusionInput,
  RevokeApplicationAuthorityEnvelopeInput,
  ResolveSubmissionOutcomeInput,
  ResumeTimelineRepairAction,
  ResumeDocumentBundle,
  JobFinderResumeWorkspace,
  JobFinderRepositoryState,
  JobFinderTestSaveSurface,
  JobFinderAgentDiscoveryActionInput,
  JobFinderAgentDiscoveryResult,
  JobFinderSearchRequest,
  JobFinderSettings,
  ProfileSetupState,
  ProjectGroupedManualAnswerCommand,
  ResumeAssistantMessage,
  ResumeDraft,
  TailoredAsset,
  ResumeDraftPatch,
  SourceDebugProgressEvent,
  SourceDebugRunRecord,
  SourceDebugRunDetails,
  SaveJobFinderWorkspaceInput,
  JobFinderRendererWorkspaceSnapshot,
  JobFinderJobDetail,
  JobFinderWorkspaceEntityMutationInput,
  JobFinderWorkspaceSyncResult,
  JobSearchPreferences,
  SaveJobSearchCampaignInput,
  RapidReviewMutationInput,
  RecommendResumeStrategyInput,
  RecordOutcomeInput,
  ResumeStrategyRecommendation,
  ReviewCompanyMergeInput,
  RunCampaignNowInput,
  SafeguardMutationInput,
  SaveResumeStrategyInput,
  SelectResumeStrategyInput,
  SetCampaignResumeStrategyDefaultInput,
  SetCompanyPreferenceInput,
  SetOutcomeSuggestionEnabledInput,
  SetJobFinderActivityControlInput,
  SnoozeGroupedDecisionInput,
  UpdateApplicationDefaultsInput,
  UpdateApplicationAuthorityEnvelopeInput,
  UpdateWorkspaceBehaviorInput,
  UpdateAiBehaviorInput,
  WorkspaceRevision,
  WriteClipboardTextResult,
  SaveUserActionAnswerDraftInput,
  UserActionCommandInput,
} from "@nestor/contracts";
import { SYSTEM_THEME_CHANGE_EVENT } from "../shared/system-theme";
import {
  ApplicationAuthorityEnvelopeMutationResultSchema,
  ApplicationAuthorityReadinessSchema,
  JobFinderTailoredAssetQuerySchema,
  JobFinderTailoredAssetDetailSchema,
  ApproveCurrentApplicationAnswersInputSchema,
  ApproveCurrentApplicationAnswersResultSchema,
  CreateApplicationAuthorityEnvelopeInputSchema,
  GetApplicationAuthorityEnvelopeInputSchema,
  GetApplicationAuthorityEnvelopeResultSchema,
  GetApplicationAuthorityReadinessInputSchema,
  ListApplicationAuthorityEnvelopesInputSchema,
  ListApplicationAuthorityEnvelopesResultSchema,
  JobFinderStartupDatabaseRecoveryFactSchema,
  JobFinderStartupResetRecoveryFactSchema,
  RevokeApplicationAuthorityEnvelopeInputSchema,
  ResolveSubmissionOutcomeInputSchema,
  ResolveSubmissionOutcomeResultSchema,
  UpdateApplicationAuthorityEnvelopeInputSchema,
} from "@nestor/contracts";

let activeAgentDiscoveryRequestId: string | null = null;
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

const jobFinderAssetChannels = new Set([
  "job-finder:list-application-documents",
  "job-finder:propose-application-document",
  "job-finder:approve-application-document",
  "job-finder:edit-application-document",
  "job-finder:export-application-document",
]);

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
      channel === "job-finder:get-workspace-bootstrap"
    ) {
      jobFinderBootstrapRoutesReadyPromise ??= nativeIpcRenderer
        .invoke("system:job-finder-bootstrap-routes-ready")
        .then(() => undefined);
      return jobFinderBootstrapRoutesReadyPromise;
    }
    if (
      channel.startsWith("job-finder:candidate-assets:") ||
      jobFinderAssetChannels.has(channel)
    ) {
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

const desktopApi = {
  browser: browserBridge,
  assistant: assistantBridge,
  ping: () => ipcRenderer.invoke("system:ping") as Promise<DesktopPlatformPing>,
  window: {
    close: () => ipcRenderer.invoke("window:close") as Promise<{ ok: true }>,
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
    getTailoredAsset: (assetId: string): Promise<TailoredAsset | null> =>
      ipcRenderer
        .invoke(
          "job-finder:get-tailored-asset",
          JobFinderTailoredAssetQuerySchema.parse({ assetId }),
        )
        .then((result) => JobFinderTailoredAssetDetailSchema.parse(result)),
    getJobDetail: (jobId: string, planId: string | null) =>
      ipcRenderer.invoke("job-finder:get-job-detail", {
        jobId,
        planId,
      }) as Promise<JobFinderJobDetail>,
    getApplicationAuthorityReadiness: (
      input: GetApplicationAuthorityReadinessInput = {},
    ): Promise<ApplicationAuthorityReadiness> =>
      ipcRenderer
        .invoke(
          "job-finder:get-application-authority-readiness",
          GetApplicationAuthorityReadinessInputSchema.parse(input),
        )
        .then((result) => ApplicationAuthorityReadinessSchema.parse(result)),
    approveCurrentApplicationAnswers: (
      input: ApproveCurrentApplicationAnswersInput,
    ): Promise<ApproveCurrentApplicationAnswersResult> =>
      ipcRenderer
        .invoke(
          "job-finder:approve-current-application-answers",
          ApproveCurrentApplicationAnswersInputSchema.parse(input),
        )
        .then((result) =>
          ApproveCurrentApplicationAnswersResultSchema.parse(result),
        ),
    listApplicationAuthorityEnvelopes: (
      input: ListApplicationAuthorityEnvelopesInput = {},
    ) =>
      ipcRenderer
        .invoke(
          "job-finder:list-application-authority-envelopes",
          ListApplicationAuthorityEnvelopesInputSchema.parse(input),
        )
        .then((result) =>
          ListApplicationAuthorityEnvelopesResultSchema.parse(result),
        ),
    getApplicationAuthorityEnvelope: (
      input: GetApplicationAuthorityEnvelopeInput,
    ) =>
      ipcRenderer
        .invoke(
          "job-finder:get-application-authority-envelope",
          GetApplicationAuthorityEnvelopeInputSchema.parse(input),
        )
        .then((result) =>
          GetApplicationAuthorityEnvelopeResultSchema.parse(result),
        ),
    createApplicationAuthorityEnvelope: (
      input: CreateApplicationAuthorityEnvelopeInput,
    ) =>
      ipcRenderer
        .invoke(
          "job-finder:create-application-authority-envelope",
          CreateApplicationAuthorityEnvelopeInputSchema.parse(input),
        )
        .then((result) =>
          ApplicationAuthorityEnvelopeMutationResultSchema.parse(result),
        ),
    updateApplicationAuthorityEnvelope: (
      input: UpdateApplicationAuthorityEnvelopeInput,
    ) =>
      ipcRenderer
        .invoke(
          "job-finder:update-application-authority-envelope",
          UpdateApplicationAuthorityEnvelopeInputSchema.parse(input),
        )
        .then((result) =>
          ApplicationAuthorityEnvelopeMutationResultSchema.parse(result),
        ),
    revokeApplicationAuthorityEnvelope: (
      input: RevokeApplicationAuthorityEnvelopeInput,
    ) =>
      ipcRenderer
        .invoke(
          "job-finder:revoke-application-authority-envelope",
          RevokeApplicationAuthorityEnvelopeInputSchema.parse(input),
        )
        .then((result) =>
          ApplicationAuthorityEnvelopeMutationResultSchema.parse(result),
        ),
    resolveSubmissionOutcome: (input: ResolveSubmissionOutcomeInput) =>
      ipcRenderer
        .invoke(
          "job-finder:resolve-submission-outcome",
          ResolveSubmissionOutcomeInputSchema.parse(input),
        )
        .then((result) => ResolveSubmissionOutcomeResultSchema.parse(result)),
    listApplicationDocuments: (input: ListApplicationDocumentsInput) =>
      ipcRenderer.invoke(
        "job-finder:list-application-documents",
        input,
      ) as Promise<ApplicationDocumentListResult>,
    proposeApplicationDocument: (input: ProposeApplicationDocumentInput) =>
      ipcRenderer.invoke(
        "job-finder:propose-application-document",
        input,
      ) as Promise<ApplicationDocumentRevision>,
    approveApplicationDocument: (input: ApproveApplicationDocumentInput) =>
      ipcRenderer.invoke(
        "job-finder:approve-application-document",
        input,
      ) as Promise<ApplicationDocumentRevision>,
    editApplicationDocument: (input: EditApplicationDocumentInput) =>
      ipcRenderer.invoke(
        "job-finder:edit-application-document",
        input,
      ) as Promise<ApplicationDocumentRevision>,
    exportApplicationDocument: (input: ExportApplicationDocumentInput) =>
      ipcRenderer.invoke(
        "job-finder:export-application-document",
        input,
      ) as Promise<ApplicationDocumentExportResult>,
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
    saveUserActionAnswerDraft: (input: SaveUserActionAnswerDraftInput) =>
      ipcRenderer.invoke(
        "job-finder:save-user-action-answer-draft",
        input,
      ) as Promise<void>,
    performUserAction: (command: UserActionCommandInput) =>
      ipcRenderer.invoke(
        "job-finder:perform-user-action",
        command,
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
    judgeUnjudgedJobs: () =>
      ipcRenderer.invoke(
        "job-finder:judge-unjudged-jobs",
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
    saveCampaign: (campaign: SaveJobSearchCampaignInput) =>
      ipcRenderer.invoke(
        "job-finder:save-campaign",
        campaign,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    selectCampaign: (campaignId: string) =>
      ipcRenderer.invoke("job-finder:select-campaign", {
        campaignId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    runCampaignNow: (input?: RunCampaignNowInput) =>
      ipcRenderer.invoke(
        "job-finder:run-campaign-now",
        input ?? {},
      ) as Promise<JobFinderWorkspaceSyncResult>,
    markCampaignNotificationRead: (notificationId: string) =>
      ipcRenderer.invoke("job-finder:mark-campaign-notification-read", {
        notificationId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    markAllCampaignNotificationsRead: () =>
      ipcRenderer.invoke(
        "job-finder:mark-all-campaign-notifications-read",
      ) as Promise<JobFinderWorkspaceSyncResult>,
    saveCampaignRule: (campaignId: string, rule: SaveCampaignRuleInput) =>
      ipcRenderer.invoke("job-finder:save-campaign-rule", {
        campaignId,
        rule,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    deleteCampaignRule: (campaignId: string, ruleId: string) =>
      ipcRenderer.invoke("job-finder:delete-campaign-rule", {
        campaignId,
        ruleId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    deleteJobSearchCampaign: (campaignId: string) =>
      ipcRenderer.invoke("job-finder:delete-campaign", {
        campaignId,
      }) as Promise<boolean>,
    toggleCampaignRule: (
      campaignId: string,
      ruleId: string,
      enabled: boolean,
    ) =>
      ipcRenderer.invoke("job-finder:toggle-campaign-rule", {
        campaignId,
        ruleId,
        enabled,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    projectCampaignRuleFunnel: (campaignId: string) =>
      ipcRenderer.invoke("job-finder:project-campaign-rule-funnel", {
        campaignId,
      }) as Promise<CampaignRuleFunnelProjection>,
    setActivityControl: (input: SetJobFinderActivityControlInput) =>
      ipcRenderer.invoke(
        "job-finder:set-activity-control",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    mutateRapidReview: (input: RapidReviewMutationInput) =>
      ipcRenderer.invoke(
        "job-finder:mutate-rapid-review",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    recordOutcome: (input: RecordOutcomeInput) =>
      ipcRenderer.invoke(
        "job-finder:record-outcome",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    saveResumeStrategy: (input: SaveResumeStrategyInput) =>
      ipcRenderer.invoke(
        "job-finder:save-resume-strategy",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    disableResumeStrategy: (strategyId: string) =>
      ipcRenderer.invoke(
        "job-finder:disable-resume-strategy",
        strategyId,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    selectResumeStrategy: (input: SelectResumeStrategyInput) =>
      ipcRenderer.invoke(
        "job-finder:select-resume-strategy",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    recommendResumeStrategy: (input: RecommendResumeStrategyInput) =>
      ipcRenderer.invoke(
        "job-finder:recommend-resume-strategy",
        input,
      ) as Promise<ResumeStrategyRecommendation>,
    setCampaignResumeStrategyDefault: (
      input: SetCampaignResumeStrategyDefaultInput,
    ) =>
      ipcRenderer.invoke(
        "job-finder:set-campaign-resume-strategy-default",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    refreshCompanyIntelligence: () =>
      ipcRenderer.invoke(
        "job-finder:refresh-company-intelligence",
      ) as Promise<JobFinderWorkspaceSyncResult>,
    setCompanyPreference: (input: SetCompanyPreferenceInput) =>
      ipcRenderer.invoke(
        "job-finder:set-company-preference",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    reviewCompanyMerge: (input: ReviewCompanyMergeInput) =>
      ipcRenderer.invoke(
        "job-finder:review-company-merge",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    mutateCompanyIntelligence: (input: CompanyIntelligenceMutationInput) =>
      ipcRenderer.invoke(
        "job-finder:mutate-company-intelligence",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    setOutcomeSuggestionEnabled: (input: SetOutcomeSuggestionEnabledInput) =>
      ipcRenderer.invoke(
        "job-finder:set-outcome-suggestion-enabled",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    mutateSafeguards: (input: SafeguardMutationInput) =>
      ipcRenderer.invoke(
        "job-finder:mutate-safeguards",
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
    updateTrackerCrm: (applicationCrm: ApplicationCrmSettings) =>
      ipcRenderer.invoke(
        "job-finder:update-tracker-crm",
        applicationCrm,
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
    runDiscovery: () =>
      ipcRenderer.invoke(
        "job-finder:run-discovery",
      ) as Promise<JobFinderWorkspaceSyncResult>,
    runAgentDiscovery: (
      onActivity?: (event: DiscoveryActivityEvent) => void,
      targetId?: string,
      searchRequest?: JobFinderSearchRequest,
    ) => {
      if (activeAgentDiscoveryRequestId) {
        return Promise.reject(new Error("Agent discovery is already running."));
      }

      const requestId = `agent_discovery_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const activityChannel = `job-finder:discovery-activity:${requestId}`;
      activeAgentDiscoveryRequestId = requestId;
      const activityHandler = onActivity
        ? (
            _event: Electron.IpcRendererEvent,
            event: DiscoveryActivityEvent,
          ) => {
            onActivity(event);
          }
        : null;

      if (activityHandler) {
        ipcRenderer.on(activityChannel, activityHandler);
      }

      const cleanup = () => {
        if (activityHandler) {
          ipcRenderer.off(activityChannel, activityHandler);
        }
        if (activeAgentDiscoveryRequestId === requestId) {
          activeAgentDiscoveryRequestId = null;
        }
      };

      const payload: JobFinderAgentDiscoveryActionInput = {
        requestId,
        targetId: targetId ?? null,
        ...(searchRequest ? { searchRequest } : {}),
      };

      const promise = ipcRenderer
        .invoke("job-finder:run-agent-discovery", payload)
        .finally(cleanup) as Promise<JobFinderAgentDiscoveryResult>;

      return promise;
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
    getApplyRunDetails: (input: JobFinderApplyRunDetailsQuery) =>
      ipcRenderer.invoke(
        "job-finder:get-apply-run-details",
        input,
      ) as Promise<ApplyRunDetails>,
    saveApplicationAnswer: (command: SaveApplicationAnswerCommandInput) =>
      ipcRenderer.invoke(
        "job-finder:save-application-answer",
        command,
      ) as Promise<ApplyRunDetails>,
    clearApplicationAnswer: (command: ClearApplicationAnswerCommandInput) =>
      ipcRenderer.invoke(
        "job-finder:clear-application-answer",
        command,
      ) as Promise<ApplyRunDetails>,
    projectGroupedManualAnswer: (command: ProjectGroupedManualAnswerCommand) =>
      ipcRenderer.invoke(
        "job-finder:project-grouped-manual-answer",
        command,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    applyGroupedManualAnswer: (input: ApplyGroupedManualAnswerInput) =>
      ipcRenderer.invoke(
        "job-finder:apply-grouped-manual-answer",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    snoozeGroupedDecision: (input: SnoozeGroupedDecisionInput) =>
      ipcRenderer.invoke(
        "job-finder:snooze-grouped-decision",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    previewPersonalWorkspaceRestore: () =>
      ipcRenderer.invoke(
        "job-finder:preview-personal-workspace-restore",
      ) as Promise<PersonalWorkspaceRestorePreview | null>,
    confirmPersonalWorkspaceRestore: (input: { token: string }) =>
      ipcRenderer.invoke(
        "job-finder:confirm-personal-workspace-restore",
        input,
      ) as Promise<PersonalWorkspaceRestoreResult>,
    exportPersonalWorkspace: () =>
      ipcRenderer.invoke(
        "job-finder:export-personal-workspace",
      ) as Promise<ApplicationCrmFileExportResult>,
    exportDiagnostics: () =>
      ipcRenderer.invoke(
        "job-finder:export-diagnostics",
      ) as Promise<JobFinderDiagnosticExportResult>,
    getPerformanceSnapshot: () =>
      ipcRenderer.invoke(
        "job-finder:get-performance-snapshot",
      ) as Promise<JobFinderPerformanceSnapshot>,
    exportApplicationPacket: (input: JobFinderApplyRunDetailsQuery) =>
      ipcRenderer.invoke(
        "job-finder:export-application-packet",
        input,
      ) as Promise<JobFinderApplicationPacketExportResult>,
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
    cancelAgentDiscovery: (input: JobFinderDiscoveryCancellationInput) =>
      ipcRenderer.invoke(
        "job-finder:cancel-discovery-run",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    resetBrowser: () =>
      ipcRenderer.invoke(
        "job-finder:reset-browser",
      ) as Promise<JobFinderWorkspaceSyncResult>,
    resetWorkspace: () =>
      ipcRenderer.invoke(
        "job-finder:reset-workspace",
      ) as Promise<JobFinderWorkspaceSyncResult>,
    getStartupResetRecovery: () =>
      ipcRenderer
        .invoke("job-finder:get-startup-reset-recovery")
        .then((payload: unknown) =>
          JobFinderStartupResetRecoveryFactSchema.parse(payload),
        ),
    getStartupDatabaseRecovery: () =>
      ipcRenderer
        .invoke("job-finder:get-startup-database-recovery")
        .then((payload: unknown) =>
          JobFinderStartupDatabaseRecoveryFactSchema.parse(payload),
        ),
    dismissStartupDatabaseRecoveryNotice: () =>
      ipcRenderer
        .invoke("job-finder:dismiss-startup-database-recovery-notice")
        .then((payload: unknown) =>
          JobFinderStartupDatabaseRecoveryFactSchema.parse(payload),
        ),
    queueJobForReview: (jobId: string) =>
      ipcRenderer.invoke("job-finder:queue-job-for-review", {
        jobId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    setJobResumeApplicationMode: (
      jobId: string,
      resumeApplicationMode: ResumeApplicationMode,
      resumeTailoringMode?: TailoringMode | null,
    ) =>
      ipcRenderer.invoke("job-finder:set-job-resume-application-mode", {
        jobId,
        resumeApplicationMode,
        ...(resumeTailoringMode === undefined ? {} : { resumeTailoringMode }),
      }) as Promise<JobFinderWorkspaceSyncResult>,
    removeJobFromReview: (jobId: string) =>
      ipcRenderer.invoke("job-finder:remove-job-from-review", {
        jobId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    dismissDiscoveryJob: (
      jobId: string,
      reasons: readonly DiscoveryFeedbackReason[],
      action: "hide_job" | "hide_and_exclude_employer" = "hide_job",
      expectedNormalizedCompanyName: string | null = null,
    ) =>
      ipcRenderer.invoke("job-finder:dismiss-discovery-job", {
        jobId,
        reasons,
        action,
        expectedNormalizedCompanyName,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    previewEmployerExclusion: (jobId: string) =>
      ipcRenderer.invoke("job-finder:preview-employer-exclusion", {
        jobId,
      }) as Promise<EmployerExclusionPreview>,
    removeEmployerExclusion: (input: RemoveEmployerExclusionInput) =>
      ipcRenderer.invoke(
        "job-finder:remove-employer-exclusion",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    restoreDismissedDiscoveryJob: (jobId: string) =>
      ipcRenderer.invoke("job-finder:restore-dismissed-discovery-job", {
        jobId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    getResumeWorkspace: (jobId: string) =>
      ipcRenderer.invoke("job-finder:get-resume-workspace", {
        jobId,
      }) as Promise<JobFinderResumeWorkspace>,
    previewResumeDraft: (draft: ResumeDraft, requestId?: string) =>
      ipcRenderer.invoke("job-finder:preview-resume-draft", {
        draft,
        requestId,
      }) as Promise<JobFinderResumePreview>,
    saveResumeDraft: (draft: ResumeDraft) =>
      ipcRenderer.invoke("job-finder:save-resume-draft", {
        draft,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    restoreResumeDraftRevision: (jobId: string, revisionId: string) =>
      ipcRenderer.invoke("job-finder:restore-resume-draft-revision", {
        jobId,
        revisionId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    undoResumeAssistantEdit: (jobId: string, revisionId: string) =>
      ipcRenderer.invoke("job-finder:undo-resume-assistant-edit", {
        jobId,
        revisionId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    regenerateResumeDraft: (jobId: string) =>
      ipcRenderer.invoke("job-finder:regenerate-resume-draft", {
        jobId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    regenerateResumeSection: (jobId: string, sectionId: string) =>
      ipcRenderer.invoke("job-finder:regenerate-resume-section", {
        jobId,
        sectionId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    exportResumePdf: (
      jobId: string,
      intent: ResumePdfExportIntent = "download",
    ) =>
      ipcRenderer.invoke("job-finder:export-resume-pdf", {
        intent,
        jobId,
      }) as Promise<JobFinderResumePdfExportReply>,
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
    approveResume: (jobId: string, exportId: string) =>
      ipcRenderer.invoke("job-finder:approve-resume", {
        jobId,
        exportId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    clearResumeApproval: (jobId: string) =>
      ipcRenderer.invoke("job-finder:clear-resume-approval", {
        jobId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    setWorkHistoryReviewAcknowledgment: (
      input: JobFinderSetWorkHistoryReviewAcknowledgmentInput,
    ) =>
      ipcRenderer.invoke(
        "job-finder:set-work-history-review-acknowledgment",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    setResumeClaimConfirmation: (
      input: JobFinderSetResumeClaimConfirmationInput,
    ) =>
      ipcRenderer.invoke(
        "job-finder:set-resume-claim-confirmation",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    applyResumePatch: (
      patch: ResumeDraftPatch,
      revisionReason?: string | null,
    ) =>
      ipcRenderer.invoke("job-finder:apply-resume-patch", {
        patch,
        revisionReason: revisionReason ?? null,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    getResumeAssistantMessages: (jobId: string) =>
      ipcRenderer.invoke("job-finder:get-resume-assistant-messages", {
        jobId,
      }) as Promise<readonly ResumeAssistantMessage[]>,
    sendResumeAssistantMessage: (jobId: string, content: string) =>
      ipcRenderer.invoke("job-finder:send-resume-assistant-message", {
        jobId,
        content,
      }) as Promise<readonly ResumeAssistantMessage[]>,
    resolveResumeAssistantProposal: (
      jobId: string,
      proposalId: string,
      action: "accept" | "reject",
      patchIds: readonly string[],
    ) =>
      ipcRenderer.invoke("job-finder:resolve-resume-assistant-proposal", {
        jobId,
        proposalId,
        action,
        patchIds,
      }) as Promise<readonly ResumeAssistantMessage[]>,
    generateResumeForBatch: async (input: ResumeBatchGenerationInput) =>
      ResumeBatchGenerationResultSchema.parse(
        await ipcRenderer.invoke("job-finder:generate-resume-for-batch", input),
      ),
    onResumeBatchProgress: (
      listener: (progress: ResumeBatchGenerationProgress) => void,
    ) => {
      const handle = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        const parsed = ResumeBatchGenerationProgressSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on("job-finder:resume-batch-progress", handle);
      return () => ipcRenderer.off("job-finder:resume-batch-progress", handle);
    },
    generateResume: (jobId: string) =>
      ipcRenderer.invoke("job-finder:generate-resume", {
        jobId,
      }) as Promise<JobFinderWorkspaceSyncResult>,
    startApplyCopilotRun: (input: JobFinderApplyCopilotActionInput) =>
      ipcRenderer.invoke(
        "job-finder:start-apply-copilot-run",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    startAutoApplyRun: (input: JobFinderApplicationStartTarget) =>
      ipcRenderer.invoke(
        "job-finder:start-auto-apply-run",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    startAutoApplyQueueRun: (
      jobIds: JobFinderApplyQueueActionInput["jobIds"],
      applicationAutomationMode?: JobFinderApplyQueueActionInput["applicationAutomationMode"],
    ) =>
      ipcRenderer.invoke("job-finder:start-auto-apply-queue-run", {
        jobIds,
        ...(applicationAutomationMode ? { applicationAutomationMode } : {}),
      }) as Promise<JobFinderWorkspaceSyncResult>,
    approveApplyRun: (input: JobFinderApplyRunActionInput) =>
      ipcRenderer.invoke(
        "job-finder:approve-apply-run",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    cancelApplyRun: (input: JobFinderApplyRunActionInput) =>
      ipcRenderer.invoke(
        "job-finder:cancel-apply-run",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    resolveApplyConsentRequest: (input: JobFinderApplyConsentActionInput) =>
      ipcRenderer.invoke(
        "job-finder:resolve-apply-consent-request",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    revokeApplyRunApproval: (input: JobFinderApplyRunActionInput) =>
      ipcRenderer.invoke(
        "job-finder:revoke-apply-run-approval",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    focusPreparedApplicationPage: (
      input: JobFinderPreparedApplicationPageInput,
    ) =>
      ipcRenderer.invoke(
        "job-finder:focus-prepared-application-page",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    submitPreparedApplication: (input: { jobId: string }) =>
      ipcRenderer.invoke(
        "job-finder:submit-prepared-application",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    sendPreparedApplications: (input: { jobIds: string[] }) =>
      ipcRenderer.invoke(
        "job-finder:send-prepared-applications",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    approveApply: (input: JobFinderApplicationStartTarget) =>
      ipcRenderer.invoke(
        "job-finder:approve-apply",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    mutateApplicationCrm: (input: ApplicationCrmMutationInput) =>
      ipcRenderer.invoke(
        "job-finder:mutate-application-crm",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    mutateApplicationCrmBulkStage: (
      input: ApplicationCrmBulkStageMutationInput,
    ) =>
      ipcRenderer.invoke(
        "job-finder:mutate-application-crm-bulk-stage",
        input,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    runApplicationNoResponseAutomation: (settings?: ApplicationCrmSettings) =>
      ipcRenderer.invoke(
        "job-finder:run-application-no-response-automation",
        settings,
      ) as Promise<JobFinderWorkspaceSyncResult>,
    exportApplicationCrm: (input: ApplicationCrmExportInput) =>
      ipcRenderer.invoke(
        "job-finder:export-application-crm",
        input,
      ) as Promise<ApplicationCrmFileExportResult>,
    ...(testApiEnabled
      ? {
          test: {
            getSystemThemeOverride: () => currentSystemThemeOverride,
            setSystemThemeOverride: (theme: "dark" | "light" | null) =>
              Promise.resolve().then(() => {
                applySystemThemeOverride(theme);
                return { ok: true as const };
              }),
            setResumePreviewMode: (mode: "ok" | "fail_once") =>
              ipcRenderer.invoke(
                "job-finder:test-set-resume-preview-mode",
                mode,
              ) as Promise<{ ok: true }>,
            loadResumeWorkspaceDemo: () =>
              ipcRenderer.invoke(
                "job-finder:test-load-resume-workspace-demo",
              ) as Promise<JobFinderRendererWorkspaceSnapshot>,
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
            runResumeQualityBenchmark: (
              input?: Partial<ResumeQualityBenchmarkRequest>,
            ) =>
              ipcRenderer.invoke(
                "job-finder:test-run-resume-quality-benchmark",
                input ?? {},
              ) as Promise<ResumeQualityBenchmarkReport>,
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
