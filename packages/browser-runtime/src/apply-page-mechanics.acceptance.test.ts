import type { Page } from "playwright";
import { expect, test, vi } from "vitest";

import { readApplyStepLabel } from "./apply-page-mechanics";

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
