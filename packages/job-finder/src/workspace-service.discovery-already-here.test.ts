import { describe, expect, test } from "vitest";
import { createSeed } from "./workspace-service.test-fixtures";
import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";

/**
 * "Already here" is a statement about the workspace before the search: these
 * listings were already in this plan. A first-ever search on an empty
 * workspace reported 47 of them, because the counter behind it was the run's
 * duplicate tally — listings the run met twice while two sources overlapped,
 * or the same card read twice by one source. Those are two different facts and
 * a person cannot act on either while they share a number.
 */
function createEmptyWorkspaceSeedWithTwoSources() {
  const seed = createSeed();
  const [firstTarget] = seed.searchPreferences.discovery.targets;
  if (!firstTarget) {
    throw new Error("Expected the fixture to configure one discovery target.");
  }

  return {
    ...seed,
    savedJobs: [],
    reviewQueue: [],
    applicationRecords: [],
    searchPreferences: {
      ...seed.searchPreferences,
      discovery: {
        ...seed.searchPreferences.discovery,
        targets: [
          firstTarget,
          {
            ...firstTarget,
            id: "target_second_board",
            label: "Second board",
            startingUrl: "https://jobs.example.test/search",
          },
        ],
      },
    },
  };
}

describe("what a first search says it already had", () => {
  test("counts nothing as already here and reports the repeats as duplicates", async () => {
    const harness = createWorkspaceServiceHarness({
      seed: createEmptyWorkspaceSeedWithTwoSources(),
    });
    const before = await harness.workspaceService.getWorkspaceSnapshot();
    expect(before.discoveryJobs).toHaveLength(0);

    await harness.workspaceService.runDiscovery();

    const discovery = await harness.repository.getDiscoveryState();
    const report = discovery.recentRuns[0]?.summary.report;
    if (!report) {
      throw new Error("Expected the finished run to freeze its own report.");
    }

    // Nothing existed before this run, so nothing can have been here already.
    expect(report.alreadyHere).toBe(0);
    // The same listings reached the run through both sources; that is a
    // duplicate merged inside the run, and it is reported as one.
    expect(report.duplicates).toBeGreaterThan(0);
  }, 120_000);
});
