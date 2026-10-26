import { afterEach, beforeEach, expect, test } from "vitest";
import { openJobStore, resetJobStore, type JobStore } from "./job-store";
import { createActivityControlStore } from "./activity-control";

let store: JobStore;
beforeEach(() => {
  store = openJobStore(":memory:");
});
afterEach(() => store.close());

test("a new store runs; clearing it keeps work paused until the reset finishes", () => {
  const control = createActivityControlStore(store);
  expect(control.read().paused).toBe(false);
  resetJobStore(store);
  expect(control.read()).toMatchObject({
    paused: true,
    reason: expect.stringContaining("Reset everything didn't finish") as string,
  });
});
