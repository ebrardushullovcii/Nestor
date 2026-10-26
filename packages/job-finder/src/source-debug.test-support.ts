import { createTestJobSites } from "./job-sites.test-support";
export { createTestJobSites } from "./job-sites.test-support";
import { createSeed } from "./workspace-service.test-fixtures";
import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";

export function createSourceDebugServiceHarness(
  options: Parameters<typeof createWorkspaceServiceHarness>[0] = {},
) {
  const seed = options.seed ?? createSeed();
  const jobSites = createTestJobSites(seed.jobSites ?? []);
  return {
    ...createWorkspaceServiceHarness({ ...options, seed, jobSites }),
    jobSites,
  };
}
