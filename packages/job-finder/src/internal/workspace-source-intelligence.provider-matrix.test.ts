import { afterEach, describe, expect, test, vi } from "vitest";

import type { JobDiscoveryTarget, JobSource } from "@nestor/contracts";

import { runPublicProviderSourceCheck } from "./workspace-public-provider-source-check";
import { toProviderAwarePosting } from "./discovery-posting-normalization";
import { preparePublicProviderFeed } from "./workspace-source-intelligence";
import { createDiscoveryListingFingerprints } from "./workspace-discovery-ledger";
import {
  buildJobIdentityAliases,
  rememberPreparedListingContent,
  prepareListingContent,
} from "./job-identity";
import {
  collectPublicProviderJobs,
  inferSourceIntelligenceFromTarget,
} from "./workspace-source-intelligence";

const versionInfo = {
  promptProfileVersion: "provider-matrix-v1",
  toolsetVersion: "provider-matrix-v1",
  adapterVersion: "provider-matrix-v1",
  appSchemaVersion: "provider-matrix-v1",
};

function createTarget(
  id: string,
  label: string,
  startingUrl: string,
): JobDiscoveryTarget {
  return {
    id,
    label,
    startingUrl,
    enabled: true,
    adapterKind: "auto",
    customInstructions: null,
    instructionStatus: "missing",
    validatedInstructionId: null,
    draftInstructionId: null,
    lastDebugRunId: null,
    lastVerifiedAt: null,
    staleReason: null,
  };
}

const providerCases = [
  {
    name: "Greenhouse",
    providerKey: "greenhouse",
    target: createTarget(
      "greenhouse_acme",
      "Acme Greenhouse",
      "https://job-boards.greenhouse.io/acme",
    ),
    expectedApiUrl:
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true",
    payload: {
      jobs: [
        {
          id: 1001,
          title: "Frontend Engineer",
          absolute_url: "https://job-boards.greenhouse.io/acme/jobs/1001",
          location: { name: "Remote" },
          content: "<p>Build accessible web applications.</p>",
          updated_at: "2026-07-30T10:00:00.000Z",
        },
      ],
    },
  },
  {
    name: "Lever",
    providerKey: "lever",
    target: createTarget(
      "lever_acme",
      "Acme Lever",
      "https://jobs.lever.co/acme",
    ),
    expectedApiUrl: "https://api.lever.co/v0/postings/acme?mode=json",
    payload: [
      {
        id: "lever-1001",
        text: "Platform Engineer",
        hostedUrl: "https://jobs.lever.co/acme/lever-1001",
        applyUrl: "https://jobs.lever.co/acme/lever-1001/apply",
        descriptionPlain: "Build reliable platform services.",
        workplaceType: "remote",
        categories: { location: "Remote", department: "Engineering" },
        createdAt: 1_722_441_600_000,
      },
    ],
  },
  {
    name: "Ashby",
    providerKey: "ashby",
    target: createTarget(
      "ashby_acme",
      "Acme Ashby",
      "https://jobs.ashbyhq.com/acme",
    ),
    expectedApiUrl: "https://api.ashbyhq.com/posting-api/job-board/acme",
    payload: {
      jobs: [
        {
          id: "ashby-1001",
          title: "Backend Engineer",
          jobUrl: "https://jobs.ashbyhq.com/acme/ashby-1001",
          applyUrl: "https://jobs.ashbyhq.com/acme/ashby-1001/application",
          location: "Remote - Europe",
          descriptionPlain: "Build reliable backend systems.",
          workplaceType: "Remote",
          employmentType: "FullTime",
          publishedAt: "2026-07-30T10:00:00.000Z",
        },
      ],
    },
  },
  {
    name: "Workday",
    providerKey: "workday",
    target: createTarget(
      "workday_acme",
      "Acme Workday",
      "https://acme.wd5.myworkdayjobs.com/en-US/External/job/New-York-NY/Senior-Engineer_R1001",
    ),
    expectedApiUrl:
      "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/job/New-York-NY/Senior-Engineer_R1001",
    payload: {
      jobPostingInfo: {
        jobReqId: "R1001",
        title: "Senior Engineer",
        externalUrl:
          "https://acme.wd5.myworkdayjobs.com/External/job/New-York-NY/Senior-Engineer_R1001",
        applyUrl:
          "https://acme.wd5.myworkdayjobs.com/External/job/New-York-NY/Senior-Engineer_R1001/apply",
        location: "New York, NY",
        jobDescription: "<p>Build customer-facing software.</p>",
        startDate: "2026-07-30",
        timeType: "Full time",
      },
    },
  },
] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public provider ATS acceptance matrix", () => {
  test.each(providerCases)(
    "$name prepares exactly the same posting, fingerprints and identity evidence off main",
    async ({ target, payload }) => {
      const intelligence = inferSourceIntelligenceFromTarget({
        target,
        currentArtifact: null,
      });
      const base = {
        payload: JSON.stringify(payload),
        target,
        intelligence,
        source: "target_site" as const,
      };
      const raw = await preparePublicProviderFeed({
        ...base,
        prepareForDiscovery: false,
      });
      const prepared = await preparePublicProviderFeed({
        ...base,
        prepareForDiscovery: true,
      });
      expect(prepared.skippedMalformedCount).toBe(raw.skippedMalformedCount);
      const expected = raw.jobs.map((posting) =>
        toProviderAwarePosting({
          posting,
          target,
          intelligence,
          adapterKind: "target_site",
          collectionMethod: "api",
          discoveryMethod: "public_api",
        }),
      );
      expect(
        prepared.jobs.map((job) => ({ ...job, discoveredAt: "" })),
      ).toEqual(raw.jobs.map((job) => ({ ...job, discoveredAt: "" })));
      expect(
        prepared.preparations.map(({ normalized }, index) => ({
          ...prepared.jobs[index],
          ...normalized,
          discoveredAt: "",
        })),
      ).toEqual(expected.map((job) => ({ ...job, discoveredAt: "" })));
      prepared.preparations.forEach((evidence, index) => {
        const job = { ...prepared.jobs[index]!, ...evidence.normalized };
        expect(evidence.fingerprints).toEqual(
          createDiscoveryListingFingerprints(expected[index]!),
        );
        expect(evidence.aliases.local).toEqual(buildJobIdentityAliases(job));
        expect(evidence.aliases.acrossSources).toEqual(
          buildJobIdentityAliases({ ...job, matchAcrossSources: true }),
        );
        expect(evidence.content).toEqual(
          prepareListingContent(job.description),
        );
        const aliases = buildJobIdentityAliases(job);
        rememberPreparedListingContent(job.description, evidence.content);
        expect(buildJobIdentityAliases(job)).toEqual(aliases);
      });
    },
  );
  test.each(providerCases.slice(0, 3))(
    "$name uses the employer board identity for hostname and URL source labels",
    async ({ target: originalTarget, payload }) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(payload),
      } as Response);
      const url = new URL(originalTarget.startingUrl);
      for (const label of [
        url.hostname,
        originalTarget.startingUrl,
        `${url.host}${url.pathname}`,
      ]) {
        const target = { ...originalTarget, label };
        const intelligence = inferSourceIntelligenceFromTarget({
          target,
          currentArtifact: null,
        });
        const result = await collectPublicProviderJobs({
          target,
          artifact: { intelligence },
          source: "target_site",
        });
        expect(result.warning).toBeNull();
        expect(result.jobs).toHaveLength(1);
        expect(result.jobs[0]?.company).toBe("Acme");
      }

      const target = {
        ...originalTarget,
        label: "Moss Lantern Systems Careers",
      };
      const intelligence = inferSourceIntelligenceFromTarget({
        target,
        currentArtifact: null,
      });
      const result = await collectPublicProviderJobs({
        target,
        artifact: { intelligence },
        source: "target_site",
      });
      expect(result.jobs[0]?.company).toBe("Moss Lantern Systems");
    },
  );

  test("keeps employers separate when two Ashby boards have the same hostname label", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const board = new URL(url).pathname.split("/").at(-1);
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            jobs: [
              {
                id: `${board}-engineer`,
                title: "Software Engineer",
                jobUrl: `https://jobs.ashbyhq.com/${board}/engineer`,
                location: "Remote - Europe",
                descriptionPlain: "Build reliable software.",
              },
            ],
          }),
      } as Response);
    });
    const companies = [];
    for (const board of ["linear", "supabase"]) {
      const target = createTarget(
        board,
        "jobs.ashbyhq.com",
        `https://jobs.ashbyhq.com/${board}`,
      );
      const intelligence = inferSourceIntelligenceFromTarget({
        target,
        currentArtifact: null,
      });
      const result = await collectPublicProviderJobs({
        target,
        artifact: { intelligence },
        source: "target_site",
      });
      expect(result.jobs[0]?.canonicalUrl).toBe(
        `https://jobs.ashbyhq.com/${board}/engineer`,
      );
      companies.push(result.jobs[0]?.company);
    }
    expect(companies).toEqual(["Linear", "Supabase"]);
  });

  test.each(providerCases)(
    "$name uses the bounded public-provider path and produces reusable no-submit proof",
    async ({ providerKey, target, expectedApiUrl, payload }) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(payload),
      } as Response);
      const startedAt = performance.now();

      const result = await runPublicProviderSourceCheck({
        target,
        source: "target_site" satisfies JobSource,
        runId: `provider_matrix_${providerKey}`,
        versionInfo,
      });
      const elapsedMs = performance.now() - startedAt;

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(expectedApiUrl);
      expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(elapsedMs).toBeLessThan(2_000);
      expect(result).not.toBeNull();
      expect(result?.jobCount).toBe(1);
      expect(result?.artifact).toMatchObject({
        status: "validated",
        intelligence: {
          provider: { key: providerKey, apiAvailability: "available" },
          collection: { preferredMethod: "api" },
        },
        verification: { outcome: "passed" },
      });
      expect(result?.attempt).toMatchObject({
        phase: "replay_verification",
        outcome: "succeeded",
        strategyLabel: "Public provider API verification",
      });
      expect(result?.artifact.applyGuidance.join(" ")).toMatch(
        /stop before any final submission/i,
      );
      expect(result?.evidenceRefs).toHaveLength(2);
    },
  );

  test.each([
    "https://jobs.ashby-example.com/acme",
    "https://careers.notworkday.example/External/job/Engineer_R1001",
    "https://jobs.icims-example.com/jobs",
  ])("does not classify provider look-alike hostname %s", (startingUrl) => {
    const intelligence = inferSourceIntelligenceFromTarget({
      target: createTarget("lookalike", "Look-alike careers", startingUrl),
      currentArtifact: null,
    });

    expect(intelligence.provider).toBeNull();
    expect(intelligence.collection.preferredMethod).not.toBe("api");
  });

  test("normalizes already encoded Workday path segments without double encoding", async () => {
    const target = createTarget(
      "workday_encoded",
      "Acme Workday",
      "https://acme.wd5.myworkdayjobs.com/en-US/External/job/San%20Jose-CA/Engineer_R1002",
    );
    const intelligence = inferSourceIntelligenceFromTarget({
      target,
      currentArtifact: null,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          jobPostingInfo: {
            jobReqId: "R1002",
            title: "Engineer",
            externalUrl:
              "https://acme.wd5.myworkdayjobs.com/External/job/San%20Jose-CA/Engineer_R1002",
            location: "San Jose, CA",
            jobDescription: "Build software.",
          },
        }),
    } as Response);

    const result = await collectPublicProviderJobs({
      target,
      artifact: { intelligence },
      source: "target_site",
    });

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/job/San%20Jose-CA/Engineer_R1002",
    );
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(result.warning).toBeNull();
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.canonicalUrl).toBe(target.startingUrl);
  });

  test("uses the provider board identity when the saved source label is generic", async () => {
    const target = createTarget(
      "default_target",
      "Primary target",
      "https://job-boards.greenhouse.io/livefront/jobs/4215612009",
    );
    const intelligence = inferSourceIntelligenceFromTarget({
      target,
      currentArtifact: null,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          jobs: [
            {
              id: 4215612009,
              title: "Product Designer",
              absolute_url: target.startingUrl,
              location: { name: "Remote" },
              content: "<p>Design digital products.</p>",
            },
          ],
        }),
    } as Response);

    const result = await collectPublicProviderJobs({
      target,
      artifact: { intelligence },
      source: "target_site",
    });

    expect(result.jobs[0]?.company).toBe("Livefront");
  });
});
