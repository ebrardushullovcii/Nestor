import { JobPostingSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { readPostingDetail } from "./read-posting-detail";
import type { JobExtractor } from "../agent/contracts";

const posting = JobPostingSchema.parse({
  source: "target_site",
  sourceJobId: "opening",
  canonicalUrl: "https://jobs.example.test/jobs/one",
  title: "Backend Engineer",
  company: "Willow House",
  location: "Remote",
  workMode: ["remote"],
  applyPath: "unknown",
  easyApplyEligible: false,
  salaryText: null,
  description: "A brief card.",
  discoveredAt: "2026-10-25T08:00:00Z",
});

test("published full listing text reaches the result without an extraction call or a second read", async () => {
  const description = `${"Build reliable APIs and operate production services. ".repeat(600)}Final requirement: distributed systems experience.`;
  const readPage = vi.fn(() =>
    Promise.resolve({
      finalUrl: posting.canonicalUrl,
      html: `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: posting.title, hiringOrganization: { name: posting.company }, description })}</script>`,
    }),
  );
  const extractJobsFromPage = vi.fn(() => Promise.resolve([]));
  const full = await readPostingDetail({
    posting,
    readPage,
    extractor: { extractJobsFromPage },
  });
  expect(full.description).toBe(description);
  expect(full.description).toContain(
    "Final requirement: distributed systems experience.",
  );
  expect(full.listingDetailFetch?.outcome).toBe("enriched");
  expect(
    await readPostingDetail({
      posting: full,
      readPage,
      extractor: { extractJobsFromPage },
    }),
  ).toBe(full);
  expect(readPage).toHaveBeenCalledTimes(1);
  expect(extractJobsFromPage).not.toHaveBeenCalled();
});

test("the model reads plain listing text with the card's employer and returns the whole body", async () => {
  const description =
    "Build APIs. Own on-call. Required: SQL. Benefits: flexible hours.";
  let requestedText = "";
  const extractJobsFromPage = vi.fn(
    (input: Parameters<JobExtractor["extractJobsFromPage"]>[0]) => {
      requestedText = input.pageText;
      return Promise.resolve([{ ...posting, description }]);
    },
  );
  const full = await readPostingDetail({
    posting,
    readPage: () =>
      Promise.resolve({
        html: `<title>Board brand</title><h1>Backend Engineer</h1><p>${description}</p>`,
        finalUrl: posting.canonicalUrl,
      }),
    extractor: { extractJobsFromPage },
  });
  expect(full.description).toBe(description);
  expect(full.company).toBe("Willow House");
  expect(extractJobsFromPage).toHaveBeenCalledTimes(1);
  expect(requestedText).toContain('"company":"Willow House"');
});

test("a failed full read cannot masquerade as a complete description", async () => {
  const full = await readPostingDetail({
    posting,
    readPage: () => Promise.reject(new Error("Site unavailable")),
    extractor: { extractJobsFromPage: () => Promise.resolve([]) },
  });
  expect(full.description).toBe("");
  expect(full.summary).toBe(posting.description);
  expect(full.listingDetailFetch?.outcome).toBe("fetch_failed");
});
