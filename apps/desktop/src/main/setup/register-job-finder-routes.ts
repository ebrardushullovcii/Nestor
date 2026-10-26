import type { IpcMain } from "electron";
import { registerJobFinderRouteHandlers } from "../routes/job-finder";
import { registerAssistantRouteHandlers } from "../routes/assistant";
import { registerApplicationStoreRoutes } from "../routes/application-store";

export function registerJobFinderDesktopRoutes(ipcMain: IpcMain) {
  registerJobFinderRouteHandlers(ipcMain);
  registerApplicationStoreRoutes(ipcMain);
  registerAssistantRouteHandlers(ipcMain);
}
