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
  importResumeFromPath: (sourcePath: string) => Promise<unknown>;
  loadApplicationsStoreDemo: (input: { sourceUrl: string }) => Promise<unknown>;
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
  it("imports a resume from a path over its typed channel", async () => {
    expect(exposedTestApi?.importResumeFromPath).toBeTypeOf("function");

    // Preload also invokes a readiness channel of its own, so answer by
    // channel rather than queueing a single value.
    const imported = { profile: {}, latestResumeImportRun: null };
    mockInvoke.mockImplementation((channel: string) =>
      channel === "job-finder:test-import-resume-from-path"
        ? Promise.resolve(imported)
        : Promise.resolve(undefined),
    );

    await expect(
      exposedTestApi?.importResumeFromPath("synthetic.txt"),
    ).resolves.toBe(imported);
    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:test-import-resume-from-path",
      { sourcePath: "synthetic.txt" },
    );
  });

  it("keeps the Applications demo loader on the same gated surface", () => {
    expect(exposedTestApi?.loadApplicationsStoreDemo).toBeTypeOf("function");
  });
});
