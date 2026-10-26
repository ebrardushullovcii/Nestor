import type { AssistantWorkspaceCommands } from "@nestor/job-finder";

export function createAssistantWorkspaceCommands(): AssistantWorkspaceCommands {
  const bind = <K extends keyof AssistantWorkspaceCommands>(
    name: K,
  ): AssistantWorkspaceCommands[K] =>
    ((...args: unknown[]) =>
      import("../job-finder/runtime").then(async ({ getProfileService }) => {
        const service = await getProfileService();
        return Reflect.apply(service[name], service, args) as unknown;
      })) as AssistantWorkspaceCommands[K];
  return {
    acceptSourceInstructionDraft: bind("acceptSourceInstructionDraft"),
    analyzeProfileFromResume: bind("analyzeProfileFromResume"),
    applyAssistantProfileOperations: bind("applyAssistantProfileOperations"),
    applyProfileCopilotPatchGroup: bind("applyProfileCopilotPatchGroup"),
    applyProfileSetupReviewAction: bind("applyProfileSetupReviewAction"),
    applyResumeTimelineRepairAction: bind("applyResumeTimelineRepairAction"),
    cancelSourceDebug: bind("cancelSourceDebug"),
    extractJobsFromPageText: bind("extractJobsFromPageText"),
    getResumeImportState: bind("getResumeImportState"),
    getSourceDebugRun: bind("getSourceDebugRun"),
    getSourceDebugRunDetails: bind("getSourceDebugRunDetails"),
    listSourceDebugRuns: bind("listSourceDebugRuns"),
    rejectProfileCopilotPatchGroup: bind("rejectProfileCopilotPatchGroup"),
    runSourceDebug: bind("runSourceDebug"),
    saveProfile: bind("saveProfile"),
    saveProfileAndSearchPreferences: bind("saveProfileAndSearchPreferences"),
    saveProfileSetupState: bind("saveProfileSetupState"),
    saveSearchPreferences: bind("saveSearchPreferences"),
    saveSettings: bind("saveSettings"),
    saveSourceInstructionArtifact: bind("saveSourceInstructionArtifact"),
    setActivityControl: bind("setActivityControl"),
    undoAssistantProfileChange: bind("undoAssistantProfileChange"),
    undoAssistantSettingsChange: bind("undoAssistantSettingsChange"),
    undoProfileRevision: bind("undoProfileRevision"),
    updateAiBehavior: bind("updateAiBehavior"),
    updateAppearanceTheme: bind("updateAppearanceTheme"),
    updateApplicationDefaults: bind("updateApplicationDefaults"),
    updateWorkspaceBehavior: bind("updateWorkspaceBehavior"),
    verifySourceInstructions: bind("verifySourceInstructions"),
  };
}
