import { describe, expect, it } from "vitest";
import { JobFinderIntelligenceSafeguardsSchema } from "@nestor/contracts";
import { countActiveSafeguardBlockers } from "./safeguards-blocker-count";

const detectedAt = "2026-08-15T10:00:00.000Z";

describe("countActiveSafeguardBlockers", () => {
  it("does not count a detected contradictory answer advisory", () => {
    const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
      contradictoryAnswerDetections: [
        {
          id: "detection_1",
          questionA: "How many years?",
          questionB: "Experience years?",
          answerA: "5",
          answerB: "2",
          contradictionScore: 0.9,
          status: "detected",
          detectedAt,
          resolvedAt: null,
          explanation: "Answers conflict.",
          recoveryGuidance: "Ask the user to confirm the correct answer.",
        },
      ],
    });

    expect(countActiveSafeguardBlockers(safeguards)).toBe(0);
  });

  it("still counts a genuine technical safeguard blocker", () => {
    const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
      abnormalFailurePauses: [
        {
          id: "pause_1",
          windowStartedAt: detectedAt,
          failuresInWindow: 4,
          sampleSize: 5,
          failureRatePercent: 80,
          failureRateThresholdPercent: 40,
          minimumSample: 5,
          paused: true,
          explanation: "Elevated application failure rate.",
          recoveryGuidance: "Inspect the latest failure evidence.",
        },
      ],
    });

    expect(countActiveSafeguardBlockers(safeguards)).toBe(1);
  });
});
