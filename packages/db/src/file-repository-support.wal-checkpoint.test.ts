import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";

import {
  runImmediateTransaction,
  scheduleWalCheckpoints,
} from "./file-repository-support";
import { readWalCheckpointProgress } from "./internal/wal-checkpoint-progress";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function walDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "nestor-wal-"));
  const filePath = path.join(directory, "workspace.sqlite");
  const database = new DatabaseSync(filePath);
  database.exec(
    "PRAGMA journal_mode = WAL; CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT)",
  );
  cleanups.push(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { database, filePath };
}

test("folds the log in after writes pause, never inside a commit", () => {
  vi.useFakeTimers();
  const { database, filePath } = walDatabase();
  const stop = scheduleWalCheckpoints(database, filePath, {
    background: false,
  });
  cleanups.unshift(stop);
  expect(database.prepare("PRAGMA wal_autocheckpoint").get()).toEqual({
    wal_autocheckpoint: 0,
  });
  const exec = vi.spyOn(database, "exec");
  const checkpoints = () =>
    exec.mock.calls.filter(([sql]) => sql.includes("wal_checkpoint")).length;

  for (let index = 0; index < 3; index += 1) {
    runImmediateTransaction(database, () => {
      database
        .prepare("INSERT INTO rows (value) VALUES (?)")
        .run("x".repeat(50_000));
    });
    vi.advanceTimersByTime(1_000);
  }
  expect(checkpoints()).toBe(0);

  vi.advanceTimersByTime(2_000);
  expect(checkpoints()).toBe(1);
});

test("stopping the schedule leaves no checkpoint pending", () => {
  vi.useFakeTimers();
  const { database, filePath } = walDatabase();
  const stop = scheduleWalCheckpoints(database, filePath, {
    background: false,
  });
  const exec = vi.spyOn(database, "exec");
  runImmediateTransaction(database, () => {
    database.prepare("INSERT INTO rows (value) VALUES (?)").run("x");
  });
  void stop();
  vi.advanceTimersByTime(10_000);
  expect(
    exec.mock.calls.filter(([sql]) => sql.includes("wal_checkpoint")),
  ).toHaveLength(0);
});

test("a log past the cap is folded in by a worker, and closing waits for it", async () => {
  const { database, filePath } = walDatabase();
  const stop = scheduleWalCheckpoints(database, filePath);
  const exec = vi.spyOn(database, "exec");
  const sizeBefore = statSync(filePath).size;
  runImmediateTransaction(database, () => {
    const insert = database.prepare("INSERT INTO rows (value) VALUES (?)");
    for (let index = 0; index < 180; index += 1)
      insert.run("x".repeat(100_000));
  });
  // The worker closes its connection after the checkpoint it was sent.
  await stop();
  expect(
    exec.mock.calls.filter(([sql]) => sql.includes("wal_checkpoint")),
  ).toHaveLength(0);
  expect(statSync(filePath).size).toBeGreaterThan(sizeBefore + 16_000_000);
});

test("recycled WAL high-water size does not checkpoint every small commit", () => {
  vi.useFakeTimers();
  const { database, filePath } = walDatabase();
  const stop = scheduleWalCheckpoints(database, filePath, { background: false });
  cleanups.unshift(stop);
  const insert = database.prepare("INSERT INTO rows(value) VALUES (?)");
  runImmediateTransaction(database, () => insert.run("x".repeat(18_000_000)));
  const highWater = statSync(`${filePath}-wal`).size;
  expect(highWater).toBeGreaterThan(16 * 1024 * 1024);
  expect(readWalCheckpointProgress(filePath)?.frames).toBe(readWalCheckpointProgress(filePath)?.backfilled);
  const exec = vi.spyOn(database, "exec");
  for (let index = 0; index < 20; index++) {
    runImmediateTransaction(database, () => insert.run("small"));
    vi.advanceTimersByTime(100);
  }
  expect(statSync(`${filePath}-wal`).size).toBe(highWater);
  expect(exec.mock.calls.filter(([sql]) => sql.includes("wal_checkpoint"))).toHaveLength(0);
  vi.advanceTimersByTime(1_500);
  expect(exec.mock.calls.filter(([sql]) => sql.includes("wal_checkpoint"))).toHaveLength(1);
});

test("pinned readers allow retries only after another cap of committed frames", () => {
  vi.useFakeTimers();
  const { database, filePath } = walDatabase();
  const reader = new DatabaseSync(filePath);
  cleanups.unshift(() => reader.close());
  reader.exec("BEGIN; SELECT * FROM rows");
  const stop = scheduleWalCheckpoints(database, filePath, { background: false });
  cleanups.unshift(stop);
  const exec = vi.spyOn(database, "exec");
  const insert = database.prepare("INSERT INTO rows(value) VALUES (?)");
  runImmediateTransaction(database, () => insert.run("x".repeat(18_000_000)));
  expect(exec.mock.calls.filter(([sql]) => sql.includes("wal_checkpoint"))).toHaveLength(1);
  for (let index = 0; index < 20; index++) runImmediateTransaction(database, () => insert.run("small"));
  expect(exec.mock.calls.filter(([sql]) => sql.includes("wal_checkpoint"))).toHaveLength(1);
  runImmediateTransaction(database, () => insert.run("y".repeat(18_000_000)));
  expect(exec.mock.calls.filter(([sql]) => sql.includes("wal_checkpoint"))).toHaveLength(2);
  reader.exec("ROLLBACK");
  vi.advanceTimersByTime(1_500);
  const progress = readWalCheckpointProgress(filePath)!;
  expect(progress.backfilled).toBe(progress.frames);
});
