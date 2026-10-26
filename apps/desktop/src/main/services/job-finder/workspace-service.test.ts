import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { mockCreateJobFinderWorkspaceServiceAsync } = vi.hoisted(() => ({
  mockCreateJobFinderWorkspaceServiceAsync: vi.fn(),
}));

// The runtime under the workspace service (repository, browser, writers).
vi.mock("./create-workspace-service", () => ({
  createJobFinderRuntimeAsync: () => Promise.resolve({}),
  createJobFinderWorkspaceServiceAsync:
    mockCreateJobFinderWorkspaceServiceAsync,
}));

import {
  getJobFinderWorkspaceService,
  setJobFinderWorkspaceServiceTestEnv,
  shutdownJobFinderWorkspaceService,
} from "./workspace-service";

function deferredService(label: string) {
  let resolveService: (service: {
    label: string;
    shutdown: () => Promise<void>;
  }) => void;
  const ready = new Promise<{ label: string; shutdown: () => Promise<void> }>(
    (resolve) => {
      resolveService = resolve;
    },
  );
  return {
    ready: ready as Promise<{ label: string; shutdown: () => Promise<void> }>,
    resolve: () =>
      resolveService!({
        label,
        shutdown: () => Promise.resolve(),
      }),
  };
}

beforeEach(async () => {
  await setJobFinderWorkspaceServiceTestEnv(null);
});

afterEach(async () => {
  await shutdownJobFinderWorkspaceService();
  vi.clearAllMocks();
});

describe("getJobFinderWorkspaceService", () => {
  test("keeps a rejected initialization from staying memoized forever", async () => {
    const service = deferredService("retry-success");
    mockCreateJobFinderWorkspaceServiceAsync
      .mockReturnValueOnce(Promise.reject(new Error("startup failed")))
      .mockReturnValueOnce(service.ready);

    await expect(getJobFinderWorkspaceService()).rejects.toThrow(
      "startup failed",
    );
    expect(mockCreateJobFinderWorkspaceServiceAsync).toHaveBeenCalledTimes(1);

    service.resolve();
    await expect(getJobFinderWorkspaceService()).resolves.toMatchObject({
      label: "retry-success",
    });
    expect(mockCreateJobFinderWorkspaceServiceAsync).toHaveBeenCalledTimes(2);
  });

  test("preserves single-flight while creation is in flight and memoizes success", async () => {
    const service = deferredService("single-flight");
    mockCreateJobFinderWorkspaceServiceAsync.mockReturnValueOnce(service.ready);

    const firstCall = getJobFinderWorkspaceService();
    const secondCall = getJobFinderWorkspaceService();

    await vi.waitFor(() =>
      expect(mockCreateJobFinderWorkspaceServiceAsync).toHaveBeenCalledTimes(1),
    );

    service.resolve();
    await expect(firstCall).resolves.toMatchObject({ label: "single-flight" });
    await expect(secondCall).resolves.toBe(await firstCall);
    await expect(getJobFinderWorkspaceService()).resolves.toBe(await firstCall);
    expect(mockCreateJobFinderWorkspaceServiceAsync).toHaveBeenCalledTimes(1);
  });

  test("lets every concurrent caller observe the same rejection before retrying", async () => {
    const failingCreation = Promise.reject(new Error("shared failure"));
    mockCreateJobFinderWorkspaceServiceAsync.mockReturnValueOnce(
      failingCreation,
    );

    const firstCall = getJobFinderWorkspaceService();
    const secondCall = getJobFinderWorkspaceService();

    await expect(firstCall).rejects.toThrow("shared failure");
    await expect(secondCall).rejects.toThrow("shared failure");

    mockCreateJobFinderWorkspaceServiceAsync.mockResolvedValueOnce({
      label: "recovered",
      shutdown: () => Promise.resolve(),
    });
    await expect(getJobFinderWorkspaceService()).resolves.toMatchObject({
      label: "recovered",
    });
    expect(mockCreateJobFinderWorkspaceServiceAsync).toHaveBeenCalledTimes(2);
  });

  test("shutdown clears the cached instance and the override environment", async () => {
    mockCreateJobFinderWorkspaceServiceAsync.mockResolvedValueOnce({
      label: "first",
      shutdown: vi.fn().mockResolvedValue(undefined),
    });
    const firstInstance = await getJobFinderWorkspaceService();

    await setJobFinderWorkspaceServiceTestEnv(null);

    mockCreateJobFinderWorkspaceServiceAsync.mockResolvedValueOnce({
      label: "second",
      shutdown: () => Promise.resolve(),
    });
    await expect(getJobFinderWorkspaceService()).resolves.not.toBe(
      firstInstance,
    );
    expect(mockCreateJobFinderWorkspaceServiceAsync).toHaveBeenCalledTimes(2);
  });
});
