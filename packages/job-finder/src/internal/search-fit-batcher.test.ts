import { afterEach, expect, test, vi } from "vitest";

import { createSearchFitBatcher } from "./search-fit-batcher";

afterEach(() => {
  vi.useRealTimers();
});

/** Three kept jobs every ten seconds for three minutes, like a slow site. */
async function trickle(maxWaitMs: number) {
  vi.useFakeTimers();
  const sizes: number[] = [];
  const firstScoreAt: number[] = [];
  const start = Date.now();
  const batcher = createSearchFitBatcher({
    batchSize: 20,
    concurrency: 3,
    partialWaitMs: 20_000,
    maxWaitMs,
    judge: (ids) => {
      sizes.push(ids.length);
      firstScoreAt.push(Date.now() - start);
      return new Promise((resolve) => setTimeout(resolve, 15_000));
    },
  });
  let next = 0;
  for (let second = 0; second < 180; second += 10) {
    batcher.enqueue([`job_${next++}`, `job_${next++}`, `job_${next++}`]);
    await vi.advanceTimersByTimeAsync(10_000);
  }
  const finishing = batcher.finish();
  await vi.advanceTimersByTimeAsync(60_000);
  await finishing;
  return { sizes, firstScoreAt: firstScoreAt[0] ?? null };
}

test("a slow search sends fuller batches and still shows its first scores early", async () => {
  // The earlier policy: anything waiting went after twenty seconds.
  const before = await trickle(20_000);
  const after = await trickle(90_000);

  console.info(
    `[token budget] fit batches for 54 trickled jobs: before ${before.sizes.join(",")} (${before.sizes.length} calls), after ${after.sizes.join(",")} (${after.sizes.length} calls)`,
  );
  expect(before.sizes.reduce((sum, size) => sum + size, 0)).toBe(54);
  expect(after.sizes.reduce((sum, size) => sum + size, 0)).toBe(54);
  expect(after.sizes.length).toBeLessThan(before.sizes.length);
  // After the quick first batch, none goes out less than half full until
  // the search ends.
  expect(Math.min(...after.sizes.slice(1, -1))).toBeGreaterThanOrEqual(10);
  // The first verdicts still arrive about twenty seconds in.
  expect(after.firstScoreAt).toBeLessThanOrEqual(20_000);
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
