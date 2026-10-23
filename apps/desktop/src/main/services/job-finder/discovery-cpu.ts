import { setDiscoveryFeedExecutor } from "@nestor/job-finder/discovery-cpu";
import { createDiscoveryCpuPool } from "./discovery-cpu-pool";

let pool: ReturnType<typeof createDiscoveryCpuPool> | null = null;

export function installDiscoveryFeedWorkers(): void {
  setDiscoveryFeedExecutor((task, signal) => {
    pool ??= createDiscoveryCpuPool(
      new URL("./discovery-cpu-worker.cjs", import.meta.url),
    );
    return pool.run(task, signal);
  });
}

export async function shutdownDiscoveryFeedWorkers(): Promise<void> {
  setDiscoveryFeedExecutor(null);
  const current = pool;
  pool = null;
  await current?.close();
}
