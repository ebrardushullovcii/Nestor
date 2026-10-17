import type {
  JobFinderResumePreview,
  JobFinderResumeWorkspace,
  JobFinderSetResumeClaimConfirmationInput,
  JobFinderRendererWorkspaceSnapshot,
  ResumeAssistantMessage,
  ResumeDraft,
  ResumeSourceDocument,
  ResumeDraftPatch,
  ResumeTemplateDefinition,
} from "@nordri/contracts";
import type { ResumeWorkHistoryDecisionRequest } from "./resume-workspace-work-history-decisions";

export interface ResumeWorkspaceScreenProps {
  actionMessage: string | null;
  /** The file the action message names, when an export just wrote one. */
  actionSavedFilePath?: string | null;
  onRevealSavedFile?: (path: string) => void;
  jobId: string;
  isWorkspacePending: boolean;
  /** Native PDF export is pending without invalidating a ready workspace. */
  isExportPending?: boolean;
  /** An application run is starting; the Apply button shows it. */
  isApplyPending?: boolean;
  workspace: JobFinderResumeWorkspace | null;
  availableResumeTemplates: readonly ResumeTemplateDefinition[];
  assistantMessages: readonly ResumeAssistantMessage[];
  assistantPending: boolean;
  onBack: () => void;
  /** Starts the existing prepare-only application flow for this job. */
  onPrepareApplication?: () => void;
  onRefresh: () => void;
  onDirtyChange: (dirty: boolean) => void;
  /**
   * Reports each user-authored draft edit — including edits made while the
   * studio was already dirty, when no dirty transition fires — so the shell
   * can retire an exact-request save retry captured before the edit.
   */
  onDraftEdited?: () => void;
  onPreviewDraft: (
    draft: ResumeDraft,
    requestId?: string,
  ) => Promise<JobFinderResumePreview>;
  onSaveDraft: (
    draft: ResumeDraft,
    onSaved?: (updatedAt: string) => void,
  ) => void;
  onSaveDraftAndThen: (
    draft: ResumeDraft,
    next: () => void | Promise<void>,
    successMessage?: string | null,
    onSaved?: (updatedAt: string) => void,
  ) => void;
  onExportPdf: (jobId: string) => void;
  /** Records that the imported resume is this person's own document. */
  onClaimResumeIdentity?: () => void;
  /** Creates a private application PDF and approves its exact verified bytes. */
  onApproveCurrentResume: (jobId: string) => void;
  onApproveResume: (jobId: string, exportId: string) => void;
  onClearResumeApproval: (jobId: string) => void;
  onSetWorkHistoryReviewAcknowledgment: (
    jobId: string,
    decision: ResumeWorkHistoryDecisionRequest,
  ) => void;
  /**
   * Optional until the Resume Studio claim-confirmation control lands; when
   * present it resolves with the committed workspace snapshot.
   */
  onSetResumeClaimConfirmation?: (
    input: JobFinderSetResumeClaimConfirmationInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  onRegenerateDraft: (jobId: string) => void;
  onRestoreRevision: (jobId: string, revisionId: string) => void;
  /** Removes one accepted AI edit and keeps later edits. */
  onUndoAiEdit: (jobId: string, revisionId: string) => void;
  /**
   * Set when the job sends the imported file unchanged. The studio says the
   * draft is not used and offers one press that writes an editable resume at
   * the saved level, then sends the Assistant request it could not act on.
   */
  originalResumeRoute?: {
    source?: ResumeSourceDocument;
    levelLabel: string;
    onWriteEditableResume: (
      jobId: string,
      pendingRequest: string | null,
    ) => void;
  } | null;
  onApplyPatch: (
    patch: ResumeDraftPatch,
    revisionReason?: string | null,
  ) => void;
  onSendAssistantMessage: (jobId: string, content: string) => void;
  onResolveAssistantProposal?: (
    jobId: string,
    proposalId: string,
    action: "accept" | "reject",
    patchIds: readonly string[],
  ) => void;
}
