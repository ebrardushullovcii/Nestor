import * as C from "@nestor/contracts";
import type { z, ZodTypeAny } from "zod";
import type { JobFinderWorkspaceService } from "../internal/workspace-service-contracts";
import type { AssistantToolGroup } from "./tool-kit";

export type JobFinderActionSafety =
  | "read"
  | "local"
  | "confirm"
  | "application";
export interface JobFinderActionContext {
  service: JobFinderWorkspaceService;
  /** Desktop-owned operations, shared with the existing IPC handlers. */
  host?: (actionId: string, input: unknown) => Promise<unknown>;
}

export interface RegisteredJobFinderAction<R = unknown> {
  input: z.ZodType<unknown>;
  group: AssistantToolGroup;
  safety: JobFinderActionSafety;
  description: string;
  tool?: { name: string; custom?: boolean };
  run(value: unknown, context: JobFinderActionContext): Promise<R>;
}

function action<S extends ZodTypeAny>(
  input: S,
  group: AssistantToolGroup,
  safety: JobFinderActionSafety,
  description: string,
  execute: (
    input: z.output<S>,
    context: JobFinderActionContext,
  ) => Promise<unknown>,
  tool?: { name: string; custom?: boolean },
): RegisteredJobFinderAction {
  return {
    input,
    group,
    safety,
    description,
    ...(tool ? { tool } : {}),
    run: (value: unknown, context: JobFinderActionContext) =>
      execute(input.parse(value) as z.output<S>, context),
  };
}

const empty = C.JobFinderEmptyActionInputSchema;
const job = C.JobFinderJobActionInputSchema;

function desktopAction<S extends ZodTypeAny>(
  id: string,
  input: S,
  group: AssistantToolGroup,
  safety: JobFinderActionSafety,
  description: string,
  tool?: { name: string; custom?: boolean },
) {
  return action(
    input,
    group,
    safety,
    description,
    async (value, context) => {
      if (!context.host) throw new Error("That desktop action is unavailable.");
      return context.host(id, value);
    },
    tool,
  );
}

/**
 * A user action has one input contract, safety class and executor. Desktop
 * routes and assistant tools call these executors. Existing conversational
 * tools are retained where they add grants, Undo or multi-job orchestration;
 * `assistantTool` binds them instead of exposing a second, weaker path.
 */
export const JOB_FINDER_ACTIONS = {
  "get-application-authority-readiness": desktopAction(
    "get-application-authority-readiness",
    C.GetApplicationAuthorityReadinessInputSchema,
    "applications",
    "read",
    "Read what the saved sending policy currently allows.",
  ),
  "list-application-authority-envelopes": desktopAction(
    "list-application-authority-envelopes",
    C.ListApplicationAuthorityEnvelopesInputSchema,
    "applications",
    "read",
    "List saved application permission envelopes.",
  ),
  "get-application-authority-envelope": desktopAction(
    "get-application-authority-envelope",
    C.GetApplicationAuthorityEnvelopeInputSchema,
    "applications",
    "read",
    "Read an exact application permission envelope.",
  ),
  "approve-current-application-answers": desktopAction(
    "approve-current-application-answers",
    C.ApproveCurrentApplicationAnswersInputSchema,
    "applications",
    "confirm",
    "Confirm the person's current saved application answers at their exact profile revision.",
  ),
  "create-application-authority-envelope": desktopAction(
    "create-application-authority-envelope",
    C.CreateApplicationAuthorityEnvelopeInputSchema,
    "applications",
    "confirm",
    "Create a scoped application permission under the existing authority editor's rules.",
  ),
  "update-application-authority-envelope": desktopAction(
    "update-application-authority-envelope",
    C.UpdateApplicationAuthorityEnvelopeInputSchema,
    "applications",
    "confirm",
    "Update an exact application permission revision under the existing authority editor's rules.",
  ),
  "revoke-application-authority-envelope": desktopAction(
    "revoke-application-authority-envelope",
    C.RevokeApplicationAuthorityEnvelopeInputSchema,
    "applications",
    "confirm",
    "Revoke a saved application permission.",
  ),
  "resolve-submission-outcome": desktopAction(
    "resolve-submission-outcome",
    C.ResolveSubmissionOutcomeInputSchema,
    "applications",
    "confirm",
    "Record a send outcome only after the person checks the employer's site; does not send or retry.",
  ),
  "get-startup-reset-recovery": desktopAction(
    "get-startup-reset-recovery",
    empty,
    "settings",
    "read",
    "Read reset recovery status.",
  ),
  "get-startup-database-recovery": desktopAction(
    "get-startup-database-recovery",
    empty,
    "settings",
    "read",
    "Read database recovery status.",
  ),
  "dismiss-startup-database-recovery-notice": desktopAction(
    "dismiss-startup-database-recovery-notice",
    empty,
    "settings",
    "local",
    "Dismiss the database recovery notice.",
  ),
  zoom: desktopAction(
    "zoom",
    C.JobFinderZoomInputSchema,
    "settings",
    "local",
    "Make text larger, smaller or restore actual size using the View menu's zoom command.",
  ),
  "get-job-detail": desktopAction(
    "get-job-detail",
    C.JobFinderJobDetailQuerySchema,
    "jobs",
    "read",
    "Read one complete saved job and its fit assessment.",
    { name: "get_job", custom: true },
  ),
  "get-tailored-asset": desktopAction(
    "get-tailored-asset",
    C.JobFinderTailoredAssetQuerySchema,
    "resume",
    "read",
    "Read one complete tailored resume asset.",
  ),
  "run-discovery": action(
    empty,
    "jobs",
    "local",
    "Search now.",
    (_i, c) => c.service.runDiscovery(),
    { name: "search_for_jobs", custom: true },
  ),
  "run-agent-discovery": action(
    C.JobFinderAgentDiscoveryActionInputSchema,
    "jobs",
    "local",
    "Search all or selected sources with a plain-language goal.",
    (i, c) =>
      c.service.runAgentDiscovery(
        undefined,
        undefined,
        i.targetId ?? undefined,
        i.searchRequest,
      ),
    { name: "search_for_jobs", custom: true },
  ),
  "run-source-debug": action(
    C.JobFinderSourceDebugActionInputSchema,
    "jobs",
    "local",
    "Check how to read a job source.",
    (i, c) => c.service.runSourceDebug(i.targetId),
    { name: "check_source", custom: true },
  ),
  "generate-resume": action(
    job,
    "resume",
    "local",
    "Generate a job's resume at its selected level.",
    (i, c) => c.service.generateResume(i.jobId),
    { name: "generate_resumes", custom: true },
  ),
  "regenerate-resume-draft": action(
    job,
    "resume",
    "local",
    "Rewrite a complete resume draft.",
    (i, c) => c.service.regenerateResumeDraft(i.jobId),
    { name: "generate_resumes", custom: true },
  ),
  "preview-resume-draft": action(
    C.JobFinderPreviewResumeDraftInputSchema,
    "resume",
    "read",
    "Preview a resume's layout and page count.",
    (i, c) => c.service.previewResumeDraft(i.draft),
    { name: "preview_resume", custom: true },
  ),
  "export-resume-pdf": action(
    C.JobFinderExportResumePdfInputSchema,
    "resume",
    "local",
    "Export a resume PDF.",
    (i, c) => c.service.exportResumePdf(i.jobId),
    { name: "export_resume", custom: true },
  ),
  "reset-workspace": desktopAction(
    "reset-workspace",
    empty,
    "settings",
    "confirm",
    "Delete the local profile, jobs, resumes, application history, chats and browser session. This cannot be undone.",
  ),
  "preview-personal-workspace-restore": desktopAction(
    "preview-personal-workspace-restore",
    empty,
    "files",
    "local",
    "Choose a workspace export and preview what restoring it would replace.",
  ),
  "confirm-personal-workspace-restore": desktopAction(
    "confirm-personal-workspace-restore",
    C.ConfirmPersonalWorkspaceRestoreSchema,
    "files",
    "confirm",
    "Replace this workspace with the chosen export, keeping a safety export first.",
  ),
  "export-personal-workspace": desktopAction(
    "export-personal-workspace",
    empty,
    "files",
    "local",
    "Save the complete local workspace, documents and chats to a private export file.",
  ),
  "export-diagnostics": desktopAction(
    "export-diagnostics",
    empty,
    "files",
    "local",
    "Save diagnostics to a file.",
  ),
  "get-performance-snapshot": desktopAction(
    "get-performance-snapshot",
    empty,
    "settings",
    "read",
    "Read app performance diagnostics.",
  ),
  "reset-browser": desktopAction(
    "reset-browser",
    empty,
    "settings",
    "confirm",
    "Close and reset the Job Finder browser session; kept forms may need reopening.",
  ),
  "write-clipboard-text": desktopAction(
    "write-clipboard-text",
    C.WriteClipboardTextInputSchema,
    "workspace",
    "local",
    "Copy text to the clipboard.",
  ),
  "reveal-saved-file": desktopAction(
    "reveal-saved-file",
    C.RevealSavedFileInputSchema,
    "files",
    "local",
    "Reveal an exported file in the file manager.",
  ),
  "read-action-state": action(
    C.JobFinderReadActionStateInputSchema,
    "workspace",
    "read",
    "Read search rules, notifications, the Apply queue or tracker settings.",
    async (i, c) => {
      const snapshot = await (c.service.getWorkspaceProjection?.() ??
        c.service.getWorkspaceSnapshot());
      if (i.scope === "apply_queue") return snapshot.applyQueue;
      if (i.scope === "tracker_settings")
        return snapshot.settings.applicationCrm;
      const values: readonly unknown[] =
        i.scope === "notifications" ? snapshot.campaignNotifications : [];
      const filtered = i.id
        ? values.filter(
            (v) => v && typeof v === "object" && "id" in v && v.id === i.id,
          )
        : values;
      return {
        total: filtered.length,
        rows: filtered.slice(i.cursor, i.cursor + i.limit),
        next: i.cursor + i.limit < filtered.length ? i.cursor + i.limit : null,
      };
    },
  ),
  "candidate-assets:import": desktopAction(
    "candidate-assets:import",
    C.CandidateAssetImportInputSchema,
    "files",
    "local",
    "Import a file into the library; opens the native chooser for the person to select the file.",
  ),
  "candidate-assets:open": desktopAction(
    "candidate-assets:open",
    C.CandidateAssetOpenInputSchema,
    "files",
    "local",
    "Open a read-only copy of a saved file.",
  ),
  "candidate-assets:list": desktopAction(
    "candidate-assets:list",
    C.CandidateAssetListInputSchema,
    "files",
    "read",
    "List files, optionally including deleted files that can be restored.",
  ),
  "candidate-assets:delete": desktopAction(
    "candidate-assets:delete",
    C.CandidateAssetDeleteInputSchema,
    "files",
    "confirm",
    "Delete a library file; it remains restorable.",
  ),
  "candidate-assets:restore": desktopAction(
    "candidate-assets:restore",
    C.CandidateAssetRestoreInputSchema,
    "files",
    "local",
    "Restore a deleted library file and continue applications waiting for it.",
  ),
  "save-profile": action(
    C.CandidateProfileSchema,
    "profile",
    "confirm",
    "Save the complete profile.",
    (i, c) => c.service.saveProfile(i),
    { name: "edit_profile", custom: true },
  ),
  "save-workspace-inputs": action(
    C.SaveJobFinderWorkspaceInputSchema,
    "profile",
    "confirm",
    "Save profile and search preferences together.",
    async (i, c) => {
      let result = await c.service.saveProfileAndSearchPreferences(
        i.profile,
        i.searchPreferences,
      );
      if (i.settings) result = await c.service.saveSettings(i.settings);
      return result;
    },
    { name: "edit_profile", custom: true },
  ),
  "save-search-preferences": action(
    C.JobSearchPreferencesSchema,
    "profile",
    "confirm",
    "Save all search preferences and sources.",
    (i, c) => c.service.saveSearchPreferences(i),
    { name: "edit_profile", custom: true },
  ),
  "analyze-profile-from-resume": action(
    empty,
    "profile",
    "local",
    "Analyze the imported resume again.",
    (_i, c) => c.service.analyzeProfileFromResume(),
  ),
  "save-profile-setup-state": action(
    C.ProfileSetupStateSchema,
    "profile",
    "local",
    "Save guided setup progress.",
    (i, c) => c.service.saveProfileSetupState(i),
    { name: "finish_profile_setup", custom: true },
  ),
  "apply-profile-setup-review-action": action(
    C.JobFinderProfileSetupReviewActionInputSchema,
    "profile",
    "local",
    "Keep or dismiss an import suggestion.",
    (i, c) =>
      c.service.applyProfileSetupReviewAction(
        i.reviewItemId,
        i.action,
        i.options,
      ),
    { name: "resolve_import_suggestion", custom: true },
  ),
  "apply-resume-timeline-repair-action": action(
    C.JobFinderResumeTimelineRepairActionInputSchema,
    "profile",
    "local",
    "Accept or undo a work-history date repair.",
    (i, c) =>
      c.service.applyResumeTimelineRepairAction(
        i.runId,
        i.proposalId,
        i.action,
      ),
  ),
  "undo-profile-revision": action(
    C.JobFinderUndoProfileRevisionInputSchema,
    "profile",
    "confirm",
    "Restore a saved profile revision.",
    (i, c) => c.service.undoProfileRevision(i.revisionId),
  ),
  "save-settings": action(
    C.JobFinderSettingsSchema,
    "settings",
    "confirm",
    "Replace all saved settings.",
    (i, c) => c.service.saveSettings(i),
    { name: "update_apply_settings", custom: true },
  ),
  "update-application-defaults": action(
    C.UpdateApplicationDefaultsInputSchema,
    "settings",
    "confirm",
    "Change apply mode and resume defaults.",
    (i, c) => c.service.updateApplicationDefaults(i),
    { name: "update_apply_settings", custom: true },
  ),
  "update-workspace-behavior": action(
    C.UpdateWorkspaceBehaviorInputSchema,
    "settings",
    "local",
    "Change session and workspace behavior.",
    (i, c) => c.service.updateWorkspaceBehavior(i),
    { name: "update_workspace_behavior", custom: true },
  ),
  "update-ai-behavior": action(
    C.UpdateAiBehaviorInputSchema,
    "settings",
    "local",
    "Change AI behavior and the default resume approach.",
    (i, c) => c.service.updateAiBehavior(i),
    { name: "update_ai_behavior", custom: true },
  ),
  "update-appearance-theme": action(
    C.JobFinderThemeActionInputSchema,
    "settings",
    "local",
    "Change the appearance theme.",
    (i, c) => c.service.updateAppearanceTheme(i.appearanceTheme),
    { name: "set_appearance", custom: true },
  ),
  "set-activity-control": action(
    C.SetJobFinderActivityControlInputSchema,
    "settings",
    "local",
    "Pause or continue background work.",
    (i, c) => c.service.setActivityControl(i),
    { name: "pause_activity", custom: true },
  ),
  "cancel-discovery-run": action(
    C.JobFinderDiscoveryCancellationInputSchema,
    "jobs",
    "local",
    "Stop a search.",
    (i, c) => c.service.cancelDiscoveryRun(i.runId),
    { name: "cancel_search" },
  ),
  "judge-unjudged-jobs": action(
    empty,
    "jobs",
    "local",
    "Judge fit for jobs without a current verdict.",
    (_i, c) => c.service.judgeUnjudgedJobs(),
  ),
  "cancel-source-debug": action(
    C.JobFinderSourceDebugRunQuerySchema,
    "jobs",
    "local",
    "Stop a source check.",
    (i, c) => c.service.cancelSourceDebug(i.runId),
  ),
  "get-source-debug-run": action(
    C.JobFinderSourceDebugRunQuerySchema,
    "jobs",
    "read",
    "Read a source check's status.",
    (i, c) => c.service.getSourceDebugRun(i.runId),
  ),
  "get-source-debug-run-details": action(
    C.JobFinderSourceDebugRunQuerySchema,
    "jobs",
    "read",
    "Read a source check's findings and learned instructions.",
    (i, c) => c.service.getSourceDebugRunDetails(i.runId),
  ),
  "list-source-debug-runs": action(
    C.JobFinderSourceDebugActionInputSchema,
    "jobs",
    "read",
    "List checks of a source.",
    (i, c) => c.service.listSourceDebugRuns(i.targetId),
  ),
  "save-source-instruction-artifact": action(
    C.JobFinderSaveSourceInstructionInputSchema,
    "jobs",
    "local",
    "Edit a source's saved reading instructions.",
    (i, c) => c.service.saveSourceInstructionArtifact(i.targetId, i.artifact),
  ),
  "accept-source-instruction-draft": action(
    C.JobFinderSourceInstructionActionInputSchema,
    "jobs",
    "local",
    "Accept learned instructions for a source.",
    (i, c) =>
      c.service.acceptSourceInstructionDraft(i.targetId, i.instructionId),
  ),
  "verify-source-instructions": action(
    C.JobFinderSourceInstructionActionInputSchema,
    "jobs",
    "local",
    "Verify a source's reading instructions.",
    (i, c) => c.service.verifySourceInstructions(i.targetId, i.instructionId),
  ),
  "queue-job-for-review": action(
    job,
    "jobs",
    "local",
    "Shortlist a job.",
    (i, c) => c.service.queueJobForReview(i.jobId),
    { name: "shortlist_jobs", custom: true },
  ),
  "remove-job-from-review": action(
    job,
    "jobs",
    "local",
    "Move a shortlisted job back to Find jobs.",
    (i, c) => c.service.removeJobFromReview(i.jobId),
    { name: "remove_from_shortlist", custom: true },
  ),
  "set-job-resume-application-mode": action(
    C.JobFinderJobResumeApplicationModeInputSchema,
    "resume",
    "local",
    "Choose a job's resume level.",
    (i, c) =>
      c.service.setJobResumeApplicationMode(
        i.jobId,
        i.resumeApplicationMode,
        i.resumeTailoringMode,
      ),
    { name: "set_resume_level", custom: true },
  ),
  "dismiss-discovery-job": action(
    C.JobFinderDismissDiscoveryJobInputSchema,
    "jobs",
    "local",
    "Hide a found job.",
    (i, c) => c.service.dismissDiscoveryJob(i),
    { name: "dismiss_jobs", custom: true },
  ),
  "restore-dismissed-discovery-job": action(
    job,
    "jobs",
    "local",
    "Show a hidden job again.",
    (i, c) => c.service.restoreDismissedDiscoveryJob(i.jobId),
    { name: "restore_jobs", custom: true },
  ),
  "preview-employer-exclusion": action(
    job,
    "jobs",
    "read",
    "Preview an employer exclusion.",
    (i, c) => c.service.previewEmployerExclusion(i.jobId),
    { name: "exclude_employer", custom: true },
  ),
  "remove-employer-exclusion": action(
    C.RemoveEmployerExclusionInputSchema,
    "jobs",
    "local",
    "Include a previously excluded employer.",
    (i, c) => c.service.removeEmployerExclusion(i),
    { name: "include_employer", custom: true },
  ),
  "get-resume-workspace": action(
    C.JobFinderResumeWorkspaceQuerySchema,
    "resume",
    "read",
    "Read a job's resume and version history.",
    (i, c) => c.service.getResumeWorkspace(i.jobId),
    { name: "read_resume", custom: true },
  ),
  "save-resume-draft": action(
    C.JobFinderSaveResumeDraftInputSchema,
    "resume",
    "confirm",
    "Save a complete resume draft.",
    (i, c) => c.service.saveResumeDraft(i.draft, i.autosaveSessionId),
    { name: "edit_resume", custom: true },
  ),
  "restore-resume-draft-revision": action(
    C.JobFinderRestoreResumeDraftRevisionInputSchema,
    "resume",
    "local",
    "Restore a saved resume version.",
    (i, c) => c.service.restoreResumeDraftRevision(i.jobId, i.revisionId),
    { name: "restore_resume_version" },
  ),
  "undo-resume-assistant-edit": action(
    C.JobFinderRestoreResumeDraftRevisionInputSchema,
    "resume",
    "local",
    "Undo one assistant edit, preserving later manual edits.",
    (i, c) => c.service.undoResumeAssistantEdit(i.jobId, i.revisionId),
    { name: "undo_change", custom: true },
  ),
  "regenerate-resume-section": action(
    C.JobFinderResumeSectionActionInputSchema,
    "resume",
    "confirm",
    "Rewrite one resume section.",
    (i, c) => c.service.regenerateResumeSection(i.jobId, i.sectionId),
  ),
  "approve-resume": action(
    C.JobFinderApproveResumeInputSchema,
    "resume",
    "local",
    "Approve the exact exported resume.",
    (i, c) => c.service.approveResume(i.jobId, i.exportId),
  ),
  "clear-resume-approval": action(
    C.JobFinderClearResumeApprovalInputSchema,
    "resume",
    "local",
    "Move a resume back to draft review.",
    // Undo of an approval puts back the status it replaced.
    (i, c) =>
      i.restoreStatus
        ? c.service.clearResumeApproval(i.jobId, {
            restoreStatus: i.restoreStatus,
          })
        : c.service.clearResumeApproval(i.jobId),
  ),
  "set-work-history-review-acknowledgment": action(
    C.JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema,
    "resume",
    "confirm",
    "Keep or remove a work-history review acknowledgment.",
    (i, c) => c.service.setWorkHistoryReviewAcknowledgment(i),
  ),
  "set-resume-claim-confirmation": action(
    C.JobFinderSetResumeClaimConfirmationInputSchema,
    "resume",
    "confirm",
    "Confirm or remove a specific resume claim.",
    (i, c) => c.service.setResumeClaimConfirmation(i),
    { name: "confirm_resume_line", custom: true },
  ),
  "apply-resume-patch": action(
    C.JobFinderApplyResumePatchInputSchema,
    "resume",
    "local",
    "Edit one resume section, entry or bullet.",
    (i, c) => c.service.applyResumePatch(i.patch, i.revisionReason),
    { name: "edit_resume", custom: true },
  ),
  "clear-application-answer": action(
    C.ClearApplicationAnswerCommandSchema,
    "applications",
    "confirm",
    "Clear a saved application answer.",
    (i, c) => c.service.clearApplicationAnswer(i),
  ),
  "snooze-grouped-decision": action(
    C.SnoozeGroupedDecisionInputSchema,
    "applications",
    "local",
    "Snooze a grouped Needs you decision.",
    (i, c) => c.service.snoozeGroupedDecision(i),
  ),
  "return-application-to-shortlist": action(
    C.JobFinderReturnApplicationToShortlistInputSchema,
    "applications",
    "local",
    "Move an unsent application back to Shortlisted, retaining its history.",
    (i, c) => c.service.returnApplicationToShortlist(i.applicationRecordId),
  ),
  "undo-return-application-to-shortlist": action(
    job,
    "applications",
    "local",
    "Undo moving an application back to Shortlisted.",
    (i, c) => c.service.undoReturnApplicationToShortlist(i.jobId),
  ),
} as const;

export type JobFinderActionId = keyof typeof JOB_FINDER_ACTIONS;

export function executeJobFinderAction<N extends JobFinderActionId>(
  name: N,
  input: unknown,
  context: JobFinderActionContext,
): ReturnType<(typeof JOB_FINDER_ACTIONS)[N]["run"]> {
  return JOB_FINDER_ACTIONS[name].run(input, context) as ReturnType<
    (typeof JOB_FINDER_ACTIONS)[N]["run"]
  >;
}

export function jobFinderActionToolName(id: string): string {
  return `action_${id.replaceAll(/[:-]/gu, "_")}`;
}
