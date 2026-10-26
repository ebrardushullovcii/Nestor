import { createSeededRepository } from "../profile-service.test-support";
import { ProfileSetupStateSchema } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import { createSeed } from "../test-fixtures";
import { deriveAndPersistProfileSetupState } from "./profile-workspace-state";
import type { ProfileContext } from "./profile-context";

describe("profile workspace setup completion", () => {
  test("passes recorded search use into setup-state derivation", async () => {
    const seed = createSeed();
    const inProgressState = ProfileSetupStateSchema.parse({
      ...seed.profileSetupState,
      status: "in_progress",
      completedAt: null,
    });
    const repository = await createSeededRepository({
      ...seed,
      profileSetupState: inProgressState,
    });

    const result = await deriveAndPersistProfileSetupState(
      {
        repository,
        hasRunJobSearch: () => true,
        jobSites: { counts: () => ({ enabled: 1 }) },
      } as unknown as ProfileContext,
      {
        profile: seed.profile,
        searchPreferences: seed.searchPreferences,
        persistedState: inProgressState,
        persist: false,
      },
    );

    expect(result.status).toBe("completed");
    expect(result.completedAt).not.toBeNull();
  });
});
