import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  PROFILE_WORKFLOW_CHANNEL,
  PROFILE_WORKFLOW_CHECK_SITE_CHANNEL,
  PROFILE_WORKFLOW_IMPORT_CHANNEL,
  ProfileWorkflowCheckSiteInputSchema,
  ProfileWorkflowCommandSchema,
  ResumeImportFieldCandidateSummarySchema,
  type JobFinderWorkspaceSnapshot,
  type ProfileWorkflowCommand,
  type ProfileWorkflowResult,
  type ProfileWorkflowState,
} from "@nestor/contracts";
import { getJobStore } from "../services/job-store";

// The old workspace service still runs these steps; it loads on first use,
// not with main.
const requests = () => import("./profile-workflow-requests");
const jobFinder = () => import("../services/job-finder");

async function readState(): Promise<ProfileWorkflowState> {
  const [
    { readPersonalWorkspaceState },
    { createEmptyJobFinderRepositoryState },
    { isDesktopResumeImportActive },
  ] = await Promise.all([
    import("@nestor/db"),
    import("../adapters/job-finder-initial-state"),
    import("../services/job-finder/import-resume"),
  ]);
  const personal = readPersonalWorkspaceState(
    null,
    createEmptyJobFinderRepositoryState(),
    getJobStore(),
  );
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

async function runAction(
  name:
    | "analyze-profile-from-resume"
    | "apply-profile-setup-review-action"
    | "apply-resume-timeline-repair-action"
    | "save-profile-setup-state"
    | "save-source-instruction-artifact",
  input: unknown,
): Promise<unknown> {
  const [{ executeJobFinderAction }, { getJobFinderWorkspaceService }] =
    await Promise.all([import("@nestor/job-finder"), jobFinder()]);
  const service = await getJobFinderWorkspaceService();
  return executeJobFinderAction(name, input, { service });
}

/** What a site check found, in one sentence for the Sources tab. */
export function describeSiteCheck(
  snapshot: Pick<
    JobFinderWorkspaceSnapshot,
    "activeSourceDebugRun" | "recentSourceDebugRuns"
  >,
  targetId: string,
): string {
  const latestRun =
    [snapshot.activeSourceDebugRun, ...snapshot.recentSourceDebugRuns]
      .filter((run) => run?.targetId === targetId)
      .sort((a, b) =>
        (b?.updatedAt ?? "").localeCompare(a?.updatedAt ?? ""),
      )[0] ?? null;
  switch (latestRun?.state) {
    case "idle":
      return "Checking this site now.";
    case "running":
      return "Still checking this site.";
    case "paused_manual":
      return (
        latestRun.manualPrerequisiteSummary ??
        latestRun.finalSummary ??
        "The site check is paused until you finish a step in the browser."
      );
    case "failed":
      return latestRun.finalSummary ?? "The site check failed.";
    case "interrupted":
      return (
        latestRun.finalSummary ??
        "The site check was interrupted before it could finish."
      );
    case "cancelled":
      return (
        latestRun.finalSummary ??
        "The site check was cancelled before it could finish."
      );
    default:
      return (
        latestRun?.finalSummary ??
        "The site check finished without saving reusable guidance."
      );
  }
}

async function runCommand(
  command: ProfileWorkflowCommand,
  event: IpcMainInvokeEvent,
): Promise<ProfileWorkflowResult> {
  const parsed = ProfileWorkflowCommandSchema.parse(command);
  const answer = async (
    snapshot?: JobFinderWorkspaceSnapshot,
  ): Promise<ProfileWorkflowResult> => {
    if (snapshot) {
      const { publishJobFinderWorkspaceUpdate } =
        await import("../services/job-finder/workspace-updates");
      publishJobFinderWorkspaceUpdate(event.sender);
    }
    return {
      state: await readState(),
      message: null,
      ...(snapshot
        ? { siteInstructions: snapshot.sourceInstructionArtifacts }
        : {}),
    };
  };
  switch (parsed.type) {
    case "read":
      return answer();
    case "analyze_resume":
      return answer(
        (await runAction(
          "analyze-profile-from-resume",
          {},
        )) as JobFinderWorkspaceSnapshot,
      );
    case "apply_review_action":
      return answer(
        (await runAction(
          "apply-profile-setup-review-action",
          parsed.input,
        )) as JobFinderWorkspaceSnapshot,
      );
    case "apply_timeline_repair":
      return answer(
        (await runAction(
          "apply-resume-timeline-repair-action",
          parsed.input,
        )) as JobFinderWorkspaceSnapshot,
      );
    case "save_setup_state":
      return answer(
        (await runAction(
          "save-profile-setup-state",
          parsed.state,
        )) as JobFinderWorkspaceSnapshot,
      );
    case "list_site_instructions": {
      const {
        getJobFinderWorkspaceService,
        getJobFinderRepositoryForWorkspaceService,
      } = await jobFinder();
      const repository = getJobFinderRepositoryForWorkspaceService(
        await getJobFinderWorkspaceService(),
      );
      if (!repository)
        throw new Error("Saved site guidance is unavailable right now.");
      return {
        ...(await answer()),
        siteInstructions: await repository.listSourceInstructionArtifacts(),
      };
    }
    case "save_site_instructions":
      return answer(
        (await runAction(
          "save-source-instruction-artifact",
          parsed.input,
        )) as JobFinderWorkspaceSnapshot,
      );
  }
}

/** Profile and guided setup run their steps here, never the old workspace view. */
export function registerProfileWorkflowRoutes(ipcMain: IpcMain): void {
  ipcMain.handle(PROFILE_WORKFLOW_CHANNEL, (event, payload: unknown) =>
    runCommand(payload as ProfileWorkflowCommand, event),
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
      const { checkSiteForRequest } = await requests();
      const snapshot = await checkSiteForRequest(event, {
        targetId: input.targetId,
        requestId: input.requestId,
        readabilityTimeoutMs: null,
      });
      return {
        state: await readState(),
        message: describeSiteCheck(snapshot, input.targetId),
        siteInstructions: snapshot.sourceInstructionArtifacts,
      };
    },
  );
}

/**
 * Main saves a non-ready import as a normal result (the file is kept even
 * when its text or analysis did not finish), so the resume's extraction
 * status decides the sentence; only `ready` claims extracted details.
 */
export function describeResumeImport(
  snapshot: Pick<
    JobFinderWorkspaceSnapshot,
    "profile" | "latestResumeImportRun"
  >,
): string {
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
