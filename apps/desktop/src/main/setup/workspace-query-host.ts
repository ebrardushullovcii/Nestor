import { app, ipcMain, type BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import {
  createWorkspaceQueryRepository,
  prepareWorkspaceQueryDatabase,
  subscribeWorkspaceCommits,
  type WorkspaceQueryRepository,
} from "@nestor/db";
import { WorkspaceReadRequestSchema } from "@nestor/contracts";
import { getJobFinderWorkspaceFilePath } from "../services/job-finder/paths";
import { setWorkspaceQueryUpdateMode } from "../services/job-finder/query-update-mode";

/** Small SQLite reads are ordinary typed IPC; no workspace hydration is needed. */
export function createWorkspaceQueryHost() {
  let repository: WorkspaceQueryRepository | null = null;
  let cursor = 0;
  let unsubscribe: (() => void) | undefined;
  let pendingPush: ReturnType<typeof setImmediate> | undefined;
  const windows = new Set<BrowserWindow>();
  function reader(): WorkspaceQueryRepository {
    if (repository) return repository;
    const filePath = getJobFinderWorkspaceFilePath();
    if (!existsSync(filePath))
      throw new Error("The workspace is opening. Try again shortly.");
    prepareWorkspaceQueryDatabase(filePath);
    repository = createWorkspaceQueryRepository(filePath);
    cursor = repository.getChanges(Number.MAX_SAFE_INTEGER).revision;
    unsubscribe = subscribeWorkspaceCommits(filePath, schedulePush);
    return repository;
  }
  ipcMain.handle("workspace-query:read", (event, payload: unknown) => {
    if (
      ![...windows].some((window) => window.webContents === event.sender) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error("Workspace read is unavailable.");
    const request = WorkspaceReadRequestSchema.parse(payload);
    if (request.method === "setQueryUpdates") {
      setWorkspaceQueryUpdateMode(event.sender.id, request.input.active);
      return;
    }
    const db = reader();
    switch (request.method) {
      case "getStartupContext":
        return db.getStartupContext();
      case "queryJobList":
        return db.queryJobList(request.input);
      case "getJobDetail":
        return db.getJobDetail(request.input.jobId, request.input.planId);
      case "getCompanyDetail":
        return db.getCompanyDetail(request.input.companyId);
      case "getHomeSummary":
        return db.getHomeSummary(request.input);
      case "getListCounts":
        return db.getListCounts(request.input);
      case "queryCompanies":
        return db.queryCompanies(request.input);
      case "getChanges":
        return db.getChanges(request.input.after, request.input.limit);
    }
  });
  function pushChanges() {
    pendingPush = undefined;
    if (!repository || !windows.size) return;
    try {
      const changes = repository.getChanges(cursor);
      if (!changes.changes.length) return;
      for (const window of windows)
        if (!window.isDestroyed())
          window.webContents.send("workspace-query:changes", changes);
      cursor = changes.revision;
      if (changes.hasMore) schedulePush();
    } catch {
      // A later commit or explicit reconnect can retry the durable cursor.
    }
  }
  function schedulePush() {
    pendingPush ??= setImmediate(pushChanges);
  }
  app.once("will-quit", () => {
    unsubscribe?.();
    if (pendingPush) clearImmediate(pendingPush);
    repository?.close();
  });
  return {
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
