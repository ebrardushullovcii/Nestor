import {
  JobSearchSettingsSchema,
  type FoundJob,
  type JobChange,
} from "@nestor/contracts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createJobSitesStore,
  openJobStore,
  resetJobStore,
  seedTrackerDemo,
  type JobStore,
} from "./job-store";

function found(n: number): FoundJob {
  return {
    title: `Reset Marker Engineer ${n}`,
    company: `Company ${n}`,
    location: "Remote",
    workModes: ["remote"],
    url: `https://board.example.test/jobs/${n}`,
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
  };
}

function layout(store: JobStore) {
  return store.db
    .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
    .all();
}

function rowCounts(store: JobStore) {
  const tables = store.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' AND sql NOT LIKE 'CREATE VIRTUAL%'",
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      (
        store.db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as {
          n: number;
        }
      ).n,
    ]),
  );
}

const dirs: string[] = [];
const stores: JobStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function openFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "job-store-reset-"));
  dirs.push(dir);
  const file = path.join(dir, "job-finder.sqlite");
  const store = openJobStore(file);
  stores.push(store);
  return { file, store };
}

describe("resetJobStore", () => {
  it("leaves the store as a new file would be, and nothing removed on disk", () => {
    const fresh = openJobStore(":memory:");
    stores.push(fresh);
    const { file, store } = openFile();

    const search = store.searches.start(JobSearchSettingsSchema.parse({}), 1);
    const { added } = store.saveFoundJobs({
      searchId: search.id,
      jobs: [1, 2, 3, 4].map(found),
    });
    store.moveJobs({ selection: { ids: [added[0]!] }, to: "shortlisted" });
    seedTrackerDemo(store, [added[1]!]);
    createJobSitesStore(store).add({ text: "https://jobs.example.test/one" });
    expect(Object.values(rowCounts(store)).some((n) => n > 0)).toBe(true);

    const changes: JobChange[] = [];
    store.onChange((change) => changes.push(change));
    resetJobStore(store);

    expect(layout(store)).toEqual(layout(fresh));
    expect(rowCounts(store)).toEqual(rowCounts(fresh));
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(store.listJobs({ stage: "found" }).rows).toEqual([]);
    expect(store.searches.latest()).toBeNull();
    expect(createJobSitesStore(store).counts().all).toBe(0);
    expect(changes.map((change) => change.cause)).toEqual([
      "application",
      "sites",
    ]);
    expect(changes[0]!.ids).toBeNull();

    // Ids start over and the saved statements still work.
    expect(
      store.saveFoundJobs({ searchId: null, jobs: [found(9)] }).added,
    ).toEqual([1]);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    for (const suffix of ["", "-wal"])
      expect(
        readFileSync(`${file}${suffix}`, { flag: "a+" }).includes(
          "Reset Marker Engineer 1",
        ),
      ).toBe(false);
    const reopened = openJobStore(file);
    stores.push(reopened);
    expect(reopened.stageCounts().found).toBe(1);
  });

  it("refuses to run inside a transaction", () => {
    const { store } = openFile();
    expect(() => store.transaction(() => resetJobStore(store))).toThrow(
      "inside a transaction",
    );
  });
});
