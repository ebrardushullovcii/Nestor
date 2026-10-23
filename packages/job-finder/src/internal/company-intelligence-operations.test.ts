import { describe, expect, test } from "vitest";

import {
  ApplicationRecordSchema,
  type ApplicationRecord,
  type ApplicationStatus,
  type CompanyIntelligenceMutationInput,
  CompanyEntitySchema,
  type CompanyEntity,
  genericCompanyNameValues,
  type SavedJob,
  SavedJobSchema,
} from "@nestor/contracts";
import {
  applyCompanyIntelligenceMutation,
  nextCompanyIntelligenceUpdatedAt,
  normalizeCompanyName,
  normalizeEmployerDomain,
  projectCompanyApplicationHistory,
  projectCompanyDuplicateJobs,
  projectCompanyOpenings,
  reconcileCompanies,
  reconcileCompaniesInTurns,
  reviewCompanyMerge,
  setCompanyPreference,
} from "./company-intelligence-operations";

const now = "2026-08-15T10:00:00.000Z";
const later = "2026-08-15T11:00:00.000Z";
const latest = "2026-08-15T12:00:00.000Z";

test("company reconciliation between turns preserves the synchronous decisions", async () => {
  const input = {
    companies: [makeCompany()],
    jobs: [
      makeJob({ id: "one", company: "Acme Inc" }),
      makeJob({ id: "two", company: "New synthetic employer" }),
    ],
    applicationRecords: [],
    now,
    createCompanyId: (identity: { normalizedName: string }) =>
      `company_${identity.normalizedName}`,
  };
  expect(await reconcileCompaniesInTurns(input)).toEqual(
    reconcileCompanies(input),
  );
  expect(await reconcileCompaniesInTurns({ ...input, now: "invalid" })).toEqual(
    reconcileCompanies({ ...input, now: "invalid" }),
  );
});

describe("nextCompanyIntelligenceUpdatedAt", () => {
  test("uses now unless a current timestamp requires the next millisecond", () => {
    expect(nextCompanyIntelligenceUpdatedAt(later, now)).toBe(later);
    expect(nextCompanyIntelligenceUpdatedAt(now, now)).toBe(
      "2026-08-15T10:00:00.001Z",
    );
    expect(nextCompanyIntelligenceUpdatedAt(now, later)).toBe(
      "2026-08-15T11:00:00.001Z",
    );
    expect(nextCompanyIntelligenceUpdatedAt(now, later, latest)).toBe(
      "2026-08-15T12:00:00.001Z",
    );
  });
});

function makeCompany(overrides: Partial<CompanyEntity> = {}): CompanyEntity {
  return CompanyEntitySchema.parse({
    id: "company_1",
    canonicalName: "Acme Inc",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function makeJob(input: {
  id: string;
  company: string;
  employerDomain?: string | null;
  status?: ApplicationStatus;
  postedAt?: string | null;
  discoveredAt?: string;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  sourceJobId?: string;
  canonicalUrl?: string;
  applicationUrl?: string | null;
  provenance?: SavedJob["provenance"];
  title?: string;
  location?: string | null;
}): SavedJob {
  return SavedJobSchema.parse({
    id: input.id,
    source: "target_site",
    sourceJobId: input.sourceJobId ?? `source_${input.id}`,
    discoveryMethod: "catalog_seed",
    canonicalUrl: input.canonicalUrl ?? `https://jobs.example.com/${input.id}`,
    applicationUrl: input.applicationUrl ?? null,
    title: input.title ?? "Engineer",
    company: input.company,
    location: input.location ?? "Remote",
    workMode: ["remote"],
    applyPath: "easy_apply",
    easyApplyEligible: true,
    postedAt: input.postedAt ?? null,
    postedAtText: null,
    providerUpdatedAt: null,
    discoveredAt: input.discoveredAt ?? "2026-08-01T00:00:00.000Z",
    firstSeenAt: input.firstSeenAt ?? null,
    lastSeenAt: input.lastSeenAt ?? null,
    lastVerifiedActiveAt: null,
    salaryText: null,
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
    employerDomain: input.employerDomain ?? null,
    atsProvider: null,
    status: input.status ?? "ready_for_review",
    matchAssessment: { score: 80 },
    provenance: input.provenance ?? [],
  });
}

function makeApplicationRecord(input: {
  id: string;
  jobId: string;
  company: string;
  status?: ApplicationStatus;
  lastUpdatedAt?: string;
}): ApplicationRecord {
  return ApplicationRecordSchema.parse({
    id: input.id,
    jobId: input.jobId,
    title: "Engineer",
    company: input.company,
    status: input.status ?? "submitted",
    lastActionLabel: "Submitted",
    nextActionLabel: null,
    lastUpdatedAt: input.lastUpdatedAt ?? "2026-08-10T00:00:00.000Z",
  });
}

function defaultCreateCompanyId(identity: {
  normalizedName: string;
  normalizedDomain: string | null;
}): string {
  const domain = identity.normalizedDomain ?? "no_domain";
  return `company_${identity.normalizedName.replace(/\s+/gu, "_")}_${domain}`;
}

describe("normalizeCompanyName and normalizeEmployerDomain", () => {
  test("normalizes names for exact comparison", () => {
    expect(normalizeCompanyName("Acme Inc.")).toBe("acme inc");
    expect(normalizeCompanyName("  Acme, Inc.  ")).toBe("acme inc");
    expect(normalizeCompanyName("Northwind Labs")).toBe("northwind labs");
    expect(normalizeCompanyName("Café C++ & C#")).toBe("cafe cplusplus csharp");
  });

  test("normalizes domains for exact comparison", () => {
    expect(normalizeEmployerDomain("Acme.com")).toBe("acme.com");
    expect(normalizeEmployerDomain("www.acme.com")).toBe("acme.com");
    expect(normalizeEmployerDomain("acme.com.")).toBe("acme.com");
  });
});

describe("reconcileCompanies", () => {
  test("creates a company from a job with a domain", () => {
    const result = reconcileCompanies({
      companies: [],
      jobs: [
        makeJob({
          id: "job_1",
          company: "Acme Inc",
          employerDomain: "acme.com",
          firstSeenAt: "2026-08-02T00:00:00.000Z",
          lastSeenAt: "2026-08-03T00:00:00.000Z",
        }),
      ],
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.companies).toHaveLength(1);
    const company = result.companies[0]!;
    expect(company.id).toBe("company_acme_inc_acme.com");
    expect(company.canonicalName).toBe("Acme Inc");
    expect(company.domains).toEqual([
      { domain: "acme.com", primary: true, verifiedAt: null },
    ]);
    expect(company.jobIds).toEqual(["job_1"]);
    expect(company.applicationRecordIds).toEqual([]);
    expect(company.preference).toBe("neutral");
    expect(company.aliases).toEqual([]);
    expect(company.sourceHistory).toEqual([
      {
        id: "target_site",
        sourceId: "target_site",
        firstSeenAt: "2026-08-02T00:00:00.000Z",
        lastSeenAt: "2026-08-03T00:00:00.000Z",
        applicationRecordIds: [],
      },
    ]);
    expect(CompanyEntitySchema.safeParse(result.companies[0]).success).toBe(
      true,
    );
    expect(result.summary.createdCompanyIds).toEqual([
      "company_acme_inc_acme.com",
    ]);
  });

  test("keeps renamed employers sharing an exact domain separate for merge review", () => {
    const result = reconcileCompanies({
      companies: [],
      jobs: [
        makeJob({
          id: "job_1",
          company: "Acme Inc",
          employerDomain: "www.acme.com",
        }),
        makeJob({
          id: "job_2",
          company: "Acme Corporation",
          employerDomain: "Acme.com",
        }),
      ],
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.companies).toHaveLength(2);
    expect(result.companies.map((company) => company.jobIds)).toEqual([
      ["job_1"],
      ["job_2"],
    ]);
    expect(result.summary.createdCompanyIds).toHaveLength(2);
    expect(result.summary.createdMergeCandidates).toHaveLength(1);
    expect(result.summary.createdMergeCandidates[0]?.reason).toContain(
      "share the employer domain",
    );
  });

  test("a shared listing host alone does not suggest merging every employer", () => {
    const count = 150;
    const startedAt = performance.now();
    const result = reconcileCompanies({
      companies: [],
      jobs: Array.from({ length: count * 2 }, (_, index) =>
        makeJob({
          id: `job_${index}`,
          company: `Board Listed Employer ${index % count} ${String.fromCharCode(97 + ((index % count) % 26))}`,
          employerDomain: "jobs-board.example",
          canonicalUrl: `https://jobs-board.example/employer/${index % count}/job/${index}`,
        }),
      ),
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pairs = new Set(
      result.companies.flatMap((company) =>
        company.mergeReviewCandidates.map((candidate) =>
          [company.id, candidate.candidateCompanyId].sort().join("|"),
        ),
      ),
    );
    expect(result.companies).toHaveLength(count);
    expect(pairs.size).toBe(0);
    expect(result.summary.createdMergeCandidates).toEqual([]);
    // A provider's shared host is source evidence, not an employer identity.
    expect(elapsedMs).toBeLessThan(4_000);
  });

  test("a shared listing domain does not create pairs among 3000 employers", () => {
    const count = 3_000;
    const result = reconcileCompanies({
      companies: [],
      jobs: Array.from({ length: count }, (_, index) =>
        makeJob({
          id: `job_${index}`,
          company: `Synthetic employer ${index}`,
          employerDomain: "hiring.shared.example",
          canonicalUrl: `https://hiring.shared.example/listing/${index}`,
        }),
      ),
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.companies).toHaveLength(count);
    expect(result.summary.createdMergeCandidates).toEqual([]);
    expect(
      result.companies.every(
        (company) =>
          company.domains[0]?.domain === "hiring.shared.example" &&
          company.mergeReviewCandidates.length === 0,
      ),
    ).toBe(true);
  }, 60_000);

  test("keeps an exact domain suggestion for related employer names", () => {
    const result = reconcileCompanies({
      companies: [],
      jobs: [
        makeJob({
          id: "job_acme",
          company: "Acme Inc",
          employerDomain: "acme.example",
          canonicalUrl: "https://acme.example/jobs/one",
        }),
        makeJob({
          id: "job_acme_group",
          company: "Acme Group",
          employerDomain: "acme.example",
          canonicalUrl: "https://acme.example/jobs/two",
        }),
      ],
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.companies.map((company) => company.jobIds)).toEqual([
      ["job_acme"],
      ["job_acme_group"],
    ]);
    expect(result.summary.createdMergeCandidates).toHaveLength(1);
    expect(result.summary.createdMergeCandidates[0]?.reason).toContain(
      "Similar company name",
    );
  });

  test.each([
    "canonicalUrl",
    "applicationUrl",
    "startingUrl",
    "listingUrl",
    "provenanceApplicationUrl",
    "pageApplyUrl",
  ] as const)("recognizes a shared host from %s", (route) => {
    const sharedHost = "https://hiring.shared.example";
    const secondJob = makeJob({
      id: "job_northwind",
      company: "Northwind Labs",
      employerDomain: "hiring.shared.example",
      canonicalUrl:
        route === "canonicalUrl"
          ? `${sharedHost}/northwind/opening`
          : "https://northwind.example/opening",
      applicationUrl:
        route === "applicationUrl" ? `${sharedHost}/apply/northwind` : null,
      provenance: [
        {
          targetId: "source_northwind",
          adapterKind: "auto",
          resolvedAdapterKind: null,
          startingUrl:
            route === "startingUrl"
              ? `${sharedHost}/northwind`
              : "https://northwind.example/careers",
          discoveredAt: now,
          collectionMethod: "fallback_search",
          providerKey: null,
          providerBoardToken: null,
          titleTriageOutcome: "pass",
          listingUrl:
            route === "listingUrl" ? `${sharedHost}/listing/northwind` : null,
          applicationUrl:
            route === "provenanceApplicationUrl"
              ? `${sharedHost}/apply/northwind`
              : null,
          pageApplyUrl:
            route === "pageApplyUrl"
              ? `${sharedHost}/page/apply/northwind`
              : null,
        },
      ],
    });
    const result = reconcileCompanies({
      companies: [],
      jobs: [
        makeJob({
          id: "job_acme",
          company: "Acme Inc",
          employerDomain: "hiring.shared.example",
          canonicalUrl: `${sharedHost}/acme/opening`,
        }),
        secondJob,
      ],
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.companies.map((company) => company.jobIds)).toEqual([
      ["job_acme"],
      ["job_northwind"],
    ]);
    expect(
      result.companies.every(
        (company) => company.domains[0]?.domain === "hiring.shared.example",
      ),
    ).toBe(true);
    expect(result.summary.createdMergeCandidates).toEqual([]);
  });

  test("removes unsupported pending suggestions while retaining a person's decision", () => {
    const sharedDomain = [
      {
        domain: "hiring.shared.example",
        primary: true,
        verifiedAt: null,
      },
    ];
    const result = reconcileCompanies({
      companies: [
        makeCompany({
          id: "acme",
          canonicalName: "Acme Inc",
          domains: sharedDomain,
          mergeReviewCandidates: [
            {
              candidateCompanyId: "northwind",
              reason:
                'Multiple companies share the employer domain "hiring.shared.example".',
              decision: "pending",
              decidedAt: null,
              requiresUserDecision: true,
            },
            {
              candidateCompanyId: "meridian",
              reason:
                'Multiple companies share the employer domain "hiring.shared.example".',
              decision: "rejected",
              decidedAt: now,
              requiresUserDecision: true,
            },
          ],
        }),
        makeCompany({
          id: "northwind",
          canonicalName: "Northwind Labs",
          domains: sharedDomain,
        }),
        makeCompany({
          id: "meridian",
          canonicalName: "Meridian Group",
          domains: sharedDomain,
        }),
      ],
      jobs: [
        makeJob({
          id: "job_acme",
          company: "Acme Inc",
          employerDomain: "hiring.shared.example",
          canonicalUrl: "https://hiring.shared.example/acme",
        }),
        makeJob({
          id: "job_northwind",
          company: "Northwind Labs",
          employerDomain: "hiring.shared.example",
          canonicalUrl: "https://hiring.shared.example/northwind",
        }),
        makeJob({
          id: "job_meridian",
          company: "Meridian Group",
          employerDomain: "hiring.shared.example",
          canonicalUrl: "https://hiring.shared.example/meridian",
        }),
      ],
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.companies[0]?.mergeReviewCandidates).toEqual([
      expect.objectContaining({
        candidateCompanyId: "meridian",
        decision: "rejected",
      }),
    ]);
    expect(result.summary.createdMergeCandidates).toEqual([]);
  });

  test.each([3_000, 10_000])(
    "keeps %i numbered employers separate and serializable",
    (count) => {
      const jobs = Array.from({ length: count }, (_, index) =>
        makeJob({ id: `job_${index}`, company: `Synthetic company ${index}` }),
      );
      const result = reconcileCompanies({
        companies: [],
        jobs,
        applicationRecords: [],
        now,
        createCompanyId: defaultCreateCompanyId,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.companies).toHaveLength(count);
      expect(result.summary.createdMergeCandidates).toEqual([]);
      expect(
        result.companies.every(
          (company) =>
            company.mergeReviewCandidates.length === 0 &&
            company.jobIds.length === 1,
        ),
      ).toBe(true);
      expect(JSON.stringify(result.companies).length).toBeGreaterThan(count);
    },
    60_000,
  );

  test("does not infer identity from shared business and legal words", () => {
    const result = reconcileCompanies({
      companies: [],
      jobs: [
        makeJob({ id: "job_alpha", company: "Alpha Software LLC" }),
        makeJob({ id: "job_beta", company: "Beta Software LLC" }),
        makeJob({ id: "job_gamma", company: "Gamma Global Solutions" }),
        makeJob({ id: "job_delta", company: "Delta Global Solutions" }),
      ],
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.companies).toHaveLength(4);
    expect(result.summary.createdMergeCandidates).toEqual([]);
  });

  test("links thousands of jobs to one employer on cold and warm passes", () => {
    const count = 5_000;
    const jobs = Array.from({ length: count }, (_, index) =>
      makeJob({ id: `job_${index}`, company: "Acme Inc" }),
    );
    const cold = reconcileCompanies({
      companies: [],
      jobs,
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });
    expect(cold.ok).toBe(true);
    if (!cold.ok) return;

    const warm = reconcileCompanies({
      companies: cold.companies,
      jobs,
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });
    expect(warm.ok).toBe(true);
    if (!warm.ok) return;
    expect(cold.companies).toHaveLength(1);
    expect(cold.companies[0]?.jobIds).toHaveLength(count);
    expect(warm.companies).toEqual(cold.companies);
    expect(warm.summary.createdMergeCandidates).toEqual([]);
  }, 60_000);

  test("matches by exact normalized name when no domain is present", () => {
    const result = reconcileCompanies({
      companies: [],
      jobs: [
        makeJob({ id: "job_1", company: "Acme Inc." }),
        makeJob({ id: "job_2", company: "Acme Inc" }),
      ],
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.companies).toHaveLength(1);
    expect(result.companies[0]!.jobIds).toEqual(["job_1", "job_2"]);
    expect(result.summary.createdCompanyIds).toHaveLength(1);
  });

  test("keeps different employers on the same ATS hostname separate", () => {
    const result = reconcileCompanies({
      companies: [],
      jobs: [
        makeJob({
          id: "job_acme",
          company: "Acme Inc",
          canonicalUrl: "https://jobs.provider.example/acme/job_acme",
        }),
        makeJob({
          id: "job_other",
          company: "Other Inc",
          canonicalUrl: "https://jobs.provider.example/other/job_other",
        }),
      ],
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.companies).toHaveLength(2);
    expect(
      result.companies.map((company) => [
        company.canonicalName,
        company.jobIds,
      ]),
    ).toEqual([
      ["Acme Inc", ["job_acme"]],
      ["Other Inc", ["job_other"]],
    ]);
    expect(
      result.companies.every((company) => company.domains.length === 0),
    ).toBe(true);
  });

  test("matches only when unique name and domain evidence resolve to the same company", () => {
    const companies = [
      makeCompany({
        id: "acme",
        canonicalName: "Acme Inc",
        domains: [{ domain: "acme.example", primary: true, verifiedAt: null }],
      }),
      makeCompany({
        id: "other",
        canonicalName: "Other Inc",
        domains: [{ domain: "other.example", primary: true, verifiedAt: null }],
      }),
    ];
    const matching = reconcileCompanies({
      companies,
      jobs: [
        makeJob({
          id: "job_match",
          company: "Acme Inc",
          employerDomain: "acme.example",
        }),
      ],
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });
    expect(matching.ok).toBe(true);
    if (!matching.ok) return;
    expect(
      matching.companies.find((company) => company.id === "acme")?.jobIds,
    ).toEqual(["job_match"]);

    const conflicting = reconcileCompanies({
      companies,
      jobs: [
        makeJob({
          id: "job_conflict",
          company: "Acme Inc",
          employerDomain: "other.example",
        }),
      ],
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });
    expect(conflicting.ok).toBe(true);
    if (!conflicting.ok) return;
    expect(
      conflicting.companies.flatMap((company) => company.jobIds),
    ).not.toContain("job_conflict");
    expect(conflicting.summary.ambiguousEvidenceCount).toBe(1);
  });

  test("shared domains do not veto an exact unique name owner", () => {
    const existing = [
      makeCompany({
        id: "c1",
        canonicalName: "Acme Inc",
        domains: [{ domain: "acme.com", primary: true, verifiedAt: null }],
      }),
      makeCompany({
        id: "c2",
        canonicalName: "Acme Corp",
        domains: [{ domain: "acme.com", primary: true, verifiedAt: null }],
      }),
    ];

    const result = reconcileCompanies({
      companies: existing,
      jobs: [
        makeJob({
          id: "job_1",
          company: "Acme Inc",
          employerDomain: "acme.com",
        }),
      ],
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.companies).toHaveLength(2);
    const primary = result.companies.find((company) => company.id === "c1")!;
    expect(primary.jobIds).toEqual(["job_1"]);
    expect(result.summary.ambiguousEvidenceCount).toBe(0);
  });

  test("does not let a legacy unknown alias and domain claim a job", () => {
    const polluted = makeCompany({
      id: "polluted",
      canonicalName: "Legacy Holdings",
      aliases: [
        {
          alias: "Acme Inc",
          normalized: "acme inc",
          confidence: 1,
          identityAuthority: "unknown",
        },
      ],
      domains: [{ domain: "acme.example", primary: true, verifiedAt: null }],
    });
    const result = reconcileCompanies({
      companies: [polluted],
      jobs: [
        makeJob({
          id: "job_acme",
          company: "Acme Inc",
          employerDomain: "acme.example",
        }),
      ],
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.companies).toHaveLength(2);
    expect(
      result.companies.find((company) => company.id === "polluted")?.jobIds,
    ).toEqual([]);
    expect(
      result.companies.find((company) => company.canonicalName === "Acme Inc")
        ?.jobIds,
    ).toEqual(["job_acme"]);
    expect(result.summary.createdMergeCandidates).toHaveLength(1);
  });

  test("accepts an approved alias but rejects ambiguous approved aliases", () => {
    const approvedAlias = {
      alias: "Acme",
      normalized: "acme",
      confidence: 1,
      identityAuthority: "user_approved_merge" as const,
    };
    const unique = reconcileCompanies({
      companies: [
        makeCompany({
          id: "approved",
          canonicalName: "Acme Incorporated",
          aliases: [approvedAlias],
        }),
      ],
      jobs: [makeJob({ id: "job_alias", company: "Acme" })],
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });
    expect(unique.ok).toBe(true);
    if (!unique.ok) return;
    expect(unique.companies[0]?.jobIds).toEqual(["job_alias"]);

    const ambiguous = reconcileCompanies({
      companies: [
        makeCompany({
          id: "first",
          canonicalName: "Acme Incorporated",
          aliases: [approvedAlias],
          jobIds: ["job_alias"],
        }),
        makeCompany({
          id: "second",
          canonicalName: "Acme Group",
          aliases: [approvedAlias],
          jobIds: ["job_alias"],
        }),
      ],
      jobs: [makeJob({ id: "job_alias", company: "Acme" })],
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });
    expect(ambiguous.ok).toBe(true);
    if (!ambiguous.ok) return;
    expect(ambiguous.companies.flatMap((company) => company.jobIds)).toEqual(
      [],
    );
    expect(ambiguous.summary.ambiguousEvidenceCount).toBe(1);
  });

  test.each(genericCompanyNameValues)(
    "does not create or retain ownership for generic company name %s",
    (name) => {
      const result = reconcileCompanies({
        companies: [
          makeCompany({
            id: "legacy",
            canonicalName: "Real Employer",
            jobIds: ["job_unknown"],
            applicationRecordIds: ["app_unknown"],
          }),
        ],
        jobs: [
          makeJob({
            id: "job_unknown",
            company: name,
            employerDomain: "real.example",
          }),
        ],
        applicationRecords: [
          makeApplicationRecord({
            id: "app_unknown",
            jobId: "job_unknown",
            company: "Real Employer",
          }),
        ],
        now,
        createCompanyId: defaultCreateCompanyId,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.companies).toHaveLength(1);
      expect(result.companies[0]?.jobIds).toEqual([]);
      expect(result.companies[0]?.applicationRecordIds).toEqual([]);
      expect(result.summary.unresolvableEvidenceCount).toBe(1);
    },
  );

  test.each([
    "Employer not stated",
    "Location not stated",
    "Unknown",
    "Politikë e Privatësisë",
    "Politikë e Privatësisë dhe Mbrojtjes së të Dhënave Personale",
    "Privacy Policy",
  ])("purges legacy unlistable company shell %s", (name) => {
    const result = reconcileCompanies({
      companies: [
        makeCompany({
          id: "placeholder",
          canonicalName: name,
          jobIds: ["job_placeholder"],
          applicationRecordIds: [],
          mergeReviewCandidates: [
            {
              candidateCompanyId: "real",
              reason: "Near-name conflict.",
              decision: "pending",
              decidedAt: null,
              requiresUserDecision: true,
            },
          ],
        }),
        makeCompany({
          id: "real",
          canonicalName: "Acme Inc",
          jobIds: ["job_real"],
          mergeReviewCandidates: [
            {
              candidateCompanyId: "placeholder",
              reason: "Near-name conflict.",
              decision: "pending",
              decidedAt: null,
              requiresUserDecision: true,
            },
          ],
        }),
      ],
      jobs: [
        makeJob({
          id: "job_placeholder",
          company: name,
        }),
        makeJob({ id: "job_real", company: "Acme Inc" }),
      ],
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.companies.map((company) => company.id)).toEqual(["real"]);
    expect(result.companies[0]?.jobIds).toEqual(["job_real"]);
    expect(result.companies[0]?.mergeReviewCandidates).toEqual([]);
    expect(result.summary.createdCompanyIds).toEqual([]);
  });

  test.each([
    "Named Staffing Agency",
    "Recruiting Agency Partners",
    "Staffing Agency, Inc.",
  ])("creates ownership for legitimate agency %s", (name) => {
    const result = reconcileCompanies({
      companies: [],
      jobs: [makeJob({ id: "job_agency", company: name })],
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.companies).toHaveLength(1);
    expect(result.companies[0]?.canonicalName).toBe(name);
    expect(result.companies[0]?.jobIds).toEqual(["job_agency"]);
  });

  test("creates a pending merge candidate for a near-name conflict", () => {
    const result = reconcileCompanies({
      companies: [
        makeCompany({ id: "c1", canonicalName: "Acme Inc" }),
        makeCompany({ id: "c2", canonicalName: "Acme" }),
      ],
      jobs: [],
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const primary = result.companies.find((company) => company.id === "c1")!;
    expect(primary.mergeReviewCandidates).toHaveLength(1);
    expect(primary.mergeReviewCandidates[0]!.candidateCompanyId).toBe("c2");
    expect(primary.mergeReviewCandidates[0]!.decision).toBe("pending");
    expect(primary.mergeReviewCandidates[0]!.reason).toContain("Similar");
    expect(primary.mergeReviewCandidates[0]!.requiresUserDecision).toBe(true);
  });

  test("creates a pending merge candidate for a near-domain conflict", () => {
    const result = reconcileCompanies({
      companies: [
        makeCompany({
          id: "c1",
          canonicalName: "Acme Inc",
          domains: [{ domain: "acme.com", primary: true, verifiedAt: null }],
        }),
        makeCompany({
          id: "c2",
          canonicalName: "Acme Corp",
          domains: [{ domain: "acme.io", primary: true, verifiedAt: null }],
        }),
      ],
      jobs: [],
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const primary = result.companies.find((company) => company.id === "c1")!;
    expect(primary.mergeReviewCandidates).toHaveLength(1);
    expect(primary.mergeReviewCandidates[0]!.candidateCompanyId).toBe("c2");
    expect(primary.mergeReviewCandidates[0]!.reason).toContain(
      "Similar employer domain",
    );
  });

  test("links applications through their saved job and records copied names as unknown aliases", () => {
    const result = reconcileCompanies({
      companies: [],
      jobs: [makeJob({ id: "job_1", company: "Northwind Labs" })],
      applicationRecords: [
        makeApplicationRecord({
          id: "app_1",
          jobId: "job_1",
          company: "Northwind Laboratories",
        }),
      ],
      now,
      createCompanyId: defaultCreateCompanyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.companies).toHaveLength(1);
    const company = result.companies[0]!;
    expect(company.jobIds).toEqual(["job_1"]);
    expect(company.applicationRecordIds).toEqual(["app_1"]);
    expect(company.aliases).toContainEqual({
      alias: "Northwind Laboratories",
      normalized: "northwind laboratories",
      confidence: 1,
      identityAuthority: "unknown",
    });
    expect(company.sourceHistory[0]!.sourceId).toBe("target_site");
    expect(company.sourceHistory[0]!.applicationRecordIds).toEqual(["app_1"]);
  });

  test("preserves a legacy application membership when its saved job is missing", () => {
    const legacy = makeCompany({
      id: "legacy",
      canonicalName: "Original Employer",
      applicationRecordIds: ["legacy_app"],
    });
    const result = reconcileCompanies({
      companies: [
        legacy,
        makeCompany({ id: "copied", canonicalName: "Copied Employer" }),
      ],
      jobs: [],
      applicationRecords: [
        makeApplicationRecord({
          id: "legacy_app",
          jobId: "deleted_job",
          company: "Copied Employer",
        }),
      ],
      now,
      createCompanyId: defaultCreateCompanyId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.companies.find((company) => company.id === "legacy")
        ?.applicationRecordIds,
    ).toEqual(["legacy_app"]);
    expect(
      result.companies.find((company) => company.id === "copied")
        ?.applicationRecordIds,
    ).toEqual([]);
    expect(result.summary.unresolvableEvidenceCount).toBe(1);
  });

  test("reassigns current job and application memberships without removing unrelated links", () => {
    const initial = reconcileCompanies({
      companies: [],
      jobs: [
        makeJob({
          id: "job_move",
          company: "Acme Inc",
          employerDomain: "acme.example",
        }),
        makeJob({
          id: "job_keep",
          company: "Acme Inc",
          employerDomain: "acme.example",
        }),
      ],
      applicationRecords: [
        makeApplicationRecord({
          id: "app_move",
          jobId: "job_move",
          company: "Acme Inc",
        }),
        makeApplicationRecord({
          id: "app_keep",
          jobId: "job_keep",
          company: "Acme Inc",
        }),
      ],
      now,
      createCompanyId: defaultCreateCompanyId,
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;

    const acmeId = initial.companies[0]!.id;
    const companiesWithLegacyLinks = initial.companies.map((company) =>
      company.id === acmeId
        ? makeCompany({
            ...company,
            jobIds: [...company.jobIds, "legacy_job"],
            applicationRecordIds: [
              ...company.applicationRecordIds,
              "legacy_app",
            ],
          })
        : company,
    );
    const reassignedJobs = [
      makeJob({
        id: "job_move",
        company: "Other Inc",
        employerDomain: "other.example",
      }),
      makeJob({
        id: "job_keep",
        company: "Acme Inc",
        employerDomain: "acme.example",
      }),
    ];
    const reassignedRecords = [
      makeApplicationRecord({
        id: "app_move",
        jobId: "job_move",
        company: "Other Inc",
      }),
      makeApplicationRecord({
        id: "app_keep",
        jobId: "job_keep",
        company: "Acme Inc",
      }),
    ];
    const reassigned = reconcileCompanies({
      companies: companiesWithLegacyLinks,
      jobs: reassignedJobs,
      applicationRecords: reassignedRecords,
      now: later,
      createCompanyId: defaultCreateCompanyId,
    });
    expect(reassigned.ok).toBe(true);
    if (!reassigned.ok) return;

    const acme = reassigned.companies.find((company) => company.id === acmeId)!;
    const other = reassigned.companies.find(
      (company) => company.canonicalName === "Other Inc",
    )!;
    expect(acme.jobIds).toEqual(["job_keep", "legacy_job"]);
    expect(acme.applicationRecordIds).toEqual(["app_keep", "legacy_app"]);
    expect(other.jobIds).toEqual(["job_move"]);
    expect(other.applicationRecordIds).toEqual(["app_move"]);

    const evidence = {
      id: "evidence_reassigned",
      kind: "offer" as const,
      summary: "Current offer",
      currency: "USD",
      minimum: 200000,
      maximum: 200000,
      period: "year" as const,
      offerStatus: "active" as const,
      jobId: "job_move",
      applicationRecordId: "app_move",
      source: "manual",
      recordedAt: latest,
      createdAt: latest,
      updatedAt: latest,
    };
    const mutate = (company: CompanyEntity) =>
      applyCompanyIntelligenceMutation({
        companies: reassigned.companies,
        jobs: reassignedJobs,
        applicationRecords: reassignedRecords,
        input: {
          companyId: company.id,
          expectedUpdatedAt: company.updatedAt,
          mutation: { type: "upsert_salary_offer_evidence", evidence },
        },
        now: latest,
      });
    const rejected = mutate(acme);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok)
      expect(rejected.failure.code).toBe("job_company_mismatch");
    expect(mutate(other).ok).toBe(true);

    const restarted = reconcileCompanies({
      companies: reassigned.companies,
      jobs: reassignedJobs,
      applicationRecords: reassignedRecords,
      now: latest,
      createCompanyId: defaultCreateCompanyId,
    });
    expect(restarted.ok).toBe(true);
    if (!restarted.ok) return;
    expect(
      restarted.companies.find((company) => company.id === acmeId)?.jobIds,
    ).toEqual(["job_keep", "legacy_job"]);
    expect(
      restarted.companies.find((company) => company.id === other.id)
        ?.applicationRecordIds,
    ).toEqual(["app_move"]);
  });

  test("is idempotent and never mutates its inputs", () => {
    const companies = [makeCompany({ id: "c1", canonicalName: "Acme Inc" })];
    const companiesSnapshot = JSON.stringify(companies);
    const jobs = [
      makeJob({ id: "job_1", company: "Acme Inc", employerDomain: "acme.com" }),
    ];
    const jobsSnapshot = JSON.stringify(jobs);

    const first = reconcileCompanies({
      companies,
      jobs,
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = reconcileCompanies({
      companies: first.companies,
      jobs,
      applicationRecords: [],
      now,
      createCompanyId: defaultCreateCompanyId,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.companies).toEqual(first.companies);
    expect(second.companies[0]!.jobIds).toEqual(["job_1"]);
    expect(second.companies[0]!.updatedAt).toBe("2026-08-15T10:00:00.001Z");
    expect(JSON.stringify(companies)).toBe(companiesSnapshot);
    expect(JSON.stringify(jobs)).toBe(jobsSnapshot);
  });

  test("fails with a structured failure when createCompanyId collides", () => {
    const result = reconcileCompanies({
      companies: [makeCompany({ id: "existing", canonicalName: "Acme Inc" })],
      jobs: [makeJob({ id: "job_1", company: "Northwind Labs" })],
      applicationRecords: [],
      now,
      createCompanyId: () => "existing",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_input");
    expect(result.failure.message).toContain("already exists");
  });

  test("fails with a structured failure for an invalid now", () => {
    const result = reconcileCompanies({
      companies: [],
      jobs: [makeJob({ id: "job_1", company: "Acme Inc" })],
      applicationRecords: [],
      now: "not-a-date",
      createCompanyId: defaultCreateCompanyId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_input");
  });
});

describe("setCompanyPreference", () => {
  test("sets the preference, clears the reason, and stamps caller now", () => {
    const companies = [
      makeCompany({
        id: "c1",
        preference: "follow",
        preferenceReason: "Inferred from volume.",
      }),
    ];

    const result = setCompanyPreference({
      companies,
      input: { companyId: "c1", preference: "exclude" },
      now: later,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.company.preference).toBe("exclude");
    expect(result.company.preferenceReason).toBeNull();
    expect(result.company.updatedAt).toBe(later);
    expect(result.companies).toHaveLength(1);
    expect(result.companies[0]).toEqual(result.company);
    expect(CompanyEntitySchema.safeParse(result.company).success).toBe(true);
  });

  test("fails when the company does not exist", () => {
    const result = setCompanyPreference({
      companies: [makeCompany({ id: "c1" })],
      input: { companyId: "missing", preference: "exclude" },
      now,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("company_not_found");
  });
});

describe("reviewCompanyMerge", () => {
  function companiesWithCandidate(): CompanyEntity[] {
    return [
      makeCompany({
        id: "primary",
        canonicalName: "Acme Inc",
        mergeReviewCandidates: [
          {
            candidateCompanyId: "secondary",
            reason: "Similar company name.",
            decision: "pending",
            decidedAt: null,
            requiresUserDecision: true,
          },
        ],
      }),
      makeCompany({ id: "secondary", canonicalName: "Acme" }),
    ];
  }

  test("rejects a merge candidate explicitly", () => {
    const result = reviewCompanyMerge({
      companies: companiesWithCandidate(),
      input: {
        companyId: "primary",
        candidateId: "secondary",
        decision: "rejected",
      },
      now: later,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.merged).toBeNull();
    expect(result.companies).toHaveLength(2);
    const primary = result.companies.find(
      (company) => company.id === "primary",
    )!;
    expect(primary.mergeReviewCandidates[0]!.decision).toBe("rejected");
    expect(primary.mergeReviewCandidates[0]!.decidedAt).toBe(later);
    expect(primary.updatedAt).toBe(later);
    expect(
      CompanyEntitySchema.array().safeParse(result.companies).success,
    ).toBe(true);
  });

  test("accepts a merge and preserves ids and aliases deterministically", () => {
    const primary = makeCompany({
      id: "primary",
      canonicalName: "Acme Inc",
      aliases: [
        {
          alias: "Acme Incorporated",
          normalized: "acme incorporated",
          confidence: 1,
          identityAuthority: "unknown",
        },
        {
          alias: "Acme",
          normalized: "acme",
          confidence: 0.5,
          identityAuthority: "unknown",
        },
      ],
      domains: [{ domain: "acme.com", primary: true, verifiedAt: null }],
      contacts: [
        {
          id: "contact_1",
          name: "Ada",
          role: null,
          email: null,
          phone: null,
          notes: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      notes: [
        { id: "note_1", body: "Initial note", createdAt: now, updatedAt: now },
      ],
      sourceHistory: [
        {
          id: "target_site",
          sourceId: "target_site",
          firstSeenAt: "2026-08-01T00:00:00.000Z",
          lastSeenAt: "2026-08-02T00:00:00.000Z",
          applicationRecordIds: ["app_1"],
        },
      ],
      jobIds: ["job_1"],
      applicationRecordIds: ["app_1"],
      mergeReviewCandidates: [
        {
          candidateCompanyId: "secondary",
          reason: "Similar company name.",
          decision: "pending",
          decidedAt: null,
          requiresUserDecision: true,
        },
      ],
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    const secondary = makeCompany({
      id: "secondary",
      canonicalName: "Acme",
      domains: [{ domain: "acme.io", primary: true, verifiedAt: null }],
      contacts: [
        {
          id: "contact_2",
          name: "Grace",
          role: null,
          email: null,
          phone: null,
          notes: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      notes: [
        { id: "note_2", body: "Second note", createdAt: now, updatedAt: now },
      ],
      sourceHistory: [
        {
          id: "target_site",
          sourceId: "target_site",
          firstSeenAt: "2026-08-01T00:00:00.000Z",
          lastSeenAt: "2026-08-05T00:00:00.000Z",
          applicationRecordIds: ["app_2"],
        },
      ],
      jobIds: ["job_2"],
      applicationRecordIds: ["app_2"],
      createdAt: "2026-08-02T00:00:00.000Z",
    });

    const result = reviewCompanyMerge({
      companies: [primary, secondary],
      input: {
        companyId: "primary",
        candidateId: "secondary",
        decision: "accepted",
      },
      now: latest,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.companies).toHaveLength(1);
    const merged = result.merged!;
    expect(merged.id).toBe("primary");
    expect(merged.canonicalName).toBe("Acme Inc");
    expect(merged.jobIds).toEqual(["job_1", "job_2"]);
    expect(merged.applicationRecordIds).toEqual(["app_1", "app_2"]);
    expect(merged.contacts.map((contact) => contact.id)).toEqual([
      "contact_1",
      "contact_2",
    ]);
    expect(merged.notes.map((note) => note.id)).toEqual(["note_1", "note_2"]);
    expect(merged.sourceHistory).toEqual([
      {
        id: "target_site",
        sourceId: "target_site",
        firstSeenAt: "2026-08-01T00:00:00.000Z",
        lastSeenAt: "2026-08-05T00:00:00.000Z",
        applicationRecordIds: ["app_1", "app_2"],
      },
    ]);
    expect(merged.aliases.map((alias) => alias.normalized)).toEqual([
      "acme incorporated",
      "acme",
    ]);
    expect(merged.aliases.map((alias) => alias.identityAuthority)).toEqual([
      "unknown",
      "user_approved_merge",
    ]);
    expect(merged.domains).toEqual([
      { domain: "acme.com", primary: true, verifiedAt: null },
      { domain: "acme.io", primary: false, verifiedAt: null },
    ]);
    expect(merged.createdAt).toBe("2026-08-01T00:00:00.000Z");
    expect(merged.updatedAt).toBe(latest);
    expect(merged.mergeReviewCandidates).toEqual([]);
    expect(result.company).toEqual(merged);
    expect(CompanyEntitySchema.safeParse(merged).success).toBe(true);
  });

  test("remaps merge candidates on other companies after an accept", () => {
    const result = reviewCompanyMerge({
      companies: [
        makeCompany({
          id: "primary",
          canonicalName: "Acme Inc",
          mergeReviewCandidates: [
            {
              candidateCompanyId: "secondary",
              reason: "Similar company name.",
              decision: "pending",
              decidedAt: null,
              requiresUserDecision: true,
            },
          ],
        }),
        makeCompany({ id: "secondary", canonicalName: "Acme" }),
        makeCompany({
          id: "third",
          canonicalName: "Acme Tools",
          mergeReviewCandidates: [
            {
              candidateCompanyId: "secondary",
              reason: "Similar company name.",
              decision: "pending",
              decidedAt: null,
              requiresUserDecision: true,
            },
          ],
        }),
      ],
      input: {
        companyId: "primary",
        candidateId: "secondary",
        decision: "accepted",
      },
      now: latest,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.companies).toHaveLength(2);
    const third = result.companies.find((company) => company.id === "third")!;
    expect(third.mergeReviewCandidates[0]!.candidateCompanyId).toBe("primary");
    expect(third.updatedAt).toBe(latest);
  });

  test("fails when the candidate was already decided", () => {
    const companies = [
      makeCompany({
        id: "primary",
        canonicalName: "Acme Inc",
        mergeReviewCandidates: [
          {
            candidateCompanyId: "secondary",
            reason: "Similar company name.",
            decision: "rejected",
            decidedAt: now,
            requiresUserDecision: true,
          },
        ],
      }),
      makeCompany({ id: "secondary", canonicalName: "Acme" }),
    ];

    const result = reviewCompanyMerge({
      companies,
      input: {
        companyId: "primary",
        candidateId: "secondary",
        decision: "accepted",
      },
      now: later,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("candidate_already_decided");
  });

  test("fails when the company or candidate is missing", () => {
    const missingCompany = reviewCompanyMerge({
      companies: companiesWithCandidate(),
      input: {
        companyId: "missing",
        candidateId: "secondary",
        decision: "accepted",
      },
      now,
    });
    expect(missingCompany.ok).toBe(false);
    if (missingCompany.ok) return;
    expect(missingCompany.failure.code).toBe("company_not_found");

    const missingCandidate = reviewCompanyMerge({
      companies: companiesWithCandidate(),
      input: {
        companyId: "primary",
        candidateId: "missing",
        decision: "accepted",
      },
      now,
    });
    expect(missingCandidate.ok).toBe(false);
    if (missingCandidate.ok) return;
    expect(missingCandidate.failure.code).toBe("candidate_not_found");
  });
});

describe("projectCompanyOpenings", () => {
  test("splits linked jobs into current and previous openings", () => {
    const company = makeCompany({
      id: "c1",
      canonicalName: "Acme Inc",
      jobIds: ["job_open", "job_closed"],
    });

    const projection = projectCompanyOpenings({
      company,
      jobs: [
        makeJob({
          id: "job_open",
          company: "Acme Inc",
          status: "interview",
          postedAt: "2026-08-05T00:00:00.000Z",
        }),
        makeJob({
          id: "job_closed",
          company: "Acme Inc",
          status: "rejected",
          postedAt: "2026-08-10T00:00:00.000Z",
        }),
        makeJob({
          id: "job_unlinked",
          company: "Other",
          status: "submitted",
          postedAt: "2026-08-01T00:00:00.000Z",
        }),
      ],
    });

    expect(projection.companyId).toBe("c1");
    expect(projection.current.map((job) => job.id)).toEqual(["job_open"]);
    expect(projection.previous.map((job) => job.id)).toEqual(["job_closed"]);
    expect(projection.currentCount).toBe(1);
    expect(projection.previousCount).toBe(1);
    expect(projection.totalCount).toBe(2);
    expect(projection.lastOpenedAt).toBe("2026-08-10T00:00:00.000Z");
    expect(SavedJobSchema.safeParse(projection.current[0]).success).toBe(true);
  });

  test("sorts openings most recent first", () => {
    const company = makeCompany({
      id: "c1",
      jobIds: ["job_a", "job_b"],
    });

    const projection = projectCompanyOpenings({
      company,
      jobs: [
        makeJob({
          id: "job_a",
          company: "Acme Inc",
          status: "ready_for_review",
          postedAt: "2026-07-01T00:00:00.000Z",
        }),
        makeJob({
          id: "job_b",
          company: "Acme Inc",
          status: "submitted",
          postedAt: "2026-08-01T00:00:00.000Z",
        }),
      ],
    });

    expect(projection.current.map((job) => job.id)).toEqual(["job_b", "job_a"]);
  });
});

describe("projectCompanyApplicationHistory", () => {
  test("projects linked records newest first with status counts", () => {
    const company = makeCompany({
      id: "c1",
      applicationRecordIds: ["app_old", "app_new"],
    });

    const projection = projectCompanyApplicationHistory({
      company,
      applicationRecords: [
        makeApplicationRecord({
          id: "app_old",
          jobId: "job_1",
          company: "Acme Inc",
          status: "rejected",
          lastUpdatedAt: "2026-08-01T00:00:00.000Z",
        }),
        makeApplicationRecord({
          id: "app_new",
          jobId: "job_2",
          company: "Acme Inc",
          status: "interview",
          lastUpdatedAt: "2026-08-10T00:00:00.000Z",
        }),
        makeApplicationRecord({
          id: "app_unlinked",
          jobId: "job_3",
          company: "Other",
          status: "submitted",
          lastUpdatedAt: "2026-08-09T00:00:00.000Z",
        }),
      ],
    });

    expect(projection.companyId).toBe("c1");
    expect(projection.records.map((record) => record.id)).toEqual([
      "app_new",
      "app_old",
    ]);
    expect(projection.totalCount).toBe(2);
    expect(projection.statusCounts.interview).toBe(1);
    expect(projection.statusCounts.rejected).toBe(1);
    expect(projection.statusCounts.submitted).toBe(0);
    expect(projection.latestUpdatedAt).toBe("2026-08-10T00:00:00.000Z");
    expect(projection.earliestUpdatedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(
      ApplicationRecordSchema.safeParse(projection.records[0]).success,
    ).toBe(true);
  });

  test("returns empty counts when nothing is linked", () => {
    const projection = projectCompanyApplicationHistory({
      company: makeCompany({ id: "c1" }),
      applicationRecords: [],
    });

    expect(projection.records).toEqual([]);
    expect(projection.totalCount).toBe(0);
    expect(projection.latestUpdatedAt).toBeNull();
    expect(projection.earliestUpdatedAt).toBeNull();
    expect(projection.statusCounts.interview).toBe(0);
  });
});

describe("applyCompanyIntelligenceMutation", () => {
  function companiesWith(canonicalName = "Acme Inc"): CompanyEntity[] {
    return [
      makeCompany({
        id: "c1",
        canonicalName,
        contacts: [
          {
            id: "contact_1",
            name: "Ada",
            role: "Recruiter",
            email: "ada@acme.com",
            phone: null,
            notes: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        notes: [
          {
            id: "note_1",
            body: "First call went well",
            createdAt: now,
            updatedAt: now,
          },
        ],
        salaryOfferEvidence: [
          {
            id: "evidence_1",
            kind: "offer",
            summary: "Verbal offer",
            currency: "USD",
            minimum: 190000,
            maximum: 190000,
            period: "year",
            offerStatus: "active",
            jobId: null,
            applicationRecordId: null,
            source: "manual",
            recordedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        ],
        jobIds: ["job_1"],
        applicationRecordIds: ["app_1", "app_2"],
      }),
    ];
  }

  test("advances every mutation variant beyond a fixed or future company timestamp", () => {
    const mutations: CompanyIntelligenceMutationInput["mutation"][] = [
      {
        type: "upsert_contact",
        contact: {
          id: "contact_2",
          name: "Grace",
          role: null,
          email: null,
          phone: null,
          notes: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      { type: "remove_contact", contactId: "contact_1" },
      {
        type: "add_note",
        note: {
          id: "note_2",
          body: "Next call",
          createdAt: now,
          updatedAt: now,
        },
      },
      { type: "remove_note", noteId: "note_1" },
      {
        type: "upsert_salary_offer_evidence",
        evidence: {
          id: "evidence_2",
          kind: "listed_salary",
          summary: "New offer",
          currency: "USD",
          minimum: 200000,
          maximum: 200000,
          period: "year",
          offerStatus: null,
          jobId: "job_1",
          applicationRecordId: null,
          source: "manual",
          recordedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        type: "remove_salary_offer_evidence",
        evidenceId: "evidence_1",
      },
    ];

    for (const mutation of mutations) {
      const company = makeCompany({
        ...companiesWith()[0],
        updatedAt: later,
      });
      const result = applyCompanyIntelligenceMutation({
        companies: [company],
        jobs: [makeJob({ id: "job_1", company: "Acme Inc" })],
        input: {
          companyId: company.id,
          expectedUpdatedAt: later,
          mutation,
        },
        now,
      });

      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) continue;
      expect(result.company.updatedAt).toBe("2026-08-15T11:00:00.001Z");
      expect(Date.parse(result.company.updatedAt)).toBeGreaterThan(
        Date.parse(company.updatedAt),
      );
    }
  });

  test("allows exactly one of two same-millisecond commands with the same CAS timestamp", () => {
    const companies = companiesWith();
    const first = applyCompanyIntelligenceMutation({
      companies,
      input: {
        companyId: "c1",
        expectedUpdatedAt: now,
        mutation: { type: "remove_note", noteId: "note_1" },
      },
      now,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.company.updatedAt).toBe("2026-08-15T10:00:00.001Z");

    const second = applyCompanyIntelligenceMutation({
      companies: first.companies,
      input: {
        companyId: "c1",
        expectedUpdatedAt: now,
        mutation: { type: "remove_contact", contactId: "contact_1" },
      },
      now,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.failure.code).toBe("company_changed");
  });

  test("upserts a contact preserving the original createdAt", () => {
    const result = applyCompanyIntelligenceMutation({
      companies: companiesWith(),
      input: {
        companyId: "c1",
        expectedUpdatedAt: now,
        mutation: {
          type: "upsert_contact",
          contact: {
            id: "contact_1",
            name: "Ada Lovelace",
            role: "Senior recruiter",
            email: "ada@acme.com",
            phone: null,
            notes: null,
            createdAt: later,
            updatedAt: later,
          },
        },
      },
      now: latest,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.companies).toHaveLength(1);
    const company = result.company;
    expect(company.contacts).toHaveLength(1);
    expect(company.contacts[0]).toMatchObject({
      id: "contact_1",
      name: "Ada Lovelace",
      role: "Senior recruiter",
    });
    // The caller-provided createdAt is ignored on an upsert; the original is kept.
    expect(company.contacts[0]!.createdAt).toBe(now);
    expect(company.contacts[0]!.updatedAt).toBe(latest);
    expect(company.updatedAt).toBe(latest);
    expect(CompanyEntitySchema.safeParse(company).success).toBe(true);
  });

  test("adds a new contact when the id does not exist", () => {
    const result = applyCompanyIntelligenceMutation({
      companies: companiesWith(),
      input: {
        companyId: "c1",
        expectedUpdatedAt: now,
        mutation: {
          type: "upsert_contact",
          contact: {
            id: "contact_2",
            name: "Grace",
            role: null,
            email: null,
            phone: null,
            notes: null,
            createdAt: later,
            updatedAt: later,
          },
        },
      },
      now: latest,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.company.contacts.map((contact) => contact.id)).toEqual([
      "contact_1",
      "contact_2",
    ]);
  });

  test("removes a contact and fails when the contact is missing", () => {
    const removed = applyCompanyIntelligenceMutation({
      companies: companiesWith(),
      input: {
        companyId: "c1",
        expectedUpdatedAt: now,
        mutation: { type: "remove_contact", contactId: "contact_1" },
      },
      now: latest,
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.company.contacts).toEqual([]);

    const missing = applyCompanyIntelligenceMutation({
      companies: companiesWith(),
      input: {
        companyId: "c1",
        expectedUpdatedAt: now,
        mutation: { type: "remove_contact", contactId: "missing" },
      },
      now: latest,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.failure.code).toBe("contact_not_found");
  });

  test("adds and removes notes", () => {
    const added = applyCompanyIntelligenceMutation({
      companies: companiesWith(),
      input: {
        companyId: "c1",
        expectedUpdatedAt: now,
        mutation: {
          type: "add_note",
          note: {
            id: "note_2",
            body: "Second call scheduled",
            createdAt: later,
            updatedAt: later,
          },
        },
      },
      now: latest,
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.company.notes.map((note) => note.id)).toEqual([
      "note_1",
      "note_2",
    ]);

    const removed = applyCompanyIntelligenceMutation({
      companies: companiesWith(),
      input: {
        companyId: "c1",
        expectedUpdatedAt: now,
        mutation: { type: "remove_note", noteId: "note_1" },
      },
      now: latest,
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.company.notes).toEqual([]);
  });

  test("upserts and removes salary/offer evidence", () => {
    const updated = applyCompanyIntelligenceMutation({
      companies: companiesWith(),
      jobs: [makeJob({ id: "job_1", company: "Acme Inc" })],
      applicationRecords: [
        makeApplicationRecord({
          id: "app_1",
          jobId: "job_1",
          company: "Acme Inc",
        }),
      ],
      input: {
        companyId: "c1",
        expectedUpdatedAt: now,
        mutation: {
          type: "upsert_salary_offer_evidence",
          evidence: {
            id: "evidence_1",
            kind: "offer",
            summary: "Signed offer",
            currency: "USD",
            minimum: 195000,
            maximum: 195000,
            period: "year",
            offerStatus: "accepted",
            jobId: "job_1",
            applicationRecordId: "app_1",
            source: "manual",
            recordedAt: later,
            createdAt: later,
            updatedAt: later,
          },
        },
      },
      now: latest,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.company.salaryOfferEvidence).toHaveLength(1);
    expect(updated.company.salaryOfferEvidence[0]).toMatchObject({
      id: "evidence_1",
      summary: "Signed offer",
      offerStatus: "accepted",
    });
    expect(updated.company.salaryOfferEvidence[0]!.createdAt).toBe(now);

    const removed = applyCompanyIntelligenceMutation({
      companies: companiesWith(),
      input: {
        companyId: "c1",
        expectedUpdatedAt: now,
        mutation: {
          type: "remove_salary_offer_evidence",
          evidenceId: "evidence_1",
        },
      },
      now: latest,
    });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.company.salaryOfferEvidence).toEqual([]);
  });

  test("validates exact current job, company, and application lineage before writing", () => {
    const jobs = [
      makeJob({ id: "job_1", company: "Acme Inc" }),
      makeJob({ id: "job_other", company: "Other Inc" }),
    ];
    const applicationRecords = [
      makeApplicationRecord({
        id: "app_1",
        jobId: "job_1",
        company: "Acme Inc",
      }),
      makeApplicationRecord({
        id: "app_2",
        jobId: "job_1",
        company: "Acme Inc",
      }),
      makeApplicationRecord({
        id: "app_other_job",
        jobId: "job_other",
        company: "Other Inc",
      }),
    ];
    const companies = companiesWith();
    const snapshot = JSON.stringify(companies);
    const evidence = {
      id: "evidence_new",
      kind: "offer" as const,
      summary: "Exact offer",
      currency: "USD",
      minimum: 200000,
      maximum: 200000,
      period: "year" as const,
      offerStatus: "active" as const,
      jobId: "job_1",
      applicationRecordId: "app_2",
      source: "manual",
      recordedAt: later,
      createdAt: later,
      updatedAt: later,
    };
    const apply = (overrides: Partial<typeof evidence>) =>
      applyCompanyIntelligenceMutation({
        companies,
        jobs,
        applicationRecords,
        input: {
          companyId: "c1",
          expectedUpdatedAt: now,
          mutation: {
            type: "upsert_salary_offer_evidence",
            evidence: { ...evidence, ...overrides },
          },
        },
        now: latest,
      });

    expect(apply({}).ok).toBe(true);
    for (const [overrides, code] of [
      [{ jobId: "missing" }, "job_not_found"],
      [
        { jobId: "job_other", applicationRecordId: "app_other_job" },
        "job_company_mismatch",
      ],
      [{ applicationRecordId: "deleted" }, "application_record_not_found"],
      [{ applicationRecordId: "app_other_job" }, "application_record_mismatch"],
    ] as const) {
      const result = apply(overrides);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe(code);
      expect(JSON.stringify(companies)).toBe(snapshot);
    }

    const salary = applyCompanyIntelligenceMutation({
      companies,
      jobs,
      applicationRecords,
      input: {
        companyId: "c1",
        expectedUpdatedAt: now,
        mutation: {
          type: "upsert_salary_offer_evidence",
          evidence: {
            ...evidence,
            kind: "listed_salary",
            applicationRecordId: null,
          },
        },
      },
      now: latest,
    });
    expect(salary.ok).toBe(true);
  });

  test("fails closed for ambiguous current company identity without writing", () => {
    const companies = [
      makeCompany({
        id: "c1",
        canonicalName: "Acme One",
        aliases: [
          {
            alias: "Acme",
            normalized: "acme",
            confidence: 1,
            identityAuthority: "user_approved_merge",
          },
        ],
        domains: [
          { domain: "shared.example", primary: true, verifiedAt: null },
        ],
        jobIds: ["job_1", "job_alias"],
        applicationRecordIds: ["app_1"],
      }),
      makeCompany({
        id: "c2",
        canonicalName: "Acme Two",
        aliases: [
          {
            alias: "Acme",
            normalized: "acme",
            confidence: 1,
            identityAuthority: "user_approved_merge",
          },
        ],
        domains: [
          { domain: "shared.example", primary: true, verifiedAt: null },
        ],
        jobIds: ["job_1", "job_alias"],
        applicationRecordIds: ["app_1"],
      }),
    ];
    const snapshot = JSON.stringify(companies);
    const job = makeJob({
      id: "job_1",
      company: "Acme",
      employerDomain: "shared.example",
    });
    const record = makeApplicationRecord({
      id: "app_1",
      jobId: "job_1",
      company: "Acme",
    });

    for (const company of companies) {
      const result = applyCompanyIntelligenceMutation({
        companies,
        jobs: [job],
        applicationRecords: [record],
        input: {
          companyId: company.id,
          expectedUpdatedAt: company.updatedAt,
          mutation: {
            type: "upsert_salary_offer_evidence",
            evidence: {
              id: "ambiguous_evidence",
              kind: "offer",
              summary: "Ambiguous offer",
              currency: "USD",
              minimum: 180000,
              maximum: 180000,
              period: "year",
              offerStatus: "active",
              jobId: "job_1",
              applicationRecordId: "app_1",
              source: "manual",
              recordedAt: later,
              createdAt: later,
              updatedAt: later,
            },
          },
        },
        now: latest,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe("job_company_mismatch");

      const aliasResult = applyCompanyIntelligenceMutation({
        companies,
        jobs: [makeJob({ id: "job_alias", company: "Acme" })],
        applicationRecords: [],
        input: {
          companyId: company.id,
          expectedUpdatedAt: company.updatedAt,
          mutation: {
            type: "upsert_salary_offer_evidence",
            evidence: {
              id: "ambiguous_alias_evidence",
              kind: "listed_salary",
              summary: "Ambiguous listing",
              currency: "USD",
              minimum: 170000,
              maximum: 190000,
              period: "year",
              offerStatus: null,
              jobId: "job_alias",
              applicationRecordId: null,
              source: "manual",
              recordedAt: later,
              createdAt: later,
              updatedAt: later,
            },
          },
        },
        now: latest,
      });
      expect(aliasResult.ok).toBe(false);
      if (!aliasResult.ok) {
        expect(aliasResult.failure.code).toBe("job_company_mismatch");
      }
    }
    expect(JSON.stringify(companies)).toBe(snapshot);
  });

  test("rejects domain-only, unknown-alias, and conflicting-domain authority without writing", () => {
    const cases = [
      {
        companies: [
          makeCompany({
            id: "owner",
            canonicalName: "Legacy Holdings",
            domains: [
              { domain: "acme.example", primary: true, verifiedAt: null },
            ],
            jobIds: ["job_1"],
          }),
        ],
        job: makeJob({
          id: "job_1",
          company: "Acme",
          employerDomain: "acme.example",
        }),
      },
      {
        companies: [
          makeCompany({
            id: "owner",
            canonicalName: "Legacy Holdings",
            aliases: [
              {
                alias: "Acme",
                normalized: "acme",
                confidence: 1,
                identityAuthority: "unknown",
              },
            ],
            jobIds: ["job_1"],
          }),
        ],
        job: makeJob({ id: "job_1", company: "Acme" }),
      },
      {
        companies: [
          makeCompany({
            id: "owner",
            canonicalName: "Acme",
            jobIds: ["job_1"],
          }),
          makeCompany({
            id: "domain_owner",
            canonicalName: "Other",
            domains: [
              { domain: "other.example", primary: true, verifiedAt: null },
            ],
          }),
        ],
        job: makeJob({
          id: "job_1",
          company: "Acme",
          employerDomain: "other.example",
        }),
      },
    ];

    for (const { companies, job } of cases) {
      const snapshot = JSON.stringify(companies);
      const owner = companies.find((company) => company.id === "owner")!;
      const result = applyCompanyIntelligenceMutation({
        companies,
        jobs: [job],
        input: {
          companyId: owner.id,
          expectedUpdatedAt: owner.updatedAt,
          mutation: {
            type: "upsert_salary_offer_evidence",
            evidence: {
              id: "unowned_evidence",
              kind: "listed_salary",
              summary: "Unowned listing",
              currency: "USD",
              minimum: 170000,
              maximum: 190000,
              period: "year",
              offerStatus: null,
              jobId: job.id,
              applicationRecordId: null,
              source: "manual",
              recordedAt: later,
              createdAt: later,
              updatedAt: later,
            },
          },
        },
        now: latest,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe("job_company_mismatch");
      expect(JSON.stringify(companies)).toBe(snapshot);
    }
  });

  test("rejects a stale compare-and-swap timestamp", () => {
    const result = applyCompanyIntelligenceMutation({
      companies: companiesWith(),
      input: {
        companyId: "c1",
        expectedUpdatedAt: "2026-08-01T00:00:00.000Z",
        mutation: { type: "remove_note", noteId: "note_1" },
      },
      now: latest,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("company_changed");
  });

  test("fails for an unknown company and never mutates inputs", () => {
    const companies = companiesWith();
    const snapshot = JSON.stringify(companies);
    const missing = applyCompanyIntelligenceMutation({
      companies,
      input: {
        companyId: "missing",
        expectedUpdatedAt: now,
        mutation: { type: "remove_note", noteId: "note_1" },
      },
      now,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.failure.code).toBe("company_not_found");
    expect(JSON.stringify(companies)).toBe(snapshot);
  });
});

describe("projectCompanyDuplicateJobs", () => {
  test("flags jobs sharing a strong identity alias as exact duplicates", () => {
    const company = makeCompany({
      id: "c1",
      jobIds: ["job_a", "job_b", "job_c"],
    });
    const groups = projectCompanyDuplicateJobs({
      company,
      jobs: [
        makeJob({
          id: "job_a",
          company: "Acme Inc",
          sourceJobId: "posting_1",
          canonicalUrl: "https://jobs.acme.com/posting_1",
        }),
        // Same source posting id but a different URL: still an exact duplicate.
        makeJob({
          id: "job_b",
          company: "Acme Inc",
          sourceJobId: "posting_1",
          canonicalUrl: "https://jobs.acme.com/repost/posting_1",
        }),
        makeJob({
          id: "job_c",
          company: "Acme Inc",
          sourceJobId: "posting_3",
          canonicalUrl: "https://jobs.acme.com/posting_3",
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: "exact",
      jobIds: ["job_a", "job_b"],
    });
  });

  test("flags same-title/company/location/posted-date postings as possible duplicates", () => {
    const company = makeCompany({
      id: "c1",
      jobIds: ["job_a", "job_b"],
    });
    const groups = projectCompanyDuplicateJobs({
      company,
      jobs: [
        makeJob({
          id: "job_a",
          company: "Acme Inc",
          sourceJobId: "posting_a",
          canonicalUrl: "https://jobs.acme.com/a",
          title: "Engineer",
          location: "Remote",
          postedAt: "2026-08-01T00:00:00.000Z",
        }),
        makeJob({
          id: "job_b",
          company: "Acme Inc",
          sourceJobId: "posting_b",
          canonicalUrl: "https://jobs.acme.com/b",
          title: "Engineer",
          location: "Remote",
          postedAt: "2026-08-01T00:00:00.000Z",
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe("possible");
  });

  test("leaves unrelated postings alone", () => {
    const company = makeCompany({
      id: "c1",
      jobIds: ["job_a", "job_b"],
    });
    const groups = projectCompanyDuplicateJobs({
      company,
      jobs: [
        makeJob({
          id: "job_a",
          company: "Acme Inc",
          sourceJobId: "posting_a",
          canonicalUrl: "https://jobs.acme.com/a",
          title: "Engineer",
          location: "Remote",
        }),
        makeJob({
          id: "job_b",
          company: "Acme Inc",
          sourceJobId: "posting_b",
          canonicalUrl: "https://jobs.acme.com/b",
          title: "Designer",
          location: "London",
        }),
      ],
    });

    expect(groups).toEqual([]);
  });

  test("returns no groups for a company with fewer than two jobs", () => {
    expect(
      projectCompanyDuplicateJobs({
        company: makeCompany({ id: "c1", jobIds: ["job_a"] }),
        jobs: [makeJob({ id: "job_a", company: "Acme Inc" })],
      }),
    ).toEqual([]);
  });
});
