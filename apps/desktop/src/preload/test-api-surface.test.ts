import { describe, expect, it, vi } from "vitest";

/**
 * The desktop test API is decided once, at preload module evaluation, from
 * NESTOR_ENABLE_TEST_API. This file therefore sets the flag before the
 * preload module is ever imported, so the enabled shape is observed in its own
 * module registry. `index.test.ts` covers the disabled shape the same way.
 */
const { mockExposeInMainWorld, mockInvoke } = vi.hoisted(() => {
  // Hoisted so the flag is set before the preload module is evaluated; a
  // plain module-level assignment would run after the hoisted import below.
  process.env.NESTOR_ENABLE_TEST_API = "1";
  return {
    mockExposeInMainWorld: vi.fn(),
    mockInvoke: vi.fn(),
  };
});

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: mockExposeInMainWorld,
  },
  ipcRenderer: {
    invoke: mockInvoke,
    off: vi.fn(),
    on: vi.fn(),
    send: vi.fn(),
  },
}));

import "./index";

type ExposedTestApi = {
  failNextSave: (surface: string) => Promise<unknown>;
  loadApplyQueueDemo: () => Promise<unknown>;
  loadWorkHistoryReviewDemo: () => Promise<unknown>;
};

const exposedTestApi = (() => {
  const exposed = mockExposeInMainWorld.mock.calls.at(-1)?.[1] as
    | { jobFinder: { test?: ExposedTestApi } }
    | undefined;
  if (!exposed) {
    throw new Error("Preload did not expose the nestor API.");
  }
  return exposed.jobFinder.test;
})();

describe("preload desktop test API surface when enabled", () => {
  it("exposes the one-shot save-failure hook over its typed channel", async () => {
    expect(exposedTestApi?.failNextSave).toBeTypeOf("function");

    // Preload also invokes a readiness channel of its own, so answer by
    // channel rather than queueing a single value.
    mockInvoke.mockImplementation((channel: string) =>
      channel === "job-finder:test-fail-next-save"
        ? Promise.resolve({ ok: true })
        : Promise.resolve(undefined),
    );

    await expect(exposedTestApi?.failNextSave("settings")).resolves.toEqual({
      ok: true,
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:test-fail-next-save",
      "settings",
    );
  });

  it("keeps the apply-queue demo loader on the same gated surface", () => {
    expect(exposedTestApi?.loadApplyQueueDemo).toBeTypeOf("function");
    expect(exposedTestApi?.loadWorkHistoryReviewDemo).toBeTypeOf("function");
  });
});
