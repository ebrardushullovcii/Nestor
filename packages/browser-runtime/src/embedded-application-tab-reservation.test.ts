import { describe, expect, test, vi } from "vitest";
import type { BrowserContext, Page } from "playwright";
import {
  reserveEmbeddedApplicationTab,
  takeEmbeddedApplicationTab,
} from "./playwright-browser-runtime";

function fakeContext(urls: string[]) {
  const pages = urls.map((url) => {
    let closed = false;
    return {
      url: () => url,
      isClosed: () => closed,
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    } as unknown as Page;
  });
  return {
    pages,
    context: {
      pages: () => pages.filter((page) => !page.isClosed()),
    } as unknown as BrowserContext,
  };
}

describe("embedded application tab reservation", () => {
  test("closes an idle blank tab instead of refusing the next form", async () => {
    const { context, pages } = fakeContext([
      "about:blank",
      ...Array.from(
        { length: 6 },
        (_, index) => `https://jobs.example/apply/${index}`,
      ),
    ]);
    const release = await reserveEmbeddedApplicationTab(
      context,
      undefined,
      async () => {
        const idle = pages.find(
          (page) => !page.isClosed() && page.url() === "about:blank",
        );
        if (!idle) return false;
        await idle.close();
        return true;
      },
    );
    expect(pages[0]!.isClosed()).toBe(true);
    expect(pages.slice(1).every((page) => !page.isClosed())).toBe(true);
    release();
  });

  test("never closes a form page to make room", async () => {
    const { context, pages } = fakeContext(
      Array.from(
        { length: 7 },
        (_, index) => `https://jobs.example/apply/${index}`,
      ),
    );
    const controller = new AbortController();
    const reservation = reserveEmbeddedApplicationTab(
      context,
      controller.signal,
      () => Promise.resolve(false),
    );
    setTimeout(() => controller.abort(), 50);
    await expect(reservation).rejects.toBeTruthy();
    expect(pages.every((page) => !page.isClosed())).toBe(true);
  });

  test("a full browser waits for a tab and says so, instead of failing after 20 s", async () => {
    vi.useFakeTimers();
    try {
      const { context, pages } = fakeContext(
        Array.from(
          { length: 7 },
          (_, index) => `https://jobs.example/apply/${index}`,
        ),
      );
      const onWaiting = vi.fn();
      let settled = false;
      const reservation = reserveEmbeddedApplicationTab(
        context,
        undefined,
        () => Promise.resolve(false),
        onWaiting,
      ).then((release) => {
        settled = true;
        return release;
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(onWaiting).toHaveBeenCalledTimes(1);
      // Well past the old 20 s limit it is still waiting, not failed.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(false);
      expect(onWaiting).toHaveBeenCalledTimes(1);
      // A tab frees up (a sent application's page, or the person closes one).
      await pages[0]!.close();
      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(true);
      (await reservation)();
    } finally {
      vi.useRealTimers();
    }
  });

  test("counts the person's own tabs, which automation cannot see", async () => {
    const { context } = fakeContext(["https://jobs.example/apply/1"]);
    const controller = new AbortController();
    const onWaiting = vi.fn();
    const reservation = reserveEmbeddedApplicationTab(
      context,
      controller.signal,
      () => Promise.resolve(false),
      onWaiting,
      // One form plus six tabs the person opened: the host has seven.
      () => 7,
    );
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect(onWaiting).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(reservation).rejects.toBeTruthy();
  });
});

test("waiting forms release working slots without being closed", async () => {
  const { context, pages } = fakeContext(
    Array.from({ length: 12 }, (_, i) => `https://jobs.example/apply/${i}`),
  );
  const release = await reserveEmbeddedApplicationTab(
    context,
    undefined,
    undefined,
    undefined,
    () => 12,
    () => 2,
  );
  expect(pages.every((page) => !page.isClosed())).toBe(true);
  release();
});

test("the total cap still holds even when every form is waiting", async () => {
  const { context, pages } = fakeContext(
    Array.from({ length: 15 }, (_, i) => `https://jobs.example/apply/${i}`),
  );
  const controller = new AbortController();
  const reservation = reserveEmbeddedApplicationTab(
    context,
    controller.signal,
    undefined,
    () => undefined,
    () => 15,
    () => 0,
  );
  controller.abort();
  await expect(reservation).rejects.toBeTruthy();
  expect(pages.every((page) => !page.isClosed())).toBe(true);
});

test("memory pressure queues a new form without losing waiting tabs and wakes when capacity returns", async () => {
  vi.useFakeTimers();
  try {
    const { context, pages } = fakeContext(["https://jobs.example/apply/1"]);
    let capacity = false;
    let settled = false;
    const waiting = vi.fn();
    const reservation = reserveEmbeddedApplicationTab(
      context,
      undefined,
      undefined,
      waiting,
      () => 1,
      () => 0,
      () => capacity,
    ).then((release) => {
      settled = true;
      return release;
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(settled).toBe(false);
    expect(waiting).toHaveBeenCalledOnce();
    expect(pages[0]!.isClosed()).toBe(false);
    capacity = true;
    await vi.advanceTimersByTimeAsync(250);
    expect(settled).toBe(true);
    (await reservation)();
  } finally {
    vi.useRealTimers();
  }
});

test("taking a tab never waits and counts what is already taken", () => {
  const { context } = fakeContext([]);
  let working = 15;
  // The host has room while working tabs plus taken tabs stay under 16.
  const hasCapacity = (reserved: number) => working + reserved < 16;
  const take = (spare = 0) =>
    takeEmbeddedApplicationTab(context, () => working, () => working, hasCapacity, spare);
  const first = take();
  expect(first).toBeTypeOf("function");
  expect(take()).toBeNull();
  first!();
  first!();
  const second = take();
  expect(second).toBeTypeOf("function");
  second!();
  working = 14;
  expect(take(2)).toBeNull();
  expect(take(1)).toBeTypeOf("function");
});
