import type { IpcMain } from "electron";
import { registerJobFinderRouteHandlers } from "../routes/job-finder";
import { registerJobFinderAuthorityRouteHandlers } from "../routes/job-finder-authority";
import { registerAssistantRouteHandlers } from "../routes/assistant";
import { registerApplicationStoreRoutes } from "../routes/application-store";

export function registerJobFinderDesktopRoutes(ipcMain: IpcMain) {
  registerJobFinderRouteHandlers(ipcMain, { includeBootstrapRoutes: false });
  registerJobFinderAuthorityRouteHandlers(ipcMain);
  registerApplicationStoreRoutes(ipcMain);
  registerAssistantRouteHandlers(ipcMain);
}
