import { expect, it, vi } from "vitest";
import { readJobFromBrowserPage } from "./browser-page-job";
import { createSeed } from "./test-fixtures";
import { createDeterministicJobFinderAiClient } from "@nestor/ai-providers";
import type { JobFinderAiClient } from "@nestor/ai-providers";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  DiscoveryPageReadError,
  DiscoveryRunResultSchema,
  JobPostingSchema,
} from "@nestor/contracts";
import { openJobStore } from "@nestor/db/job-store";
import { savePageJobs } from "./job-commands";

const aiClient = createDeterministicJobFinderAiClient("Test model");
const pageUrl = "https://board.example.test/job";
const applicationUrl = "https://employer.example.test/jobs/design";
const boardPosting = JobPostingSchema.parse({
  ...createSeed().savedJobs[0]!,
  title: "Product Designer",
  company: "Example Studio",
  canonicalUrl: pageUrl,
  applicationUrl,
  description: "",
  needsRenderedPage: true,
});
const readContext = () => {
  const { profile, searchPreferences } = createSeed();
  return Promise.resolve({ profile, searchPreferences });
};

it("Add to Find jobs reads rendered DOM facts when the initial capture has no posting", async () => {
  const body =
    "Build accessible workflows. Full duties, qualifications and salary are available after rendering.";
  const posting = { ...createSeed().savedJobs[0]!, description: body };
  const extractJobsFromPage = vi
    .fn<JobFinderAiClient["extractJobsFromPage"]>()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([posting]);
  const readRenderedPage = vi.fn(() =>
    Promise.resolve({
      html: "<main>Loading</main>",
      finalUrl: "https://replica.test/job",
      visibleText: body,
    }),
  );
  const result = await readJobFromBrowserPage(
    { ...aiClient, extractJobsFromPage },
    {
      html: "<main>Loading</main>",
      pageUrl: "https://replica.test/job",
      browser: { runtime: { readRenderedPage }, readContext },
    },
  );
  expect(result).toEqual({ posting, fullListingRead: true });
  expect(readRenderedPage).toHaveBeenCalledOnce();
  expect(extractJobsFromPage.mock.calls[1]?.[0].pageText).toContain(body);
  const store = openJobStore(":memory:");
  try {
    const saved = savePageJobs(store, {
      postings: [result.posting],
      pageUrl: "https://replica.test/job",
      fullListingRead: result.fullListingRead,
    });
    const row = store.getJob(saved.ids[0]!)!;
    expect(row.description).toBe(body);
    expect(row.facts.fullListingRead).toBe(true);
    expect(row.facts.keySkills).toEqual(result.posting.keySkills);
  } finally {
    store.close();
  }
});

it("fills a partial posting from its application link through the browser listing reader", async () => {
  const description = "Design accessible products. Partner with engineers.";
  const runAgentDiscovery = vi
    .fn<NonNullable<BrowserSessionRuntime["runAgentDiscovery"]>>()
    .mockResolvedValue(
      DiscoveryRunResultSchema.parse({
        source: "target_site",
        startedAt: boardPosting.discoveredAt,
        completedAt: boardPosting.discoveredAt,
        querySummary: "Read the supplied vacancy",
        warning: null,
        jobs: [
          {
            ...boardPosting,
            canonicalUrl: applicationUrl,
            title: "Product Designer, Core Platform",
            description,
            listingDetailFetch: {
              outcome: "enriched",
              method: "page_text",
              attemptedAt: boardPosting.discoveredAt,
              detail: "Read the full posting",
            },
          },
        ],
      }),
    );
  const readRenderedPage = vi.fn();
  const result = await readJobFromBrowserPage(
    {
      ...aiClient,
      extractJobsFromPage: vi.fn().mockResolvedValue([boardPosting]),
    },
    {
      html: "<main>Product Designer at Example Studio</main>",
      pageUrl,
      browser: {
        runtime: { readRenderedPage, runAgentDiscovery },
        readContext,
      },
    },
  );
  expect(readRenderedPage).not.toHaveBeenCalled();
  expect(runAgentDiscovery).toHaveBeenCalledOnce();
  const [source, options] = runAgentDiscovery.mock.calls[0]!;
  expect(source).toBe("target_site");
  expect(options.startingUrls).toEqual([applicationUrl]);
  expect(options.requestedListing).toMatchObject({
    url: applicationUrl,
    title: boardPosting.title,
  });
  expect(options.requestedListing?.text).toContain(boardPosting.company);
  expect(result).toMatchObject({
    posting: {
      ...boardPosting,
      description,
      needsRenderedPage: false,
      listingDetailFetch: { outcome: "enriched" },
    },
    fullListingRead: true,
  });
});

it("keeps and saves the partial posting when the application page cannot be read", async () => {
  const result = await readJobFromBrowserPage(
    {
      ...aiClient,
      extractJobsFromPage: vi.fn().mockResolvedValue([boardPosting]),
    },
    {
      html: "<main>Product Designer at Example Studio</main>",
      pageUrl,
      browser: {
        runtime: {
          runAgentDiscovery: vi.fn().mockRejectedValue(new Error("Offline")),
        },
        readContext,
      },
    },
  );
  expect(result.fullListingRead).toBe(false);
  expect(result.warning).toContain("could not read the full description");
  const store = openJobStore(":memory:");
  try {
    const saved = savePageJobs(store, {
      postings: [result.posting],
      pageUrl,
      fullListingRead: result.fullListingRead,
    });
    expect(store.getJob(saved.ids[0]!)).toMatchObject({
      title: boardPosting.title,
      company: boardPosting.company,
      url: pageUrl,
      applyUrl: applicationUrl,
      facts: { fullListingRead: false },
    });
  } finally {
    store.close();
  }
});

it.each([404, 410])(
  "reports a listing taken down after HTTP %s",
  async (status) => {
    const extractJobsFromPage = vi.fn().mockResolvedValue([]);
    const readRenderedPage = vi
      .fn()
      .mockRejectedValue(new DiscoveryPageReadError(status));
    await expect(
      readJobFromBrowserPage(
        { ...aiClient, extractJobsFromPage },
        {
          html: "<main>This vacancy is unavailable</main>",
          pageUrl,
          browser: { runtime: { readRenderedPage }, readContext },
        },
      ),
    ).rejects.toThrow("This job listing has been taken down.");
    expect(extractJobsFromPage).toHaveBeenCalledOnce();
  },
);
