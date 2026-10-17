import {
  DiscoveryRunRecordSchema,
  JobFinderDiscoveryStateSchema,
  ProfileSetupStateSchema,
} from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import { describe, expect, test } from "vitest";

import { createSeed } from "../workspace-service.test-fixtures";
import { deriveAndPersistProfileSetupState } from "./profile-workspace-state";
import type { WorkspaceServiceContext } from "./workspace-service-context";

describe("profile workspace setup completion", () => {
  test("passes recorded search use into setup-state derivation", async () => {
    const seed = createSeed();
    const inProgressState = ProfileSetupStateSchema.parse({
      ...seed.profileSetupState,
      status: "in_progress",
      completedAt: null,
    });
    const repository = createInMemoryJobFinderRepository({
      ...seed,
      profileSetupState: inProgressState,
      discovery: JobFinderDiscoveryStateSchema.parse({
        ...seed.discovery,
        recentRuns: [
          DiscoveryRunRecordSchema.parse({
            id: "discovery_setup_completed_1",
            campaignId: null,
            state: "completed",
            startedAt: "2026-09-13T08:00:00.000Z",
            completedAt: "2026-09-13T08:00:10.000Z",
            targetIds: ["target_linkedin_default"],
            targetExecutions: [],
            activity: [],
          }),
        ],
      }),
    });

    try {
      const result = await deriveAndPersistProfileSetupState(
        { repository } as unknown as WorkspaceServiceContext,
        {
          profile: seed.profile,
          searchPreferences: seed.searchPreferences,
          persistedState: inProgressState,
          persist: false,
        },
      );

      expect(result.status).toBe("completed");
      expect(result.completedAt).not.toBeNull();
    } finally {
      await repository.close();
    }
  });
});
