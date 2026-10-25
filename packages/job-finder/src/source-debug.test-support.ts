import type { JobDiscoveryTarget } from "@nestor/contracts";
import { createJobSitesStore, openJobStore } from "@nestor/db/job-store";
import { afterEach } from "vitest";
import { createSeed } from "./workspace-service.test-fixtures";
import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";

const stores: ReturnType<typeof openJobStore>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

export function createTestJobSites(targets: readonly JobDiscoveryTarget[]) {
  const store = openJobStore(":memory:");
  stores.push(store);
  const sites = createJobSitesStore(store);
  for (const target of targets) {
    const { firstAddedId } = sites.add({ text: target.startingUrl });
    if (firstAddedId === null) throw new Error("Duplicate fixture site.");
    sites.update({
      id: firstAddedId,
      label: target.label,
      enabled: target.enabled,
      customInstructions: target.customInstructions,
    });
    sites.record(firstAddedId, {
      instructionStatus: target.instructionStatus,
      validatedInstructionId: target.validatedInstructionId,
      draftInstructionId: target.draftInstructionId,
      lastDebugRunId: target.lastDebugRunId,
      lastVerifiedAt: target.lastVerifiedAt,
      staleReason: target.staleReason,
    });
  }
  return sites;
}

export function createSourceDebugServiceHarness(
  options: Parameters<typeof createWorkspaceServiceHarness>[0] = {},
) {
  const seed = options.seed ?? createSeed();
  const jobSites = createTestJobSites(
    seed.searchPreferences?.discovery.targets ?? [],
  );
  return {
    ...createWorkspaceServiceHarness({ ...options, seed, jobSites }),
    jobSites,
  };
}
