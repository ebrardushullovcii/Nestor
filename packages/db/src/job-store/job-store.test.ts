import type { FoundJob, JobChange } from "@nestor/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openJobStore, type JobStore } from "./job-store";

function found(n: number, overrides: Partial<FoundJob> = {}): FoundJob {
  return {
    title: `Frontend Engineer ${n}`,
    company: `Company ${n % 7}`,
    location: n % 2 ? "Remote" : "Berlin, Germany",
    workModes: n % 2 ? ["remote"] : ["onsite"],
    url: `https://board.example.test/jobs/${n}?utm_source=x`,
    applyUrl: null,
    sourceId: "board",
    sourceLabel: "Example Board",
    sourceJobId: String(n),
    postedAt: "2026-10-20T00:00:00.000Z",
    salaryText: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    seniority: null,
    employmentType: null,
    summary: null,
    description: `Listing ${n}`,
    ...overrides,
  };
}

const stores: JobStore[] = [];
function open(): JobStore {
  const store = openJobStore(":memory:");
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("job store", () => {
  it("recognizes saved listing aliases and hidden jobs before another search reads them", () => {
    const store = open();
    const first = found(1);
    const { added } = store.saveFoundJobs({ searchId: "first", jobs: [first] });
    const alias = found(1, {
      url: "https://other.example.test/jobs/abc",
      sourceId: "other",
      sourceJobId: "abc",
    });
    store.saveFoundJobs({ searchId: "second", jobs: [alias] });
    store.setStage(added, "hidden");
    const tracked = `${alias.url}?utm_campaign=repeat`;
    const fresh = "https://other.example.test/jobs/new";
    expect(store.findKnownUrls([first.url, tracked, fresh, first.url])).toEqual(
      [first.url, tracked],
    );
    expect(store.findKnownUrls([])).toEqual([]);
  });

  it("adds only new jobs when a search runs again and merges a job listed on two sites", () => {
    const store = open();
    const first = store.saveFoundJobs({
      searchId: "s1",
      jobs: [found(1), found(2), found(3)],
    });
    expect(first.added).toHaveLength(3);

    const again = store.saveFoundJobs({
      searchId: "s2",
      jobs: [
        found(1, { url: "https://board.example.test/jobs/1/" }),
        found(2),
        found(4),
        // The same job on another site: same title, employer and place.
        found(3, {
          url: "https://other.example.test/postings/abc",
          sourceId: "other",
          sourceLabel: "Other Board",
          sourceJobId: "abc",
          description: "Listing 3, with the longer text the other site shows.",
        }),
      ],
    });
    expect(again.added).toHaveLength(1);
    expect(again.merged).toHaveLength(3);
    expect(store.stageCounts().found).toBe(4);

    const merged = store.getJob(first.added[2]!);
    expect(merged?.sourceCount).toBe(2);
    expect(merged?.sightings.map((s) => s.sourceLabel)).toEqual([
      "Example Board",
      "Other Board",
    ]);
    expect(merged?.description).toContain("longer text");
    expect(merged?.searchId).toBe("s1");
  });

  it("saves a job the search did not keep as hidden, with its reason, and knows its link", () => {
    const store = open();
    const result = store.saveFoundJobs({
      searchId: "s1",
      jobs: [found(1), found(2, { hiddenReason: "Asks for a pilot licence" })],
    });
    expect(result.added).toHaveLength(1);
    expect(result.hidden).toHaveLength(1);
    const hidden = store.listJobs({ stage: "hidden" }).rows[0];
    expect(hidden?.stageNote).toBe("Asks for a pilot licence");
    expect(
      store.findKnownUrls([
        "https://board.example.test/jobs/2/",
        "https://board.example.test/jobs/9",
      ]),
    ).toEqual(["https://board.example.test/jobs/2/"]);
    // Showing it again clears the reason; Undo brings it back.
    const shown = store.moveJobs({
      selection: { ids: result.hidden },
      to: "found",
    });
    expect(store.getJob(result.hidden[0]!)?.stageNote).toBe(null);
    store.undoMove(shown.moveId!);
    expect(store.getJob(result.hidden[0]!)?.stageNote).toBe(
      "Asks for a pilot licence",
    );
  });

  it("keeps two openings with the same title on one site apart", () => {
    const store = open();
    const result = store.saveFoundJobs({
      searchId: null,
      jobs: [
        found(1, { title: "Designer", company: "Acme", location: "Remote" }),
        found(2, { title: "Designer", company: "Acme", location: "Remote" }),
      ],
    });
    expect(result.added).toHaveLength(2);
  });

  it("never brings a hidden job back, and Undo puts each job where it was", () => {
    const store = open();
    const { added } = store.saveFoundJobs({
      searchId: "s1",
      jobs: [found(1), found(2), found(3), found(4)],
    });
    const [a, b, c, d] = added as [number, number, number, number];

    store.moveJobs({ selection: { ids: [a] }, to: "shortlisted" });
    const hide = store.moveJobs({
      selection: {
        filter: {
          stage: "found",
          searchId: null,
          minFit: null,
          text: "",
          workModes: [],
        },
        except: [d],
      },
      to: "hidden",
    });
    expect(hide.moved).toBe(2);
    expect(hide.counts).toMatchObject({ found: 1, hidden: 2, shortlisted: 1 });

    // A repeat search sees the hidden jobs again and leaves them hidden.
    const again = store.saveFoundJobs({
      searchId: "s2",
      jobs: [found(2), found(3)],
    });
    expect(again.added).toEqual([]);
    expect(store.stageCounts().hidden).toBe(2);

    const undone = store.undoMove(hide.moveId!);
    expect(undone.moved).toBe(2);
    expect(undone.counts).toMatchObject({
      found: 3,
      hidden: 0,
      shortlisted: 1,
    });
    expect(store.getJob(b)?.stage).toBe("found");
    expect(store.getJob(c)?.stage).toBe("found");

    // Moving back out of Shortlisted is one more move.
    store.moveJobs({ selection: { ids: [a] }, to: "found" });
    expect(store.stageCounts()).toMatchObject({ found: 4, shortlisted: 0 });
  });

  it("pages through a stage in fit order with filters and counts", () => {
    const store = open();
    const { added } = store.saveFoundJobs({
      searchId: "s1",
      jobs: Array.from({ length: 25 }, (_, i) => found(i + 1)),
    });
    store.setFit(
      added.slice(0, 10).map((id, i) => ({
        id,
        score: 50 + i,
        summary: `Fit ${i}`,
        reasons: [],
        gaps: [],
      })),
    );

    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const page = store.listJobs({ stage: "found", limit: 7, cursor });
      expect(page.total).toBe(25);
      seen.push(...page.rows.map((row) => row.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(25);
    expect(seen[0]).toBe(added[9]);

    // A fit floor keeps jobs not scored yet, below the scored ones.
    const strong = store.listJobs({ stage: "found", minFit: 55, limit: 6 });
    expect(strong.rows.map((row) => row.fitScore)).toEqual([
      59,
      58,
      57,
      56,
      55,
      null,
    ]);
    expect(strong.total).toBe(20);

    const remote = store.listJobs({ stage: "found", workModes: ["remote"] });
    expect(remote.total).toBe(13);
    const text = store.listJobs({ stage: "found", text: "engineer 12" });
    expect(text.rows.map((row) => row.title)).toEqual(["Frontend Engineer 12"]);
  });

  it("counts a whole stage exactly and caps only filtered counts", () => {
    const store = open();
    store.saveFoundJobs({
      searchId: null,
      jobs: Array.from({ length: 1005 }, (_, i) => found(i + 1)),
    });
    expect(store.listJobs({ stage: "found" })).toMatchObject({
      total: 1005,
      totalCapped: false,
    });
    expect(store.listJobs({ stage: "found", text: "frontend" })).toMatchObject({
      total: 1000,
      totalCapped: true,
    });
  });

  it("tells listeners which stages changed", () => {
    const store = open();
    const changes: JobChange[] = [];
    store.onChange((change) => changes.push(change));
    const { added } = store.saveFoundJobs({ searchId: "s1", jobs: [found(1)] });
    store.moveJobs({ selection: { ids: added }, to: "hidden" });
    expect(changes.map((c) => [c.cause, c.stages.sort()])).toEqual([
      ["found", ["found"]],
      ["move", ["found", "hidden"]],
    ]);
  });

  it("keeps a search's counts and marks one cut off by a restart as stopped", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-store-"));
    const file = path.join(dir, "jobs.sqlite");
    try {
      const store = openJobStore(file);
      const search = store.searches.start(
        {
          depth: "quick",
          sourceIds: "all",
          picky: "balanced",
          postedWithin: "month",
          note: "",
        },
        3,
      );
      store.searches.count(search.id, { found: 5, added: 4, merged: 1 });
      store.searches.count(search.id, { sourcesDone: 1, added: 2 });
      expect(store.searches.latest()).toMatchObject({
        state: "running",
        sourcesTotal: 3,
        sourcesDone: 1,
        found: 5,
        added: 6,
        merged: 1,
      });
      store.close();
      const reopened = openJobStore(file);
      expect(reopened.searches.get(search.id)?.state).toBe("stopped");
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts a file from another store version over", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-store-"));
    const file = path.join(dir, "jobs.sqlite");
    try {
      const old = new DatabaseSync(file);
      old.exec("CREATE TABLE saved_jobs (id TEXT); PRAGMA user_version = 99;");
      old.close();
      const store = openJobStore(file);
      store.saveFoundJobs({ searchId: null, jobs: [found(1)] });
      expect(store.stageCounts().found).toBe(1);
      store.close();
      const reopened = openJobStore(file);
      expect(reopened.stageCounts().found).toBe(1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
