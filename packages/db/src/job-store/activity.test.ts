import { JobSearchSettingsSchema, type FoundJob } from "@nestor/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createActivityStore } from "./activity";
import { openJobStore, type JobStore } from "./job-store";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const HOUR = 3_600_000;

let store: JobStore;
let ids: number[];

function job(n: number): FoundJob {
  return {
    title: `Analyst ${n}`,
    company: `Spool ${n}`,
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

function resume(jobId: number, state: string, at: number) {
  store
    .sql(
      "INSERT INTO resumes (job_id, level, state, updated_at) VALUES (?, 'tailored', ?, ?)",
    )
    .run(jobId, state, at);
}

function application(jobId: number, state: string, at: number) {
  store
    .sql(
      `INSERT INTO applications (job_id, mode, state, queued_at, updated_at)
       VALUES (?, 'confirm_before_submit', ?, ?, ?)`,
    )
    .run(jobId, state, at, at);
}

beforeEach(() => {
  store = openJobStore(":memory:");
  ({ added: ids } = store.saveFoundJobs({
    searchId: null,
    jobs: Array.from({ length: 9 }, (_, n) => job(n + 1)),
  }));
});

afterEach(() => store.close());

describe("activity feed", () => {
  it("lists running work and what finished in the last day, leaving waiting-on-you to Needs you", () => {
    resume(ids[0]!, "writing", NOW - HOUR);
    resume(ids[1]!, "ready", NOW - 2 * HOUR);
    resume(ids[2]!, "ready", NOW - 30 * HOUR);
    application(ids[3]!, "running", NOW - HOUR);
    application(ids[4]!, "needs_you", NOW - HOUR);
    application(ids[5]!, "submitted", NOW - 3 * HOUR);
    application(ids[6]!, "failed", NOW - 26 * HOUR);
    const search = store.searches.start(JobSearchSettingsSchema.parse({}), 4);

    const feed = createActivityStore(store).feed(NOW);

    expect(feed.searches.map((row) => [row.id, row.state])).toEqual([
      [search.id, "running"],
    ]);
    expect(feed.resumes.map((row) => [row.jobId, row.state])).toEqual([
      [ids[0], "writing"],
      [ids[1], "ready"],
    ]);
    expect(feed.resumes[0]?.title).toBe("Analyst 1");
    expect(feed.resumes[0]?.stage).toBe("found");
    expect(feed.applications.map((row) => [row.jobId, row.state])).toEqual([
      [ids[3], "running"],
      [ids[5], "submitted"],
    ]);
    expect(feed.running).toBe(3);
  });

  it("lists the person's moves of the day, and how many jobs each still holds", () => {
    const shortlist = store.moveJobs({
      selection: { ids: [ids[0]!, ids[1]!] },
      to: "shortlisted",
    });
    const hide = store.moveJobs({
      selection: { ids: [ids[2]!] },
      to: "hidden",
    });
    // Something else moved one shortlisted job on since.
    store.setStage([ids[1]!], "applied");

    const moves = createActivityStore(store).feed().moves;

    expect(
      moves.map((move) => [move.id, move.to, move.count, move.stillThere]),
    ).toEqual([
      [hide.moveId, "hidden", 1, 1],
      [shortlist.moveId, "shortlisted", 2, 1],
    ]);
    expect(moves[1]).toMatchObject({
      from: ["found"],
      title: "Analyst 1",
      company: "Spool 1",
    });

    store.undoMove(hide.moveId!);
    expect(
      createActivityStore(store)
        .feed()
        .moves.map((move) => move.id),
    ).toEqual([shortlist.moveId]);
  });

  it("keeps a finished search for a day", () => {
    const search = store.searches.start(JobSearchSettingsSchema.parse({}), 2);
    store.searches.finish(search.id, "done");
    const finishedAt = Date.now();
    const activity = createActivityStore(store);
    expect(activity.feed(finishedAt + HOUR).searches[0]?.state).toBe("done");
    expect(activity.feed(finishedAt + 25 * HOUR).searches).toEqual([]);
    expect(activity.feed(finishedAt + HOUR).running).toBe(0);
  });
});
