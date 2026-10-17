import { FitJudgmentSchema, MatchAssessmentSchema } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  applyFitJudgment,
  preserveCompletedAssessment,
} from "./fit-judgment-apply";

const at = "2026-10-03T10:00:00.000Z";

function judgment(overrides: Record<string, unknown>) {
  return FitJudgmentSchema.parse({
    source: "batch",
    judgedAt: at,
    score: 40,
    recommendation: "skip",
    role: "exact",
    roleExplanation: "This is the Product Designer work you are looking for.",
    preferences: "conflict",
    locationReach: "outside_area",
    ...overrides,
  });
}

describe("a verdict on a job card (ADR 0041)", () => {
  test("says the model's own reason for its recommendation", () => {
    const applied = applyFitJudgment(
      MatchAssessmentSchema.parse({ score: 0, reasons: [], gaps: [] }),
      judgment({
        summary: "Austin is outside the places you are looking in.",
      }),
    );

    expect(applied.recommendationRationale).toBe(
      "Austin is outside the places you are looking in.",
    );
  });

  test("a verdict saved before the model gave a reason keeps the old wording", () => {
    const applied = applyFitJudgment(
      MatchAssessmentSchema.parse({ score: 0, reasons: [], gaps: [] }),
      judgment({ gaps: ["Needs presence in Austin, Texas."] }),
    );

    expect(applied.recommendationRationale).toBe(
      "Needs presence in Austin, Texas.",
    );
  });
});

describe("completed assessment preservation (R3-019)", () => {
  const full = {
    ...applyFitJudgment(
      MatchAssessmentSchema.parse({ score: 0, reasons: [], gaps: [] }),
      judgment({ source: "full", score: 58 }),
    ),
    requirementsSource: "model" as const,
  };
  test("does not replace a full read with a later card judgment or no verdict", () => {
    const shallow = applyFitJudgment(
      MatchAssessmentSchema.parse({ score: 0, reasons: [], gaps: [] }),
      judgment({ score: 85, judgedAt: "2026-10-04T00:00:00.000Z" }),
    );
    expect(preserveCompletedAssessment(full, shallow)).toBe(full);
    expect(
      preserveCompletedAssessment(
        full,
        MatchAssessmentSchema.parse({ score: 0, reasons: [], gaps: [] }),
      ),
    ).toBe(full);
  });
  test("accepts a completed later full read, but refuses an older one", () => {
    const later = applyFitJudgment(
      full,
      judgment({
        source: "full",
        score: 32,
        judgedAt: "2026-10-04T00:00:00.000Z",
      }),
    );
    expect(preserveCompletedAssessment(full, later)).toBe(later);
    expect(preserveCompletedAssessment(later, full)).toBe(later);
  });
});

test.each([
  { contextFingerprint: "goals-B", postingFingerprint: "listing-A" },
  { contextFingerprint: "goals-A", postingFingerprint: "listing-B" },
])(
  "accepts a fresh batch under changed context or listing: %s",
  (fingerprints) => {
    const full = applyFitJudgment(
      MatchAssessmentSchema.parse({ score: 0, reasons: [], gaps: [] }),
      judgment({
        source: "full",
        contextFingerprint: "goals-A",
        postingFingerprint: "listing-A",
      }),
    );
    const batch = applyFitJudgment(
      full,
      judgment({
        ...fingerprints,
        source: "batch",
        judgedAt: "2026-10-02T00:00:00.000Z",
        score: 25,
      }),
    );
    expect(preserveCompletedAssessment(full, batch)).toBe(batch);
  },
);
