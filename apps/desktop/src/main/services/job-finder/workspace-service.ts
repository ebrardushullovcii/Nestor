import { JobFinderWorkspaceSnapshotSchema } from "@nestor/contracts";
import { createJobFinderWorkspaceServiceAsync } from "./create-workspace-service";
import { toRendererWorkspaceSnapshot } from "./renderer-workspace-view";
import {
  writeStartupWorkspaceView,
  type StartupWorkspaceView,
} from "./startup-workspace-view";

type JobFinderWorkspaceService = Awaited<
  ReturnType<typeof createJobFinderWorkspaceServiceAsync>
>;

let jobFinderWorkspaceServicePromise:
  | ReturnType<typeof createJobFinderWorkspaceServiceAsync>
  | undefined;

let jobFinderWorkspaceServiceOverrideEnv: Partial<NodeJS.ProcessEnv> | null =
  null;

export function getJobFinderWorkspaceService() {
  if (jobFinderWorkspaceServicePromise) {
    return jobFinderWorkspaceServicePromise;
  }

  const creation = createJobFinderWorkspaceServiceAsync(
    jobFinderWorkspaceServiceOverrideEnv ?? undefined,
  );
  jobFinderWorkspaceServicePromise = creation;

  void creation.catch(() => {
    // A failed startup must not stay memoized forever; a later caller retries
    // initialization while in-flight and successful creations stay single-flight.
    if (jobFinderWorkspaceServicePromise === creation) {
      jobFinderWorkspaceServicePromise = undefined;
    }
  });

  return creation;
}

export async function setJobFinderWorkspaceServiceTestEnv(
  envOverrides: Partial<NodeJS.ProcessEnv> | null,
) {
  await shutdownJobFinderWorkspaceService();
  jobFinderWorkspaceServiceOverrideEnv = envOverrides;
}

/**
 * What the window shows right now, for the next start. Skipped while a search
 * or an application is running: shutdown changes those, and the next start
 * would briefly show them still running.
 */
async function captureStartupWorkspaceView(
  service: JobFinderWorkspaceService,
): Promise<StartupWorkspaceView | null> {
  if (!service.getWorkspaceProjection) return null;
  const snapshot = toRendererWorkspaceSnapshot(
    await service.getWorkspaceProjection(),
  );
  const busy =
    snapshot.discoveryRunState === "running" ||
    snapshot.activeDiscoveryRun !== null ||
    snapshot.applyRuns.some((run) => run.state === "running");
  if (busy) return null;
  const bootstrap = toRendererWorkspaceSnapshot(
    JobFinderWorkspaceSnapshotSchema.parse(
      await service.getWorkspaceBootstrap(),
    ),
  );
  return { bootstrap, snapshot };
}

export async function shutdownJobFinderWorkspaceService(
  options: { saveStartupView?: boolean } = {},
) {
  const servicePromise = jobFinderWorkspaceServicePromise;
  jobFinderWorkspaceServicePromise = undefined;

  if (!servicePromise) {
    return;
  }

  const service = await servicePromise.catch((error) => {
    console.warn(
      "[Desktop] Job Finder workspace service was not created before shutdown.",
      error,
    );
    return undefined;
  });
  if (!service) {
    return;
  }

  const startupView = options.saveStartupView
    ? await captureStartupWorkspaceView(service).catch((error: unknown) => {
        console.warn("[Desktop] Could not read the startup view.", error);
        return null;
      })
    : null;

  let closedCleanly = true;
  await service.shutdown().catch((error) => {
    closedCleanly = false;
    console.warn(
      "[Desktop] Failed to shut down Job Finder workspace service cleanly.",
      error,
    );
  });
  if (options.saveStartupView) {
    writeStartupWorkspaceView(closedCleanly ? startupView : null);
  }
}
