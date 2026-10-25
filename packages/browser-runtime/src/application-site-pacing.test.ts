import { EventEmitter } from "node:events";
import type { Page, Response } from "playwright";
import { expect, test, vi } from "vitest";
import { createApplicationPreparationScheduler } from "./application-preparation-scheduler";
import { createApplicationSitePacing } from "./application-site-pacing";

function scenario() {
  const events = new EventEmitter();
  const frame = {};
  const url = "https://jobs.example/apply";
  const reload = vi.fn(() => {
    respond(200);
    return Promise.resolve();
  });
  const page = Object.assign(events, {
    url: () => url,
    mainFrame: () => frame,
    isClosed: () => false,
    reload,
  }) as unknown as Page;
  function respond(
    status: number,
    method = "GET",
    resourceType = "document",
    responseUrl = url,
  ) {
    events.emit("response", {
      url: () => responseUrl,
      status: () => status,
      frame: () => frame,
      headers: () => (status === 429 ? { "retry-after": "1" } : {}),
      request: () => ({
        method: () => method,
        resourceType: () => resourceType,
        isNavigationRequest: () => resourceType === "document",
      }),
    } as unknown as Response);
  }
  const scheduler = createApplicationPreparationScheduler();
  const pacing = createApplicationSitePacing(scheduler);
  pacing.observe(page);
  return { scheduler, pacing, page, respond, reload, url };
}

test("a rejected GET recovers after the site's wait without an agent turn", async () => {
  vi.useFakeTimers();
  try {
    const s = scenario();
    const lease = await s.scheduler.acquire(s.url);
    s.respond(429);
    const ready = s.pacing.waitForReady(s.page, lease);
    await vi.advanceTimersByTimeAsync(999);
    expect(s.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await ready;
    expect(s.reload).toHaveBeenCalledTimes(1);
    lease.release();
  } finally {
    vi.useRealTimers();
  }
});

test("a rejected form write waits but is never repeated or reloaded", async () => {
  vi.useFakeTimers();
  try {
    const s = scenario();
    const lease = await s.scheduler.acquire(s.url);
    s.respond(429, "POST");
    const ready = s.pacing.waitForReady(s.page, lease);
    await vi.advanceTimersByTimeAsync(1_000);
    await ready;
    expect(s.reload).not.toHaveBeenCalled();
    lease.release();
  } finally {
    vi.useRealTimers();
  }
});

test("a third-party fetch limit does not delay the application site", async () => {
  const s = scenario();
  const lease = await s.scheduler.acquire(s.url);
  s.respond(429, "GET", "fetch", "https://analytics.other.test/events");
  await s.pacing.waitForReady(s.page, lease);
  expect(s.reload).not.toHaveBeenCalled();
  lease.release();
});
