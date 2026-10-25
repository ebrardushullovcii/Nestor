// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type {
  CompanyEntity,
  DiscoveryJobView,
  SavedJob,
} from "@nestor/contracts";
import {
  indexCompanyJobs,
  projectCompanyApplicationHistory,
  projectCompanyDuplicateJobs,
  projectCompanyOpenings,
} from "./company-projections";

const now = "2026-08-15T10:00:00.000Z";

function makeCompany(overrides: Partial<CompanyEntity> = {}): CompanyEntity {
  return {
    id: "company_1",
    canonicalName: "Acme Inc",
    aliases: [],
    domains: [],
    preference: "neutral",
    preferenceReason: null,
    mergeReviewCandidates: [],
    contacts: [],
    notes: [],
    salaryOfferEvidence: [],
    sourceHistory: [],
    jobIds: [],
    applicationRecordIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeJob(id: string, overrides: Partial<SavedJob> = {}): SavedJob {
  return {
    id,
    source: "target_site",
    sourceJobId: `source_${id}`,
    discoveryMethod: "catalog_seed",
    collectionMethod: "fallback_search",
    canonicalUrl: `https://jobs.example.com/${id}`,
    applicationUrl: null,
    title: "Engineer",
    company: "Acme Inc",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "easy_apply",
    easyApplyEligible: true,
    postedAt: null,
    postedAtText: null,
    providerUpdatedAt: null,
    discoveredAt: now,
    firstSeenAt: null,
    lastSeenAt: null,
    lastVerifiedActiveAt: null,
    salaryText: null,
    normalizedCompensation: {
      currency: null,
      interval: null,
      minAmount: null,
      maxAmount: null,
      minAnnualUsd: null,
      maxAnnualUsd: null,
    },
    detailQuality: "card_only",
    summary: null,
    description: "A job.",
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
    providerKey: null,
    providerBoardToken: null,
    providerIdentifier: null,
    titleTriageOutcome: "pass",
    sourceIntelligence: null,
    screeningHints: {},
    keywordSignals: [],
    benefits: [],
    status: "ready_for_review",
    matchAssessment: { score: 80, reasons: [], gaps: [] },
    provenance: [],
    discoveryFeedback: null,
    resumeApplicationMode: null,
    latestMatchAssessmentAudit: null,
    ...overrides,
  } as SavedJob;
}

function withActivity(
  job: SavedJob,
  listingActivity: DiscoveryJobView["listingActivity"],
): DiscoveryJobView {
  return { ...job, listingActivity };
}

describe("projectCompanyOpenings", () => {
  it("groups by listing activity independently from workflow status", () => {
    const projection = projectCompanyOpenings({
      company: makeCompany({
        jobIds: ["job_open", "job_closed"],
      }),
      jobs: [
        withActivity(
          makeJob("job_open", {
            status: "rejected",
            postedAt: "2026-08-05T00:00:00.000Z",
          }),
          {
            status: "active",
            observedAt: "2026-08-14T00:00:00.000Z",
            evidence: "last_seen_at",
          },
        ),
        withActivity(
          makeJob("job_closed", {
            status: "discovered",
            postedAt: "2026-08-10T00:00:00.000Z",
          }),
          {
            status: "closed",
            observedAt: "2026-08-15T00:00:00.000Z",
            signalId: "signal_closed",
            provenance: "provider",
            explanation: "The provider marked the role closed.",
            detail: null,
            confidence: 1,
          },
        ),
        makeJob("job_unlinked", {
          status: "submitted",
          postedAt: "2026-08-01T00:00:00.000Z",
        }),
      ],
    });

    expect(projection.lastSeenAvailable.map((job) => job.id)).toEqual([
      "job_open",
    ]);
    expect(projection.reportedClosed.map((job) => job.id)).toEqual([
      "job_closed",
    ]);
    expect(projection.totalCount).toBe(2);
    expect(projection.lastOpenedAt).toBe("2026-08-10T00:00:00.000Z");
  });

  it("groups inactive, stale, and unknown for verification and never orders by discoveredAt", () => {
    const projection = projectCompanyOpenings({
      company: makeCompany({ jobIds: ["inactive", "stale", "unknown"] }),
      jobs: [
        withActivity(
          makeJob("inactive", {
            postedAt: null,
            providerUpdatedAt: "2026-08-10T00:00:00.000Z",
            discoveredAt: "2026-08-15T00:00:00.000Z",
          }),
          {
            status: "inactive",
            observedAt: "2026-08-15T00:00:00.000Z",
            ledgerEntryId: "ledger_1",
            provenance: "discovery_ledger",
            explanation: "Missing from a complete refresh.",
          },
        ),
        withActivity(
          makeJob("stale", {
            postedAt: "2026-08-12T00:00:00.000Z",
            discoveredAt: "2026-08-01T00:00:00.000Z",
          }),
          {
            status: "stale",
            observedAt: "2026-08-15T00:00:00.000Z",
            signalId: "signal_stale",
            provenance: "browser",
            explanation: "The page may no longer accept applications.",
            detail: "An expiry banner was visible.",
            confidence: 0.8,
          },
        ),
        withActivity(
          makeJob("unknown", { discoveredAt: "2026-08-20T00:00:00.000Z" }),
          {
            status: "unknown",
          },
        ),
      ],
    });

    expect(projection.needsVerification.map((job) => job.id)).toEqual([
      "stale",
      "inactive",
      "unknown",
    ]);
    expect(projection.lastOpenedAt).toBe("2026-08-12T00:00:00.000Z");
  });

  it("deduplicates company job ids and ignores missing jobs deterministically", () => {
    const first = makeJob("duplicate", {
      title: "First indexed value",
      postedAt: "2026-08-10T00:00:00.000Z",
    });
    const projection = projectCompanyOpenings({
      company: makeCompany({
        jobIds: ["duplicate", "missing", "duplicate"],
      }),
      jobs: [first, makeJob("duplicate", { title: "Later duplicate" })],
    });

    expect(projection.totalCount).toBe(1);
    expect(projection.needsVerification.map((job) => job.title)).toEqual([
      "First indexed value",
    ]);
    expect(projection.lastOpenedAt).toBe("2026-08-10T00:00:00.000Z");
  });

  it("projects representative companies from a shared 10,000-job index within budget", () => {
    const jobs = Array.from({ length: 10_000 }, (_, index) =>
      withActivity(
        makeJob(`job_${String(index).padStart(5, "0")}`, {
          postedAt: `2026-08-${String((index % 20) + 1).padStart(2, "0")}T00:00:00.000Z`,
        }),
        index % 3 === 0
          ? {
              status: "active",
              observedAt: now,
              evidence: "last_seen_at",
            }
          : { status: "unknown" },
      ),
    );
    const companies = Array.from({ length: 100 }, (_, companyIndex) =>
      makeCompany({
        id: `company_${companyIndex}`,
        jobIds: Array.from(
          { length: 100 },
          (_, offset) => jobs[companyIndex * 100 + offset]!.id,
        ),
      }),
    );

    const startedAt = performance.now();
    const jobById = indexCompanyJobs(jobs);
    const projections = companies.map((company) =>
      projectCompanyOpenings({ company, jobs, jobById }),
    );
    const elapsedMs = performance.now() - startedAt;

    expect(projections).toHaveLength(100);
    expect(
      projections.every((projection) => projection.totalCount === 100),
    ).toBe(true);
    expect(projections[0]!.lastSeenAvailableCount).toBe(34);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});

describe("projectCompanyApplicationHistory", () => {
  it("returns linked records newest first with status counts", () => {
    const projection = projectCompanyApplicationHistory({
      company: makeCompany({ applicationRecordIds: ["app_old", "app_new"] }),
      applicationRecords: [
        {
          id: "app_old",
          jobId: "job_1",
          title: "Engineer",
          company: "Acme Inc",
          status: "rejected",
          lastActionLabel: "Rejected",
          nextActionLabel: null,
          lastUpdatedAt: "2026-08-01T00:00:00.000Z",
          lastAttemptState: null,
          questionSummary: {
            total: 0,
            required: 0,
            answered: 0,
            unansweredRequired: 0,
          },
          latestBlocker: null,
          consentSummary: { status: "none", pendingCount: 0 },
          replaySummary: {
            sourceInstructionArtifactId: null,
            lastUrl: null,
            checkpointCount: 0,
            evidenceCount: 0,
          },
          events: [],
          crm: null,
          automationMode: "prepare_only" as const,
        },
        {
          id: "app_new",
          jobId: "job_2",
          title: "Engineer",
          company: "Acme Inc",
          status: "interview",
          lastActionLabel: "Interviewed",
          nextActionLabel: null,
          lastUpdatedAt: "2026-08-10T00:00:00.000Z",
          lastAttemptState: null,
          questionSummary: {
            total: 0,
            required: 0,
            answered: 0,
            unansweredRequired: 0,
          },
          latestBlocker: null,
          consentSummary: { status: "none", pendingCount: 0 },
          replaySummary: {
            sourceInstructionArtifactId: null,
            lastUrl: null,
            checkpointCount: 0,
            evidenceCount: 0,
          },
          events: [],
          crm: null,
          automationMode: "prepare_only" as const,
        },
      ],
    });

    expect(projection.records.map((record) => record.id)).toEqual([
      "app_new",
      "app_old",
    ]);
    expect(projection.statusCounts.interview).toBe(1);
    expect(projection.statusCounts.rejected).toBe(1);
    expect(projection.latestUpdatedAt).toBe("2026-08-10T00:00:00.000Z");
  });
});

describe("projectCompanyDuplicateJobs", () => {
  it("flags an exact duplicate when postings share a source posting id", () => {
    const groups = projectCompanyDuplicateJobs({
      company: makeCompany({ jobIds: ["job_a", "job_b"] }),
      jobs: [
        makeJob("job_a", {
          sourceJobId: "posting_1",
          canonicalUrl: "https://jobs.example.com/a",
        }),
        makeJob("job_b", {
          sourceJobId: "posting_1",
          canonicalUrl: "https://jobs.example.com/b",
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: "exact",
      jobIds: ["job_a", "job_b"],
    });
  });

  it("flags an exact duplicate when postings share a canonical listing url", () => {
    const groups = projectCompanyDuplicateJobs({
      company: makeCompany({ jobIds: ["job_a", "job_b"] }),
      jobs: [
        makeJob("job_a", {
          sourceJobId: "posting_a",
          canonicalUrl: "https://jobs.example.com/same",
        }),
        makeJob("job_b", {
          sourceJobId: "posting_b",
          canonicalUrl: "https://jobs.example.com/same",
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe("exact");
  });

  it("flags a possible duplicate for identical title/company/location/posted date", () => {
    const groups = projectCompanyDuplicateJobs({
      company: makeCompany({ jobIds: ["job_a", "job_b"] }),
      jobs: [
        makeJob("job_a", {
          sourceJobId: "posting_a",
          canonicalUrl: "https://jobs.example.com/a",
          postedAt: "2026-08-01T00:00:00.000Z",
        }),
        makeJob("job_b", {
          sourceJobId: "posting_b",
          canonicalUrl: "https://jobs.example.com/b",
          postedAt: "2026-08-01T00:00:00.000Z",
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe("possible");
  });

  it("leaves unrelated postings alone and never silently merges", () => {
    const groups = projectCompanyDuplicateJobs({
      company: makeCompany({ jobIds: ["job_a", "job_b"] }),
      jobs: [
        makeJob("job_a", {
          title: "Engineer",
          location: "Remote",
          sourceJobId: "posting_a",
          canonicalUrl: "https://jobs.example.com/a",
        }),
        makeJob("job_b", {
          title: "Designer",
          location: "London",
          sourceJobId: "posting_b",
          canonicalUrl: "https://jobs.example.com/b",
        }),
      ],
    });

    expect(groups).toEqual([]);
  });

  it("indexes a 500-plus posting catalog without pairing unrelated jobs", () => {
    const jobs = Array.from({ length: 501 }, (_, index) =>
      makeJob(`job_${String(index).padStart(3, "0")}`, {
        sourceJobId: index < 2 ? "shared-posting" : `posting_${index}`,
      }),
    );
    const groups = projectCompanyDuplicateJobs({
      company: makeCompany({ jobIds: jobs.map((job) => job.id) }),
      jobs,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: "exact",
      jobIds: ["job_000", "job_001"],
    });
  });

  it("returns no groups for a company with fewer than two jobs", () => {
    expect(
      projectCompanyDuplicateJobs({
        company: makeCompany({ jobIds: ["job_a"] }),
        jobs: [makeJob("job_a")],
      }),
    ).toEqual([]);
  });
});
