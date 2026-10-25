import { constants as bufferConstants } from "node:buffer";
import { describe, expect, test, vi } from "vitest";
import {
  ApplicationRecordSchema,
  CompanyEntitySchema,
  SavedJobSchema,
  type CompanyEntity,
} from "@nestor/contracts";
import {
  createCompanyScaleFixture,
  companyScaleNow,
} from "./company-intelligence.scale-test-support";
import {
  projectCompanyApplicationHistory,
  projectCompanyDuplicateJobs,
  projectCompanyOpenings,
  reconcileCompanies,
} from "./company-intelligence-operations";

const createCompanyId = ({ normalizedName }: { normalizedName: string }) =>
  `company_${normalizedName.replaceAll(" ", "_")}`;
const company = (
  id: string,
  canonicalName: string,
  overrides: Partial<CompanyEntity> = {},
) =>
  CompanyEntitySchema.parse({
    id,
    canonicalName,
    createdAt: companyScaleNow,
    updatedAt: companyScaleNow,
    ...overrides,
  });

describe("company reconciliation evidence at scale", () => {
  test.each([
    { jobCount: 3_000, companyCount: 3_000, sharedListingHosts: false },
    { jobCount: 3_000, companyCount: 3_000, sharedListingHosts: true },
    { jobCount: 10_000, companyCount: 1_000, sharedListingHosts: true },
    { jobCount: 10_000, companyCount: 10_000, sharedListingHosts: true },
  ])(
    "cold/warm: $jobCount jobs, $companyCount employers, shared hosts $sharedListingHosts",
    (input) => {
      const fixture = createCompanyScaleFixture(input);
      const jobParse = vi.spyOn(SavedJobSchema, "safeParse");
      const recordParse = vi.spyOn(ApplicationRecordSchema, "safeParse");
      const companyParse = vi.spyOn(CompanyEntitySchema, "parse");
      try {
        const started = performance.now();
        const cold = reconcileCompanies({
          ...fixture,
          companies: [],
          now: companyScaleNow,
          createCompanyId,
        });
        const coldMs = performance.now() - started;
        expect(cold.ok).toBe(true);
        if (!cold.ok) throw new Error(cold.failure.message);
        expect(cold.companies).toHaveLength(input.companyCount);
        expect(cold.summary.createdMergeCandidates).toEqual([]);
        expect(companyParse).toHaveBeenCalledTimes(input.companyCount);
        // Frozen jobs are repository display rows, validated when read.
        expect(jobParse).not.toHaveBeenCalled();
        expect(recordParse).toHaveBeenCalledTimes(
          fixture.applicationRecords.length,
        );
        const owners = new Map(
          cold.companies.flatMap((entry) =>
            entry.jobIds.map((id) => [id, entry.canonicalName] as const),
          ),
        );
        expect(owners.size).toBe(input.jobCount);
        for (const job of fixture.jobs)
          expect(owners.get(job.id)).toBe(job.company);
        expect(
          cold.companies.reduce(
            (count, entry) => count + entry.applicationRecordIds.length,
            0,
          ),
        ).toBe(fixture.applicationRecords.length);
        expect(
          fixture.jobs.every(
            (job) =>
              job.provenance.length === 4 && job.description.length > 20_000,
          ),
        ).toBe(true);
        const serialized = JSON.stringify(cold.companies);
        expect(serialized.length).toBeLessThan(
          input.companyCount * 1_600 + input.jobCount * 100,
        );
        jobParse.mockClear();
        recordParse.mockClear();
        companyParse.mockClear();
        const warmStarted = performance.now();
        const warm = reconcileCompanies({
          ...fixture,
          companies: cold.companies,
          now: companyScaleNow,
          createCompanyId,
        });
        const warmMs = performance.now() - warmStarted;
        expect(warm.ok).toBe(true);
        if (!warm.ok) throw new Error(warm.failure.message);
        expect(warm.companies).toEqual(cold.companies);
        expect(warm.summary.createdMergeCandidates).toEqual([]);
        expect(warm.summary.createdCompanyIds).toEqual([]);
        expect(jobParse).not.toHaveBeenCalled();
        expect(recordParse).not.toHaveBeenCalled();
        expect(companyParse).not.toHaveBeenCalled();
        expect(coldMs).toBeLessThan(6_000);
        expect(warmMs).toBeLessThan(6_000);
        console.info(
          "company-scale",
          JSON.stringify({
            ...input,
            coldMs: Math.round(coldMs),
            warmMs: Math.round(warmMs),
            serializedBytes: Buffer.byteLength(serialized),
            candidates: 0,
          }),
        );
      } finally {
        jobParse.mockRestore();
        recordParse.mockRestore();
        companyParse.mockRestore();
      }
    },
    20_000,
  );

  test("old synthetic-name pair output exceeds V8's string limit at 3000 employers", () => {
    let minimumLength = Infinity;
    let count = 0;
    for (let first = 0; first < 100; first += 1)
      for (let second = first + 1; second < 100; second += 1) {
        // Original rule: two shared tokens / four union tokens = 0.5.
        const a = `Synthetic company ${first}`.toLowerCase().split(" ");
        const b = `Synthetic company ${second}`.toLowerCase().split(" ");
        const shared = b.filter((token) => a.includes(token)).length;
        if (shared / (a.length + b.length - shared) < 0.5) continue;
        count += 1;
        minimumLength = Math.min(
          minimumLength,
          JSON.stringify({
            candidateCompanyId: `company_${"0".repeat(36)}`,
            reason: `Similar company name "Synthetic company ${first}" vs "Synthetic company ${second}".`,
            decision: "pending",
            decidedAt: null,
            requiresUserDecision: true,
          }).length + 1,
        );
      }
    expect(count).toBe((100 * 99) / 2);
    expect(minimumLength * ((3_000 * 2_999) / 2)).toBeGreaterThan(
      bufferConstants.MAX_STRING_LENGTH,
    );
  });

  test.each([
    "canonical",
    "application",
    "starting",
    "sighting_listing",
    "page_apply",
  ] as const)(
    "shared host inferred from %s URLs does not request a merge",
    (location) => {
      const fixture = createCompanyScaleFixture({ jobCount: 2, freeze: false });
      const jobs = fixture.jobs.map((job, index) =>
        SavedJobSchema.parse({
          ...job,
          company: index === 0 ? "Northwind" : "Cedarworks",
          employerDomain: "shared.example",
          canonicalUrl:
            location === "canonical"
              ? `https://shared.example/job/${index}`
              : job.canonicalUrl,
          applicationUrl:
            location === "application"
              ? `https://shared.example/apply/${index}`
              : job.applicationUrl,
          provenance: [
            {
              ...job.provenance[0]!,
              startingUrl:
                location === "starting"
                  ? "https://shared.example/jobs"
                  : "https://source.example/jobs",
              listingUrl:
                location === "sighting_listing"
                  ? `https://shared.example/job/${index}`
                  : job.canonicalUrl,
              pageApplyUrl:
                location === "page_apply"
                  ? `https://shared.example/apply/${index}`
                  : job.applicationUrl,
            },
          ],
        }),
      );
      const result = reconcileCompanies({
        jobs,
        applicationRecords: [],
        companies: [],
        now: companyScaleNow,
        createCompanyId,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.companies).toHaveLength(2);
      expect(result.summary.createdMergeCandidates).toEqual([]);
      expect(
        result.companies.every(
          (entry) => entry.domains[0]?.domain === "shared.example",
        ),
      ).toBe(true);
    },
  );

  test.each([
    ["Atlas Services Ltd", "Beacon Services Ltd", 0],
    ["Signal Systems 1", "Signal Systems 2", 0],
    ["Acme Inc", "Acme Corp", 1],
  ] as const)(
    "informative tokens distinguish %s and %s",
    (first, second, expected) => {
      const result = reconcileCompanies({
        companies: [company("c1", first), company("c2", second)],
        jobs: [],
        applicationRecords: [],
        now: companyScaleNow,
        createCompanyId,
      });
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.summary.createdMergeCandidates).toHaveLength(expected);
    },
  );

  test("keeps meaningful names on a shared host and employer domains from independent sources", () => {
    const fixture = createCompanyScaleFixture({ jobCount: 2, freeze: false });
    for (const shared of [true, false]) {
      const jobs = fixture.jobs.map((job, index) =>
        SavedJobSchema.parse({
          ...job,
          company: index === 0 ? "Acme Inc" : "Acme Corp",
          employerDomain: shared ? "listing.example" : "acme.example",
        }),
      );
      const result = reconcileCompanies({
        companies: [],
        jobs,
        applicationRecords: [],
        now: companyScaleNow,
        createCompanyId,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.summary.createdMergeCandidates).toHaveLength(1);
      expect(result.summary.createdMergeCandidates[0]?.reason).toContain(
        shared ? "Similar company name" : "share the employer domain",
      );
      expect(result.companies.flatMap((entry) => entry.jobIds)).toHaveLength(2);
    }
  });

  test("cleans unsupported pending suggestions while keeping decisions and durable data", () => {
    const decisions = ["pending", "rejected", "approved_merge"] as const;
    const companies = [
      company("c0", "Synthetic company 0", {
        aliases: [
          {
            alias: "Approved alternate",
            normalized: "approved alternate",
            confidence: 1,
            identityAuthority: "user_approved_merge",
          },
        ],
        jobIds: ["historical_job"],
        applicationRecordIds: ["historical_application"],
        mergeReviewCandidates: decisions.map((decision, index) => ({
          candidateCompanyId: `c${index + 1}`,
          reason: `Similar company name "Synthetic company 0" vs "Synthetic company ${index + 1}".`,
          decision,
          decidedAt: decision === "pending" ? null : companyScaleNow,
          requiresUserDecision: true,
        })),
      }),
      ...decisions.map((_, index) =>
        company(`c${index + 1}`, `Synthetic company ${index + 1}`),
      ),
    ];
    const before = JSON.stringify(companies);
    const result = reconcileCompanies({
      companies,
      jobs: [],
      applicationRecords: [],
      now: companyScaleNow,
      createCompanyId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.companies[0]?.mergeReviewCandidates.map((entry) => entry.decision),
    ).toEqual(["rejected", "approved_merge"]);
    expect(result.companies[0]?.aliases).toEqual(companies[0]?.aliases);
    expect(result.companies[0]?.jobIds).toEqual(["historical_job"]);
    expect(result.companies[0]?.applicationRecordIds).toEqual([
      "historical_application",
    ]);
    expect(JSON.stringify(companies)).toBe(before);
  });

  test("keeps conflicts added during attachment to an existing company", () => {
    const fixture = createCompanyScaleFixture({
      jobCount: 1,
      sharedListingHosts: false,
    });
    const result = reconcileCompanies({
      companies: [
        company("c1", "Acme"),
        company("c2", "Northwind", {
          domains: [
            { domain: "employer.example", primary: true, verifiedAt: null },
          ],
        }),
        company("c3", "Cedarworks", {
          domains: [
            { domain: "employer.example", primary: true, verifiedAt: null },
          ],
        }),
      ],
      jobs: [
        SavedJobSchema.parse({
          ...fixture.jobs[0]!,
          company: "Acme",
          employerDomain: "employer.example",
        }),
      ],
      applicationRecords: [],
      now: companyScaleNow,
      createCompanyId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.companies[0]?.mergeReviewCandidates.map(
        (entry) => entry.candidateCompanyId,
      ),
    ).toEqual(["c2", "c3"]);
    expect(result.companies[0]?.jobIds).toEqual([fixture.jobs[0]!.id]);
  });

  test("a shared source host does not displace an existing exact name owner", () => {
    const fixture = createCompanyScaleFixture({ jobCount: 2, freeze: false });
    const jobs = fixture.jobs.map((job, index) =>
      SavedJobSchema.parse({
        ...job,
        company: index === 0 ? "Northwind" : "Cedarworks",
        employerDomain: "listing.example",
      }),
    );
    const result = reconcileCompanies({
      companies: [
        company("northwind", "Northwind", {
          domains: [
            { domain: "listing.example", primary: true, verifiedAt: null },
          ],
        }),
        company("cedarworks", "Cedarworks", { jobIds: [jobs[1]!.id] }),
      ],
      jobs,
      applicationRecords: [],
      now: companyScaleNow,
      createCompanyId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.companies[1]?.jobIds).toEqual([jobs[1]!.id]);
    expect(result.summary.ambiguousEvidenceCount).toBe(0);
    expect(result.summary.createdMergeCandidates).toEqual([]);
  });

  test("shared listing subdomains also disqualify their supplied parent domain", () => {
    const fixture = createCompanyScaleFixture({ jobCount: 2, freeze: false });
    const jobs = fixture.jobs.map((job, index) =>
      SavedJobSchema.parse({
        ...job,
        company: index === 0 ? "Northwind" : "Cedarworks",
        employerDomain: index === 0 ? "shared.example" : null,
        canonicalUrl: `https://employer${index}.shared.example/job/${index}`,
        applicationUrl: null,
        provenance: [],
      }),
    );
    const result = reconcileCompanies({
      companies: [
        company("northwind", "Northwind", {
          domains: [
            { domain: "shared.example", primary: true, verifiedAt: null },
          ],
        }),
        company("cedarworks", "Cedarworks", {
          domains: [
            { domain: "shared.example", primary: true, verifiedAt: null },
          ],
        }),
      ],
      jobs,
      applicationRecords: [],
      now: companyScaleNow,
      createCompanyId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.createdMergeCandidates).toEqual([]);
    expect(result.companies.map((entry) => entry.jobIds)).toEqual([
      [jobs[0]!.id],
      [jobs[1]!.id],
    ]);
  });

  test("company projections parse linked rows only and leave unrelated listings alone", () => {
    const fixture = createCompanyScaleFixture({
      jobCount: 3_000,
      companyCount: 300,
    });
    const selected = company("selected", fixture.jobs[0]!.company, {
      jobIds: fixture.jobs
        .filter((job) => job.company === fixture.jobs[0]!.company)
        .map((job) => job.id),
      applicationRecordIds: fixture.applicationRecords
        .filter((record) => record.company === fixture.jobs[0]!.company)
        .map((record) => record.id),
    });
    const guarded = fixture.jobs.map((job) =>
      selected.jobIds.includes(job.id)
        ? job
        : {
            ...job,
            get description(): string {
              throw new Error("Unlinked listing was parsed");
            },
          },
    );
    const openings = projectCompanyOpenings({
      company: selected,
      jobs: guarded,
    });
    expect(openings.totalCount).toBe(10);
    expect(
      projectCompanyDuplicateJobs({ company: selected, jobs: guarded }),
    ).toEqual([]);
    expect(
      projectCompanyApplicationHistory({
        company: selected,
        applicationRecords: fixture.applicationRecords,
      }).totalCount,
    ).toBe(10);
    expect(openings.previousCount + openings.currentCount).toBe(10);
    const first = [...openings.current, ...openings.previous][0]!;
    expect(first).not.toBe(fixture.jobs.find((job) => job.id === first.id));
  });

  test("duplicate lookup stays bounded for 10000 unrelated openings at one employer", () => {
    const timeLookup = (jobCount: number) => {
      const fixture = createCompanyScaleFixture({ jobCount, companyCount: 1 });
      const selected = company("selected", fixture.jobs[0]!.company, {
        jobIds: fixture.jobs.map((job) => job.id),
      });
      const started = performance.now();
      expect(
        projectCompanyDuplicateJobs({ company: selected, jobs: fixture.jobs }),
      ).toEqual([]);
      return performance.now() - started;
    };
    // Ten times the openings may cost about ten times as long; comparing
    // pairs would cost a hundred. A ratio holds on a busy machine where a
    // fixed budget in milliseconds did not.
    const small = timeLookup(1_000);
    const large = timeLookup(10_000);
    expect(large).toBeLessThan(Math.max(small, 50) * 30);
  }, 60_000);

  test("immutable evidence caching does not hide changes to mutable nested inputs", () => {
    const fixture = createCompanyScaleFixture({ jobCount: 1, freeze: false });
    const job = Object.freeze(fixture.jobs[0]!);
    const input = {
      companies: [],
      jobs: [job],
      applicationRecords: [],
      now: companyScaleNow,
      createCompanyId,
    };
    expect(reconcileCompanies(input).ok).toBe(true);
    // Ownership does not validate unused listing fields on our typed rows.
    job.keySkills.push(42 as unknown as string);
    job.provenance[0]!.listingUrl =
      "https://changed-employer.example.test/role";
    const next = reconcileCompanies(input);
    expect(next.ok).toBe(true);
    // A new row is a carrier-free control; mutable sighting links must not
    // be hidden by the evidence memo on the shallow-frozen original.
    expect(next).toEqual(reconcileCompanies({ ...input, jobs: [{ ...job }] }));
  });
});
