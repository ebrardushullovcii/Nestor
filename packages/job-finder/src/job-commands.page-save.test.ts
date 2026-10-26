import { JobPostingSchema } from "@nestor/contracts";
import { openJobStore, type JobStore } from "@nestor/db/job-store";
import { afterEach, expect, it } from "vitest";

import { savePageJobs } from "./job-commands";
import { createSeed } from "./workspace-service.test-support";

const stores: JobStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function open() {
  const store = openJobStore(":memory:");
  stores.push(store);
  return store;
}

const posting = (n: number, overrides: Record<string, unknown> = {}) =>
  JobPostingSchema.parse({
    ...createSeed().savedJobs[0],
    id: `p${n}`,
    sourceJobId: `REQ-${n}`,
    canonicalUrl: `https://careers.example.test/jobs/${n}`,
    applicationUrl: `https://careers.example.test/jobs/${n}/apply`,
    title: `Designer ${n}`,
    company: `Company ${n}`,
    ...overrides,
  });

it("keys page postings by their source id and saves more than fifty at once", () => {
  const store = open();
  const pageUrl = "https://careers.example.test/jobs";
  const first = savePageJobs(store, {
    postings: Array.from({ length: 60 }, (_, i) => posting(i)),
    pageUrl,
  });
  expect(first.added).toHaveLength(60);
  // The same requisition under a new address is the same job.
  const again = savePageJobs(store, {
    postings: [
      posting(3, { canonicalUrl: "https://careers.example.test/r/xyz" }),
    ],
    pageUrl,
  });
  expect(again.added).toEqual([]);
  expect(again.ids).toEqual([first.ids[3]]);
});

it("applies on this page when the person picks Apply on this link", () => {
  const store = open();
  const [saved] = store.saveFoundJobs({
    searchId: null,
    jobs: [
      {
        title: "Designer 1",
        company: "Company 1",
        location: "Remote",
        workModes: ["remote"],
        url: "https://board.example.test/jobs/1",
        applyUrl: "https://board.example.test/jobs/1/apply",
        sourceId: "board",
        sourceLabel: "Board",
        sourceJobId: null,
        postedAt: null,
        salaryText: null,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        seniority: null,
        employmentType: null,
        summary: null,
        description: "Listing",
      },
    ],
  }).ids;
  // The same job, now open on the employer's own site.
  const here = posting(1, {
    canonicalUrl: "https://board.example.test/jobs/1",
    applicationUrl: "https://employer.example.test/apply/1",
  });
  const result = savePageJobs(store, {
    postings: [here],
    pageUrl: "https://employer.example.test/apply/1",
    applyOnThisPage: true,
  });
  expect(result.ids).toEqual([saved]);
  expect(store.getJob(saved!)?.applyUrl).toBe(
    "https://employer.example.test/apply/1",
  );
});
