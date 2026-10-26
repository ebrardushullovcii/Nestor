import type { AssistantWorkspaceCommands } from "@nestor/job-finder";

export function createAssistantWorkspaceCommands(): AssistantWorkspaceCommands {
  const bind = <K extends keyof AssistantWorkspaceCommands>(
    name: K,
  ): AssistantWorkspaceCommands[K] =>
    ((...args: unknown[]) =>
      import("../job-finder/workspace-service").then(
        async ({ getJobFinderWorkspaceService }) => {
          const service = await getJobFinderWorkspaceService();
          return Reflect.apply(service[name], service, args) as unknown;
        },
      )) as AssistantWorkspaceCommands[K];
  return {
    acceptSourceInstructionDraft: bind("acceptSourceInstructionDraft"),
    analyzeProfileFromResume: bind("analyzeProfileFromResume"),
    applyAssistantProfileOperations: bind("applyAssistantProfileOperations"),
    applyProfileCopilotPatchGroup: bind("applyProfileCopilotPatchGroup"),
    applyProfileSetupReviewAction: bind("applyProfileSetupReviewAction"),
    applyResumeTimelineRepairAction: bind("applyResumeTimelineRepairAction"),
    cancelApplyRun: bind("cancelApplyRun"),
    cancelSourceDebug: bind("cancelSourceDebug"),
    clearApplicationAnswer: bind("clearApplicationAnswer"),
    extractJobsFromPageText: bind("extractJobsFromPageText"),
    getResumeImportState: bind("getResumeImportState"),
    getSourceDebugRun: bind("getSourceDebugRun"),
    getSourceDebugRunDetails: bind("getSourceDebugRunDetails"),
    listSourceDebugRuns: bind("listSourceDebugRuns"),
    queueJobForReview: bind("queueJobForReview"),
    rejectProfileCopilotPatchGroup: bind("rejectProfileCopilotPatchGroup"),
    removeJobFromReview: bind("removeJobFromReview"),
    returnApplicationToShortlist: bind("returnApplicationToShortlist"),
    runSourceDebug: bind("runSourceDebug"),
    saveProfile: bind("saveProfile"),
    saveProfileAndSearchPreferences: bind("saveProfileAndSearchPreferences"),
    saveProfileSetupState: bind("saveProfileSetupState"),
    saveSearchPreferences: bind("saveSearchPreferences"),
    saveSettings: bind("saveSettings"),
    saveSourceInstructionArtifact: bind("saveSourceInstructionArtifact"),
    setActivityControl: bind("setActivityControl"),
    snoozeGroupedDecision: bind("snoozeGroupedDecision"),
    undoAssistantProfileChange: bind("undoAssistantProfileChange"),
    undoAssistantResumeChange: bind("undoAssistantResumeChange"),
    undoAssistantSettingsChange: bind("undoAssistantSettingsChange"),
    undoProfileRevision: bind("undoProfileRevision"),
    undoReturnApplicationToShortlist: bind("undoReturnApplicationToShortlist"),
    updateAiBehavior: bind("updateAiBehavior"),
    updateAppearanceTheme: bind("updateAppearanceTheme"),
    updateApplicationDefaults: bind("updateApplicationDefaults"),
    updateWorkspaceBehavior: bind("updateWorkspaceBehavior"),
    verifySourceInstructions: bind("verifySourceInstructions"),
  };
}
