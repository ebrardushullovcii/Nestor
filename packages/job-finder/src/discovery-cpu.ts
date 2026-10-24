export { preparePublicProviderFeed } from "./internal/workspace-source-intelligence";
export { setDiscoveryFeedExecutor } from "./internal/discovery-feed-executor";
import type { DiscoveryCpuTask, DiscoveryCpuResult } from "@nestor/contracts";
import { preparePublicProviderFeed } from "./internal/workspace-source-intelligence";
export async function runDiscoveryCpuTask(
  task: DiscoveryCpuTask,
): Promise<DiscoveryCpuResult> {
  return { kind: "feed", result: await preparePublicProviderFeed(task.input) };
}
