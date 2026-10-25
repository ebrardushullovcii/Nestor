import {
  app,
  ipcMain,
  MessageChannelMain,
  utilityProcess,
  type BrowserWindow,
  type UtilityProcess,
} from "electron";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { subscribeWorkspaceCommits } from "@nestor/db/workspace-commits";
import {
  WorkspaceReadRequestSchema,
  type WorkspaceReaderControl,
} from "@nestor/contracts";
import { getJobFinderWorkspaceFilePath } from "../services/job-finder/paths";
import { setWorkspaceQueryUpdateMode } from "../services/job-finder/query-update-mode";
import {
  prepareWorkspaceScreenReads,
  prepareWorkspaceStartupContextReads,
  waitForWorkspaceDatabaseMigrations,
} from "./workspace-database-startup";

/** Main authorizes a private preload port; reads then bypass its busy event loop. */
export function createWorkspaceQueryHost() {
  const windows = new Set<BrowserWindow>();
  const filePath = getJobFinderWorkspaceFilePath();
  const contextReady = prepareWorkspaceStartupContextReads();
  const queriesReady = prepareWorkspaceScreenReads();
  let child: UtilityProcess | undefined;
  let closed = false;
  let stop: Promise<void> | undefined;
  let stopped: (() => void) | undefined;
  const send = (process: UtilityProcess, message: WorkspaceReaderControl) =>
    process.postMessage(message);
  const available = app.whenReady().then(() => {
    if (closed) return;
    child = utilityProcess.fork(
      fileURLToPath(new URL("./workspace-query-reader.cjs", import.meta.url)),
      [],
      {
        execArgv: [],
        serviceName: "Workspace screen reads",
        stdio: "pipe",
      },
    );
    const process = child;
    process.stderr?.on("data", (chunk: Buffer) =>
      console.warn("Workspace reader:", chunk.toString()),
    );
    return new Promise<UtilityProcess>((resolve, reject) => {
      let spawned = false;
      process.once("exit", () => {
        child = undefined;
        stopped?.();
        if (!spawned) reject(new Error("Workspace reader could not start."));
        unavailable();
      });
      process.once("spawn", () => {
        spawned = true;
        if (!closed) send(process, { type: "initialize", filePath });
        resolve(process);
      });
    });
  });
  let recovery: Promise<void> | undefined;
  function recover() {
    recovery ??= (async () => {
      if (closed) throw new Error("The workspace is closing.");
      const { getJobFinderWorkspaceService } =
        await import("../services/job-finder");
      await getJobFinderWorkspaceService();
      const { prepareWorkspaceQueryDatabase } = await import("@nestor/db");
      prepareWorkspaceQueryDatabase(filePath);
    })();
    return recovery;
  }
  async function release(
    prepared: Promise<void>,
    type: "context-ready" | "queries-ready",
  ) {
    try {
      await prepared;
      if (closed) return;
      if (!existsSync(filePath)) await recover();
    } catch {
      if (closed) return;
      // Canonical opening owns corruption recovery and its disclosure.
      await recover();
    }
    const process = await available;
    if (process && !closed) send(process, { type });
  }
  void release(contextReady, "context-ready").catch(unavailable);
  void release(queriesReady, "queries-ready").catch(unavailable);
  function unavailable() {
    if (closed) return;
    for (const window of windows)
      if (!window.isDestroyed())
        window.webContents.send("workspace-query:unavailable");
  }
  function changed() {
    void available
      .then((process) => {
        if (process && !closed) send(process, { type: "changed" });
      })
      .catch(unavailable);
  }
  const unsubscribe = subscribeWorkspaceCommits(filePath, changed);
  void waitForWorkspaceDatabaseMigrations().then(changed);
  const authorized = (
    event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
  ) =>
    [...windows].some((window) => window.webContents === event.sender) &&
    event.senderFrame === event.sender.mainFrame;
  ipcMain.handle("workspace-query:read", (event, payload: unknown) => {
    if (closed || !authorized(event))
      throw new Error("Workspace read is unavailable.");
    const request = WorkspaceReadRequestSchema.parse(payload);
    if (request.method !== "setQueryUpdates")
      throw new Error("Workspace reads require the preload connection.");
    setWorkspaceQueryUpdateMode(event.sender.id, request.input.active);
  });
  ipcMain.on("workspace-query:connect", (event) => {
    if (closed || !authorized(event)) return;
    void available
      .then((process) => {
        if (
          !process ||
          closed ||
          event.sender.isDestroyed() ||
          !authorized(event)
        )
          return;
        const { port1, port2 } = new MessageChannelMain();
        process.postMessage(
          { type: "attach" } satisfies WorkspaceReaderControl,
          [port2],
        );
        event.senderFrame?.postMessage("workspace-query:port", null, [port1]);
      })
      .catch(unavailable);
  });
  function close(): Promise<void> {
    if (stop) return stop;
    closed = true;
    unsubscribe();
    if (!child) return (stop = Promise.resolve());
    stop = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    void available
      .then((process) => {
        if (process && child === process) send(process, { type: "close" });
      })
      .catch(() => stopped?.());
    return stop;
  }
  app.once("will-quit", () => {
    void close();
  });
  return {
    close,
    attach(window: BrowserWindow) {
      const id = window.webContents.id;
      windows.add(window);
      window.once("closed", () => {
        windows.delete(window);
        setWorkspaceQueryUpdateMode(id, false);
      });
    },
  };
}
