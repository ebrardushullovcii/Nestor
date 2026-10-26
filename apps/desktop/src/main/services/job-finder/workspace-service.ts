import { shutdownDiscoveryFeedWorkers } from "./discovery-cpu";
import { stopResumeService } from "../resumes";
import {
  createJobFinderRuntimeAsync,
  createJobFinderWorkspaceServiceAsync,
  type JobFinderRuntime,
} from "./create-workspace-service";

let runtimePromise: Promise<JobFinderRuntime> | undefined;
let servicePromise:
  | ReturnType<typeof createJobFinderWorkspaceServiceAsync>
  | undefined;
let overrideEnv: Partial<NodeJS.ProcessEnv> | null = null;
let closing = false;

/**
 * Starts the repository, browser, AI and the resume writer and Apply on
 * them, once. App start calls this after the first screen; the old
 * workspace service builds on the same runtime.
 */
export function startJobFinderRuntime(): Promise<JobFinderRuntime> {
  if (runtimePromise) return runtimePromise;
  if (closing) return Promise.reject(new Error("The workspace is closing."));
  const starting = createJobFinderRuntimeAsync(overrideEnv ?? undefined);
  runtimePromise = starting;
  void starting.catch(() => {
    if (runtimePromise === starting) runtimePromise = undefined;
  });
  return starting;
}

export function getJobFinderWorkspaceService() {
  if (servicePromise) return servicePromise;
  if (closing) return Promise.reject(new Error("The workspace is closing."));
  const creation = startJobFinderRuntime().then((runtime) =>
    createJobFinderWorkspaceServiceAsync(overrideEnv ?? undefined, runtime),
  );
  servicePromise = creation;
  void creation.catch(() => {
    if (servicePromise === creation) servicePromise = undefined;
  });
  return creation;
}

export function beginJobFinderWorkspaceShutdown(): void {
  closing = true;
}

export async function setJobFinderWorkspaceServiceTestEnv(
  env: Partial<NodeJS.ProcessEnv> | null,
) {
  await shutdownJobFinderWorkspaceService();
  overrideEnv = env;
  closing = false;
}

export async function shutdownJobFinderWorkspaceService() {
  const opening = servicePromise;
  const starting = runtimePromise;
  servicePromise = undefined;
  runtimePromise = undefined;
  if (!opening && !starting) return;
  const service = await opening?.catch((error: unknown) => {
    console.warn("[Desktop] Workspace did not open before shutdown.", error);
    return undefined;
  });
  if (service)
    await service.shutdown().catch((error: unknown) => {
      console.warn("[Desktop] Workspace shutdown failed.", error);
    });
  else {
    // Only the runtime started: stop its writers and close its repository.
    const runtime = await starting?.catch(() => undefined);
    runtime?.applicationService.stop();
    stopResumeService();
    await runtime?.jobFinderRepository.close().catch((error: unknown) => {
      console.warn("[Desktop] Workspace shutdown failed.", error);
    });
  }
  await shutdownDiscoveryFeedWorkers();
}
