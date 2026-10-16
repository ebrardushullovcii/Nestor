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
  JobFinderWorkspaceSnapshot,
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
        ) => Promise<JobFinderWorkspaceSnapshot>;
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
        getWorkspace: () => Promise<JobFinderWorkspaceSnapshot>;
        getWorkspaceBootstrap: () => Promise<JobFinderWorkspaceSnapshot>;
        syncWorkspace: (
          baseRevision: WorkspaceRevision | null,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        onWorkspaceUpdate: (listener: () => void) => () => void;
        mutateWorkspaceEntities: (
          input: JobFinderWorkspaceEntityMutationInput,
        ) => Promise<JobFinderWorkspaceSyncResult>;
        openBrowserSession: (
          input?: JobFinderOpenBrowserSessionInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        checkBrowserSession: () => Promise<JobFinderWorkspaceSnapshot>;
        saveUserActionAnswerDraft: (
          input: SaveUserActionAnswerDraftInput,
        ) => Promise<void>;
        performUserAction: (
          command: UserActionCommandInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        saveProfile: (
          profile: CandidateProfile,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        saveWorkspaceInputs: {
          (
            profile: CandidateProfile,
            searchPreferences: JobSearchPreferences,
          ): Promise<JobFinderWorkspaceSnapshot>;
          (
            input: SaveJobFinderWorkspaceInput,
          ): Promise<JobFinderWorkspaceSnapshot>;
        };
        analyzeProfileFromResume: () => Promise<JobFinderWorkspaceSnapshot>;
        saveSearchPreferences: (
          searchPreferences: JobSearchPreferences,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        saveCampaign: (
          campaign: SaveJobSearchCampaignInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        selectCampaign: (
          campaignId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        runCampaignNow: (
          input?: RunCampaignNowInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        markCampaignNotificationRead: (
          notificationId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        markAllCampaignNotificationsRead: () => Promise<JobFinderWorkspaceSnapshot>;
        saveCampaignRule: (
          campaignId: string,
          rule: SaveCampaignRuleInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        deleteCampaignRule: (
          campaignId: string,
          ruleId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        deleteJobSearchCampaign: (campaignId: string) => Promise<boolean>;
        toggleCampaignRule: (
          campaignId: string,
          ruleId: string,
          enabled: boolean,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        projectCampaignRuleFunnel: (
          campaignId: string,
        ) => Promise<CampaignRuleFunnelProjection>;
        setActivityControl: (
          input: SetJobFinderActivityControlInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        mutateRapidReview: (
          input: RapidReviewMutationInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        recordOutcome: (
          input: RecordOutcomeInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        saveResumeStrategy: (
          input: SaveResumeStrategyInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        disableResumeStrategy: (
          strategyId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        selectResumeStrategy: (
          input: SelectResumeStrategyInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        recommendResumeStrategy: (
          input: RecommendResumeStrategyInput,
        ) => Promise<ResumeStrategyRecommendation>;
        setCampaignResumeStrategyDefault: (
          input: SetCampaignResumeStrategyDefaultInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        refreshCompanyIntelligence: () => Promise<JobFinderWorkspaceSnapshot>;
        setCompanyPreference: (
          input: SetCompanyPreferenceInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        reviewCompanyMerge: (
          input: ReviewCompanyMergeInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        mutateCompanyIntelligence: (
          input: CompanyIntelligenceMutationInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        setOutcomeSuggestionEnabled: (
          input: SetOutcomeSuggestionEnabledInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        mutateSafeguards: (
          input: SafeguardMutationInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        saveSettings: (
          settings: JobFinderSettings,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        updateApplicationDefaults: (
          input: UpdateApplicationDefaultsInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        updateWorkspaceBehavior: (
          input: UpdateWorkspaceBehaviorInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        updateAiBehavior: (
          input: UpdateAiBehaviorInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        updateAppearanceTheme: (
          appearanceTheme: AppearanceTheme,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        updateTrackerCrm: (
          applicationCrm: ApplicationCrmSettings,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        saveProfileSetupState: (
          profileSetupState: ProfileSetupState,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        applyProfileSetupReviewAction: (
          reviewItemId: string,
          action: "confirm" | "dismiss" | "clear_value",
          options?: ProfileSetupReviewActionOptions,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        applyResumeTimelineRepairAction: (
          runId: string,
          proposalId: string,
          action: ResumeTimelineRepairAction,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        sendProfileCopilotMessage: (
          content: string,
          context?: ProfileCopilotContext,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        applyProfileCopilotPatchGroup: (
          patchGroupId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        rejectProfileCopilotPatchGroup: (
          patchGroupId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        undoProfileRevision: (
          revisionId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        importResume: (
          onProgress?: (event: ResumeImportProgressEvent) => void,
          /** `retryInterrupted` imports again the file a stopped import saved. */
          options?: { retryInterrupted?: boolean },
        ) => Promise<JobFinderWorkspaceSnapshot>;
        cancelImportResume: (stopProcessing?: boolean) => void;
        runDiscovery: () => Promise<JobFinderWorkspaceSnapshot>;
        runAgentDiscovery: (
          onActivity?: (event: DiscoveryActivityEvent) => void,
          targetId?: string,
          searchRequest?: JobFinderSearchRequest,
        ) => Promise<JobFinderAgentDiscoveryResult>;
        runSourceDebug: (
          targetId: string,
          onProgress?: (event: SourceDebugProgressEvent) => void,
          options?: { readabilityTimeoutMs?: number },
        ) => Promise<JobFinderWorkspaceSnapshot>;
        cancelSourceDebug: (
          runId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
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
        ) => Promise<JobFinderWorkspaceSnapshot>;
        applyGroupedManualAnswer: (
          input: ApplyGroupedManualAnswerInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        snoozeGroupedDecision: (
          input: SnoozeGroupedDecisionInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
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
        ) => Promise<JobFinderWorkspaceSnapshot>;
        listSourceDebugRuns: (
          targetId: string,
        ) => Promise<readonly SourceDebugRunRecord[]>;
        acceptSourceInstructionDraft: (
          targetId: string,
          instructionId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        verifySourceInstructions: (
          targetId: string,
          instructionId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        cancelAgentDiscovery: (
          input: JobFinderDiscoveryCancellationInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        resetBrowser: () => Promise<JobFinderWorkspaceSnapshot>;
        resetWorkspace: () => Promise<JobFinderWorkspaceSnapshot>;
        getStartupResetRecovery: () => Promise<JobFinderStartupResetRecoveryFact>;
        getStartupDatabaseRecovery: () => Promise<JobFinderStartupDatabaseRecoveryFact>;
        dismissStartupDatabaseRecoveryNotice: () => Promise<JobFinderStartupDatabaseRecoveryFact>;
        queueJobForReview: (
          jobId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        setJobResumeApplicationMode: (
          jobId: string,
          resumeApplicationMode: ResumeApplicationMode,
          resumeTailoringMode?: TailoringMode | null,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        removeJobFromReview: (
          jobId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        dismissDiscoveryJob: (
          jobId: string,
          reasons: readonly DiscoveryFeedbackReason[],
          action?: "hide_job" | "hide_and_exclude_employer",
          expectedNormalizedCompanyName?: string | null,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        previewEmployerExclusion: (
          jobId: string,
        ) => Promise<EmployerExclusionPreview>;
        removeEmployerExclusion: (
          input: RemoveEmployerExclusionInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        restoreDismissedDiscoveryJob: (
          jobId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        getResumeWorkspace: (
          jobId: string,
        ) => Promise<JobFinderResumeWorkspace>;
        previewResumeDraft: (
          draft: ResumeDraft,
          requestId?: string,
        ) => Promise<JobFinderResumePreview>;
        saveResumeDraft: (
          draft: ResumeDraft,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        restoreResumeDraftRevision: (
          jobId: string,
          revisionId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        undoResumeAssistantEdit: (
          jobId: string,
          revisionId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        regenerateResumeDraft: (
          jobId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        regenerateResumeSection: (
          jobId: string,
          sectionId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        exportResumePdf: (
          jobId: string,
          intent?: ResumePdfExportIntent,
        ) => Promise<JobFinderResumePdfExportResult>;
        revealSavedFile: (path: string) => Promise<RevealSavedFileResult>;
        writeClipboardText: (text: string) => Promise<WriteClipboardTextResult>;
        approveResume: (
          jobId: string,
          exportId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        clearResumeApproval: (
          jobId: string,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        setWorkHistoryReviewAcknowledgment: (
          input: JobFinderSetWorkHistoryReviewAcknowledgmentInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        setResumeClaimConfirmation: (
          input: JobFinderSetResumeClaimConfirmationInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        applyResumePatch: (
          patch: ResumeDraftPatch,
          revisionReason?: string | null,
        ) => Promise<JobFinderWorkspaceSnapshot>;
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
        generateResume: (jobId: string) => Promise<JobFinderWorkspaceSnapshot>;
        startApplyCopilotRun: (
          input: JobFinderApplyCopilotActionInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        startAutoApplyRun: (
          input: JobFinderApplicationStartTarget,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        startAutoApplyQueueRun: (
          jobIds: JobFinderApplyQueueActionInput["jobIds"],
          applicationAutomationMode?: JobFinderApplyQueueActionInput["applicationAutomationMode"],
        ) => Promise<JobFinderWorkspaceSnapshot>;
        approveApplyRun: (
          input: JobFinderApplyRunActionInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        cancelApplyRun: (
          input: JobFinderApplyRunActionInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        resolveApplyConsentRequest: (
          input: JobFinderApplyConsentActionInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        revokeApplyRunApproval: (
          input: JobFinderApplyRunActionInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        focusPreparedApplicationPage: (
          input: JobFinderPreparedApplicationPageInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        submitPreparedApplication: (input: {
          jobId: string;
        }) => Promise<JobFinderWorkspaceSnapshot>;
        sendPreparedApplications: (input: {
          jobIds: string[];
        }) => Promise<JobFinderWorkspaceSnapshot>;
        approveApply: (
          input: JobFinderApplicationStartTarget,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        mutateApplicationCrm: (
          input: ApplicationCrmMutationInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        mutateApplicationCrmBulkStage: (
          input: ApplicationCrmBulkStageMutationInput,
        ) => Promise<JobFinderWorkspaceSnapshot>;
        runApplicationNoResponseAutomation: (
          settings?: ApplicationCrmSettings,
        ) => Promise<JobFinderWorkspaceSnapshot>;
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
          loadResumeWorkspaceDemo: () => Promise<JobFinderWorkspaceSnapshot>;
          loadApplyQueueDemo: () => Promise<JobFinderWorkspaceSnapshot>;
          loadWorkHistoryReviewDemo: () => Promise<JobFinderWorkspaceSnapshot>;
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
          }) => Promise<JobFinderWorkspaceSnapshot>;
          /**
           * Arms exactly the next save on one protected surface to fail, then
           * clears itself. Test API only; absent in a production build.
           */
          failNextSave: (
            surface: JobFinderTestSaveSurface,
          ) => Promise<{ ok: true }>;
          resetWorkspaceState: (
            state: JobFinderRepositoryState,
          ) => Promise<JobFinderWorkspaceSnapshot>;
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
          ) => Promise<JobFinderWorkspaceSnapshot>;
        };
      };
    };
  }
}

export {};
