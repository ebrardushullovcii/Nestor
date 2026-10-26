import type {
  AppearanceTheme,
  CandidateProfile,
  EditableSourceInstructionArtifact,
  JobFinderOpenBrowserSessionInput,
  JobFinderSearchRequest,
  JobFinderRendererWorkspaceSnapshot,
  JobSearchPreferences,
  ProfileCopilotContext,
  ProfileSetupReviewActionOptions,
  ProfileSetupStep,
  ResumeImportProgressEvent,
  ResumeTimelineRepairAction,
  SetJobFinderActivityControlInput,
  UpdateApplicationDefaultsInput,
  UpdateWorkspaceBehaviorInput,
  UpdateAiBehaviorInput,
  SourceDebugRunDetails,
} from "@nestor/contracts";
import type { PendingActionScope } from "./job-finder-pending-actions";
import type { ActionState } from "@renderer/features/job-finder/lib/job-finder-types";
import type { JobFinderSaveState } from "./job-finder-save-state";

/**
 * Opt-in error propagation for one call, not a mode change for the action.
 *
 * Every Job Finder action reports its own failure once, as a route message, and
 * then resolves `false` — a caller that only fires and forgets wants exactly
 * that. A caller that reports the failure IN PLACE needs the cause as well, and
 * cannot get it from a boolean: the Applications hand-off composed "The Job
 * Finder browser did not open…" with nothing where the reason belonged. Passing
 * this makes the returned promise reject with the underlying error for that
 * call only; the route message is written either way, and no other caller's
 * behaviour changes.
 */
export type JobFinderActionFailureReporting = {
  readonly rethrowError?: boolean;
};

export interface JobFinderPageContext {
  actionState: ActionState;
  canImportResume: boolean;
  importResumeGuardMessage: string | null;
  isPending: (scope: PendingActionScope) => boolean;
  resumeOperationStarts?: Readonly<Record<string, number>>;
  isAnyPending: (scopes: readonly PendingActionScope[]) => boolean;
  profileCopilotBusy: boolean;
  resumeImportProgress: ResumeImportProgressEvent | null;
  saveState: JobFinderSaveState;
  onAnalyzeProfileFromResume: () => void;
  onApplyProfileCopilotPatchGroup: (patchGroupId: string) => void;
  onApplyProfileSetupReviewAction: (
    reviewItemId: string,
    action: "confirm" | "dismiss" | "clear_value",
    options?: ProfileSetupReviewActionOptions,
  ) => void;
  onApplyResumeTimelineRepairAction: (
    runId: string,
    proposalId: string,
    action: ResumeTimelineRepairAction,
  ) => Promise<void>;
  onCheckBrowserSession: () => void;
  /** Puts a recorded move back (toast Undo, Activity's Recent changes). */
  onRemoveReviewJobs?: (
    jobIds: readonly string[],
    options?: { quiet?: boolean },
  ) => Promise<void>;
  /** Shows a file the app wrote in the OS file manager. Nothing is opened. */
  onRevealSavedFile: (path: string) => void;
  onGetSourceDebugRunDetails: (runId: string) => Promise<SourceDebugRunDetails>;
  /** `retryInterrupted` imports again the file a stopped import saved. */
  onImportResume: (options?: { retryInterrupted?: boolean }) => void;
  onCancelImportResume: () => void;
  /**
   * Opens or focuses the Job Finder browser and resolves with whether that
   * actually happened. The result used to be discarded (`void runAction(...)`),
   * so a caller that reported an outcome beside the control could only report
   * an optimistic success: the rejection never reached it. Callers that do not
   * report an outcome still `void` the promise at their own call site.
   */

  onOpenBrowserSession: (
    input?: JobFinderOpenBrowserSessionInput,
    options?: JobFinderActionFailureReporting,
  ) => Promise<boolean>;
  onOpenProfile: () => void;
  onNavigateSafely: (path: string) => void;
  onProfileSurfaceDirtyChange: (dirty: boolean) => void;
  /**
   * Reports each user-authored Profile or setup draft edit — including edits
   * made while the surface was already dirty, when no dirty transition
   * fires — so the shell's exact-request save retry stays truthful.
   */
  onProfileSurfaceDraftEdited: () => void;
  profileCopilotPendingContextKey: string | null;
  onAssessJobListing: (jobId: string) => Promise<void>;
  onRejectProfileCopilotPatchGroup: (patchGroupId: string) => void;
  onResetBrowser: () => Promise<boolean>;
  onResumeProfileSetup: (step?: ProfileSetupStep) => void;
  onRunAgentDiscovery?: (searchRequest?: JobFinderSearchRequest) => void;
  onRunDiscoveryForTarget?: (targetId: string) => void;
  onSaveSetupStep: (
    profile: CandidateProfile,
    searchPreferences: JobSearchPreferences,
    nextStep: ProfileSetupStep,
    options?: {
      message?: string;
      openProfile?: boolean;
      stayOnCurrentStep?: boolean;
    },
  ) => void;
  onSendProfileCopilotMessage: (
    content: string,
    context?: ProfileCopilotContext,
  ) => void | Promise<boolean>;
  onUndoProfileRevision: (revisionId: string) => void;
  onRunSourceDebug: (
    targetId: string,
    options?: { readabilityTimeoutMs?: number },
  ) => void;
  onSaveAll: (
    profile: CandidateProfile,
    searchPreferences: JobSearchPreferences,
  ) => void;
  onSaveProfile: (profile: CandidateProfile) => void;
  onSaveSearchPreferences: (searchPreferences: JobSearchPreferences) => void;
  onUpdateApplicationDefaults: (
    input: UpdateApplicationDefaultsInput,
  ) => Promise<boolean>;
  onUpdateWorkspaceBehavior: (
    input: UpdateWorkspaceBehaviorInput,
  ) => Promise<boolean>;
  onUpdateAiBehavior: (
    input: UpdateAiBehaviorInput,
    options?: { undo?: () => void },
  ) => Promise<boolean>;
  onUpdateAppearanceTheme: (
    appearanceTheme: AppearanceTheme,
  ) => Promise<boolean>;
  onSaveSourceInstructionArtifact: (
    targetId: string,
    artifact: EditableSourceInstructionArtifact,
  ) => void;
  onSelectDiscoveryJob: (jobId: string) => void;
  onSelectReviewItem: (jobId: string) => void;
  onSetActivityControl: (
    input: SetJobFinderActivityControlInput,
  ) => Promise<boolean>;
  onVerifySourceInstructions: (targetId: string, instructionId: string) => void;
  selectedDiscoveryJob:
    | JobFinderRendererWorkspaceSnapshot["discoveryJobs"][number]
    | null;
  selectedReviewItem:
    | JobFinderRendererWorkspaceSnapshot["reviewQueue"][number]
    | null;
  selectedReviewJob:
    | JobFinderRendererWorkspaceSnapshot["discoveryJobs"][number]
    | null;
  selectedTailoredAsset:
    | JobFinderRendererWorkspaceSnapshot["tailoredAssets"][number]
    | null;
  workspace: JobFinderRendererWorkspaceSnapshot;
}
