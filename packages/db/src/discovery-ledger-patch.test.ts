import { DatabaseSync } from "node:sqlite";
import { DiscoveryLedgerEntrySchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { patchDiscoveryLedger } from "./index";
import {
  createTempRepository,
  cleanupTempDirectoryWithRetry,
} from "./file-repository.test-support";

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
      discoveryLedger: Array.from({ length: 3000 }, (_, i) =>
        entry(`ledger_${i}`),
      ),
    }));
    const before = await repo.readDiscoveryStateForRun!();
    const parse = vi.spyOn(DiscoveryLedgerEntrySchema, "parse");
    await repo.commitDiscoveryStateUpdate((current) => ({
      ...current,
      discoveryLedger: patchDiscoveryLedger(current.discoveryLedger, [
        {
          id: "ledger_20",
          update: (row) => ({ ...row!, latestStatus: "applied" }),
        },
        { id: "appended", update: () => entry("appended") },
      ]),
    }));
    expect(parse).toHaveBeenCalledTimes(1); // the new test row; owned writes are trusted
    parse.mockRestore();
    const committed = await repo.readDiscoveryStateForRun!();
    expect(committed.discoveryLedger[19]).toBe(before.discoveryLedger[19]);
    expect(committed.discoveryLedger[20]?.latestStatus).toBe("applied");
    expect(committed.discoveryLedger.at(-1)?.id).toBe("appended");
    await repo.commitDiscoveryStateUpdate((current) => ({
      ...current,
      discoveryLedger: patchDiscoveryLedger(current.discoveryLedger, [
        { id: "ledger_20", moveToEnd: true, update: (row) => row! },
      ]),
    }));
    const moved = await repo.readDiscoveryStateForRun!();
    expect(moved.discoveryLedger.at(-1)?.id).toBe("ledger_20");
    expect(moved.discoveryLedger[20]?.id).toBe("ledger_21");
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
      .run("ledger_21");
    await repo.commitDiscoveryStateUpdate((current) => ({
      ...current,
      discoveryLedger: patchDiscoveryLedger(current.discoveryLedger, [
        {
          id: "ledger_22",
          update: (row) => ({ ...row!, latestStatus: "enriched" }),
        },
      ]),
    }));
    const expected = (await repo.getDiscoveryState()).discoveryLedger;
    expect(expected.find((row) => row.id === "ledger_21")?.latestStatus).toBe(
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
