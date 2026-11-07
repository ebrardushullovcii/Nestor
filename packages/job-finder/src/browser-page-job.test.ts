import { expect, it, vi } from "vitest";
import { readJobFromBrowserPage } from "./browser-page-job";
import { createSeed } from "./test-fixtures";
import type { JobFinderAiClient } from "@nestor/ai-providers";
import { openJobStore } from "@nestor/db/job-store";
import { savePageJobs } from "./job-commands";

it("Add to Find jobs reads rendered DOM facts after an invalid empty-description extraction", async () => {
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
    { extractJobsFromPage },
    {
      html: "<main>Loading</main>",
      pageUrl: "https://replica.test/job",
      readRenderedPage,
    },
  );
  expect(result).toBe(posting);
  expect(readRenderedPage).toHaveBeenCalledOnce();
  expect(extractJobsFromPage.mock.calls[1]?.[0].pageText).toContain(body);
  const store = openJobStore(":memory:");
  try {
    const saved = savePageJobs(store, {
      postings: [result],
      pageUrl: "https://replica.test/job",
      fullListingRead: true,
    });
    const row = store.getJob(saved.ids[0]!)!;
    expect(row.description).toBe(body);
    expect(row.facts.fullListingRead).toBe(true);
    expect(row.facts.keySkills).toEqual(result.keySkills);
  } finally {
    store.close();
  }
});
