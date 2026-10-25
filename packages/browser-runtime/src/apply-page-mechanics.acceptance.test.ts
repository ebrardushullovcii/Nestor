import type { Page } from "playwright";
import { expect, test, vi } from "vitest";

import {
  createPlaywrightApplyPageMechanics,
  readApplyStepLabel,
} from "./apply-page-mechanics";

test("native text writes return the observed field value", async () => {
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
  const mechanics = createPlaywrightApplyPageMechanics(page);
  await expect(mechanics.fillText("c0", "Robin Ashford")).resolves.toEqual({
    ok: true,
    observedValue: "Robin Ashford",
  });
  expect(fill).toHaveBeenCalledOnce();
  expect(waitForTimeout).not.toHaveBeenCalled();
});

test("an absent progress marker is reported as unknown", async () => {
  const evaluateAll = vi.fn((read: (elements: Element[]) => unknown) =>
    Promise.resolve(read([])),
  );
  const innerText = vi.fn(() => Promise.resolve(""));
  const locator = vi.fn(() => ({
    evaluateAll,
    first: () => ({ innerText, count: () => Promise.resolve(0) }),
  }));
  const page = { locator } as unknown as Pick<Page, "locator">;
  await expect(readApplyStepLabel(page)).resolves.toBeNull();
  expect(innerText).not.toHaveBeenCalled();
  expect(evaluateAll).toHaveBeenCalledOnce();
});

test("a page read failure still leaves progress unknown", async () => {
  const page = {
    locator: () => ({
      evaluateAll: () => Promise.reject(new Error("Page moved")),
    }),
  } as unknown as Pick<Page, "locator">;
  await expect(readApplyStepLabel(page)).resolves.toBeNull();
});

test("an accepted native toggle reports its checked value", async () => {
  const setChecked = vi.fn(() => Promise.resolve());
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
});
