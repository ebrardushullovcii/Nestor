import type { IpcMain } from "electron";
import { registerSystemRouteHandlers } from "../routes/system";
import { registerWindowRouteHandlers } from "../routes/window";
import { registerBrowserRoutes } from "../routes/browser";

export interface FeatureRoutesReadyResponse {
  readonly ready: true;
}

/**
 * Register the small IPC surface needed while the renderer is starting.
 *
 * Feature routes are intentionally loaded in a separate chunk so their main
 * process parse/require work can overlap BrowserWindow and renderer startup.
 * The preload bridge uses this readiness channel to serialize feature calls
 * until that deferred route graph has registered its handlers.
 */
export function registerCoreDesktopRoutes(
  ipcMain: IpcMain,
  jobFinderRoutesReady: () => Promise<void>,
  jobFinderAssetRoutesReady: () => Promise<void>,
  liveAssistantRoutesReady: () => Promise<void>,
) {
  registerSystemRouteHandlers(ipcMain);
  registerWindowRouteHandlers(ipcMain);
  registerBrowserRoutes(ipcMain);
  ipcMain.handle(
    "system:job-finder-routes-ready",
    async (): Promise<FeatureRoutesReadyResponse> => {
      await jobFinderRoutesReady();
      return { ready: true };
    },
  );
  ipcMain.handle(
    "system:job-finder-asset-routes-ready",
    async (): Promise<FeatureRoutesReadyResponse> => {
      await jobFinderAssetRoutesReady();
      return { ready: true };
    },
  );
  ipcMain.handle(
    "system:live-assistant-routes-ready",
    async (): Promise<FeatureRoutesReadyResponse> => {
      await liveAssistantRoutesReady();
      return { ready: true };
    },
  );
}
