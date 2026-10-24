import type { IpcMain } from "electron";
import {
  getDesktopTestDelayMs,
  isDesktopTestApiEnabled,
} from "../services/job-finder/test-api";
import { toRendererWorkspaceSnapshot } from "../services/job-finder/renderer-workspace-view";
import { usesWorkspaceQueryUpdates } from "../services/job-finder/query-update-mode";

// The workspace services are a large module graph. Loading them only when a
// handler needs them keeps the graph off the window's initial load.
async function getJobFinderWorkspaceService() {
  const services = await import("../services/job-finder");
  return services.getJobFinderWorkspaceService();
}

export const TEST_WORKSPACE_OPENING_HOLD_ENV =
  "NESTOR_TEST_WORKSPACE_OPENING_HOLD_MS";
const MAX_TEST_WORKSPACE_OPENING_HOLD_MS = 5_000;

export function getTestWorkspaceOpeningHoldMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (!isDesktopTestApiEnabled(env)) {
    return 0;
  }

  return Math.min(
    getDesktopTestDelayMs(
      env.NESTOR_TEST_WORKSPACE_OPENING_HOLD_MS,
      TEST_WORKSPACE_OPENING_HOLD_ENV,
    ),
    MAX_TEST_WORKSPACE_OPENING_HOLD_MS,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerJobFinderBootstrapDesktopRoutes(ipcMain: IpcMain) {
  const openingHoldMs = getTestWorkspaceOpeningHoldMs();
  let openingHoldPromise: Promise<void> | null = null;
  const waitForOpeningHold = () => {
    if (openingHoldMs <= 0) {
      return Promise.resolve();
    }

    openingHoldPromise ??= delay(openingHoldMs);
    return openingHoldPromise;
  };

  ipcMain.handle("job-finder:get-workspace", async (event) => {
    await waitForOpeningHold();
    const workspaceService = await getJobFinderWorkspaceService();
    return toRendererWorkspaceSnapshot(
      await (workspaceService.getWorkspaceProjection?.() ??
        workspaceService.getWorkspaceSnapshot()),
      usesWorkspaceQueryUpdates(event.sender.id) ? true : undefined,
    );
  });

  ipcMain.handle("job-finder:get-workspace-bootstrap", async (event) => {
    await waitForOpeningHold();
    const workspaceService = await getJobFinderWorkspaceService();
    return toRendererWorkspaceSnapshot(
      await workspaceService.getWorkspaceBootstrap(),
      usesWorkspaceQueryUpdates(event.sender.id) ? true : undefined,
    );
  });
}
