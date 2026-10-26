import { describe, expect, it } from "vitest";
import {
  JobFinderRepositoryStateSchema,
  evaluateProfileSetupReadiness,
} from "@nestor/contracts";
import { createEmptyJobFinderRepositoryState } from "./job-finder-initial-state";

describe("createEmptyJobFinderRepositoryState fresh seed", () => {
  it("seeds no job sources so first-run setup asks for the sites the user uses", () => {
    const state = createEmptyJobFinderRepositoryState();
    const parsed = JobFinderRepositoryStateSchema.parse(state);
    expect(parsed.searchPreferences.discovery.targets).toEqual([]);
    expect(
      evaluateProfileSetupReadiness(parsed.profile, parsed.searchPreferences)
        .hasDiscoverySource,
    ).toBe(false);
  });
});
