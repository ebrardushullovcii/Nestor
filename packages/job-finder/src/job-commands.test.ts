import type { JobSearchStatus } from "@nestor/contracts";
import { openJobStore } from "@nestor/db/job-store";
import { afterEach, describe, expect, it } from "vitest";

import { createJobCommandRunner, type JobSearchControl } from "./job-commands";

const store = openJobStore(":memory:");
afterEach(() => {
  store.db.exec("DELETE FROM jobs; DELETE FROM searches;");
});

function job(n: number) {
  return {
    title: `Designer ${n}`,
    company: "Acme",
    location: "Remote",
    workModes: [],
    url: `https://jobs.example.test/${n}`,
    applyUrl: null,
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
    description: `Listing ${n}`,
  };
}

describe("job commands", () => {
  it("shortlists and undoes through the same commands the chat uses", async () => {
    const run = createJobCommandRunner({
      store,
      search: () => Promise.reject(new Error("no search in this test")),
      currentSearch: () => null,
      listSites: () => Promise.resolve([]),
    });
    const { added } = store.saveFoundJobs({
      searchId: null,
      jobs: [job(1), job(2)],
    });
    const moved = await run("move_jobs", {
      selection: { ids: [added[0]] },
      to: "shortlisted",
    });
    expect(moved.counts).toMatchObject({ found: 1, shortlisted: 1 });
    const page = await run("list_jobs", { stage: "shortlisted" });
    expect(page.rows.map((row) => row.title)).toEqual(["Designer 1"]);
    const undone = await run("undo_move", { moveId: moved.moveId });
    expect(undone.counts).toMatchObject({ found: 2, shortlisted: 0 });
  });

  it("refuses bad input and unknown commands", async () => {
    const run = createJobCommandRunner({
      store,
      search: () => Promise.reject(new Error("no search in this test")),
      currentSearch: () => null,
      listSites: () => Promise.resolve([]),
    });
    await expect(run("move_jobs", { to: "applied" })).rejects.toThrow();
    await expect(
      run("delete_everything" as "stage_counts", {}),
    ).rejects.toThrow(/no job command/u);
  });

  it("starts a search with the chosen settings and reports it", async () => {
    let started: unknown = null;
    const status: JobSearchStatus = { search: null, sources: [] };
    const search: JobSearchControl = {
      start: (settings) => {
        started = settings;
        return Promise.resolve();
      },
      stop: () => undefined,
      status: () => status,
      scoreUnscored: () => Promise.resolve(0),
    };
    const run = createJobCommandRunner({
      store,
      search: () => Promise.resolve(search),
      currentSearch: () => search,
      listSites: () => Promise.resolve([]),
    });
    await run("start_search", { depth: "thorough", picky: "strict" });
    expect(started).toMatchObject({
      depth: "thorough",
      picky: "strict",
      postedWithin: "month",
      sourceIds: "all",
    });
  });
});
