// @vitest-environment jsdom

import type { FoundJob, JobListQueryInput } from "@nestor/contracts";
import { openJobStore, type JobStore } from "@nestor/db/job-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { searchSavedJobs } from "./build-job-finder-global-search-entries";

let store: JobStore;

function job(n: number, title: string, company: string): FoundJob {
  return {
    title,
    company,
    location: "Remote",
    workModes: ["remote"],
    url: `https://board.example.test/jobs/${n}`,
    applyUrl: null,
    sourceId: "board",
    sourceLabel: "Example Board",
    sourceJobId: String(n),
    postedAt: null,
    salaryText: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    seniority: null,
    employmentType: null,
    summary: null,
    description: `Listing ${n}`,
  };
}

beforeEach(() => {
  store = openJobStore(":memory:");
  const run = (name: string, input: JobListQueryInput) => {
    if (name === "list_jobs") return Promise.resolve(store.listJobs(input));
    return Promise.reject(new Error(`${name} is not stubbed`));
  };
  Object.assign(window, { nestor: { jobs: { run } } });
});

afterEach(() => store.close());

describe("searchSavedJobs", () => {
  it("finds saved jobs in every stage and opens each on the screen that lists it", async () => {
    const { added } = store.saveFoundJobs({
      searchId: null,
      jobs: [
        job(1, "Supply Chain Analyst", "Spool"),
        job(2, "Supply Planner", "Crate"),
        job(3, "Data Analyst", "Ledger"),
        job(4, "Analyst, Logistics", "Freight"),
        job(5, "Frontend Engineer", "Pixel"),
      ],
    });
    store.setStage([added[1]!], "shortlisted");
    store.setStage([added[2]!], "applied");
    store.setStage([added[3]!], "hidden");

    const entries = await searchSavedJobs("analyst");

    expect(
      entries.map((entry) => [entry.title, entry.kind, entry.href]),
    ).toEqual([
      ["Supply Chain Analyst", "job", `/job-finder/discovery?job=${added[0]}`],
      [
        "Data Analyst",
        "application",
        `/job-finder/applications?jobId=${added[2]}`,
      ],
      ["Analyst, Logistics", "job", `/job-finder/discovery?job=${added[3]}`],
    ]);
    expect(entries[0]?.subtitle).toBe("Spool · Remote · Found");
    expect(entries[2]?.subtitle).toBe("Freight · Remote · Hidden");

    const [shortlisted] = await searchSavedJobs("crate");
    expect(shortlisted?.href).toBe(
      `/job-finder/review-queue?jobId=${added[1]}`,
    );
    expect(await searchSavedJobs("nothing here")).toEqual([]);
  });
});
