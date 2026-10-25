import { describe, expect, test, } from "vitest";

import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

function createSeedWithValidatedSource() {
  const seed = createSeed();
  seed.searchPreferences.discovery.targets = [
    {
      id: "target_company",
      label: "Company careers",
      startingUrl: "https://example.com/jobs",
      enabled: true,
      adapterKind: "auto",
      customInstructions: null,
      instructionStatus: "validated",
      validatedInstructionId: "instruction_validated",
      draftInstructionId: "instruction_draft",
      lastDebugRunId: "debug_run",
      lastVerifiedAt: "2026-07-31T10:00:00.000Z",
      staleReason: null,
    },
  ];
  return seed;
}

describe("source guidance invalidation", () => {

  test.each(["preferences", "profile-and-preferences"] as const)(
    "clears stale source guidance through the %s save path",
    async (savePath) => {
      const seed = createSeedWithValidatedSource();
      const { workspaceService } = createWorkspaceServiceHarness({ seed });
      const nextPreferences = {
        ...seed.searchPreferences,
        discovery: {
          ...seed.searchPreferences.discovery,
          targets: seed.searchPreferences.discovery.targets.map((target) => ({
            ...target,
            startingUrl: "https://other.example/jobs",
          })),
        },
      };

      const snapshot =
        savePath === "preferences"
          ? await workspaceService.saveSearchPreferences(nextPreferences)
          : await workspaceService.saveProfileAndSearchPreferences(
              seed.profile,
              nextPreferences,
            );

      expect(snapshot.searchPreferences.discovery.targets[0]).toMatchObject({
        startingUrl: "https://other.example/jobs",
        instructionStatus: "missing",
        validatedInstructionId: null,
        draftInstructionId: null,
        lastDebugRunId: null,
        lastVerifiedAt: null,
        staleReason:
          "Starting page URL changed. Check this source again before reusing saved guidance.",
      });
    },
  );
});
