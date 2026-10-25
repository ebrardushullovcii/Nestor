import {
  JobFinderDiscoveryStateSchema,
  JobFinderIntelligenceStateSchema,
  ListingSignalRecordSchema,
} from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import { describe, expect, test } from "vitest";

import { createJobFinderWorkspaceService } from "./index";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createSeed,
} from "./workspace-service.test-support";

describe("workspace listing activity snapshots", () => {

  test("rebuilds the same derived activity after a service restart", async () => {
    const seed = createSeed();
    const savedJob = seed.savedJobs[0]!;
    seed.discovery = JobFinderDiscoveryStateSchema.parse({
      ...seed.discovery,
    });
    seed.intelligence = JobFinderIntelligenceStateSchema.parse({
      ...seed.intelligence,
      safeguards: {
        ...seed.intelligence.safeguards,
        listingSignals: [
          ListingSignalRecordSchema.parse({
            id: "signal-ready-closed",
            jobId: savedJob.id,
            signal: "closed",
            detail: "The provider returned an explicit closed state.",
            detectedAt: "2026-08-23T11:00:00.000Z",
            confidence: 1,
            provenance: "provider",
            explanation: "The listing is explicitly closed.",
            recoveryGuidance: "Review before reopening the listing.",
          }),
        ],
      },
    });
    const repository = createInMemoryJobFinderRepository(seed);
    const createService = () =>
      createJobFinderWorkspaceService({
        repository,
        browserRuntime: createBrowserRuntime(),
        aiClient: createAiClient(),
        documentManager: createDocumentManager(),
      });

    const beforeRestart = await createService().getWorkspaceSnapshot();
    const afterRestart = await createService().getWorkspaceSnapshot();
    const beforeActivity = beforeRestart.discoveryJobs.find(
      (job) => job.id === savedJob.id,
    )?.listingActivity;
    const afterActivity = afterRestart.discoveryJobs.find(
      (job) => job.id === savedJob.id,
    )?.listingActivity;

    expect(beforeActivity).toMatchObject({
      status: "closed",
      signalId: "signal-ready-closed",
      provenance: "provider",
      explanation: "The listing is explicitly closed.",
    });
    expect(afterActivity).toEqual(beforeActivity);
    expect("listingActivity" in (await repository.listSavedJobs())[0]!).toBe(
      false,
    );
  });

  test.each(["unknown", "stale", "inactive"] as const)(
    "allows a listing with %s activity through the shortlist service gate",
    async (activity) => {
      const seed = createSeed();
      const savedJob = seed.savedJobs[1]!;
      if (activity === "stale") {
        seed.intelligence = JobFinderIntelligenceStateSchema.parse({
          ...seed.intelligence,
          safeguards: {
            ...seed.intelligence.safeguards,
            listingSignals: [
              ListingSignalRecordSchema.parse({
                id: "signal-stale-gate",
                jobId: savedJob.id,
                signal: "stale",
                detail: "The listing date is old.",
                detectedAt: "2026-08-23T11:00:00.000Z",
                confidence: 0.8,
                provenance: "browser",
                explanation: "The listing may be stale.",
                recoveryGuidance: "Verify before applying.",
              }),
            ],
          },
        });
      }
      if (activity === "inactive") {
        seed.discovery = JobFinderDiscoveryStateSchema.parse({
          ...seed.discovery,
        });
      }
      const repository = createInMemoryJobFinderRepository(seed);
      const service = createJobFinderWorkspaceService({
        repository,
        browserRuntime: createBrowserRuntime(),
        aiClient: createAiClient(),
        documentManager: createDocumentManager(),
      });

      await expect(
        service.queueJobForReview(savedJob.id),
      ).resolves.toBeDefined();
    },
  );
});
