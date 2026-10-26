import type { JobDiscoveryTarget } from "@nestor/contracts";
import { createJobSitesStore, openJobStore } from "@nestor/db/job-store";
import { afterEach } from "vitest";
const stores: ReturnType<typeof openJobStore>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

export function createTestJobStore() {
  const store = openJobStore(":memory:");
  stores.push(store);
  return store;
}

export function createTestJobSites(
  targets: readonly JobDiscoveryTarget[],
  store = createTestJobStore(),
) {
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
