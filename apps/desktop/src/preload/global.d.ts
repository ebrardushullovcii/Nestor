import type { DesktopResumesBridge } from "./resumes";
import type { DesktopTrackerBridge } from "./tracker";
import type {
  ApplicationListPage,
  ApplicationListQuery,
  ApplicationRow,
  ApplicationTarget,
  ApplicationsForJobsInput,
  ApplicationDetails,
  NeedsYouListQuery,
  NeedsYouPage,
  AnswerNeedsYouInput,
  AnswerNeedsYouResult,
  ApplyJobsInput,
  ApplyJobsResult,
  JobChange,
  ApplicationStoreDemoResult,
  WorkspaceQueryApi,
  JobFinderDiscoveryCommandReply,
  JobFinderDiscoveryCancellationReply,
  ApplicationPageState,
  ApplicationPageReopenProgress,
  ReopenApplicationPageInput,
  ResumeBatchGenerationInput,
  ResumeBatchGenerationResult,
  ResumeBatchGenerationProgress,
} from "@nestor/contracts";
import type {
  DesktopAssistantBridge,
  DesktopBrowserBridge,
  DesktopJobsBridge,
  ApplicationAuthorityEnvelope,
  ApplicationAuthorityEnvelopeMutationResult,
  ApplicationAuthorityReadiness,
  ApplicationCrmBulkStageMutationInput,
  ApplicationCrmExportInput,
  ApplicationCrmFileExportResult,
  ApplicationCrmMutationInput,
  ApplicationCrmSettings,
  ApplicationDocumentExportResult,
  ApplicationDocumentListResult,
  ApplicationDocumentRevision,
  ApplicationListPage,
  ApplicationListQuery,
  ApplicationPageReopenProgress,
  ApplicationPageState,
  ApplicationStoreDemoResult,
  ApplyGroupedManualAnswerInput,
  ApplyJobsInput,
  ApplyJobsResult,
  ApplyRunDetails,
  ApproveApplicationDocumentInput,
  ApproveCurrentApplicationAnswersInput,
  ApproveCurrentApplicationAnswersResult,
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
  ClearApplicationAnswerCommandInput,
  CreateApplicationAuthorityEnvelopeInput,
  DesktopAssistantBridge,
  DesktopBrowserBridge,
  DesktopContextMenuInput,
  DesktopContextMenuResult,
  DesktopPlatformPing,
  DesktopWindowCloseGuardState,
  DesktopWindowCloseRequest,
  DesktopWindowCloseResolution,
  DesktopWindowControlsState,
  DiscoveryActivityEvent,
  DiscoveryFeedbackReason,
  EditableSourceInstructionArtifact,
  EditApplicationDocumentInput,
  EmployerExclusionPreview,
  ExportApplicationDocumentInput,
  GetApplicationAuthorityEnvelopeInput,
  GetApplicationAuthorityReadinessInput,
  InterviewAudioTranscriptionInput,
  InterviewCaptionFileReadInput,
  InterviewCaptionFileTextResult,
  InterviewChatTurn,
  InterviewClipboardTextResult,
  InterviewClipboardWriteInput,
  InterviewExportFormat,
  InterviewExportResult,
  InterviewHotkeyAction,
  InterviewLiveSession,
  InterviewOverlayMoveInput,
  InterviewPrepArtifactFromCueInput,
  InterviewTranscriptAnnotationInput,
  InterviewTranscriptSegmentInput,
  InterviewWorkspaceView,
  JobChange,
  JobFinderAgentDiscoveryReply,
  JobFinderApplicationPacketExportResult,
  JobFinderApplicationStartTarget,
  JobFinderApplyConsentActionInput,
  JobFinderApplyCopilotActionInput,
  JobFinderApplyQueueActionInput,
  JobFinderApplyQueueControlInput,
  JobFinderApplyRunActionInput,
  JobFinderApplyRunDetailsQuery,
  JobFinderApproveResumesInput,
  JobFinderDiagnosticExportResult,
  JobFinderDiscoveryCancellationInput,
  JobFinderDiscoveryCancellationReply,
  JobFinderDiscoveryCommandReply,
  JobFinderInterviewFollowUpInput,
  JobFinderJobDetail,
  JobFinderOpenBrowserSessionInput,
  JobFinderPerformanceSnapshot,
  JobFinderPreparedApplicationPageInput,
  JobFinderRemoveFromApplyQueueInput,
  JobFinderRendererWorkspaceSnapshot,
  JobFinderRepositoryState,
  JobFinderResumePdfExportReply,
  JobFinderResumePreview,
  JobFinderResumeWorkspace,
  JobFinderReturnApplicationToShortlistInput,
  JobFinderSearchRequest,
  JobFinderSetResumeClaimConfirmationInput,
  JobFinderSettings,
  JobFinderSetWorkHistoryReviewAcknowledgmentInput,
  JobFinderStartApplyQueueInput,
  JobFinderStartupDatabaseRecoveryFact,
  JobFinderStartupResetRecoveryFact,
  JobFinderTestSaveSurface,
  JobFinderWorkspaceEntityMutationInput,
  JobFinderWorkspaceSyncResult,
  JobSearchPreferences,
  ListApplicationAuthorityEnvelopesInput,
  ListApplicationAuthorityEnvelopesResult,
  ListApplicationDocumentsInput,
  PersonalWorkspaceRestorePreview,
  PersonalWorkspaceRestoreResult,
  ProfileCopilotContext,
  ProfileSetupReviewActionOptions,
  ProfileSetupState,
  ProjectGroupedManualAnswerCommand,
  ProposeApplicationDocumentInput,
  RemoveEmployerExclusionInput,
  ReopenApplicationPageInput,
  ResolveSubmissionOutcomeInput,
  ResolveSubmissionOutcomeResult,
  ResumeApplicationMode,
  ResumeAssistantMessage,
  ResumeBatchGenerationInput,
  ResumeBatchGenerationProgress,
  ResumeBatchGenerationResult,
  ResumeDocumentBundle,
  ResumeDraft,
  ResumeDraftPatch,
  ResumeImportBenchmarkCase,
  ResumeImportBenchmarkReport,
  ResumeImportBenchmarkRequest,
  ResumeImportFieldCandidate,
  ResumeImportProgressEvent,
  ResumeImportRun,
  ResumePdfExportIntent,
  ResumeQualityBenchmarkReport,
  ResumeQualityBenchmarkRequest,
  ResumeTimelineRepairAction,
  RevealSavedFileResult,
  RevokeApplicationAuthorityEnvelopeInput,
  SaveApplicationAnswerCommandInput,
  SaveInterviewSetupInput,
  SaveJobFinderWorkspaceInput,
  SaveUserActionAnswerDraftInput,
  SendInterviewChatMessageInput,
  SetJobFinderActivityControlInput,
  SnoozeGroupedDecisionInput,
  SourceDebugProgressEvent,
  SourceDebugRunDetails,
  SourceDebugRunRecord,
  TailoredAsset,
  TailoringMode,
  UpdateAiBehaviorInput,
  UpdateApplicationAuthorityEnvelopeInput,
  UpdateApplicationDefaultsInput,
  UpdateInterviewOverlayPreferenceInput,
  UpdateWorkspaceBehaviorInput,
  UserActionCommandInput,
  WorkspaceQueryApi,
  WorkspaceRevision,
  WriteClipboardTextResult,
} from "@nestor/contracts";

declare global {
  interface Window {
    nestor: {
      browser: DesktopBrowserBridge;
      assistant: DesktopAssistantBridge;
      jobs: DesktopJobsBridge;
      resumes: DesktopResumesBridge;
      tracker: DesktopTrackerBridge;
      ping: () => Promise<DesktopPlatformPing>;
      window: {
        close: () => Promise<{ ok: true }>;
        showContextMenu: (
          input: DesktopContextMenuInput,
        ) => Promise<DesktopContextMenuResult>;
        getControlsState: () => Promise<DesktopWindowControlsState>;
        onControlsStateChange: (
          listener: (state: DesktopWindowControlsState) => void,
        ) => () => void;
        minimize: () => Promise<DesktopWindowControlsState>;
        toggleMaximize: () => Promise<DesktopWindowControlsState>;
        setCloseGuardState: (
          input: DesktopWindowCloseGuardState,
        ) => Promise<{ ok: true }>;
        resolveCloseRequest: (
          input: DesktopWindowCloseResolution,
        ) => Promise<{ ok: true }>;
        onCloseRequest: (
          listener: (request: DesktopWindowCloseRequest) => void,
        ) => () => void;
      };
      liveAssistant: {
        getWorkspace: () => Promise<InterviewWorkspaceView>;
        getSession: (sessionId: string) => Promise<InterviewLiveSession | null>;
        onWorkspaceChange: (
          listener: (workspace: InterviewWorkspaceView) => void,
        ) => () => void;
        saveSetup: (
          input: SaveInterviewSetupInput,
        ) => Promise<InterviewWorkspaceView>;
        runRehearsal: () => Promise<InterviewWorkspaceView>;
        startSession: () => Promise<InterviewWorkspaceView>;
        beginReconfiguration: () => Promise<InterviewWorkspaceView>;
        finishReconfiguration: () => Promise<InterviewWorkspaceView>;
        performAction: (
          action: InterviewHotkeyAction,
        ) => Promise<InterviewWorkspaceView>;
        moveOverlayWindow: (
          input: InterviewOverlayMoveInput,
        ) => Promise<{ moved: boolean }>;
        updateOverlayPreference: (
          input: UpdateInterviewOverlayPreferenceInput,
        ) => Promise<InterviewWorkspaceView>;
        deleteSession: (sessionId: string) => Promise<InterviewWorkspaceView>;
        saveCueAsPrepArtifact: (
          input: InterviewPrepArtifactFromCueInput,
        ) => Promise<InterviewWorkspaceView>;
        addTranscriptAnnotation: (
          input: InterviewTranscriptAnnotationInput,
        ) => Promise<InterviewWorkspaceView>;
        addTranscriptSegment: (
          input: InterviewTranscriptSegmentInput,
        ) => Promise<InterviewWorkspaceView>;
        sendChatMessage: (
          input: SendInterviewChatMessageInput,
        ) => Promise<InterviewChatTurn>;
        transcribeAudioChunk: (
          input: InterviewAudioTranscriptionInput,
        ) => Promise<InterviewWorkspaceView>;
        verifyOverlayProtection: () => Promise<InterviewWorkspaceView>;
        resetOverlayPreferences: () => Promise<InterviewWorkspaceView>;
        readClipboardText: () => Promise<InterviewClipboardTextResult>;
        writeClipboardText: (
          input: InterviewClipboardWriteInput,
        ) => Promise<{ written: true }>;
        selectCaptionFile: () => Promise<InterviewCaptionFileTextResult>;
        readCaptionFile: (
          input: InterviewCaptionFileReadInput,
        ) => Promise<InterviewCaptionFileTextResult>;
        exportSession: (
          sessionId: string,
          format?: InterviewExportFormat,
        ) => Promise<InterviewExportResult>;
        recordJobFinderFollowUp: (
          input: JobFinderInterviewFollowUpInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
      };
      jobFinder: {
        applyJobs: (input: ApplyJobsInput) => Promise<ApplyJobsResult>;
        listApplications: (input?: ApplicationListQuery) => Promise<ApplicationListPage>;
        applicationsForJobs: (input: ApplicationsForJobsInput) => Promise<ApplicationRow[]>;
        getApplicationDetails: (input: ApplicationTarget) => Promise<ApplicationDetails | null>;
        openApplication: (input: ApplicationTarget) => Promise<boolean>;
        stopApplication: (input: ApplicationTarget) => Promise<boolean>;
        listNeedsYou: (input?: NeedsYouListQuery) => Promise<NeedsYouPage>;
        answerNeedsYou: (input: AnswerNeedsYouInput) => Promise<AnswerNeedsYouResult>;
        onApplicationsChange: (listener: (change: JobChange) => void) => () => void;
        queries: WorkspaceQueryApi;
        getApplicationAuthorityReadiness: (
          input?: GetApplicationAuthorityReadinessInput,
        ) => Promise<ApplicationAuthorityReadiness>;
        approveCurrentApplicationAnswers: (
          input: ApproveCurrentApplicationAnswersInput,
        ) => Promise<ApproveCurrentApplicationAnswersResult>;
        listApplicationAuthorityEnvelopes: (
          input?: ListApplicationAuthorityEnvelopesInput,
        ) => Promise<ListApplicationAuthorityEnvelopesResult>;
        getApplicationAuthorityEnvelope: (
          input: GetApplicationAuthorityEnvelopeInput,
        ) => Promise<ApplicationAuthorityEnvelope | null>;
        createApplicationAuthorityEnvelope: (
          input: CreateApplicationAuthorityEnvelopeInput,
        ) => Promise<ApplicationAuthorityEnvelopeMutationResult>;
        updateApplicationAuthorityEnvelope: (
          input: UpdateApplicationAuthorityEnvelopeInput,
        ) => Promise<ApplicationAuthorityEnvelopeMutationResult>;
        revokeApplicationAuthorityEnvelope: (
          input: RevokeApplicationAuthorityEnvelopeInput,
        ) => Promise<ApplicationAuthorityEnvelopeMutationResult>;
        resolveSubmissionOutcome: (
          input: ResolveSubmissionOutcomeInput,
        ) => Promise<ResolveSubmissionOutcomeResult>;
        listApplicationDocuments: (
          input: ListApplicationDocumentsInput,
        ) => Promise<ApplicationDocumentListResult>;
        proposeApplicationDocument: (
          input: ProposeApplicationDocumentInput,
        ) => Promise<ApplicationDocumentRevision>;
        approveApplicationDocument: (
          input: ApproveApplicationDocumentInput,
        ) => Promise<ApplicationDocumentRevision>;
        editApplicationDocument: (
          input: EditApplicationDocumentInput,
        ) => Promise<ApplicationDocumentRevision>;
        exportApplicationDocument: (
          input: ExportApplicationDocumentInput,
        ) => Promise<ApplicationDocumentExportResult>;
        listCandidateAssets: (
          input?: CandidateAssetListInput,
        ) => Promise<CandidateAssetListResult>;
        importCandidateAsset: (
          input: CandidateAssetImportInput,
        ) => Promise<CandidateAssetImportResult>;
        deleteCandidateAsset: (
          input: CandidateAssetDeleteInput,
        ) => Promise<CandidateAssetDeleteResult>;
        openCandidateAsset: (
          input: CandidateAssetOpenInput,
        ) => Promise<CandidateAssetOpenResult>;
        restoreCandidateAsset: (
          input: CandidateAssetRestoreInput,
        ) => Promise<CandidateAssetRestoreResult>;
        getWorkspace: () => Promise<JobFinderRendererWorkspaceSnapshot>;
        getTailoredAsset: (assetId: string) => Promise<TailoredAsset | null>;
        getJobDetail: (
          jobId: string,
          planId: string | null,
        ) => Promise<JobFinderJobDetail>;
        getWorkspaceBootstrap: () => Promise<JobFinderRendererWorkspaceSnapshot>;
        /**
         * Home's first view (ADR 0077): everything but the Find jobs lists,
         * which stay deferred. Null when the workspace cannot give one.
         */
        getWorkspaceHome?: () => Promise<JobFinderRendererWorkspaceSnapshot | null>;
        syncWorkspace: (
          baseRevision: WorkspaceRevision | null,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        /** Tells main which revision this window shows (0: none it knows). */
        noteWorkspaceRevision: (revision: WorkspaceRevision) => void;
        onWorkspaceUpdate: (listener: () => void) => () => void;
        onOpenRoute: (listener: (route: string) => void) => () => void;
        mutateWorkspaceEntities: (
          input: JobFinderWorkspaceEntityMutationInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        openBrowserSession: (
          input?: JobFinderOpenBrowserSessionInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        checkBrowserSession: () => Promise<JobFinderWorkspaceSyncResult>;
        saveUserActionAnswerDraft: (
          input: SaveUserActionAnswerDraftInput,
        ) => Promise<void>;
        performUserAction: (
          command: UserActionCommandInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        saveProfile: (
          profile: CandidateProfile,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        saveWorkspaceInputs: {
          (
            profile: CandidateProfile,
            searchPreferences: JobSearchPreferences,
          ): Promise<JobFinderWorkspaceSyncResult>;
          (
            input: SaveJobFinderWorkspaceInput,
          ): Promise<JobFinderWorkspaceSyncResult>;
        };
        judgeUnjudgedJobs: () => Promise<JobFinderWorkspaceSyncResult>;
        analyzeProfileFromResume: () => Promise<JobFinderWorkspaceSyncResult>;
        saveSearchPreferences: (
          searchPreferences: JobSearchPreferences,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        setActivityControl: (
          input: SetJobFinderActivityControlInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        saveSettings: (
          settings: JobFinderSettings,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        updateApplicationDefaults: (
          input: UpdateApplicationDefaultsInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        updateWorkspaceBehavior: (
          input: UpdateWorkspaceBehaviorInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        updateAiBehavior: (
          input: UpdateAiBehaviorInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        updateAppearanceTheme: (
          appearanceTheme: AppearanceTheme,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        updateTrackerCrm: (
          applicationCrm: ApplicationCrmSettings,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        saveProfileSetupState: (
          profileSetupState: ProfileSetupState,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        applyProfileSetupReviewAction: (
          reviewItemId: string,
          action: "confirm" | "dismiss" | "clear_value",
          options?: ProfileSetupReviewActionOptions,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        applyResumeTimelineRepairAction: (
          runId: string,
          proposalId: string,
          action: ResumeTimelineRepairAction,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        sendProfileCopilotMessage: (
          content: string,
          context?: ProfileCopilotContext,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        applyProfileCopilotPatchGroup: (
          patchGroupId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        rejectProfileCopilotPatchGroup: (
          patchGroupId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        undoProfileRevision: (
          revisionId: string,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        importResume: (
          onProgress?: (event: ResumeImportProgressEvent) => void,
          /** `retryInterrupted` imports again the file a stopped import saved. */
          options?: { retryInterrupted?: boolean },
        ) => Promise<JobFinderWorkspaceSyncResult>;
        cancelImportResume: (stopProcessing?: boolean) => void;
        runDiscovery: () => Promise<JobFinderWorkspaceSyncResult>;
        runAgentDiscovery: (
          onActivity?: (event: DiscoveryActivityEvent) => void,
          targetId?: string,
          searchRequest?: JobFinderSearchRequest,
        ) => Promise<JobFinderAgentDiscoveryReply>;
        runAgentDiscoveryCommand: (
          onActivity?: (event: DiscoveryActivityEvent) => void,
          targetId?: string,
          searchRequest?: JobFinderSearchRequest,
        ) => Promise<JobFinderDiscoveryCommandReply>;
        cancelDiscoveryRunCommand: (
          runId: string,
        ) => Promise<JobFinderDiscoveryCancellationReply>;
        runSourceDebug: (
          targetId: string,
          onProgress?: (event: SourceDebugProgressEvent) => void,
          options?: { readabilityTimeoutMs?: number },
        ) => Promise<JobFinderWorkspaceSyncResult>;
        cancelSourceDebug: (
          runId: string,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        getSourceDebugRun: (runId: string) => Promise<SourceDebugRunRecord>;
        getSourceDebugRunDetails: (
          runId: string,
        ) => Promise<SourceDebugRunDetails>;
        getApplyRunDetails: (
          input: JobFinderApplyRunDetailsQuery,
        ) => Promise<ApplyRunDetails>;
        saveApplicationAnswer: (
          command: SaveApplicationAnswerCommandInput,
        ) => Promise<ApplyRunDetails>;
        clearApplicationAnswer: (
          command: ClearApplicationAnswerCommandInput,
        ) => Promise<ApplyRunDetails>;
        projectGroupedManualAnswer: (
          command: ProjectGroupedManualAnswerCommand,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        applyGroupedManualAnswer: (
          input: ApplyGroupedManualAnswerInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        snoozeGroupedDecision: (
          input: SnoozeGroupedDecisionInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        previewPersonalWorkspaceRestore: () => Promise<PersonalWorkspaceRestorePreview | null>;
        confirmPersonalWorkspaceRestore: (input: {
          token: string;
        }) => Promise<PersonalWorkspaceRestoreResult>;
        exportPersonalWorkspace: () => Promise<ApplicationCrmFileExportResult>;
        exportDiagnostics: () => Promise<JobFinderDiagnosticExportResult>;
        getPerformanceSnapshot: () => Promise<JobFinderPerformanceSnapshot>;
        exportApplicationPacket: (
          input: JobFinderApplyRunDetailsQuery,
        ) => Promise<JobFinderApplicationPacketExportResult>;
        saveSourceInstructionArtifact: (
          targetId: string,
          artifact: EditableSourceInstructionArtifact,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        listSourceDebugRuns: (
          targetId: string,
        ) => Promise<readonly SourceDebugRunRecord[]>;
        acceptSourceInstructionDraft: (
          targetId: string,
          instructionId: string,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        verifySourceInstructions: (
          targetId: string,
          instructionId: string,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        cancelAgentDiscovery: (
          input: JobFinderDiscoveryCancellationInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        resetBrowser: () => Promise<JobFinderWorkspaceSyncResult>;
        resetWorkspace: () => Promise<JobFinderWorkspaceSyncResult>;
        getStartupResetRecovery: () => Promise<JobFinderStartupResetRecoveryFact>;
        getStartupDatabaseRecovery: () => Promise<JobFinderStartupDatabaseRecoveryFact>;
        dismissStartupDatabaseRecoveryNotice: () => Promise<JobFinderStartupDatabaseRecoveryFact>;
        queueJobForReview: (
          jobId: string,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        setJobResumeApplicationMode: (
          jobId: string,
          resumeApplicationMode: ResumeApplicationMode,
          resumeTailoringMode?: TailoringMode | null,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        removeJobFromReview: (
          jobId: string,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        dismissDiscoveryJob: (
          jobId: string,
          reasons: readonly DiscoveryFeedbackReason[],
          action?: "hide_job" | "hide_and_exclude_employer",
          expectedNormalizedCompanyName?: string | null,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        previewEmployerExclusion: (
          jobId: string,
        ) => Promise<EmployerExclusionPreview>;
        removeEmployerExclusion: (
          input: RemoveEmployerExclusionInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        restoreDismissedDiscoveryJob: (
          jobId: string,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        getResumeWorkspace: (
          jobId: string,
        ) => Promise<JobFinderResumeWorkspace>;
        previewResumeDraft: (
          draft: ResumeDraft,
          requestId?: string,
        ) => Promise<JobFinderResumePreview>;
        saveResumeDraft: (
          draft: ResumeDraft,
          autosaveSessionId?: string,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        restoreResumeDraftRevision: (
          jobId: string,
          revisionId: string,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        undoResumeAssistantEdit: (
          jobId: string,
          revisionId: string,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        regenerateResumeDraft: (
          jobId: string,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        regenerateResumeSection: (
          jobId: string,
          sectionId: string,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        exportResumePdf: (
          jobId: string,
          intent?: ResumePdfExportIntent,
        ) => Promise<JobFinderResumePdfExportReply>;
        revealSavedFile: (path: string) => Promise<RevealSavedFileResult>;
        writeClipboardText: (text: string) => Promise<WriteClipboardTextResult>;
        approveResume: (
          jobId: string,
          exportId: string,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        clearResumeApproval: (
          jobId: string,
          restoreStatus?: "draft" | "needs_review",
        ) => Promise<JobFinderWorkspaceSyncResult>;
        setWorkHistoryReviewAcknowledgment: (
          input: JobFinderSetWorkHistoryReviewAcknowledgmentInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        setResumeClaimConfirmation: (
          input: JobFinderSetResumeClaimConfirmationInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        applyResumePatch: (
          patch: ResumeDraftPatch,
          revisionReason?: string | null,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        getResumeAssistantMessages: (
          jobId: string,
        ) => Promise<readonly ResumeAssistantMessage[]>;
        sendResumeAssistantMessage: (
          jobId: string,
          content: string,
        ) => Promise<readonly ResumeAssistantMessage[]>;
        resolveResumeAssistantProposal: (
          jobId: string,
          proposalId: string,
          action: "accept" | "reject",
          patchIds: readonly string[],
        ) => Promise<readonly ResumeAssistantMessage[]>;
        getApplicationPageStates: (
          resultIds: string[],
        ) => Promise<ApplicationPageState[]>;
        reopenApplicationPage: (
          input: ReopenApplicationPageInput,
          onProgress?: (progress: ApplicationPageReopenProgress) => void,
        ) => Promise<ApplicationPageState>;
        generateResumeForBatch: (
          input: ResumeBatchGenerationInput,
        ) => Promise<ResumeBatchGenerationResult>;
        onResumeBatchProgress: (
          listener: (progress: ResumeBatchGenerationProgress) => void,
        ) => () => void;
        generateResume: (
          jobId: string,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        startApplyCopilotRun: (
          input: JobFinderApplyCopilotActionInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        startAutoApplyRun: (
          input: JobFinderApplicationStartTarget,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        startAutoApplyQueueRun: (
          jobIds: JobFinderApplyQueueActionInput["jobIds"],
          applicationAutomationMode?: JobFinderApplyQueueActionInput["applicationAutomationMode"],
        ) => Promise<JobFinderWorkspaceSyncResult>;
        startApplyQueue: (
          input: JobFinderStartApplyQueueInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        approveResumes: (
          input: JobFinderApproveResumesInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        controlApplyQueue: (
          input: JobFinderApplyQueueControlInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        removeFromApplyQueue: (
          input: JobFinderRemoveFromApplyQueueInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        returnApplicationToShortlist: (
          input: JobFinderReturnApplicationToShortlistInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        undoReturnApplicationToShortlist: (
          jobId: string,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        approveApplyRun: (
          input: JobFinderApplyRunActionInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        cancelApplyRun: (
          input: JobFinderApplyRunActionInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        resolveApplyConsentRequest: (
          input: JobFinderApplyConsentActionInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        revokeApplyRunApproval: (
          input: JobFinderApplyRunActionInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        focusPreparedApplicationPage: (
          input: JobFinderPreparedApplicationPageInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        submitPreparedApplication: (input: {
          jobId: string;
        }) => Promise<JobFinderWorkspaceSyncResult>;
        sendPreparedApplications: (input: {
          jobIds: string[];
        }) => Promise<JobFinderWorkspaceSyncResult>;
        approveApply: (
          input: JobFinderApplicationStartTarget,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        mutateApplicationCrm: (
          input: ApplicationCrmMutationInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        mutateApplicationCrmBulkStage: (
          input: ApplicationCrmBulkStageMutationInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        runApplicationNoResponseAutomation: (
          settings?: ApplicationCrmSettings,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        exportApplicationCrm: (
          input: ApplicationCrmExportInput,
        ) => Promise<ApplicationCrmFileExportResult>;
        test?: {
          loadApplicationsStoreDemo: (input: {
            sourceUrl: string;
          }) => Promise<ApplicationStoreDemoResult>;
          getSystemThemeOverride: () => "dark" | "light" | null;
          setSystemThemeOverride: (
            theme: "dark" | "light" | null,
          ) => Promise<{ ok: true }>;
          setResumePreviewMode: (
            mode: "ok" | "fail_once",
          ) => Promise<{ ok: true }>;
          loadResumeWorkspaceDemo: () => Promise<JobFinderRendererWorkspaceSnapshot>;
          loadApplyQueueDemo: () => Promise<JobFinderRendererWorkspaceSnapshot>;
          loadWorkHistoryReviewDemo: () => Promise<JobFinderRendererWorkspaceSnapshot>;
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
          }) => Promise<JobFinderRendererWorkspaceSnapshot>;
          /**
           * Arms exactly the next save on one protected surface to fail, then
           * clears itself. Test API only; absent in a production build.
           */
          failNextSave: (
            surface: JobFinderTestSaveSurface,
          ) => Promise<{ ok: true }>;
          resetWorkspaceState: (
            state: JobFinderRepositoryState,
          ) => Promise<JobFinderRendererWorkspaceSnapshot>;
          getPerformanceSnapshot: () => Promise<JobFinderPerformanceSnapshot>;
          runResumeImportBenchmark: (
            input?: Partial<ResumeImportBenchmarkRequest>,
          ) => Promise<ResumeImportBenchmarkReport>;
          getResumeImportBenchmarkCases: () => Promise<
            readonly ResumeImportBenchmarkCase[]
          >;
          getResumeImportState: () => Promise<{
            resumeImportRuns: readonly ResumeImportRun[];
            resumeImportDocumentBundles: readonly ResumeDocumentBundle[];
            resumeImportFieldCandidates: readonly ResumeImportFieldCandidate[];
          }>;
          runResumeQualityBenchmark: (
            input?: Partial<ResumeQualityBenchmarkRequest>,
          ) => Promise<ResumeQualityBenchmarkReport>;
          importResumeFromPath: (
            sourcePath: string | { sourcePath: string; useVision?: boolean },
          ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        };
      };
    };
  }
}

export {};
