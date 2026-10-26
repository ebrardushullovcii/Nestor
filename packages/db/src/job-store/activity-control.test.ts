import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openJobStore, resetJobStore, type JobStore } from "./job-store";
import {
  carryOverOldPause,
  createActivityControlStore,
  readOldPause,
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

function writeOldPause(paused: unknown) {
  const old = new DatabaseSync(oldFile);
  old.exec(
    "CREATE TABLE IF NOT EXISTS singleton_state(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  old
    .prepare("INSERT OR REPLACE INTO singleton_state(key,value) VALUES(?,?)")
    .run(
      "activity_control",
      typeof paused === "string" && paused.startsWith("raw:")
        ? paused.slice(4)
        : JSON.stringify({ paused, pausedAt: null, reason: "Old reason" }),
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

test.each([
  ['the text "true"', "true"],
  ["1", 1],
  ["null", null],
  ["no paused field", "raw:{}"],
  ["text that isn't JSON", "raw:paused"],
  ["a JSON array", "raw:[false]"],
])("an old pause of %s carries over as paused", (_name, value) => {
  writeOldPause(value);
  carryOverOldPause(store, oldFile);
  expect(createActivityControlStore(store).read()).toMatchObject({
    paused: true,
    reason: expect.stringContaining("Resume it when you're ready") as string,
  });
});

test("an old file with no pause row carries over as paused", () => {
  const old = new DatabaseSync(oldFile);
  old.exec(
    "CREATE TABLE singleton_state(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  old.close();
  carryOverOldPause(store, oldFile);
  expect(paused()).toBe(true);
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

test("only a clean `paused: false` ever reads as running (generated values)", () => {
  // A small deterministic generator: every JSON shape a stored value could
  // take, nested a little, plus non-JSON text.
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
  const leaves: unknown[] = [
    true,
    false,
    null,
    0,
    1,
    -1,
    "",
    "false",
    "true",
    "no",
    [],
    {},
  ];
  const value = (depth: number): unknown => {
    const pick = next() % (depth > 1 ? leaves.length : leaves.length + 2);
    if (pick < leaves.length) return leaves[pick];
    return pick === leaves.length
      ? [value(depth + 1)]
      : { paused: value(depth + 1) };
  };
  for (let n = 0; n < 300; n++) {
    const paused = value(0);
    const raw =
      n % 10 === 0
        ? `{"paused":${JSON.stringify(paused)}`
        : JSON.stringify(n % 3 === 0 ? paused : { paused });
    const old = new DatabaseSync(oldFile);
    old.exec(
      "CREATE TABLE IF NOT EXISTS singleton_state(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    old
      .prepare("INSERT OR REPLACE INTO singleton_state(key,value) VALUES(?,?)")
      .run("activity_control", raw);
    old.close();
    const clean = n % 10 !== 0 && n % 3 !== 0 && paused === false;
    expect(readOldPause(oldFile) === "running", raw).toBe(clean);
  }
});
