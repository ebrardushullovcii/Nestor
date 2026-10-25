import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { SavedJobSchema } from "@nestor/contracts";
import { createSavedJob } from "../file-repository.test-support";
import { createSavedJobDetails } from "./saved-job-details";
import { createSavedJobProjectionReader } from "./saved-job-projection";
import {
  ensureSavedJobRelations,
  writeSavedJobStorage,
} from "./saved-job-storage";

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

test("sightings, verdicts and preparation reuse evidence while changed bodies keep old versions", async () => {
  const db = database();
  db.exec("CREATE TABLE saved_jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const put = db.prepare("INSERT OR REPLACE INTO saved_jobs VALUES (?, ?)");
  const job = createSavedJob({ id: "shared", description: "Original listing" });
  put.run(job.id, JSON.stringify(job));
  const read = createSavedJobProjectionReader(db, { sqliteDetails: true });
  const first = await read();
  const next = {
    ...job,
    lastSeenAt: "2026-10-25T00:00:00.000Z",
    matchAssessment: {
      ...job.matchAssessment,
      score: job.matchAssessment.score + 1,
    },
  };
  put.run(job.id, JSON.stringify(next));
  const second = await read();
  expect(
    db.prepare("SELECT count(*) AS n FROM saved_job_details").get()!.n,
  ).toBe(1);
  expect(JSON.parse(JSON.stringify(second[0]))).toEqual(next);
  expect(JSON.parse(JSON.stringify(first[0]))).toEqual(job);
  const changed = {
    ...next,
    description: "Changed listing",
    keySkills: ["New skill"],
  };
  put.run(job.id, JSON.stringify(changed));
  const third = await read();
  expect(
    db.prepare("SELECT count(*) AS n FROM saved_job_details").get()!.n,
  ).toBe(2);
  db.exec("DELETE FROM saved_jobs");
  expect(JSON.parse(JSON.stringify(third[0]))).toEqual(changed);
  expect(JSON.parse(JSON.stringify(second[0]))).toEqual(next);
});

test("normalized details include source facts and never reuse reset text IDs", async () => {
  const db = database();
  db.exec("CREATE TABLE saved_jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  ensureSavedJobRelations(db);
  const base = createSavedJob({
    id: "normalized",
    description: "Original text",
  });
  const job = createSavedJob({
    ...base,
    provenance: [
      {
        targetId: "source",
        adapterKind: "auto",
        startingUrl: "https://example.test/jobs",
        discoveredAt: base.discoveredAt,
        collectionMethod: "api",
        providerKey: null,
        providerBoardToken: null,
        titleTriageOutcome: "pass",
        resolvedAdapterKind: "target_site",
        listingFacts: {
          title: base.title,
          company: base.company,
          location: base.location,
          salaryText: base.salaryText,
          seniority: base.seniority,
          description: "Source text",
          summary: base.summary,
        },
      },
    ],
  });
  writeSavedJobStorage(db, job);
  const read = createSavedJobProjectionReader(db, { sqliteDetails: true });
  const first = await read();
  writeSavedJobStorage(db, { ...job, lastSeenAt: "2026-10-25T00:00:00.000Z" });
  const next = await read();
  expect(
    db.prepare("SELECT count(*) AS n FROM saved_job_details").get()!.n,
  ).toBe(1);
  const changed = {
    ...job,
    provenance: job.provenance.map((source) => ({
      ...source,
      listingFacts: {
        ...source.listingFacts!,
        description: "Changed source text",
      },
    })),
  };
  writeSavedJobStorage(db, changed);
  const sourceChanged = await read();
  expect(sourceChanged[0]!.provenance[0]!.listingFacts!.description).toBe(
    "Changed source text",
  );
  expect(next[0]!.provenance[0]!.listingFacts!.description).toBe("Source text");
  db.exec(
    "DELETE FROM saved_jobs; DELETE FROM job_provenance; DELETE FROM job_listing_texts; DELETE FROM job_fit_assessments",
  );
  const reset = { ...job, description: "Reset text" };
  writeSavedJobStorage(db, reset);
  expect(JSON.parse(JSON.stringify((await read())[0]))).toEqual(reset);
  expect(JSON.parse(JSON.stringify(first[0]))).toEqual(job);
});
