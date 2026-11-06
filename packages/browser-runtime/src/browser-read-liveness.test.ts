import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import { afterEach, expect, test, vi } from "vitest";
import { withBrowserReadLiveness } from "./browser-read-liveness";

afterEach(() => vi.useRealTimers());
const never = () => new Promise<never>(() => {});
function page() {
  return Object.assign(new EventEmitter(), {
    evaluate: () => Promise.resolve(),
  }) as unknown as Page & EventEmitter;
}

test("navigation during a read is an observation error, with the page retained", async () => {
  const browserPage = page();
  const result = withBrowserReadLiveness(browserPage, never);
  const rejection = expect(result).rejects.toThrow("observe again");
  browserPage.emit("framenavigated", browserPage.mainFrame?.());
  await rejection;
  expect(browserPage.listenerCount("response")).toBe(0);
});

test("a page read that never settles returns on actual browser connection silence", async () => {
  vi.useFakeTimers();
  const browserPage = page();
  const result = withBrowserReadLiveness(browserPage, never);
  const rejection = expect(result).rejects.toBeDefined();
  await vi.advanceTimersByTimeAsync(15_001);
  await rejection;
  expect(browserPage.listenerCount("response")).toBe(0);
});

test("real response progress keeps a long read alive without a total deadline", async () => {
  vi.useFakeTimers();
  const browserPage = page();
  let complete!: (value: string) => void;
  const result = withBrowserReadLiveness(
    browserPage,
    () =>
      new Promise<string>((resolve) => {
        complete = resolve;
      }),
  );
  for (let index = 0; index < 5; index++) {
    await vi.advanceTimersByTimeAsync(10_000);
    browserPage.emit("response", {});
  }
  complete("read completed after 50 seconds of progress");
  await expect(result).resolves.toContain("50 seconds");
});
