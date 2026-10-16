import { expect, test } from "vitest";
import {
  createAdaptiveConcurrencyLimiter,
  createConcurrencyLimiter,
} from "./concurrency-limiter";

test("queued permits are FIFO, release once, and survive operation failures", async () => {
  const limiter = createConcurrencyLimiter(1);
  const release = await limiter.acquire();
  const started: number[] = [];
  const first = limiter
    .run(() => {
      started.push(1);
      return Promise.reject(new Error("failed"));
    })
    .catch(() => undefined);
  const second = limiter.run(() => {
    started.push(2);
    return Promise.resolve("kept");
  });
  expect(started).toEqual([]);
  release();
  release();
  await first;
  expect(await second).toBe("kept");
  expect(started).toEqual([1, 2]);
  expect(await limiter.run(() => Promise.resolve("still usable"))).toBe(
    "still usable",
  );
});

test("an overloaded service halves new starts once per cool-down and successes restore them", async () => {
  let clock = 0;
  const limiter = createAdaptiveConcurrencyLimiter({
    max: 8,
    min: 2,
    coolDownMs: 1_000,
    now: () => clock,
  });
  const held = await Promise.all(
    Array.from({ length: 8 }, () => limiter.acquire()),
  );
  limiter.recordOverload();
  limiter.recordOverload();
  expect(limiter.capacity()).toBe(4);
  let started = false;
  const waiting = limiter.acquire().then((release) => {
    started = true;
    return release;
  });
  // Holders above the lowered capacity finish; the new start waits until
  // fewer than four are running.
  for (const release of held.slice(0, 4)) release();
  await Promise.resolve();
  expect(started).toBe(false);
  held[4]!();
  (await waiting)();
  expect(started).toBe(true);
  clock = 1_000;
  limiter.recordOverload();
  limiter.recordOverload();
  clock = 2_000;
  limiter.recordOverload();
  expect(limiter.capacity()).toBe(2);
  for (let index = 0; index < 10; index += 1) limiter.recordSuccess();
  expect(limiter.capacity()).toBe(8);
  for (const release of held.slice(5)) release();
});
