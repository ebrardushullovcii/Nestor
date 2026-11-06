import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isAlive, ownedProcessTree, startTime } from "./common.mjs";

test("a folder path in a launcher's command line never grants cleanup ownership", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nestor-owned-processes-"));
  const create = () =>
    spawn(
      process.execPath,
      ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)", dir],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
  const owned = create(),
    other = create();
  try {
    await Promise.all(
      [owned, other].map(
        (child) => new Promise((resolve) => child.stdout.once("data", resolve)),
      ),
    );
    const started = startTime(owned.pid);
    assert.ok(started);
    const snapshot = ownedProcessTree([[owned.pid, started]]);
    assert.ok(snapshot.has(owned.pid));
    assert.equal(snapshot.has(other.pid), false);
    assert.equal(
      ownedProcessTree([[other.pid, "different birth time"]]).size,
      0,
    );
    owned.kill();
    assert.equal(isAlive(other.pid), true);
  } finally {
    if (!owned.killed) owned.kill();
    other.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
