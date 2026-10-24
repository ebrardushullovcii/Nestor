import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import {
  createTempRepository,
  createSavedJob,
} from "./file-repository.test-support";
import {
  createWorkspaceQueryRepository,
  prepareWorkspaceQueryDatabase,
} from "./workspace-query-repository";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const temp = await createTempRepository("nestor-query-");
  cleanups.push(temp.cleanup);
  const writer = await temp.createRepository();
  cleanups.push(() => writer.close());
  const reader = createWorkspaceQueryRepository(temp.filePath);
  cleanups.push(() => reader.close());
  return { ...temp, writer, reader };
}
describe("independent workspace queries", () => {
  test("pages and filters saved and pending jobs without carrying bodies", async () => {
    const { writer, reader } = await fixture();
    await writer.commitSavedJobDelta({
      upserts: [
        createSavedJob({ id: "a", title: "Alpha", status: "discovered" }),
        createSavedJob({ id: "b", title: "Beta", status: "discovered" }),
        createSavedJob({ id: "c", title: "Gamma", status: "shortlisted" }),
      ],
    });
    const result = reader.queryJobList({
      list: "discovery",
      filters: { planId: null, workModes: ["remote"] },
      sort: "title",
      page: { offset: 1, limit: 1 },
    });
    expect(result.rows.map((row) => row.id)).toEqual(["b"]);
    expect(result.total).toBe(3);
    expect(result.counts.shortlisted).toBe(1);
    expect(result.rows[0]).not.toHaveProperty("description");
    expect(reader.getJobDetail("b")?.job.description).toContain(
      "Lead product design",
    );
    expect(
      reader
        .queryJobList({
          list: "all",
          filters: { planId: null },
          search: "Gamma",
        })
        .rows.map((row) => row.id),
    ).toEqual(["c"]);
    expect(reader.getJobDetail("missing")).toBeNull();
  });
  test("feed and metadata commit together, retain deletes, and exclude rollbacks", async () => {
    const { filePath, writer, reader } = await fixture();
    const before = reader.getChanges(Number.MAX_SAFE_INTEGER).revision;
    await writer.commitSavedJobDelta({
      upserts: [createSavedJob({ id: "changed" })],
    });
    const changes = reader.getChanges(before);
    expect(changes.changes).toContainEqual(
      expect.objectContaining({
        table: "saved_jobs",
        id: "changed",
        operation: "upsert",
      }),
    );
    const other = new DatabaseSync(filePath);
    cleanups.push(() => other.close());
    other.exec(
      "BEGIN IMMEDIATE; DELETE FROM saved_jobs WHERE id = 'changed'; ROLLBACK",
    );
    expect(reader.getChanges(changes.revision).changes).toEqual([]);
    expect(reader.getJobDetail("changed")).not.toBeNull();
    other.exec("DELETE FROM saved_jobs WHERE id = 'changed'");
    expect(reader.getChanges(changes.revision).changes).toContainEqual(
      expect.objectContaining({ id: "changed", operation: "delete" }),
    );
    expect(
      reader.queryJobList({ list: "all", filters: { planId: null } }).total,
    ).toBe(0);
  });
  test("per-plan scores, stable paging, and older-connection writes remain current", async () => {
    const { filePath, writer, reader } = await fixture();
    const base = createSavedJob();
    const assessment = {
      ...base.matchAssessment,
      score: 90,
      contextFingerprint: "profile",
      postingFingerprint: "posting",
    };
    await writer.commitSavedJobDelta({
      upserts: [
        createSavedJob({
          id: "plan-a",
          campaignIds: ["p"],
          planAssessments: { p: assessment },
        }),
        createSavedJob({ id: "unscoped" }),
      ],
    });
    const result = reader.queryJobList({
      list: "all",
      filters: { planId: "p" },
    });
    expect(result.total).toBe(1);
    expect(result.rows[0]?.score).toBe(90);
    const other = new DatabaseSync(filePath);
    cleanups.push(() => other.close());
    other
      .prepare(
        "UPDATE saved_jobs SET value = json_set(value, '$.title', ?) WHERE id = ?",
      )
      .run("Changed title", "plan-a");
    expect(
      reader.queryJobList({ list: "all", filters: { planId: "p" } }).rows[0]
        ?.title,
    ).toBe("Changed title");
    prepareWorkspaceQueryDatabase(filePath);
    expect(
      reader.queryJobList({ list: "all", filters: { planId: "p" } }).total,
    ).toBe(1);
  });
  test("read connection cannot mutate canonical data", async () => {
    const { filePath } = await fixture();
    const readOnly = new DatabaseSync(filePath, { readOnly: true });
    cleanups.push(() => readOnly.close());
    expect(() => readOnly.exec("DELETE FROM saved_jobs")).toThrow();
  });
});
