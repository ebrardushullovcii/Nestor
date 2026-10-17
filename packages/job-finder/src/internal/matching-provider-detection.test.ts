import { describe, expect, test } from "vitest";
import {
  JobPostingSchema,
  MatchAssessmentSchema,
  type JobPosting,
} from "@nestor/contracts";

import { mergeDiscoveredJob } from "./matching";

const BASE_ASSESSMENT = MatchAssessmentSchema.parse({
  score: 70,
  reasons: [],
  gaps: [],
});

function createProviderDetectionPosting(
  overrides: Partial<JobPosting> = {},
): JobPosting {
  return JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: "provider_detection_listing",
    canonicalUrl: "https://careers.acme.example/jobs/engineer",
    title: "Software Engineer",
    company: "Acme",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    discoveredAt: "2026-08-20T09:00:00.000Z",
    salaryText: null,
    description: "Build reliable distributed systems.",
    ...overrides,
  });
}

function detectAtsProviderLabel(overrides: Partial<JobPosting>): string | null {
  return mergeDiscoveredJob(
    BASE_ASSESSMENT,
    createProviderDetectionPosting(overrides),
    undefined,
  ).atsProvider;
}

describe("ATS provider detection from parsed hostnames", () => {
  test("labels sanctioned provider hosts across subdomains", () => {
    expect(
      detectAtsProviderLabel({
        canonicalUrl: "https://boards.greenhouse.io/acme/jobs/1",
      }),
    ).toBe("Greenhouse");
    expect(
      detectAtsProviderLabel({
        canonicalUrl: "https://job-boards.greenhouse.io/acme/jobs/1",
      }),
    ).toBe("Greenhouse");
    expect(
      detectAtsProviderLabel({
        canonicalUrl: "https://jobs.lever.co/acme/abc123",
      }),
    ).toBe("Lever");
    expect(
      detectAtsProviderLabel({
        canonicalUrl: "https://jobs.eu.lever.co/acme/abc123",
      }),
    ).toBe("Lever");
    expect(
      detectAtsProviderLabel({
        canonicalUrl:
          "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Engineer_R1001",
      }),
    ).toBe("Workday");
    expect(
      detectAtsProviderLabel({
        canonicalUrl: "https://jobs.ashbyhq.com/acme/abc123",
      }),
    ).toBe("Ashby");
    expect(
      detectAtsProviderLabel({
        canonicalUrl: "https://acme.icims.com/jobs/i1001",
      }),
    ).toBe("iCIMS");
    expect(
      detectAtsProviderLabel({
        canonicalUrl: "https://acme.icims.eu/jobs/i1001",
      }),
    ).toBe("iCIMS");
  });

  test("normalizes case, trailing dot, and IDN separators through URL parsing", () => {
    expect(
      detectAtsProviderLabel({
        canonicalUrl: "HTTPS://JOBS.LEVER.CO/acme/abc123",
      }),
    ).toBe("Lever");
    expect(
      detectAtsProviderLabel({
        canonicalUrl: "https://boards.greenhouse.io./acme/jobs/1",
      }),
    ).toBe("Greenhouse");
    expect(
      detectAtsProviderLabel({
        canonicalUrl: "https://jobs。lever.co/acme/abc123",
      }),
    ).toBe("Lever");
  });

  test("rejects deceptive and lookalike hosts", () => {
    expect(
      detectAtsProviderLabel({
        canonicalUrl: "https://greenhouse.io.evil.example/jobs/1",
      }),
    ).toBeNull();
    expect(
      detectAtsProviderLabel({
        canonicalUrl: "https://evilgreenhouse.io/jobs/1",
      }),
    ).toBeNull();
    expect(
      detectAtsProviderLabel({
        canonicalUrl: "https://jobs.lever.co.evil.example/acme/abc123",
      }),
    ).toBeNull();
  });

  test("ignores brand words in paths, queries, and userinfo", () => {
    expect(
      detectAtsProviderLabel({
        canonicalUrl:
          "https://careers.acme.example/jobs/workday-platform-engineer",
      }),
    ).toBeNull();
    expect(
      detectAtsProviderLabel({
        canonicalUrl:
          "https://careers.acme.example/jobs/1?ats=greenhouse&board=ashby",
      }),
    ).toBeNull();
    expect(
      detectAtsProviderLabel({
        canonicalUrl: "https://user:greenhouse@careers.acme.example/jobs/1",
      }),
    ).toBeNull();
  });

  test("skips malformed and unsupported-protocol candidates", () => {
    expect(detectAtsProviderLabel({ canonicalUrl: "not-a-url" })).toBeNull();
    expect(
      detectAtsProviderLabel({
        canonicalUrl: "ftp://boards.greenhouse.io/acme/jobs/1",
      }),
    ).toBeNull();
  });

  test("returns null for unknown custom career domains", () => {
    expect(
      detectAtsProviderLabel({
        canonicalUrl: "https://careers.acme.example/jobs/engineer",
      }),
    ).toBeNull();
  });

  test("prefers the first supported candidate URL", () => {
    expect(
      detectAtsProviderLabel({
        applicationUrl: "https://boards.greenhouse.io/acme/jobs/1",
        canonicalUrl: "https://jobs.lever.co/acme/abc123",
      }),
    ).toBe("Greenhouse");
    expect(
      detectAtsProviderLabel({
        applicationUrl: "https://careers.acme.example/jobs/1",
        canonicalUrl: "https://jobs.ashbyhq.com/acme/abc123",
      }),
    ).toBe("Ashby");
    expect(
      detectAtsProviderLabel({
        applicationUrl: "https://careers.acme.example/jobs/apply",
        canonicalUrl: "https://careers.acme.example/jobs/1",
        employerWebsiteUrl: "https://acme.wd5.myworkdayjobs.com/en-US/External",
      }),
    ).toBe("Workday");
  });
});
