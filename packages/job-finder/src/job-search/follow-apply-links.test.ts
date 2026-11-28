import {
  DiscoveryPageReadError,
  type FoundJob,
  type ReadDiscoveryPostingPage,
} from "@nestor/contracts";
import { expect, it, vi } from "vitest";
import { followBoardApplyLinks } from "./follow-apply-links";

function listing(url: string, applyUrl: string | null): FoundJob {
  return {
    title: "Senior Product Engineer",
    company: "n8n",
    location: "Europe",
    workModes: ["remote"],
    url,
    applyUrl,
    sourceId: "nomads",
    sourceLabel: "Nomads",
    sourceJobId: null,
    postedAt: null,
    salaryText: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    seniority: null,
    employmentType: null,
    summary: null,
    description: "Build the workflow editor.",
    facts: { fullListingRead: true },
  };
}

it("stores the employer page a board's own apply link redirects to, following each link once", async () => {
  const landings: Record<string, string> = {
    "https://www.nomads.test/job/go/2033454/":
      "https://jobs.ashby.test/n8n/896c58a8",
    "https://www.nomads.test/job/go/1950011/":
      "https://www.nomads.test/remote-development-jobs",
  };
  const readPage = vi.fn<ReadDiscoveryPostingPage>((url, options) => {
    expect(options.landingOnly).toBe(true);
    const finalUrl = landings[url];
    return finalUrl
      ? Promise.resolve({ html: "", finalUrl })
      : Promise.reject(new DiscoveryPageReadError(403));
  });
  const jobs = [
    listing(
      "https://www.nomads.test/jobs/n8n-2033454",
      "https://www.nomads.test/job/go/2033454/",
    ),
    // Two listings with one board link make one request.
    listing(
      "https://nomads.test/jobs/n8n-2033454-copy",
      "https://www.nomads.test/job/go/2033454/",
    ),
    listing(
      "https://www.nomads.test/jobs/n8n-1950011",
      "https://www.nomads.test/job/go/1950011/",
    ),
    listing(
      "https://www.nomads.test/jobs/n8n-3000000",
      "https://www.nomads.test/job/go/3000000/",
    ),
    listing(
      "https://www.nomads.test/jobs/n8n-4000000",
      "https://jobs.lever.test/n8n/4000000",
    ),
    listing("https://www.nomads.test/jobs/n8n-5000000", null),
  ];
  const result = await followBoardApplyLinks(
    { jobs, failures: [] },
    readPage,
    undefined,
  );
  expect(readPage).toHaveBeenCalledTimes(3);
  expect(
    result.jobs.map((job) => [job.applyUrl, job.facts?.applyLinkFollowedUrl]),
  ).toEqual([
    [
      "https://jobs.ashby.test/n8n/896c58a8",
      "https://www.nomads.test/job/go/2033454/",
    ],
    [
      "https://jobs.ashby.test/n8n/896c58a8",
      "https://www.nomads.test/job/go/2033454/",
    ],
    // A link that stays on the board is kept, and not followed again.
    [
      "https://www.nomads.test/job/go/1950011/",
      "https://www.nomads.test/job/go/1950011/",
    ],
    // Not answered: the next search follows it again.
    ["https://www.nomads.test/job/go/3000000/", null],
    // Already the employer's form, or no link at all.
    ["https://jobs.lever.test/n8n/4000000", undefined],
    [null, undefined],
  ]);
  expect(result.jobs[0]?.facts?.fullListingRead).toBe(true);
  expect(result.jobs[3]?.facts?.fullListingRead).toBe(true);
});
