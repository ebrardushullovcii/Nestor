import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import {
  ApplicationRecordSchema,
  FitJudgmentSchema,
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
import { ensureWorkspaceReadIndex } from "./internal/workspace-read-index";

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
  test("plan ordering preserves indexed job facts; actual membership changes update them", async () => {
    const { writer, reader, filePath } = await fixture();
    await writer.commitSavedJobDelta({
      upserts: ["a", "b", "c"].map((id) => createSavedJob({ id })),
    });
    const db = new DatabaseSync(filePath);
    cleanups.push(() => db.close());
    db.exec(`INSERT INTO plan_job_memberships VALUES ('p', 'a', 0), ('p', 'b', 1), ('q', 'a', 0);
      CREATE TEMP TABLE query_index_writes(operation TEXT);
      CREATE TEMP TRIGGER count_query_insert AFTER INSERT ON main.workspace_job_index BEGIN INSERT INTO query_index_writes VALUES ('insert'); END;
      CREATE TEMP TRIGGER count_query_update AFTER UPDATE ON main.workspace_job_index BEGIN INSERT INTO query_index_writes VALUES ('update'); END;
      CREATE TEMP TRIGGER count_query_delete AFTER DELETE ON main.workspace_job_index BEGIN INSERT INTO query_index_writes VALUES ('delete'); END;
      DROP TRIGGER workspace_membership_identity_update;
      CREATE TRIGGER workspace_membership_update AFTER UPDATE ON plan_job_memberships BEGIN SELECT RAISE(FAIL, 'Legacy broad trigger ran'); END;`);
    // An existing database gets only the corrected trigger, without a rebuild.
    ensureWorkspaceReadIndex(db);
    expect(db.prepare("SELECT * FROM query_index_writes").all()).toEqual([]);
    const ids = (planId: string) => reader.queryJobList({
      list: "all", filters: { planId },
    }).rows.map((job) => job.id).sort();
    expect(ids("p")).toEqual(["a", "b"]);
    const canonical = await writer.listSavedJobs();
    db.exec("UPDATE plan_job_memberships SET position = 1 - position WHERE plan_id = 'p'");
    expect(db.prepare("SELECT * FROM query_index_writes").all()).toEqual([]);
    expect(ids("p")).toEqual(["a", "b"]);
    expect(await writer.listSavedJobs()).toEqual(canonical);
    expect(db.prepare("SELECT item_id FROM plan_job_memberships WHERE plan_id = 'p' ORDER BY position").all().map((row) => row.item_id)).toEqual(["b", "a"]);
    db.exec("UPDATE plan_job_memberships SET item_id = 'c' WHERE plan_id = 'p' AND item_id = 'a'");
    expect(ids("p")).toEqual(["b", "c"]);
    expect(ids("q")).toEqual(["a"]);
    db.exec("BEGIN; DELETE FROM plan_job_memberships WHERE plan_id = 'p'; ROLLBACK");
    expect(ids("p")).toEqual(["b", "c"]);
    db.exec("DELETE FROM plan_job_memberships WHERE plan_id = 'p' AND item_id = 'b'");
    expect(ids("p")).toEqual(["c"]);
  });

  test("Find jobs bands keep unjudged work visible and exclude decided and weaker jobs by default", async () => {
    const { writer, reader } = await fixture();
    const base = createSavedJob({
      status: "discovered",
      discoveryMethod: "browser_agent",
    });
    const judged = {
      ...base.matchAssessment,
      contextFingerprint: "profile",
      postingFingerprint: "listing",
      judgment: FitJudgmentSchema.parse({
        source: "batch",
        judgedAt: "2026-10-24T00:00:00.000Z",
        score: 60,
        recommendation: "review_before_applying",
      }),
    };
    await writer.commitSavedJobDelta({
      upserts: [
        createSavedJob({
          ...base,
          id: "strong",
          matchAssessment: { ...judged, score: 60 },
        }),
        createSavedJob({
          ...base,
          id: "unchecked",
          matchAssessment: { ...judged, score: 10, judgment: null },
        }),
        createSavedJob({
          ...base,
          id: "weaker",
          matchAssessment: { ...judged, score: 45 },
        }),
        createSavedJob({
          ...base,
          id: "mismatch",
          matchAssessment: { ...judged, score: 20 },
        }),
        createSavedJob({
          ...base,
          id: "decided",
          status: "ready_for_review",
          matchAssessment: judged,
        }),
        createSavedJob({
          ...base,
          id: "returned",
          status: "shortlisted",
          matchAssessment: judged,
        }),
      ],
    });
    const result = reader.queryJobList({
      list: "discovery",
      filters: { planId: null },
    });
    expect(result.rows.map((row) => row.id).sort()).toEqual([
      "returned",
      "strong",
      "unchecked",
    ]);
    expect(result.counts.discovery).toBe(3);
    expect(
      reader
        .queryJobList({
          list: "discovery",
          filters: { planId: null, discoveryBands: ["weaker", "mismatches"] },
        })
        .rows.map((row) => row.id)
        .sort(),
    ).toEqual(["mismatch", "weaker"]);
    expect(
      reader.queryJobList({ list: "all", filters: { planId: null } }).total,
    ).toBe(6);
  });
  test("startup reads preserve legacy bodies and do not wait for evidence conversion", async () => {
    const temp = await createTempRepository("nestor-early-query-");
    cleanups.push(temp.cleanup);
    const writer = await temp.createRepository();
    const preferences = await writer.getSearchPreferences();
    const campaigns = await writer.getCampaignState();
    const job = createSavedJob({
      id: "early",
      status: "discovered",
      description: "Synthetic listing evidence.",
      firstSeenAt: "2026-10-20T10:00:00.000Z",
    });
    await writer.commitSavedJobDelta({ upserts: [job] });
    await writer.close();
    const raw = new DatabaseSync(temp.filePath);
    cleanups.push(() => raw.close());
    raw
      .prepare(
        "UPDATE saved_jobs SET value = ?, assessment_id = NULL, description_id = NULL, list_visible = NULL, first_seen_at = NULL, last_seen_at = NULL WHERE id = ?",
      )
      .run(JSON.stringify(job), job.id);
    raw
      .prepare(
        "UPDATE singleton_state SET value = ? WHERE key = 'search_preferences'",
      )
      .run(JSON.stringify(preferences));
    raw
      .prepare(
        "UPDATE singleton_state SET value = ? WHERE key = 'campaign_state'",
      )
      .run(JSON.stringify(campaigns));
    raw.exec(
      "DELETE FROM schema_migrations WHERE version IN (26,27,28,29); DELETE FROM workspace_read_meta",
    );
    const before = raw
      .prepare("SELECT value FROM saved_jobs WHERE id = ?")
      .get(job.id)!.value;
    prepareWorkspaceQueryDatabase(temp.filePath);
    const reader = createWorkspaceQueryRepository(temp.filePath);
    cleanups.push(() => reader.close());
    expect(reader.getStartupContext().sourceCount).toBe(
      preferences.discovery.targets.length,
    );
    const page = reader.queryJobList({
      list: "all",
      filters: { planId: null },
    });
    expect(page.total).toBe(1);
    expect(page.rows[0]).toMatchObject({
      id: job.id,
      firstSeenAt: job.firstSeenAt,
    });
    expect(reader.getHomeSummary({ planId: null }).counts.all).toBe(1);
    expect(
      raw.prepare("SELECT value FROM saved_jobs WHERE id = ?").get(job.id)!
        .value,
    ).toBe(before);
    expect(
      raw
        .prepare(
          "SELECT version FROM schema_migrations WHERE version IN (26,27,28,29)",
        )
        .all(),
    ).toEqual([]);
  });
  test("closing the query connection before the writer permits a clean-close marker", async () => {
    const temp = await createTempRepository("nestor-query-close-");
    const writer = await temp.createRepository();
    const reader = createWorkspaceQueryRepository(temp.filePath);
    try {
      reader.getStartupContext();
      reader.close();
      await writer.close();
      expect(existsSync(`${temp.filePath}.clean-close`)).toBe(true);
    } finally {
      await temp.cleanup();
    }
  });
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
