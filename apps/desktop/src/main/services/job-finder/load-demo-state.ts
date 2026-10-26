import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { JobFinderWorkspaceSnapshotSchema } from "@nestor/contracts";
import {
  createApplyQueueDemoState,
  createAgentOwnedBrowserDriveState,
  createWorkHistoryReviewDriveState,
} from "../../adapters/job-finder-demo-state";
import {
  JOB_FINDER_DEMO_EXPORT_RESUME_CONTENT,
  JOB_FINDER_DEMO_SOURCE_RESUME_CONTENT,
} from "../../adapters/job-finder-demo-resume-files";
import { getJobFinderWorkspaceService } from "./workspace-service";
import { lowerPauseAfterReset } from "./reset-workspace";

async function writeDemoFile(
  filePath: string | null | undefined,
  content: string,
) {
  if (!filePath) {
    return;
  }

  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  await writeFile(filePath, content, "utf8");
}

export async function ensureDemoResumeFiles(
  sourceFilePath: string | null | undefined,
  exportFilePaths: readonly (string | null | undefined)[],
) {
  await Promise.all([
    writeDemoFile(sourceFilePath, JOB_FINDER_DEMO_SOURCE_RESUME_CONTENT),
    ...exportFilePaths.map((filePath) =>
      writeDemoFile(filePath, JOB_FINDER_DEMO_EXPORT_RESUME_CONTENT),
    ),
  ]);
}

export async function loadApplyQueueDemoState() {
  const state = createApplyQueueDemoState();
  await ensureDemoResumeFiles(
    state.profile.baseResume.storagePath,
    state.resumeExportArtifacts.map((artifact) => artifact.filePath),
  );
  const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
  await jobFinderWorkspaceService.resetWorkspace(state);
  // A reset holds the pause until its caller lowers it; a demo state brings
  // its own.
  lowerPauseAfterReset(state.activityControl);
  return JobFinderWorkspaceSnapshotSchema.parse(
    await jobFinderWorkspaceService.getWorkspaceSnapshot(),
  );
}

export async function loadWorkHistoryReviewDriveState() {
  const state = createWorkHistoryReviewDriveState();
  await ensureDemoResumeFiles(
    state.profile.baseResume.storagePath,
    state.resumeExportArtifacts.map((artifact) => artifact.filePath),
  );
  const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
  await jobFinderWorkspaceService.resetWorkspace(state);
  // A reset holds the pause until its caller lowers it; a demo state brings
  // its own.
  lowerPauseAfterReset(state.activityControl);
  return JobFinderWorkspaceSnapshotSchema.parse(
    await jobFinderWorkspaceService.getWorkspaceSnapshot(),
  );
}

export async function loadAgentOwnedBrowserDriveState(input: {
  sourceUrl: string;
  applicationUrl: string;
  secondaryApplicationUrl?: string;
  jobTitle?: string;
  jobCompany?: string;
  foundJobs?: readonly {
    title: string;
    company: string;
    applicationUrl: string;
  }[];
}) {
  const state = createAgentOwnedBrowserDriveState(input);
  await ensureDemoResumeFiles(
    state.profile.baseResume.storagePath,
    state.resumeExportArtifacts.map((artifact) => artifact.filePath),
  );
  const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
  await jobFinderWorkspaceService.resetWorkspace(state);
  lowerPauseAfterReset(state.activityControl);
  return JobFinderWorkspaceSnapshotSchema.parse(
    await jobFinderWorkspaceService.getWorkspaceSnapshot(),
  );
}
