import type { Page } from "playwright";
import { expect, test, vi } from "vitest";

import {
  createPlaywrightApplyPageMechanics,
  readApplyStepLabel,
} from "./apply-page-mechanics";

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
        elementHandles: () =>
          Promise.resolve([
            {
              evaluate: vi
                .fn()
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce({
                  present: true,
                  checked: true,
                  metadata: {
                    autocomplete: "",
                    name: "",
                    id: "",
                    label: "Terms",
                    placeholder: "",
                  },
                }),
              dispose: () => Promise.resolve(),
            },
          ]),
        setChecked,
      }),
    }),
  } as unknown as Page;
  await expect(
    createPlaywrightApplyPageMechanics(page).setToggle("c0", true),
  ).resolves.toMatchObject({
    ok: true,
    observedValue: "checked",
    controlState: { checked: true },
  });
  expect(evaluate).toHaveBeenCalledOnce();
  expect(setChecked).not.toHaveBeenCalled();
});
