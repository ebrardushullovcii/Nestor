import { stat } from "node:fs";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  DISCOVERY_READER_LOST_ERROR,
  JobPostingSchema,
  type JobDiscoveryTarget,
  type JobSearchPreferences,
  type JobSource,
} from "@nestor/contracts";

import {
  applyDiscoveryTitleTriage,
  buildDiscoveryStartingUrls,
  collectPublicProviderJobs,
  preparePublicProviderFeed,
  inferSourceIntelligenceFromTarget,
  resolveRouteKindForReuse,
} from "./workspace-source-intelligence";
import { setDiscoveryFeedExecutor } from "./discovery-feed-executor";
import {
  buildJobIdentityAliases,
  digestJobIdentityDescription,
} from "./job-identity";
import { createDiscoveryListingFingerprints } from "./workspace-discovery-ledger";
import {
  createSeed,
  createSourceInstructionArtifact,
} from "../workspace-service.test-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

function createGreenhouseTarget(): JobDiscoveryTarget {
  return {
    id: "greenhouse_remote",
    label: "Remote Greenhouse",
    startingUrl: "https://job-boards.greenhouse.io/remote",
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

function createLeverTarget(): JobDiscoveryTarget {
  return {
    id: "lever_aircall",
    label: "Aircall Lever",
    startingUrl: "https://jobs.lever.co/aircall",
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

function createEuropeanLeverTarget(): JobDiscoveryTarget {
  return {
    ...createLeverTarget(),
    id: "lever_olx_europe",
    label: "OLX Lever Europe",
    startingUrl: "https://jobs.eu.lever.co/olx",
  };
}

function createAshbyTarget(): JobDiscoveryTarget {
  return {
    ...createGreenhouseTarget(),
    id: "ashby_constructor",
    label: "Constructor Ashby",
    startingUrl: "https://jobs.ashbyhq.com/constructor/ashby_job_1",
  };
}

function createWorkdayTarget(): JobDiscoveryTarget {
  return {
    ...createGreenhouseTarget(),
    id: "workday_amat",
    label: "Applied Materials Workday",
    startingUrl:
      "https://amat.wd1.myworkdayjobs.com/en-US/External/job/SingaporeSGP/Software-Engineer_R2612079",
  };
}

function createUnknownCareersTarget(): JobDiscoveryTarget {
  return {
    id: "unknown_careers",
    label: "Unknown Careers",
    startingUrl: "https://example.com/careers",
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

function createSearchSurfaceTarget(): JobDiscoveryTarget {
  return {
    id: "linkedin_default",
    label: "LinkedIn Jobs",
    startingUrl: "https://www.linkedin.com/jobs/",
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

function createSearchPreferences(
  overrides: Partial<JobSearchPreferences> = {},
): JobSearchPreferences {
  return {
    targetRoles: [],
    jobFamilies: [],
    locations: [],
    excludedLocations: [],
    workModes: [],
    seniorityLevels: [],
    targetIndustries: [],
    targetCompanyStages: [],
    employmentTypes: [],
    minimumSalaryUsd: null,
    targetSalaryUsd: null,
    salaryCurrency: "USD",
    compensation: {
      minimum: null,
      maximum: null,
      interval: "year",
      currency: null,
      currencyStatus: "needs_clarification",
    },
    approvalMode: "draft_only",
    tailoringMode: "conservative",
    companyBlacklist: [],
    companyWhitelist: [],
    discovery: {
      targets: [],
      historyLimit: 5,
      collectOnlyHardCriteriaMatches: true,
    },
    ...overrides,
  };
}

test("keeps jobs outside soft preferences visible unless strict collection is enabled", () => {
  const seed = createSeed();
  const posting = createPosting({
    title: "Product Designer",
    location: "Toronto, Canada",
    workMode: ["onsite"],
  });
  const broadPreferences = createSearchPreferences({
    targetRoles: ["Senior Software Engineer"],
    locations: ["Berlin, Germany"],
    workModes: ["remote"],
    discovery: {
      targets: [],
      historyLimit: 5,
      collectOnlyHardCriteriaMatches: false,
    },
  });

  expect(
    applyDiscoveryTitleTriage({
      posting,
      profile: seed.profile,
      searchPreferences: broadPreferences,
    }),
  ).toEqual({ outcome: "pass", reason: null });
});

test("leaves sign-in walls and talent pools to the model rather than phrase lists", () => {
  const seed = createSeed();
  const searchPreferences = createSearchPreferences({
    targetRoles: ["Marketing Coordinator"],
    discovery: {
      targets: [],
      historyLimit: 5,
      collectOnlyHardCriteriaMatches: false,
    },
  });
  for (const posting of [
    createPosting({
      title: "Customer Service",
      description:
        "Sign in to continue. Welcome back. Email or phone. Password. New to LinkedIn? Join now.",
    }),
    createPosting({ title: "Keep me in mind!" }),
  ]) {
    // The model reading the page skips these, and fit judging marks any that
    // arrive as skip (ADR 0041).
    expect(
      applyDiscoveryTitleTriage({
        posting,
        profile: seed.profile,
        searchPreferences,
      }),
    ).toEqual({ outcome: "pass", reason: null });
  }
});

test("always skips an explicitly excluded location", () => {
  const seed = createSeed();
  const posting = createPosting({
    location: "Toronto, Canada",
  });
  const searchPreferences = createSearchPreferences({
    excludedLocations: ["Toronto, Canada"],
    discovery: {
      targets: [],
      historyLimit: 5,
      collectOnlyHardCriteriaMatches: false,
    },
  });

  expect(
    applyDiscoveryTitleTriage({
      posting,
      profile: seed.profile,
      searchPreferences,
    }),
  ).toEqual({
    outcome: "skip_location",
    reason: "Location is explicitly excluded.",
  });
});

function createPosting(
  overrides: Partial<ReturnType<typeof JobPostingSchema.parse>> = {},
) {
  return JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: "job_1",
    discoveryMethod: "browser_agent",
    collectionMethod: "fallback_search",
    canonicalUrl: "https://example.com/jobs/job_1",
    applicationUrl: null,
    title: "Software Engineer",
    company: "Example Co",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "unknown",
    easyApplyEligible: false,
    postedAt: null,
    postedAtText: null,
    discoveredAt: "2026-03-20T10:00:00.000Z",
    firstSeenAt: null,
    lastSeenAt: null,
    lastVerifiedActiveAt: null,
    salaryText: null,
    summary: "Build product features.",
    description: "Build product features with TypeScript and React.",
    keySkills: ["TypeScript", "React"],
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
    ...overrides,
  });
}

async function collectGreenhouseJobs(
  updatedAt: string | null,
  content = "<p>Teach software engineering.</p>",
) {
  const target = createGreenhouseTarget();
  const intelligence = inferSourceIntelligenceFromTarget({
    target,
    currentArtifact: null,
  });
  const source: JobSource = "target_site";

  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        jobs: [
          {
            id: 4622190,
            title: "SEI Instructor Lead",
            absolute_url:
              "https://job-boards.greenhouse.io/remote/jobs/4622190",
            location: { name: "New York, NY" },
            updated_at: updatedAt,
            content,
          },
        ],
      }),
  } as Response);

  return collectPublicProviderJobs({
    target,
    artifact: { intelligence },
    source,
  });
}

describe("collectPublicProviderJobs", () => {
  test("worker preparation carries exact raw-card aliases and fingerprints beside normalized facts", async () => {
    const target = createGreenhouseTarget();
    const intelligence = inferSourceIntelligenceFromTarget({
      target,
      currentArtifact: null,
    });
    const prepared = await preparePublicProviderFeed({
      target,
      intelligence,
      source: "target_site",
      prepareForDiscovery: true,
      payload: JSON.stringify({
        jobs: [
          {
            id: 17,
            title: "Software Engineer",
            absolute_url: "https://job-boards.greenhouse.io/remote/jobs/17",
            location: { name: "Remote, Remote" },
            content: `<p>${"Build reliable software with a distributed team. ".repeat(40)}</p>`,
          },
        ],
      }),
    });
    const raw = prepared.jobs[0]!;
    const hints = prepared.preparations[0]!;
    expect(hints.screening?.aliases.acrossSources).toEqual(
      buildJobIdentityAliases({ ...raw, matchAcrossSources: true }),
    );
    expect(hints.screening?.fingerprints).toEqual(
      createDiscoveryListingFingerprints(raw),
    );
    expect(hints.screening?.descriptionDigest).toBe(
      digestJobIdentityDescription(raw.description),
    );
    const normalized = { ...raw, ...hints.normalized };
    expect(hints.aliases.acrossSources).toEqual(
      buildJobIdentityAliases({ ...normalized, matchAcrossSources: true }),
    );
    expect(hints.descriptionDigest).toBe(
      digestJobIdentityDescription(normalized.description),
    );
  });
  test("reads a feed again on this thread when its reader is lost", async () => {
    const executor = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("Feed reader exited (1)."), {
          name: DISCOVERY_READER_LOST_ERROR,
        }),
      ),
    );
    setDiscoveryFeedExecutor(executor);
    try {
      const result = await collectGreenhouseJobs(null);
      expect(executor).toHaveBeenCalledOnce();
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(result.warning).toBeNull();
      expect(result.jobs.map((job) => job.sourceJobId)).toEqual(["4622190"]);
    } finally {
      setDiscoveryFeedExecutor(null);
    }
  });
  test("an unreadable feed from a live reader is not fetched again", async () => {
    setDiscoveryFeedExecutor(() =>
      Promise.reject(new Error("Unreadable feed")),
    );
    try {
      const result = await collectGreenhouseJobs(null);
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      expect(result.jobs).toEqual([]);
      expect(result.warning).not.toBeNull();
    } finally {
      setDiscoveryFeedExecutor(null);
    }
  });
  test("decodes escaped provider markup before summarizing the job", async () => {
    const result = await collectGreenhouseJobs(
      null,
      "&lt;div class=&quot;content-intro&quot;&gt;&lt;strong&gt;About the role:&lt;/strong&gt;&lt;/div&gt;" +
        "&lt;p&gt;Build React &amp;amp; TypeScript interfaces. Ship &#8220;accessible&#8221; UI.&lt;/p&gt;" +
        "&lt;script&gt;ignore this script&lt;/script&gt;",
    );
    expect(result.jobs[0]?.description).toBe(
      "About the role:\n\nBuild React & TypeScript interfaces. Ship “accessible” UI.",
    );
    expect(result.jobs[0]?.summary).toBe(
      "About the role: Build React & TypeScript interfaces. Ship “accessible” UI.",
    );
  });
  test("collects current Ashby board jobs through the reusable posting API", async () => {
    const target = createAshbyTarget();
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
              id: "ashby_job_1",
              title: "Software Engineer: Core",
              location: "Remote - EMEA",
              publishedAt: "2026-06-04T12:01:47.857+02:00",
              workplaceType: "Remote",
              employmentType: "FullTime",
              department: "Engineering",
              team: "Core",
              jobUrl: "https://jobs.ashbyhq.com/constructor/ashby_job_1",
              applyUrl:
                "https://jobs.ashbyhq.com/constructor/ashby_job_1/application",
              descriptionPlain: "Build high-availability backend systems.",
            },
          ],
        }),
    } as Response);

    const result = await collectPublicProviderJobs({
      target,
      artifact: { intelligence },
      source: "target_site",
    });

    expect(intelligence.provider).toMatchObject({
      key: "ashby",
      apiAvailability: "available",
      boardSlug: "constructor",
      publicApiUrlTemplate:
        "https://api.ashbyhq.com/posting-api/job-board/constructor",
    });
    expect(result.warning).toBeNull();
    expect(result.jobs[0]).toMatchObject({
      sourceJobId: "ashby_job_1",
      company: "Constructor",
      canonicalUrl: target.startingUrl,
      applicationUrl:
        "https://jobs.ashbyhq.com/constructor/ashby_job_1/application",
      providerKey: "ashby",
      workMode: ["remote"],
      employerDomain: null,
    });
  });

  test("collects an exact Workday job through its public candidate-experience endpoint", async () => {
    const target = createWorkdayTarget();
    const intelligence = inferSourceIntelligenceFromTarget({
      target,
      currentArtifact: null,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          jobPostingInfo: {
            jobReqId: "R2612079",
            title: "Software Engineer",
            location: "Singapore,SGP",
            externalUrl:
              "https://amat.wd1.myworkdayjobs.com/External/job/SingaporeSGP/Software-Engineer_R2612079",
            jobDescription: "<p>Build software for semiconductor systems.</p>",
            startDate: "2026-02-02",
            timeType: "Full time",
          },
        }),
    } as Response);

    const result = await collectPublicProviderJobs({
      target,
      artifact: { intelligence },
      source: "target_site",
    });

    expect(intelligence.provider).toMatchObject({
      key: "workday",
      apiAvailability: "available",
      boardSlug: "External",
      publicApiUrlTemplate:
        "https://amat.wd1.myworkdayjobs.com/wday/cxs/amat/External/job/SingaporeSGP/Software-Engineer_R2612079",
    });
    expect(result.warning).toBeNull();
    expect(result.jobs[0]).toMatchObject({
      sourceJobId: "R2612079",
      canonicalUrl: target.startingUrl,
      providerKey: "workday",
      description: "Build software for semiconductor systems.",
      employerDomain: null,
    });
  });

  test("prioritizes an exact provider job URL before applying collection caps", async () => {
    const target = {
      ...createGreenhouseTarget(),
      startingUrl:
        "https://job-boards.greenhouse.io/remote/jobs/target_job?gh_src=test",
    };
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
              id: "unrelated_job",
              title: "Unrelated role",
              absolute_url:
                "https://job-boards.greenhouse.io/remote/jobs/unrelated_job",
              location: { name: "Remote" },
              content: "<p>Unrelated role.</p>",
            },
            {
              id: "target_job",
              title: "Software Engineer",
              absolute_url:
                "https://job-boards.greenhouse.io/remote/jobs/target_job",
              location: { name: "Remote" },
              content: "<p>Build software.</p>",
            },
          ],
        }),
    } as Response);

    const result = await collectPublicProviderJobs({
      target,
      artifact: { intelligence },
      source: "target_site",
    });

    expect(result.jobs.map((job) => job.sourceJobId)).toEqual([
      "target_job",
      "unrelated_job",
    ]);
  });

  test("maps Greenhouse updated_at to providerUpdatedAt without claiming a posted date", async () => {
    const result = await collectGreenhouseJobs("2024-07-24T16:08:01-04:00");

    expect(result.warning).toBeNull();
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.postedAt).toBeNull();
    expect(result.jobs[0]?.providerUpdatedAt).toBe("2024-07-24T20:08:01.000Z");
  });

  test("keeps Greenhouse jobs when provider timestamps are invalid", async () => {
    const result = await collectGreenhouseJobs("not-a-date");

    expect(result.warning).toBeNull();
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.postedAt).toBeNull();
    expect(result.jobs[0]?.providerUpdatedAt).toBeNull();
  });

  test("keeps Lever posting dates on postedAt with providerUpdatedAt untouched", async () => {
    const target = createLeverTarget();
    const intelligence = inferSourceIntelligenceFromTarget({
      target,
      currentArtifact: null,
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            id: "lever_job_1",
            text: "Senior Engineer",
            createdAt: "2024-07-24T16:08:01-04:00",
            hostedUrl: "https://jobs.lever.co/aircall/lever_job_1",
            applyUrl: null,
            descriptionPlain: "Build platform features.",
            categories: {
              location: "Remote",
            },
          },
        ]),
    } as Response);

    const result = await collectPublicProviderJobs({
      target,
      artifact: { intelligence },
      source: "target_site",
    });

    expect(result.warning).toBeNull();
    expect(result.jobs[0]?.postedAt).toBe("2024-07-24T20:08:01.000Z");
    expect(result.jobs[0]?.providerUpdatedAt).toBeNull();
  });

  test("skips isolated malformed records while collecting the rest of the board", async () => {
    const target = createGreenhouseTarget();
    const intelligence = inferSourceIntelligenceFromTarget({
      target,
      currentArtifact: null,
    });
    const records: Array<Record<string, unknown> | string | null> = Array.from(
      { length: 49 },
      (_, index) => ({
        id: index + 1,
        title: `Software Engineer ${index + 1}`,
        absolute_url: `https://job-boards.greenhouse.io/remote/jobs/${index + 1}`,
        location: { name: "Remote" },
        content: "<p>Build software.</p>",
      }),
    );
    records.splice(7, 0, "malformed-provider-record");
    expect(records).toHaveLength(50);

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jobs: records }),
    } as Response);

    const result = await collectPublicProviderJobs({
      target,
      artifact: { intelligence },
      source: "target_site",
    });

    expect(result.jobs).toHaveLength(49);
    expect(result.jobs.find((job) => job.sourceJobId === "8")?.title).toBe(
      "Software Engineer 8",
    );
    expect(result.warning).toBe(
      "1 job in this board's list could not be read and was skipped.",
    );
  });

  test("fails collection when every record in the payload is malformed", async () => {
    const target = createGreenhouseTarget();
    const intelligence = inferSourceIntelligenceFromTarget({
      target,
      currentArtifact: null,
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ jobs: [null, 42, "malformed-provider-record"] }),
    } as Response);

    const result = await collectPublicProviderJobs({
      target,
      artifact: { intelligence },
      source: "target_site",
    });

    expect(result.jobs).toEqual([]);
    expect(result.warning).toBe("The job board's job list could not be read.");
  });

  test("normalizes stringified numeric provider timestamps", async () => {
    const target = createLeverTarget();
    const intelligence = inferSourceIntelligenceFromTarget({
      target,
      currentArtifact: null,
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            id: "lever_job_1",
            text: "Senior Engineer",
            createdAt: "1721851681000",
            hostedUrl: "https://jobs.lever.co/aircall/lever_job_1",
            applyUrl: null,
            descriptionPlain: "Build platform features.",
            additionalPlain: "Remote-friendly engineering culture.",
            workplaceType: "hybrid",
            lists: [
              {
                text: "What we're looking for",
                content:
                  "<p>Production experience with React and TypeScript.</p>",
              },
            ],
            categories: {
              location: "Madrid Office",
            },
          },
        ]),
    } as Response);

    const result = await collectPublicProviderJobs({
      target,
      artifact: { intelligence },
      source: "target_site",
    });

    expect(result.warning).toBeNull();
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.postedAt).toBe("2024-07-24T20:08:01.000Z");
    expect(result.jobs[0]?.description).toContain(
      "Production experience with React and TypeScript.",
    );
    expect(result.jobs[0]?.workMode).toContain("hybrid");
  });

  test.each([
    ["onsite", ["onsite"]],
    ["on-site", ["onsite"]],
    ["on site", ["onsite"]],
    ["hybrid / on-site", ["hybrid"]],
    ["remote or on-site", ["remote"]],
    ["not onsite", []],
    ["not on-site", []],
    ["not an on site role", []],
  ])(
    "preserves explicit provider work mode %s",
    async (workplaceType, expected) => {
      const target = createLeverTarget();
      const intelligence = inferSourceIntelligenceFromTarget({
        target,
        currentArtifact: null,
      });
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json([
          {
            id: "paris-onsite",
            text: "Frontend Engineer",
            hostedUrl: "https://jobs.lever.co/aircall/paris-onsite",
            categories: { location: "Paris, France" },
            workplaceType,
            descriptionPlain:
              "Build accessible React and TypeScript interfaces.",
          },
        ]),
      );
      const result = await collectPublicProviderJobs({
        target,
        artifact: { intelligence },
        source: "target_site",
      });
      const posting = result.jobs[0]!;
      expect(posting.workMode).toEqual(expected);
    },
  );

  test("uses the European Lever API for EU-hosted boards", () => {
    const intelligence = inferSourceIntelligenceFromTarget({
      target: createEuropeanLeverTarget(),
      currentArtifact: null,
    });
    const provider = intelligence.provider;

    expect(provider).not.toBeNull();
    if (!provider) {
      throw new Error("Expected EU Lever source intelligence.");
    }

    expect(provider.key).toBe("lever");
    expect(provider.publicApiUrlTemplate).toBe(
      "https://api.eu.lever.co/v0/postings/olx?mode=json",
    );
  });

  test("returns a clear timeout warning when the Greenhouse API hangs", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(
      new AbortController().signal,
    );
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("Timed out", "AbortError"),
    );

    const target = createGreenhouseTarget();
    const intelligence = inferSourceIntelligenceFromTarget({
      target,
      currentArtifact: null,
    });

    const result = await collectPublicProviderJobs({
      target,
      artifact: { intelligence },
      source: "target_site",
      retryDelaysMs: [0, 0, 0],
    });

    expect(result.jobs).toEqual([]);
    expect(result.warning).toBe(
      "The job board did not answer in time; it is tried again on the next search.",
    );
    // A timed-out feed is asked once more, not on every retry.
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  test("asks again through a dropped connection and keeps the feed", async () => {
    const target = createGreenhouseTarget();
    const intelligence = inferSourceIntelligenceFromTarget({
      target,
      currentArtifact: null,
    });
    const dropped = () =>
      Promise.reject(
        new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }),
      );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(dropped)
      .mockImplementationOnce(dropped)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jobs: [
              {
                id: 4401,
                title: "Platform Engineer",
                absolute_url: "https://boards.greenhouse.io/acme/jobs/4401",
                location: { name: "Remote" },
                content: "<p>Build the platform.</p>",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const result = await collectPublicProviderJobs({
      target,
      artifact: { intelligence },
      source: "target_site",
      retryDelaysMs: [0, 0, 0],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result.warning).toBeNull();
    expect(result.jobs.map((job) => job.sourceJobId)).toEqual(["4401"]);
  });

  test("names the network failure when the connection never comes back", async () => {
    const target = createGreenhouseTarget();
    const intelligence = inferSourceIntelligenceFromTarget({
      target,
      currentArtifact: null,
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.reject(
          new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }),
        ),
      );

    const result = await collectPublicProviderJobs({
      target,
      artifact: { intelligence },
      source: "target_site",
      retryDelaysMs: [0, 0],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result.jobs).toEqual([]);
    expect(result.warning).toBe(
      "The job board could not be reached; it is tried again on the next search.",
    );
  });

  test("does not ask a provider again after it answers with an error", async () => {
    const target = createGreenhouseTarget();
    const intelligence = inferSourceIntelligenceFromTarget({
      target,
      currentArtifact: null,
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("not found", { status: 404 }));

    const result = await collectPublicProviderJobs({
      target,
      artifact: { intelligence },
      source: "target_site",
      retryDelaysMs: [0, 0, 0],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.warning).toBe(
      "No job list was found at this board's address (HTTP 404). Check the address with Edit.",
    );
  });

  test("returns a clear timeout warning when the Lever API hangs", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("Timed out", "AbortError"),
    );

    const target = createLeverTarget();
    const intelligence = inferSourceIntelligenceFromTarget({
      target,
      currentArtifact: null,
    });

    const result = await collectPublicProviderJobs({
      target,
      artifact: { intelligence },
      source: "target_site",
      retryDelaysMs: [0],
    });

    expect(result.jobs).toEqual([]);
    expect(result.warning).toBe(
      "The job board did not answer in time; it is tried again on the next search.",
    );
  });

  test("ends a request that stays silent, after one more try", async () => {
    const target = createGreenhouseTarget();
    const intelligence = inferSourceIntelligenceFromTarget({
      target,
      currentArtifact: null,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );

    const result = await collectPublicProviderJobs({
      target,
      artifact: { intelligence },
      source: "target_site",
      retryDelaysMs: [0, 0],
      timeoutMs: 30,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.warning).toBe(
      "The job board did not answer in time; it is tried again on the next search.",
    );
  });

  test("does not time out a feed whose bytes arrived while the process was busy", async () => {
    const target = createGreenhouseTarget();
    const intelligence = inferSourceIntelligenceFromTarget({
      target,
      currentArtifact: null,
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((resolve, reject) => {
          const response = new Response(
            JSON.stringify({
              jobs: [
                {
                  id: 5501,
                  title: "Platform Engineer",
                  absolute_url: "https://boards.greenhouse.io/acme/jobs/5501",
                  location: { name: "Remote" },
                  content: "<p>Build the platform.</p>",
                },
              ],
            }),
            { status: 200 },
          );
          setImmediate(() => {
            // The answer arrives while other work holds the main process
            // past the limit; it waits behind that work with the next
            // network events (a file read started before the busy stretch
            // stands in for the socket, so a loaded machine cannot finish
            // it only after the timeout's own look).
            stat(".", () =>
              init?.signal?.aborted
                ? reject(new DOMException("Aborted", "AbortError"))
                : resolve(response),
            );
            const until = Date.now() + 80;
            while (Date.now() < until) {
              // busy
            }
          });
        }),
    );

    const result = await collectPublicProviderJobs({
      target,
      artifact: { intelligence },
      source: "target_site",
      retryDelaysMs: [],
      timeoutMs: 30,
    });

    expect(result.warning).toBeNull();
    expect(result.jobs.map((job) => job.sourceJobId)).toEqual(["5501"]);
  });

  test("normalizes Lever createdAt timestamps when present", async () => {
    const target = createLeverTarget();
    const intelligence = inferSourceIntelligenceFromTarget({
      target,
      currentArtifact: null,
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            id: "lever_job_1",
            text: "Senior Engineer",
            createdAt: "2024-07-24T16:08:01-04:00",
            hostedUrl: "https://jobs.lever.co/aircall/lever_job_1",
            applyUrl: null,
            descriptionPlain: "Build platform features.",
            categories: {
              location: "Remote",
            },
          },
        ]),
    } as Response);

    const result = await collectPublicProviderJobs({
      target,
      artifact: { intelligence },
      source: "target_site",
    });

    expect(result.warning).toBeNull();
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.postedAt).toBe("2024-07-24T20:08:01.000Z");
  });

  test("infers a route-backed no-artifact collection method from the target URL", () => {
    const intelligence = inferSourceIntelligenceFromTarget({
      target: createUnknownCareersTarget(),
      currentArtifact: null,
    });

    expect(intelligence.collection.preferredMethod).toBe("careers_page");
  });

  test("prefers learned discovery routes before the raw target starting URL", () => {
    const target = createUnknownCareersTarget();
    const artifact = createSourceInstructionArtifact({
      id: "instruction_unknown_careers_learned_routes",
      targetId: target.id,
      status: "draft",
      createdAt: "2026-03-20T10:04:00.000Z",
      updatedAt: "2026-03-20T10:05:00.000Z",
      acceptedAt: null,
      basedOnRunId: "debug_run_unknown_careers",
      basedOnAttemptIds: ["debug_attempt_unknown_careers"],
      notes:
        "Prefer learned jobs routes before the generic careers landing page.",
      navigationGuidance: [],
      searchGuidance: [],
      detailGuidance: [],
      applyGuidance: [],
      warnings: [],
      versionInfo: {
        promptProfileVersion: "v1",
        toolsetVersion: "v1",
        adapterVersion: "v1",
        appSchemaVersion: "v1",
      },
      verification: null,
      intelligence: {
        provider: null,
        collection: {
          preferredMethod: "listing_route",
          rankedMethods: ["listing_route", "careers_page", "fallback_search"],
          startingRoutes: [
            {
              url: target.startingUrl,
              label: "Starting URL",
              kind: "listing",
              confidence: 0.6,
            },
            {
              url: "https://example.com/jobs/recommended",
              label: "Learned jobs collection",
              kind: "collection",
              confidence: 0.88,
            },
          ],
          searchRouteTemplates: [
            {
              url: "https://example.com/jobs/search",
              label: "Learned search route",
              kind: "search",
              confidence: 0.95,
            },
          ],
          detailRoutePatterns: [],
          listingMarkers: [],
        },
        apply: {
          applyPath: "unknown",
          authMarkers: [],
          consentMarkers: [],
          questionSurfaceHints: [],
          resumeUploadHints: [],
        },
        reliability: {
          selectorFingerprints: [],
          stableControlNames: [],
          failureFingerprints: [],
          verifiedAt: null,
          freshnessNotes: [],
        },
        overrides: {
          forceMethod: null,
          deniedRoutePatterns: [],
          extraStartingRoutes: ["https://example.com/jobs/curated"],
        },
      },
    });

    expect(buildDiscoveryStartingUrls(target, artifact)).toEqual([
      "https://example.com/jobs/curated",
      "https://example.com/jobs/search",
      "https://example.com/jobs/recommended",
      "https://example.com/careers",
    ]);
  });

  test("filters broken and templated learned routes before reusing discovery starting urls", () => {
    const target = createUnknownCareersTarget();
    const artifact = createSourceInstructionArtifact({
      id: "instruction_unknown_careers_filtered_routes",
      targetId: target.id,
      status: "draft",
      createdAt: "2026-03-20T10:04:00.000Z",
      updatedAt: "2026-03-20T10:05:00.000Z",
      acceptedAt: null,
      basedOnRunId: "debug_run_unknown_careers_filtered_routes",
      basedOnAttemptIds: ["debug_attempt_unknown_careers_filtered_routes"],
      notes: "Broken and templated routes should not be reused.",
      navigationGuidance: [],
      searchGuidance: [],
      detailGuidance: [],
      applyGuidance: [],
      warnings: [],
      versionInfo: {
        promptProfileVersion: "v1",
        toolsetVersion: "v1",
        adapterVersion: "v1",
        appSchemaVersion: "v1",
      },
      verification: null,
      intelligence: {
        provider: null,
        collection: {
          preferredMethod: "listing_route",
          rankedMethods: ["listing_route", "careers_page", "fallback_search"],
          startingRoutes: [
            {
              url: target.startingUrl,
              label: "Starting URL",
              kind: "listing",
              confidence: 0.6,
            },
            {
              url: "https://example.com/jobs/search?currentJobId=123",
              label: "Search route with unstable query",
              kind: "search",
              confidence: 0.9,
            },
            {
              url: "https://example.com/{slug}",
              label: "Templated route",
              kind: "listing",
              confidence: 0.4,
            },
            {
              url: "https://example.com/404",
              label: "Broken route",
              kind: "listing",
              confidence: 0.2,
            },
            {
              url: "https://example.com/jobs/view/123",
              label: "Detail route",
              kind: "detail",
              confidence: 0.5,
            },
          ],
          searchRouteTemplates: [
            {
              url: "https://example.com/jobs/search?selectedJobId=456",
              label: "Search template with unstable query",
              kind: "search",
              confidence: 0.95,
            },
          ],
          detailRoutePatterns: [],
          listingMarkers: [],
        },
        apply: {
          applyPath: "unknown",
          authMarkers: [],
          consentMarkers: [],
          questionSurfaceHints: [],
          resumeUploadHints: [],
        },
        reliability: {
          selectorFingerprints: [],
          stableControlNames: [],
          failureFingerprints: [],
          verifiedAt: null,
          freshnessNotes: [],
        },
        overrides: {
          forceMethod: null,
          deniedRoutePatterns: [],
          extraStartingRoutes: [],
        },
      },
    });

    expect(buildDiscoveryStartingUrls(target, artifact)).toEqual([
      "https://example.com/jobs/search",
      "https://example.com/careers",
    ]);
  });

  test("starts from the learned routes; no search address is built from the person's goals (ADR 0041)", () => {
    const target = createSearchSurfaceTarget();
    const artifact = createSourceInstructionArtifact({
      id: "instruction_guided_query_first",
      targetId: target.id,
      status: "draft",
      createdAt: "2026-03-20T10:04:00.000Z",
      updatedAt: "2026-03-20T10:05:00.000Z",
      acceptedAt: null,
      basedOnRunId: "debug_run_guided_query_first",
      basedOnAttemptIds: ["debug_attempt_guided_query_first"],
      notes: "Prefer concrete query entry over generic collections.",
      navigationGuidance: [],
      searchGuidance: [
        "URL-based search works with parameters like ?keywords=frontend&location=kosovo.",
      ],
      detailGuidance: [],
      applyGuidance: [],
      warnings: [],
      versionInfo: {
        promptProfileVersion: "v1",
        toolsetVersion: "v1",
        adapterVersion: "v1",
        appSchemaVersion: "v1",
      },
      verification: null,
      intelligence: {
        provider: {
          key: "linkedin",
          label: "LinkedIn Jobs",
          confidence: 0.98,
          apiAvailability: "not_supported",
          publicApiUrlTemplate: null,
          boardToken: null,
          boardSlug: null,
          providerIdentifier: "linkedin_jobs",
        },
        collection: {
          preferredMethod: "listing_route",
          rankedMethods: ["listing_route", "careers_page", "fallback_search"],
          startingRoutes: [
            {
              url: "https://www.linkedin.com/jobs/collections/recommended/",
              label: "Recommended collection",
              kind: "collection",
              confidence: 0.92,
            },
            {
              url: "https://www.linkedin.com/jobs/search/",
              label: "Generic search route",
              kind: "search",
              confidence: 0.9,
            },
          ],
          searchRouteTemplates: [
            {
              url: "https://www.linkedin.com/jobs/search/",
              label: "Generic search template",
              kind: "search",
              confidence: 0.95,
            },
          ],
          detailRoutePatterns: [],
          listingMarkers: [],
        },
        apply: {
          applyPath: "unknown",
          authMarkers: [],
          consentMarkers: [],
          questionSurfaceHints: [],
          resumeUploadHints: [],
        },
        reliability: {
          selectorFingerprints: [],
          stableControlNames: [],
          failureFingerprints: [],
          verifiedAt: null,
          freshnessNotes: [],
        },
        overrides: {
          forceMethod: null,
          deniedRoutePatterns: [],
          extraStartingRoutes: [],
        },
      },
    });

    expect(buildDiscoveryStartingUrls(target, artifact)).toEqual([
      "https://www.linkedin.com/jobs/search/",
      "https://www.linkedin.com/jobs/collections/recommended/",
      "https://www.linkedin.com/jobs/",
    ]);
  });

  test("falls back to only the configured starting url when no learned source guidance exists", () => {
    const target = createSearchSurfaceTarget();

    expect(buildDiscoveryStartingUrls(target, null)).toEqual([
      "https://www.linkedin.com/jobs/",
    ]);
  });

  test("does not reuse search routes that the instruction guidance explicitly disproved", () => {
    const target = {
      id: "kosovajob",
      label: "KosovaJob",
      startingUrl: "https://kosovajob.com/",
      enabled: true,
      adapterKind: "auto",
      customInstructions: null,
      instructionStatus: "draft",
      validatedInstructionId: null,
      draftInstructionId: null,
      lastDebugRunId: null,
      lastVerifiedAt: null,
      staleReason: null,
    } satisfies JobDiscoveryTarget;
    const artifact = createSourceInstructionArtifact({
      id: "instruction_kosovajob_disproved_search_route",
      targetId: target.id,
      status: "draft",
      createdAt: "2026-04-23T03:00:00.000Z",
      updatedAt: "2026-04-23T03:01:00.000Z",
      acceptedAt: null,
      basedOnRunId: "debug_run_kosovajob_disproved_search_route",
      basedOnAttemptIds: ["debug_attempt_kosovajob_disproved_search_route"],
      notes: null,
      navigationGuidance: [],
      searchGuidance: [
        "Filter note: /search route returns 404 - not a working search endpoint",
      ],
      detailGuidance: [],
      applyGuidance: [],
      warnings: [],
      versionInfo: {
        promptProfileVersion: "v1",
        toolsetVersion: "v1",
        adapterVersion: "v1",
        appSchemaVersion: "v1",
      },
      verification: null,
      intelligence: {
        provider: null,
        collection: {
          preferredMethod: "listing_route",
          rankedMethods: ["listing_route", "careers_page", "fallback_search"],
          startingRoutes: [
            {
              url: target.startingUrl,
              label: "Starting URL",
              kind: "anchor",
              confidence: 0.6,
            },
            {
              url: "https://kosovajob.com/search",
              label: "Observed route",
              kind: "search",
              confidence: 0.84,
            },
            {
              url: "https://kosovajob.com/jobs",
              label: "Observed route",
              kind: "listing",
              confidence: 0.84,
            },
          ],
          searchRouteTemplates: [
            {
              url: "https://kosovajob.com/search",
              label: "Observed route",
              kind: "search",
              confidence: 0.84,
            },
          ],
          detailRoutePatterns: [],
          listingMarkers: [],
        },
        apply: {
          applyPath: "unknown",
          authMarkers: [],
          consentMarkers: [],
          questionSurfaceHints: [],
          resumeUploadHints: [],
        },
        reliability: {
          selectorFingerprints: [],
          stableControlNames: [],
          failureFingerprints: [],
          verifiedAt: null,
          freshnessNotes: [],
        },
        overrides: {
          forceMethod: null,
          deniedRoutePatterns: [],
          extraStartingRoutes: [],
        },
      },
    });

    expect(buildDiscoveryStartingUrls(target, artifact)).toEqual([
      "https://kosovajob.com/jobs",
      "https://kosovajob.com/",
    ]);
  });

  test("does not re-add the starting url when it is denied by learned guidance", () => {
    const target = createUnknownCareersTarget();
    const artifact = createSourceInstructionArtifact({
      id: "instruction_unknown_careers_denied_starting_url",
      targetId: target.id,
      status: "draft",
      createdAt: "2026-04-24T00:00:00.000Z",
      updatedAt: "2026-04-24T00:01:00.000Z",
      acceptedAt: null,
      basedOnRunId: "debug_run_unknown_careers_denied_starting_url",
      basedOnAttemptIds: ["debug_attempt_unknown_careers_denied_starting_url"],
      notes: null,
      navigationGuidance: [],
      searchGuidance: [
        "https://example.com/careers returns 404 and should not be reused.",
      ],
      detailGuidance: [],
      applyGuidance: [],
      warnings: [],
      versionInfo: {
        promptProfileVersion: "v1",
        toolsetVersion: "v1",
        adapterVersion: "v1",
        appSchemaVersion: "v1",
      },
      verification: null,
      intelligence: {
        provider: null,
        collection: {
          preferredMethod: "listing_route",
          rankedMethods: ["listing_route", "careers_page", "fallback_search"],
          startingRoutes: [],
          searchRouteTemplates: [
            {
              url: "https://example.com/jobs/search",
              label: "Search route",
              kind: "search",
              confidence: 0.9,
            },
          ],
          detailRoutePatterns: [],
          listingMarkers: [],
        },
        apply: {
          applyPath: "unknown",
          authMarkers: [],
          consentMarkers: [],
          questionSurfaceHints: [],
          resumeUploadHints: [],
        },
        reliability: {
          selectorFingerprints: [],
          stableControlNames: [],
          failureFingerprints: [],
          verifiedAt: null,
          freshnessNotes: [],
        },
        overrides: {
          forceMethod: null,
          deniedRoutePatterns: [],
          extraStartingRoutes: [],
        },
      },
    });

    expect(buildDiscoveryStartingUrls(target, artifact)).toEqual([
      "https://example.com/jobs/search",
    ]);
  });

  test("returns no discovery starting urls when every learned route and the target starting url are denied", () => {
    const target = createUnknownCareersTarget();
    const artifact = createSourceInstructionArtifact({
      id: "instruction_unknown_careers_all_routes_denied",
      targetId: target.id,
      status: "draft",
      createdAt: "2026-04-24T00:00:00.000Z",
      updatedAt: "2026-04-24T00:01:00.000Z",
      acceptedAt: null,
      basedOnRunId: "debug_run_unknown_careers_all_routes_denied",
      basedOnAttemptIds: ["debug_attempt_unknown_careers_all_routes_denied"],
      notes: null,
      navigationGuidance: [],
      searchGuidance: [
        "https://example.com/careers returns 404 and should not be reused.",
        "https://example.com/jobs/search returns 404 and should not be reused.",
      ],
      detailGuidance: [],
      applyGuidance: [],
      warnings: [],
      versionInfo: {
        promptProfileVersion: "v1",
        toolsetVersion: "v1",
        adapterVersion: "v1",
        appSchemaVersion: "v1",
      },
      verification: null,
      intelligence: {
        provider: null,
        collection: {
          preferredMethod: "listing_route",
          rankedMethods: ["listing_route", "careers_page", "fallback_search"],
          startingRoutes: [],
          searchRouteTemplates: [
            {
              url: "https://example.com/jobs/search",
              label: "Search route",
              kind: "search",
              confidence: 0.9,
            },
          ],
          detailRoutePatterns: [],
          listingMarkers: [],
        },
        apply: {
          applyPath: "unknown",
          authMarkers: [],
          consentMarkers: [],
          questionSurfaceHints: [],
          resumeUploadHints: [],
        },
        reliability: {
          selectorFingerprints: [],
          stableControlNames: [],
          failureFingerprints: [],
          verifiedAt: null,
          freshnessNotes: [],
        },
        overrides: {
          forceMethod: null,
          deniedRoutePatterns: [],
          extraStartingRoutes: [],
        },
      },
    });

    expect(buildDiscoveryStartingUrls(target, artifact)).toEqual([]);
  });

  test("keeps discovery starting-url building free of board-specific host gates and query policy", () => {
    const moduleSource = readFileSync(
      new URL("./workspace-source-intelligence.ts", import.meta.url),
      "utf8",
    );

    expect(moduleSource).not.toMatch(/geoId|f_WT/);
    expect(moduleSource).not.toMatch(/new URL\("\/jobs\/search/u);
  });

  test("does not classify kosovajob-style same-host slug detail routes as reusable listing routes", () => {
    expect(
      resolveRouteKindForReuse(
        "https://kosovajob.com/shopaz/category-manager-fashion-sports-outdoor-e-commerce",
      ),
    ).toBe("anchor");
  });
});

describe("Best matches only keeps what the model judged a fit (ADR 0041)", () => {
  const strict = () =>
    createSearchPreferences({
      targetRoles: ["Frontend Engineer"],
      locations: ["Berlin, Germany"],
      discovery: {
        targets: [],
        historyLimit: 5,
        collectOnlyHardCriteriaMatches: true,
      },
    });
  const verdict = (
    overrides: Partial<
      NonNullable<Parameters<typeof applyDiscoveryTitleTriage>[0]["judgment"]>
    >,
  ) => ({
    source: "batch" as const,
    judgedAt: "2026-10-02T10:00:00.000Z",
    contextFingerprint: null,
    postingFingerprint: null,
    score: 80,
    recommendation: "strong_fit" as const,
    role: "exact" as const,
    roleExplanation: null,
    preferences: "aligned" as const,
    preferencesExplanation: null,
    locationReach: "in_area" as const,
    reasons: [],
    gaps: [],
    listingClosed: false,
    listingClosedEvidence: null,
    ...overrides,
  });
  const triage = (
    judgment: ReturnType<typeof verdict> | null,
    searchPreferences = strict(),
  ) =>
    applyDiscoveryTitleTriage({
      posting: createPosting({ title: "Backend Engineer" }),
      profile: createSeed().profile,
      searchPreferences,
      judgment,
    });

  test("keeps a job the model has not judged rather than guessing", () => {
    expect(triage(null)).toEqual({ outcome: "pass", reason: null });
  });

  test("keeps a job the model judged a fit", () => {
    expect(triage(verdict({}))).toEqual({ outcome: "pass", reason: null });
  });

  test("drops a different role, saying why in the model's words", () => {
    expect(
      triage(
        verdict({
          role: "conflict",
          recommendation: "skip",
          gaps: ["Backend work, not the frontend role you want"],
        }),
      ),
    ).toEqual({
      outcome: "skip_title",
      reason: "Backend work, not the frontend role you want",
    });
  });

  test("drops a job outside the person's places", () => {
    expect(triage(verdict({ locationReach: "outside_area" })).outcome).toBe(
      "skip_location",
    );
  });

  test("drops a job that contradicts another saved goal", () => {
    expect(triage(verdict({ preferences: "conflict" })).outcome).toBe(
      "skip_work_mode",
    );
  });

  test("drops a job the model would skip", () => {
    expect(triage(verdict({ recommendation: "skip" })).outcome).toBe(
      "skip_title",
    );
  });

  test("keeps everything when Best matches only is off", () => {
    const broad = createSearchPreferences({
      targetRoles: ["Frontend Engineer"],
      discovery: {
        targets: [],
        historyLimit: 5,
        collectOnlyHardCriteriaMatches: false,
      },
    });
    expect(
      triage(verdict({ role: "conflict", recommendation: "skip" }), broad),
    ).toEqual({ outcome: "pass", reason: null });
  });
});
