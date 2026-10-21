import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import {
  createSavedJob,
  createTempRepository,
} from "../file-repository.test-support";
import { createSavedJobProjectionReader } from "./saved-job-projection";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(
    "CREATE TABLE saved_jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE progress (value INTEGER)",
  );
  const put = (id: string, title = id) =>
    db
      .prepare(
        "INSERT INTO saved_jobs VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(id, JSON.stringify(createSavedJob({ id, title })));
  return { db, put, read: createSavedJobProjectionReader(db) };
}

test("progress-only writes reuse rows; a job change replaces only its immutable row", async () => {
  const { db, put, read } = fixture();
  put("a");
  put("B");
  const first = await read();
  expect(first.map((job) => job.id)).toEqual(["B", "a"]);
  db.exec("INSERT INTO progress VALUES (1)");
  expect(await read()).toBe(first);
  expect(() => first[0]!.keySkills.push("accidental edit")).toThrow();
  put("a", "Changed");
  const changed = await read();
  expect(changed[0]).toBe(first[0]);
  expect(changed[1]?.title).toBe("Changed");
  expect(first[1]?.title).toBe("a");
  db.prepare("DELETE FROM saved_jobs WHERE id=?").run("B");
  expect((await read()).map((job) => job.id)).toEqual(["a"]);
});

test("a sighting's copy of the listing and an equal plan verdict share the job's values", async () => {
  const { db, read } = fixture();
  const base = createSavedJob({ id: "a" });
  const job = createSavedJob({
    id: "a",
    provenance: [
      {
        targetId: "board",
        adapterKind: "auto",
        startingUrl: "https://example.test",
        discoveredAt: base.discoveredAt,
        listingFacts: {
          title: base.title,
          company: base.company,
          location: base.location,
          salaryText: null,
          seniority: null,
          description: base.description,
          summary: null,
        },
      },
    ] as unknown as typeof base.provenance,
    planAssessments: {
      same: base.matchAssessment,
      other: { ...base.matchAssessment, score: base.matchAssessment.score - 1 },
    },
  });
  db.prepare("INSERT INTO saved_jobs VALUES (?, ?)").run(
    "a",
    JSON.stringify(job),
  );
  const [row] = await read();
  expect(row?.provenance[0]?.listingFacts?.description).toBe(
    base.description,
  );
  expect(row?.planAssessments?.same).toBe(row?.matchAssessment);
  expect(row?.planAssessments?.other).not.toBe(row?.matchAssessment);
  expect(row?.planAssessments?.other?.score).toBe(
    base.matchAssessment.score - 1,
  );
  expect(Object.isFrozen(row?.provenance[0]?.listingFacts)).toBe(true);
});

test("rolled-back writes leave the projection intact; reset replaces the complete set", async () => {
  const { db, put, read } = fixture();
  put("a");
  const first = await read();
  db.exec("BEGIN");
  put("a", "Rolled back");
  put("b");
  db.exec("ROLLBACK");
  expect(await read()).toBe(first);
  db.exec("BEGIN; DELETE FROM saved_jobs");
  put("c");
  db.exec("COMMIT");
  expect((await read()).map((job) => job.id)).toEqual(["c"]);
});

test("a read inside a transaction cannot cache rows that are later rolled back", async () => {
  const { db, put, read } = fixture();
  put("a");
  await read();
  db.exec("BEGIN");
  put("a", "Uncommitted");
  expect((await read())[0]?.title).toBe("Uncommitted");
  db.exec("ROLLBACK");
  // The next write reuses the rolled-back epoch. Both rows must still be
  // loaded from committed storage, never from the transaction's cached map.
  put("b");
  expect((await read()).map((job) => [job.id, job.title])).toEqual([
    ["a", "a"],
    ["b", "b"],
  ]);
});

test("a post-commit caller cannot join an older projection still parsing its rows", async () => {
  const { put, read } = fixture();
  for (let i = 0; i < 250; i++) put(String(i));
  const reading = read();
  put("249", "Updated during parsing");
  const afterCommit = read();
  expect(afterCommit).not.toBe(reading);
  const initial = await reading;
  expect(initial.find((job) => job.id === "249")?.title).toBe("249");
  expect((await afterCommit).find((job) => job.id === "249")?.title).toBe(
    "Updated during parsing",
  );
  expect(await read()).toBe(await afterCommit);
});

test("corrupt changed rows fail instead of serving stale data", async () => {
  const { db, put, read } = fixture();
  put("a");
  await read();
  db.prepare("UPDATE saved_jobs SET value=? WHERE id=?").run("{}", "a");
  await expect(read()).rejects.toThrow("Corrupted persisted row");
  put("a", "Repaired");
  expect((await read())[0]?.title).toBe("Repaired");
});

test("another connection's commits invalidate cached rows and ordinary reads stay owned", async () => {
  const fixture = await createTempRepository("nestor-projection-");
  const repository = await fixture.createRepository();
  const other = new DatabaseSync(fixture.filePath);
  try {
    await repository.commitSavedJobDelta({
      upserts: [createSavedJob({ id: "external" })],
    });
    const before = await repository.readSavedJobsProjection();
    const own = await repository.listSavedJobs();
    own
      .find((job) => job.id === "external")!
      .keySkills.push("caller-only edit");
    expect(
      (await repository.readSavedJobsProjection()).find(
        (job) => job.id === "external",
      )?.keySkills,
    ).not.toContain("caller-only edit");
    other
      .prepare("UPDATE saved_jobs SET value=? WHERE id=?")
      .run(
        JSON.stringify(
          createSavedJob({ id: "external", title: "External update" }),
        ),
        "external",
      );
    const after = await repository.readSavedJobsProjection();
    expect(after).not.toBe(before);
    expect(after.find((job) => job.id === "external")?.title).toBe(
      "External update",
    );
  } finally {
    other.close();
    await repository.close();
    await fixture.cleanup();
  }
});

test("a full read pages through the jobs, and a write between pages lands on the next read", async () => {
  const { put, read } = fixture();
  for (let index = 0; index < 650; index += 1)
    put(`job-${String(index).padStart(4, "0")}`);
  const reading = read();
  // While the first pages are parsed, a job in a later page changes.
  await new Promise<void>((resolve) => setImmediate(resolve));
  put("job-0600", "Changed while reading");
  const first = await reading;
  expect(first).toHaveLength(650);
  const next = await read();
  expect(next.find((job) => job.id === "job-0600")?.title).toBe(
    "Changed while reading",
  );
  expect(next.map((job) => job.id)).toEqual(first.map((job) => job.id));
});

test("jobs holding alike values share one frozen copy", async () => {
  const { put, read } = fixture();
  put("a");
  put("b");
  const [a, b] = await read();
  expect(a!.normalizedCompensation).toEqual(b!.normalizedCompensation);
  expect(a!.matchAssessment.dimensions).toBe(b!.matchAssessment.dimensions);
  expect(a!.matchAssessment.compensationFit).toBe(
    b!.matchAssessment.compensationFit,
  );
  expect(Object.isFrozen(a!.matchAssessment.dimensions)).toBe(true);
});

test("the cached ids answer only while the cached rows are current", async () => {
  const { db, put, read } = fixture();
  put("b");
  put("a");
  expect(read.currentIds()).toBeNull();
  await read();
  expect(read.currentIds()).toEqual(["a", "b"]);
  put("c");
  expect(read.currentIds()).toBeNull();
  await read();
  expect(read.currentIds()).toEqual(["a", "b", "c"]);
  db.exec("BEGIN");
  expect(read.currentIds()).toBeNull();
  db.exec("ROLLBACK");
});
