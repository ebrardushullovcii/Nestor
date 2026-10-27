import {
  JobListQuerySchema,
  type FoundJob,
  type JobChange,
  type WorkMode,
} from "@nestor/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createApplicationStore } from "./applications";
import {
  belowFloorSql,
  jobCountSql,
  jobPageSql,
  toWorkModeMask,
} from "./job-list";
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
  it("tells where a job was first seen and why it sits in its stage, as getJob does", () => {
    const store = open();
    const { added } = store.saveFoundJobs({
      searchId: "first",
      jobs: [
        found(1),
        found(2, { hiddenReason: "Closed: applications ended" }),
      ],
    });
    store.saveFoundJobs({
      searchId: "second",
      jobs: [
        found(1, {
          url: "https://other.example.test/jobs/1",
          sourceId: "other",
        }),
      ],
    });
    const origins = store.jobOrigins([...added, 999]);
    for (const id of added) {
      const job = store.getJob(id)!;
      expect(origins.get(id)).toEqual({
        sourceId: job.sightings[0]?.sourceId ?? null,
        stageNote: job.stageNote ?? null,
      });
    }
    expect(origins.has(999)).toBe(false);
  });

  it("gives its page cache back without losing anything", () => {
    const store = open();
    const { added } = store.saveFoundJobs({ searchId: "s", jobs: [found(1)] });
    store.releaseMemory();
    expect(store.getJob(added[0]!)?.title).toBe("Frontend Engineer 1");
  });

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

  it("moves an approved job back to Find jobs, and Undo makes it approved again", () => {
    const store = open();
    const { added } = store.saveFoundJobs({
      searchId: "s1",
      jobs: [found(1), found(2)],
    });
    const [a, b] = added as [number, number];
    store.setStage([a, b], "resume");
    for (const id of [a, b])
      store
        .sql(
          `INSERT INTO resumes (job_id, level, state, updated_at, approved_at, pdf_path)
           VALUES (?, 'tailored', 'ready', 1, 1, ?)`,
        )
        .run(id, `C:/generated/${id}/resume.pdf`);
    // Apply had started on b and was stopped.
    store
      .sql(
        `INSERT INTO applications (job_id, mode, state, queued_at, updated_at)
         VALUES (?, 'confirm_before_submit', 'stopped', 1, 1)`,
      )
      .run(b);
    const approval = (id: number) =>
      store
        .sql("SELECT approved_at, pdf_path FROM resumes WHERE job_id = ?")
        .get(id) as { approved_at: number | null; pdf_path: string | null };

    const back = store.moveJobs({ selection: { ids: [a, b] }, to: "found" });
    expect(back.moved).toBe(2);
    expect(back.counts).toMatchObject({ found: 2, resume: 0 });

    store.undoMove(back.moveId!);
    expect(store.getJob(a)?.stage).toBe("resume");
    expect(store.getJob(b)?.stage).toBe("resume");
    expect(approval(a)).toEqual({
      approved_at: 1,
      pdf_path: `C:/generated/${a}/resume.pdf`,
    });

    // Back in Find jobs and shortlisted again, the resume waits for review.
    store.moveJobs({ selection: { ids: [a] }, to: "found" });
    store.moveJobs({ selection: { ids: [a] }, to: "shortlisted" });
    expect(approval(a)).toEqual({ approved_at: null, pdf_path: null });
  });

  it("leaves a job that moved on since a move where it is when that move is undone", () => {
    const store = open();
    const { added } = store.saveFoundJobs({
      searchId: "s1",
      jobs: [found(1), found(2), found(3)],
    });
    const [approved, hidden, other] = added as [number, number, number];
    store.setStage([approved], "resume");
    store
      .sql(
        `INSERT INTO resumes (job_id, level, state, updated_at, approved_at, pdf_path)
         VALUES (?, 'tailored', 'ready', 1, 1, 'C:/generated/resume.pdf')`,
      )
      .run(approved);

    // Approved, back to Find jobs (A), shortlisted again, which clears the
    // approval, and back to Find jobs (C). Undoing A must not make it
    // approved again without an approval.
    const a = store.moveJobs({ selection: { ids: [approved] }, to: "found" });
    store.moveJobs({ selection: { ids: [approved] }, to: "shortlisted" });
    store.moveJobs({ selection: { ids: [approved] }, to: "found" });
    expect(store.undoMove(a.moveId!).moved).toBe(0);
    expect(store.getJob(approved)?.stage).toBe("found");

    // Hidden, shown, hidden again: undoing the first hide changes nothing.
    const firstHide = store.moveJobs({
      selection: { ids: [hidden, other] },
      to: "hidden",
    });
    store.moveJobs({ selection: { ids: [hidden] }, to: "found" });
    store.moveJobs({ selection: { ids: [hidden] }, to: "hidden" });
    const undone = store.undoMove(firstHide.moveId!);
    expect(undone.moved).toBe(1);
    expect(store.getJob(hidden)?.stage).toBe("hidden");
    expect(store.getJob(other)?.stage).toBe("found");
  });

  it("never undoes a job back into Approved without its approval", () => {
    const store = open();
    const { added } = store.saveFoundJobs({ searchId: "s1", jobs: [found(1)] });
    const [id] = added as [number];
    store.setStage([id], "resume");
    store
      .sql(
        `INSERT INTO resumes (job_id, level, state, updated_at, approved_at, pdf_path)
         VALUES (?, 'tailored', 'ready', 1, 1, 'C:/generated/resume.pdf')`,
      )
      .run(id);

    // Approved, back to Find jobs (A), shortlisted again, which clears the
    // approval (B), back to Find jobs (C); then Undo C, B and A in order.
    const a = store.moveJobs({ selection: { ids: [id] }, to: "found" });
    const b = store.moveJobs({ selection: { ids: [id] }, to: "shortlisted" });
    const c = store.moveJobs({ selection: { ids: [id] }, to: "found" });
    expect(store.undoMove(c.moveId!).moved).toBe(1);
    expect(store.undoMove(b.moveId!).moved).toBe(1);
    expect(store.undoMove(a.moveId!).moved).toBe(0);

    expect(store.getJob(id)?.stage).toBe("found");
    expect(
      createApplicationStore(store).applyJobs({ selection: { ids: [id] } }),
    ).toEqual({ queued: 0, unchanged: 0, notApproved: 1 });
  });

  it("undoes a move again once a later move of its jobs is undone", () => {
    const store = open();
    const { added } = store.saveFoundJobs({ searchId: "s1", jobs: [found(1)] });
    const [id] = added as [number];
    const hide = store.moveJobs({ selection: { ids: [id] }, to: "hidden" });
    const show = store.moveJobs({ selection: { ids: [id] }, to: "found" });
    store.undoMove(show.moveId!);
    expect(store.undoMove(hide.moveId!).moved).toBe(1);
    expect(store.getJob(id)?.stage).toBe("found");
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
    // Select all asks for the exact number past the cap.
    expect(store.countJobs({ stage: "found", text: "frontend" })).toBe(1005);
    expect(store.countJobs({ stage: "found" })).toBe(1005);
    expect(store.countJobs({ stage: "hidden", text: "frontend" })).toBe(0);
  });

  it("counts the scored jobs under a fit floor with the rest of the filter", () => {
    const store = open();
    const { added } = store.saveFoundJobs({
      searchId: null,
      jobs: Array.from({ length: 12 }, (_, i) =>
        found(i + 1, i < 6 ? {} : { title: `Data Analyst ${i + 1}` }),
      ),
    });
    // Scores 10, 20, … 110 capped at 100; the last two stay unscored.
    store.setFit(
      added.slice(0, 10).map((id, i) => ({
        id,
        score: Math.min(100, (i + 1) * 10),
        summary: "",
        reasons: [],
        gaps: [],
      })),
    );
    expect(store.listJobs({ stage: "found" })).toMatchObject({
      belowFloor: null,
      belowFloorCapped: false,
    });
    // 10–50 sit under 60; unscored jobs are not below it.
    expect(store.listJobs({ stage: "found", minFit: 60 }).belowFloor).toBe(5);
    // The text filter applies: only the engineers (10–60) count.
    expect(
      store.listJobs({ stage: "found", minFit: 60, text: "engineer" })
        .belowFloor,
    ).toBe(5);
    expect(
      store.listJobs({ stage: "found", minFit: 60, text: "analyst" })
        .belowFloor,
    ).toBe(0);
    expect(
      store.listJobs({ stage: "found", minFit: 60, workModes: ["remote"] })
        .belowFloor,
    ).toBe(3);
  });

  it("pages a fit floor and work modes in every order, below and past the count cap", () => {
    const store = open();
    const modes = [["remote"], ["hybrid"], ["remote", "hybrid"], ["onsite"]];
    const { added } = store.saveFoundJobs({
      searchId: null,
      jobs: Array.from({ length: 1010 }, (_, i) =>
        found(i + 1, {
          workModes: modes[i % 4] as FoundJob["workModes"],
          postedAt: new Date(Date.UTC(2026, 8, 1 + (i % 40))).toISOString(),
        }),
      ),
    });
    // Every seventh job stays unscored.
    store.setFit(
      added
        .filter((_, i) => i % 7 !== 0)
        .map((id, i) => ({
          id,
          score: 30 + (i % 70),
          summary: `Fit ${i}`,
          reasons: [],
          gaps: [],
        })),
    );
    const rows = store
      .sql(
        "SELECT id, work_modes, fit_score, found_at, posted_at, stage_at FROM jobs",
      )
      .all() as Record<string, number>[];
    const order = {
      best_fit: ["fit_score", "found_at", "id"],
      newest: ["found_at", "id"],
      posted: ["posted_at", "found_at", "id"],
      recent: ["stage_at", "id"],
    } as const;
    const filters: { minFit?: number; workModes?: WorkMode[] }[] = [
      { minFit: 60 },
      { minFit: 20 },
      { workModes: ["hybrid"] },
      { workModes: ["remote"], minFit: 90 },
    ];
    for (const filter of filters) {
      const mask = toWorkModeMask(filter.workModes ?? []);
      const want = rows.filter(
        (row) =>
          (filter.minFit === undefined ||
            row.fit_score! >= filter.minFit ||
            row.fit_score === -1) &&
          (mask === 0 || (row.work_modes! & mask) !== 0),
      );
      for (const sort of Object.keys(order) as (keyof typeof order)[]) {
        const expected = [...want]
          .sort((a, b) => {
            for (const column of order[sort])
              if (a[column] !== b[column]) return b[column]! - a[column]!;
            return 0;
          })
          .map((row) => row.id);
        const seen: number[] = [];
        let cursor: string | null = null;
        do {
          const page = store.listJobs({
            stage: "found",
            ...filter,
            sort,
            limit: 200,
            cursor,
          });
          expect(page.total, `${sort} ${JSON.stringify(filter)}`).toBe(
            Math.min(expected.length, 1000),
          );
          seen.push(...page.rows.map((row) => row.id));
          cursor = page.nextCursor;
        } while (cursor);
        expect(seen, `${sort} ${JSON.stringify(filter)}`).toEqual(expected);
      }
    }
  });

  it("reads a filtered page and count from index ranges, never the whole stage", () => {
    const store = open();
    const plan = (query: { sql: string; params: unknown[] }) =>
      (
        store
          .sql(`EXPLAIN QUERY PLAN ${query.sql}`)
          .all(...(query.params as number[])) as { detail: string }[]
      ).map((row) => row.detail);
    const filters: { minFit?: number; workModes?: WorkMode[] }[] = [
      { minFit: 60 },
      { workModes: ["flexible"] },
      { workModes: ["remote", "hybrid"], minFit: 60 },
    ];
    for (const filter of filters) {
      for (const sort of ["best_fit", "newest", "posted", "recent"] as const) {
        const query = JobListQuerySchema.parse({
          stage: "found",
          ...filter,
          sort,
        });
        const label = `${sort} ${JSON.stringify(filter)}`;
        for (const detail of [
          ...plan(jobPageSql(query, 0)),
          ...plan(jobCountSql(query)),
          ...(filter.minFit === undefined ? [] : plan(belowFloorSql(query)!)),
        ].filter((line) => line.includes(" USING "))) {
          // Each range reads only jobs it keeps: the filter is in the index search.
          expect(detail, label).toMatch(
            /\(stage=\? AND (work_modes|fit_score)/,
          );
        }
        if (sort === "best_fit" || filter.minFit === undefined)
          expect(plan(jobPageSql(query, 0)).join("\n"), label).not.toContain(
            "TEMP B-TREE",
          );
      }
    }
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
          sites: { all: true, except: [] },
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

  it("starts a file from before the store kept its data over", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-store-"));
    const file = path.join(dir, "jobs.sqlite");
    try {
      const old = new DatabaseSync(file);
      old.exec("CREATE TABLE saved_jobs (id TEXT); PRAGMA user_version = 5;");
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

  it("keeps the jobs in a file a newer build wrote", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-store-"));
    const file = path.join(dir, "jobs.sqlite");
    try {
      const store = openJobStore(file);
      store.saveFoundJobs({ searchId: null, jobs: [found(1), found(2)] });
      store.close();
      const newer = new DatabaseSync(file);
      newer.exec(
        "PRAGMA user_version = 99; CREATE TABLE later_notes (id INTEGER)",
      );
      newer.close();
      const reopened = openJobStore(file);
      expect(reopened.stageCounts().found).toBe(2);
      reopened.close();
      const check = new DatabaseSync(file);
      expect(check.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 99,
      });
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
