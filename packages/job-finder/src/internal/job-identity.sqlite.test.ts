import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createFileJobFinderRepository } from "@nestor/db";
import { createSeed } from "../workspace-service.test-fixtures";
import { createJobIdentityIndex, type JobIdentityInput } from "./job-identity";
import { createRunDiscoveryLedger } from "./discovery-run-indexes";
import { DiscoveryLedgerEntrySchema } from "@nestor/contracts";

test("SQLite candidates preserve every alias intersection, ambiguity and replacement decision", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nestor-identity-parity-"));
  const repository = await createFileJobFinderRepository({
    filePath: path.join(dir, "workspace.sqlite"),
    seed: createSeed(),
  });
  const storage = repository.createDiscoveryIdentityStore?.();
  if (!storage) throw new Error("SQLite identity storage is unavailable");
  try {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: `row_${i}`,
      source: "target_site",
      sourceJobId: String(i),
      canonicalUrl: `https://source.example.test/jobs/${i}`,
      applicationUrl: `https://employer.example.test/apply/${i}`,
      title: `Engineer ${i % 10}`,
      company: `Synthetic Employer ${i % 7}`,
      location: "Remote",
      description: `Synthetic listing group ${i % 10}. ${"Build reliable software with a collaborative team. ".repeat(30)}`,
      matchAcrossSources: true,
    }));
    const memory = createJobIdentityIndex(rows, (value) => value);
    const sqlite = createJobIdentityIndex(
      rows,
      (value) => value,
      undefined,
      storage,
    );
    const queries: JobIdentityInput[] = rows.flatMap((row, i) => [
      row,
      { ...row, title: "Corrected title" },
      { ...row, canonicalUrl: rows[(i + 1) % rows.length]!.canonicalUrl },
      {
        ...row,
        sourceJobId: `other_${i}`,
        canonicalUrl: `https://other.example.test/roles/${i}`,
        applicationUrl: null,
      },
    ]);
    for (const query of queries)
      expect(sqlite.resolve(query)).toEqual(memory.resolve(query));
    const replacement = {
      ...rows[0]!,
      canonicalUrl: "https://source.example.test/replaced",
    };
    memory.replace(rows[0]!, replacement);
    sqlite.replace(rows[0]!, replacement);
    memory.remove(rows[1]!);
    sqlite.remove(rows[1]!);
    for (const query of queries)
      expect(sqlite.resolve(query)).toEqual(memory.resolve(query));
  } finally {
    storage.close();
    await repository.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite ledger keeps overlapping source baselines and restores failed attempts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nestor-ledger-parity-"));
  const seed = createSeed();
  const repository = await createFileJobFinderRepository({
    filePath: path.join(dir, "workspace.sqlite"),
    seed,
  });
  const storage = repository.createDiscoveryIdentityStore?.();
  if (!storage) throw new Error("SQLite identity storage is unavailable");
  try {
    const posting = {
      ...seed.savedJobs[0]!,
      sourceJobId: "one",
      canonicalUrl: "https://source.example.test/one",
    };
    const initial = DiscoveryLedgerEntrySchema.parse({
      ...posting,
      id: "entry",
      targetId: "source",
      firstSeenAt: "2026-10-01T00:00:00.000Z",
      lastSeenAt: "2026-10-01T00:00:00.000Z",
    });
    const ledger = createRunDiscoveryLedger([initial], storage);
    await ledger.warm();
    const baseline = ledger.captureSnapshot();
    const before = ledger.entries();
    ledger.record({
      posting,
      targetId: "source",
      seenAt: "2026-10-24T00:00:00.000Z",
      status: "seen",
    });
    expect(ledger.find(posting)?.lastSeenAt).toBe("2026-10-24T00:00:00.000Z");
    expect(baseline.find(posting)?.lastSeenAt).toBe(initial.lastSeenAt);
    ledger.restore(before);
    expect(ledger.find(posting)?.lastSeenAt).toBe(initial.lastSeenAt);
    baseline.release();
  } finally {
    storage.close();
    await repository.close();
    await rm(dir, { recursive: true, force: true });
  }
});
