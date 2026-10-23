import type { BrowserContext, Page } from "playwright";
import { expect, test, vi } from "vitest";
import {
  restorePreparedForm,
  type PreparedFormSnapshot,
} from "./prepared-form-recovery";

const snapshot: PreparedFormSnapshot = {
  url: "https://jobs.example/apply",
  structure: "native-single-page",
  fields: [
    {
      type: "text",
      value: "Synthetic answer",
      checked: false,
      selected: [],
      files: [],
      disabled: false,
      readOnly: false,
    },
  ],
};

function setup(fresh: PreparedFormSnapshot | null, restored = snapshot) {
  const fill = vi.fn().mockResolvedValue(undefined);
  const goto = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  const page = {
    frames: () => [{}],
    isClosed: () => false,
    evaluate: vi
      .fn()
      .mockResolvedValueOnce(fresh)
      .mockResolvedValueOnce(restored),
    goto,
    close,
    locator: () => ({ nth: () => ({ fill }) }),
  } as unknown as Page;
  const context = {
    newPage: vi.fn().mockResolvedValue(page),
  } as unknown as BrowserContext;
  const guard = vi.fn().mockResolvedValue(undefined);
  return { page, context, fill, guard, goto, close };
}

test("a changed wizard or unsupported page is closed without refilling anything", async () => {
  const h = setup({ ...snapshot, structure: "first-step-after-reload" });
  expect(await restorePreparedForm({ ...h, snapshot, files: [] })).toBeNull();
  expect(h.fill).not.toHaveBeenCalled();
  expect(h.close).toHaveBeenCalledOnce();
  expect(h.guard.mock.invocationCallOrder[0]).toBeLessThan(
    h.goto.mock.invocationCallOrder[0]!,
  );
});

test("saved answers are accepted only after an exact readback", async () => {
  const h = setup(snapshot);
  expect(await restorePreparedForm({ ...h, snapshot, files: [] })).toBe(h.page);
  expect(h.fill).toHaveBeenCalledWith("Synthetic answer", { timeout: 3000 });
  expect(h.close).not.toHaveBeenCalled();
  const changed = setup(snapshot, {
    ...snapshot,
    fields: [{ ...snapshot.fields[0]!, value: "" }],
  });
  expect(
    await restorePreparedForm({ ...changed, snapshot, files: [] }),
  ).toBeNull();
  expect(changed.close).toHaveBeenCalledOnce();
});
