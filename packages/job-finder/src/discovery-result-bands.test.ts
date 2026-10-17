import { describe, expect, it } from "vitest";
import type { MatchAssessment, SavedJob } from "@nestor/contracts";

import { createSavedJob } from "./workspace-service.test-fixtures";
import {
  getDiscoveryResultGroup,
  isDiscoveryClearMismatch,
} from "./discovery-result-bands";

function scoredAssessment(
  overrides: Partial<MatchAssessment> = {},
): MatchAssessment {
  return {
    scorerVersion: 9,
    score: 24,
    scoreIsUpperBound: false,
    contextFingerprint: "ctx",
    postingFingerprint: "post",
    compensationFit: {},
    locationReach: "in_area",
    dimensions: {},
    reasons: [],
    gaps: [],
    recommendation: "review_before_applying",
    recommendationRationale: "test",
    // The model's verdict is what earns a printable percentage (ADR 0041),
    // so this row's band is decided by the score rather than by the
    // withheld-score path.
    judgment: {
      source: "batch",
      judgedAt: "2026-10-02T10:00:00.000Z",
      score: overrides.score ?? 24,
      recommendation: overrides.recommendation ?? "review_before_applying",
    },
    requirements: [
      {
        id: "req_paid_media",
        category: "skill",
        label: "Paid media campaign ownership",
        importance: "required",
        status: "partial",
        jobEvidence: "Owns paid media campaigns end to end.",
        resumeEvidence: [],
        explanation: "Some paid media ownership shown.",
      },
    ],
    ...overrides,
  } as unknown as MatchAssessment;
}

function chicagoJob(matchAssessment: MatchAssessment): SavedJob {
  return createSavedJob({
    id: "job_envisionit",
    source: "target_site",
    sourceJobId: "1",
    discoveryMethod: "browser_agent",
    canonicalUrl: "https://jobs.example.test/paid-media",
    applicationUrl: null,
    title: "Senior Paid Media Manager",
    company: "Envisionit",
    location: "Chicago, IL",
    workMode: ["hybrid"],
    applyPath: "unknown",
    easyApplyEligible: false,
    postedAt: null,
    postedAtText: null,
    discoveredAt: "2026-09-13T09:58:00.000Z",
    firstSeenAt: "2026-09-13T09:58:00.000Z",
    lastSeenAt: "2026-09-13T09:58:00.000Z",
    lastVerifiedActiveAt: null,
    salaryText: null,
    summary: null,
    description: "Own paid media campaigns for Chicago clients.",
    keySkills: [],
    responsibilities: [],
    minimumQualifications: [],
    preferredQualifications: [],
    seniority: null,
    employmentType: null,
    department: null,
    team: null,
    employerWebsiteUrl: null,
    employerDomain: null,
    atsProvider: null,
    keywordSignals: [],
    benefits: [],
    status: "discovered",
    matchAssessment,
    provenance: [],
  } as Parameters<typeof createSavedJob>[0]);
}

describe("banding a requested role in the requested place", () => {
  it("never calls a low-scoring adjacent-title job in the saved area a clear mismatch", () => {
    const job = chicagoJob(
      scoredAssessment({ titleFamilyMatch: "adjacent", score: 24 }),
    );

    expect(isDiscoveryClearMismatch(job)).toBe(false);
    expect(getDiscoveryResultGroup(job)).not.toBe("mismatches");
  });

  it("keeps the same protection for an exact title family in the saved area", () => {
    const job = chicagoJob(
      scoredAssessment({ titleFamilyMatch: "same_family", score: 12 }),
    );

    expect(isDiscoveryClearMismatch(job)).toBe(false);
    expect(getDiscoveryResultGroup(job)).not.toBe("mismatches");
  });

  it("still bands a low score as a clear mismatch outside the saved area", () => {
    const job = chicagoJob(
      scoredAssessment({
        titleFamilyMatch: "adjacent",
        locationReach: "outside_area",
        score: 24,
      }),
    );

    expect(isDiscoveryClearMismatch(job)).toBe(true);
  });

  it("still bands a low score as a clear mismatch for an unrelated title", () => {
    const job = chicagoJob(
      scoredAssessment({ titleFamilyMatch: "unrelated", score: 24 }),
    );

    expect(isDiscoveryClearMismatch(job)).toBe(true);
  });

  it("leaves the scorer's own skip verdict alone", () => {
    const job = chicagoJob(
      scoredAssessment({
        titleFamilyMatch: "adjacent",
        recommendation: "skip",
        score: 24,
      }),
    );

    expect(isDiscoveryClearMismatch(job)).toBe(true);
  });
});
