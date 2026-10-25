import { MatchAssessmentSchema, type MatchAssessment } from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import { createMatchAssessmentChangeAudit } from "./match-assessment-change-audit";

function createAssessment(
  overrides: Partial<MatchAssessment> = {},
): MatchAssessment {
  return MatchAssessmentSchema.parse({
    scorerVersion: 4,
    contextFingerprint: "match_context_v4_candidate",
    postingFingerprint: "match_posting_v4_listing",
    score: 82,
    compensationFit: {
      state: "meets_minimum",
      confidence: "high",
      minimumSalaryUsd: 90_000,
      listingMinimumAnnualUsd: 100_000,
      listingCurrency: "USD",
      explanation: "The comparable salary meets the saved minimum.",
    },
    dimensions: {
      roleSuitability: {
        state: "exact",
        explanation: "The title matches a saved target role.",
        evidence: [
          {
            source: "listing",
            label: "Role",
            detail: "Senior Software Engineer",
          },
        ],
      },
      preferenceAlignment: {
        state: "aligned",
        explanation: "The listing matches configured preferences.",
        evidence: [
          {
            source: "preference",
            label: "Work mode",
            detail: "Remote",
          },
        ],
      },
      applicationEffort: {
        level: "moderate",
        explanation: "The application uses a standard ATS form.",
        evidence: [
          {
            source: "listing",
            label: "Apply path",
            detail: "ATS form",
          },
        ],
      },
      evidenceConfidence: {
        level: "high",
        explanation: "Most required evidence is explicit.",
        evidence: [
          {
            source: "derived",
            label: "Coverage",
            detail: "1 of 1 required items supported",
          },
        ],
        supportedCount: 1,
        partialCount: 0,
        missingCount: 0,
        unknownCount: 0,
        conflictCount: 0,
      },
    },
    reasons: ["Target title matches", "Required skill is supported"],
    gaps: [],
    recommendation: "apply_with_original",
    recommendationRationale:
      "The original resume supports the required evidence.",
    requirements: [
      {
        id: "requirement_skill_typescript",
        category: "skill",
        label: "TypeScript",
        importance: "required",
        status: "supported",
        jobEvidence: "TypeScript is required.",
        resumeEvidence: [
          {
            sourceKind: "profile_skill",
            sourceId: null,
            label: "TypeScript",
            detail: "Saved profile skill",
          },
        ],
        explanation: "TypeScript appears in the saved profile.",
      },
    ],
    ...overrides,
  });
}

describe("createMatchAssessmentChangeAudit", () => {
  it("reports stable assessments without inventing a cause", () => {
    const assessment = createAssessment();

    const audit = createMatchAssessmentChangeAudit({
      previous: assessment,
      current: structuredClone(assessment),
    });

    expect(audit).toMatchObject({
      status: "unchanged",
      causeConfidence: "not_applicable",
      rankingSignalChanged: false,
      inputChanges: [],
      outputChanges: [],
      reasons: [],
    });
  });

  it("reports scorer and ranking-signal changes in deterministic order", () => {
    const previous = createAssessment({ scorerVersion: 3 });
    const current = createAssessment({
      scorerVersion: 4,
      score: 68,
      recommendation: "review_before_applying",
    });

    const audit = createMatchAssessmentChangeAudit({ previous, current });

    expect(audit.status).toBe("assessment_changed");
    expect(audit.causeConfidence).toBe("known");
    expect(audit.rankingSignalChanged).toBe(true);
    expect(audit.inputChanges.map((change) => change.code)).toEqual([
      "scorer_version_changed",
    ]);
    expect(
      audit.outputChanges.slice(0, 2).map((change) => change.code),
    ).toEqual(["score_changed", "recommendation_changed"]);
  });

  it("attributes a combined context fingerprint without guessing profile versus preferences", () => {
    const audit = createMatchAssessmentChangeAudit({
      previous: createAssessment({
        contextFingerprint: "match_context_v4_before",
      }),
      current: createAssessment({
        contextFingerprint: "match_context_v4_after",
      }),
    });

    const change = audit.inputChanges[0];
    expect(change).toMatchObject({
      code: "candidate_context_changed",
      scope: "candidate_context",
      certainty: "known",
    });
    expect(change?.detail).toContain("profile and/or search preferences");
    expect(change?.detail).toContain("does not identify which one changed");
    expect(change?.detail).not.toMatch(
      /the profile changed|the search preferences changed/iu,
    );
    expect(audit.status).toBe("inputs_changed_assessment_stable");
  });

  it("reports listing fingerprint changes as listing-evidence changes", () => {
    const audit = createMatchAssessmentChangeAudit({
      previous: createAssessment({
        postingFingerprint: "match_posting_v4_before",
      }),
      current: createAssessment({
        postingFingerprint: "match_posting_v4_after",
      }),
    });

    expect(audit.inputChanges).toEqual([
      expect.objectContaining({
        code: "listing_evidence_changed",
        certainty: "known",
        title: "Listing evidence changed",
      }),
    ]);
    expect(audit.status).toBe("inputs_changed_assessment_stable");
  });

  it("keeps missing legacy metadata unknown instead of claiming an input change", () => {
    const audit = createMatchAssessmentChangeAudit({
      previous: createAssessment({
        contextFingerprint: null,
        postingFingerprint: null,
      }),
      current: createAssessment(),
    });

    expect(audit.status).toBe("metadata_incomplete");
    expect(audit.causeConfidence).toBe("unknown");
    expect(audit.inputChanges.map((change) => change.code)).toEqual([
      "candidate_context_metadata_unknown",
      "listing_evidence_metadata_unknown",
    ]);
    expect(
      audit.inputChanges.every((change) => change.certainty === "unknown"),
    ).toBe(true);
  });

  it("reports dimensions and requirement changes with stable user-readable subjects", () => {
    const previous = createAssessment();
    const current = createAssessment({
      dimensions: {
        ...previous.dimensions,
        roleSuitability: {
          state: "adjacent",
          explanation: "The title is adjacent to a saved target role.",
          evidence: previous.dimensions.roleSuitability.evidence,
        },
        evidenceConfidence: {
          ...previous.dimensions.evidenceConfidence,
          level: "moderate",
          supportedCount: 0,
          missingCount: 1,
          explanation: "A required item is not supported.",
        },
      },
      requirements: [
        {
          ...previous.requirements[0]!,
          status: "missing",
          resumeEvidence: [],
          explanation: "TypeScript is not present in candidate evidence.",
        },
        {
          id: "requirement_experience_years",
          category: "experience",
          label: "Five years of experience",
          importance: "required",
          status: "partial",
          jobEvidence: "Five years of experience required.",
          resumeEvidence: [],
          explanation: "The saved timeline may not cover five years.",
        },
      ],
    });

    const audit = createMatchAssessmentChangeAudit({ previous, current });
    const codes = audit.outputChanges.map((change) => change.code);

    expect(codes).toEqual([
      "role_suitability_changed",
      "evidence_confidence_changed",
      "requirement_added",
      "requirement_status_changed",
      "requirement_evidence_changed",
    ]);
    expect(
      audit.outputChanges.find(
        (change) => change.code === "requirement_status_changed",
      ),
    ).toMatchObject({
      subject: "skill:typescript",
      previousValue: "supported",
      currentValue: "missing",
    });
  });

  it("ignores non-semantic requirement and evidence ordering changes", () => {
    const first = createAssessment();
    const secondRequirement = {
      id: "requirement_domain_fintech",
      category: "domain" as const,
      label: "Fintech",
      importance: "preferred" as const,
      status: "partial" as const,
      jobEvidence: "Fintech experience preferred.",
      resumeEvidence: [
        {
          sourceKind: "project" as const,
          sourceId: "project-payments",
          label: "Payments project",
          detail: "Built a payment reconciliation prototype.",
        },
        {
          sourceKind: "experience" as const,
          sourceId: "experience-platform",
          label: "Platform Engineer",
          detail: "Integrated billing services.",
        },
      ],
      explanation: "Candidate evidence is adjacent to fintech.",
    };
    const previous = createAssessment({
      requirements: [...first.requirements, secondRequirement],
    });
    const current = createAssessment({
      requirements: [
        {
          ...secondRequirement,
          id: "regenerated_requirement_id",
          resumeEvidence: [...secondRequirement.resumeEvidence].reverse(),
        },
        {
          ...first.requirements[0]!,
          id: "another_regenerated_id",
        },
      ],
    });

    const audit = createMatchAssessmentChangeAudit({ previous, current });

    expect(audit.status).toBe("unchanged");
    expect(audit.outputChanges).toEqual([]);
  });

  it("marks unexplained output changes when recorded inputs are identical", () => {
    const previous = createAssessment();
    const current = createAssessment({
      score: 79,
      reasons: ["Target title matches", "Evidence strength changed"],
    });

    const audit = createMatchAssessmentChangeAudit({ previous, current });

    expect(audit.status).toBe("assessment_changed_with_unknown_cause");
    expect(audit.causeConfidence).toBe("unknown");
    expect(audit.rankingSignalChanged).toBe(true);
    expect(audit.summary).toMatch(/exact cause is unknown/iu);
  });

  it("reports a rank-only change without inventing a change in this job", () => {
    const assessment = createAssessment();
    const audit = createMatchAssessmentChangeAudit({
      previous: assessment,
      current: structuredClone(assessment),
      previousRank: 5,
      currentRank: 2,
    });

    expect(audit).toMatchObject({
      status: "assessment_changed_with_unknown_cause",
      causeConfidence: "unknown",
      rankingSignalChanged: true,
      previousRank: 5,
      currentRank: 2,
    });
    expect(audit.outputChanges).toEqual([
      expect.objectContaining({
        code: "rank_position_changed",
        previousValue: "5",
        currentValue: "2",
      }),
    ]);
    expect(audit.reasons[0]).toContain("other jobs enter, leave, or change");
  });

  it("rejects invalid rank metadata", () => {
    expect(() =>
      createMatchAssessmentChangeAudit({
        previous: createAssessment(),
        current: createAssessment(),
        previousRank: 0,
      }),
    ).toThrow(/positive integer/iu);
  });
  it("normalizes assessments through the contract schema", () => {
    const invalid = {
      ...createAssessment(),
      score: 101,
    } as unknown as MatchAssessment;

    expect(() =>
      createMatchAssessmentChangeAudit({
        previous: createAssessment(),
        current: invalid,
      }),
    ).toThrow();
  });
});
