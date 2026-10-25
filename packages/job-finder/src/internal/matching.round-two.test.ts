import { describe, expect, test, vi } from "vitest";
import type { JobRequirementAssessment } from "@nestor/contracts";
import {
  createSeed,
  createAiClient,
  createWorkspaceServiceHarness,
} from "../workspace-service.test-support";
import {
  createMatchAssessmentAsync,
  mergeDiscoveredJob,
  mergeDiscoveredPostings,
  applySightingRoute,
} from "./matching";

const requirement = (
  label: string,
  status: JobRequirementAssessment["status"],
  category: JobRequirementAssessment["category"] = "skill",
): JobRequirementAssessment => ({
  id: label,
  label,
  status,
  category,
  importance: "required",
  jobEvidence: label,
  resumeEvidence:
    status === "supported"
      ? [
          {
            sourceKind: "profile",
            sourceId: null,
            label: "Saved profile",
            detail: label,
          },
        ]
      : [],
  explanation: `${label}: ${status}`,
});

describe("Round two fit findings", () => {
  test("the full assessment's verdict stands, with the requirements it found", async () => {
    const seed = createSeed();
    const requirements = [
      requirement("Very good German", "conflict"),
      requirement("Eight months of enrollment", "conflict", "experience"),
      requirement("Power BI", "missing"),
      requirement("Design education", "supported", "experience"),
    ];
    const client = {
      ...createAiClient(),
      assessJobFit: () =>
        Promise.resolve({
          score: 34,
          reasons: ["Remote"],
          gaps: ["Very good German is required"],
          requirements,
          recommendation: "skip" as const,
          role: "exact" as const,
          roleExplanation: "This is the analyst work you are looking for.",
        }),
    };
    const assessed = await createMatchAssessmentAsync(
      client,
      seed.profile,
      seed.searchPreferences,
      seed.savedJobs[0]!,
    );
    expect(assessed.score).toBe(34);
    expect(assessed.recommendation).toBe("skip");
    expect(assessed.recommendationRationale).toBe(
      "Very good German is required",
    );
    expect(assessed.gaps).toEqual(["Very good German is required"]);
    expect(assessed.dimensions.roleSuitability.state).toBe("exact");
    expect(assessed.requirements).toEqual(expect.arrayContaining(requirements));
    expect(assessed.requirementsSource).toBe("model");
    expect(assessed.judgment?.source).toBe("full");
    expect(assessed.dimensions.evidenceConfidence.conflictCount).toBe(2);
  });

  test("no rule recomputes the model's score", async () => {
    const seed = createSeed();
    const client = {
      ...createAiClient(),
      assessJobFit: () =>
        Promise.resolve({
          score: 88,
          reasons: ["Close match"],
          gaps: [],
          requirements: [requirement("Experience", "supported")],
        }),
    };
    const assessed = await createMatchAssessmentAsync(
      client,
      seed.profile,
      { ...seed.searchPreferences, targetRoles: ["Instructional Designer"] },
      { ...seed.savedJobs[0]!, title: "Backend Engineer" },
    );
    // The title rules call this an occupational conflict; the model read the
    // listing and the profile and decided otherwise.
    expect(assessed.score).toBe(88);
    expect(assessed.recommendation).toBe("review_before_applying");
    expect(assessed.reasons).toEqual(["Close match"]);
  });

  test("the model's place verdict stands over remote alignment", async () => {
    const seed = createSeed();
    const client = {
      ...createAiClient(),
      assessJobFit: () =>
        Promise.resolve({
          score: 30,
          reasons: [],
          gaps: ["Remote only for people in Germany"],
          requirements: [
            requirement("Remote work in Germany only", "conflict", "location"),
          ],
          recommendation: "skip" as const,
          preferences: "conflict" as const,
          locationReach: "outside_area" as const,
        }),
    };
    const assessed = await createMatchAssessmentAsync(
      client,
      seed.profile,
      seed.searchPreferences,
      { ...seed.savedJobs[0]!, location: "Remote", workMode: ["remote"] },
    );
    expect(assessed.dimensions.preferenceAlignment.state).toBe("conflict");
    expect(assessed.locationReach).toBe("outside_area");
    expect(assessed.recommendation).toBe("skip");
  });
  test("reuses a current full assessment on shortlist and honors an explicit reassessment", async () => {
    const seed = createSeed();
    const job = {
      ...seed.savedJobs[0]!,
      detailQuality: "detail_enriched" as const,
      listingDetailFetch: {
        outcome: "enriched" as const,
        method: "json_ld" as const,
        attemptedAt: "2026-10-02T00:00:00.000Z",
        detail: "Read the full listing.",
      },
    };
    const assessJobFit = vi.fn(() =>
      Promise.resolve({
        score: 90,
        reasons: [],
        gaps: [],
        requirements: [requirement("German B2", "missing")],
      }),
    );
    const fetchListingHtml = vi.fn(() =>
      Promise.resolve({
        status: 200,
        finalUrl: job.canonicalUrl,
        html: "<main>Fresh listing requirements: German B2</main>",
      }),
    );
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: { ...seed, savedJobs: [job] },
      aiClient: {
        ...createAiClient(),
        assessJobFit,
        extractJobsFromPage: () =>
          Promise.resolve([
            {
              ...job,
              description:
                "Fresh listing requirements: German B2. " + job.description,
              minimumQualifications: ["German B2"],
            },
          ]),
      },
      fetchListingHtml,
    });
    await workspaceService.assessJobListing(job.id);
    await workspaceService.queueJobForReview(job.id);
    expect(assessJobFit).toHaveBeenCalledTimes(1);
    expect(fetchListingHtml).toHaveBeenCalledTimes(1);
    expect(assessJobFit.mock.calls[0]).toBeDefined();
    await workspaceService.assessJobListing(job.id);
    expect(assessJobFit).toHaveBeenCalledTimes(2);
    expect(fetchListingHtml).toHaveBeenCalledTimes(2);
  });
});

describe("completed full reads (R3-019, R3-106)", () => {
  test("rediscovery keeps the full verdict and requirement facts", async () => {
    const seed = createSeed();
    const original = seed.savedJobs[0]!;
    const full = await createMatchAssessmentAsync(
      {
        ...createAiClient(),
        assessJobFit: () =>
          Promise.resolve({
            score: 58,
            reasons: [],
            gaps: ["Java not evidenced"],
            requirements: [requirement("Java", "missing")],
          }),
      },
      seed.profile,
      seed.searchPreferences,
      original,
    );
    const existing = { ...original, matchAssessment: full };
    const merged = mergeDiscoveredJob(
      { ...full, judgment: null, requirements: [], score: 0 },
      { ...original, description: original.title },
      existing,
    );
    expect(merged.matchAssessment).toEqual(full);
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed: { ...seed, savedJobs: [existing] },
    });
    await workspaceService.getWorkspaceSnapshot();
    expect(
      (await repository.listSavedJobs())[0]?.matchAssessment.requirements,
    ).toEqual(full.requirements);
  });

  test("an empty reassessment reports failure rather than clearing the score", async () => {
    const seed = createSeed();
    const full = await createMatchAssessmentAsync(
      {
        ...createAiClient(),
        assessJobFit: () =>
          Promise.resolve({
            score: 45,
            reasons: [],
            gaps: [],
            requirements: [requirement("Licence", "missing")],
          }),
      },
      seed.profile,
      seed.searchPreferences,
      seed.savedJobs[0]!,
    );
    const job = {
      ...seed.savedJobs[0]!,
      matchAssessment: full,
      detailQuality: "detail_enriched" as const,
      listingDetailFetch: {
        outcome: "enriched" as const,
        method: "json_ld" as const,
        attemptedAt: "2026-10-04T00:00:00.000Z",
        detail: "Read",
      },
    };
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed: { ...seed, savedJobs: [job] },
      aiClient: {
        ...createAiClient(),
        assessJobFit: () => Promise.resolve(null),
        extractJobsFromPage: () => Promise.resolve([job]),
      },
      fetchListingHtml: () =>
        Promise.resolve({
          status: 200,
          finalUrl: job.canonicalUrl,
          html: "<main>Readable listing body</main>",
        }),
    });
    await expect(workspaceService.assessJobListing(job.id)).rejects.toThrow(
      "previous assessment was kept",
    );
    expect((await repository.listSavedJobs())[0]?.matchAssessment.score).toBe(45);
  });

  test("a completed read explains its score change in the visible rationale", async () => {
    const seed = createSeed();
    const preliminary = await createMatchAssessmentAsync(
      {
        ...createAiClient(),
        assessJobFit: () =>
          Promise.resolve({
            score: 48,
            reasons: ["Related work"],
            gaps: [],
            requirements: [requirement("Experience", "unknown")],
          }),
      },
      seed.profile,
      seed.searchPreferences,
      seed.savedJobs[0]!,
    );
    const next = await createMatchAssessmentAsync(
      {
        ...createAiClient(),
        assessJobFit: () =>
          Promise.resolve({
            score: 32,
            reasons: [],
            gaps: ["Required Java experience not evidenced"],
            requirements: [requirement("Java", "missing")],
            recommendation: "skip" as const,
          }),
      },
      seed.profile,
      seed.searchPreferences,
      { ...seed.savedJobs[0]!, matchAssessment: preliminary },
    );
    expect(next.recommendationRationale).toContain("from 48% to 32%");
    expect(next.recommendationRationale).toContain("Java experience");
  });
});

test.each([
  { requirements: undefined },
  { requirements: [] as JobRequirementAssessment[] },
])(
  "a shallow full reply cannot replace checked requirements (R3-019, R3-018): %j",
  async ({ requirements }) => {
    const seed = createSeed();
    const job = seed.savedJobs[0]!;
    const checked = await createMatchAssessmentAsync(
      {
        ...createAiClient(),
        assessJobFit: () =>
          Promise.resolve({
            score: 58,
            reasons: [],
            gaps: [],
            requirements: [requirement("Java", "missing")],
          }),
      },
      seed.profile,
      seed.searchPreferences,
      job,
    );
    await expect(
      createMatchAssessmentAsync(
        {
          ...createAiClient(),
          assessJobFit: () =>
            Promise.resolve({
              score: 85,
              reasons: ["Title matches"],
              gaps: [],
              ...(requirements ? { requirements } : {}),
            }),
        },
        seed.profile,
        seed.searchPreferences,
        { ...job, matchAssessment: checked },
      ),
    ).rejects.toThrow("previous assessment was kept");
  },
);


describe("fix-up response and route regressions", () => {
  test.each([null, "https://jobs.example.test/apply/correct"])(
    "persists a refreshed destination (%s) in the sighting and honours it after rediscovery",
    async (applicationUrl) => {
      const seed = createSeed();
      const original = seed.savedJobs[0]!;
      const bad = "https://jobs.example.test/blog/applying-for-citizenship";
      const job = {
        ...original,
        applicationUrl: bad,
        provenance: [
          {
            targetId: "test",
            adapterKind: "auto" as const,
            startingUrl: original.canonicalUrl,
            discoveredAt: original.discoveredAt,
            listingUrl: original.canonicalUrl,
            applicationUrl: bad,
            pageApplyUrl: bad,
            routeReadAt: "2026-10-01T00:00:00Z",
            collectionMethod: "fallback_search" as const,
            providerKey: null,
            providerBoardToken: null,
            resolvedAdapterKind: null,
            titleTriageOutcome: "pass" as const,
          },
        ],
      };
      const { workspaceService, repository } = createWorkspaceServiceHarness({
        seed: { ...seed, savedJobs: [job] },
        aiClient: {
          ...createAiClient(),
          extractJobsFromPage: () => Promise.resolve([{ ...job, applicationUrl }]),
          assessJobFit: () =>
            Promise.resolve({
              score: 50,
              reasons: [],
              gaps: [],
              requirements: [requirement("Skills", "unknown")],
            }),
        },
        fetchListingHtml: () =>
          Promise.resolve({
            status: 200,
            finalUrl: job.canonicalUrl,
            html: "<main>Full listing body</main>",
          }),
      });
      await workspaceService.assessJobListing(job.id);
      const saved = (await repository.listSavedJobs())[0]!;
      expect(saved.applicationUrl).toBe(applicationUrl);
      expect(saved.provenance[0]).toMatchObject({
        applicationUrl,
        pageApplyUrl: applicationUrl,
      });
      // Even legacy sightings with an obsolete collected URL honour the read.
      expect(
        applySightingRoute(saved, {
          ...saved.provenance[0]!,
          applicationUrl: bad,
        }).applicationUrl,
      ).toBe(applicationUrl);
      const merged = mergeDiscoveredPostings(
        seed.profile,
        seed.searchPreferences,
        [saved],
        [job],
        () => job.provenance[0]!,
      ).mergedJobs[0]!;
      expect(merged.applicationUrl).toBe(applicationUrl);
      expect(
        applySightingRoute(merged, merged.provenance[0]!).applicationUrl,
      ).toBe(applicationUrl);
    },
  );

  test.each([undefined, []])(
    "rejects an incomplete first full assessment with checks %s",
    async (requirements) => {
      const seed = createSeed();
      const client = {
        ...createAiClient(),
        assessJobFit: () =>
          Promise.resolve({
            score: 95,
            recommendation: "strong_fit" as const,
            reasons: ["Title matches"],
            gaps: [],
            ...(requirements ? { requirements } : {}),
          }),
      };
      await expect(
        createMatchAssessmentAsync(
          client,
          seed.profile,
          seed.searchPreferences,
          seed.savedJobs[0]!,
        ),
      ).rejects.toThrow("could not be completed");
    },
  );
});
