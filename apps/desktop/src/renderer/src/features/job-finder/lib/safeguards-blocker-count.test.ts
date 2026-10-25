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

  it("stops counting a company's conflict once every pair was allowed (STAB-006)", () => {
    const conflict = (allowedPairs: unknown[]) =>
      JobFinderIntelligenceSafeguardsSchema.parse({
        simultaneousApplicationConflicts: [
          {
            id: "conflict_company",
            applicationRecordId: "application_a",
            conflictingApplicationRecordId: "application_b",
            companyKey: "spool",
            companyName: "Spool Workshop",
            jobIds: ["job_a", "job_b"],
            allowedPairs,
            status: "detected",
            explanation: "Two roles at the same employer.",
            recoveryGuidance: "Choose in Safeguards.",
          },
        ],
      });

    expect(countActiveSafeguardBlockers(conflict([]))).toBe(1);
    // Send both anyway.
    expect(
      countActiveSafeguardBlockers(
        conflict([
          {
            jobIds: ["job_b", "job_a"],
            decidedAt: detectedAt,
            revokedAt: null,
          },
        ]),
      ),
    ).toBe(0);
    // A choice taken back holds again.
    expect(
      countActiveSafeguardBlockers(
        conflict([
          {
            jobIds: ["job_a", "job_b"],
            decidedAt: detectedAt,
            revokedAt: detectedAt,
          },
        ]),
      ),
    ).toBe(1);
  });
});
