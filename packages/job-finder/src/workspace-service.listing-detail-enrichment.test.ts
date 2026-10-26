import { describe, expect, test, vi } from "vitest";
import type { JobFinderAiClient } from "@nestor/ai-providers";
import type { ListingHtmlFetcher } from "./index";
import { readPlanAssessment } from "./internal/plan-assessment";
import { htmlToPlainText } from "@nestor/browser-agent/listing-detail-extraction";
import { createSeed } from "./workspace-service.test-fixtures";
import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";
import { createAiClient } from "./workspace-service.test-runtimes";

const DESCRIPTION_HTML =
  "<p>We build the design system and the workflow platform every product team ships on, and this role owns both end to end.</p><h3>What you will do</h3><ul><li>Lead the design system roadmap across web and native surfaces.</li><li>Partner with product designers and engineers on component quality.</li><li>Run design reviews and mentor senior designers.</li></ul><h3>Requirements</h3><ul><li>Six or more years of product design with a shipped design system.</li><li>Deep Figma expertise and hands-on prototyping.</li><li>Experience with workflow or B2B platforms.</li></ul>";

function createDetailReadingAiClient() {
  const jobs = createSeed().savedJobs;
  const postings = [
    ...jobs,
    {
      ...jobs[1]!,
      canonicalUrl: "https://www.linkedin.com/jobs/view/linkedin_pause_case",
    },
  ];
  const aiClient = createAiClient();
  // Configured readers now read every page, including its published record.
  // Supply the model's result instead of relying on a structured-data bypass.
  const extractJobsFromPage = vi.fn<typeof aiClient.extractJobsFromPage>(
    (input) => {
      expect(input.pageType).toBe("job_detail");
      expect(input.maxJobs).toBe(1);
      expect(input.pageText).toContain("Published JobPosting record");
      expect(input.pageText).toContain("Six or more years of product design");
      const posting = postings.find(
        (job) => job.canonicalUrl === input.pageUrl,
      );
      if (!posting) throw new Error(`Unexpected listing: ${input.pageUrl}`);
      return Promise.resolve([
        {
          ...posting,
          company: "Signal Systems",
          location: "Austin, TX, US",
          description: htmlToPlainText(DESCRIPTION_HTML),
          salaryText: "USD 150,000 – 190,000 / year",
          applicationUrl: null,
        },
      ]);
    },
  );
  return {
    aiClient: {
      ...aiClient,
      extractJobsFromPage,
      assessJobFit: () =>
        Promise.resolve({
          score: 80,
          reasons: ["Design systems experience"],
          gaps: [],
          recommendation: "strong_fit" as const,
          role: "exact" as const,
          roleExplanation: "Design systems role.",
          requirements: [
            {
              id: "design",
              label: "Design systems",
              status: "supported" as const,
              category: "skill" as const,
              importance: "required" as const,
              jobEvidence: "Lead the design system roadmap",
              resumeEvidence: [],
              explanation: "Synthetic assessment.",
            },
          ],
        }),
    },
    extractJobsFromPage,
  };
}

const RECORD_PAGE = (title: string | null, company: string) =>
  `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title,
    datePosted: "2026-03-19",
    employmentType: "FULL_TIME",
    hiringOrganization: { "@type": "Organization", name: company },
    jobLocation: {
      "@type": "Place",
      address: {
        addressLocality: "Austin",
        addressRegion: "TX",
        addressCountry: "US",
      },
    },
    baseSalary: {
      "@type": "MonetaryAmount",
      currency: "USD",
      value: { minValue: 150000, maxValue: 190000, unitText: "YEAR" },
    },
    description: DESCRIPTION_HTML,
  })}</script></head><body></body></html>`;

test("Judge fit reads the current Settings policy and cannot reuse an opposite-policy verdict", async () => {
  const seed = createSeed();
  const job = seed.savedJobs[0]!;
  const { aiClient: base } = createDetailReadingAiClient();
  const assessJobFit = vi.fn<JobFinderAiClient["assessJobFit"]>(
    async (input) => {
      const result = await base.assessJobFit();
      const off =
        input.searchPreferences.discovery.remoteCountsAsAnyLocation === false;
      return {
        ...result,
        score: off ? 82 : 96,
        preferences: off ? "conflict" : "aligned",
        preferencesExplanation: off
          ? "Remote office is outside preferred places."
          : "Remote location accepted.",
      };
    },
  );
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient: { ...base, assessJobFit },
    fetchListingHtml: () =>
      Promise.resolve({
        status: 200,
        html: RECORD_PAGE(job.title, job.company),
        finalUrl: job.canonicalUrl,
      }),
  });
  await workspaceService.assessJobListing(job.id);
  const on = (await repository.listSavedJobs()).find(
    (row) => row.id === job.id,
  )!.matchAssessment;
  expect(on.score).toBe(96);
  const settings = await repository.getSettings();
  await repository.saveSettings({
    ...settings,
    aiBehavior: {
      ...settings.aiBehavior!,
      jobSearch: {
        ...settings.aiBehavior!.jobSearch,
        remoteCountsAsAnyLocation: false,
      },
    },
  });
  await workspaceService.assessJobListing(job.id);
  const off = (await repository.listSavedJobs()).find(
    (row) => row.id === job.id,
  )!.matchAssessment;
  expect(off.score).toBe(82);
  expect(off.judgment?.preferences).toBe("conflict");
  expect(off.judgment?.contextFingerprint).not.toBe(
    on.judgment?.contextFingerprint,
  );
  expect(
    assessJobFit.mock.calls.at(-1)?.[0].searchPreferences.discovery
      .remoteCountsAsAnyLocation,
  ).toBe(false);
});

describe("listing detail enrichment inside a discovery run", () => {
  test("shortlisting returns before its background listing read and persists the later assessment", async () => {
    let release!: (result: Awaited<ReturnType<ListingHtmlFetcher>>) => void;
    const fetchListingHtml = vi.fn<ListingHtmlFetcher>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { aiClient } = createDetailReadingAiClient();
    const seed = createSeed();
    const job = seed.savedJobs[0]!;
    job.detailQuality = "card_only";
    job.listingDetailFetch = null;
    job.matchAssessment.judgment = null;
    const onListingAssessmentFinished = vi.fn();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
      fetchListingHtml,
      aiClient,
      onListingAssessmentFinished,
    });
    const snapshot = await workspaceService.queueJobForReview(job.id);
    expect(
      snapshot.reviewQueue.find((item) => item.jobId === job.id)
        ?.listingAssessmentPending,
    ).toBe(true);
    await vi.waitFor(() => expect(fetchListingHtml).toHaveBeenCalled());
    expect(
      (await repository.listSavedJobs()).find((entry) => entry.id === job.id)
        ?.listingDetailFetch,
    ).toBeNull();
    release({
      status: 200,
      html: RECORD_PAGE(null, "Signal Systems"),
      finalUrl: job.canonicalUrl,
    });
    await vi.waitFor(async () => {
      const read = (await repository.listSavedJobs()).find(
        (entry) => entry.id === job.id,
      )!;
      expect(read.listingDetailFetch?.outcome).toBe("enriched");
      expect(
        readPlanAssessment(read, snapshot.activeCampaignId).matchAssessment
          .judgment,
      ).toBeTruthy();
      expect(onListingAssessmentFinished).toHaveBeenCalledOnce();
      expect(
        (await workspaceService.getWorkspaceSnapshot()).reviewQueue.find(
          (item) => item.jobId === job.id,
        )?.listingAssessmentPending,
      ).toBe(false);
    });
  });
});

test("an explicit listing read reports a job outside the saved list", async () => {
  const fetchListingHtml = vi.fn<ListingHtmlFetcher>();
  const { workspaceService } = createWorkspaceServiceHarness({
    fetchListingHtml,
  });
  await expect(
    workspaceService.assessJobListing("missing_synthetic_job"),
  ).rejects.toThrow("This job is not in the saved list.");
  expect(fetchListingHtml).not.toHaveBeenCalled();
});
