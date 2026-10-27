// Run: node --test .claude/skills/verify-nestor/bin/lib/perf.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const perf = path.join(import.meta.dirname, "perf.mjs");
const run = (...args) =>
  spawnSync(process.execPath, [perf, ...args], { encoding: "utf8" });

test("--seed-into seeds the folder with the first size and measures nothing", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nestor-perf-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const out = path.join(root, "out");

  const result = run("--sizes", "40,20000", "--seed-into", data, "--out", out);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Seeded .* with 40 jobs and 30 job sites/u);
  const db = new DatabaseSync(path.join(data, "job-finder.sqlite"));
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM jobs").get().n, 40);
  } finally {
    db.close();
  }
  // No launch or screens run, so no report.
  assert.deepEqual(readdirSync(root), ["data"]);
  assert.match(result.stdout, /^Seeded [^\n]*\n$/u);
});

test("--seed-into refuses a folder that already holds something", (t) => {
  const data = mkdtempSync(path.join(os.tmpdir(), "nestor-perf-test-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  writeFileSync(path.join(data, "keep.txt"), "the person's file");

  const result = run("--sizes", "40", "--seed-into", data);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--seed-into takes an empty folder/u);
  assert.deepEqual(readdirSync(data), ["keep.txt"]);
});
