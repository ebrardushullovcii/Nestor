import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockExposeInMainWorld,
  mockInvoke,
  mockIpcRendererOff,
  mockIpcRendererOn,
  mockIpcRendererSend,
} = vi.hoisted(() => ({
  mockExposeInMainWorld: vi.fn(),
  mockInvoke: vi.fn(),
  mockIpcRendererOff: vi.fn(),
  mockIpcRendererOn: vi.fn(),
  mockIpcRendererSend: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: mockExposeInMainWorld,
  },
  ipcRenderer: {
    invoke: mockInvoke,
    off: mockIpcRendererOff,
    on: mockIpcRendererOn,
    send: mockIpcRendererSend,
  },
}));

import "./index";

type ExposedJobFinderApi = {
  applyJobs: Window["nestor"]["jobFinder"]["applyJobs"];
  listApplications: Window["nestor"]["jobFinder"]["listApplications"];
  getStartupResetRecovery: () => Promise<unknown>;
};

const exposedJobFinder = (() => {
  const exposed = mockExposeInMainWorld.mock.calls.at(-1)?.[1] as
    | { jobFinder: ExposedJobFinderApi }
    | undefined;
  if (!exposed) {
    throw new Error("Preload did not expose the nestor API.");
  }
  return exposed.jobFinder;
})();

describe("preload startup recovery boundary", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it("passes the startup reset recovery fact main checked", async () => {
    const fact = {
      status: "degraded",
      reason: "marker_quarantined_malformed",
      quarantinedFileName: "job-finder-reset-intent.invalid-a.json",
    };
    // The first feature call also waits for main's routes to be ready.
    mockInvoke.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === "job-finder:get-startup-reset-recovery"
          ? { ...fact }
          : { ready: true },
      ),
    );

    await expect(exposedJobFinder.getStartupResetRecovery()).resolves.toEqual(
      fact,
    );
    expect(mockInvoke).toHaveBeenCalledWith(
      "job-finder:get-startup-reset-recovery",
    );
  });
});

describe("preload desktop test API boundary", () => {
  it("omits the test surface entirely when the test API is disabled", () => {
    expect(process.env.NESTOR_ENABLE_TEST_API).not.toBe("1");
    expect(
      (exposedJobFinder as unknown as { test?: unknown }).test,
    ).toBeUndefined();
  });
});

it("exposes the store Apply selection and paged applications without a workspace response", async () => {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === "job-finder:apply-jobs")
      return Promise.resolve({ queued: 2, unchanged: 0, notApproved: 0 });
    if (channel === "job-finder:list-applications")
      return Promise.resolve({ rows: [], nextCursor: null });
    return Promise.resolve({ ready: true });
  });
  expect(
    await exposedJobFinder.applyJobs({ selection: { ids: [1, 2] } }),
  ).toEqual({ queued: 2, unchanged: 0, notApproved: 0 });
  expect(mockInvoke).toHaveBeenCalledWith("job-finder:apply-jobs", {
    selection: { ids: [1, 2] },
  });
  expect(
    await exposedJobFinder.listApplications({ state: "queued", limit: 20 }),
  ).toEqual({ rows: [], nextCursor: null });
  expect(mockInvoke).toHaveBeenCalledWith("job-finder:list-applications", {
    state: "queued",
    limit: 20,
  });
});
