import { DatabaseSync } from "node:sqlite";
import {
  DiscoveryActivityEventSchema,
  DiscoveryLedgerEntrySchema,
  DiscoveryRunRecordSchema,
  type JobFinderDiscoveryState,
} from "@nestor/contracts";
import { afterEach, expect, test, vi } from "vitest";
import {
  createSavedJob,
  createTempRepository,
} from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";
import { createDiscoveryDisplayProjectionReader } from "./internal/discovery-display-projection";
import {
  createDiscoveryStorage,
  discoveryRowScope,
  readDiscoveryStorage,
  type DiscoveryDisplayRowCache,
} from "./internal/discovery-storage";

afterEach(() => vi.restoreAllMocks());

function ledger(id: string, title = id) {
  return DiscoveryLedgerEntrySchema.parse({
    id,
    title,
    canonicalUrl: `https://example.test/${encodeURIComponent(id)}`,
    source: "target_site",
    targetId: "synthetic",
    firstSeenAt: "2026-10-13T10:00:00.000Z",
    lastSeenAt: "2026-10-13T10:00:00.000Z",
  });
}

function run(id: string, targetId = "target") {
  return DiscoveryRunRecordSchema.parse({
    id,
    state: "completed",
    scope: "run_all",
    startedAt: "2026-10-13T10:00:00.000Z",
    targetIds: [targetId],
    targetExecutions: [
      { targetId, adapterKind: "auto", state: "completed", jobsFound: 1 },
    ],
    activity: [
      DiscoveryActivityEventSchema.parse({
        id: "event/with/delimiters",
        runId: id,
        timestamp: "2026-10-13T10:00:00.000Z",
        kind: "progress",
        stage: "navigation",
        message: `Synthetic ${id}`,
      }),
    ],
    summary: { targetsPlanned: 1, outcome: "completed" },
  });
}

test("moving the first of 10k ledger rows to last and removing the first pending row writes two rows", async () => {
  const temp = await createTempRepository("nestor-bounded-order-");
  let repo = await temp.createRepository();
  const raw = new DatabaseSync(temp.filePath);
  try {
    const template = createSavedJob();
    await repo.commitDiscoveryStateUpdate((current) => ({
      ...current,
      discoveryLedger: Array.from({ length: 10000 }, (_, index) =>
        ledger(`ledger_${index}`),
      ),
      pendingDiscoveryJobs: Array.from({ length: 10000 }, (_, index) => ({
        ...template,
        id: `pending_${index}`,
      })),
    }));
    raw.exec(
      "CREATE TABLE test_row_markers (table_name TEXT, operation TEXT, id TEXT)",
    );
    for (const table of ["discovery_ledger", "discovery_pending_jobs"]) {
      for (const event of ["INSERT", "UPDATE", "DELETE"]) {
        raw.exec(`CREATE TRIGGER test_${table}_${event} AFTER ${event} ON ${table}
          BEGIN INSERT INTO test_row_markers VALUES ('${table}', '${event}', ${event === "DELETE" ? "OLD" : "NEW"}.id); END`);
      }
    }
    // Creating audit triggers on another connection changes data_version.
    // Warm both caches after that external schema commit.
    raw.exec(`CREATE TRIGGER fail_synthetic_pending AFTER INSERT ON discovery_pending_jobs
      WHEN NEW.id = 'rollback_pending' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`);
    const before = await repo.getDiscoveryState();
    const displayBefore = await repo.readDiscoveryDisplayProjection();
    let borrowed: Readonly<JobFinderDiscoveryState> | null = null;
    await expect(
      repo.commitSavedJobDelta({
        upsertsFromBorrowedDiscovery: (current) => [
          current.pendingDiscoveryJobs[0]!,
        ],
        updateDiscoveryState: (current) => {
          borrowed = current;
          return {
            ...current,
            discoveryLedger: [
              ...current.discoveryLedger.slice(1),
              { ...current.discoveryLedger[0]!, latestStatus: "applied" },
            ],
            pendingDiscoveryJobs: [
              ...current.pendingDiscoveryJobs.slice(1),
              { ...current.pendingDiscoveryJobs[0]!, id: "rollback_pending" },
            ],
          };
        },
      }),
    ).rejects.toThrow();
    expect(
      raw.prepare("SELECT COUNT(*) AS count FROM test_row_markers").get()
        ?.count,
    ).toBe(0);
    expect(await repo.getDiscoveryState()).toEqual(before);
    expect(await repo.readDiscoveryDisplayProjection()).toBe(displayBefore);
    expect(await repo.listSavedJobsByIds(["pending_0"])).toEqual([]);

    await repo.commitSavedJobDelta({
      upsertsFromBorrowedDiscovery: (current) => [
        current.pendingDiscoveryJobs[0]!,
      ],
      updateDiscoveryState: (current) => {
        expect(current).toBe(borrowed);
        return {
          ...current,
          discoveryLedger: [
            ...current.discoveryLedger.slice(1),
            { ...current.discoveryLedger[0]!, latestStatus: "applied" },
          ],
          pendingDiscoveryJobs: current.pendingDiscoveryJobs.slice(1),
        };
      },
    });
    const markers = raw
      .prepare("SELECT table_name, operation, id FROM test_row_markers")
      .all();
    expect(markers).toEqual([
      { table_name: "discovery_ledger", operation: "INSERT", id: "ledger_0" },
      {
        table_name: "discovery_pending_jobs",
        operation: "DELETE",
        id: "pending_0",
      },
    ]);
    expect(
      raw
        .prepare("SELECT position FROM discovery_ledger WHERE id='ledger_0'")
        .get()?.position,
    ).toBe(10000);
    expect(
      raw
        .prepare("SELECT position FROM discovery_ledger WHERE id='ledger_1'")
        .get()?.position,
    ).toBe(1);
    expect(
      raw
        .prepare(
          "SELECT position FROM discovery_pending_jobs WHERE id='pending_1'",
        )
        .get()?.position,
    ).toBe(1);
    const expected = {
      ...before,
      discoveryLedger: [
        ...before.discoveryLedger.slice(1),
        { ...before.discoveryLedger[0]!, latestStatus: "applied" as const },
      ],
      pendingDiscoveryJobs: before.pendingDiscoveryJobs.slice(1),
    };
    expect(await repo.getDiscoveryState()).toEqual(expected);
    const displayAfter = await repo.readDiscoveryDisplayProjection();
    expect(displayAfter).toEqual(expected);
    expect(displayAfter.discoveryLedger[0]).toBe(
      displayBefore.discoveryLedger[1],
    );
    expect(displayAfter.pendingDiscoveryJobs[0]).toBe(
      displayBefore.pendingDiscoveryJobs[1],
    );
    await repo.close();
    repo = await temp.createRepository();
    expect(await repo.getDiscoveryState()).toEqual(expected);
    expect(await repo.readDiscoveryDisplayProjection()).toEqual(expected);
    console.info(
      "10k ledger move + 10k pending removal: 1 ledger INSERT, 1 pending DELETE; rollback markers 0",
    );
  } finally {
    raw.close();
    await repo.close();
    await temp.cleanup();
  }
}, 30000);

test("mid-list insertion, duplicate-id collisions, arbitrary reorder and exhausted ranks preserve complete order on restart", async () => {
  const temp = await createTempRepository("nestor-order-parity-");
  let repo = await temp.createRepository();
  try {
    const entries = [
      ledger("a"),
      ledger("duplicate", "first"),
      ledger("duplicate", "second"),
      ledger("duplicate#duplicate_1"),
      ledger("a/b"),
      ledger("b"),
    ];
    await repo.commitDiscoveryStateUpdate((current) => ({
      ...current,
      discoveryLedger: entries,
    }));
    let expected = [entries[0]!, ledger("middle"), ...entries.slice(1)];
    await repo.commitDiscoveryStateUpdate((current) => ({
      ...current,
      discoveryLedger: [
        current.discoveryLedger[0]!,
        expected[1]!,
        ...current.discoveryLedger.slice(1),
      ],
    }));
    const raw = new DatabaseSync(temp.filePath);
    try {
      expect(
        raw
          .prepare("SELECT position FROM discovery_ledger WHERE id='middle'")
          .get()?.position,
      ).toBe(0.5);
      expect(
        raw.prepare("SELECT position FROM discovery_ledger WHERE id='b'").get()
          ?.position,
      ).toBe(5);
    } finally {
      raw.close();
    }
    const permutations = [
      [5, 2, 0, 6, 3, 1, 4],
      [6, 5, 4, 3, 2, 1, 0],
      [1, 2, 3, 4, 5, 6, 0],
    ];
    for (const order of permutations) {
      expected = order.map((index) => expected[index]!);
      await repo.commitDiscoveryStateUpdate((current) => ({
        ...current,
        discoveryLedger: order.map((index) => current.discoveryLedger[index]!),
      }));
      expect((await repo.getDiscoveryState()).discoveryLedger).toEqual(
        expected,
      );
      await repo.close();
      repo = await temp.createRepository();
      expect((await repo.getDiscoveryState()).discoveryLedger).toEqual(
        expected,
      );
      expect(
        (await repo.readDiscoveryDisplayProjection()).discoveryLedger,
      ).toEqual(expected);
    }
    // Repeated insertions into the same gap eventually need rank compaction.
    for (let index = 0; index < 60; index += 1) {
      const inserted = ledger(`tiny_gap_${index}`);
      expected = [expected[0]!, inserted, ...expected.slice(1)];
      await repo.commitDiscoveryStateUpdate((current) => ({
        ...current,
        discoveryLedger: [
          current.discoveryLedger[0]!,
          inserted,
          ...current.discoveryLedger.slice(1),
        ],
      }));
    }
    await repo.close();
    repo = await temp.createRepository();
    expect((await repo.getDiscoveryState()).discoveryLedger).toEqual(expected);
  } finally {
    await repo.close();
    await temp.cleanup();
  }
});

test("warm display refresh batches 500 changed bodies in one indexed query and reuses other rows", async () => {
  const temp = await createTempRepository("nestor-batched-dirty-");
  const repo = await temp.createRepository();
  try {
    await repo.commitDiscoveryStateUpdate((current) => ({
      ...current,
      discoveryLedger: Array.from({ length: 1000 }, (_, index) =>
        ledger(`batch_${index}`),
      ),
    }));
  } finally {
    await repo.close();
  }
  const raw = new DatabaseSync(temp.filePath);
  try {
    const read = createDiscoveryDisplayProjectionReader(
      raw,
      createSeed().discovery,
    );
    const before = await read();
    raw.exec("BEGIN");
    for (let index = 0; index < 500; index += 1)
      raw
        .prepare("UPDATE discovery_ledger SET value=? WHERE id=?")
        .run(
          JSON.stringify(ledger(`batch_${index}`, `changed ${index}`)),
          `batch_${index}`,
        );
    raw.exec("COMMIT");
    const queries = vi.spyOn(raw, "prepare");
    const parse = vi.spyOn(JSON, "parse");
    const after = await read();
    const valueQueries = queries.mock.calls.filter(
      ([query]) =>
        /^SELECT id, (position, )?value FROM discovery_ledger/.test(query),
    );
    expect(valueQueries).toHaveLength(1);
    expect(valueQueries[0]![0]).toContain(
      "id IN (SELECT value FROM json_each(?))",
    );
    const plan = raw
      .prepare(`EXPLAIN QUERY PLAN ${valueQueries[0]![0]}`)
      .all(JSON.stringify(["batch_0"]));
    expect(
      plan.some((row) =>
        String(row.detail).includes("SEARCH discovery_ledger USING INDEX"),
      ),
    ).toBe(true);
    expect(
      queries.mock.calls.some(([query]) =>
        query.startsWith("SELECT value FROM discovery_ledger"),
      ),
    ).toBe(false);
    expect(parse.mock.calls).toHaveLength(501);
    expect(after.discoveryLedger[0]?.title).toBe("changed 0");
    expect(after.discoveryLedger[499]?.title).toBe("changed 499");
    expect(after.discoveryLedger[500]).toBe(before.discoveryLedger[500]);
    console.info(
      "500 dirty ledger rows: 1 indexed body query, 501 JSON parses including small singleton",
    );
  } finally {
    raw.close();
    await temp.cleanup();
  }
});

test("run scopes are pruned across 48 histories with delimiters and duplicate IDs", async () => {
  const temp = await createTempRepository("nestor-run-cache-pruning-");
  const repo = await temp.createRepository();
  await repo.close();
  const raw = new DatabaseSync(temp.filePath);
  try {
    const storage = createDiscoveryStorage(raw, createSeed().discovery);
    const cache: DiscoveryDisplayRowCache = {
      scopes: new Map(),
      dirty: new Map(),
    };
    for (let index = 0; index < 48; index += 1) {
      const before = storage.read();
      const nextRun = run(`run/${index}`);
      const recentRuns = [
        nextRun,
        { ...nextRun, summary: { ...nextRun.summary, jobsPersisted: 2 } },
        run(`run/${index}#duplicate_1`),
        ...before.recentRuns,
      ].slice(0, 5);
      raw.exec("BEGIN IMMEDIATE");
      const stored = storage.update({ ...before, recentRuns }, before);
      raw.exec("COMMIT");
      storage.publish(stored);
      readDiscoveryStorage(raw, createSeed().discovery, false, cache);
      const runIds = new Set(
        raw
          .prepare("SELECT id FROM discovery_runs")
          .all()
          .map((row) => String(row.id)),
      );
      expect(
        [...cache.scopes.values()]
          .filter((scope) => scope.runId)
          .every((scope) => runIds.has(scope.runId)),
      ).toBe(true);
      expect(cache.scopes.size).toBeLessThanOrEqual(runIds.size * 3 + 2);
      expect(
        [...cache.scopes.values()].reduce(
          (count, scope) => count + scope.values.size,
          0,
        ),
      ).toBeLessThanOrEqual(10);
    }
    const read = createDiscoveryDisplayProjectionReader(
      raw,
      createSeed().discovery,
    );
    let before = storage.read();
    raw.exec("BEGIN IMMEDIATE");
    const stored = storage.update(
      {
        ...before,
        recentRuns: [run("run", "nested/target"), run("run/nested", "target")],
      },
      before,
    );
    raw.exec("COMMIT");
    storage.publish(stored);
    const displayBefore = await read();
    raw
      .prepare(
        "UPDATE discovery_run_targets SET value=json_set(value, '$.jobsFound', 7) WHERE run_id='run' AND id='nested/target'",
      )
      .run();
    const displayAfter = await read();
    expect(displayAfter.recentRuns[0]?.targetExecutions[0]?.jobsFound).toBe(7);
    expect(displayAfter.recentRuns[1]?.targetExecutions[0]?.jobsFound).toBe(1);
    expect(displayAfter.recentRuns[1]?.activity[0]).toBe(
      displayBefore.recentRuns[1]?.activity[0],
    );
    expect(discoveryRowScope("discovery_run_targets", "run")).not.toBe(
      discoveryRowScope("discovery_run_targets", "run/nested"),
    );
    before = storage.read();
    raw.exec("BEGIN IMMEDIATE");
    const empty = storage.update({ ...before, recentRuns: [] }, before);
    raw.exec("COMMIT");
    storage.publish(empty);
    readDiscoveryStorage(raw, createSeed().discovery, false, cache);
    expect(cache.scopes.size).toBe(2);
    console.info(
      "48 run histories: at most 17 cache scopes / 10 retained rows; empty history returns to 2 global scopes",
    );
  } finally {
    raw.close();
    await temp.cleanup();
  }
});
