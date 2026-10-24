import { app } from "electron";
import type { JobFinderWorkspaceService } from "@nestor/job-finder";

import { getEmbeddedBrowser } from "../browser/embedded-browser";
import {
  buildJobFinderDiagnosticExport,
  buildPersonalWorkspaceExport,
  personalWorkspaceExportFileName,
} from "./build-diagnostic-export";
import { collectJobFinderPerformanceSnapshot } from "./collect-performance-snapshot";
import { getJobFinderRepositoryForWorkspaceService } from "./create-workspace-service";

/** The content is shared by the native Save dialog and the chat export. */
export async function buildWorkspaceFileExport(
  service: JobFinderWorkspaceService,
  kind: "workspace" | "diagnostics",
) {
  if (kind === "diagnostics") {
    const { performance, workspace } =
      await collectJobFinderPerformanceSnapshot({
        service,
        waitingFormMemory: () => getEmbeddedBrowser().reduceWaitingFormMemory(),
      });
    const content = buildJobFinderDiagnosticExport({
      workspace,
      performance,
      build: {
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? "unknown",
        chromiumVersion: process.versions.chrome ?? "unknown",
        nodeVersion: process.versions.node,
        platform:
          process.platform === "win32" || process.platform === "darwin"
            ? process.platform
            : "linux",
        architecture:
          process.arch === "arm64" || process.arch === "ia32"
            ? process.arch
            : "x64",
      },
    });
    return {
      fileName: "nestor-job-finder-diagnostics.json",
      content: `${JSON.stringify(content, null, 2)}\n`,
      exportedCount: 0,
    };
  }
  const repository = getJobFinderRepositoryForWorkspaceService(service);
  if (!repository)
    throw new Error(
      "Your workspace could not be exported. Nothing was deleted.",
    );
  const workspace = await service.getWorkspaceSnapshot();
  const { exportAssistantHistory } =
    await import("../assistant/assistant-service");
  const [
    assistantHistory,
    repositoryState,
    applicationQuestions,
    applicationAnswers,
  ] = await Promise.all([
    exportAssistantHistory(),
    repository.exportState(),
    repository.listApplicationQuestionRecords(),
    repository.listApplicationAnswerRecords(),
  ]);
  const content = await buildPersonalWorkspaceExport({
    workspace,
    repositoryState,
    assistantHistory,
    applicationQuestions,
    applicationAnswers,
  });
  return {
    fileName: personalWorkspaceExportFileName(),
    content,
    exportedCount: workspace.applicationRecords.length,
  };
}
