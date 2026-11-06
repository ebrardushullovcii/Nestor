import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import { afterEach, expect, test, vi } from "vitest";
import { withBrowserReadLiveness } from "./browser-read-liveness";
import { capturePreparedForm } from "./prepared-form-recovery";

afterEach(() => vi.useRealTimers());
const never = () => new Promise<never>(() => {});
function page() {
  return Object.assign(new EventEmitter(), {
    evaluate: () => Promise.resolve(),
  }) as unknown as Page & EventEmitter;
}

test("navigation during a post-action read returns the new document and destination", async () => {
  const browserPage = Object.assign(page(), {
    url: () => "https://employer.example.test/application",
    mainFrame: () => frame,
    waitForLoadState: () => Promise.resolve(),
  });
  const frame = {};
  let attempts = 0;
  const result = withBrowserReadLiveness(browserPage, () =>
    ++attempts === 1
      ? never()
      : Promise.resolve({ bodyText: "Application form" }),
  );
  await Promise.resolve();
  browserPage.emit("framenavigated", frame);
  await expect(result).resolves.toMatchObject({
    bodyText: "Application form",
    navigationNote:
      "The page navigated to https://employer.example.test/application.",
  });
  expect(attempts).toBe(2);
  expect(browserPage.listenerCount("framenavigated")).toBe(0);
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

test("a never-settling durable form capture cannot hold application completion", async () => {
  vi.useFakeTimers();
  const browserPage = Object.assign(page(), {
    isClosed: () => false,
    frames: () => [{}],
    evaluate: never,
  });
  const result = capturePreparedForm(browserPage);
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
