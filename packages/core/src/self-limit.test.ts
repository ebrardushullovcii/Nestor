import { afterEach, expect, test, vi } from "vitest";
import {
  reportSelfLimitHit,
  selfLimitSlice,
  selfLimitTimeout,
  forwardPageSelfLimitHit,
} from "./self-limit";
import {
  createAdaptiveConcurrencyLimiter,
  createConcurrencyLimiter,
} from "./concurrency-limiter";

afterEach(() => vi.restoreAllMocks());

test("records one structured event containing only the configured limit", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const hit = { limit: "turns", kind: "budget", value: 24, where: "runtime" };
  reportSelfLimitHit({ ...hit, ...{ answer: "private model answer" } });
  expect(log).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(String(log.mock.calls[0]![0]).slice("[self_limit_hit] ".length)),
  ).toEqual({ event: "self_limit_hit", ...hit });
});

test("only reports windows which actually omit evidence and preserves slice semantics", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(selfLimitSlice("abc", 0, 3, "text")).toBe("abc");
  expect(selfLimitSlice([1, 2], 0, 3, "array")).toEqual([1, 2]);
  expect(log).not.toHaveBeenCalled();
  expect(selfLimitSlice("abc", 0, 2, "text")).toBe("ab");
  expect(selfLimitSlice([1, 2, 3], -2, undefined, "array")).toEqual([2, 3]);
  expect(log).toHaveBeenCalledTimes(2);
  expect(log.mock.calls.every(([line]) => !String(line).includes("abc"))).toBe(
    true,
  );
});

test("forwards page metadata through the same reporter and ignores unrelated/malformed logs", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(forwardPageSelfLimitHit("ordinary page message")).toBe(false);
  expect(forwardPageSelfLimitHit("__nestor_self_limit__ broken")).toBe(true);
  expect(log).not.toHaveBeenCalled();
  forwardPageSelfLimitHit(
    '__nestor_self_limit__ {"limit":"links","kind":"count","value":400,"where":"page"}',
  );
  expect(log).toHaveBeenCalledOnce();
  expect(String(log.mock.calls[0]![0])).toContain('"event":"self_limit_hit"');
});

test("a caught browser deadline reports once without changing its error or successful results", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await selfLimitTimeout(Promise.resolve("kept"), 2000, "read")).toBe(
    "kept",
  );
  const timeout = Object.assign(new Error("Timeout 2000ms exceeded"), {
    name: "TimeoutError",
  });
  await expect(
    selfLimitTimeout(Promise.reject(timeout), 2000, "read"),
  ).rejects.toBe(timeout);
  await expect(
    selfLimitTimeout(Promise.reject(new Error("other failure")), 2000, "read"),
  ).rejects.toThrow("other failure");
  expect(
    await selfLimitTimeout(undefined, 2000, "optional read"),
  ).toBeUndefined();
  expect(log).toHaveBeenCalledTimes(1);
});

test.each(["fixed", "adaptive"])(
  "%s concurrency reports waiting, not unused capacity",
  async (kind) => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const limiter =
      kind === "fixed"
        ? createConcurrencyLimiter(1)
        : createAdaptiveConcurrencyLimiter({ max: 1 });
    const release = await limiter.acquire();
    expect(log).not.toHaveBeenCalled();
    const waiting = limiter.acquire();
    expect(log).toHaveBeenCalledTimes(1);
    release();
    (await waiting)();
  },
);
