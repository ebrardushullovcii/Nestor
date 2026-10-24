import { DatabaseSync } from "node:sqlite";
import { createInMemoryJobFinderRepository } from "./in-memory-repository";
import { createSeed } from "./test-fixtures";
import { expect, test, vi } from "vitest";
import {
  readPreparedSavedJobIdentity,
  readPreparedMatchAssessmentPostingFingerprint,
  computeMatchAssessmentPostingFingerprint,
  writeDiscoveryPreparation,
} from "@nestor/contracts";
import {
  createTempRepository,
  createSavedJob,
  savedJobData,
} from "./file-repository.test-support";

const fingerprints = {
  version: 1 as const,
  card: "card",
  detail: "detail",
  material: "material",
};

test("memory preparation follows unchanged inputs and is invalidated by a later body write", async () => {
  const repo = createInMemoryJobFinderRepository(createSeed());
  const job = createSavedJob({ id: "memory-prepared" });
  await repo.commitSavedJobDelta({ upserts: [job] });
  await repo.writeSavedJobDiscoveryFingerprints([prepared(job)]);
  expect((await repo.readSavedJobDiscoveryFingerprints([job.id])).size).toBe(1);
  await repo.commitSavedJobDelta({
    upserts: [
      { ...createSavedJob({ id: job.id }), description: "Changed body" },
    ],
  });
  await repo.writeSavedJobDiscoveryFingerprints([job]);
  expect((await repo.readSavedJobDiscoveryFingerprints([job.id])).size).toBe(0);
  await repo.close();
});
function prepared(job: ReturnType<typeof createSavedJob>) {
  writeDiscoveryPreparation(job, {
    fingerprints: { owner: job, value: fingerprints },
    matchAssessmentPostingFingerprint:
      computeMatchAssessmentPostingFingerprint(job),
    savedIdentity: {
      owner: job,
      value: {
        version: 1,
        local: { keys: ["local"], priorities: [1] },
        acrossSources: { keys: ["shared"], priorities: [1] },
        content: null,
      },
    },
  });
  return Object.freeze(job);
}

test("preparation batches do not load or rewrite bodies and reject stale inputs", async () => {
  const temp = await createTempRepository("nestor-preparation-write-");
  const repo = await temp.createRepository();
  const inspect = new DatabaseSync(temp.filePath);
  try {
    const job = createSavedJob({
      id: "legacy",
      description: "A long listing. ".repeat(1000),
    });
    await repo.commitSavedJobDelta({ upserts: [job] });
    const previousProjection = (await repo.readSavedJobsProjection()).find(
      (row) => row.id === job.id,
    )!;
    expect(readPreparedSavedJobIdentity(previousProjection)).toBeNull();
    const before = inspect
      .prepare("SELECT value, description_id FROM saved_jobs WHERE id = ?")
      .get(job.id);
    const bodyReads = vi.fn();
    const originalPrepare = Reflect.get(DatabaseSync.prototype, "prepare");
    const spy = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync, sql) {
        const statement = originalPrepare.call(this, sql);
        if (/^SELECT id, text FROM job_listing_texts/.test(sql)) {
          const all = statement.all.bind(statement);
          vi.spyOn(statement, "all").mockImplementation((...args) => {
            bodyReads();
            return all(...args);
          });
        }
        return statement;
      });
    try {
      await repo.writeSavedJobDiscoveryFingerprints([prepared(job)]);
    } finally {
      spy.mockRestore();
    }
    expect(bodyReads).not.toHaveBeenCalled();
    const currentProjection = (await repo.readSavedJobsProjection()).find(
      (row) => row.id === job.id,
    )!;
    expect(readPreparedSavedJobIdentity(currentProjection)).not.toBeNull();
    expect(
      readPreparedMatchAssessmentPostingFingerprint(currentProjection),
    ).toBe(computeMatchAssessmentPostingFingerprint(job));
    expect(
      readPreparedMatchAssessmentPostingFingerprint(previousProjection),
    ).toBeNull();
    expect(readPreparedSavedJobIdentity(previousProjection)).toBeNull();
    expect(
      inspect
        .prepare("SELECT value, description_id FROM saved_jobs WHERE id = ?")
        .get(job.id),
    ).toEqual(before);
    expect(
      (await repo.readSavedJobDiscoveryFingerprints([job.id])).get(job.id)
        ?.identity,
    ).toBeDefined();
    expect(savedJobData((await repo.listSavedJobsByIds([job.id]))[0]!)).toEqual(
      savedJobData(job),
    );
    for (const change of [
      { title: "Changed title" },
      { canonicalUrl: "https://example.test/changed" },
      { description: "Changed body" },
      { minimumQualifications: ["New requirement"] },
      {
        keywordSignals: [
          { id: "new", label: "New", kind: "domain" as const, weight: 3 },
        ],
      },
      { atsProvider: "Changed ATS" },
    ]) {
      await repo.commitSavedJobDelta({
        upserts: [{ ...createSavedJob({ id: job.id }), ...change }],
      });
      await repo.writeSavedJobDiscoveryFingerprints([job]);
      expect(
        (await repo.readSavedJobDiscoveryFingerprints([job.id])).size,
      ).toBe(0);
    }
  } finally {
    inspect.close();
    await repo.close();
    await temp.cleanup();
  }
});

test("a failed preparation batch rolls back every fingerprint", async () => {
  const temp = await createTempRepository("nestor-preparation-rollback-");
  const repo = await temp.createRepository();
  const inspect = new DatabaseSync(temp.filePath);
  try {
    const jobs = [createSavedJob({ id: "a" }), createSavedJob({ id: "b" })];
    await repo.commitSavedJobDelta({ upserts: jobs });
    inspect.exec(`CREATE TRIGGER reject_preparation BEFORE INSERT ON saved_job_discovery_fingerprints
      WHEN NEW.job_id = 'b' BEGIN SELECT RAISE(ABORT, 'batch failed'); END;`);
    await expect(
      repo.writeSavedJobDiscoveryFingerprints(jobs.map(prepared)),
    ).rejects.toThrow("batch failed");
    expect(
      (await repo.readSavedJobDiscoveryFingerprints(["a", "b"])).size,
    ).toBe(0);
  } finally {
    inspect.close();
    await repo.close();
    await temp.cleanup();
  }
});

test("a scoped borrowed no-op reads no bodies, and a material write batches required body reads", async () => {
  const temp = await createTempRepository("nestor-scoped-write-");
  const repo = await temp.createRepository();
  try {
    const jobs = [createSavedJob({ id: "a" }), createSavedJob({ id: "b" })];
    await repo.commitSavedJobDelta({ upserts: jobs });
    let bodyReads = 0;
    const originalPrepare = Reflect.get(DatabaseSync.prototype, "prepare");
    const spy = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync, sql) {
        const statement = originalPrepare.call(this, sql);
        if (/^SELECT id, text FROM job_listing_texts/.test(sql)) {
          const all = statement.all.bind(statement);
          vi.spyOn(statement, "all").mockImplementation((...args) => {
            bodyReads++;
            return all(...args);
          });
        }
        return statement;
      });
    try {
      await repo.commitSavedJobDelta({
        updateJobIds: ["a", "b"],
        borrowCurrentJobs: true,
        update: (job) => job,
      });
      expect(bodyReads).toBe(0);
      await repo.commitSavedJobDelta({
        updateJobIds: ["a", "b"],
        borrowCurrentJobs: true,
        update: (job) => ({ ...job, title: "New title" }),
      });
      expect(bodyReads).toBe(1);
      expect(
        spy.mock.calls.some(([sql]) =>
          sql.includes("INSERT INTO job_plan_assessments"),
        ),
      ).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(
      (await repo.listSavedJobsByIds(["a", "b"])).map(savedJobData),
    ).toEqual(jobs.map((job) => ({ ...job, title: "New title" })));
  } finally {
    await repo.close();
    await temp.cleanup();
  }
});
