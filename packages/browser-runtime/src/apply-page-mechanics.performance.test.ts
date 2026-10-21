import type { Page } from "playwright";
import { afterEach, expect, test, vi } from "vitest";

import {
  createPlaywrightApplyPageMechanics,
  readApplyStepLabel,
} from "./apply-page-mechanics";

afterEach(() => vi.useRealTimers());

test("native text writes read acceptance immediately without a per-field wait", async () => {
  vi.useFakeTimers();
  let value = "";
  const fill = vi.fn((answer: string) => {
    value = answer;
    return Promise.resolve();
  });
  const waitForTimeout = vi.fn(() => Promise.resolve());
  const page = {
    locator: () => ({
      nth: () => ({ fill, inputValue: () => Promise.resolve(value) }),
    }),
    waitForTimeout,
  } as unknown as Page;
  const started = Date.now();
  const mechanics = createPlaywrightApplyPageMechanics(page);
  for (let index = 0; index < 12; index++)
    await expect(
      mechanics.fillText(`c${index}`, "Robin Ashford"),
    ).resolves.toEqual({ ok: true, observedValue: "Robin Ashford" });
  expect(fill).toHaveBeenCalledTimes(12);
  expect(waitForTimeout).not.toHaveBeenCalled();
  expect(Date.now() - started).toBe(0);
});

test("apply and search page reads do not wait for an absent progress marker", async () => {
  vi.useFakeTimers();
  const evaluateAll = vi.fn((read: (elements: Element[]) => unknown) =>
    Promise.resolve(read([])),
  );
  // The previous single-element read waited one second when no marker existed.
  const innerText = vi.fn(
    () => new Promise((resolve) => setTimeout(() => resolve(""), 1_000)),
  );
  const locator = vi.fn(() => ({
    evaluateAll,
    first: () => ({ innerText, count: () => Promise.resolve(0) }),
  }));
  const page = { locator } as unknown as Pick<Page, "locator">;
  const started = Date.now();
  for (let read = 0; read < 42; read += 1) {
    await expect(readApplyStepLabel(page)).resolves.toBeNull();
  }
  expect(Date.now() - started).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(innerText).not.toHaveBeenCalled();
  expect(evaluateAll).toHaveBeenCalledTimes(42);
});

test("a page read failure still leaves progress unknown", async () => {
  const page = {
    locator: () => ({
      evaluateAll: () => Promise.reject(new Error("Page moved")),
    }),
  } as unknown as Pick<Page, "locator">;
  await expect(readApplyStepLabel(page)).resolves.toBeNull();
});

test("an accepted native toggle does not wait for a covered pointer target", async () => {
  vi.useFakeTimers();
  const setChecked = vi.fn(
    () => new Promise((resolve) => setTimeout(resolve, 5_000)),
  );
  const evaluate = vi.fn(() => Promise.resolve(true));
  const page = {
    locator: () => ({
      nth: () => ({
        scrollIntoViewIfNeeded: () => Promise.resolve(),
        evaluate,
        setChecked,
      }),
    }),
  } as unknown as Page;
  await expect(
    createPlaywrightApplyPageMechanics(page).setToggle("c0", true),
  ).resolves.toEqual({ ok: true, observedValue: "checked" });
  expect(evaluate).toHaveBeenCalledOnce();
  expect(setChecked).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
