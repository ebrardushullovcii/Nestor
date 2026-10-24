import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import { createDiscoveryIdentityStore } from "./discovery-identity-store";

test("persisted exact-input aliases are reused across run indexes and candidates stay isolated", () => {
  const db = new DatabaseSync(":memory:");
  const first = createDiscoveryIdentityStore(db);
  const build = vi.fn(() => [
    {
      key: "listing-url:https://example.test/one",
      kind: "canonical_listing_url" as const,
      confidence: "strong" as const,
      priority: 40,
    },
  ]);
  first.put(1, "identity_v1:one", build);
  first.put(2, "identity_v1:one", build);
  expect(build).toHaveBeenCalledTimes(1);
  expect(first.read("identity_v1:one", build)).toEqual(
    build.mock.results[0]!.value,
  );
  expect(build).toHaveBeenCalledTimes(1);
  expect(first.find(["listing-url:https://example.test/one"])).toEqual([
    { key: "listing-url:https://example.test/one", id: 1 },
    { key: "listing-url:https://example.test/one", id: 2 },
  ]);
  first.remove(1);
  const second = createDiscoveryIdentityStore(db);
  expect(second.find(["listing-url:https://example.test/one"])).toEqual([]);
  second.put(7, "identity_v1:one", build);
  expect(build).toHaveBeenCalledTimes(1);
  expect(
    second.find(["listing-url:https://example.test/one"]).map((row) => row.id),
  ).toEqual([7]);
  first.close();
  second.close();
  db.close();
});

test("a failed batch rolls back cached keys and index rows together", () => {
  const db = new DatabaseSync(":memory:");
  const store = createDiscoveryIdentityStore(db);
  const build = vi.fn(() => [
    {
      key: "one",
      kind: "canonical_listing_url" as const,
      confidence: "strong" as const,
      priority: 40,
    },
  ]);
  expect(() =>
    store.batch(() => {
      store.put(1, "one", build);
      throw new Error("batch failed");
    }),
  ).toThrow("batch failed");
  expect(store.find(["one"])).toEqual([]);
  store.put(1, "one", build);
  expect(build).toHaveBeenCalledTimes(2);
  store.close();
  db.close();
});
