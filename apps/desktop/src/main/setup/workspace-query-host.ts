import { app, ipcMain, type BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import {
  createWorkspaceQueryRepository,
  prepareWorkspaceQueryDatabase,
  type WorkspaceQueryRepository,
} from "@nestor/db";
import { WorkspaceReadRequestSchema } from "@nestor/contracts";
import { getJobFinderWorkspaceFilePath } from "../services/job-finder/paths";

/** Small SQLite reads are ordinary typed IPC; no workspace hydration is needed. */
export function createWorkspaceQueryHost() {
  let repository: WorkspaceQueryRepository | null = null;
  let cursor = 0;
  const windows = new Set<BrowserWindow>();
  function reader(): WorkspaceQueryRepository {
    if (repository) return repository;
    const filePath = getJobFinderWorkspaceFilePath();
    if (!existsSync(filePath))
      throw new Error("The workspace is opening. Try again shortly.");
    prepareWorkspaceQueryDatabase(filePath);
    repository = createWorkspaceQueryRepository(filePath);
    cursor = repository.getChanges(Number.MAX_SAFE_INTEGER).revision;
    return repository;
  }
  ipcMain.handle("workspace-query:read", (event, payload: unknown) => {
    if (
      ![...windows].some((window) => window.webContents === event.sender) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error("Workspace read is unavailable.");
    const request = WorkspaceReadRequestSchema.parse(payload);
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
  const timer = setInterval(() => {
    if (!repository || !windows.size) return;
    try {
      const changes = repository.getChanges(cursor);
      if (!changes.changes.length) return;
      for (const window of windows)
        if (!window.isDestroyed())
          window.webContents.send("workspace-query:changes", changes);
      cursor = changes.revision;
    } catch {
      // Leave the durable cursor unchanged so the next tick retries.
    }
  }, 100);
  timer.unref();
  app.once("will-quit", () => {
    clearInterval(timer);
    repository?.close();
  });
  return {
    attach(window: BrowserWindow) {
      windows.add(window);
      window.once("closed", () => windows.delete(window));
    },
  };
}
