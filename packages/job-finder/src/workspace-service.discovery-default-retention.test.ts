import { afterEach, describe, expect, test, vi } from "vitest";
import { JobDiscoveryTargetSchema } from "@nestor/contracts";
import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

afterEach(() => vi.restoreAllMocks());

describe("default discovery retains collected listings", () => {
  test.each([
    { sources: 1, perSource: 130, budget: null, expected: 130 },
    { sources: 2, perSource: 70, budget: null, expected: 140 },
    { sources: 2, perSource: 70, budget: 3, expected: 3 },
  ])(
    "retention for %j",
    async ({ sources, perSource, budget, expected }) => {
      const seed = createSeed();
      seed.savedJobs = [];
      seed.discovery.pendingDiscoveryJobs = [];
      seed.discovery.discoveryLedger = [];
      seed.settings.discoveryOnly = false;
      seed.searchPreferences.companyWhitelist = [];
      seed.searchPreferences.companyBlacklist = [];
      seed.searchPreferences.excludedLocations = [];
      seed.searchPreferences.discovery.collectOnlyHardCriteriaMatches = false;
      seed.searchPreferences.discovery.runJobBudget = budget;
      seed.searchPreferences.discovery.targets = Array.from(
        { length: sources },
        (_, id) =>
          JobDiscoveryTargetSchema.parse({
            id: `board${id}`,
            label: `Board ${id}`,
            startingUrl: `https://job-boards.greenhouse.io/board${id}`,
          }),
      );
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation((request) => {
          const url =
            typeof request === "string"
              ? request
              : request instanceof URL
                ? request.href
                : request.url;
          const board = /\/boards\/(board\d+)/u.exec(url)?.[1] ?? "board0";
          return Promise.resolve(
            Response.json({
              jobs: Array.from({ length: perSource }, (_, id) => ({
                id,
                title:
                  id < 2
                    ? `Product Designer ${board}`
                    : `Product Designer ${board} ${id}`,
                absolute_url: `https://job-boards.greenhouse.io/${board}/jobs/${id}`,
                location: {
                  name:
                    id === 0
                      ? "Berlin, Germany"
                      : id === 1
                        ? "Paris, France"
                        : "Remote",
                },
                content: `<p>Build accessible product interfaces for project ${board}-${id}.</p>`,
              })),
            }),
          );
        });
      const { workspaceService, repository } = createWorkspaceServiceHarness({
        seed,
      });
      const snapshot = await workspaceService.runAgentDiscovery();
      const saved = await repository.listSavedJobs();
      expect(saved).toHaveLength(expected);
      expect(snapshot.recentDiscoveryRuns[0]?.summary.validJobsFound).toBe(
        expected,
      );
      expect(snapshot.recentDiscoveryRuns[0]?.targetExecutions).toHaveLength(
        sources,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(sources);
      if (budget === null) {
        expect(
          snapshot.recentDiscoveryRuns[0]?.targetExecutions.every(
            (source) => source.requestedJobBudget === null,
          ),
        ).toBe(true);
        // Same title at the same employer can be distinct roles in different cities.
        expect(
          saved
            .filter((job) => job.title === "Product Designer board0")
            .map((job) => job.location)
            .sort(),
        ).toEqual(["Berlin, Germany", "Paris, France"]);
      } else {
        expect(
          snapshot.recentDiscoveryRuns[0]?.targetExecutions.map(
            (source) => source.requestedJobBudget,
          ),
        ).toEqual([1, 2]);
      }
    },
    60_000,
  );
});
