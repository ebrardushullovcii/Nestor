import { afterEach, expect, test, vi } from "vitest";

import { createSearchFitBatcher } from "./search-fit-batcher";

afterEach(() => {
  vi.useRealTimers();
});

test("a full batch goes at once and calls stay within the concurrency", async () => {
  let inFlight = 0;
  let most = 0;
  const releases: Array<() => void> = [];
  const batcher = createSearchFitBatcher({
    batchSize: 20,
    concurrency: 2,
    partialWaitMs: 20_000,
    maxWaitMs: 90_000,
    judge: () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      return new Promise<void>((resolve) =>
        releases.push(() => {
          inFlight -= 1;
          resolve();
        }),
      );
    },
  });
  batcher.enqueue(Array.from({ length: 70 }, (_, index) => `job_${index}`));
  expect(releases).toHaveLength(2);
  expect(batcher.waiting).toBe(30);
  releases.shift()!();
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  const finishing = batcher.finish();
  while (releases.length > 0) {
    releases.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await finishing;
  expect(most).toBe(2);
  expect(batcher.waiting).toBe(0);
});

test("stop drops what is waiting and sends nothing more", async () => {
  vi.useFakeTimers();
  const judge = vi.fn(() => Promise.resolve());
  const batcher = createSearchFitBatcher({
    batchSize: 20,
    concurrency: 3,
    partialWaitMs: 20_000,
    maxWaitMs: 90_000,
    judge,
  });
  batcher.enqueue(["job_1", "job_2"]);
  batcher.stop();
  await vi.advanceTimersByTimeAsync(120_000);
  await batcher.finish();
  expect(judge).not.toHaveBeenCalled();
});

test("finishing drains pending jobs exactly once with freed source capacity", async () => {
  vi.useFakeTimers();
  const batches: string[][] = [];
  let inFlight = 0;
  let peak = 0;
  const batcher = createSearchFitBatcher({
    batchSize: 2,
    concurrency: 2,
    finishConcurrency: 3,
    partialWaitMs: 20000,
    maxWaitMs: 90000,
    judge: (ids) => {
      batches.push([...ids]);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          inFlight -= 1;
          resolve();
        }, 1),
      );
    },
  });
  const ids = Array.from({ length: 7 }, (_, i) => "job_" + i);
  batcher.enqueue(ids);
  expect(inFlight).toBe(2);
  const finishing = batcher.finish();
  expect(inFlight).toBe(3);
  await vi.runAllTimersAsync();
  await finishing;
  expect(peak).toBe(3);
  expect(batcher.waiting).toBe(0);
  expect(batches.flat()).toEqual(ids);
  expect(new Set(batches.flat()).size).toBe(ids.length);
});
