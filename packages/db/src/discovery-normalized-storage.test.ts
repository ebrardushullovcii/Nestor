import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import {
  BrowserAgentRunCheckpointSchema,
  DiscoveryActivityEventSchema,
  DiscoveryLedgerEntrySchema,
  DiscoveryRunRecordSchema,
} from "@nordri/contracts";
import { describe, expect, test, vi } from "vitest";
import { cleanupTempDirectoryWithRetry, createSavedJob, createTempRepository } from "./file-repository.test-support";
import { createDiscoveryStorage } from "./internal/discovery-storage";
import { createSeed } from "./test-fixtures";

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
  test("pairs saved job, ledger, counters and checkpoint writes and rolls all of them back on failure", async () => {
    const temp = await createTempRepository("nordri-discovery-paired-rows-");
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

        await expect(repo.commitSavedJobDelta({
          upserts: [createSavedJob({ id: "rolled_back_job" })],
          updateDiscoveryState: (current) => ({
            ...current,
            activeRun: { ...current.activeRun!, targetExecutions: [{ ...current.activeRun!.targetExecutions[0]!, agentCheckpoint: checkpoint(2) }] },
            discoveryLedger: [...current.discoveryLedger, ledger("rolled_back_ledger")],
            pendingDiscoveryJobs: [{ id: "invalid_pending" }],
          }) as never,
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
    const temp = await createTempRepository("nordri-discovery-migration-");
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
    const temp = await createTempRepository("nordri-discovery-cache-tx-");
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

  test.each([3000, 10000])("a checkpoint with %i ledger rows writes only changed records", async (size) => {
    const temp = await createTempRepository(`nordri-discovery-scale-${size}-`);
    try {
      const repo = await temp.createRepository();
      try {
        const entries = Array.from({ length: size }, (_, index) => ledger(`ledger_${index}`));
        await repo.commitDiscoveryStateUpdate((current) => ({
          ...current,
          runState: "running",
          activeRun: run("active_scale", 1),
          recentRuns: [{ ...run("historical_scale", 1), state: "completed", activity: Array.from({ length: 1000 }, (_, index) => activity("historical_scale", index)) }],
          discoveryLedger: entries,
        }));
        const displayBefore = await repo.readDiscoveryDisplayProjection();
        const raw = new DatabaseSync(temp.filePath);
        try {
          const oldLedgerRowid = Number(raw.prepare("SELECT rowid FROM discovery_ledger WHERE id = ?").get(`ledger_${size - 1}`)?.rowid);
          const oldHistoryRowid = Number(raw.prepare("SELECT rowid FROM discovery_run_checkpoints WHERE run_id = 'historical_scale'").get()?.rowid);
          const stringify = vi.spyOn(JSON, "stringify");
          const started = performance.now();
          await repo.commitDiscoveryStateUpdate((current) => ({
            ...current,
            activeRun: {
              ...current.activeRun!,
              targetExecutions: [{ ...current.activeRun!.targetExecutions[0]!, agentCheckpoint: checkpoint(2) }],
            },
          }));
          const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
          expect(stringify.mock.calls.some(([value]) => Array.isArray(value) && value.length >= size)).toBe(false);
          expect(stringify.mock.calls.some(([value]) => value && typeof value === "object" && "discoveryLedger" in value)).toBe(false);
          expect(stringify.mock.calls.some(([value]) => {
            const candidate: unknown = value;
            return candidate !== null && typeof candidate === "object" && "id" in candidate && candidate.id === "historical_scale";
          })).toBe(false);
          stringify.mockRestore();
          const parse = vi.spyOn(JSON, "parse");
          const displayAfter = await repo.readDiscoveryDisplayProjection();
          expect(displayAfter).toBe(displayBefore);
          expect(parse.mock.calls.length).toBeLessThan(20);
          expect(displayAfter.discoveryLedger[0]).toBe(displayBefore.discoveryLedger[0]);
          parse.mockRestore();
          expect(Number(raw.prepare("SELECT rowid FROM discovery_ledger WHERE id = ?").get(`ledger_${size - 1}`)?.rowid)).toBe(oldLedgerRowid);
          expect(Number(raw.prepare("SELECT rowid FROM discovery_run_checkpoints WHERE run_id = 'historical_scale'").get()?.rowid)).toBe(oldHistoryRowid);
          expect((await repo.getDiscoveryState()).activeRun?.targetExecutions[0]?.agentCheckpoint?.revision).toBe(2);
          console.info(`normalized discovery checkpoint ${size} ledger rows: ${elapsedMs} ms`);
        } finally { raw.close(); }
      } finally { await repo.close(); }
    } finally { await cleanupTempDirectoryWithRetry(temp.tempDirectory); }
  });
});
