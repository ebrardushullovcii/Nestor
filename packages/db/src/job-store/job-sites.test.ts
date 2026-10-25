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
      invalid: ["not a site"],
    });
    expect(sites.add({ text: "https://jobs.example.test/one" })).toMatchObject({
      added: 0,
      duplicates: 1,
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
