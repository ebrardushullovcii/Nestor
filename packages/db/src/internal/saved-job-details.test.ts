import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { SavedJobSchema } from "@nestor/contracts";
import { createSavedJob } from "../file-repository.test-support";
import { createSavedJobDetails } from "./saved-job-details";
import { createSavedJobProjectionReader } from "./saved-job-projection";

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.close();
});

test("large finalization waves are reclaimed in parts without removing held versions", () => {
  let retire: (version: number) => void = () => {
    throw new Error("Registry not created");
  };
  vi.stubGlobal(
    "FinalizationRegistry",
    class {
      constructor(callback: (version: number) => void) {
        retire = callback;
      }
      register() {}
    },
  );
  const db = database();
  const details = createSavedJobDetails(db);
  const project = (id: string) => {
    const job = createSavedJob({ id, description: `Original ${id}` });
    return details.project(job, JSON.stringify(job));
  };
  const held = project("held");
  for (let index = 0; index < 64; index++) project(`retired_${index}`);
  for (const row of db
    .prepare("SELECT version FROM saved_job_details WHERE id LIKE 'retired_%'")
    .all())
    retire(Number(row.version));
  const count = () =>
    Number(db.prepare("SELECT count(*) AS n FROM saved_job_details").get()!.n);
  const current = [project("current")];
  expect(count()).toBeLessThan(65);
  expect(count()).toBeGreaterThan(2);
  expect(held.description).toBe("Original held");
  for (let index = 0; index < 64; index++)
    current.push(project(`current_${index}`));
  expect(count()).toBe(current.length + 1);
  expect(current.every((row) => row.description === `Original ${row.id}`)).toBe(
    true,
  );
  expect(held.description).toBe("Original held");
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
  expect(parse).not.toHaveBeenCalled();
  for (const row of rows.slice(1)) void row.keySkills;
  expect(parse).not.toHaveBeenCalled();
  void rows[0]!.keySkills;
  expect(parse).not.toHaveBeenCalled();
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
  });
  const first = await read();
  put.run("a", JSON.stringify({ ...firstJob, description: "New listing" }));
  const second = await read();
  expect(second[0]!.description).toBe("New listing");
  expect(first[0]!.description).toBe("Original listing");
  db.exec("DELETE FROM saved_jobs");
  expect(await read()).toEqual([]);
  expect(JSON.parse(JSON.stringify(first[0]))).toEqual(firstJob);
});
