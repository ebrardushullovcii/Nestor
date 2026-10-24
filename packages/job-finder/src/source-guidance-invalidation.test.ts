import { describe, expect, test, vi } from "vitest";
import { DiscoveryRunResultSchema } from "@nestor/contracts";
import { SOURCE_URL_CHANGED_STALE_REASON } from "./internal/workspace-helpers";

import {
  createSeed,
  createWorkspaceServiceHarness,
  createBrowserRuntime,
  createSourceInstructionArtifact,
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
  test.each(["none", "custom", "validated", "retained-artifact"] as const)(
    "successful discovery resolves the URL warning only without saved guidance (%s)",
    async (guidance) => {
      const seed = createSeedWithValidatedSource();
      const target = seed.searchPreferences.discovery.targets[0]!;
      target.startingUrl = "https://other.example/jobs";
      target.staleReason = SOURCE_URL_CHANGED_STALE_REASON;
      target.instructionStatus = "missing";
      target.validatedInstructionId = guidance === "validated" ? "saved" : null;
      target.draftInstructionId = null;
      target.customInstructions =
        guidance === "custom" ? "Use the jobs tab" : null;
      if (guidance === "retained-artifact") {
        seed.sourceInstructionArtifacts = [
          createSourceInstructionArtifact({
            id: "old-guidance",
            targetId: target.id,
            basedOnRunId: "old-check",
            createdAt: "2026-07-31T10:00:00.000Z",
            updatedAt: "2026-07-31T10:00:00.000Z",
            navigationGuidance: ["Use the jobs tab"],
            versionInfo: {
              promptProfileVersion: "test",
              toolsetVersion: "test",
              adapterVersion: "test",
            },
          }),
        ];
      }
      const browserRuntime = createBrowserRuntime();
      browserRuntime.runAgentDiscovery = vi.fn(() =>
        Promise.resolve(
          DiscoveryRunResultSchema.parse({
            source: "target_site",
            querySummary: "Fresh source completed",
            jobs: [],
            warning: null,
            inventoryCompleteness: "complete",
            startedAt: "2026-10-25T00:00:00.000Z",
            completedAt: "2026-10-25T00:00:01.000Z",
          }),
        ),
      );
      const { workspaceService, repository } = createWorkspaceServiceHarness({
        seed,
        browserRuntime,
      });
      const snapshot = await workspaceService.runAgentDiscovery();
      expect(snapshot.recentDiscoveryRuns[0]?.targetExecutions[0]?.state).toBe(
        "completed",
      );
      const expected =
        guidance === "none" ? null : SOURCE_URL_CHANGED_STALE_REASON;
      expect(
        (await repository.getSearchPreferences()).discovery.targets[0]
          ?.staleReason,
      ).toBe(expected);
      expect(
        (await repository.getCampaignState())?.campaigns[0]?.searchPreferences
          .discovery.targets[0]?.staleReason,
      ).toBe(expected);
    },
  );

  test("a failed source keeps its URL warning", async () => {
    const seed = createSeedWithValidatedSource();
    const target = seed.searchPreferences.discovery.targets[0]!;
    target.staleReason = SOURCE_URL_CHANGED_STALE_REASON;
    target.validatedInstructionId = null;
    target.draftInstructionId = null;
    const browserRuntime = createBrowserRuntime();
    browserRuntime.runAgentDiscovery = vi.fn(() =>
      Promise.reject(new Error("Source unavailable")),
    );
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
    });
    await expect(workspaceService.runAgentDiscovery()).rejects.toThrow(
      "Source unavailable",
    );
    expect(
      (await repository.getSearchPreferences()).discovery.targets[0]
        ?.staleReason,
    ).toBe(SOURCE_URL_CHANGED_STALE_REASON);
  });

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
