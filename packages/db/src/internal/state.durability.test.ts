import { DatabaseSync } from "node:sqlite";
import { describe, expect, test, vi } from "vitest";

import { normalizeLegacyDiscoveryState } from "./legacy";
import { runMigrations } from "./migrations";
import { bootstrapState, getSingletonValue } from "./state";
import { createSeed } from "../test-fixtures";

function openWorkspace(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  runMigrations(database);
  bootstrapState(database, createSeed());
  return database;
}

function writeDiscoveryBlob(database: DatabaseSync, value: unknown): void {
  database
    .prepare(
      "UPDATE singleton_state SET value = ? WHERE key = 'discovery_state'",
    )
    .run(JSON.stringify(value));
}

/**
 * `onInvalid` is an opt-in per call site. These cover the helper itself; no
 * production reader opts in yet (see the cross-group request for
 * `file-repository.ts` `getDiscoveryState`), so nothing here claims that a
 * workspace with an unnormalizable discovery blob currently opens.
 */
describe("getSingletonValue invalid-row handling", () => {
  test("fails closed by default so a corrupted row is never silently defaulted", () => {
    const database = openWorkspace();
    try {
      writeDiscoveryBlob(database, {
        sessions: "not-an-array",
        activeSourceDebugRun: 7,
      });

      expect(() =>
        getSingletonValue(database, "discovery_state", {
          parse: normalizeLegacyDiscoveryState,
        }),
      ).toThrow(/Corrupted persisted row in table "singleton_state"/u);
    } finally {
      database.close();
    }
  });

  test("returns null and warns when the caller opts into the fallback", () => {
    const database = openWorkspace();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeDiscoveryBlob(database, {
        sessions: "not-an-array",
        activeSourceDebugRun: 7,
      });

      expect(
        getSingletonValue(
          database,
          "discovery_state",
          { parse: normalizeLegacyDiscoveryState },
          { onInvalid: "fallback" },
        ),
      ).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("discovery_state");
    } finally {
      warn.mockRestore();
      database.close();
    }
  });

  test("still returns the persisted value when the fallback is opted into and the row is readable", () => {
    const database = openWorkspace();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const seed = createSeed();

      expect(
        getSingletonValue(
          database,
          "discovery_state",
          { parse: normalizeLegacyDiscoveryState },
          { onInvalid: "fallback" },
        ),
      ).toEqual(seed.discovery);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      database.close();
    }
  });
});
