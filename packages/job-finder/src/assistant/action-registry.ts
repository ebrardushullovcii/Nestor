import * as C from "@nestor/contracts";
import type { z, ZodTypeAny } from "zod";
import type { AssistantWorkspaceCommands } from "./workspace-commands";
import type { AssistantToolGroup } from "./tool-kit";

export type JobFinderActionSafety =
  | "read"
  | "local"
  | "confirm"
  | "application";
export interface JobFinderActionContext {
  service: AssistantWorkspaceCommands;
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
  "get-home-summary": desktopAction(
    "get-home-summary",
    C.HomeSummaryInputSchema,
    "workspace",
    "read",
    "Read the actual Home dashboard: totals, dated sent/replies chart, weekly changes, response rate, interviews and reminders. Supply the person's UTC offset in minutes.",
    { name: "get_home_summary" },
  ),
  "get-activity": desktopAction(
    "get-activity",
    empty,
    "workspace",
    "read",
    "Read the complete Activity feed, including running work, progress and finished or failed tasks. Does not clear or change activity.",
    { name: "get_activity" },
  ),
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
  zoom: desktopAction(
    "zoom",
    C.JobFinderZoomInputSchema,
    "settings",
    "local",
    "Make text larger, smaller or restore actual size using the View menu's zoom command.",
  ),
  "run-source-debug": action(
    C.JobFinderSourceDebugActionInputSchema,
    "jobs",
    "local",
    "Check how to read a job source.",
    (i, c) => c.service.runSourceDebug(i.targetId),
    { name: "check_source", custom: true },
  ),

  "reset-workspace": desktopAction(
    "reset-workspace",
    empty,
    "settings",
    "confirm",
    "Delete the local profile, jobs, resumes, application history, chats and browser session. This cannot be undone.",
  ),
  "export-diagnostics": desktopAction(
    "export-diagnostics",
    empty,
    "files",
    "local",
    "Save diagnostics to a file.",
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
