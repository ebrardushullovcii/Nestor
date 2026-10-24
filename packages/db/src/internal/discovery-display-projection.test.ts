import { DatabaseSync } from "node:sqlite";
import {
  DiscoveryLedgerEntrySchema,
  DiscoveryRunRecordSchema,
  JobFinderDiscoveryStateSchema,
} from "@nestor/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createInMemoryJobFinderRepository } from "../index";
import type { JobFinderRepository } from "../index";
import {
  createSavedJob,
  createTempRepository,
} from "../file-repository.test-support";
import { createSeed } from "../test-fixtures";
import { createDiscoveryDisplayProjectionReader } from "./discovery-display-projection";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

function discoveryFixture() {
  const checkpointJob = createSavedJob({
    id: "checkpoint_job",
    description: "checkpoint-only-body ".repeat(1600),
  });
  const run = DiscoveryRunRecordSchema.parse({
    id: "run_checkpoint",
    state: "running",
    scope: "run_all",
    startedAt: "2026-10-13T10:00:00.000Z",
    targetIds: ["target_checkpoint"],
    targetExecutions: [
      {
        targetId: "target_checkpoint",
        adapterKind: "auto",
        state: "running",
        agentCheckpoint: {
          revision: 7,
          savedAt: "2026-10-13T10:00:01.000Z",
          currentUrl: "https://jobs.example.com/roles/1",
          lastStableUrl: "https://jobs.example.com/roles/1",
          stepCount: 4,
          collectedJobs: [checkpointJob],
          visitedUrls: ["https://jobs.example.com/roles/1"],
          phaseEvidence: {},
        },
      },
    ],
    activity: [],
    summary: { targetsPlanned: 1, outcome: "running" },
  });
  return JobFinderDiscoveryStateSchema.parse({
    ...createSeed().discovery,
    runState: "running",
    activeRun: run,
    recentRuns: [{ ...run, id: "previous_checkpoint", state: "failed" }],
    pendingDiscoveryJobs: [
      createSavedJob({ id: "pending_display", title: "Pending listing" }),
    ],
    discoveryLedger: [
      DiscoveryLedgerEntrySchema.parse({
        id: "ledger_display",
        source: "target_site",
        targetId: "target_checkpoint",
        canonicalUrl: "https://jobs.example.com/roles/ledger",
        title: "Ledger listing",
        firstSeenAt: "2026-10-13T10:00:00.000Z",
        lastSeenAt: "2026-10-13T10:00:01.000Z",
      }),
    ],
  });
}

function rawFixture() {
  const db = new DatabaseSync(":memory:");
  cleanup.push(() => db.close());
  db.exec(
    "CREATE TABLE singleton_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  const put = (state: unknown) =>
    db
      .prepare(
        "INSERT INTO singleton_state VALUES ('discovery_state', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(state));
  return {
    db,
    put,
    read: createDiscoveryDisplayProjectionReader(db, createSeed().discovery),
  };
}

test("SQLite excludes checkpoint bodies before JS parses the display state", async () => {
  const { put, read } = rawFixture();
  const canonical = discoveryFixture();
  put(canonical);
  const parsing = vi.spyOn(JSON, "parse");
  const display = await read();
  const parsedJson = String(parsing.mock.calls[0]?.[0]);
  expect(parsedJson).not.toContain("checkpoint-only-body");
  expect(parsedJson.length).toBeLessThan(JSON.stringify(canonical).length / 8);
  expect(display.activeRun?.targetExecutions[0]?.agentCheckpoint).toBeNull();
  expect(
    display.recentRuns[0]?.targetExecutions[0]?.agentCheckpoint,
  ).toBeNull();
  expect(display.pendingDiscoveryJobs).toEqual(canonical.pendingDiscoveryJobs);
  expect(display.discoveryLedger).toEqual(canonical.discoveryLedger);
  expect(display.activeRun?.targetIds).toEqual(canonical.activeRun?.targetIds);
  expect(() =>
    display.pendingDiscoveryJobs[0]!.keySkills.push("accidental edit"),
  ).toThrow();
});

test("unrelated writes reuse the display state; discovery writes and key removal invalidate it", async () => {
  const { db, put, read } = rawFixture();
  put(discoveryFixture());
  const first = await read();
  db.exec("INSERT INTO singleton_state VALUES ('settings', '{}')");
  expect(await read()).toBe(first);
  put({ ...discoveryFixture(), runState: "completed" });
  expect((await read()).runState).toBe("completed");
  db.exec(
    "UPDATE singleton_state SET key='removed_discovery' WHERE key='discovery_state'",
  );
  expect((await read()).activeRun).toBeNull();
});

test("transaction reads never retain rolled-back discovery state when epochs are reused", async () => {
  const { db, put, read } = rawFixture();
  put(discoveryFixture());
  await read();
  db.exec("BEGIN");
  put({ ...discoveryFixture(), runState: "failed" });
  expect((await read()).runState).toBe("failed");
  db.exec("ROLLBACK");
  expect((await read()).runState).toBe("running");
  put({ ...discoveryFixture(), runState: "completed" });
  expect((await read()).runState).toBe("completed");
});

test("malformed discovery rows fail without disclosing their contents", async () => {
  const { db, put, read } = rawFixture();
  put(discoveryFixture());
  await read();
  db.exec("UPDATE singleton_state SET value='private-invalid-json'");
  await expect(read()).rejects.toThrow(
    'Corrupted persisted row in table "singleton_state"',
  );
  await expect(read()).rejects.not.toThrow("private-invalid-json");
  put({ ...discoveryFixture(), runState: "invalid-state" });
  await expect(read()).rejects.toThrow("Corrupted persisted row");
});

test("bootstrap and recovery checks do not load deferred history, pending jobs or ledger", async () => {
  const temp = await createTempRepository("nestor-discovery-bootstrap-");
  cleanup.push(temp.cleanup);
  const repo = await temp.createRepository();
  cleanup.push(() => repo.close());
  const state = discoveryFixture();
  await repo.commitDiscoveryStateUpdate(() => state);
  const raw = new DatabaseSync(temp.filePath);
  cleanup.push(() => raw.close());
  for (const row of raw
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='trigger'
    AND tbl_name IN ('discovery_runs','discovery_ledger','discovery_pending_jobs')`,
    )
    .all())
    raw.exec(`DROP TRIGGER "${String(row.name).replaceAll('"', '""')}"`);
  raw.exec("DROP INDEX workspace_ledger_activity_idx");
  // Deferred corruption must still fail a canonical read, but must not force
  // the shell or phase check to read unrelated history and listing bodies.
  raw.exec(`UPDATE discovery_runs SET value='private-invalid-history' WHERE active=0;
    UPDATE discovery_ledger SET value='private-invalid-ledger';
    UPDATE discovery_pending_jobs SET value='private-invalid-pending'`);
  const bootstrap = await repo.readDiscoveryBootstrapProjection();
  expect(bootstrap.activeRun?.id).toBe(state.activeRun?.id);
  expect(bootstrap.activeRun?.targetExecutions[0]?.agentCheckpoint).toBeNull();
  expect(bootstrap).not.toHaveProperty("recentRuns");
  expect(bootstrap).not.toHaveProperty("discoveryLedger");
  expect(bootstrap).not.toHaveProperty("pendingDiscoveryJobs");
  expect(await repo.readDiscoveryRunStates()).toEqual([
    { state: "running", runPhase: null, isActive: true },
    { state: "failed", runPhase: null, isActive: false },
  ]);
  await expect(async () => repo.getDiscoveryState()).rejects.toThrow(
    "Corrupted persisted row",
  );
});

for (const storage of ["memory", "file"] as const) {
  describe(`${storage} discovery display/canonical parity`, () => {
    async function repository(): Promise<JobFinderRepository> {
      if (storage === "memory")
        return createInMemoryJobFinderRepository(createSeed());
      const temp = await createTempRepository("nestor-discovery-display-");
      cleanup.push(temp.cleanup);
      const repo = await temp.createRepository();
      cleanup.push(() => repo.close());
      return repo;
    }

    test("display reads leave canonical checkpoint, pending-job, export and updater payloads intact", async () => {
      const repo = await repository();
      const canonical = discoveryFixture();
      await repo.commitDiscoveryStateUpdate(() => canonical);
      const display = await repo.readDiscoveryDisplayProjection();
      expect(await repo.readDiscoveryDisplayProjection()).toBe(display);
      const bootstrap = await repo.readDiscoveryBootstrapProjection();
      expect(bootstrap).toEqual({
        sessions: display.sessions,
        runState: display.runState,
        activeRun: display.activeRun,
        activeSourceDebugRun: display.activeSourceDebugRun,
      });
      expect(await repo.readDiscoveryRunStates()).toEqual([
        { state: "running", runPhase: null, isActive: true },
        { state: "failed", runPhase: null, isActive: false },
      ]);
      expect(
        display.activeRun?.targetExecutions[0]?.agentCheckpoint,
      ).toBeNull();
      expect(await repo.getDiscoveryState()).toEqual(canonical);
      expect((await repo.exportState()).discovery).toEqual(canonical);
      const owned = await repo.getDiscoveryState();
      owned.activeRun!.targetExecutions[0]!.agentCheckpoint!.collectedJobs[0]!.title =
        "Caller edit";
      expect(
        (await repo.getDiscoveryState()).activeRun?.targetExecutions[0]
          ?.agentCheckpoint?.collectedJobs[0]?.title,
      ).not.toBe("Caller edit");
      await repo.commitDiscoveryStateUpdate((current) => {
        expect(
          current.activeRun?.targetExecutions[0]?.agentCheckpoint?.revision,
        ).toBe(7);
        return { ...current, runState: "cancelled" };
      });
      expect((await repo.readDiscoveryDisplayProjection()).runState).toBe(
        "cancelled",
      );
      expect(
        (await repo.getDiscoveryState()).recentRuns[0]?.targetExecutions[0]
          ?.agentCheckpoint?.revision,
      ).toBe(7);
    });

    test("failed paired commits preserve jobs, canonical state and both cached projections", async () => {
      const repo = await repository();
      await repo.commitDiscoveryStateUpdate(() => discoveryFixture());
      const beforeDiscovery = await repo.readDiscoveryDisplayProjection();
      const beforeJobs = await repo.readSavedJobsProjection();
      await expect(
        repo.commitSavedJobDelta({
          upserts: [createSavedJob({ id: "rollback_job" })],
          updateDiscoveryState: () => {
            throw new Error("paired rollback");
          },
        }),
      ).rejects.toThrow("paired rollback");
      expect(await repo.readDiscoveryDisplayProjection()).toBe(beforeDiscovery);
      expect(await repo.readSavedJobsProjection()).toBe(beforeJobs);
      expect(
        (await repo.getDiscoveryState()).activeRun?.targetExecutions[0]
          ?.agentCheckpoint?.revision,
      ).toBe(7);
      expect(await repo.listSavedJobsByIds(["rollback_job"])).toEqual([]);
    });

    test("reset and state import invalidate projections without losing checkpoints or pending jobs", async () => {
      const repo = await repository();
      await repo.readDiscoveryDisplayProjection();
      await repo.readSavedJobsProjection();
      await repo.reset({
        ...createSeed(),
        discovery: discoveryFixture(),
        savedJobs: [createSavedJob({ id: "imported_job" })],
      });
      expect(
        (await repo.readDiscoveryDisplayProjection()).pendingDiscoveryJobs[0]
          ?.id,
      ).toBe("pending_display");
      expect(
        (await repo.readSavedJobsProjection()).map((job) => job.id),
      ).toEqual(["imported_job"]);
      const imported = await repo.exportState();
      await repo.reset(createSeed());
      expect(
        (await repo.readDiscoveryDisplayProjection()).activeRun,
      ).toBeNull();
      await repo.reset(imported);
      expect(
        (await repo.getDiscoveryState()).activeRun?.targetExecutions[0]
          ?.agentCheckpoint?.revision,
      ).toBe(7);
      expect(
        (await repo.readDiscoveryDisplayProjection()).activeRun
          ?.targetExecutions[0]?.agentCheckpoint,
      ).toBeNull();
    });
  });
}

test("other connections invalidate discovery display state and reopening retains canonical checkpoints", async () => {
  const temp = await createTempRepository("nestor-discovery-display-external-");
  cleanup.push(temp.cleanup);
  let repo = await temp.createRepository();
  cleanup.push(() => repo.close());
  await repo.commitDiscoveryStateUpdate(() => discoveryFixture());
  const before = await repo.readDiscoveryDisplayProjection();
  const other = new DatabaseSync(temp.filePath);
  try {
    other
      .prepare("UPDATE singleton_state SET value=? WHERE key='discovery_state'")
      .run(JSON.stringify({ ...discoveryFixture(), runState: "completed" }));
    const after = await repo.readDiscoveryDisplayProjection();
    expect(after).not.toBe(before);
    expect(after.runState).toBe("completed");
    expect(after.pendingDiscoveryJobs).toEqual(before.pendingDiscoveryJobs);
  } finally {
    other.close();
  }
  await repo.close();
  repo = await temp.createRepository();
  expect(
    (await repo.getDiscoveryState()).activeRun?.targetExecutions[0]
      ?.agentCheckpoint?.collectedJobs[0]?.description,
  ).toContain("checkpoint-only-body");
  expect((await repo.readDiscoveryDisplayProjection()).runState).toBe(
    "completed",
  );
});

test("display ledger follows in-place edits, appends, removals and moves in stored order", async () => {
  const temp = await createTempRepository("nestor-discovery-display-ledger-");
  cleanup.push(temp.cleanup);
  const repo = await temp.createRepository();
  cleanup.push(() => repo.close());
  const entry = (id: string, lastSeenAt = "2026-10-13T10:00:01.000Z") =>
    DiscoveryLedgerEntrySchema.parse({
      id,
      source: "target_site",
      targetId: "target_checkpoint",
      canonicalUrl: `https://jobs.example.com/roles/${id}`,
      title: `Listing ${id}`,
      firstSeenAt: "2026-10-13T10:00:00.000Z",
      lastSeenAt,
    });
  await repo.commitDiscoveryStateUpdate((current) => ({
    ...current,
    discoveryLedger: ["a", "b", "c", "d"].map((id) => entry(id)),
  }));
  const ids = async () =>
    (await repo.readDiscoveryDisplayProjection()).discoveryLedger.map(
      (row) => `${row.id}@${row.lastSeenAt}`,
    );
  const canonicalIds = async () =>
    (await repo.getDiscoveryState()).discoveryLedger.map(
      (row) => `${row.id}@${row.lastSeenAt}`,
    );
  const first = await repo.readDiscoveryDisplayProjection();
  const unchanged = first.discoveryLedger[0];

  // A sighting rewritten where it stands, and one listing appended.
  await repo.commitDiscoveryStateUpdate((current) => ({
    ...current,
    discoveryLedger: [
      ...current.discoveryLedger.map((row) =>
        row.id === "c" ? entry("c", "2026-10-14T10:00:00.000Z") : row,
      ),
      entry("e"),
    ],
  }));
  const second = await repo.readDiscoveryDisplayProjection();
  expect(second.discoveryLedger[0]).toBe(unchanged);
  expect(await ids()).toEqual(await canonicalIds());
  expect(await ids()).toEqual([
    "a@2026-10-13T10:00:01.000Z",
    "b@2026-10-13T10:00:01.000Z",
    "c@2026-10-14T10:00:00.000Z",
    "d@2026-10-13T10:00:01.000Z",
    "e@2026-10-13T10:00:01.000Z",
  ]);

  // A listing seen again moves to the end.
  await repo.commitDiscoveryStateUpdate((current) => ({
    ...current,
    discoveryLedger: [
      ...current.discoveryLedger.filter((row) => row.id !== "a"),
      entry("a", "2026-10-15T10:00:00.000Z"),
    ],
  }));
  expect(await ids()).toEqual(await canonicalIds());
  expect((await ids()).at(-1)).toBe("a@2026-10-15T10:00:00.000Z");

  // A removal, then a move to the front.
  await repo.commitDiscoveryStateUpdate((current) => ({
    ...current,
    discoveryLedger: current.discoveryLedger.filter((row) => row.id !== "b"),
  }));
  expect(await ids()).toEqual(await canonicalIds());
  await repo.commitDiscoveryStateUpdate((current) => ({
    ...current,
    discoveryLedger: [
      current.discoveryLedger.at(-1)!,
      ...current.discoveryLedger.slice(0, -1),
    ],
  }));
  expect((await ids())[0]).toBe("a@2026-10-15T10:00:00.000Z");
  expect(await ids()).toEqual(await canonicalIds());
});

test("display refreshes consume repeated changes without losing later edits or caching a rollback", async () => {
  const temp = await createTempRepository("nestor-discovery-display-repeated-");
  cleanup.push(temp.cleanup);
  const repo = await temp.createRepository();
  cleanup.push(() => repo.close());
  await repo.commitDiscoveryStateUpdate(() => discoveryFixture());
  const db = new DatabaseSync(temp.filePath);
  cleanup.push(() => db.close());
  const read = createDiscoveryDisplayProjectionReader(
    db,
    createSeed().discovery,
  );
  const initial = await read();
  const title = db.prepare(
    "UPDATE discovery_ledger SET value = json_set(value, '$.title', ?) WHERE id = 'ledger_display'",
  );
  title.run("First synthetic edit");
  title.run("Latest synthetic edit");
  const updated = await read();
  expect(updated.discoveryLedger[0]?.title).toBe("Latest synthetic edit");
  expect(initial.discoveryLedger[0]?.title).toBe("Ledger listing");
  expect(await read()).toBe(updated);

  db.exec("BEGIN");
  title.run("Rolled back synthetic edit");
  expect((await read()).discoveryLedger[0]?.title).toBe(
    "Rolled back synthetic edit",
  );
  db.exec("ROLLBACK");
  expect((await read()).discoveryLedger[0]?.title).toBe(
    "Latest synthetic edit",
  );
  title.run("Next committed synthetic edit");
  expect((await read()).discoveryLedger[0]?.title).toBe(
    "Next committed synthetic edit",
  );
  db.exec("DELETE FROM discovery_ledger WHERE id = 'ledger_display'");
  expect((await read()).discoveryLedger).toEqual([]);
  const recreated = {
    ...discoveryFixture().discoveryLedger[0]!,
    title: "Recreated synthetic listing",
  };
  db.prepare(
    "INSERT INTO discovery_ledger(id, position, value) VALUES (?, ?, ?)",
  ).run(recreated.id, 0, JSON.stringify(recreated));
  expect((await read()).discoveryLedger).toEqual([recreated]);
});
