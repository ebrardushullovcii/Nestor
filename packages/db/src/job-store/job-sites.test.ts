import { expect, test } from "vitest";
import { openJobStore, createJobSitesStore } from "./job-store";

test("bulk add explains duplicates and invalid entries; editing a site touches only that site", () => {
  const store = openJobStore(":memory:");
  try {
    const sites = createJobSitesStore(store);
    const added = sites.add({
      text: "https://jobs.example.test/one#jobs\nhttps://jobs.example.test/one\nnot a site\nhttps://jobs.example.test/two",
    });
    expect(added).toMatchObject({
      added: 2,
      duplicates: 1,
      duplicateUrls: ["https://jobs.example.test/one"],
      invalid: ["not a site"],
    });
    expect(sites.add({ text: "https://jobs.example.test/one" })).toMatchObject({
      added: 0,
      duplicates: 1,
      duplicateUrls: ["https://jobs.example.test/one"],
    });
    const before = sites.list();
    const first = before.rows.find((site) => site.url.endsWith("/one"))!;
    const other = before.rows.find((site) => site.url.endsWith("/two"))!;
    expect(
      sites.update({ id: first.id, enabled: false, label: "My employer" }),
    ).toMatchObject({ enabled: false, label: "My employer" });
    expect(sites.get(other.id)).toEqual(other);
    expect(
      sites.list({ filter: "disabled" }).rows.map((site) => site.id),
    ).toEqual([first.id]);
    expect(
      sites.list({ text: "employer" }).rows.map((site) => site.id),
    ).toEqual([first.id]);
    expect(sites.list({ text: "https://jobs.example.test/two" }).rows).toEqual([
      other,
    ]);
    expect(() => sites.update({ id: first.id, url: other.url })).toThrow(
      "already in your list",
    );
    expect(sites.remove(first.id)).toBe(true);
    expect(sites.enabled()).toEqual([other]);
  } finally {
    store.close();
  }
});

test("900 sites are read one indexed page at a time without loading a profile", () => {
  const store = openJobStore(":memory:");
  try {
    const sites = createJobSitesStore(store);
    expect(
      sites.add({
        text: Array.from(
          { length: 900 },
          (_, index) =>
            `https://board-${String(index).padStart(3, "0")}.example.test/jobs`,
        ).join("\n"),
      }).added,
    ).toBe(900);
    const first = sites.list();
    expect(first.rows).toHaveLength(25);
    expect(first.counts).toEqual({
      all: 900,
      enabled: 900,
      disabled: 0,
      needs_attention: 0,
    });
    const second = sites.list({ cursor: first.nextCursor });
    expect(second.rows).toHaveLength(25);
    expect(
      second.rows.some((site) =>
        first.rows.some((seen) => seen.id === site.id),
      ),
    ).toBe(false);
    expect(
      sites.list({ text: "board-899" }).rows.map((site) => site.url),
    ).toEqual(["https://board-899.example.test/jobs"]);
  } finally {
    store.close();
  }
});

test("each site edit has its own persisted Undo, with later edits and reused URLs protected", () => {
  const store = openJobStore(":memory:");
  try {
    const sites = createJobSitesStore(store);
    sites.add({ text: "http://127.0.0.1/board/\nhttp://127.0.0.1/lever/" });
    const addition = sites.takeUndo();
    const [first, second] = sites.list().rows;
    sites.setEnabled({ selection: { all: true, except: [] }, enabled: false });
    const switching = sites.takeUndo();
    sites.update({ id: first!.id, label: "Later name" });
    const rename = sites.takeUndo();
    // A newly created store instance reads the same persisted journal.
    const reopened = createJobSitesStore(store);
    expect(reopened.undo(switching.undoId!)).toEqual({
      changed: 2,
      skipped: 0,
    });
    expect(sites.get(first!.id)).toMatchObject({
      enabled: true,
      label: "Later name",
    });
    expect(sites.get(second!.id)?.enabled).toBe(true);
    sites.remove(second!.id);
    const removal = sites.takeUndo();
    sites.add({ text: second!.url });
    expect(reopened.undo(removal.undoId!)).toEqual({ changed: 0, skipped: 1 });
    expect(reopened.undo(addition.undoId!)).toEqual({ changed: 0, skipped: 2 });
    expect(reopened.undo(rename.undoId!)).toEqual({ changed: 1, skipped: 0 });
    expect(sites.list().total).toBe(2);
  } finally {
    store.close();
  }
});
