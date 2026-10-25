import { openJobStore } from "@nestor/db/job-store";
import { afterEach, describe, expect, it } from "vitest";

import { createJobCommandRunner } from "./job-commands";

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
    const run = createJobCommandRunner({ store });
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
    const run = createJobCommandRunner({ store });
    await expect(run("move_jobs", { to: "applied" })).rejects.toThrow();
    await expect(
      run("delete_everything" as "stage_counts", {}),
    ).rejects.toThrow(/no job command/u);
  });
});
