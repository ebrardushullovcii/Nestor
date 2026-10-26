import type { IpcMain } from "electron";
import { registerCandidateAssetRouteHandlers } from "../routes/candidate-assets";

export function registerJobFinderAssetDesktopRoutes(ipcMain: IpcMain) {
  registerCandidateAssetRouteHandlers(ipcMain);
}
