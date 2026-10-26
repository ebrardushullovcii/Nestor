import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openJobStore, resetJobStore, type JobStore } from "./job-store";
import {
  carryOverOldPause,
  createActivityControlStore,
} from "./activity-control";

let dir: string;
let oldFile: string;
let store: JobStore;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "nestor-pause-"));
  oldFile = path.join(dir, "job-finder-workspace.sqlite");
  store = openJobStore(path.join(dir, "job-finder.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeOldPause(paused: boolean) {
  const old = new DatabaseSync(oldFile);
  old.exec(
    "CREATE TABLE IF NOT EXISTS singleton_state(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  old
    .prepare("INSERT OR REPLACE INTO singleton_state(key,value) VALUES(?,?)")
    .run(
      "activity_control",
      JSON.stringify({ paused, pausedAt: null, reason: "Old reason" }),
    );
  old.close();
}

const paused = () => createActivityControlStore(store).read().paused;

test("a pause set in the old workspace file stays set after the update", () => {
  writeOldPause(true);
  carryOverOldPause(store, oldFile);
  expect(paused()).toBe(true);
  // Taken once: the old file is not asked again.
  writeOldPause(false);
  carryOverOldPause(store, oldFile);
  expect(paused()).toBe(true);
});

test("a fresh install runs, and never creates the old workspace file", () => {
  carryOverOldPause(store, oldFile);
  expect(paused()).toBe(false);
  expect(existsSync(oldFile)).toBe(false);
  // Once decided, a later old file is never read for the pause.
  writeOldPause(true);
  carryOverOldPause(store, oldFile);
  expect(paused()).toBe(false);
});

test("an old file that was never paused leaves work running", () => {
  writeOldPause(false);
  carryOverOldPause(store, oldFile);
  expect(paused()).toBe(false);
});

test("an old file that can't be read leaves work paused, with a reason", () => {
  writeFileSync(oldFile, "not a database");
  carryOverOldPause(store, oldFile);
  expect(createActivityControlStore(store).read()).toMatchObject({
    paused: true,
    reason: expect.stringContaining("Resume it when you're ready") as string,
  });
});

test("Reset everything leaves work running, whatever the old file says", () => {
  writeOldPause(true);
  carryOverOldPause(store, oldFile);
  resetJobStore(store);
  carryOverOldPause(store, oldFile);
  expect(paused()).toBe(false);
});
