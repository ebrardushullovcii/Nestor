import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireLease,
  artifactName,
  isAlive,
  journal,
  ownedProcessIds,
  redact,
  sessionEnvironment,
  startFixtureSites,
  stopChild,
} from "./support.mjs";

test("one owner holds the lease; releasing it permits a later session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-lease-test-"));
  let lease = await acquireLease(root);
  try {
    await lease.update({ electronPid: 12345 });
    await assert.rejects(
      acquireLease(root),
      /Another QA session.*[\s\S]*12345/,
    );
    await lease.release();
    lease = await acquireLease(root);
  } finally {
    await lease.release();
    await rm(root, { recursive: true });
  }
});

test("ten explicit parallel owners coexist without losing updates or releasing a sibling's lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-parallel-lease-test-"));
  let leases = [];
  try {
    leases = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        acquireLease(root, {
          parallelGroup: "job-finder-check",
          sessionId: `lane-${index}`,
        }),
      ),
    );
    await Promise.all(
      leases.map((lease, index) =>
        lease.update({ electronPid: 12000 + index }),
      ),
    );
    const owners = await leases[0].owners();
    assert.equal(owners.length, 10);
    assert.deepEqual(
      owners.map((owner) => owner.electronPid).sort(),
      Array.from({ length: 10 }, (_, index) => 12000 + index),
    );
    await assert.rejects(acquireLease(root), /Another QA session/);
    await assert.rejects(
      acquireLease(root, {
        parallelGroup: "different-check",
        sessionId: "lane-0",
      }),
      /Another QA session/,
    );
    await assert.rejects(
      acquireLease(root, {
        parallelGroup: "job-finder-check",
        sessionId: "lane-0",
      }),
      /Another QA session/,
    );
    await Promise.all(leases.slice(1).map((lease) => lease.release()));
    assert.equal((await leases[0].owners()).length, 1);
    await assert.rejects(acquireLease(root), /Another QA session/);
    await leases[0].release();
    const exclusive = await acquireLease(root);
    await exclusive.release();
  } finally {
    await Promise.all(leases.map((lease) => lease.release()));
    await rm(root, { recursive: true });
  }
});

test("parallel opt-in cannot bypass an exclusive owner or use unsafe session names", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "qa-exclusive-lease-test-"),
  );
  const lease = await acquireLease(root);
  try {
    await assert.rejects(
      acquireLease(root, { parallelGroup: "group" }),
      /Another QA session/,
    );
    await assert.rejects(
      acquireLease(root, { sessionId: "lane" }),
      /requires an explicit parallelGroup/,
    );
    await assert.rejects(
      acquireLease(root, { parallelGroup: "../group" }),
      /artifact name/,
    );
    await assert.rejects(
      acquireLease(root, { parallelGroup: "group", sessionId: "../lane" }),
      /artifact name/,
    );
  } finally {
    await lease.release();
    await rm(root, { recursive: true });
  }
});

test(
  "Windows discovers and stops only an owned child tree",
  { skip: process.platform !== "win32" },
  async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); console.log(child.pid); setInterval(() => {}, 1000);",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let descendant;
    try {
      descendant = await new Promise((resolve, reject) => {
        child.stdout.once("data", (data) =>
          resolve(Number(data.toString().trim())),
        );
        child.once("error", reject);
      });
      const owned = await ownedProcessIds(child.pid);
      assert.ok(owned.includes(child.pid));
      assert.ok(owned.includes(descendant));
      assert.ok(!owned.includes(process.pid));
      await stopChild(child);
      assert.equal(isAlive(child.pid), false);
      assert.equal(isAlive(descendant), false);
      assert.equal(isAlive(process.pid), true);
    } finally {
      await stopChild(child);
    }
  },
);

test("deterministic mode strips credentials and conflicting Electron launch variables", async () => {
  const env = await sessionEnvironment("deterministic", {
    NESTOR_AI_API_KEY: "should-not-leak",
    OPENAI_API_KEY: "also-secret",
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_RENDERER_URL: "http://localhost:5173",
    NODE_OPTIONS: "--require some-hook",
    NESTOR_TEST_RESUME_PREVIEW: "fail_once",
    NESTOR_TEST_API_USE_LIVE_AI: "1",
    NESTOR_INTERVIEW_TEST_USE_LIVE_AI: "1",
  });
  assert.equal(env.NESTOR_AI_API_KEY, "");
  assert.equal(env.OPENAI_API_KEY, "");
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.ELECTRON_RENDERER_URL, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NESTOR_TEST_RESUME_PREVIEW, "fail_once");
  assert.equal(env.NESTOR_TEST_API_USE_LIVE_AI, "0");
  assert.equal(env.NESTOR_INTERVIEW_TEST_USE_LIVE_AI, "0");
  await assert.rejects(sessionEnvironment("typo"), /provider must/);
});

test("configured mode enables both real providers despite ambient test-mode flags", async () => {
  const env = await sessionEnvironment("configured", {
    NESTOR_AI_API_KEY: "synthetic-test-key",
    NESTOR_TEST_API_USE_LIVE_AI: "0",
    NESTOR_INTERVIEW_TEST_USE_LIVE_AI: "0",
  });
  assert.equal(env.NESTOR_AI_API_KEY, "synthetic-test-key");
  assert.equal(env.NESTOR_TEST_API_USE_LIVE_AI, "1");
  assert.equal(env.NESTOR_INTERVIEW_TEST_USE_LIVE_AI, "1");
});

test("both provider modes default to the embedded browser and preserve explicit host overrides", async () => {
  for (const provider of ["deterministic", "configured"]) {
    for (const unset of [undefined, ""]) {
      const defaultEnv = await sessionEnvironment(provider, {
        NESTOR_BROWSER_HOST: unset,
      });
      assert.equal(defaultEnv.NESTOR_BROWSER_HOST, "embedded");
    }
    for (const host of ["embedded", "external"]) {
      const env = await sessionEnvironment(provider, {
        NESTOR_BROWSER_HOST: host,
      });
      assert.equal(env.NESTOR_BROWSER_HOST, host);
    }
  }
});

test("artifact names cannot escape their session directory", () => {
  for (const name of ["../data", "/tmp/data", "a/b", "..", ""])
    assert.throws(() => artifactName(name));
  assert.equal(artifactName("profile-dark-1440"), "profile-dark-1440");
});

test("journal serializes asynchronous events and redacts known secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-journal-test-"));
  try {
    const events = journal(root, { NESTOR_AI_API_KEY: "test-secret" });
    events.record("first", "test-secret");
    events.record("second", "Bearer example-token");
    await events.flush();
    const entries = (await readFile(path.join(root, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      entries.map((entry) => entry.type),
      ["first", "second"],
    );
    assert.equal(entries[0].detail, "[redacted]");
    assert.equal(entries[1].detail, "Bearer [redacted]");
    assert.equal(redact("normal message"), "normal message");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("fixture servers use independent ports, keep POST evidence local, and close their own process", async () => {
  const firstDir = await mkdtemp(path.join(os.tmpdir(), "qa-sites-test-"));
  const secondDir = await mkdtemp(path.join(os.tmpdir(), "qa-sites-test-"));
  let first;
  let second;
  try {
    first = await startFixtureSites(firstDir);
    second = await startFixtureSites(secondDir);
    assert.notEqual(first.url, second.url);
    assert.equal((await fetch(`${first.url}board/`)).status, 200);
    await fetch(`${first.url}nonexistent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password: "synthetic-password",
        name: "Fictional Tester",
      }),
    });
    const log = await readFile(first.log, "utf8");
    assert.match(log, /Fictional Tester/);
    assert.doesNotMatch(log, /synthetic-password/);
    await first.close();
    assert.equal(isAlive(first.pid), false);
    assert.equal((await fetch(second.url)).status, 200);
  } finally {
    await first?.close();
    await second?.close();
    await rm(firstDir, { recursive: true });
    await rm(secondDir, { recursive: true });
  }
});
