import { DatabaseSync } from "node:sqlite";
import {
  ApplicationRecordSchema,
  QueryJobListInputSchema,
} from "@nestor/contracts";
import { afterEach, describe, expect, test } from "vitest";
import {
  createTempRepository,
  createSavedJob,
} from "./file-repository.test-support";
import {
  createWorkspaceQueryRepository,
  prepareWorkspaceQueryDatabase,
} from "./workspace-query-repository";
import { subscribeWorkspaceCommits } from "./workspace-commits";

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
  test("pending rows retain their location before promotion", async () => {
    const { writer, reader } = await fixture();
    await writer.commitDiscoveryStateUpdate((current) => ({
      ...current,
      pendingDiscoveryJobs: [
        createSavedJob({
          id: "pending-location",
          status: "discovered",
          location: "Remote, Europe",
        }),
      ],
    }));
    expect(
      reader.queryJobList({ list: "all", filters: { planId: null } }).rows[0]
        ?.location,
    ).toBe("Remote, Europe");
  });
  test("commit callbacks see committed rows without a polling timer and never see rollbacks", async () => {
    const { filePath, writer, reader } = await fixture();
    const seen: string[] = [];
    const stop = subscribeWorkspaceCommits(filePath, () => {
      seen.push(reader.getJobDetail("pushed")?.job.title ?? "missing");
    });
    cleanups.push(stop);
    await writer.commitSavedJobDelta({
      upserts: [createSavedJob({ id: "pushed", title: "Committed" })],
    });
    expect(seen).toEqual(["Committed"]);
    await expect(
      writer.commitSavedJobDelta({
        updateJobIds: ["pushed"],
        update() {
          throw new Error("abort");
        },
      }),
    ).rejects.toThrow("abort");
    expect(seen).toEqual(["Committed"]);
    stop();
    await writer.commitSavedJobDelta({
      upserts: [createSavedJob({ id: "pushed", title: "Later" })],
    });
    expect(seen).toEqual(["Committed"]);
  });
  test("intake-only utility filtering keeps curated work and hidden jobs recoverable", async () => {
    const { writer, reader } = await fixture();
    await writer.commitSavedJobDelta({
      upserts: [
        createSavedJob({
          id: "chrome",
          title: "Privacy policy",
          status: "discovered",
        }),
        createSavedJob({
          id: "curated",
          title: "Privacy policy",
          status: "shortlisted",
        }),
        createSavedJob({ id: "role", status: "discovered" }),
        createSavedJob({
          id: "hidden",
          status: "archived",
          discoveryFeedback: {
            version: 1,
            revision: 1,
            reasons: [],
            priorStatus: "discovered",
            recordedAt: "2026-10-24T00:00:00.000Z",
          },
        }),
      ],
    });
    expect(
      reader
        .queryJobList({
          list: "discovery",
          filters: { planId: null },
          sort: "title",
        })
        .rows.map((row) => row.id)
        .sort(),
    ).toEqual(["curated", "role"]);
    expect(
      reader
        .queryJobList({ list: "dismissed", filters: { planId: null } })
        .rows.map((row) => row.id),
    ).toEqual(["hidden"]);
    await writer.commitSavedJobDelta({
      updateJobIds: ["hidden"],
      update: (job) => ({
        ...job,
        status: "discovered",
        discoveryFeedback: null,
      }),
    });
    expect(reader.getListCounts({ planId: null }).dismissed).toBe(0);
    expect(reader.getListCounts({ planId: null }).discovery).toBe(3);
  });
  test("returned unsent applications leave Applications while their review-queue job and history stay available", async () => {
    const { writer, reader } = await fixture();
    await writer.commitSavedJobDelta({
      upserts: [createSavedJob({ id: "returned", status: "ready_for_review" })],
    });
    const record = ApplicationRecordSchema.parse({
      id: "application",
      jobId: "returned",
      title: "Synthetic role",
      company: "Synthetic company",
      lastActionLabel: "Prepared",
      nextActionLabel: null,
      status: "ready_for_review",
      lastUpdatedAt: "2026-10-24T00:00:00.000Z",
    });
    await writer.upsertApplicationRecord(record);
    expect(reader.getListCounts({ planId: null })).toMatchObject({
      applications: 1,
      shortlisted: 1,
    });
    await writer.upsertApplicationRecord({
      ...record,
      returnedToShortlistAt: "2026-10-24T00:00:00Z",
    });
    expect(reader.getListCounts({ planId: null })).toMatchObject({
      applications: 0,
      shortlisted: 1,
    });
    await writer.upsertApplicationRecord({
      ...record,
      returnedToShortlistAt: record.lastUpdatedAt,
      lastUpdatedAt: "2026-10-24T00:01:00.000Z",
    });
    expect(reader.getListCounts({ planId: null })).toMatchObject({
      applications: 1,
      shortlisted: 1,
    });
  });
  test("query input rejects unbounded pages and unknown filters", () => {
    expect(
      QueryJobListInputSchema.safeParse({ list: "all", page: { limit: 201 } })
        .success,
    ).toBe(false);
    expect(
      QueryJobListInputSchema.safeParse({
        list: "all",
        filters: { sql: "DROP TABLE" },
      }).success,
    ).toBe(false);
  });
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
    expect(result.counts.shortlisted).toBe(0);
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
    const membership = new DatabaseSync(filePath);
    membership
      .prepare(
        "INSERT INTO plan_job_memberships(plan_id, item_id, position) VALUES ('p', 'plan-a', 0)",
      )
      .run();
    membership.close();
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
