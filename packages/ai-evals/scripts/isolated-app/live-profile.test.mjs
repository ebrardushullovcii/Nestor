import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  prepareLiveProfile,
  assertLiveProfile,
  profileProvenance,
  provenanceName,
} from "./live-profile.mjs";

test("persistent app-setup provenance survives reuse; synthetic seed cannot be blessed by reuse", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nestor-profile-test-"));
  try {
    const dir = path.join(root, "live");
    prepareLiveProfile(dir, [
      path.join(root, "repo"),
      path.join(root, "campaign"),
    ]);
    const initial = readFileSync(path.join(dir, provenanceName), "utf8");
    assert.equal(profileProvenance(dir).kind, "app_setup");
    assert.doesNotThrow(() => assertLiveProfile(dir, "live"));
    prepareLiveProfile(dir, []);
    assert.equal(readFileSync(path.join(dir, provenanceName), "utf8"), initial);
    writeFileSync(
      path.join(dir, provenanceName),
      JSON.stringify({
        kind: "synthetic",
        seedChannel: "job-finder:test-load-applications-store-demo",
      }),
    );
    prepareLiveProfile(dir, []);
    assert.throws(() => assertLiveProfile(dir, "live"), /seeded/);
    assert.doesNotThrow(() => assertLiveProfile(dir, "replica"));
    assert.throws(
      () =>
        prepareLiveProfile(path.join(root, "repo", "nested"), [
          path.join(root, "repo"),
        ]),
      /outside/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
