import { shutdownDiscoveryFeedWorkers } from "./discovery-cpu";
import { createJobFinderWorkspaceServiceAsync } from "./create-workspace-service";

let servicePromise:
  | ReturnType<typeof createJobFinderWorkspaceServiceAsync>
  | undefined;
let overrideEnv: Partial<NodeJS.ProcessEnv> | null = null;
let closing = false;

export function getJobFinderWorkspaceService() {
  if (servicePromise) return servicePromise;
  if (closing) return Promise.reject(new Error("The workspace is closing."));
  const creation = createJobFinderWorkspaceServiceAsync(
    overrideEnv ?? undefined,
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
  servicePromise = undefined;
  if (!opening) return;
  const service = await opening.catch((error: unknown) => {
    console.warn("[Desktop] Workspace did not open before shutdown.", error);
    return undefined;
  });
  if (service)
    await service.shutdown().catch((error: unknown) => {
      console.warn("[Desktop] Workspace shutdown failed.", error);
    });
  await shutdownDiscoveryFeedWorkers();
}
