import * as C from "@nestor/contracts";
import { access } from "node:fs/promises";
import path from "node:path";
import { app, clipboard, shell } from "electron";

import { executeCandidateAssetAction } from "../../routes/candidate-assets";
import { getJobFinderWorkspaceService } from "../job-finder/workspace-service";
import { buildDiagnosticsFileExport } from "../job-finder/workspace-file-exports";
import { getJobFinderUserDataDirectory } from "../job-finder/paths";
import { isDesktopTestApiEnabled } from "../job-finder/test-api";
import { writeExportFile } from "./write-export-file";
import {
  resetJobFinderBrowser,
  resetJobFinderWorkspace,
} from "../job-finder/reset-workspace";
import { collectJobFinderPerformanceSnapshot } from "../job-finder/collect-performance-snapshot";
import { getRegisteredMainWindow } from "../../setup/finished-work-notifier-instance";
import { applyMainWindowZoomCommand } from "../../setup/window-zoom";
import { executeAuthorityAction } from "../../routes/job-finder-authority";
import {
  getJobFinderStartupResetRecoveryFact,
  getJobFinderStartupDatabaseRecoveryFact,
  dismissJobFinderStartupDatabaseRecoveryNotice,
} from "../job-finder";

/** Desktop services behind registered actions. No arbitrary IPC or paths. */
export async function executeDesktopJobFinderAction(
  actionId: string,
  input: unknown,
): Promise<unknown> {
  if (
    actionId.includes("application-authority-") ||
    actionId === "approve-current-application-answers" ||
    actionId === "resolve-submission-outcome"
  )
    return executeAuthorityAction(actionId, input);
  if (actionId === "get-startup-reset-recovery")
    return getJobFinderStartupResetRecoveryFact();
  if (actionId === "get-startup-database-recovery")
    return getJobFinderStartupDatabaseRecoveryFact();
  if (actionId === "dismiss-startup-database-recovery-notice")
    return dismissJobFinderStartupDatabaseRecoveryNotice();
  if (actionId === "zoom") {
    const window = getRegisteredMainWindow();
    if (!window || window.isDestroyed())
      throw new Error("The main window is unavailable.");
    applyMainWindowZoomCommand(
      window.webContents,
      C.JobFinderZoomInputSchema.parse(input).command,
    );
    return {
      zoomPercent: Math.round(window.webContents.getZoomFactor() * 100),
    };
  }
  if (actionId === "reset-workspace") return resetJobFinderWorkspace();
  if (actionId === "write-clipboard-text") {
    await clipboard.writeText(
      C.WriteClipboardTextInputSchema.parse(input).text,
    );
    return { written: true };
  }
  if (actionId === "reveal-saved-file") {
    const value = C.RevealSavedFileInputSchema.parse(input);
    try {
      await access(value.path);
    } catch {
      return { outcome: "not_found" };
    }
    shell.showItemInFolder(value.path);
    return { outcome: "revealed" };
  }
  if (actionId === "reset-browser") return resetJobFinderBrowser();
  if (actionId.startsWith("candidate-assets:"))
    return executeCandidateAssetAction(actionId, input);
  if (actionId === "stop-search")
    return (await import("../job-commands")).runJobCommand(
      "stop_search",
      input,
    );
  if (actionId === "stop-application")
    return (await import("../application-commands")).runApplicationCommand(
      "stop_application",
      input,
    );
  const service = await getJobFinderWorkspaceService();
  if (actionId === "get-tailored-asset") {
    const repository = (
      await import("../job-finder/create-workspace-service")
    ).getJobFinderRepositoryForWorkspaceService(service);
    if (!repository) throw new Error("Resume preview storage is unavailable.");
    return repository.getTailoredAssetById(
      C.JobFinderTailoredAssetQuerySchema.parse(input).assetId,
    );
  }
  if (actionId === "get-performance-snapshot")
    return (await collectJobFinderPerformanceSnapshot({ service })).performance;
  if (actionId === "export-diagnostics") {
    const directory = isDesktopTestApiEnabled()
      ? path.join(getJobFinderUserDataDirectory(), "exports")
      : app.getPath("downloads");
    const file = await buildDiagnosticsFileExport(service);
    return { filePath: await writeExportFile({ directory, ...file }) };
  }
  throw new Error("Unknown registered desktop action.");
}
