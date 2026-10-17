import { MatchAssessmentSchema, type SavedJob } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import {
  FIT_NOT_JUDGED_REASON,
  FIT_UNASSESSED_REASON,
  FIT_UPPER_BOUND_REASON,
  getFitEvidenceDepth,
  getMatchAssessmentPresentation,
  getRoleAndRequirementsStatus,
} from "./match-assessment-presentation";

type PresentationInput = Pick<SavedJob, "discoveryMethod" | "matchAssessment">;

const boundFingerprints = {
  contextFingerprint: "match_context_v4_candidate",
  postingFingerprint: "match_posting_v4_listing",
};

function titleOnlyJob(): PresentationInput {
  return {
    discoveryMethod: "browser_agent",
    matchAssessment: MatchAssessmentSchema.parse({
      score: 54,
      ...boundFingerprints,
    }),
  };
}

/**
 * The shape `createMatchAssessment` actually emits for a listing whose text
 * was never captured. The bare fixture above passed for months while this one
 * printed a bare percentage in the app: a saved-preference location
 * requirement existed but was never decided, and "mixed" preference alignment
 * was reached only because an absence placeholder had been read as a real
 * place. Both are counted as "not verified" now.
 */
function realEngineTitleOnlyJob(): PresentationInput {
  return {
    discoveryMethod: "browser_agent",
    matchAssessment: MatchAssessmentSchema.parse({
      score: 54,
      ...boundFingerprints,
      compensationFit: { state: "unknown" },
      dimensions: {
        roleSuitability: {
          state: "adjacent",
          explanation:
            "The title matches, but the listing text was not captured, so nothing beyond the title could be checked.",
        },
        preferenceAlignment: { state: "unknown" },
        evidenceConfidence: { level: "unavailable" },
      },
      requirements: [
        {
          id: "location_not_stated",
          category: "location",
          label: "Location (not stated in listing)",
          importance: "required",
          status: "unknown",
          jobEvidence: "The listing does not state a location.",
          resumeEvidence: [],
          explanation:
            "The listing does not state a location, so it could not be compared with the saved search areas.",
        },
      ],
    }),
  };
}

function checkedJob(): PresentationInput {
  return {
    discoveryMethod: "browser_agent",
    matchAssessment: MatchAssessmentSchema.parse({
      score: 78,
      ...boundFingerprints,
      judgment: {
        source: "batch",
        judgedAt: "2026-10-02T10:00:00.000Z",
        score: 78,
        recommendation: "review_before_applying",
      },
      dimensions: {
        roleSuitability: {
          state: "exact",
          explanation: "The listing title matches a saved target role.",
          evidence: [],
        },
      },
      requirements: [
        {
          id: "skill_figma",
          category: "skill",
          label: "Figma",
          importance: "required",
          status: "supported",
          jobEvidence: "Figma is used daily.",
          resumeEvidence: [],
          explanation: "The resume contains explicit Figma evidence.",
        },
      ],
    }),
  };
}

function unboundJob(): PresentationInput {
  return {
    discoveryMethod: "catalog_seed",
    matchAssessment: MatchAssessmentSchema.parse({ score: 70 }),
  };
}

describe("getFitEvidenceDepth", () => {
  it("reports a job without a model verdict as not judged", () => {
    expect(getFitEvidenceDepth(titleOnlyJob().matchAssessment)).toEqual({
      isNotJudged: true,
      reason: FIT_NOT_JUDGED_REASON,
      verifiedDimensionCount: 0,
    });
  });

  it("counts an undecided saved-preference requirement as no evidence at all", () => {
    expect(
      getFitEvidenceDepth(realEngineTitleOnlyJob().matchAssessment),
    ).toEqual({
      isNotJudged: true,
      reason: FIT_NOT_JUDGED_REASON,
      verifiedDimensionCount: 0,
    });
  });

  it("needs the model's verdict, not only decided requirements, to earn a number", () => {
    const job = realEngineTitleOnlyJob();
    const withRequirement = {
      ...job.matchAssessment,
      requirements: [
        ...job.matchAssessment.requirements,
        {
          id: "skill_typescript",
          category: "skill" as const,
          label: "TypeScript",
          importance: "required" as const,
          status: "conflict" as const,
          jobEvidence: "TypeScript is required.",
          resumeEvidence: [],
          explanation: "The resume shows no TypeScript evidence.",
        },
      ],
    };
    expect(getFitEvidenceDepth(withRequirement).isNotJudged).toBe(true);
    expect(
      getFitEvidenceDepth({
        ...withRequirement,
        judgment: checkedJob().matchAssessment.judgment,
      }).isNotJudged,
    ).toBe(false);
  });

  it("tolerates a partial payload instead of throwing", () => {
    expect(
      getFitEvidenceDepth({
        score: 40,
      } as unknown as PresentationInput["matchAssessment"]).isNotJudged,
    ).toBe(true);
  });
});

describe("getMatchAssessmentPresentation", () => {
  it("withholds the percentage until the model has judged the job", () => {
    const presentation = getMatchAssessmentPresentation(titleOnlyJob());

    expect(presentation.isNotJudged).toBe(true);
    expect(presentation.isScoreWithheld).toBe(true);
    expect(presentation.headlineScoreLabel).toBe("Not judged yet");
    expect(presentation.headlineScoreLabel).not.toContain("54");
    expect(presentation.headlineScoreAriaLabel).toBe(
      "Overall fit: not judged yet",
    );
    // No number appears anywhere until the model has judged the job.
    expect(presentation.breakdownScoreLabel).toBeNull();
    expect(presentation.withheldReason).toBe(FIT_NOT_JUDGED_REASON);
  });

  it("never prints a number in the inspector that the row withholds", () => {
    const presentation = getMatchAssessmentPresentation(titleOnlyJob());

    expect(presentation.headlineScoreAriaLabel).not.toContain("not scored");
    expect(presentation.breakdownScoreLabel).toBeNull();
  });

  it("withholds the percentage for the real card-only engine output", () => {
    const presentation = getMatchAssessmentPresentation(
      realEngineTitleOnlyJob(),
    );

    expect(presentation.headlineScoreLabel).toBe("Not judged yet");
    expect(presentation.headlineScoreLabel).not.toContain("54");
    expect(presentation.breakdownScoreLabel).toBeNull();
  });

  it("qualifies a score that stopped at a gap's ceiling", () => {
    // Unrelated jobs kept printing an identical "71% fit" because several
    // ceilings land on the same number; the ceiling is not a measurement.
    const presentation = getMatchAssessmentPresentation({
      ...checkedJob(),
      matchAssessment: MatchAssessmentSchema.parse({
        ...checkedJob().matchAssessment,
        score: 71,
        scoreIsUpperBound: true,
      }),
    });

    expect(presentation.isScoreWithheld).toBe(false);
    expect(presentation.headlineScoreLabel).toBe("Up to 71% fit");
    expect(presentation.headlineScoreAriaLabel).toBe(
      "Overall fit: up to 71 percent",
    );
    expect(presentation.breakdownScoreLabel).toBe("Up to 71% fit");
    expect(presentation.withheldReason).toBe(FIT_UPPER_BOUND_REASON);
  });

  it("withholds any number at all for an unbound assessment", () => {
    const presentation = getMatchAssessmentPresentation(unboundJob());

    expect(presentation.isProvisional).toBe(true);
    expect(presentation.headlineScoreLabel).toBe("Fit not assessed");
    expect(presentation.breakdownScoreLabel).toBeNull();
    expect(presentation.withheldReason).toBe(FIT_UNASSESSED_REASON);
  });

  it("prints the percentage once the model has judged the job", () => {
    const presentation = getMatchAssessmentPresentation(checkedJob());

    expect(presentation.isScoreWithheld).toBe(false);
    expect(presentation.headlineScoreLabel).toBe("78% fit");
    expect(presentation.breakdownScoreLabel).toBe("78% fit");
    expect(presentation.withheldReason).toBeNull();
  });
});

describe("getRoleAndRequirementsStatus", () => {
  const requirement = (status: "supported" | "missing" | "partial") => ({
    status,
  });

  it("never says Strong match above evidence that does not support it", () => {
    // The line printed underneath reads "1 of 3 supported".
    expect(
      getRoleAndRequirementsStatus("exact", [
        requirement("supported"),
        requirement("missing"),
        requirement("partial"),
      ]),
    ).toEqual({ label: "Partial match", tone: "active" });
  });

  it("says the evidence is missing when nothing is supported", () => {
    expect(
      getRoleAndRequirementsStatus("exact", [
        requirement("missing"),
        requirement("missing"),
      ]),
    ).toEqual({ label: "Needs evidence", tone: "critical" });
  });

  it("keeps the title verdict when every requirement is supported", () => {
    expect(
      getRoleAndRequirementsStatus("exact", [
        requirement("supported"),
        requirement("supported"),
      ]),
    ).toEqual({ label: "Strong match", tone: "positive" });
  });

  it("keeps the title verdict when there is nothing to compare", () => {
    expect(getRoleAndRequirementsStatus("exact", [])).toEqual({
      label: "Strong match",
      tone: "positive",
    });
    expect(
      getRoleAndRequirementsStatus("conflict", [requirement("missing")]),
    ).toEqual({ label: "Role conflict", tone: "critical" });
  });
});
