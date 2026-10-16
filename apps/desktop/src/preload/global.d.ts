import type {
  ResumeBatchGenerationInput,
  ResumeBatchGenerationResult,
  ResumeBatchGenerationProgress,
} from "@nordri/contracts";
import type {
  DesktopAssistantBridge,
  DesktopBrowserBridge,
  ApplicationAuthorityEnvelope,
  ApplicationAuthorityEnvelopeMutationResult,
  ApplicationAuthorityReadiness,
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
  ApproveCurrentApplicationAnswersInput,
  ApproveCurrentApplicationAnswersResult,
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
  CreateApplicationAuthorityEnvelopeInput,
  JobFinderApplicationPacketExportResult,
  JobFinderDiagnosticExportResult,
  JobFinderApplyConsentActionInput,
  JobFinderApplyCopilotActionInput,
  JobFinderApplyQueueActionInput,
  JobFinderApplyRunActionInput,
  JobFinderApplyRunDetailsQuery,
  JobFinderApplicationStartTarget,
  JobFinderPreparedApplicationPageInput,
  JobFinderDiscoveryCancellationInput,
  JobFinderSearchRequest,
  CandidateProfile,
  TailoredAsset,
  ClearApplicationAnswerCommandInput,
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
  GetApplicationAuthorityEnvelopeInput,
  GetApplicationAuthorityReadinessInput,
  InterviewExportFormat,
  InterviewExportResult,
  JobFinderInterviewFollowUpInput,
  ListApplicationAuthorityEnvelopesInput,
  ListApplicationAuthorityEnvelopesResult,
  ListApplicationDocumentsInput,
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
  WriteClipboardTextResult,
  JobFinderOpenBrowserSessionInput,
  JobFinderSetResumeClaimConfirmationInput,
  JobFinderSetWorkHistoryReviewAcknowledgmentInput,
  ProfileCopilotContext,
  ProfileSetupReviewActionOptions,
  ProposeApplicationDocumentInput,
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
  JobFinderResumePdfExportResult,
  RevealSavedFileResult,
  ResumePdfExportIntent,
  RevokeApplicationAuthorityEnvelopeInput,
  ResolveSubmissionOutcomeInput,
  ResolveSubmissionOutcomeResult,
  RemoveEmployerExclusionInput,
  ResumeTimelineRepairAction,
  ResumeDocumentBundle,
  JobFinderPerformanceSnapshot,
  JobFinderResumePreview,
  JobFinderResumeWorkspace,
  JobFinderRepositoryState,
  JobFinderTestSaveSurface,
  JobFinderAgentDiscoveryResult,
  JobFinderSettings,
  ProfileSetupState,
  ProjectGroupedManualAnswerCommand,
  ResumeAssistantMessage,
  ResumeDraft,
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
  CompanyIntelligenceMutationInput,
  ResumeStrategyRecommendation,
  ReviewCompanyMergeInput,
  RunCampaignNowInput,
  SaveResumeStrategyInput,
  SafeguardMutationInput,
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
  SaveUserActionAnswerDraftInput,
  UserActionCommandInput,
} from "@nordri/contracts";
import type {
  JobFinderStartupDatabaseRecoveryFact,
  JobFinderStartupResetRecoveryFact,
} from "@nordri/contracts";

declare global {
  interface Window {
    nordri: {
      browser: DesktopBrowserBridge;
      assistant: DesktopAssistantBridge;
      ping: () => Promise<DesktopPlatformPing>;
      window: {
        close: () => Promise<{ ok: true }>;
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
        syncWorkspace: (
          baseRevision: WorkspaceRevision | null,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        onWorkspaceUpdate: (listener: () => void) => () => void;
        mutateWorkspaceEntities: (
          input: JobFinderWorkspaceEntityMutationInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        openBrowserSession: (
          input?: JobFinderOpenBrowserSessionInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        checkBrowserSession: () => Promise<JobFinderRendererWorkspaceSnapshot>;
        saveUserActionAnswerDraft: (
          input: SaveUserActionAnswerDraftInput,
        ) => Promise<void>;
        performUserAction: (
          command: UserActionCommandInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        saveProfile: (
          profile: CandidateProfile,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        saveWorkspaceInputs: {
          (
            profile: CandidateProfile,
            searchPreferences: JobSearchPreferences,
          ): Promise<JobFinderRendererWorkspaceSnapshot>;
          (
            input: SaveJobFinderWorkspaceInput,
          ): Promise<JobFinderRendererWorkspaceSnapshot>;
        };
        judgeUnjudgedJobs: () => Promise<JobFinderRendererWorkspaceSnapshot>;
        analyzeProfileFromResume: () => Promise<JobFinderRendererWorkspaceSnapshot>;
        saveSearchPreferences: (
          searchPreferences: JobSearchPreferences,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        saveCampaign: (
          campaign: SaveJobSearchCampaignInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        selectCampaign: (
          campaignId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        runCampaignNow: (
          input?: RunCampaignNowInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        markCampaignNotificationRead: (
          notificationId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        markAllCampaignNotificationsRead: () => Promise<JobFinderRendererWorkspaceSnapshot>;
        saveCampaignRule: (
          campaignId: string,
          rule: SaveCampaignRuleInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        deleteCampaignRule: (
          campaignId: string,
          ruleId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        deleteJobSearchCampaign: (campaignId: string) => Promise<boolean>;
        toggleCampaignRule: (
          campaignId: string,
          ruleId: string,
          enabled: boolean,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        projectCampaignRuleFunnel: (
          campaignId: string,
        ) => Promise<CampaignRuleFunnelProjection>;
        setActivityControl: (
          input: SetJobFinderActivityControlInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        mutateRapidReview: (
          input: RapidReviewMutationInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        recordOutcome: (
          input: RecordOutcomeInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        saveResumeStrategy: (
          input: SaveResumeStrategyInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        disableResumeStrategy: (
          strategyId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        selectResumeStrategy: (
          input: SelectResumeStrategyInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        recommendResumeStrategy: (
          input: RecommendResumeStrategyInput,
        ) => Promise<ResumeStrategyRecommendation>;
        setCampaignResumeStrategyDefault: (
          input: SetCampaignResumeStrategyDefaultInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        refreshCompanyIntelligence: () => Promise<JobFinderRendererWorkspaceSnapshot>;
        setCompanyPreference: (
          input: SetCompanyPreferenceInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        reviewCompanyMerge: (
          input: ReviewCompanyMergeInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        mutateCompanyIntelligence: (
          input: CompanyIntelligenceMutationInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        setOutcomeSuggestionEnabled: (
          input: SetOutcomeSuggestionEnabledInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        mutateSafeguards: (
          input: SafeguardMutationInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        saveSettings: (
          settings: JobFinderSettings,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        updateApplicationDefaults: (
          input: UpdateApplicationDefaultsInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        updateWorkspaceBehavior: (
          input: UpdateWorkspaceBehaviorInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        updateAiBehavior: (
          input: UpdateAiBehaviorInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        updateAppearanceTheme: (
          appearanceTheme: AppearanceTheme,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        updateTrackerCrm: (
          applicationCrm: ApplicationCrmSettings,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        saveProfileSetupState: (
          profileSetupState: ProfileSetupState,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        applyProfileSetupReviewAction: (
          reviewItemId: string,
          action: "confirm" | "dismiss" | "clear_value",
          options?: ProfileSetupReviewActionOptions,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        applyResumeTimelineRepairAction: (
          runId: string,
          proposalId: string,
          action: ResumeTimelineRepairAction,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
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
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        importResume: (
          onProgress?: (event: ResumeImportProgressEvent) => void,
          /** `retryInterrupted` imports again the file a stopped import saved. */
          options?: { retryInterrupted?: boolean },
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        cancelImportResume: (stopProcessing?: boolean) => void;
        runDiscovery: () => Promise<JobFinderRendererWorkspaceSnapshot>;
        runAgentDiscovery: (
          onActivity?: (event: DiscoveryActivityEvent) => void,
          targetId?: string,
          searchRequest?: JobFinderSearchRequest,
        ) => Promise<JobFinderAgentDiscoveryResult>;
        runSourceDebug: (
          targetId: string,
          onProgress?: (event: SourceDebugProgressEvent) => void,
          options?: { readabilityTimeoutMs?: number },
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        cancelSourceDebug: (
          runId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
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
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        applyGroupedManualAnswer: (
          input: ApplyGroupedManualAnswerInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        snoozeGroupedDecision: (
          input: SnoozeGroupedDecisionInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
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
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        listSourceDebugRuns: (
          targetId: string,
        ) => Promise<readonly SourceDebugRunRecord[]>;
        acceptSourceInstructionDraft: (
          targetId: string,
          instructionId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        verifySourceInstructions: (
          targetId: string,
          instructionId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        cancelAgentDiscovery: (
          input: JobFinderDiscoveryCancellationInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        resetBrowser: () => Promise<JobFinderRendererWorkspaceSnapshot>;
        resetWorkspace: () => Promise<JobFinderRendererWorkspaceSnapshot>;
        getStartupResetRecovery: () => Promise<JobFinderStartupResetRecoveryFact>;
        getStartupDatabaseRecovery: () => Promise<JobFinderStartupDatabaseRecoveryFact>;
        dismissStartupDatabaseRecoveryNotice: () => Promise<JobFinderStartupDatabaseRecoveryFact>;
        queueJobForReview: (
          jobId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        setJobResumeApplicationMode: (
          jobId: string,
          resumeApplicationMode: ResumeApplicationMode,
          resumeTailoringMode?: TailoringMode | null,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        removeJobFromReview: (
          jobId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        dismissDiscoveryJob: (
          jobId: string,
          reasons: readonly DiscoveryFeedbackReason[],
          action?: "hide_job" | "hide_and_exclude_employer",
          expectedNormalizedCompanyName?: string | null,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        previewEmployerExclusion: (
          jobId: string,
        ) => Promise<EmployerExclusionPreview>;
        removeEmployerExclusion: (
          input: RemoveEmployerExclusionInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        restoreDismissedDiscoveryJob: (
          jobId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        getResumeWorkspace: (
          jobId: string,
        ) => Promise<JobFinderResumeWorkspace>;
        previewResumeDraft: (
          draft: ResumeDraft,
          requestId?: string,
        ) => Promise<JobFinderResumePreview>;
        saveResumeDraft: (
          draft: ResumeDraft,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        restoreResumeDraftRevision: (
          jobId: string,
          revisionId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        undoResumeAssistantEdit: (
          jobId: string,
          revisionId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        regenerateResumeDraft: (
          jobId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        regenerateResumeSection: (
          jobId: string,
          sectionId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        exportResumePdf: (
          jobId: string,
          intent?: ResumePdfExportIntent,
        ) => Promise<JobFinderResumePdfExportResult>;
        revealSavedFile: (path: string) => Promise<RevealSavedFileResult>;
        writeClipboardText: (text: string) => Promise<WriteClipboardTextResult>;
        approveResume: (
          jobId: string,
          exportId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        clearResumeApproval: (
          jobId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        setWorkHistoryReviewAcknowledgment: (
          input: JobFinderSetWorkHistoryReviewAcknowledgmentInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        setResumeClaimConfirmation: (
          input: JobFinderSetResumeClaimConfirmationInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        applyResumePatch: (
          patch: ResumeDraftPatch,
          revisionReason?: string | null,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
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
        generateResumeForBatch: (
          input: ResumeBatchGenerationInput,
        ) => Promise<ResumeBatchGenerationResult>;
        onResumeBatchProgress: (
          listener: (progress: ResumeBatchGenerationProgress) => void,
        ) => () => void;
        generateResume: (
          jobId: string,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        startApplyCopilotRun: (
          input: JobFinderApplyCopilotActionInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        startAutoApplyRun: (
          input: JobFinderApplicationStartTarget,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        startAutoApplyQueueRun: (
          jobIds: JobFinderApplyQueueActionInput["jobIds"],
          applicationAutomationMode?: JobFinderApplyQueueActionInput["applicationAutomationMode"],
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        approveApplyRun: (
          input: JobFinderApplyRunActionInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        cancelApplyRun: (
          input: JobFinderApplyRunActionInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        resolveApplyConsentRequest: (
          input: JobFinderApplyConsentActionInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        revokeApplyRunApproval: (
          input: JobFinderApplyRunActionInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        focusPreparedApplicationPage: (
          input: JobFinderPreparedApplicationPageInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        submitPreparedApplication: (input: {
          jobId: string;
        }) => Promise<JobFinderRendererWorkspaceSnapshot>;
        sendPreparedApplications: (input: {
          jobIds: string[];
        }) => Promise<JobFinderRendererWorkspaceSnapshot>;
        approveApply: (
          input: JobFinderApplicationStartTarget,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        mutateApplicationCrm: (
          input: ApplicationCrmMutationInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        mutateApplicationCrmBulkStage: (
          input: ApplicationCrmBulkStageMutationInput,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        runApplicationNoResponseAutomation: (
          settings?: ApplicationCrmSettings,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>;
        exportApplicationCrm: (
          input: ApplicationCrmExportInput,
        ) => Promise<ApplicationCrmFileExportResult>;
        test?: {
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
