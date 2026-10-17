import { describe, expect, it } from "vitest";
import type { MatchAssessment, SavedJob } from "@nestor/contracts";
import { createSavedJob } from "../workspace-service.test-fixtures";
import { getDiscoveryResultGroup } from "../discovery-result-bands";
import {
  isTargetTitleFamily,
  resolveTitleFamilyMatch,
} from "./discovery-title-family";

function assessment(overrides: Partial<MatchAssessment> = {}): MatchAssessment {
  return {
    scorerVersion: 9,
    score: 48,
    scoreIsUpperBound: false,
    contextFingerprint: "ctx",
    postingFingerprint: "post",
    compensationFit: {},
    locationReach: "unknown",
    dimensions: {},
    reasons: [],
    gaps: [],
    recommendation: "review_before_applying",
    recommendationRationale: "test",
    requirements: [],
    ...overrides,
  } as unknown as MatchAssessment;
}

function titleOnlyJob(matchAssessment: MatchAssessment): SavedJob {
  return createSavedJob({
    id: "job_family",
    source: "target_site",
    sourceJobId: "1",
    discoveryMethod: "browser_agent",
    canonicalUrl: "https://jobs.example.test/1",
    applicationUrl: null,
    title: "Executive Assistant I",
    company: "Example Co",
    location: "Chicago, IL",
    workMode: [],
    applyPath: "unknown",
    easyApplyEligible: false,
    postedAt: null,
    postedAtText: null,
    discoveredAt: "2026-09-05T09:58:00.000Z",
    firstSeenAt: "2026-09-05T09:58:00.000Z",
    lastSeenAt: "2026-09-05T09:58:00.000Z",
    lastVerifiedActiveAt: null,
    salaryText: null,
    summary: null,
    description: "Executive Assistant I",
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

describe("resolveTitleFamilyMatch", () => {
  it("reads the model's recorded role verdict", () => {
    expect(
      resolveTitleFamilyMatch(assessment({ titleFamilyMatch: "same_family" })),
    ).toBe("same_family");
    expect(
      resolveTitleFamilyMatch(assessment({ titleFamilyMatch: "unrelated" })),
    ).toBe("unrelated");
  });

  it("reads the same verdict from the role dimension", () => {
    expect(
      resolveTitleFamilyMatch(
        assessment({
          dimensions: {
            roleSuitability: { state: "adjacent" },
          } as MatchAssessment["dimensions"],
        }),
      ),
    ).toBe("adjacent");
  });

  it("reports null rather than 'unrelated' when the model has not judged it", () => {
    expect(resolveTitleFamilyMatch(assessment())).toBeNull();
    expect(isTargetTitleFamily(assessment())).toBe(false);
  });
});

describe("banding a job the model has not judged", () => {
  it("keeps it in the main results as not checked yet, never buried", () => {
    expect(getDiscoveryResultGroup(titleOnlyJob(assessment()))).toBe(
      "unchecked",
    );
  });
});
