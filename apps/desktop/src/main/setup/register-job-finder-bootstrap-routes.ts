import { JobFinderWorkspaceSnapshotSchema } from "@nestor/contracts";
import type { IpcMain } from "electron";
import {
  getDesktopTestDelayMs,
  getJobFinderWorkspaceService,
  isDesktopTestApiEnabled,
} from "../services/job-finder";
import { toRendererWorkspaceSnapshot } from "../services/job-finder/renderer-workspace-view";

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

  ipcMain.handle("job-finder:get-workspace", async () => {
    await waitForOpeningHold();
    const workspaceService = await getJobFinderWorkspaceService();
    return toRendererWorkspaceSnapshot(
      await (workspaceService.getWorkspaceProjection?.() ??
        workspaceService.getWorkspaceSnapshot()),
    );
  });

  ipcMain.handle("job-finder:get-workspace-bootstrap", async () => {
    await waitForOpeningHold();
    const workspaceService = await getJobFinderWorkspaceService();
    return toRendererWorkspaceSnapshot(
      JobFinderWorkspaceSnapshotSchema.parse(
        await workspaceService.getWorkspaceBootstrap(),
      ),
    );
  });
}
