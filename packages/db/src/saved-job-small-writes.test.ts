import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import type { JobFinderRepository } from "./repository-types";
import { createInMemoryJobFinderRepository } from "./in-memory-repository";
import {
  createSavedJob,
  createTempRepository,
  savedJobData,
} from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";
import { createWorkspaceQueryRepository } from "./workspace-query-repository";

for (const storage of ["file", "memory"] as const)
  test(`${storage}: small writes retain workflow, other plans and exact job fields`, async () => {
    const temp =
      storage === "file"
        ? await createTempRepository("nestor-small-writes-")
        : null;
    const repo: JobFinderRepository = temp
      ? await temp.createRepository()
      : createInMemoryJobFinderRepository(createSeed());
    try {
      const base = createSavedJob({
        id: "a",
        status: "discovered",
        description: "Unchanged listing body. ".repeat(1000),
      });
      const job = createSavedJob({
        ...base,
        planAssessments: {
          p: { ...base.matchAssessment, score: 70 },
          q: { ...base.matchAssessment, score: 40 },
        },
      });
      await repo.commitSavedJobDelta({ upserts: [job] });
      await repo.commitSavedJobDelta({
        updateJobIds: [job.id],
        update: (row) => ({ ...row, status: "ready_for_review" }),
      });
      const before = (await repo.listSavedJobsByIds([job.id]))[0]!;
      const initialProjection = await repo.readSavedJobsProjection();
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      try {
        expect(
          await repo.updateSavedJobPlanAssessments([
            {
              jobId: job.id,
              planId: "p",
              assessment: { ...base.matchAssessment, score: 91 },
            },
          ]),
        ).toBe(1);
        expect(
          await repo.updateSavedJobSightings([
            {
              id: job.id,
              lastSeenAt: "2026-10-24T01:00:00.000Z",
              firstSeenAt: null,
            },
            { id: job.id, lastVerifiedActiveAt: "2026-10-24T01:00:00.000Z" },
            { id: "missing", lastSeenAt: null },
          ]),
        ).toBe(1);
        expect(
          prepare.mock.calls.filter(
            ([sql]) =>
              /^SELECT\b/iu.test(sql.trim()) && sql.includes("FROM saved_jobs"),
          ),
        ).toEqual([]);
      } finally {
        prepare.mockRestore();
      }
      const after = (await repo.listSavedJobsByIds([job.id]))[0]!;
      expect(savedJobData(after)).toEqual({
        ...savedJobData(before),
        firstSeenAt: null,
        lastSeenAt: "2026-10-24T01:00:00.000Z",
        lastVerifiedActiveAt: "2026-10-24T01:00:00.000Z",
        planAssessments: {
          ...before.planAssessments,
          p: { ...base.matchAssessment, score: 91 },
        },
      });
      expect(
        (await repo.readSavedJobsProjection())[0]?.planAssessments?.p?.score,
      ).toBe(91);
      expect(initialProjection[0]?.planAssessments?.p?.score).toBe(70);
      expect(
        await repo.updateSavedJobPlanAssessments([
          { jobId: job.id, planId: "p", assessment: after.planAssessments!.p! },
        ]),
      ).toBe(0);
      expect(
        await repo.updateSavedJobSightings([
          { id: job.id, lastSeenAt: after.lastSeenAt },
        ]),
      ).toBe(0);
      await expect(
        repo.commitSavedJobDelta({
          planAssessments: [
            {
              jobId: job.id,
              planId: "p",
              assessment: { ...base.matchAssessment, score: 12 },
            },
          ],
          sightings: [{ id: job.id, lastSeenAt: null }],
          updateDiscoveryState() {
            throw new Error("abort paired commit");
          },
        }),
      ).rejects.toThrow("abort paired commit");
      expect(
        savedJobData((await repo.listSavedJobsByIds([job.id]))[0]!),
      ).toEqual(savedJobData(after));
      await repo.commitSavedJobDelta({
        planAssessments: [{ jobId: job.id, planId: "p", assessment: null }],
        sightings: [{ id: job.id, lastSeenAt: null }],
      });
      const removed = (await repo.listSavedJobsByIds([job.id]))[0]!;
      expect(removed.planAssessments).toEqual({ q: before.planAssessments!.q });
      expect(removed.lastSeenAt).toBeNull();
    } finally {
      await repo.close();
      await temp?.cleanup();
    }
  });

test("plan and timestamp batches never write listing/value/evidence; query score and feed stay current", async () => {
  const temp = await createTempRepository("nestor-small-write-sql-");
  const repo = await temp.createRepository();
  const db = new DatabaseSync(temp.filePath);
  const reader = createWorkspaceQueryRepository(temp.filePath);
  try {
    const base = createSavedJob({
      id: "a",
      planAssessments: { p: createSavedJob().matchAssessment },
    });
    await repo.commitSavedJobDelta({ upserts: [base] });
    db.prepare(
      "INSERT INTO plan_job_memberships(plan_id,item_id,position) VALUES ('p','a',0)",
    ).run();
    db.exec(`CREATE TABLE test_body_writes(table_name TEXT);
      CREATE TRIGGER test_root_value AFTER UPDATE OF value ON saved_jobs BEGIN INSERT INTO test_body_writes VALUES('saved_jobs.value'); END;
      ${["job_listing_texts", "job_fit_assessments", "job_provenance"].flatMap((table) => ["INSERT", "UPDATE", "DELETE"].map((event) => `CREATE TRIGGER test_${table}_${event} AFTER ${event} ON ${table} BEGIN INSERT INTO test_body_writes VALUES('${table}'); END;`)).join("\n")}`);
    const revision = reader.getChanges(Number.MAX_SAFE_INTEGER).revision;
    await repo.commitSavedJobDelta({
      planAssessments: [
        {
          jobId: base.id,
          planId: "p",
          assessment: { ...base.matchAssessment, score: 31 },
        },
      ],
      sightings: [{ id: base.id, lastSeenAt: "2026-10-24T02:00:00.000Z" }],
    });
    expect(db.prepare("SELECT * FROM test_body_writes").all()).toEqual([]);
    expect(
      reader.queryJobList({ list: "all", filters: { planId: "p" } }).rows[0]
        ?.score,
    ).toBe(31);
    expect(
      reader.queryJobList({ list: "all", filters: { planId: "p" } }).rows[0]
        ?.lastSeenAt,
    ).toBe("2026-10-24T02:00:00.000Z");
    expect(reader.getChanges(revision).changes).toContainEqual(
      expect.objectContaining({
        table: "saved_jobs",
        id: base.id,
        operation: "upsert",
      }),
    );
    expect(
      await repo.updateSavedJobPlanAssessments([
        { jobId: "unknown", planId: "p", assessment: base.matchAssessment },
      ]),
    ).toBe(0);
  } finally {
    reader.close();
    db.close();
    await repo.close();
    await temp.cleanup();
  }
});
