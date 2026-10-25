import { describe, expect, test } from "vitest";

import {
  JobPostingSchema,
  type JobPosting,
} from "@nestor/contracts";

import {
  createDiscoveryListingFingerprints,
  rememberDiscoveryListingFingerprints,
} from "./workspace-discovery-ledger";

function createPosting(overrides: Partial<JobPosting> = {}): JobPosting {
  return JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: "job_1",
    discoveryMethod: "browser_agent",
    collectionMethod: "careers_page",
    canonicalUrl: "https://example.com/jobs/job-1",
    applicationUrl: "https://example.com/jobs/job-1/apply",
    title: "Software Engineer",
    company: "Acme",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    postedAt: "2026-03-19T09:00:00.000Z",
    discoveredAt: "2026-03-20T09:00:00.000Z",
    salaryText: "$150,000",
    detailQuality: "detail_enriched",
    summary: "Build reliable customer-facing software.",
    description:
      "Build reliable customer-facing software with TypeScript and React.",
    keySkills: ["TypeScript", "React"],
    responsibilities: ["Ship reliable product improvements."],
    minimumQualifications: ["Five years of software engineering experience."],
    preferredQualifications: [],
    benefits: ["Health insurance"],
    ...overrides,
  });
}

describe("workspace-discovery-ledger", () => {
  test("reuses worker fingerprints across copies, but changing any material input computes a new digest", () => {
    const worker = createPosting();
    const fingerprints = createDiscoveryListingFingerprints(worker);
    rememberDiscoveryListingFingerprints(worker, fingerprints);
    const copy = JobPostingSchema.parse(worker);
    expect(createDiscoveryListingFingerprints(copy)).toEqual(fingerprints);
    const owned = createDiscoveryListingFingerprints(copy);
    owned.card = "caller-owned";
    expect(createDiscoveryListingFingerprints(copy)).toEqual(fingerprints);
    copy.description += " A changed description.";
    expect(createDiscoveryListingFingerprints(copy).detail).not.toBe(
      fingerprints.detail,
    );
    copy.description = worker.description;
    copy.workMode.push("hybrid");
    expect(createDiscoveryListingFingerprints(copy).card).not.toBe(
      fingerprints.card,
    );
    expect(worker.workMode).toEqual(["remote"]);
  });
});
