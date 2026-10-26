import { chmod, copyFile, mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserWindow, dialog, shell } from "electron";
import type { IpcMain, IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import {
  CandidateAssetDeleteInputSchema,
  CandidateAssetDeleteResultSchema,
  CandidateAssetImportInputSchema,
  CandidateAssetImportResultSchema,
  CandidateAssetListInputSchema,
  CandidateAssetListResultSchema,
  CandidateAssetOpenInputSchema,
  CandidateAssetOpenResultSchema,
  CandidateAssetRestoreInputSchema,
  CandidateAssetRestoreResultSchema,
  type ResumeSourceDocument,
} from "@nestor/contracts";
import { CandidateAssetLibraryError } from "../services/job-finder/candidate-asset-library";
import type { CandidateAssetLibrary } from "../services/job-finder/candidate-asset-library";
import { getCandidateAssetLibrary } from "../services/job-finder/candidate-asset-library-instance";

interface CandidateAssetRouteDependencies {
  library: CandidateAssetLibrary;
  selectFile: (event: IpcMainInvokeEvent | null) => Promise<string | null>;
  getResumeSource?: () => Promise<ResumeSourceDocument>;
}

const fileDialogOptions: OpenDialogOptions = {
  title: "Import a document or asset",
  buttonLabel: "Import securely",
  properties: ["openFile"],
  filters: [
    {
      name: "Supported documents and images",
      extensions: [
        "pdf",
        "docx",
        "txt",
        "md",
        "csv",
        "vtt",
        "srt",
        "png",
        "jpg",
        "jpeg",
        "webp",
      ],
    },
  ],
};

async function selectCandidateAssetFile(event: IpcMainInvokeEvent | null) {
  const parentWindow = event ? BrowserWindow.fromWebContents(event.sender) : null;
  const selection = parentWindow
    ? await dialog.showOpenDialog(parentWindow, fileDialogOptions)
    : await dialog.showOpenDialog(fileDialogOptions);
  return selection.canceled ? null : (selection.filePaths[0] ?? null);
}

async function runAssetOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CandidateAssetLibraryError) throw error;
    throw new CandidateAssetLibraryError(
      "The candidate asset storage operation could not be completed.",
    );
  }
}

export function createCandidateAssetOperations(
  dependencies: CandidateAssetRouteDependencies = {
    library: getCandidateAssetLibrary(),
    selectFile: selectCandidateAssetFile,
    getResumeSource: async () => {
      const { startJobFinderRuntime } =
        await import("../services/job-finder/runtime");
      const { repository } = await startJobFinderRuntime();
      return (await repository.getProfile()).baseResume;
    },
  },
) {
  const operations = new Map<string, (event: IpcMainInvokeEvent | null, input: unknown) => Promise<unknown>>();
  const add = (name: string, operation: (event: IpcMainInvokeEvent | null, input: unknown) => Promise<unknown>) => operations.set(name, operation);
  add(
    "job-finder:candidate-assets:list",
    async (_event, payload) => {
      const input = CandidateAssetListInputSchema.parse(payload ?? {});
      const result = await runAssetOperation(() =>
        dependencies.library.list(input),
      );
      if (!input.resumeSourceId)
        return CandidateAssetListResultSchema.parse(result);
      const source = await dependencies.getResumeSource?.();
      let originalResumeFile = null;
      if (source?.id === input.resumeSourceId && source.storagePath) {
        try {
          const info = await stat(source.storagePath);
          if (info.isFile())
            originalResumeFile = {
              id: source.id,
              fileName: source.fileName,
              fileType:
                path.extname(source.fileName).slice(1).toUpperCase() || "File",
              byteSize: info.size,
              importedAt: source.uploadedAt,
            };
        } catch {
          /* The source was removed from disk. */
        }
      }
      return CandidateAssetListResultSchema.parse({
        ...result,
        originalResumeFile,
      });
    },
  );

  add(
    "job-finder:candidate-assets:import",
    async (event, payload) => {
      const input = CandidateAssetImportInputSchema.parse(payload);
      const sourcePath = await dependencies.selectFile(event);
      if (!sourcePath) {
        return CandidateAssetImportResultSchema.parse({ status: "cancelled" });
      }
      const result = await runAssetOperation(async () =>
        CandidateAssetImportResultSchema.parse(
          await dependencies.library.importFromSourcePath(sourcePath, input),
        ),
      );
      return result;
    },
  );

  add(
    "job-finder:candidate-assets:delete",
    async (_event, payload) => {
      const input = CandidateAssetDeleteInputSchema.parse(payload);
      return runAssetOperation(async () =>
        CandidateAssetDeleteResultSchema.parse(
          await dependencies.library.softDelete(input.assetId),
        ),
      );
    },
  );

  // Opens a read-only copy in the default app, so the person can see what an
  // application would attach without hunting for Job Finder's private folder.
  add(
    "job-finder:candidate-assets:open",
    async (_event, payload) => {
      const input = CandidateAssetOpenInputSchema.parse(payload);
      let viewingPath: string;
      try {
        viewingPath = await dependencies.library.writeViewingCopy(
          input.assetId,
          path.join(os.tmpdir(), "nestor-file-views"),
        );
      } catch {
        const source = await dependencies.getResumeSource?.();
        if (source?.id !== input.assetId || !source.storagePath) {
          return CandidateAssetOpenResultSchema.parse({ outcome: "not_found" });
        }
        try {
          const directory = await mkdtemp(
            path.join(os.tmpdir(), "nestor-resume-view-"),
          );
          viewingPath = path.join(directory, path.basename(source.fileName));
          await copyFile(source.storagePath, viewingPath);
          // Same as Profile › Files: the person views a copy they cannot
          // change by accident.
          await chmod(viewingPath, 0o400);
        } catch {
          return CandidateAssetOpenResultSchema.parse({ outcome: "not_found" });
        }
      }
      const failure = await shell.openPath(viewingPath);
      return CandidateAssetOpenResultSchema.parse({
        outcome: failure ? "failed" : "opened",
      });
    },
  );

  add(
    "job-finder:candidate-assets:restore",
    async (_event, payload) => {
      const input = CandidateAssetRestoreInputSchema.parse(payload);
      const result = await runAssetOperation(async () =>
        CandidateAssetRestoreResultSchema.parse(
          await dependencies.library.restore(input),
        ),
      );
      return result;
    },
  );
  return operations;
}

export function registerCandidateAssetRouteHandlers(ipcMain: IpcMain, dependencies?: CandidateAssetRouteDependencies) {
  for (const [name, operation] of createCandidateAssetOperations(dependencies)) {
    ipcMain.handle(name, (event, input: unknown) => operation(event, input));
  }
}

export async function executeCandidateAssetAction(id: string, input: unknown) {
  const operation = createCandidateAssetOperations().get(`job-finder:${id}`);
  if (!operation) throw new Error("Unknown candidate file action.");
  return operation(null, input);
}
