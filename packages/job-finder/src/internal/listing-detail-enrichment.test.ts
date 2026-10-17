import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SavedJobSchema,
  type JobPosting,
  type MatchAssessment,
  type SavedJob,
} from "@nestor/contracts";
import { createSavedJob } from "../workspace-service.test-fixtures";
import {
  applyListingDetailToJob,
  createDefaultListingHtmlFetcher,
  describeListingDetailEnrichment,
  enrichSavedJobListingDetails,
  jobNeedsListingDetail,
  namesDifferentRole,
  readListingDetail,
  type ListingHtmlFetcher,
  type ListingPageReader,
} from "./listing-detail-enrichment";

const NOW = "2026-09-05T10:00:00.000Z";
afterEach(() => vi.unstubAllGlobals());

it("stops consuming an oversized response rather than buffering its entire body", async () => {
  let pulls = 0;
  const cancel = vi.fn();
  const bytes = new TextEncoder().encode("x".repeat(8192));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(bytes);
      if (pulls === 1000) controller.close();
    },
    cancel,
  });
  vi.stubGlobal("fetch", () => Promise.resolve(new Response(body)));
  const result = await createDefaultListingHtmlFetcher()(
    "https://example.test/large",
    { signal: new AbortController().signal },
  );
  expect(result.html).toHaveLength(1_500_000);
  expect(pulls).toBeLessThan(200);
  expect(cancel).toHaveBeenCalledOnce();
});

function cardOnlyJob(overrides: Partial<SavedJob> = {}): SavedJob {
  return createSavedJob({
    id: "job_card",
    source: "target_site",
    sourceJobId: "4677969",
    discoveryMethod: "browser_agent",
    canonicalUrl: "https://jobs.example.test/4677969-senior-software-engineer",
    applicationUrl: null,
    title: "Senior Software Engineer",
    company: "jobs.example.test",
    location: "Location not stated",
    workMode: [],
    applyPath: "unknown",
    easyApplyEligible: false,
    postedAt: null,
    postedAtText: null,
    discoveredAt: "2026-09-05T09:58:00.000Z",
    firstSeenAt: "2026-09-05T09:58:00.000Z",
    lastSeenAt: "2026-09-05T09:58:00.000Z",
    lastVerifiedActiveAt: null,
    salaryText: null,
    summary: null,
    description: "Senior Software Engineer",
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
    keywordSignals: [],
    benefits: [],
    status: "discovered",
    matchAssessment: { score: 48, reasons: [], gaps: [] },
    provenance: [],
    ...overrides,
  } as Parameters<typeof createSavedJob>[0]);
}

const RECORD_PAGE = `<script type="application/ld+json">{"@type":"JobPosting","title":"Senior Software Engineer","datePosted":"2026-08-30","employmentType":"FULL_TIME","hiringOrganization":{"name":"Garner Health"},"jobLocation":{"address":{"addressLocality":"New York","addressRegion":"NY","addressCountry":"US"}},"baseSalary":{"currency":"USD","value":{"minValue":180000,"maxValue":220000,"unitText":"YEAR"}},"description":"<p>Garner is building tools that make healthcare affordable, and this team owns the provider platform end to end.</p><h3>What you will do</h3><ul><li>Design and ship C# and .NET services for a behavioral-health platform.</li><li>Own MongoDB schema design and query tuning across provider and appointment workflows.</li><li>Build ASP.NET Core REST APIs and internal microservices.</li></ul><h3>Requirements</h3><ul><li>5+ years with .NET Core and REST APIs.</li><li>Production experience with cloud services on Azure or AWS.</li><li>Comfort with CI/CD automation and observability.</li></ul><p>We offer remote work across the United States.</p>"}</script>`;

function fakeFetcher(
  routes: Record<string, { status?: number; html: string } | Error>,
): ListingHtmlFetcher & { calls: string[] } {
  const calls: string[] = [];
  const fetcher: ListingHtmlFetcher = (url) => {
    calls.push(url);
    const route = routes[url];
    if (!route) {
      return Promise.resolve({ status: 404, html: "", finalUrl: url });
    }
    if (route instanceof Error) {
      return Promise.reject(route);
    }
    return Promise.resolve({
      status: route.status ?? 200,
      html: route.html,
      finalUrl: url,
    });
  };
  return Object.assign(fetcher, { calls });
}

const assess = vi.fn(
  (posting: JobPosting): MatchAssessment =>
    ({
      scorerVersion: 9,
      score: posting.description.length > 100 ? 82 : 48,
      dimensions: {},
      reasons: posting.description.length > 100 ? ["Requirements matched"] : [],
      gaps: [],
      recommendation: "review_before_applying",
      recommendationRationale: "test",
      contextFingerprint: "ctx",
      postingFingerprint: `post_${posting.description.length}`,
    }) as unknown as MatchAssessment,
);

describe("jobNeedsListingDetail", () => {
  it("treats reworded titles as the same role and other roles as a conflict", () => {
    expect(
      namesDifferentRole(
        "Werkstudent Data Analyst",
        "Werkstudent Data Analyst (m/w/d)",
      ),
    ).toBe(false);
    expect(
      namesDifferentRole("Data Engineer", "Data Engineer, Meadow Pipelines"),
    ).toBe(false);
    expect(
      namesDifferentRole(
        "Lead Operations Planner",
        "Intern Operations Planner",
      ),
    ).toBe(true);
    expect(
      namesDifferentRole(
        "Junior Instructional Designer",
        "Lead Learning Coordinator",
      ),
    ).toBe(true);
  });

  it("records a structured title conflict without attaching the other role's facts", async () => {
    const job = cardOnlyJob({ title: "Junior Instructional Designer" });
    const result = await enrichSavedJobListingDetails({
      jobs: [job],
      assess,
      fetchHtml: fakeFetcher({ [job.canonicalUrl]: { html: RECORD_PAGE } }),
      now: () => NOW,
    });
    expect(result.jobs[0]?.title).toBe(job.title);
    expect(result.jobs[0]?.listingDetailFetch?.identityConflict).toEqual({
      expectedTitle: job.title,
      observedTitle: "Senior Software Engineer",
    });
    expect(result.jobs[0]?.description).toBe(job.description);
  });

  it("reads a rate-limited page as soon as the site's own wait has passed", () => {
    const rateLimited = (attemptedAt: string, retryAfterAt: string) =>
      cardOnlyJob({
        listingDetailFetch: {
          attemptedAt,
          outcome: "blocked",
          method: null,
          detail: "Rate limited.",
          retryAfterAt,
        },
      });
    // NOW is 10:00. Asked to wait two seconds a minute ago: due now, not in
    // an hour.
    expect(
      jobNeedsListingDetail(
        rateLimited("2026-09-05T09:59:00.000Z", "2026-09-05T09:59:02.000Z"),
        NOW,
      ),
    ).toBe(true);
    expect(
      jobNeedsListingDetail(
        rateLimited("2026-09-05T09:59:58.000Z", "2026-09-05T10:00:30.000Z"),
        NOW,
      ),
    ).toBe(false);
    // A refusal without a stated wait keeps the hour-long back-off.
    expect(
      jobNeedsListingDetail(
        cardOnlyJob({
          listingDetailFetch: {
            attemptedAt: "2026-09-05T09:59:00.000Z",
            outcome: "blocked",
            method: null,
            detail: "The page answered 403.",
          },
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("reads fetchable jobs until this stage has captured their complete page", () => {
    expect(jobNeedsListingDetail(cardOnlyJob(), NOW)).toBe(true);
    expect(
      jobNeedsListingDetail(
        cardOnlyJob({ detailQuality: "detail_enriched" }),
        NOW,
      ),
    ).toBe(true);
    expect(
      jobNeedsListingDetail(
        cardOnlyJob({
          listingDetailFetch: {
            attemptedAt: "2026-09-05T08:30:00.000Z",
            outcome: "blocked",
            method: null,
            detail: "Rate limited.",
            retryAfterAt: "2026-09-05T10:30:00.000Z",
          },
        }),
        NOW,
      ),
    ).toBe(false);
    expect(
      jobNeedsListingDetail(
        cardOnlyJob({
          detailQuality: "detail_enriched",
          listingDetailFetch: {
            attemptedAt: "2026-09-05T09:30:00.000Z",
            outcome: "enriched",
            method: "json_ld",
            detail: "Read the complete listing page.",
          },
        }),
        NOW,
      ),
    ).toBe(false);
    expect(
      jobNeedsListingDetail(
        cardOnlyJob({ canonicalUrl: "mailto:jobs@example.test" }),
        NOW,
      ),
    ).toBe(false);
    expect(
      jobNeedsListingDetail(
        cardOnlyJob({
          listingDetailFetch: {
            attemptedAt: "2026-09-05T09:30:00.000Z",
            outcome: "no_detail",
            method: null,
            detail: null,
          },
        }),
        NOW,
      ),
    ).toBe(false);
    // A failed read is worth another try after an hour, a read with no body
    // only after a day.
    expect(
      jobNeedsListingDetail(
        cardOnlyJob({
          listingDetailFetch: {
            attemptedAt: "2026-09-05T08:30:00.000Z",
            outcome: "fetch_failed",
            method: null,
            detail: null,
          },
        }),
        NOW,
      ),
    ).toBe(true);
  });
});

describe("enrichSavedJobListingDetails", () => {
  it("retries a body that ends mid-word once and records partial listing text", async () => {
    const job = cardOnlyJob();
    const incompleteDescription = `${"Build reliable TypeScript services with a senior product team. ".repeat(12)}Coordinate delivery across th`;
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      title: job.title,
      description: incompleteDescription,
    })}</script>`;
    const fetchHtml = vi.fn<ListingHtmlFetcher>((url) =>
      Promise.resolve({ status: 200, html, finalUrl: url }),
    );

    const result = await enrichSavedJobListingDetails({
      jobs: [job],
      fetchHtml,
      assess,
      now: () => NOW,
    });

    expect(fetchHtml).toHaveBeenCalledTimes(2);
    expect(result.jobs[0]?.detailQuality).toBe("partial_detail");
    expect(result.jobs[0]?.listingDetailFetch).toMatchObject({
      outcome: "partial",
      detail:
        "Read partial listing text; some page text was omitted or the response was incomplete.",
    });
  });

  it("reads the page, fills the card's gaps, upgrades quality and re-scores", async () => {
    const job = cardOnlyJob();
    const fetchHtml = fakeFetcher({
      [job.canonicalUrl]: { html: RECORD_PAGE },
    });

    const result = await enrichSavedJobListingDetails({
      jobs: [job],
      fetchHtml,
      assess,
      now: () => NOW,
    });

    const next = result.jobs[0]!;
    expect(result.changedJobIds).toEqual([job.id]);
    expect(next.detailQuality).toBe("detail_enriched");
    expect(next.listingDetailFetch).toMatchObject({
      attemptedAt: NOW,
      outcome: "enriched",
      method: "json_ld",
    });
    // The body is the point of the read; the card's placeholder company and
    // location give way to what the page said, the pay is filled in, and the
    // summary is the opening paragraph rather than the whole body.
    expect(next.description).toContain("5+ years with .NET Core and REST APIs");
    expect(next.company).toBe("Garner Health");
    expect(next.location).toBe("New York, NY, US");
    expect(next.salaryText).toBe("USD 180,000 – 220,000 / year");
    expect(next.normalizedCompensation.minAnnualUsd).toBe(180000);
    expect(next.postedAt).toBe("2026-08-30T00:00:00.000Z");
    expect(next.employmentType).toBe("Full-Time");
    // Work mode comes from the record's own fields, not from words in the body.
    expect(next.workMode).toEqual(job.workMode);
    expect(next.summary).toMatch(/^Garner is building tools/u);
    expect(next.summary?.length ?? 0).toBeLessThan(430);
    expect(next.matchAssessment.score).toBe(82);
    const scoringInput = SavedJobSchema.parse(assess.mock.calls.at(-1)?.[0]);
    expect(scoringInput.listingDetailCapture).toMatchObject({
      state: "captured",
    });
    expect(scoringInput.description).toContain(
      "5+ years with .NET Core and REST APIs",
    );
    expect(result.summary).toMatchObject({ attempted: 1, enriched: 1 });
  });

  it("has the model read a page that publishes no record", async () => {
    const job = cardOnlyJob();
    const html = `<html><head><title>Senior Software Engineer | Garner</title></head><body><main><h1>Senior Software Engineer</h1><p>${"Design and ship .NET services. ".repeat(30)}</p></main></body></html>`;
    const fetchHtml = fakeFetcher({ [job.canonicalUrl]: { html } });
    const body = `Garner is building tools that make healthcare affordable.\n\n${"Design and ship .NET services with the provider platform team. ".repeat(6)}\n\nRequirements\n\n• 5+ years with .NET Core and REST APIs.`;
    const readPage = vi.fn<ListingPageReader>(() =>
      Promise.resolve({
        ...job,
        title: "Senior Software Engineer",
        company: "Garner Health",
        location: "New York, NY, United States",
        description: body,
        workMode: ["hybrid" as const],
        keySkills: [".NET Core", "REST APIs"],
        minimumQualifications: ["5+ years with .NET Core and REST APIs"],
      }),
    );

    const result = await enrichSavedJobListingDetails({
      jobs: [job],
      fetchHtml,
      readPage,
      assess,
      now: () => NOW,
    });

    expect(readPage).toHaveBeenCalledTimes(1);
    const pageRead = readPage.mock.calls[0]?.[0];
    expect(pageRead?.pageUrl).toBe(job.canonicalUrl);
    expect(pageRead?.pageText).toContain(
      "Page title: Senior Software Engineer | Garner",
    );
    const next = result.jobs[0]!;
    expect(next.listingDetailFetch).toMatchObject({
      outcome: "enriched",
      method: "page_text",
    });
    expect(next.description).toContain("5+ years with .NET Core");
    expect(next.company).toBe("Garner Health");
    expect(next.location).toBe("New York, NY, United States");
    expect(next.workMode).toContain("hybrid");
    expect(next.keySkills).toEqual([".NET Core", "REST APIs"]);
    expect(next.minimumQualifications).toEqual([
      "5+ years with .NET Core and REST APIs",
    ]);
  });

  it("records no detail when the model finds no listing on the page", async () => {
    const job = cardOnlyJob();
    const fetchHtml = fakeFetcher({
      [job.canonicalUrl]: {
        html: "<html><body><main><p>Sign in to view this listing.</p></main></body></html>",
      },
    });

    const result = await enrichSavedJobListingDetails({
      jobs: [job],
      fetchHtml,
      readPage: () => Promise.resolve(null),
      assess,
      now: () => NOW,
    });

    expect(result.jobs[0]?.listingDetailFetch).toMatchObject({
      outcome: "no_detail",
      detail:
        "The listing could not be read from this page. Open the listing and try again.",
    });
  });

  it("uses the salary stated in the body when a separate cell doubled the floor", async () => {
    const applied = await applyListingDetailToJob({
      job: cardOnlyJob({ salaryText: "$200000 - 500000" }),
      detail: {
        method: "page_text",
        title: null,
        company: null,
        location: null,
        description:
          "Highly Competitive Salary: - $100k-$500k USD yearly. Candidate Requirements: - Proven campaign leadership and paid ads experience across multiple channels.",
        salaryText: null,
        employmentType: null,
        postedAt: null,
        validThrough: null,
        workModeHints: ["remote"],
        directApplyUrl: null,
      },
      attemptedAt: NOW,
      assess,
    });

    expect(applied.job.salaryText).toBe("$100k-$500k USD yearly");
    expect(applied.job.normalizedCompensation.minAnnualUsd).toBe(100_000);
    expect(applied.job.normalizedCompensation.maxAnnualUsd).toBe(500_000);
  });

  it("corrects a plausible but wrong card employer and location from the listing (R3-013)", async () => {
    const job = cardOnlyJob({ company: "Garner", location: "Austin, TX" });
    const fetchHtml = fakeFetcher({
      [job.canonicalUrl]: { html: RECORD_PAGE },
    });

    const result = await enrichSavedJobListingDetails({
      jobs: [job],
      fetchHtml,
      assess,
      now: () => NOW,
    });

    expect(result.jobs[0]?.company).toBe("Garner Health");
    expect(result.jobs[0]?.location).toBe("New York, NY, US");
  });

  it("records what happened when a page will not read, without failing the batch", async () => {
    const blocked = cardOnlyJob({
      id: "job_blocked",
      canonicalUrl: "https://jobs.example.test/blocked",
    });
    const missing = cardOnlyJob({
      id: "job_missing",
      canonicalUrl: "https://jobs.example.test/missing",
    });
    const thin = cardOnlyJob({
      id: "job_thin",
      canonicalUrl: "https://jobs.example.test/thin",
    });
    const broken = cardOnlyJob({
      id: "job_broken",
      canonicalUrl: "https://jobs.example.test/broken",
    });
    const fetchHtml = fakeFetcher({
      [blocked.canonicalUrl]: { status: 403, html: "" },
      [thin.canonicalUrl]: {
        html: "<html><body><p>Sign in to view.</p></body></html>",
      },
      [broken.canonicalUrl]: new Error("socket hang up"),
    });

    const result = await enrichSavedJobListingDetails({
      jobs: [blocked, missing, thin, broken],
      fetchHtml,
      assess,
      now: () => NOW,
    });

    const byId = new Map(result.jobs.map((job) => [job.id, job]));
    expect(byId.get("job_blocked")?.listingDetailFetch?.outcome).toBe(
      "blocked",
    );
    expect(byId.get("job_missing")?.listingDetailFetch?.outcome).toBe(
      "fetch_failed",
    );
    expect(byId.get("job_thin")?.listingDetailFetch?.outcome).toBe("no_detail");
    expect(byId.get("job_broken")?.listingDetailFetch).toMatchObject({
      outcome: "fetch_failed",
      detail: "socket hang up",
    });
    for (const job of result.jobs) {
      expect(job.detailQuality).toBe("card_only");
      expect(job.description).toBe("Senior Software Engineer");
    }
    expect(result.summary).toMatchObject({
      attempted: 4,
      blocked: 1,
      failed: 2,
      noDetail: 1,
      enriched: 0,
    });
    expect(describeListingDetailEnrichment(result.summary)).toBe(
      "Read 0 of 4 listing pages · 1 had no listing text · 1 was blocked or rate-limited · 2 could not be reached.",
    );

    const rateLimited = cardOnlyJob({
      id: "job_rate_limited",
      canonicalUrl: "https://jobs.example.test/rate-limited",
    });
    const alwaysRateLimited = vi.fn<ListingHtmlFetcher>().mockResolvedValue({
      status: 429,
      html: "",
      finalUrl: rateLimited.canonicalUrl,
      retryAfterMs: 0,
    });
    const rateLimitedResult = await enrichSavedJobListingDetails({
      jobs: [rateLimited],
      fetchHtml: alwaysRateLimited,
      assess,
      now: () => NOW,
    });
    // Asked once, then again twice after the site's pause, then left for the
    // next search.
    expect(alwaysRateLimited).toHaveBeenCalledTimes(3);
    expect(rateLimitedResult.jobs[0]?.listingDetailFetch).toMatchObject({
      outcome: "blocked",
      detail:
        "The site asked Job Finder to slow down (HTTP 429). The listing is read again on the next search.",
    });

    // Every page that was rate-limited gets its own retry, not just the first.
    const firstLimited = cardOnlyJob({
      id: "job_first_limited",
      canonicalUrl: "https://jobs.example.test/first-limited",
    });
    const secondLimited = cardOnlyJob({
      id: "job_second_limited",
      canonicalUrl: "https://jobs.example.test/second-limited",
    });
    const limitedOnce = new Set<string>();
    const eachOnceFetcher = vi.fn<ListingHtmlFetcher>((url) => {
      if (!limitedOnce.has(url)) {
        limitedOnce.add(url);
        return Promise.resolve({
          status: 429,
          html: "",
          finalUrl: url,
          retryAfterMs: 0,
        });
      }
      return Promise.resolve({ status: 200, html: RECORD_PAGE, finalUrl: url });
    });
    const bothRecovered = await enrichSavedJobListingDetails({
      jobs: [firstLimited, secondLimited],
      fetchHtml: eachOnceFetcher,
      assess,
      now: () => NOW,
      concurrency: 1,
    });
    expect(eachOnceFetcher).toHaveBeenCalledTimes(4);
    expect(bothRecovered.summary).toMatchObject({ enriched: 2, blocked: 0 });

    const recoversAfterRateLimit = cardOnlyJob({
      id: "job_rate_limit_recovers",
      canonicalUrl: "https://jobs.example.test/rate-limit-recovers",
    });
    const controlledFetcher = vi
      .fn<ListingHtmlFetcher>()
      .mockResolvedValueOnce({
        status: 429,
        html: "",
        finalUrl: recoversAfterRateLimit.canonicalUrl,
        retryAfterMs: 0,
      })
      .mockResolvedValueOnce({
        status: 200,
        html: RECORD_PAGE,
        finalUrl: recoversAfterRateLimit.canonicalUrl,
      });
    const recovered = await enrichSavedJobListingDetails({
      jobs: [recoversAfterRateLimit],
      fetchHtml: controlledFetcher,
      assess,
      now: () => NOW,
    });
    expect(controlledFetcher).toHaveBeenCalledTimes(2);
    expect(recovered.summary).toMatchObject({ enriched: 1, blocked: 0 });
    expect(recovered.jobs[0]?.detailQuality).toBe("detail_enriched");

    const longWait = cardOnlyJob({
      id: "job_long_rate_limit",
      canonicalUrl: "https://jobs.example.test/long-rate-limit",
    });
    const deferredSibling = cardOnlyJob({
      id: "job_deferred_sibling",
      canonicalUrl: "https://jobs.example.test/deferred-sibling",
    });
    const longWaitFetcher = vi.fn<ListingHtmlFetcher>().mockResolvedValue({
      status: 429,
      html: "",
      finalUrl: longWait.canonicalUrl,
      retryAfterMs: 120_000,
    });
    const deferred = await enrichSavedJobListingDetails({
      jobs: [longWait, deferredSibling],
      fetchHtml: longWaitFetcher,
      assess,
      now: () => NOW,
      concurrency: 1,
    });
    expect(longWaitFetcher).toHaveBeenCalledTimes(1);
    expect(deferred.summary).toMatchObject({
      attempted: 1,
      blocked: 1,
      skipped: 1,
    });
    expect(deferred.jobs[0]?.listingDetailFetch?.retryAfterAt).toBe(
      "2026-09-05T10:02:00.000Z",
    );

    const shortWait = cardOnlyJob({
      id: "job_short_rate_limit",
      canonicalUrl: "https://jobs.example.test/short-rate-limit",
    });
    const concurrentLongWait = cardOnlyJob({
      id: "job_concurrent_long_rate_limit",
      canonicalUrl: "https://jobs.example.test/concurrent-long-rate-limit",
    });
    const neverFetched = cardOnlyJob({
      id: "job_never_fetched_after_rate_limit",
      canonicalUrl: "https://jobs.example.test/never-fetched",
    });
    const concurrentFetcher = vi.fn<ListingHtmlFetcher>(async (url) => {
      if (url === shortWait.canonicalUrl) {
        return {
          status: 429,
          html: "",
          finalUrl: url,
          retryAfterMs: 10,
        };
      }
      if (url === concurrentLongWait.canonicalUrl) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return {
          status: 429,
          html: "",
          finalUrl: url,
          retryAfterMs: 120_000,
        };
      }
      return { status: 200, html: RECORD_PAGE, finalUrl: url };
    });
    const concurrentDeferred = await enrichSavedJobListingDetails({
      jobs: [shortWait, concurrentLongWait, neverFetched],
      fetchHtml: concurrentFetcher,
      assess,
      now: () => NOW,
      concurrency: 2,
    });
    expect(concurrentFetcher).toHaveBeenCalledTimes(2);
    expect(concurrentFetcher).not.toHaveBeenCalledWith(
      neverFetched.canonicalUrl,
      expect.anything(),
    );
    expect(concurrentDeferred.summary).toMatchObject({
      attempted: 2,
      blocked: 2,
      skipped: 1,
    });
    expect(
      concurrentDeferred.jobs
        .slice(0, 2)
        .map((job) => job.listingDetailFetch?.retryAfterAt),
    ).toEqual(["2026-09-05T10:02:00.000Z", "2026-09-05T10:02:00.000Z"]);
  });

  it("skips jobs that do not need a read and caps how many it reads", async () => {
    const enriched = cardOnlyJob({
      id: "job_done",
      detailQuality: "detail_enriched",
      listingDetailFetch: {
        attemptedAt: "2026-09-05T09:30:00.000Z",
        outcome: "enriched",
        method: "json_ld",
        detail: "Read the complete listing page.",
      },
    });
    const first = cardOnlyJob({
      id: "job_1",
      canonicalUrl: "https://jobs.example.test/1",
    });
    const second = cardOnlyJob({
      id: "job_2",
      canonicalUrl: "https://jobs.example.test/2",
    });
    const fetchHtml = fakeFetcher({
      [first.canonicalUrl]: { html: RECORD_PAGE },
      [second.canonicalUrl]: { html: RECORD_PAGE },
    });

    const result = await enrichSavedJobListingDetails({
      jobs: [enriched, first, second],
      fetchHtml,
      assess,
      now: () => NOW,
      maxJobs: 1,
    });

    expect(fetchHtml.calls).toEqual([first.canonicalUrl]);
    expect(result.changedJobIds).toEqual(["job_1"]);
    expect(result.summary.skipped).toBe(2);
    expect(result.jobs.map((job) => job.id)).toEqual([
      "job_done",
      "job_1",
      "job_2",
    ]);
  });

  it("gives every queued listing its own request budget", async () => {
    const jobs = [1, 2, 3].map((index) =>
      cardOnlyJob({
        id: `job_${index}`,
        canonicalUrl: `https://jobs.example.test/${index}`,
      }),
    );
    let ticks = 0;
    const fetchHtml: ListingHtmlFetcher = async (url) => {
      ticks += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { status: 200, html: RECORD_PAGE, finalUrl: url };
    };

    const result = await enrichSavedJobListingDetails({
      jobs,
      fetchHtml,
      assess,
      now: () => NOW,
      concurrency: 1,
      perRequestTimeoutMs: 100,
    });

    expect(ticks).toBe(3);
    expect(result.summary.attempted).toBe(3);
    expect(result.summary.enriched).toBe(3);
    expect(result.summary.skipped).toBe(0);
  });
});

describe("applyListingDetailToJob", () => {
  it("reports partial when the page text is thin but still better than the card", async () => {
    const job = cardOnlyJob();
    const applied = await applyListingDetailToJob({
      job,
      detail: {
        method: "page_text",
        title: null,
        company: null,
        location: null,
        description:
          "We are hiring an engineer to join a small platform team. You will own services, gather requirements with product, and ship weekly. Remote welcome across Europe.",
        salaryText: null,
        employmentType: null,
        postedAt: null,
        validThrough: null,
        workModeHints: ["remote"],
        directApplyUrl: null,
      },
      attemptedAt: NOW,
      assess,
    });

    expect(applied.outcome).toBe("partial");
    expect(applied.job.detailQuality).toBe("partial_detail");
    expect(applied.job.listingDetailFetch?.method).toBe("page_text");
    expect(applied.job.workMode).toEqual(["remote"]);
  });
});

describe("complete model page reads", () => {
  it("includes requirements outside main and after sparse JSON-LD (R3-036)", async () => {
    const job = cardOnlyJob();
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: job.title, description: "Search card only" })}</script></head><body><main><h1>${job.title}</h1><p>About the employer</p></main><section><h2>What you bring</h2><p>Portfolio required. Variable hours. German C1.</p></section></body></html>`;
    const readPage = vi.fn<ListingPageReader>(({ pageText }) => {
      expect(pageText).toContain("What you bring");
      expect(pageText).toContain("German C1");
      expect(pageText).toContain("Published JobPosting record");
      return Promise.resolve({
        ...job,
        description: "Portfolio required. Variable hours. German C1.",
        minimumQualifications: ["Portfolio", "German C1"],
      });
    });
    const detail = await readListingDetail({
      html,
      url: job.canonicalUrl,
      expectedTitle: job.title,
      readPage,
    });
    expect(readPage).toHaveBeenCalledOnce();
    expect(detail?.minimumQualifications).toEqual(["Portfolio", "German C1"]);
  });
  it("preserves model-read work mode, pay scale, start date and application restriction (R3-104)", async () => {
    const job = cardOnlyJob({ title: "Class Teacher" });
    const description =
      "MPS/UPS. Start as soon as possible. No CVs: use our application form. Teach KS2, prepare lessons, track progress and support pupils. ".repeat(
        8,
      );
    const result = await enrichSavedJobListingDetails({
      jobs: [job],
      fetchHtml: (url) =>
        Promise.resolve({
          status: 200,
          finalUrl: url,
          html: `<body>${description}<a href="/apply/teacher">Apply</a></body>`,
        }),
      readPage: () =>
        Promise.resolve({
          ...job,
          description,
          salaryText: "MPS/UPS",
          workMode: ["onsite"],
          applicationUrl: "https://jobs.example.test/apply/teacher",
          minimumQualifications: [
            "Available as soon as possible",
            "Application form only; no CVs",
          ],
        }),
      assess,
      now: () => NOW,
    });
    expect(result.jobs[0]).toMatchObject({
      salaryText: "MPS/UPS",
      workMode: ["onsite"],
      minimumQualifications: [
        "Available as soon as possible",
        "Application form only; no CVs",
      ],
    });
    expect(result.jobs[0]?.description).toContain("No CVs");
  });
  it("uses the model's vacancy route rather than an apply-labelled article (R3-014)", async () => {
    const job = cardOnlyJob({
      applicationUrl: "https://jobs.example.test/blog/applying-for-citizenship",
    });
    const html = `<body><h1>${job.title}</h1><a href="/blog/applying-for-citizenship">Apply for citizenship</a><a href="https://employer.example.test/apply/42">Apply to this role</a></body>`;
    const readPage = vi.fn<ListingPageReader>(({ pageText }) => {
      expect(pageText).toContain("https://employer.example.test/apply/42");
      return Promise.resolve({
        ...job,
        description: job.description,
        applicationUrl: "https://employer.example.test/apply/42",
      });
    });
    const detail = await readListingDetail({
      html,
      url: job.canonicalUrl,
      expectedTitle: job.title,
      readPage,
    });
    expect(detail?.directApplyUrl).toBe(
      "https://employer.example.test/apply/42",
    );
    const next = await applyListingDetailToJob({
      job,
      detail: detail!,
      attemptedAt: NOW,
      assess,
    });
    expect(next.job.applicationUrl).toBe(
      "https://employer.example.test/apply/42",
    );
    const unknown = await applyListingDetailToJob({
      job,
      detail: { ...detail!, directApplyUrl: null },
      attemptedAt: NOW,
      assess,
    });
    expect(unknown.job.applicationUrl).toBeNull();
  });
});

describe("partial listing corrections", () => {
  it.each(["Wrong employer", "Employer not stated"])(
    "keeps confirmed employer, city and work mode over %s without losing the full body",
    async (company) => {
      const job = cardOnlyJob({
        company,
        description: "Stored full listing evidence. ".repeat(100),
        detailQuality: "detail_enriched",
      });
      const result = await applyListingDetailToJob({
        job,
        attemptedAt: NOW,
        assess,
        detail: {
          method: "page_text",
          title: job.title,
          company: "Confirmed employer",
          location: "Confirmed city",
          workModeHints: ["hybrid"],
          description: "Only this part of the page was readable.",
          salaryText: null,
          employmentType: null,
          postedAt: null,
          validThrough: null,
          directApplyUrl: null,
        },
      });
      expect(result.job).toMatchObject({
        company: "Confirmed employer",
        location: "Confirmed city",
        workMode: ["hybrid"],
        description: job.description,
      });
    },
  );
});

it("keeps an omitted page read explicitly partial even when the model returns a long description", async () => {
  const job = cardOnlyJob();
  const detail = await readListingDetail({
    html: `<main>${"Navigation and body ".repeat(10000)}</main>`,
    url: job.canonicalUrl,
    expectedTitle: job.title,
    readPage: () =>
      Promise.resolve({
        ...job,
        description: "Readable requirements. ".repeat(100),
      }),
  });
  expect(detail?.descriptionLikelyTruncated).toBe(true);
  const result = await applyListingDetailToJob({
    job,
    detail: detail!,
    attemptedAt: NOW,
    assess,
  });
  expect(result.outcome).toBe("partial");
  expect(result.job.listingDetailFetch?.detail).toContain(
    "partial listing text",
  );
});

it("publishes listing progress after every read including a failure", async () => {
  const jobs = [
    cardOnlyJob(),
    cardOnlyJob({
      id: "second",
      canonicalUrl: "https://jobs.example.test/second",
    }),
  ];
  const progress: number[] = [];
  await enrichSavedJobListingDetails({
    jobs,
    maxJobs: 2,
    concurrency: 1,
    fetchHtml: (url) =>
      Promise.resolve({ status: 404, html: "", finalUrl: url }),
    assess: (posting) =>
      jobs.find((job) => job.canonicalUrl === posting.canonicalUrl)!
        .matchAssessment,
    onProgress: (completed, total) => {
      expect(total).toBe(2);
      progress.push(completed);
    },
  });
  expect(progress).toEqual([1, 2]);
});
