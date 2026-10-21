import { afterEach, expect, test, vi } from "vitest";
import { JobDiscoveryTargetSchema } from "@nestor/contracts";

import {
  createAiClient,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

afterEach(() => vi.restoreAllMocks());

function seedWithTwoBoards() {
  const seed = createSeed();
  seed.savedJobs = [];
  seed.discovery.pendingDiscoveryJobs = [];
  seed.discovery.discoveryLedger = [];
  seed.settings.discoveryOnly = false;
  seed.searchPreferences.targetRoles = ["Product Designer"];
  seed.searchPreferences.locations = ["Berlin, Germany"];
  seed.searchPreferences.discovery.collectOnlyHardCriteriaMatches = false;
  seed.searchPreferences.discovery.targets = ["alpha", "beta"].map((board) =>
    JobDiscoveryTargetSchema.parse({
      id: board,
      label: `Board ${board}`,
      startingUrl: `https://job-boards.greenhouse.io/${board}-fixture`,
    }),
  );
  const fetched: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((request) => {
    const url = String(request instanceof Request ? request.url : request);
    fetched.push(url);
    const board = url.includes("alpha") ? "alpha" : "beta";
    return Promise.resolve(
      Response.json({
        jobs: [
          {
            id: board === "alpha" ? 1 : 2,
            title: "Product Designer",
            location: { name: "Berlin, DE" },
            absolute_url: `https://job-boards.greenhouse.io/${board}-fixture/jobs/${board === "alpha" ? 1 : 2}`,
            content:
              "Work with product managers and engineers on a planning product.",
            updated_at: "2026-10-20T09:00:00.000Z",
          },
        ],
      }),
    );
  });
  return { seed, fetched };
}

const searchedBoards = (fetched: readonly string[]) =>
  [...new Set(fetched.map((url) => (url.includes("alpha") ? "alpha" : "beta")))]
    .sort();

test("a search started again after it stopped skips the sources it already finished", async () => {
  const { seed, fetched } = seedWithTwoBoards();
  const { workspaceService, repository } = createWorkspaceServiceHarness({
    seed,
    aiClient: createAiClient(),
  });

  await workspaceService.runAgentDiscovery();
  expect(searchedBoards(fetched)).toEqual(["alpha", "beta"]);

  // The search stopped after alpha finished and while beta was running.
  await repository.commitDiscoveryStateUpdate((current) => {
    const [latest, ...older] = current.recentRuns;
    return {
      ...current,
      recentRuns: [
        {
          ...latest!,
          state: "cancelled",
          targetExecutions: latest!.targetExecutions.map((execution) =>
            execution.targetId === "beta"
              ? { ...execution, state: "cancelled" as const }
              : execution,
          ),
        },
        ...older,
      ],
    };
  });

  fetched.length = 0;
  await workspaceService.runAgentDiscovery();
  expect(searchedBoards(fetched)).toEqual(["beta"]);
  const restarted = (await repository.getDiscoveryState()).recentRuns[0]!;
  expect(restarted.targetIds).toEqual(["beta"]);
  expect(restarted.activity.map((event) => event.message)).toContain(
    "Continuing the search that stopped: 1 source it already finished is not searched again.",
  );

  // That search finished, so the next one searches every source again.
  fetched.length = 0;
  await workspaceService.runAgentDiscovery();
  expect(searchedBoards(fetched)).toEqual(["alpha", "beta"]);
}, 60_000);
