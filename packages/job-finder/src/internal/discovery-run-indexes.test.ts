import { DiscoveryLedgerEntrySchema, type JobPosting } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  createRunDiscoveryLedger,
  createSyncedJobIdentityIndex,
} from "./discovery-run-indexes";
import { recordDiscoveredPostingInLedger } from "./workspace-discovery-ledger";
import { createSeed } from "../workspace-service.test-fixtures";

type Row = {
  id: string;
  canonicalUrl: string;
  source: "target_site";
  sourceJobId: string;
  title: string;
};

const row = (id: string): Row => ({
  id,
  canonicalUrl: `https://jobs.example.test/${id}`,
  source: "target_site",
  sourceJobId: id,
  title: `Engineer ${id}`,
});

describe("createSyncedJobIdentityIndex", () => {
  test("invalidates frozen identity resolutions when the inventory changes", () => {
    const synced = createSyncedJobIdentityIndex<Row>((value) => value);
    const identity = Object.freeze(row("a"));
    const first = row("a");
    const index = synced.sync([first]);
    const matched = index.resolve(identity);
    expect(index.resolve(identity)).toBe(matched);
    const replacement = { ...first, title: "Updated" };
    synced.sync([replacement]);
    expect(index.resolve(identity)).toMatchObject({
      status: "matched",
      value: replacement,
    });
    index.remove(replacement);
    expect(index.resolve(identity).status).toBe("none");
  });
  test("follows the working list by identity and the merges made through it", () => {
    const synced = createSyncedJobIdentityIndex<Row>((value) => value);
    const a = row("a");
    const b = row("b");
    let index = synced.sync([a, b]);
    expect(index.find(row("a"))).toBe(a);

    const a2 = { ...a, title: "Engineer a (updated)" };
    index = synced.sync([a2, b]);
    expect(index.find(row("a"))).toBe(a2);

    const c = row("c");
    index.add(c);
    expect(index.find(row("c"))).toBe(c);
    // A rolled-back list drops what the merge added.
    index = synced.sync([a2, b]);
    expect(index.find(row("c"))).toBeNull();
    expect(index.find(row("b"))).toBe(b);
  });
});

describe("createRunDiscoveryLedger", () => {
  const posting = (id: string): JobPosting => ({
    ...createSeed().savedJobs[0]!,
    sourceJobId: id,
    canonicalUrl: `https://jobs.example.test/${id}`,
    applicationUrl: `https://jobs.example.test/${id}/apply`,
    title: `Engineer ${id}`,
  });
  const sighting = (id: string, seenAt: string) => ({
    posting: posting(id),
    targetId: "target",
    seenAt,
    status: "seen" as const,
  });

  test("records sightings in the same order as the array ledger", () => {
    const initial = ["one", "two", "three"].map((id) =>
      DiscoveryLedgerEntrySchema.parse({
        id: `ledger_${id}`,
        canonicalUrl: `https://jobs.example.test/${id}`,
        source: "target_site",
        sourceJobId: id,
        title: `Engineer ${id}`,
        targetId: "target",
        firstSeenAt: "2026-10-01T00:00:00.000Z",
        lastSeenAt: "2026-10-01T00:00:00.000Z",
      }),
    );
    const run = createRunDiscoveryLedger(initial);
    let array = initial;
    for (const [id, at] of [
      ["one", "2026-10-21T00:00:01.000Z"],
      ["four", "2026-10-21T00:00:02.000Z"],
      ["two", "2026-10-21T00:00:03.000Z"],
    ] as const) {
      run.record(sighting(id, at));
      array = recordDiscoveredPostingInLedger({
        ...sighting(id, at),
        ledger: array,
      });
    }
    const strip = (entries: readonly { id: string; title: string }[]) =>
      entries.map((entry) =>
        entry.id.startsWith("ledger_") ? entry.id : entry.title,
      );
    expect(strip(run.entries())).toEqual(strip(array));
    expect(strip(run.entries())).toEqual([
      "ledger_three",
      "ledger_one",
      "Engineer four",
      "ledger_two",
    ]);
  });

  test("marks a source's unlisted entries inactive in place and restores a rolled-back attempt", () => {
    const run = createRunDiscoveryLedger([]);
    run.record(sighting("one", "2026-10-21T00:00:01.000Z"));
    run.record(sighting("two", "2026-10-21T00:00:02.000Z"));
    const before = run.entries();
    expect(
      run.markInactive({
        targetId: "target",
        seenCanonicalUrls: ["https://jobs.example.test/two"],
        occurredAt: "2026-10-21T00:01:00.000Z",
        allowInactiveMarking: true,
      }),
    ).toBe(1);
    expect(run.entries().map((entry) => entry.latestStatus)).toEqual([
      "inactive",
      "seen",
    ]);
    expect(run.find(posting("one"))?.latestStatus).toBe("inactive");

    run.restore(before);
    expect(run.entries()).toBe(before);
    expect(run.find(posting("one"))?.latestStatus).toBe("seen");
  });
});
