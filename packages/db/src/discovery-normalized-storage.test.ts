import { DatabaseSync } from "node:sqlite";
import { rm } from "node:fs/promises";
import {
  BrowserAgentRunCheckpointSchema,
  DiscoveryActivityEventSchema,
  DiscoveryLedgerEntrySchema,
  DiscoveryRunRecordSchema,
} from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";
import { cleanupTempDirectoryWithRetry, createSavedJob, createTempRepository } from "./file-repository.test-support";
import { createDiscoveryStorage } from "./internal/discovery-storage";
import { createDiscoveryDisplayProjectionReader } from "./internal/discovery-display-projection";
import { createSeed } from "./test-fixtures";
import { patchDiscoveryLedger } from "./index";

function ledger(id: string) {
  return DiscoveryLedgerEntrySchema.parse({
    id,
    canonicalUrl: `https://example.test/jobs/${id}`,
    source: "target_site",
    title: "Synthetic role",
    targetId: "synthetic_target",
    firstSeenAt: "2026-10-13T10:00:00.000Z",
    lastSeenAt: "2026-10-13T10:00:00.000Z",
  });
}

function checkpoint(revision: number) {
  return BrowserAgentRunCheckpointSchema.parse({
    revision,
    savedAt: `2026-10-13T10:00:${String(revision).padStart(2, "0")}.000Z`,
    currentUrl: "https://example.test/jobs/1",
    lastStableUrl: "https://example.test/jobs/1",
    stepCount: revision,
    collectedJobs: [createSavedJob({ id: "checkpoint_private", description: "synthetic checkpoint body ".repeat(400) })],
    visitedUrls: ["https://example.test/jobs/1"],
    phaseEvidence: {},
  });
}

function run(id: string, revision: number) {
  return DiscoveryRunRecordSchema.parse({
    id,
    state: "running",
    scope: "run_all",
    startedAt: "2026-10-13T10:00:00.000Z",
    targetIds: ["synthetic_target"],
    targetExecutions: [{ targetId: "synthetic_target", adapterKind: "auto", state: "running", agentCheckpoint: checkpoint(revision) }],
    activity: [],
    summary: { targetsPlanned: 1, outcome: "running" },
  });
}

function activity(runId: string, index: number) {
  return DiscoveryActivityEventSchema.parse({
    id: `${runId}_event_${index}`,
    runId,
    timestamp: "2026-10-13T10:00:00.000Z",
    kind: "progress",
    stage: "navigation",
    message: `Visited synthetic page ${index}`,
  });
}

describe("normalized discovery storage", () => {
  test("progress appends only new events and preserves rowids, exact order and checkpoints", async () => {
    const temp = await createTempRepository("nestor-append-progress-");
    const repo = await temp.createRepository();
    const raw = new DatabaseSync(temp.filePath);
    try {
      const initial = {
        ...run("append", 1),
        activity: [activity("append", 0), activity("append", 1)],
      };
      await repo.commitDiscoveryStateUpdate((current) => ({
        ...current,
        runState: "running",
        activeRun: initial,
      }));
      const rowids = () =>
        Object.fromEntries(
          [
            "discovery_run_activity",
            "discovery_run_targets",
            "discovery_run_checkpoints",
          ].flatMap((table) =>
            raw
              .prepare(`SELECT id,rowid FROM ${table} WHERE run_id='append'`)
              .all()
              .map((row) => [`${table}:${String(row.id)}`, row.rowid]),
          ),
        );
      const before = rowids();
      raw.exec(
        "CREATE TABLE progress_writes (kind TEXT,table_name TEXT,id TEXT)",
      );
      for (const table of [
        "discovery_run_activity",
        "discovery_run_targets",
        "discovery_run_checkpoints",
      ])
        for (const operation of ["insert", "update", "delete"])
          raw.exec(
            `CREATE TRIGGER audit_${table}_${operation} AFTER ${operation.toUpperCase()} ON ${table} BEGIN INSERT INTO progress_writes VALUES ('${operation}','${table}',${operation === "delete" ? "OLD" : "NEW"}.id); END`,
          );
      const appended = {
        ...initial,
        activity: [...initial.activity, activity("append", 2)],
        targetExecutions: initial.targetExecutions.map((target) => ({
          ...target,
          jobsReviewed: 1,
          agentCheckpoint: checkpoint(2),
        })),
      };
      await repo.commitDiscoveryStateUpdate((current) => ({
        ...current,
        activeRun: appended,
      }));
      expect(
        raw
          .prepare("SELECT * FROM progress_writes ORDER BY table_name,kind")
          .all(),
      ).toEqual([
        {
          kind: "insert",
          table_name: "discovery_run_activity",
          id: "append_event_2",
        },
        {
          kind: "update",
          table_name: "discovery_run_checkpoints",
          id: "synthetic_target",
        },
        {
          kind: "update",
          table_name: "discovery_run_targets",
          id: "synthetic_target",
        },
      ]);
      for (const [key, value] of Object.entries(before))
        expect(rowids()[key]).toBe(value);
      expect((await repo.getDiscoveryState()).activeRun).toEqual(appended);
      raw.exec("DELETE FROM progress_writes");
      await repo.commitDiscoveryStateUpdate((current) => ({
        ...current,
        activeRun: structuredClone(current.activeRun),
      }));
      expect(raw.prepare("SELECT * FROM progress_writes").all()).toEqual([]);
      const reordered = {
        ...appended,
        activity: [
          { ...appended.activity[2]!, message: "Edited progress" },
          ...appended.activity.slice(0, 2),
        ],
      };
      await repo.commitDiscoveryStateUpdate((current) => ({
        ...current,
        activeRun: reordered,
      }));
      expect((await repo.getDiscoveryState()).activeRun).toEqual(reordered);
      for (const [key, value] of Object.entries(before))
        expect(rowids()[key]).toBe(value);
      raw.exec(
        `CREATE TRIGGER fail_progress BEFORE INSERT ON discovery_run_checkpoints WHEN json_extract(NEW.value,'$.revision')=3 BEGIN SELECT RAISE(ABORT,'checkpoint failure'); END`,
      );
      await expect(
        repo.commitDiscoveryStateUpdate((current) => ({
          ...current,
          activeRun: {
            ...reordered,
            activity: [...reordered.activity, activity("append", 3)],
            targetExecutions: reordered.targetExecutions.map((target) => ({
              ...target,
              agentCheckpoint: checkpoint(3),
            })),
          },
        })),
      ).rejects.toThrow("checkpoint failure");
      expect((await repo.getDiscoveryState()).activeRun).toEqual(reordered);
      expect(raw.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe(
        "ok",
      );
    } finally {
      raw.close();
      await repo.close();
      await temp.cleanup();
    }
  });
  test("a ledger batch reads only its changed ranks once and uses bounded inserts", async () => {
    const temp = await createTempRepository("nestor-ledger-batch-");
    try {
      const repo = await temp.createRepository();
      await repo.commitDiscoveryStateUpdate((current) => ({ ...current, discoveryLedger: Array.from({ length: 3 }, (_, index) => ledger(`batch_${index}`)) }));
      await repo.close();
      const raw = new DatabaseSync(temp.filePath);
      try {
        const storage = createDiscoveryStorage(raw, createSeed().discovery);
        const before = storage.read();
        const calls = { rankReads: 0, rowWrites: 0 };
        const prepare = raw.prepare.bind(raw);
        const spy = vi.spyOn(raw, "prepare").mockImplementation((sql) => {
          const stmt = prepare(sql);
          if (sql.startsWith("SELECT id, position FROM discovery_ledger WHERE")) {
            const all = stmt.all.bind(stmt);
            vi.spyOn(stmt, "all").mockImplementation((...args) => { calls.rankReads++; return all(...args); });
          }
          if (sql.startsWith("INSERT INTO discovery_ledger_observations")) {
            const run = stmt.run.bind(stmt);
            vi.spyOn(stmt, "run").mockImplementation((...args) => { calls.rowWrites++; return run(...args); });
          }
          return stmt;
        });
        const next = patchDiscoveryLedger(before.discoveryLedger, Array.from({ length: 2 }, (_, index) => ({ id: `batch_${index}`, update: (row) => ({ ...row!, lastSeenAt: "2026-10-24T00:00:00.000Z" }) })));
        raw.exec("BEGIN IMMEDIATE");
        const stored = storage.update({ ...before, discoveryLedger: next }, before);
        raw.exec("COMMIT");
        storage.publish(stored);
        expect(calls.rankReads).toBe(1);
        expect(calls.rowWrites).toBeGreaterThan(0);
        expect(calls.rowWrites).toBeLessThanOrEqual(5);
        expect(storage.read().discoveryLedger).toEqual(next);
        spy.mockRestore();
        const reopened = new DatabaseSync(temp.filePath);
        try { expect(createDiscoveryStorage(reopened, createSeed().discovery).read().discoveryLedger).toEqual(next); }
        finally { reopened.close(); }
      } finally { raw.close(); }
    } finally { await cleanupTempDirectoryWithRetry(temp.tempDirectory); }
  });

  test("migration 29 backs up and preserves complete legacy run metadata once", async () => {
    const temp = await createTempRepository("nestor-run-progress-migration-");
    try {
      const repo = await temp.createRepository();
      const legacy = {
        ...run("legacy_progress", 3),
        summary: { ...run("legacy_progress", 3).summary, jobsPersisted: 7, sourceHealth: [{ targetId: "synthetic_target", health: "warning" as const, durationMs: 27, warnings: ["Synthetic warning"] }] },
        activity: [activity("legacy_progress", 1)],
      };
      await repo.commitDiscoveryStateUpdate((current) => ({ ...current, activeRun: legacy, runState: "running" }));
      await repo.close();
      const backupPath = `${temp.filePath}.before-discovery-progress.sqlite`;
      await rm(backupPath, { force: true });
      const raw = new DatabaseSync(temp.filePath);
      try {
        const metadata = Object.fromEntries(Object.entries(legacy).filter(([key]) => key !== "activity" && key !== "targetExecutions"));
        raw.prepare("UPDATE discovery_runs SET value = ?, progress = '{}' WHERE id = ?").run(JSON.stringify(metadata), legacy.id);
        raw.exec("DELETE FROM discovery_run_source_health; DELETE FROM schema_migrations WHERE version = 29");
      } finally { raw.close(); }
      const migrated = await temp.createRepository();
      try {
        expect((await migrated.getDiscoveryState()).activeRun).toEqual(legacy);
        const backup = new DatabaseSync(backupPath, { readOnly: true });
        try {
          expect(backup.prepare("SELECT progress FROM discovery_runs WHERE id = ?").get(legacy.id)?.progress).toBe("{}");
          expect(backup.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
        } finally { backup.close(); }
      } finally { await migrated.close(); }
      const again = await temp.createRepository();
      try { expect((await again.getDiscoveryState()).activeRun).toEqual(legacy); }
      finally { await again.close(); }
    } finally { await cleanupTempDirectoryWithRetry(temp.tempDirectory); }
  });

  test("progress updates leave the large run header unchanged and retain recovery and source history", async () => {
    const temp = await createTempRepository("nestor-run-progress-");
    try {
      const repo = await temp.createRepository();
      const initial = {
        ...run("progress", 1),
        targetIds: Array.from({ length: 2 }, (_, index) => `synthetic_source_${index}`),
        summary: {
          ...run("progress", 1).summary,
          sourceHealth: Array.from({ length: 2 }, (_, index) => ({ targetId: `synthetic_source_${index}`, health: "pending" as const, durationMs: 0, warnings: [] })),
        },
      };
      await repo.commitDiscoveryStateUpdate((current) => ({ ...current, activeRun: initial, runState: "running" }));
      const raw = new DatabaseSync(temp.filePath);
      try {
        const header = raw.prepare("SELECT value FROM discovery_runs WHERE id = 'progress'").get()?.value;
        raw.exec(`CREATE TABLE synthetic_run_writes (kind TEXT, bytes INTEGER);
          CREATE TRIGGER synthetic_header AFTER UPDATE OF value ON discovery_runs BEGIN INSERT INTO synthetic_run_writes VALUES ('header', length(NEW.value)); END;
          CREATE TRIGGER synthetic_progress AFTER UPDATE OF progress ON discovery_runs BEGIN INSERT INTO synthetic_run_writes VALUES ('progress', length(NEW.progress)); END;
          CREATE TRIGGER synthetic_health AFTER UPDATE ON discovery_run_source_health BEGIN INSERT INTO synthetic_run_writes VALUES ('health', length(NEW.value)); END;`);
        const displayBefore = await repo.readDiscoveryDisplayProjection();
        await repo.commitDiscoveryStateUpdate((current) => ({
          ...current,
          activeRun: {
            ...current.activeRun!,
            targetExecutions: [{ ...current.activeRun!.targetExecutions[0]!, agentCheckpoint: checkpoint(2) }],
            activity: [activity("progress", 1)],
            summary: {
              ...current.activeRun!.summary,
              jobsPersisted: 1,
              sourceHealth: current.activeRun!.summary.sourceHealth.map((value, index) => index === 0 ? { ...value, health: "healthy" } : value),
            },
          },
        }));
        expect(raw.prepare("SELECT value FROM discovery_runs WHERE id = 'progress'").get()?.value).toBe(header);
        expect(raw.prepare("SELECT COUNT(*) AS n FROM synthetic_run_writes WHERE kind = 'header'").get()?.n).toBe(0);
        expect(raw.prepare("SELECT COUNT(*) AS n FROM synthetic_run_writes WHERE kind = 'health'").get()?.n).toBe(1);
        expect(Number(raw.prepare("SELECT SUM(bytes) AS n FROM synthetic_run_writes").get()?.n)).toBeLessThan(2000);
        const display = await repo.readDiscoveryDisplayProjection();
        expect(display.activeRun?.summary.jobsPersisted).toBe(1);
        expect(display.activeRun?.summary.sourceHealth[0]?.health).toBe("healthy");
        expect(display.activeRun?.summary.sourceHealth[1]).toBe(displayBefore.activeRun?.summary.sourceHealth[1]);
        expect(display.activeRun?.activity).toHaveLength(1);
      } finally { raw.close(); await repo.close(); }
      const reopened = await temp.createRepository();
      try {
        const state = await reopened.getDiscoveryState();
        expect(state.activeRun?.targetIds).toEqual(initial.targetIds);
        expect(state.activeRun?.targetExecutions[0]?.agentCheckpoint?.revision).toBe(2);
        expect(state.activeRun?.summary.jobsPersisted).toBe(1);
        expect(state.activeRun?.summary.sourceHealth).toHaveLength(2);
        expect(state.activeRun?.summary.sourceHealth[0]?.health).toBe("healthy");
        expect(state.activeRun?.activity).toHaveLength(1);
      } finally { await reopened.close(); }
    } finally { await cleanupTempDirectoryWithRetry(temp.tempDirectory); }
  });

  test("prunes complete run rows atomically without reporting every retired child as a display edit", async () => {
    const temp = await createTempRepository("nestor-discovery-retirement-");
    try {
      const repo = await temp.createRepository();
      try {
        const old = { ...run("retired", 1), activity: Array.from({ length: 300 }, (_, index) => activity("retired", index)) };
        await repo.commitDiscoveryStateUpdate((current) => ({ ...current, recentRuns: [old] }));
        const rows = new DatabaseSync(temp.filePath);
        try {
          const storage = createDiscoveryStorage(rows, createSeed().discovery);
          const readDisplay = createDiscoveryDisplayProjectionReader(rows, createSeed().discovery);
          const before = storage.read();
          await readDisplay();
          rows.exec("BEGIN IMMEDIATE");
          storage.update({ ...before, recentRuns: [] }, before);
          rows.exec("ROLLBACK");
          expect(storage.read()).toEqual(before);
          expect((await readDisplay()).recentRuns).toHaveLength(1);
          rows.exec("BEGIN IMMEDIATE");
          const after = storage.update({ ...before, recentRuns: [] }, before);
          rows.exec("COMMIT");
          storage.publish(after);
          expect(rows.prepare("SELECT COUNT(*) AS n FROM discovery_display_changes WHERE run_id = ?").get("retired")?.n).toBe(0);
          expect((await readDisplay()).recentRuns).toEqual([]);
          for (const table of ["discovery_run_targets", "discovery_run_checkpoints", "discovery_run_activity"])
            expect(rows.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id = ?`).get("retired")?.n).toBe(0);
        } finally { rows.close(); }
        expect((await repo.getDiscoveryState()).recentRuns).toEqual([]);
      } finally { await repo.close(); }
    } finally { await cleanupTempDirectoryWithRetry(temp.tempDirectory); }
  });

  test("pairs saved job, ledger, counters and checkpoint writes and rolls all of them back on failure", async () => {
    const temp = await createTempRepository("nestor-discovery-paired-rows-");
    try {
      const repo = await temp.createRepository();
      try {
        await repo.commitSavedJobDelta({
          upserts: [createSavedJob({ id: "paired_job" })],
          updateDiscoveryState: (current) => ({
            ...current,
            runState: "running",
            activeRun: { ...run("paired_run", 1), summary: { ...run("paired_run", 1).summary, jobsPersisted: 1 } },
            discoveryLedger: [...current.discoveryLedger, ledger("paired_ledger")],
          }),
        });
        const committed = await repo.getDiscoveryState();
        expect(committed.activeRun?.targetExecutions[0]?.agentCheckpoint?.revision).toBe(1);
        expect(committed.activeRun?.summary.jobsPersisted).toBe(1);
        expect(await repo.listSavedJobsByIds(["paired_job"])).toHaveLength(1);

        const failing = new DatabaseSync(temp.filePath);
        failing.exec(`CREATE TRIGGER fail_synthetic_checkpoint AFTER UPDATE OF value ON discovery_run_checkpoints
          WHEN json_extract(NEW.value, '$.revision') = 2
          BEGIN SELECT RAISE(ABORT, 'synthetic checkpoint failure'); END`);
        failing.close();
        await expect(repo.commitSavedJobDelta({
          upserts: [createSavedJob({ id: "rolled_back_job" })],
          updateDiscoveryState: (current) => ({
            ...current,
            activeRun: { ...current.activeRun!, targetExecutions: [{ ...current.activeRun!.targetExecutions[0]!, agentCheckpoint: checkpoint(2) }] },
            discoveryLedger: [...current.discoveryLedger, ledger("rolled_back_ledger")],
            pendingDiscoveryJobs: [],
          }),
        })).rejects.toThrow();
        expect(await repo.getDiscoveryState()).toEqual(committed);
        expect(await repo.listSavedJobsByIds(["rolled_back_job"])).toEqual([]);
      } finally { await repo.close(); }
      const reopened = await temp.createRepository();
      try {
        expect((await reopened.getDiscoveryState()).activeRun?.targetExecutions[0]?.agentCheckpoint?.revision).toBe(1);
        expect((await reopened.getDiscoveryState()).discoveryLedger.map((entry) => entry.id)).toContain("paired_ledger");
      } finally { await reopened.close(); }
    } finally { await cleanupTempDirectoryWithRetry(temp.tempDirectory); }
  });

  test("migrates a complete legacy singleton once, retaining history, ledger, pending jobs and checkpoints", async () => {
    const temp = await createTempRepository("nestor-discovery-migration-");
    try {
      const initial = await temp.createRepository();
      await initial.close();
      const legacy = {
        ...createSeed().discovery,
        runState: "running" as const,
        activeRun: run("active_legacy", 3),
        recentRuns: [
          {
            ...run("historical_legacy", 2),
            state: "completed" as const,
            targetExecutions: [
              run("historical_legacy", 2).targetExecutions[0]!,
              { ...run("historical_legacy", 1).targetExecutions[0]!, agentCheckpoint: checkpoint(4) },
              { ...run("historical_legacy", 1).targetExecutions[0]!, targetId: "synthetic_target#duplicate_1" },
            ],
          },
          { ...run("historical_legacy", 1), state: "failed" as const },
        ],
        discoveryLedger: [ledger("legacy_one"), ledger("legacy_two"), { ...ledger("legacy_two"), title: "Duplicate historical sighting" }, ledger("legacy_two#duplicate_1")],
        pendingDiscoveryJobs: [createSavedJob({ id: "pending_legacy" })],
      };
      const database = new DatabaseSync(temp.filePath);
      try {
        database.exec("BEGIN IMMEDIATE");
        database.prepare("DELETE FROM schema_migrations WHERE version = 20").run();
        for (const table of ["discovery_run_checkpoints", "discovery_run_activity", "discovery_run_targets", "discovery_runs", "discovery_ledger", "discovery_pending_jobs"]) database.exec(`DELETE FROM ${table}`);
        database.prepare("UPDATE singleton_state SET value = ?, revision = revision + 1 WHERE key = 'discovery_state'").run(JSON.stringify(legacy));
        database.exec("COMMIT");
      } finally { database.close(); }
      const migrated = await temp.createRepository();
      try {
        expect(await migrated.getDiscoveryState()).toEqual(legacy);
        await migrated.commitDiscoveryStateUpdate((current) => ({ ...current, runState: "completed" }));
        expect((await migrated.getDiscoveryState()).recentRuns[0]?.targetExecutions.map((target) => target.agentCheckpoint?.revision)).toEqual([2, 4, 1]);
        expect((await migrated.readDiscoveryDisplayProjection()).activeRun?.targetExecutions[0]?.agentCheckpoint).toBeNull();
        const beforeExternal = await migrated.readDiscoveryDisplayProjection();
        const external = new DatabaseSync(temp.filePath);
        try {
          external.prepare("UPDATE discovery_ledger SET value = ? WHERE id = 'legacy_two'")
            .run(JSON.stringify({ ...legacy.discoveryLedger[1], title: "Externally updated synthetic role" }));
        } finally { external.close(); }
        expect((await migrated.readDiscoveryDisplayProjection()).discoveryLedger[1]?.title).toBe("Externally updated synthetic role");
        expect((await migrated.readDiscoveryDisplayProjection()).discoveryLedger[0]).not.toBe(beforeExternal.discoveryLedger[0]);
        expect((await migrated.getDiscoveryState()).discoveryLedger[1]?.title).toBe("Externally updated synthetic role");
      } finally { await migrated.close(); }
      const reopened = await temp.createRepository();
      try { expect((await reopened.getDiscoveryState()).discoveryLedger[1]?.title).toBe("Externally updated synthetic role"); }
      finally { await reopened.close(); }
      const rows = new DatabaseSync(temp.filePath);
      try {
        expect(Number(rows.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 20").get()?.count)).toBe(1);
        expect(Number(rows.prepare("SELECT COUNT(*) AS count FROM discovery_ledger").get()?.count)).toBe(4);
        expect(String(rows.prepare("SELECT value FROM singleton_state WHERE key = 'discovery_state'").get()?.value)).not.toContain("synthetic checkpoint body");
      } finally { rows.close(); }
    } finally { await cleanupTempDirectoryWithRetry(temp.tempDirectory); }
  });

  test("canonical cache observes local row edits but never retains rolled-back transaction reads", async () => {
    const temp = await createTempRepository("nestor-discovery-cache-tx-");
    try {
      const repo = await temp.createRepository();
      await repo.commitDiscoveryStateUpdate((current) => ({ ...current, discoveryLedger: [ledger("cache_row")] }));
      await repo.close();
      const database = new DatabaseSync(temp.filePath);
      try {
        const storage = createDiscoveryStorage(database, createSeed().discovery);
        const original = storage.read();
        expect(storage.read()).toBe(original);
        const writeTitle = (title: string) => database.prepare("UPDATE discovery_ledger SET value = ? WHERE id = 'cache_row'")
          .run(JSON.stringify({ ...ledger("cache_row"), title }));

        database.exec("BEGIN IMMEDIATE");
        writeTitle("Uncommitted synthetic role");
        const uncommitted = storage.read();
        expect(uncommitted.discoveryLedger[0]?.title).toBe("Uncommitted synthetic role");
        expect(() => storage.publish(uncommitted)).toThrow("only be published after commit");
        database.exec("ROLLBACK");
        expect(storage.read()).toBe(original);

        database.exec("BEGIN IMMEDIATE");
        writeTitle("Committed synthetic role");
        expect(storage.read().discoveryLedger[0]?.title).toBe("Committed synthetic role");
        database.exec("COMMIT");
        expect(storage.read().discoveryLedger[0]?.title).toBe("Committed synthetic role");

        writeTitle("Local synthetic role");
        expect(storage.read().discoveryLedger[0]?.title).toBe("Local synthetic role");
        database.prepare("UPDATE singleton_state SET value = json_set(value, '$.runState', 'running') WHERE key = 'discovery_state'").run();
        expect(storage.read().runState).toBe("running");
      } finally { database.close(); }
    } finally { await cleanupTempDirectoryWithRetry(temp.tempDirectory); }
  });
});
