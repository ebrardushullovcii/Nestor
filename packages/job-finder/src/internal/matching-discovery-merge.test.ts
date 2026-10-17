import { describe, expect, test } from "vitest";
import {
  JobPostingSchema,
  MatchAssessmentSchema,
  SavedJobSchema,
  type JobPosting,
  type MatchAssessment,
  type SavedJob,
} from "@nestor/contracts";

import { createSeed } from "../workspace-service.test-fixtures";
import { collectResumeAffectingChangedJobIds } from "./resume-workspace-staleness";
import { mergeDiscoveredJob, mergeDiscoveredPostings } from "./matching";

const RICH_DESCRIPTION =
  "Own product design from discovery through measured delivery. Partner with product managers and engineers to define customer problems, evaluate alternatives, and document interaction decisions before build. Test prototypes weekly with real users, synthesize qualitative and quantitative evidence into prioritized recommendations, and improve shipped workflows across onboarding, activation, and retention surfaces. Maintain the design system tokens, document accessibility expectations for every component, and coach teammates through structured design reviews so quality stays high as the platform grows.";

const UPDATED_RICH_DESCRIPTION =
  "Own product design from discovery through measured delivery. Partner with product managers and engineers to define customer problems, evaluate alternatives, and document interaction decisions before build. Test prototypes weekly with real users, synthesize qualitative and quantitative evidence into prioritized recommendations, and improve shipped workflows across onboarding, activation, and retention surfaces. Evolve the multi-brand theming architecture, document accessibility expectations for every component, and run structured critiques so quality scales as the platform expands into new markets.";

// Both partial descriptions clear the 18-word partial floor without reaching
// the enriched floors, and neither matches a synthetic one-liner pattern.
const PARTIAL_DESCRIPTION_A =
  "Design and ship customer-facing workflows with a small senior team while partnering closely with engineering and research to validate every release.";
const PARTIAL_DESCRIPTION_B =
  "Shape onboarding and activation experiences end to end while mentoring teammates and raising the craft bar across the organization.";

function createRecrawl(overrides: Partial<JobPosting> = {}): JobPosting {
  return JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: "listing_1",
    discoveryMethod: "browser_agent",
    canonicalUrl: "https://example.com/jobs/senior-product-designer",
    applicationUrl: "https://example.com/jobs/senior-product-designer/apply",
    title: "Senior Product Designer",
    company: "Signal Systems",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "easy_apply",
    easyApplyEligible: true,
    postedAt: "2026-03-20T09:00:00.000Z",
    providerUpdatedAt: "2026-03-20T08:00:00.000Z",
    discoveredAt: "2026-03-20T09:05:00.000Z",
    firstSeenAt: "2026-03-20T09:05:00.000Z",
    lastSeenAt: "2026-03-20T09:05:00.000Z",
    lastVerifiedActiveAt: "2026-03-20T09:05:00.000Z",
    salaryText: "$180k - $220k",
    normalizedCompensation: {
      currency: "USD",
      interval: "year",
      minAmount: 180000,
      maxAmount: 220000,
      minAnnualUsd: 180000,
      maxAnnualUsd: 220000,
    },
    summary: "Own product design from discovery through measured delivery.",
    description: RICH_DESCRIPTION,
    keySkills: ["Figma", "Design Systems"],
    responsibilities: [
      "Lead discovery, prototyping, and validation for customer-facing workflows.",
      "Document interaction decisions and measure outcomes after release.",
      "Maintain design system tokens across platforms.",
    ],
    minimumQualifications: [
      "Seven years designing complex product workflows.",
      "Portfolio demonstrating shipped end-to-end design work.",
    ],
    preferredQualifications: [
      "Experience with design tokens and theming systems.",
      "Background in developer-tool or platform products.",
    ],
    seniority: "Senior",
    employmentType: "Full-time",
    department: "Design",
    team: "Design Systems",
    employerWebsiteUrl: "https://signalsystems.example.com",
    employerDomain: "signalsystems.example.com",
    // The collection pipeline stamps detail quality from content evidence.
    detailQuality: "detail_enriched",
    benefits: ["Remote-first collaboration", "Annual learning budget"],
    ...overrides,
  });
}

function createThinRecrawl(overrides: Partial<JobPosting> = {}): JobPosting {
  return createRecrawl({
    discoveredAt: "2026-03-21T10:00:00.000Z",
    lastSeenAt: "2026-03-21T10:00:00.000Z",
    lastVerifiedActiveAt: "2026-03-21T10:00:00.000Z",
    applicationUrl: null,
    providerUpdatedAt: null,
    salaryText: null,
    normalizedCompensation: {
      currency: null,
      interval: null,
      minAmount: null,
      maxAmount: null,
      minAnnualUsd: null,
      maxAnnualUsd: null,
    },
    summary: null,
    // Card-only re-render: a synthetic one-liner with no structured detail.
    description: "Senior Product Designer role at Signal Systems",
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
    benefits: [],
    detailQuality: "card_only",
    keywordSignals: [],
    ...overrides,
  });
}

const BASE_ASSESSMENT: MatchAssessment = MatchAssessmentSchema.parse({
  score: 92,
  reasons: ["Strong design systems overlap"],
  gaps: [],
});

function createSavedJob(
  posting: JobPosting,
  overrides: Partial<SavedJob> = {},
): SavedJob {
  return SavedJobSchema.parse({
    ...posting,
    id: `job_${posting.sourceJobId}`,
    status: "ready_for_review",
    matchAssessment: BASE_ASSESSMENT,
    provenance: [],
    ...overrides,
  });
}

describe("discovered posting detail-quality merges", () => {
  test("a thinner recrawl keeps richer saved detail and does not stale approved resumes", () => {
    const existing = createSavedJob(createRecrawl(), {
      campaignIds: ["campaign_first", "campaign_second"],
    });
    const merged = mergeDiscoveredJob(
      existing.matchAssessment,
      createThinRecrawl(),
      existing,
    );

    expect(merged.detailQuality).toBe("detail_enriched");
    expect(merged.summary).toBe(existing.summary);
    expect(merged.description).toBe(RICH_DESCRIPTION);
    expect(merged.keySkills).toEqual(existing.keySkills);
    expect(merged.responsibilities).toEqual(existing.responsibilities);
    expect(merged.minimumQualifications).toEqual(
      existing.minimumQualifications,
    );
    expect(merged.preferredQualifications).toEqual(
      existing.preferredQualifications,
    );
    expect(merged.benefits).toEqual(existing.benefits);
    expect(merged.seniority).toBe("Senior");
    expect(merged.employmentType).toBe("Full-time");
    expect(merged.department).toBe("Design");
    expect(merged.team).toBe("Design Systems");
    // Evidence links dropped by the thinner crawl fall back to stored values.
    expect(merged.applicationUrl).toBe(existing.applicationUrl);
    expect(merged.salaryText).toBe(existing.salaryText);
    expect(merged.normalizedCompensation).toEqual(
      existing.normalizedCompensation,
    );
    // Freshness still advances on the card.
    expect(merged.firstSeenAt).toBe(existing.firstSeenAt);
    expect(merged.lastSeenAt).toBe("2026-03-21T10:00:00.000Z");
    expect(merged.lastVerifiedActiveAt).toBe("2026-03-21T10:00:00.000Z");
    expect(merged.campaignIds).toEqual(["campaign_first", "campaign_second"]);
    // No resume-affecting regression means approved exports stay valid.
    expect(collectResumeAffectingChangedJobIds([existing], [merged])).toEqual(
      [],
    );
  });

  test("stored content evidence protects detail even when its saved quality label is stale", () => {
    const existing = createSavedJob(
      createRecrawl({ detailQuality: "card_only" }),
    );
    const merged = mergeDiscoveredJob(
      existing.matchAssessment,
      createThinRecrawl(),
      existing,
    );

    expect(merged.detailQuality).toBe("detail_enriched");
    expect(merged.description).toBe(RICH_DESCRIPTION);
    expect(merged.responsibilities).toEqual(existing.responsibilities);
  });

  test("a thinner recrawl never fills missing stored scalars from weaker evidence", () => {
    const existing = createSavedJob(
      createRecrawl({ seniority: null, employmentType: null }),
    );
    const merged = mergeDiscoveredJob(
      existing.matchAssessment,
      createThinRecrawl({ employmentType: "Full-time" }),
      existing,
    );

    expect(merged.seniority).toBeNull();
    expect(merged.employmentType).toBeNull();
    expect(collectResumeAffectingChangedJobIds([existing], [merged])).toEqual(
      [],
    );
  });

  test("provider freshness stays monotonic while detail is preserved", () => {
    const existing = createSavedJob(
      createRecrawl({ providerUpdatedAt: "2026-03-22T08:00:00.000Z" }),
    );

    const olderThin = mergeDiscoveredJob(
      existing.matchAssessment,
      createThinRecrawl({ providerUpdatedAt: "2026-03-21T09:00:00.000Z" }),
      existing,
    );
    expect(olderThin.providerUpdatedAt).toBe("2026-03-22T08:00:00.000Z");
    expect(olderThin.description).toBe(RICH_DESCRIPTION);

    const newerThin = mergeDiscoveredJob(
      existing.matchAssessment,
      createThinRecrawl({ providerUpdatedAt: "2026-03-23T09:00:00.000Z" }),
      existing,
    );
    expect(newerThin.providerUpdatedAt).toBe("2026-03-23T09:00:00.000Z");
    expect(newerThin.description).toBe(RICH_DESCRIPTION);
  });

  test("a richer recrawl upgrades a thinner saved listing", () => {
    const thinSaved = createSavedJob(createThinRecrawl(), {
      status: "discovered",
    });
    const richer = createRecrawl({
      discoveredAt: "2026-03-22T10:00:00.000Z",
      lastSeenAt: "2026-03-22T10:00:00.000Z",
      lastVerifiedActiveAt: "2026-03-22T10:00:00.000Z",
    });
    const merged = mergeDiscoveredJob(BASE_ASSESSMENT, richer, thinSaved);

    expect(merged.detailQuality).toBe("detail_enriched");
    expect(merged.description).toBe(RICH_DESCRIPTION);
    expect(merged.responsibilities).toHaveLength(3);
    expect(merged.salaryText).toBe("$180k - $220k");
    // A genuine upgrade is a real content change and may re-review resumes.
    expect(collectResumeAffectingChangedJobIds([thinSaved], [merged])).toEqual([
      thinSaved.id,
    ]);
  });

  test("an equally rich material change updates content and stales approved resumes", () => {
    const existing = createSavedJob(createRecrawl());
    const updated = createRecrawl({
      discoveredAt: "2026-03-23T10:00:00.000Z",
      lastSeenAt: "2026-03-23T10:00:00.000Z",
      lastVerifiedActiveAt: "2026-03-23T10:00:00.000Z",
      description: UPDATED_RICH_DESCRIPTION,
      responsibilities: [
        "Own product discovery and prototype validation with real users.",
        "Partner with engineering to ship accessible workflows.",
      ],
    });
    const merged = mergeDiscoveredJob(BASE_ASSESSMENT, updated, existing);

    expect(merged.description).toBe(UPDATED_RICH_DESCRIPTION);
    expect(merged.responsibilities).toEqual(updated.responsibilities);
    expect(collectResumeAffectingChangedJobIds([existing], [merged])).toEqual([
      existing.id,
    ]);
  });

  test("an equally rich recrawl may delete stored detail groups", () => {
    const existing = createSavedJob(createRecrawl());
    const trimmed = createRecrawl({
      discoveredAt: "2026-03-23T10:00:00.000Z",
      lastSeenAt: "2026-03-23T10:00:00.000Z",
      lastVerifiedActiveAt: "2026-03-23T10:00:00.000Z",
      benefits: [],
      preferredQualifications: [],
    });
    const merged = mergeDiscoveredJob(BASE_ASSESSMENT, trimmed, existing);

    expect(merged.benefits).toEqual([]);
    expect(merged.preferredQualifications).toEqual([]);
    expect(merged.description).toBe(RICH_DESCRIPTION);
  });

  test("a partial-detail recrawl cannot regress a detail-enriched listing", () => {
    const existing = createSavedJob(createRecrawl());
    const partial = mergeDiscoveredJob(
      BASE_ASSESSMENT,
      createThinRecrawl({
        detailQuality: "partial_detail",
        description: PARTIAL_DESCRIPTION_A,
        responsibilities: ["Own discovery workflows."],
      }),
      existing,
    );

    expect(partial.description).toBe(RICH_DESCRIPTION);
    expect(partial.responsibilities).toEqual(existing.responsibilities);
    expect(partial.detailQuality).toBe("detail_enriched");
    expect(collectResumeAffectingChangedJobIds([existing], [partial])).toEqual(
      [],
    );
  });

  test("an equally partial recrawl still updates a partial saved listing", () => {
    const existing = createSavedJob(
      createThinRecrawl({
        detailQuality: "partial_detail",
        description: PARTIAL_DESCRIPTION_A,
        responsibilities: ["Own discovery workflows."],
        keySkills: ["Figma"],
      }),
      { status: "discovered" },
    );
    const updatedPartial = createThinRecrawl({
      discoveredAt: "2026-03-22T10:00:00.000Z",
      lastSeenAt: "2026-03-22T10:00:00.000Z",
      lastVerifiedActiveAt: "2026-03-22T10:00:00.000Z",
      detailQuality: "partial_detail",
      description: PARTIAL_DESCRIPTION_B,
      responsibilities: ["Shape onboarding experiences."],
      keySkills: ["Figma"],
    });
    const merged = mergeDiscoveredJob(
      BASE_ASSESSMENT,
      updatedPartial,
      existing,
    );

    expect(merged.detailQuality).toBe("partial_detail");
    expect(merged.description).toBe(PARTIAL_DESCRIPTION_B);
    expect(merged.responsibilities).toEqual(["Shape onboarding experiences."]);
    expect(collectResumeAffectingChangedJobIds([existing], [merged])).toEqual([
      existing.id,
    ]);
  });

  test("compensation and screening merges stay correct when evidence thins out", () => {
    const existing = createSavedJob(
      createRecrawl({
        screeningHints: {
          sponsorshipText:
            "Work authorization or sponsorship details are mentioned in the listing.",
          requiresSecurityClearance: null,
          relocationText: null,
          travelText: null,
          remoteGeographies: ["Europe"],
          requiresConsentInterrupt: null,
          requiresConsentInterruptKind: null,
        },
      }),
    );
    const merged = mergeDiscoveredJob(
      existing.matchAssessment,
      createThinRecrawl(),
      existing,
    );

    expect(merged.salaryText).toBe("$180k - $220k");
    expect(merged.normalizedCompensation).toMatchObject({
      currency: "USD",
      interval: "year",
      minAmount: 180000,
      maxAmount: 220000,
    });
    expect(merged.screeningHints.sponsorshipText).toBe(
      "Work authorization or sponsorship details are mentioned in the listing.",
    );
    expect(merged.screeningHints.remoteGeographies).toEqual(["Europe"]);
    expect(collectResumeAffectingChangedJobIds([existing], [merged])).toEqual(
      [],
    );
  });

  test("a stronger recrawl still refreshes compensation and adds screening signals", () => {
    const existing = createSavedJob(
      createRecrawl({
        screeningHints: {
          sponsorshipText: null,
          requiresSecurityClearance: null,
          relocationText: null,
          travelText: null,
          remoteGeographies: [],
          requiresConsentInterrupt: null,
          requiresConsentInterruptKind: null,
        },
      }),
    );
    const updated = createRecrawl({
      discoveredAt: "2026-03-23T10:00:00.000Z",
      lastSeenAt: "2026-03-23T10:00:00.000Z",
      lastVerifiedActiveAt: "2026-03-23T10:00:00.000Z",
      salaryText: "$190k - $230k",
      description: `${RICH_DESCRIPTION} The team supports visa sponsorship for eligible candidates.`,
    });
    const merged = mergeDiscoveredJob(BASE_ASSESSMENT, updated, existing);

    expect(merged.salaryText).toBe("$190k - $230k");
    expect(merged.normalizedCompensation).toMatchObject({
      minAmount: 190000,
      maxAmount: 230000,
    });
    expect(merged.screeningHints.sponsorshipText).toContain(
      "Work authorization or sponsorship details are mentioned in the listing",
    );
  });
});

describe("mergeDiscoveredPostings detail-quality monotonicity", () => {
  function mergeWithExisting(
    existingJobs: readonly SavedJob[],
    postings: readonly JobPosting[],
  ) {
    const seed = createSeed();

    return mergeDiscoveredPostings(
      seed.profile,
      seed.searchPreferences,
      existingJobs,
      postings,
      (posting) => ({
        targetId: "target_merge_test",
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

  test.each([
    { title: "Junior Product Designer", seniority: "Junior" },
    { title: "Lead Learning Coordinator", seniority: "Lead" },
    { title: "Senior Product Designer", seniority: "Director" },
  ])(
    "keeps distinct vacancies at one employer and location ($title / $seniority)",
    (facts) => {
      const first = createRecrawl({
        canonicalUrl: "http://127.0.0.1:47950/board-a/jobs/20",
        applicationUrl: null,
      });
      const second = createRecrawl({
        ...facts,
        canonicalUrl: "http://127.0.0.1:47950/board-b/jobs/20",
        applicationUrl: null,
      });
      const result = mergeWithExisting([], [first, second]);
      expect(result.mergedJobs).toHaveLength(2);
      expect(result.duplicatesMerged).toBe(0);
      expect(
        result.mergedJobs.map((job) => [job.title, job.canonicalUrl]),
      ).toEqual([
        [first.title, first.canonicalUrl],
        [second.title, second.canonicalUrl],
      ]);
    },
  );

  test("true reposts retain both sources and one posting's display facts in either order", () => {
    const first = createRecrawl({
      canonicalUrl: "https://board-a.test/jobs/20",
      applicationUrl: null,
      salaryText: "EUR 96,000 per year",
      discoveredAt: "2026-03-20T09:00:00.000Z",
    });
    const second = createRecrawl({
      canonicalUrl: "https://board-b.test/jobs/30",
      sourceJobId: "30",
      applicationUrl: "https://board-b.test/apply/30",
      salaryText: "USD 99,000 per year",
      discoveredAt: "2026-03-20T10:00:00.000Z",
    });
    for (const postings of [
      [first, second],
      [second, first],
    ]) {
      const result = mergeWithExisting([], postings);
      expect(result.mergedJobs).toHaveLength(1);
      expect(result.duplicatesMerged).toBe(1);
      expect(result.mergedJobs[0]).toMatchObject({
        title: first.title,
        location: first.location,
        canonicalUrl: first.canonicalUrl,
        applicationUrl: null,
        salaryText: first.salaryText,
      });
      expect(result.mergedJobs[0]?.provenance).toHaveLength(2);
    }
  });

  test("a thinner recrawl appends provenance without regressing rich detail", () => {
    const existing = createSavedJob(createRecrawl());
    const result = mergeWithExisting([existing], [createThinRecrawl()]);

    expect(result.duplicatesMerged).toBe(1);
    expect(result.mergedJobs).toHaveLength(1);
    const merged = result.mergedJobs[0]!;
    expect(merged.id).toBe(existing.id);
    expect(merged.provenance).toHaveLength(1);
    expect(merged.provenance[0]?.targetId).toBe("target_merge_test");
    expect(merged.description).toBe(RICH_DESCRIPTION);
    expect(merged.detailQuality).toBe("detail_enriched");
    expect(
      collectResumeAffectingChangedJobIds([existing], result.mergedJobs),
    ).toEqual([]);
  });

  test("an access-gate sighting cannot replace the real listing url or detail", () => {
    const existing = createSavedJob(
      createThinRecrawl({
        sourceJobId: "8",
        canonicalUrl: "https://jobs.example.test/jobs/8",
        applicationUrl: "https://jobs.example.test/jobs/8/apply",
        title: "Frontend Engineer, Dusk Design Systems",
        description: "Full-time 6d",
      }),
    );
    const accessGate = createThinRecrawl({
      sourceJobId: "8",
      canonicalUrl: "https://jobs.example.test/security/8",
      applicationUrl: "https://jobs.example.test/security/8",
      title: "Frontend Engineer, Dusk Design Systems",
      description: "Security check",
    });

    const result = mergeWithExisting([existing], [accessGate]);

    expect(result.duplicatesMerged).toBe(1);
    expect(result.mergedJobs).toHaveLength(1);
    expect(result.mergedJobs[0]).toMatchObject({
      id: existing.id,
      title: existing.title,
      canonicalUrl: existing.canonicalUrl,
      applicationUrl: existing.applicationUrl,
      description: existing.description,
    });
  });

  test("merges an exact cross-source body with a shortened title and preserves the full title", () => {
    const existing = createSavedJob(
      createRecrawl({
        sourceJobId: "board_5",
        canonicalUrl: "https://jobs.example.test/board/5",
        applicationUrl: "https://jobs.example.test/board/5/apply",
        title: "Data Engineer, Meadow Pipelines",
        company: "Meadow Byte Guild",
        location: "Remote, Worldwide",
      }),
    );
    const duplicate = createRecrawl({
      sourceJobId: "gatekeeper_5",
      canonicalUrl: "https://jobs.example.test/gatekeeper/5",
      applicationUrl: "https://jobs.example.test/gatekeeper/apply/5",
      title: "Data Engineer",
      company: "Meadow Byte Guild",
      location: "Remote, Worldwide",
    });

    const result = mergeWithExisting([existing], [duplicate]);

    expect(result.newJobs).toEqual([]);
    expect(result.duplicatesMerged).toBe(1);
    expect(result.mergedJobs).toHaveLength(1);
    expect(result.mergedJobs[0]?.id).toBe(existing.id);
    expect(result.mergedJobs[0]?.title).toBe("Data Engineer, Meadow Pipelines");
  });

  test("never persists pagination or an empty non-detail site section", () => {
    const result = mergeWithExisting(
      [],
      [
        createRecrawl({
          sourceJobId: "page_1000",
          canonicalUrl: "https://example.com/jobs?page=1000",
          title: "Go to page 1000",
          company: "Employer not listed",
          description: "Go to page 1000",
        }),
        createRecrawl({
          sourceJobId: "content_descriptions",
          canonicalUrl: "https://example.com/content/descriptions",
          title: "Content Descriptions",
          company: "Employer not listed",
          description: "Content Descriptions",
        }),
      ],
    );

    expect(result.mergedJobs).toEqual([]);
    expect(result.invalidSkipped).toBe(2);
  });
});
