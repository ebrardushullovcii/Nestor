import { SPEED_LEVELS, speedLevelOf } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { createProfileServiceHarness } from "../profile-service.test-support";

describe("Speed setting", () => {
  it("is Standard by default and saved through the workspace behavior update", async () => {
    const { profileWork } = createProfileServiceHarness();
    const before = await profileWork.read();
    expect(speedLevelOf(before.settings)).toBe("standard");

    const faster = await profileWork.updateWorkspaceBehavior({
      speedLevel: "faster",
    });
    expect(speedLevelOf(faster.settings)).toBe("faster");
    expect(faster.settings.collapseSideMenuWithAssistant).toBe(
      before.settings.collapseSideMenuWithAssistant,
    );
  });

  it("gives each faster level more pages and applications", () => {
    const { standard, faster, maximum } = SPEED_LEVELS;
    for (const key of ["searchPages", "applyAtOnce", "waitingPages"] as const) {
      expect(faster[key]).toBeGreaterThan(standard[key]);
      expect(maximum[key]).toBeGreaterThan(faster[key]);
    }
  });

  it("sends fit checks at full concurrency at every level", () => {
    // Fit requests are network-bound and cost no memory, so a slower level
    // gains nothing by holding them back.
    const { standard, faster, maximum } = SPEED_LEVELS;
    expect(standard.fitRequests).toBe(maximum.fitRequests);
    expect(faster.fitRequests).toBe(maximum.fitRequests);
  });
});
