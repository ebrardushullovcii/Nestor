import { createTestJobSites } from "./job-sites.test-support";
export { createTestJobSites } from "./job-sites.test-support";
import { createProfileServiceHarness } from "./profile-service.test-support";
import { createSeed } from "./test-fixtures";

export function createSourceDebugServiceHarness(
  options: Parameters<typeof createProfileServiceHarness>[0] = {},
) {
  const seed = options.seed ?? createSeed();
  const jobSites = createTestJobSites(seed.jobSites);
  return {
    ...createProfileServiceHarness({ ...options, seed, jobSites }),
    jobSites,
  };
}
