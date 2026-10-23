import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { SavedJobSchema } from "@nestor/contracts";
import { createSavedJob } from "../file-repository.test-support";
import { createSavedJobDetails } from "./saved-job-details";
import { createSavedJobProjectionReader } from "./saved-job-projection";

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});
function database() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return db;
}

test("detail evidence is lazy and the full-job cache holds at most sixteen versions", () => {
  const db = database();
  const details = createSavedJobDetails(db);
  const rows = Array.from({ length: 17 }, (_, i) => {
    const job = createSavedJob({
      id: String(i),
      description: `Description ${i}`,
    });
    return details.project(job, JSON.stringify(job));
  });
  const parse = vi.spyOn(SavedJobSchema, "parse");
  expect(rows.map((row) => row.id)).toHaveLength(17);
  expect(parse).not.toHaveBeenCalled();
  expect(rows[0]!.description).toBe("Description 0");
  expect(rows[0]!.description).toBe("Description 0");
  expect(parse).not.toHaveBeenCalled();
  void rows[0]!.keySkills;
  void rows[0]!.keySkills;
  expect(parse).toHaveBeenCalledTimes(1);
  for (const row of rows.slice(1)) void row.keySkills;
  expect(parse).toHaveBeenCalledTimes(17);
  void rows[0]!.keySkills;
  expect(parse).toHaveBeenCalledTimes(18);
  expect(() => rows[0]!.keySkills.push("mutation")).toThrow();
});

test("held projection details survive edits, deletion and cache eviction", async () => {
  const db = database();
  db.exec("CREATE TABLE saved_jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const put = db.prepare("INSERT OR REPLACE INTO saved_jobs VALUES (?, ?)");
  const firstJob = createSavedJob({ id: "a", description: "Original listing" });
  put.run(firstJob.id, JSON.stringify(firstJob));
  const read = createSavedJobProjectionReader(db, {
    sqliteDetails: true,
    validationStamp: "build",
  });
  const first = await read();
  await read.validation();
  put.run("a", JSON.stringify({ ...firstJob, description: "New listing" }));
  const second = await read();
  expect(second[0]!.description).toBe("New listing");
  expect(first[0]!.description).toBe("Original listing");
  db.exec("DELETE FROM saved_jobs");
  expect(await read()).toEqual([]);
  expect(JSON.parse(JSON.stringify(first[0]))).toEqual(firstJob);
});

test("full detail reads reuse only this build's mark for byte-identical canonical rows", async () => {
  const db = database();
  db.exec("CREATE TABLE saved_jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const put = db.prepare("INSERT OR REPLACE INTO saved_jobs VALUES (?, ?)");
  const job = createSavedJob({
    id: "marked",
    description: "Validated listing",
  });
  put.run(job.id, JSON.stringify(job));
  for (let i = 0; i < 17; i++) {
    const other = createSavedJob({ id: `other_${i}` });
    put.run(other.id, JSON.stringify(other));
  }
  const read = createSavedJobProjectionReader(db, {
    sqliteDetails: true,
    validationStamp: "build",
  });
  const rows = await read();
  await read.validation();
  const parse = vi.spyOn(SavedJobSchema, "parse");
  expect(rows[0]!.keySkills).toEqual(job.keySkills);
  expect(parse).not.toHaveBeenCalled();
  for (const row of rows.slice(1)) void row.keySkills;
  // An old TEMP row cannot borrow a newer row's mark, even for the same id.
  put.run(
    job.id,
    JSON.stringify({ ...job, description: "Updated canonical listing" }),
  );
  db.prepare(
    "INSERT OR REPLACE INTO row_validations VALUES ('saved_jobs', ?, 'build')",
  ).run(job.id);
  expect(rows[0]!.keySkills).toEqual(job.keySkills);
  expect(parse).toHaveBeenCalledOnce();
});

test("a new build publishes list facts before background validation and marks full rows", async () => {
  const db = database();
  db.exec("CREATE TABLE saved_jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const put = db.prepare("INSERT INTO saved_jobs VALUES (?, ?)");
  for (let i = 0; i < 60; i++) {
    const base = createSavedJob({ id: String(i) });
    const job = SavedJobSchema.parse({
      ...base,
      planAssessments: { same: base.matchAssessment },
    });
    put.run(job.id, JSON.stringify(job));
  }
  const read = createSavedJobProjectionReader(db, {
    sqliteDetails: true,
    validationStamp: "new-build",
  });
  const rows = await read();
  expect(rows).toHaveLength(60);
  expect(rows[0]!.planAssessments!.same).toBe(rows[0]!.matchAssessment);
  expect(
    Number(db.prepare("SELECT count(*) AS n FROM row_validations").get()!.n),
  ).toBeLessThan(60);
  await read.validation();
  expect(
    Number(
      db
        .prepare(
          "SELECT count(*) AS n FROM row_validations WHERE validated_stamp = 'new-build'",
        )
        .get()!.n,
    ),
  ).toBe(60);
});

test("invalid unopened detail fails background validation and the next list read", async () => {
  const db = database();
  db.exec("CREATE TABLE saved_jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const invalid = { ...createSavedJob({ id: "a" }), description: 17 };
  db.prepare("INSERT INTO saved_jobs VALUES (?, ?)").run(
    "a",
    JSON.stringify(invalid),
  );
  const read = createSavedJobProjectionReader(db, {
    sqliteDetails: true,
    validationStamp: "new-build",
  });
  const [row] = await read();
  expect(row!.id).toBe("a");
  expect(() => row!.description).toThrow("Corrupted persisted row");
  await expect(read.validation()).rejects.toThrow("Corrupted persisted row");
  await expect(read()).rejects.toThrow("Corrupted persisted row");
  expect(db.prepare("SELECT count(*) AS n FROM row_validations").get()!.n).toBe(
    0,
  );
});
