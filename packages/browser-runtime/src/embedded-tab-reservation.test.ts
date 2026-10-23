import type { BrowserContext } from "playwright";
import { expect, test, vi } from "vitest";
import {
  reserveEmbeddedApplicationTab,
  resolveAutomationPageForContext,
} from "./playwright-browser-runtime";

test("page resolution waits for its ownership claim before allowing navigation", async () => {
  let finish!: () => void;
  const claim = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onClaim = vi.fn(() => claim);
  const page = { isClosed: () => false, url: () => "about:blank" };
  const context = {
    pages: () => [],
    newPage: () => Promise.resolve(page),
  } as unknown as BrowserContext;
  let resolved = false;
  const pending = resolveAutomationPageForContext(context, {
    bringToFront: false,
    onPageResolved: onClaim,
  }).then(() => {
    resolved = true;
  });
  await vi.waitFor(() => expect(onClaim).toHaveBeenCalledOnce());
  expect(resolved).toBe(false);
  finish();
  await pending;
  expect(resolved).toBe(true);
});

test("host capacity admits work above the old seven/fifteen limits and counts concurrent reservations", async () => {
  const context = {
    pages: () => Array.from({ length: 24 }, () => ({ isClosed: () => false })),
  } as unknown as BrowserContext;
  const capacity = vi.fn((pending: number) => pending < 2);
  const first = await reserveEmbeddedApplicationTab(
    context,
    undefined,
    undefined,
    undefined,
    () => 24,
    () => 10,
    capacity,
  );
  const second = await reserveEmbeddedApplicationTab(
    context,
    undefined,
    undefined,
    undefined,
    () => 24,
    () => 10,
    capacity,
  );
  expect(capacity.mock.calls.map(([pending]) => pending)).toEqual([0, 1]);
  const controller = new AbortController();
  const third = reserveEmbeddedApplicationTab(
    context,
    controller.signal,
    undefined,
    undefined,
    () => 24,
    () => 10,
    capacity,
  );
  controller.abort();
  await expect(third).rejects.toMatchObject({ name: "AbortError" });
  first();
  first();
  second();
  const next = await reserveEmbeddedApplicationTab(
    context,
    undefined,
    undefined,
    undefined,
    () => 24,
    () => 10,
    capacity,
  );
  expect(capacity).toHaveBeenLastCalledWith(0);
  next();
});
