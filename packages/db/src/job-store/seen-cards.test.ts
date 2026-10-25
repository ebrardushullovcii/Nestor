import { expect, test } from "vitest";
import { openJobStore } from "./job-store";

test("remembers rejected cards without jobs; only changed cards or role goals need another decision", () => {
  const store = openJobStore(":memory:");
  try {
    const rejected = {
      url: "https://board.example/jobs/ABC?utm_source=first",
      cardFingerprint: "v1",
      roleGoalsKey: "analyst",
      verdict: "unrelated" as const,
    };
    store.rememberSeenCards([rejected]);
    const tracked = {
      ...rejected,
      url: "https://board.example/jobs/ABC?utm_source=repeat",
    };
    expect(store.lookupSeenCards([tracked], "analyst")).toEqual([tracked]);
    expect(
      store.lookupSeenCards(
        [{ ...tracked, cardFingerprint: "changed" }],
        "analyst",
      ),
    ).toEqual([]);
    expect(store.lookupSeenCards([tracked], "engineer")).toEqual([]);
    expect(
      store.lookupSeenCards(
        [{ ...tracked, url: "https://board.example/jobs/abc" }],
        "analyst",
      ),
    ).toEqual([]);
    expect(store.stageCounts().found).toBe(0);
    const before = store.db.prepare("SELECT total_changes() AS n").get();
    store.rememberSeenCards([tracked]);
    expect(store.db.prepare("SELECT total_changes() AS n").get()).toEqual(
      before,
    );
    expect(() =>
      store.transaction(() => {
        store.rememberSeenCards([{ ...tracked, roleGoalsKey: "new" }]);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(store.lookupSeenCards([tracked], "new")).toEqual([]);
  } finally {
    store.close();
  }
});
