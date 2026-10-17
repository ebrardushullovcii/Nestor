import { describe, expect, it } from "vitest";
import {
  JobFinderRepositoryStateSchema,
  STARTER_JOB_SOURCES,
  evaluateProfileSetupReadiness,
  isRunnableJobDiscoveryTarget,
} from "@nestor/contracts";
import { createEmptyJobFinderRepositoryState } from "./job-finder-initial-state";

describe("createEmptyJobFinderRepositoryState fresh seed", () => {
  it("seeds no job sources so first-run setup asks for the sites the user uses", () => {
    const state = createEmptyJobFinderRepositoryState();
    const parsed = JobFinderRepositoryStateSchema.parse(state);
    const seededTargets = parsed.searchPreferences.discovery.targets;

    expect(seededTargets).toHaveLength(0);
    expect(STARTER_JOB_SOURCES.length).toBeGreaterThan(0);

    for (const target of seededTargets) {
      expect(target.instructionStatus).toBe("missing");
      expect(target.validatedInstructionId).toBeNull();
      // Seeding never creates a runnable source and never enables one.
      expect(isRunnableJobDiscoveryTarget(target)).toBe(false);
    }

    expect(
      evaluateProfileSetupReadiness(parsed.profile, parsed.searchPreferences)
        .hasDiscoverySource,
    ).toBe(false);
    expect(seededTargets.every((target) => !target.enabled)).toBe(true);
  });
});
