import type { IpcMain } from "electron";
import {
  PROFILE_WORKFLOW_CHANNEL,
  PROFILE_WORKFLOW_CHECK_SITE_CHANNEL,
  PROFILE_WORKFLOW_IMPORT_CHANNEL,
  ProfileWorkflowCheckSiteInputSchema,
  ProfileWorkflowCommandSchema,
  ResumeImportFieldCandidateSummarySchema,
  type CandidateProfile,
  type ProfileWorkflowCommand,
  type ProfileWorkflowResult,
  type ProfileWorkflowState,
  type ResumeImportRun,
  type SourceDebugRunRecord,
} from "@nestor/contracts";
import { getJobStore } from "../services/job-store";

// Profile work loads on first use, not with main.
const requests = () => import("./profile-workflow-requests");
const runtime = () => import("../services/job-finder/runtime");

async function readState(): Promise<ProfileWorkflowState> {
  const [{ readPersonalWorkspaceState }, { isDesktopResumeImportActive }] =
    await Promise.all([
      import("@nestor/db"),
      import("../services/job-finder/import-resume"),
    ]);
  const personal = readPersonalWorkspaceState(getJobStore());
  return {
    profileSetupState: personal.profileSetupState,
    latestResumeImportRun: personal.latestResumeImportRun,
    latestResumeImportReviewCandidates:
      personal.latestResumeImportReviewCandidates.map((candidate) =>
        ResumeImportFieldCandidateSummarySchema.parse(candidate),
      ),
    resumeImportActive: isDesktopResumeImportActive(),
  };
}

/** What a site check found, in one sentence for the Sources tab. */
export function describeSiteCheck(run: SourceDebugRunRecord | null): string {
  switch (run?.state) {
    case "idle":
      return "Checking this site now.";
    case "running":
      return "Still checking this site.";
    case "paused_manual":
      return (
        run.manualPrerequisiteSummary ??
        run.finalSummary ??
        "The site check is paused until you finish a step in the browser."
      );
    case "failed":
      return run.finalSummary ?? "The site check failed.";
    case "interrupted":
      return (
        run.finalSummary ??
        "The site check was interrupted before it could finish."
      );
    case "cancelled":
      return (
        run.finalSummary ??
        "The site check was cancelled before it could finish."
      );
    default:
      return (
        run?.finalSummary ??
        "The site check finished without saving reusable guidance."
      );
  }
}

async function runCommand(
  command: ProfileWorkflowCommand,
): Promise<ProfileWorkflowResult> {
  const parsed = ProfileWorkflowCommandSchema.parse(command);
  if (parsed.type === "read")
    return { state: await readState(), message: null };
  const { startJobFinderRuntime } = await runtime();
  const { profileService: service, repository } = await startJobFinderRuntime();
  const answer = async (
    withInstructions = false,
  ): Promise<ProfileWorkflowResult> => {
    const { notifyJobFinderChange } =
      await import("../services/job-finder/changes");
    notifyJobFinderChange();
    return {
      state: await readState(),
      message: null,
      ...(withInstructions
        ? {
            siteInstructions: await repository.listSourceInstructionArtifacts(),
          }
        : {}),
    };
  };
  switch (parsed.type) {
    case "analyze_resume":
      await service.analyzeProfileFromResume();
      return answer();
    case "apply_review_action":
      await service.applyProfileSetupReviewAction(
        parsed.input.reviewItemId,
        parsed.input.action,
        parsed.input.options,
      );
      return answer();
    case "apply_timeline_repair":
      await service.applyResumeTimelineRepairAction(
        parsed.input.runId,
        parsed.input.proposalId,
        parsed.input.action,
      );
      return answer();
    case "save_setup_state":
      await service.saveProfileSetupState(parsed.state);
      return answer();
    case "list_site_instructions":
      return answer(true);
    case "save_site_instructions":
      await service.saveSourceInstructionArtifact(
        parsed.input.targetId,
        parsed.input.artifact,
      );
      return answer(true);
  }
}

/** Profile and guided setup run their steps here. */
export function registerProfileWorkflowRoutes(ipcMain: IpcMain): void {
  ipcMain.handle(PROFILE_WORKFLOW_CHANNEL, (_event, payload: unknown) =>
    runCommand(payload as ProfileWorkflowCommand),
  );
  ipcMain.handle(
    PROFILE_WORKFLOW_IMPORT_CHANNEL,
    async (event, payload: unknown): Promise<ProfileWorkflowResult> => {
      const before = await readState();
      const { importResumeForRequest } = await requests();
      const imported = await importResumeForRequest(
        ipcMain,
        event,
        payload,
        () => Promise.resolve(before.latestResumeImportRun),
      );
      return {
        state: await readState(),
        message: imported
          ? describeResumeImport(imported)
          : "No resume selected. Your profile was not changed.",
      };
    },
  );
  ipcMain.handle(
    PROFILE_WORKFLOW_CHECK_SITE_CHANNEL,
    async (event, payload: unknown): Promise<ProfileWorkflowResult> => {
      const input = ProfileWorkflowCheckSiteInputSchema.parse(payload);
      const [{ checkSiteForRequest }, { startJobFinderRuntime }] =
        await Promise.all([requests(), runtime()]);
      const run = await checkSiteForRequest(event, {
        targetId: input.targetId,
        requestId: input.requestId,
      });
      const { repository } = await startJobFinderRuntime();
      return {
        state: await readState(),
        message: describeSiteCheck(run),
        siteInstructions: await repository.listSourceInstructionArtifacts(),
      };
    },
  );
}

/**
 * Main saves a non-ready import as a normal result (the file is kept even
 * when its text or analysis did not finish), so the resume's extraction
 * status decides the sentence; only `ready` claims extracted details.
 */
export function describeResumeImport(snapshot: {
  profile: CandidateProfile;
  latestResumeImportRun: ResumeImportRun | null;
}): string {
  const { fileName, extractionStatus } = snapshot.profile.baseResume;
  switch (extractionStatus) {
    case "ready":
      return `${fileName} was imported. Review the extracted details before approving them.`;
    case "needs_text":
      return `${fileName} was saved, but no text could be read from it, so no details were extracted. Try another file, or add your details manually in Profile.`;
    case "failed":
      return (
        snapshot.latestResumeImportRun?.errorMessage ??
        `${fileName} was saved, but extracting its details failed. Try importing it again, or add your details manually in Profile.`
      );
    case "not_started":
      return `${fileName} was saved, but its details have not been extracted yet. Open Profile and refresh from the saved resume.`;
  }
}
