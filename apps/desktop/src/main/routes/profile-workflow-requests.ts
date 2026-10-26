import { BrowserWindow, dialog } from "electron";
import type { IpcMain, IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import {
  CancelResumeImportRequestSchema,
  ImportResumeRequestSchema,
  ResumeImportProgressEventSchema,
  SourceDebugProgressEventSchema,
  type JobFinderWorkspaceSnapshot,
  type ResumeImportRun,
} from "@nestor/contracts";
import {
  getJobFinderWorkspaceService,
  importResumeFromSourcePath,
  retryInterruptedResumeImport,
} from "../services/job-finder";
import { runBoundedNewSourceReadabilityCheck } from "../services/job-finder/new-source-readability-check";
import { publishJobFinderWorkspaceUpdate } from "../services/job-finder/workspace-updates";

/**
 * Resume import and site checks started from a window: the file picker,
 * cancellation and progress events. Both the old workspace routes and the
 * Profile workflow routes run these; each answers in its own shape.
 */

export async function readWorkspaceProjection(
  service: Awaited<ReturnType<typeof getJobFinderWorkspaceService>>,
): Promise<JobFinderWorkspaceSnapshot> {
  if (!service.getWorkspaceProjection) {
    throw new Error("The interactive workspace view is unavailable.");
  }
  // Main keeps full validated jobs; trim listing evidence at the IPC boundary.
  return service.getWorkspaceProjection();
}

const activeResumeImportRequests = new WeakMap<
  object,
  {
    requestId: string;
    cancelled: boolean;
    phase: "picking" | "processing";
  }
>();

/**
 * Imports the resume the person picks, or with `retryInterrupted` the
 * working copy a stopped import saved. Null when nothing was imported (the
 * picker was cancelled or closed).
 */
export async function importResumeForRequest(
  ipcMain: Pick<IpcMain, "on" | "removeListener">,
  event: IpcMainInvokeEvent,
  payload: unknown,
  latestRun: () => Promise<ResumeImportRun | null>,
): Promise<JobFinderWorkspaceSnapshot | null> {
  const importRequest = ImportResumeRequestSchema.parse(payload ?? {});
  const requestId = importRequest.requestId ?? null;
  const abortController = new AbortController();
  const request: {
    requestId: string;
    cancelled: boolean;
    phase: "picking" | "processing";
  } | null = requestId
    ? { requestId, cancelled: false, phase: "picking" }
    : null;
  if (request) {
    activeResumeImportRequests.set(event.sender, request);
  }

  const cancelHandler = request
    ? (cancelEvent: Electron.IpcMainEvent, cancelPayload: unknown) => {
        const cancelRequest =
          CancelResumeImportRequestSchema.safeParse(cancelPayload);
        const activeRequest = activeResumeImportRequests.get(
          cancelEvent.sender,
        );
        if (
          activeRequest === request &&
          cancelRequest.success &&
          cancelRequest.data.requestId === request.requestId &&
          (request.phase === "picking" ||
            cancelRequest.data.stopProcessing === true)
        ) {
          // Ignore a late picker choice, or stop processing before it can
          // apply results. The listener stays installed until this request
          // settles, so manual setup can stop an in-flight model read.
          request.cancelled = true;
          abortController.abort();
        }
      }
    : null;
  if (cancelHandler) {
    ipcMain.on("job-finder:cancel-import-resume", cancelHandler);
  }

  const reportProgress = requestId
    ? (
        progress: Parameters<typeof ResumeImportProgressEventSchema.parse>[0],
      ) => {
        const parsedProgress = ResumeImportProgressEventSchema.parse(progress);

        // A native picker can outlive the renderer that opened it. Do not
        // let a progress notification race turn a successful import into a
        // rejected IPC request after a reload or window close.
        try {
          if (event.sender.isDestroyed()) {
            return;
          }
          event.sender.send(
            `job-finder:resume-import-progress:${requestId}`,
            parsedProgress,
          );
        } catch (error) {
          // The sender may be destroyed between the check and send. Preserve
          // import persistence for that expected lifecycle race, while still
          // surfacing unexpected send failures.
          if (!event.sender.isDestroyed()) {
            throw error;
          }
        }
      }
    : undefined;
  const dialogOptions: OpenDialogOptions = {
    properties: ["openFile"],
    filters: [
      {
        name: "Resume documents",
        extensions: ["pdf", "docx", "txt", "md"],
      },
      { name: "All files", extensions: ["*"] },
    ],
  };
  const parentWindow = BrowserWindow.fromWebContents(event.sender);
  try {
    // Starting a stopped import again reads the working copy it saved, so
    // there is no picker to wait on.
    if (importRequest.retryInterrupted === true) {
      if (request) {
        request.phase = "processing";
      }
      return await retryInterruptedResumeImport(await latestRun(), {
        ...(reportProgress ? { onProgress: reportProgress } : {}),
        signal: abortController.signal,
      });
    }
    const usableParentWindow =
      parentWindow && !parentWindow.isDestroyed() ? parentWindow : null;
    if (usableParentWindow) {
      // A hidden or backgrounded renderer can otherwise leave the native
      // picker behind another window where automation and users cannot see
      // Escape/cancel feedback.
      usableParentWindow.show();
      usableParentWindow.focus();
    }
    const selection = usableParentWindow
      ? await dialog.showOpenDialog(usableParentWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    const sourcePath = selection.filePaths[0];
    if (request?.cancelled || selection.canceled || !sourcePath) {
      return null;
    }

    if (request) {
      // A valid selection transfers ownership from the native picker to the
      // importer synchronously, before any further await can let a
      // route-change cancellation race discard real processing.
      request.phase = "processing";
    }
    return await importResumeFromSourcePath(sourcePath, {
      signal: abortController.signal,
      ...(reportProgress ? { onProgress: reportProgress } : {}),
    });
  } finally {
    if (cancelHandler) {
      ipcMain.removeListener("job-finder:cancel-import-resume", cancelHandler);
    }
    if (request && activeResumeImportRequests.get(event.sender) === request) {
      activeResumeImportRequests.delete(event.sender);
    }
  }
}

/**
 * Checks how to read one job site, reporting progress to the window that
 * asked. An interrupted check is cancelled; a navigation failure the
 * workflow already recorded answers with that recorded state.
 */
export async function checkSiteForRequest(
  event: IpcMainInvokeEvent,
  input: {
    targetId: string;
    requestId: string | null;
    readabilityTimeoutMs: number | null;
  },
): Promise<JobFinderWorkspaceSnapshot> {
  const { targetId, requestId, readabilityTimeoutMs } = input;
  const service = await getJobFinderWorkspaceService();
  let snapshot: JobFinderWorkspaceSnapshot;
  try {
    const run = (signal?: AbortSignal) =>
      service.runSourceDebug(
        targetId,
        signal,
        requestId
          ? (progressEvent) => {
              event.sender.send(
                `job-finder:source-debug-progress:${requestId}`,
                SourceDebugProgressEventSchema.parse(progressEvent),
              );
              publishJobFinderWorkspaceUpdate(event.sender);
            }
          : undefined,
      );
    snapshot = readabilityTimeoutMs
      ? await runBoundedNewSourceReadabilityCheck(
          (signal) => run(signal),
          readabilityTimeoutMs,
        )
      : await run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.name === "AbortError") {
      const interrupted = await readWorkspaceProjection(service);
      const runningRun = interrupted.recentSourceDebugRuns.find(
        (run) => run.targetId === targetId && run.state === "running",
      );
      snapshot = runningRun
        ? await service.cancelSourceDebug(runningRun.id)
        : interrupted;
    } else {
      if (
        !/(?:ApplicationNavigationError|page\.(?:goto|waitFor)|navigation.*(?:failed|timeout)|Timeout \d+ms exceeded|net::ERR_)/iu.test(
          detail,
        )
      ) {
        throw error;
      }
      // The workflow records a screen-safe failed result before this route
      // fallback is reached. Return that durable snapshot instead of letting
      // Electron paint its transport wrapper across the window.
      snapshot = await readWorkspaceProjection(service);
    }
  }

  publishJobFinderWorkspaceUpdate(event.sender);
  return snapshot;
}
