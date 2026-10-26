import { JobPostingSchema, type JobPosting } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import { createSeed } from "../test-fixtures";
import { mergeDiscoveredPostings } from "./matching";

function merge(postings: readonly JobPosting[], withExisting = false) {
  const seed = createSeed();
  const existing = seed.savedJobs[0]!;
  return mergeDiscoveredPostings(
    seed.profile,
    seed.searchPreferences,
    withExisting ? [existing] : [],
    postings,
    (posting) => ({
      targetId: "target_identity_test",
      adapterKind: "auto",
      resolvedAdapterKind: "target_site",
      startingUrl: posting.canonicalUrl,
      discoveredAt: posting.discoveredAt,
      collectionMethod: posting.collectionMethod,
      providerKey: posting.providerKey,
      providerBoardToken: posting.providerBoardToken,
      titleTriageOutcome: posting.titleTriageOutcome,
    }),
  );
}

describe("discovered posting identity merge", () => {
  test("merges an aggregator result into the existing job when both lead to the same ATS application", () => {
    const seed = createSeed();
    const existing = seed.savedJobs[0]!;
    existing.sourceJobId = "linkedin_5112809008";
    existing.canonicalUrl =
      "https://www.linkedin.com/jobs/view/senior-engineer-5112809008";
    existing.applicationUrl =
      "https://job-boards.greenhouse.io/acme/jobs/5112809008?gh_src=linkedin";
    existing.title = "Senior Software Engineer";
    existing.company = "Acme";
    existing.location = "Remote - United States";
    existing.postedAt = "2026-08-08T12:30:00.000Z";

    const atsPosting = JobPostingSchema.parse({
      ...existing,
      sourceJobId: "5112809008",
      canonicalUrl: "https://job-boards.greenhouse.io/acme/jobs/5112809008",
      applicationUrl:
        "https://job-boards.greenhouse.io/acme/jobs/5112809008?utm_source=direct",
      providerKey: "greenhouse",
      providerBoardToken: "acme",
      providerIdentifier: "acme",
    });
    const result = mergeDiscoveredPostings(
      seed.profile,
      seed.searchPreferences,
      [existing],
      [atsPosting],
      (posting) => ({
        targetId: "target_greenhouse",
        adapterKind: "auto",
        resolvedAdapterKind: "target_site",
        startingUrl: posting.canonicalUrl,
        discoveredAt: posting.discoveredAt,
        collectionMethod: posting.collectionMethod,
        providerKey: posting.providerKey,
        providerBoardToken: posting.providerBoardToken,
        titleTriageOutcome: posting.titleTriageOutcome,
      }),
    );

    expect(result.mergedJobs).toHaveLength(1);
    expect(result.mergedJobs[0]?.id).toBe(existing.id);
    expect(result.duplicatesMerged).toBe(1);
    expect(result.newJobs).toHaveLength(0);
  });

  test("keeps colliding generic source IDs from different employers as distinct jobs", () => {
    const base = createSeed().savedJobs[0]!;
    const first = JobPostingSchema.parse({
      ...base,
      sourceJobId: "123",
      canonicalUrl: "https://jobs.alpha.test/roles/123",
      applicationUrl: "https://jobs.alpha.test/roles/123/apply",
      company: "Alpha",
    });
    const second = JobPostingSchema.parse({
      ...base,
      sourceJobId: "123",
      canonicalUrl: "https://jobs.beta.test/roles/123",
      applicationUrl: "https://jobs.beta.test/roles/123/apply",
      company: "Beta",
    });

    const result = merge([first, second]);

    expect(result.mergedJobs).toHaveLength(2);
    expect(new Set(result.mergedJobs.map((job) => job.id)).size).toBe(2);
    expect(result.newJobs).toHaveLength(2);
    expect(result.duplicatesMerged).toBe(0);
  });

  test("does not auto-merge separate openings from facts alone", () => {
    const base = createSeed().savedJobs[0]!;
    const first = JobPostingSchema.parse({
      ...base,
      sourceJobId: "opening-a",
      canonicalUrl: "https://careers.acme.test/jobs/opening-a",
      applicationUrl: "https://careers.acme.test/jobs/opening-a/apply",
      company: "Acme",
      title: "Senior Software Engineer",
      location: "Remote - United States",
      postedAt: "2026-08-08T12:30:00.000Z",
    });
    const second = JobPostingSchema.parse({
      ...first,
      sourceJobId: "opening-b",
      canonicalUrl: "https://careers.acme.test/jobs/opening-b",
      applicationUrl: "https://careers.acme.test/jobs/opening-b/apply",
    });

    const result = merge([first, second]);

    expect(result.mergedJobs).toHaveLength(2);
    expect(result.duplicatesMerged).toBe(0);
  });
});
