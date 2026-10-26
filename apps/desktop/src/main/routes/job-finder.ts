import { buildDiagnosticsFileExport } from "../services/job-finder/diagnostics-export";
import { resetJobFinderBrowser } from "../services/job-finder/reset-workspace";
import { access, writeFile } from "node:fs/promises";
import { BrowserWindow, clipboard, dialog, shell } from "electron";
import type { IpcMain, SaveDialogOptions } from "electron";
import {
  JobFinderStartupResetRecoveryFactSchema,
  ResumeImportBenchmarkRequestSchema,
  RevealSavedFileInputSchema,
  RevealSavedFileResultSchema,
  JobFinderDiagnosticExportResultSchema,
  ResumeImportBenchmarkReportSchema,
  ResumeImportBenchmarkCaseSchema,
  WriteClipboardTextInputSchema,
  WriteClipboardTextResultSchema,
} from "@nestor/contracts";

import {
  importResumeFromSourcePath,
  isDesktopTestApiEnabled,
  parseResumeImportPathPayload,
  resetJobFinderWorkspace,
  getJobFinderStartupResetRecoveryFact,
  runDesktopResumeImportBenchmark,
  defaultBenchmarkCases,
} from "../services/job-finder";

function requireTestApi(): void {
  if (!isDesktopTestApiEnabled())
    throw new Error(
      "Desktop test API is disabled. Set NESTOR_ENABLE_TEST_API=1 to enable scripted UI flows.",
    );
}

/** Settings' support tools, the reset, and the desktop test API. */
export function registerJobFinderRouteHandlers(ipcMain: IpcMain) {
  ipcMain.handle(
    "job-finder:test-run-resume-import-benchmark",
    async (_event, payload: unknown) => {
      requireTestApi();
      const parsed = ResumeImportBenchmarkRequestSchema.partial().parse(
        payload ?? {},
      );
      const options = {
        ...(parsed.benchmarkVersion !== undefined
          ? { benchmarkVersion: parsed.benchmarkVersion }
          : {}),
        ...(parsed.cases !== undefined ? { cases: parsed.cases } : {}),
        ...(parsed.canaryOnly !== undefined
          ? { canaryOnly: parsed.canaryOnly }
          : {}),
        ...(parsed.useConfiguredAi !== undefined
          ? { useConfiguredAi: parsed.useConfiguredAi }
          : {}),
        ...(parsed.useVision !== undefined
          ? { useVision: parsed.useVision }
          : {}),
      };

      const report = await runDesktopResumeImportBenchmark(options);
      return ResumeImportBenchmarkReportSchema.parse(report);
    },
  );

  ipcMain.handle("job-finder:test-get-resume-import-benchmark-cases", () => {
    requireTestApi();
    return ResumeImportBenchmarkCaseSchema.array().parse(defaultBenchmarkCases);
  });

  ipcMain.handle(
    "job-finder:test-import-resume-from-path",
    async (_event, payload: unknown) => {
      requireTestApi();
      const { sourcePath, useVision } = parseResumeImportPathPayload(payload);
      return importResumeFromSourcePath(
        sourcePath,
        useVision !== undefined ? { useVision } : {},
      );
    },
  );

  ipcMain.handle("job-finder:export-diagnostics", async (event) => {
    const diagnostic = await buildDiagnosticsFileExport();
    if (isDesktopTestApiEnabled()) {
      return JobFinderDiagnosticExportResultSchema.parse({
        status: "cancelled",
      });
    }
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const options: SaveDialogOptions = {
      defaultPath: "nestor-job-finder-diagnostics.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
      title: "Export Job Finder diagnostics",
    };
    const saveResult = browserWindow
      ? await dialog.showSaveDialog(browserWindow, options)
      : await dialog.showSaveDialog(options);
    if (saveResult.canceled || !saveResult.filePath) {
      return JobFinderDiagnosticExportResultSchema.parse({
        status: "cancelled",
      });
    }
    const outputPath = saveResult.filePath.toLowerCase().endsWith(".json")
      ? saveResult.filePath
      : saveResult.filePath + ".json";
    await writeFile(outputPath, diagnostic.content, "utf8");
    return JobFinderDiagnosticExportResultSchema.parse({ status: "saved" });
  });

  // Shows a file the app itself wrote in the operating system's file manager.
  // The export already named the path; without this the person had to find it
  // by hand. The OS selects the file — nothing is opened or executed — and a
  // path that no longer exists says so instead of failing silently.
  ipcMain.handle("job-finder:reveal-saved-file", async (_event, payload) => {
    const { path: savedPath } = RevealSavedFileInputSchema.parse(payload);

    try {
      await access(savedPath);
    } catch {
      return RevealSavedFileResultSchema.parse({ outcome: "not_found" });
    }

    if (typeof shell.showItemInFolder !== "function") {
      return RevealSavedFileResultSchema.parse({ outcome: "unsupported" });
    }

    shell.showItemInFolder(savedPath);
    return RevealSavedFileResultSchema.parse({ outcome: "revealed" });
  });

  ipcMain.handle(
    "job-finder:write-clipboard-text",
    (_event, payload: unknown) => {
      const { text } = WriteClipboardTextInputSchema.parse(payload);
      void clipboard.writeText(text);
      return WriteClipboardTextResultSchema.parse({ written: true });
    },
  );

  ipcMain.handle("job-finder:reset-browser", () => resetJobFinderBrowser());
  ipcMain.handle("job-finder:reset-workspace", () => resetJobFinderWorkspace());

  ipcMain.handle("job-finder:get-startup-reset-recovery", () =>
    JobFinderStartupResetRecoveryFactSchema.parse(
      getJobFinderStartupResetRecoveryFact(),
    ),
  );
}
