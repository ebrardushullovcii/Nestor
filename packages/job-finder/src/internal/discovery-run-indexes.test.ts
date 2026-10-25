
import { describe, expect, test } from "vitest";

import {
  createSyncedJobIdentityIndex,
} from "./discovery-run-indexes";

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
