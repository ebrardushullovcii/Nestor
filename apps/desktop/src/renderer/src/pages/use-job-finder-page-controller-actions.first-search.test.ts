import { describe, expect, it } from "vitest";

import { shouldStartFirstSearchAfterSetup } from "./use-job-finder-page-controller-actions";

type Input = Parameters<typeof shouldStartFirstSearchAfterSetup>[0];

function workspace(overrides: {
  targets?: unknown[];
  recentDiscoveryRuns?: unknown[];
  activeDiscoveryRun?: unknown;
}): Input {
  return {
    activeDiscoveryRun: overrides.activeDiscoveryRun ?? null,
    recentDiscoveryRuns: overrides.recentDiscoveryRuns ?? [],
    searchPreferences: {
      discovery: {
        targets: overrides.targets ?? [
          {
            id: "target_board",
            label: "Board",
            startingUrl: "https://jobs.example.test/",
            enabled: true,
            adapterKind: "auto",
          },
        ],
      },
    },
  } as unknown as Input;
}

describe("shouldStartFirstSearchAfterSetup", () => {
  it("starts the first search when setup finishes with a source and no search yet", () => {
    expect(shouldStartFirstSearchAfterSetup(workspace({}))).toBe(true);
  });

  it("never starts one when a search already ran or is running", () => {
    expect(
      shouldStartFirstSearchAfterSetup(
        workspace({ recentDiscoveryRuns: [{ id: "run_1" }] }),
      ),
    ).toBe(false);
    expect(
      shouldStartFirstSearchAfterSetup(
        workspace({ activeDiscoveryRun: { id: "run_live" } }),
      ),
    ).toBe(false);
  });

  it("does not start one without a source that can be searched", () => {
    expect(shouldStartFirstSearchAfterSetup(workspace({ targets: [] }))).toBe(
      false,
    );
  });
});
