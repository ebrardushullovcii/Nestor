import { describe, expect, test, vi } from "vitest";
import {
  applicationSiteKey,
  applicationPreparationConcurrency,
  createApplicationPreparationScheduler,
} from "./application-preparation-scheduler";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test.each([
  [undefined, 16],
  ["16", 16],
  ["99", 16],
  ["1", 1],
  ["0", 1],
  ["bad", 16],
  ["2.5", 16],
] as const)("application concurrency %s resolves to %i", (value, expected) => {
  expect(applicationPreparationConcurrency(value)).toBe(expected);
});

describe("application preparation ownership", () => {
  test("a site's requested wait releases capacity for other sites and resumes at its deadline", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createApplicationPreparationScheduler(1);
      const limited = await scheduler.acquire("https://one.example/apply");
      scheduler.recordResponse("https://one.example/apply", 429, "2");
      let resumed = false;
      const waiting = limited.moveTo("https://one.example/apply").then(() => {
        resumed = true;
      });
      const other = await scheduler.acquire("https://two.test/apply");
      other.release();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(resumed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      limited.release();
      expect(resumed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("success returns a site to normal speed; missing Retry-After backs off repeated limits", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createApplicationPreparationScheduler();
      const now = Date.now();
      expect(scheduler.recordResponse("https://one.example/a", 429, null)).toBe(
        now + 1_000,
      );
      expect(scheduler.recordResponse("https://one.example/a", 429, null)).toBe(
        now + 2_000,
      );
      await vi.advanceTimersByTimeAsync(2_000);
      scheduler.recordResponse("https://one.example/a", 200, null);
      const lease = await scheduler.acquire("https://one.example/a");
      lease.release();
      expect(scheduler.recordResponse("https://one.example/a", 429, null)).toBe(
        Date.now() + 1_000,
      );
      expect(
        scheduler.recordResponse("https://two.test/a", 403, null),
      ).toBeNull();
      expect(
        scheduler.recordResponse("https://two.test/a", 503, null),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("an HTTP date or a long Retry-After is honored and stopping clears the waiter", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createApplicationPreparationScheduler();
      const date = new Date(Math.ceil(Date.now() / 1_000) * 1_000 + 5_000);
      expect(
        scheduler.recordResponse(
          "https://one.example/a",
          503,
          date.toUTCString(),
        ),
      ).toBe(date.getTime());
      expect(scheduler.recordResponse("https://two.test/a", 429, "86400")).toBe(
        Date.now() + 86_400_000,
      );
      const controller = new AbortController();
      const waiting = scheduler.acquire(
        "https://two.test/a",
        controller.signal,
      );
      controller.abort();
      await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  test("concurrent hands both wait for a busy redirect destination", async () => {
    const scheduler = createApplicationPreparationScheduler(2);
    const moving = await scheduler.acquire("https://first.example/apply");
    const busy = await scheduler.acquire("https://second.example/apply");
    let moved = 0;
    const moves = [
      moving.moveTo("https://second.example/form"),
      moving.moveTo("https://second.example/form"),
    ].map((pending) =>
      pending.then(() => {
        moved += 1;
      }),
    );
    await tick();
    expect(moved).toBe(0);
    busy.release();
    await Promise.all(moves);
    expect(moved).toBe(2);
    moving.release();
  });

  test("releasing a redirect waiter settles its pending hands and frees its slot", async () => {
    const scheduler = createApplicationPreparationScheduler(2);
    const moving = await scheduler.acquire("https://first.example/apply");
    const busy = await scheduler.acquire("https://second.example/apply");
    const pending = moving.moveTo("https://second.example/form");
    await tick();
    moving.release();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const other = await scheduler.acquire("https://third.example/apply");
    other.release();
    busy.release();
  });

  test("an unbounded requested capacity still admits at most sixteen workers", async () => {
    const scheduler = createApplicationPreparationScheduler(Infinity);
    const leases = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        scheduler.acquire(`https://site${index}.example/apply`),
      ),
    );
    let started = false;
    const next = scheduler
      .acquire("https://extra.example/apply")
      .then((lease) => {
        started = true;
        return lease;
      });
    await tick();
    expect(started).toBe(false);
    leases[0]!.release();
    (await next).release();
    for (const lease of leases) lease.release();
  });

  test("different sites overlap within the configured limit", async () => {
    const scheduler = createApplicationPreparationScheduler(2);
    const first = await scheduler.acquire("https://jobs.alpha.example/apply");
    const second = await scheduler.acquire("https://jobs.beta.test/apply");
    const third = scheduler.acquire("https://gamma.example/apply");
    let started = false;
    void third.then(() => {
      started = true;
    });
    await tick();
    expect(started).toBe(false);
    first.release();
    const thirdLease = await third;
    expect(started).toBe(true);
    second.release();
    thirdLease.release();
  });

  test("a redirect waiting on a busy site frees capacity for another site", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createApplicationPreparationScheduler(2);
      const first = await scheduler.acquire("https://one.example/apply");
      const busy = await scheduler.acquire("https://two.test/apply");
      let entered = false;
      const redirected = first.moveTo("https://two.test/next").then(() => {
        entered = true;
      });
      const other = await scheduler.acquire("https://three.example/apply");
      expect(entered).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      // The redirected application takes the released destination and counts
      // toward the worker limit again.
      busy.release();
      await redirected;
      expect(entered).toBe(true);
      let fourthStarted = false;
      const fourth = scheduler
        .acquire("https://four.test/apply")
        .then((lease) => {
          fourthStarted = true;
          return lease;
        });
      await vi.advanceTimersByTimeAsync(0);
      expect(fourthStarted).toBe(false);
      other.release();
      (await fourth).release();
      first.release();
    } finally {
      vi.useRealTimers();
    }
  });

  test("stopping a redirect waiter does not reserve the destination or a worker", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createApplicationPreparationScheduler(2);
      const controller = new AbortController();
      const first = await scheduler.acquire(
        "https://one.example/apply",
        controller.signal,
      );
      const busy = await scheduler.acquire("https://two.test/apply");
      const redirected = first.moveTo("https://two.test/next");
      controller.abort();
      await expect(redirected).rejects.toMatchObject({ name: "AbortError" });
      first.release();
      const other = await scheduler.acquire("https://three.example/apply");
      busy.release();
      const next = await scheduler.acquire("https://two.test/apply");
      expect(vi.getTimerCount()).toBe(0);
      next.release();
      other.release();
    } finally {
      vi.useRealTimers();
    }
  });

  test("subdomains of one site serialize", async () => {
    const scheduler = createApplicationPreparationScheduler(2);
    expect(applicationSiteKey("https://apply.example.com/a")).toBe(
      "example.com",
    );
    expect(applicationSiteKey("http://127.0.0.1:8080/apply")).toBe("127.0.0.1");
    expect(applicationSiteKey("http://127.0.0.2:8080/apply")).toBe("127.0.0.2");
    expect(applicationSiteKey("http://[::1]:8080/apply")).toBe("[::1]");
    const first = await scheduler.acquire("https://jobs.example.com/apply");
    const second = scheduler.acquire("https://account.example.com/form");
    let started = false;
    void second.then(() => {
      started = true;
    });
    await tick();
    expect(started).toBe(false);
    first.release();
    const secondLease = await second;
    expect(started).toBe(true);
    secondLease.release();
  });

  test("a redirect waits before work on the shared destination site", async () => {
    const scheduler = createApplicationPreparationScheduler(2);
    const first = await scheduler.acquire("https://one.example/apply");
    const second = await scheduler.acquire("https://two.test/apply");
    const redirected = second.moveTo("https://account.one.example/form");
    let moved = false;
    void redirected.then(() => {
      moved = true;
    });
    await tick();
    expect(moved).toBe(false);
    first.release();
    await redirected;
    expect(moved).toBe(true);
    second.release();
  });

  test("crossed redirects release old sites and do not deadlock", async () => {
    const scheduler = createApplicationPreparationScheduler(2);
    const first = await scheduler.acquire("https://one.example/apply");
    const second = await scheduler.acquire("https://two.test/apply");
    await Promise.all([
      first.moveTo("https://two.test/form"),
      second.moveTo("https://one.example/form"),
    ]);
    first.release();
    second.release();
  });

  test("an aborted waiter leaves capacity available", async () => {
    const scheduler = createApplicationPreparationScheduler(1);
    const first = await scheduler.acquire("https://one.example/apply");
    const controller = new AbortController();
    const waiting = scheduler.acquire(
      "https://two.test/apply",
      controller.signal,
    );
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    first.release();
    const next = await scheduler.acquire("https://three.example/apply");
    next.release();
  });

  test("a form waiting for a browser tab lets others on its site carry on", async () => {
    const scheduler = createApplicationPreparationScheduler(1);
    const retry = await scheduler.acquire(
      "http://127.0.0.1:47950/greenhouse/apply/9",
    );
    let tabFree: () => void = () => undefined;
    const waitingForTab = retry.suspend(
      () => new Promise<void>((resolve) => (tabFree = resolve)),
    );
    // Another application on the same site (and the only worker slot) is
    // not blocked by the retry that is waiting for a tab.
    const other = await scheduler.acquire(
      "http://127.0.0.1:47950/greenhouse/apply/8",
    );
    other.release();
    tabFree();
    await waitingForTab;
    // The retry has the site again after its wait.
    let thirdGranted = false;
    const third = scheduler
      .acquire("http://127.0.0.1:47950/greenhouse/apply/3")
      .then((lease) => {
        thirdGranted = true;
        return lease;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(thirdGranted).toBe(false);
    retry.release();
    (await third).release();
  });
});
