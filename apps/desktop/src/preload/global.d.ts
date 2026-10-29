import type { DesktopResumesBridge } from "./resumes";
import type { DesktopHomeBridge } from "./home";
import type { DesktopActivityBridge } from "./activity";
import type { DesktopNeedsYouBridge } from "./needs-you";
import type { DesktopTrackerBridge } from "./tracker";
import type {
  ApplicationListPage,
  ApplicationListQuery,
  ApplicationRow,
  ApplicationTarget,
  ResolveUncertainSendInput,
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
} from "@nestor/contracts";
import type {
  DesktopAssistantBridge,
  DesktopBrowserBridge,
  DesktopJobsBridge,
  DesktopProfileWorkflowBridge,
  ApplicationListPage,
  ApplicationListQuery,
  ApplicationStoreDemoResult,
  ApplyJobsInput,
  ApplyJobsResult,
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
  DesktopAssistantBridge,
  DesktopBrowserBridge,
  DesktopContextMenuInput,
  DesktopContextMenuResult,
  DesktopPlatformPing,
  LaunchContext,
  DesktopWindowCloseGuardState,
  DesktopWindowCloseRequest,
  DesktopWindowCloseResolution,
  DesktopWindowControlsState,
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
  JobFinderDiagnosticExportResult,
  JobFinderInterviewFollowUpInput,
  JobFinderStartupResetRecoveryFact,
  ResumeImportBenchmarkCase,
  ResumeImportBenchmarkReport,
  ResumeImportBenchmarkRequest,
  ResumeImportRun,
  RevealSavedFileResult,
  SaveInterviewSetupInput,
  SendInterviewChatMessageInput,
  UpdateInterviewOverlayPreferenceInput,
  WriteClipboardTextResult,
} from "@nestor/contracts";

declare global {
  interface Window {
    nestor: {
      browser: DesktopBrowserBridge;
      assistant: DesktopAssistantBridge;
      jobs: DesktopJobsBridge;
      resumes: DesktopResumesBridge;
      needsYou: DesktopNeedsYouBridge;
      tracker: DesktopTrackerBridge;
      home: DesktopHomeBridge;
      activity: DesktopActivityBridge;
      profileWorkflow: DesktopProfileWorkflowBridge;
      ping: () => Promise<DesktopPlatformPing>;
      /** The first screen is usable; main starts its background services. */
      firstScreenShown: () => void;
      /** Settings and setup state for the first frame. */
      launchContext: () => Promise<LaunchContext>;
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
        ) => Promise<unknown>;
      };
      jobFinder: {
        applyJobs: (input: ApplyJobsInput) => Promise<ApplyJobsResult>;
        listApplications: (
          input?: ApplicationListQuery,
        ) => Promise<ApplicationListPage>;
        applicationsForJobs: (
          input: ApplicationsForJobsInput,
        ) => Promise<ApplicationRow[]>;
        getApplicationDetails: (
          input: ApplicationTarget,
        ) => Promise<ApplicationDetails | null>;
        openApplication: (input: ApplicationTarget) => Promise<boolean>;
        stopApplication: (input: ApplicationTarget) => Promise<boolean>;
        resolveUncertainSend: (
          input: ResolveUncertainSendInput,
        ) => Promise<boolean>;
        listNeedsYou: (input?: NeedsYouListQuery) => Promise<NeedsYouPage>;
        answerNeedsYou: (
          input: AnswerNeedsYouInput,
        ) => Promise<AnswerNeedsYouResult>;
        onApplicationsChange: (
          listener: (change: JobChange) => void,
        ) => () => void;
        onOpenRoute: (listener: (route: string) => void) => () => void;
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
        exportDiagnostics: () => Promise<JobFinderDiagnosticExportResult>;
        resetWorkspace: () => Promise<void>;
        getStartupResetRecovery: () => Promise<JobFinderStartupResetRecoveryFact>;
        revealSavedFile: (path: string) => Promise<RevealSavedFileResult>;
        writeClipboardText: (text: string) => Promise<WriteClipboardTextResult>;
        test?: {
          loadApplicationsStoreDemo: (input: {
            sourceUrl: string;
            trackApplications?: boolean;
          }) => Promise<ApplicationStoreDemoResult>;
          getSystemThemeOverride: () => "dark" | "light" | null;
          setSystemThemeOverride: (
            theme: "dark" | "light" | null,
          ) => Promise<{ ok: true }>;
          runResumeImportBenchmark: (
            input?: Partial<ResumeImportBenchmarkRequest>,
          ) => Promise<ResumeImportBenchmarkReport>;
          getResumeImportBenchmarkCases: () => Promise<
            readonly ResumeImportBenchmarkCase[]
          >;
          importResumeFromPath: (
            sourcePath: string | { sourcePath: string; useVision?: boolean },
          ) => Promise<{
            profile: CandidateProfile;
            latestResumeImportRun: ResumeImportRun | null;
          }>;
        };
      };
    };
  }
}

export {};
