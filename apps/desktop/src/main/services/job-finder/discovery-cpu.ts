import { setDiscoveryFeedExecutor } from "@nestor/job-finder/discovery-cpu";
import { createDiscoveryCpuPool } from "./discovery-cpu-pool";

let pool: ReturnType<typeof createDiscoveryCpuPool> | null = null;

export function installDiscoveryFeedWorkers(): void {
  const getPool = () =>
    (pool ??= createDiscoveryCpuPool(
      new URL("./discovery-cpu-worker.cjs", import.meta.url),
    ));
  setDiscoveryFeedExecutor((task, signal) => {
    return getPool().run(task, signal);
  });
}

export async function shutdownDiscoveryFeedWorkers(): Promise<void> {
  setDiscoveryFeedExecutor(null);
  const current = pool;
  pool = null;
  await current?.close();
}
