import { DiscoveryLedgerEntrySchema } from "@nestor/contracts";
import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import {
  cleanupTempDirectoryWithRetry,
  createTempRepository,
} from "./file-repository.test-support";
import { patchDiscoveryLedger } from "./index";

const entry = (id: string) =>
  DiscoveryLedgerEntrySchema.parse({
    id,
    source: "target_site",
    canonicalUrl: `https://example.test/jobs/${id}`,
    title: "Synthetic engineer",
    targetId: "synthetic",
    firstSeenAt: "2026-10-23T00:00:00.000Z",
    lastSeenAt: "2026-10-23T00:00:00.000Z",
  });

test("ledger patches trust typed rows, retain order, roll back and preserve external edits", async () => {
  const temp = await createTempRepository("nestor-ledger-patch-");
  let repo = await temp.createRepository();
  const raw = new DatabaseSync(temp.filePath);
  try {
    raw.exec(`CREATE TRIGGER fail_ledger_patch BEFORE INSERT ON discovery_ledger
      WHEN NEW.id = 'rolled_back' BEGIN SELECT RAISE(ABORT, 'patch failed'); END;`);
    await repo.commitDiscoveryStateUpdate((current) => ({
      ...current,
      discoveryLedger: Array.from({ length: 4 }, (_, i) =>
        entry(`ledger_${i}`),
      ),
    }));
    const before = await repo.readDiscoveryStateForRun!();
    const parse = vi.spyOn(DiscoveryLedgerEntrySchema, "parse");
    await repo.commitDiscoveryStateUpdate((current) => ({
      ...current,
      discoveryLedger: patchDiscoveryLedger(current.discoveryLedger, [
        {
          id: "ledger_1",
          update: (row) => ({ ...row!, latestStatus: "applied" }),
        },
        { id: "appended", update: () => entry("appended") },
      ]),
    }));
    expect(parse).toHaveBeenCalledTimes(1); // the new test row; owned writes are trusted
    parse.mockRestore();
    const committed = await repo.readDiscoveryStateForRun!();
    expect(committed.discoveryLedger[0]).toBe(before.discoveryLedger[0]);
    expect(committed.discoveryLedger[1]?.latestStatus).toBe("applied");
    expect(committed.discoveryLedger.at(-1)?.id).toBe("appended");
    await repo.commitDiscoveryStateUpdate((current) => ({
      ...current,
      discoveryLedger: patchDiscoveryLedger(current.discoveryLedger, [
        { id: "ledger_1", moveToEnd: true, update: (row) => row! },
      ]),
    }));
    const moved = await repo.readDiscoveryStateForRun!();
    expect(moved.discoveryLedger.at(-1)?.id).toBe("ledger_1");
    expect(moved.discoveryLedger[1]?.id).toBe("ledger_2");
    await expect(
      repo.commitDiscoveryStateUpdate((current) => ({
        ...current,
        discoveryLedger: patchDiscoveryLedger(current.discoveryLedger, [
          { id: "rolled_back", update: () => entry("rolled_back") },
        ]),
      })),
    ).rejects.toThrow();
    expect(await repo.readDiscoveryStateForRun!()).toBe(moved);
    raw
      .prepare(
        "UPDATE discovery_ledger SET value = json_set(value, '$.latestStatus', 'skipped') WHERE id = ?",
      )
      .run("ledger_2");
    await repo.commitDiscoveryStateUpdate((current) => ({
      ...current,
      discoveryLedger: patchDiscoveryLedger(current.discoveryLedger, [
        {
          id: "ledger_3",
          update: (row) => ({ ...row!, latestStatus: "enriched" }),
        },
      ]),
    }));
    const expected = (await repo.getDiscoveryState()).discoveryLedger;
    expect(expected.find((row) => row.id === "ledger_2")?.latestStatus).toBe(
      "skipped",
    );
    expect(expected.some((row) => row.id === "rolled_back")).toBe(false);
    await repo.close();
    repo = await temp.createRepository();
    expect((await repo.getDiscoveryState()).discoveryLedger).toEqual(expected);
  } finally {
    vi.restoreAllMocks();
    raw.close();
    await repo.close();
    await cleanupTempDirectoryWithRetry(temp.tempDirectory);
  }
});

test("large ledger patches preserve exact text and roll back earlier batches when a later row fails", async () => {
  const temp = await createTempRepository("nestor-ledger-batch-rollback-");
  let repo = await temp.createRepository();
  const raw = new DatabaseSync(temp.filePath);
  try {
    const initial = Array.from({ length: 260 }, (_, index) =>
      entry(`ledger_${index}`),
    );
    await repo.commitDiscoveryStateUpdate((current) => ({
      ...current,
      discoveryLedger: initial,
    }));
    const text = 'Synthetic "role" \\ path\nUnicode: 日本語 🚀\u0000end';
    const changes = initial.map((row) => ({
      id: row.id,
      update: (current: typeof row | null) => ({ ...current!, title: text }),
    }));
    const revision = () =>
      Number(
        raw
          .prepare(
            "SELECT COALESCE(MAX(revision), 0) AS revision FROM workspace_changes",
          )
          .get()!.revision,
      );
    raw.exec(`CREATE TRIGGER fail_late_ledger_patch BEFORE INSERT ON discovery_ledger
      WHEN NEW.id = 'ledger_250' BEGIN SELECT RAISE(ABORT, 'late patch failed'); END;`);
    const beforeRevision = revision();
    await expect(
      repo.commitDiscoveryStateUpdate((current) => ({
        ...current,
        discoveryLedger: patchDiscoveryLedger(current.discoveryLedger, changes),
      })),
    ).rejects.toThrow("late patch failed");
    expect((await repo.getDiscoveryState()).discoveryLedger).toEqual(initial);
    expect(revision()).toBe(beforeRevision);
    raw.exec("DROP TRIGGER fail_late_ledger_patch");
    await repo.commitDiscoveryStateUpdate((current) => ({
      ...current,
      discoveryLedger: patchDiscoveryLedger(current.discoveryLedger, changes),
    }));
    const expected = initial.map((row) => ({ ...row, title: text }));
    expect((await repo.getDiscoveryState()).discoveryLedger).toEqual(expected);
    const changedIds = raw
      .prepare(
        "SELECT item_id FROM workspace_changes WHERE revision > ? AND table_name = 'discovery_ledger'",
      )
      .all(beforeRevision)
      .map((row) => row.item_id);
    expect(changedIds).toEqual(initial.map((row) => row.id));
    await repo.close();
    repo = await temp.createRepository();
    expect((await repo.getDiscoveryState()).discoveryLedger).toEqual(expected);
  } finally {
    raw.close();
    await repo.close();
    await cleanupTempDirectoryWithRetry(temp.tempDirectory);
  }
});
