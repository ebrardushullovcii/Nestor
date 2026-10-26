import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listApplications: vi.fn(),
  stopApplication: vi.fn(),
}));
vi.mock("../services/job-finder/application-store", () => ({
  getApplicationStore: () => ({ listApplications: mocks.listApplications }),
}));
vi.mock("../services/job-store", () => ({ getJobStore: vi.fn() }));
vi.mock("../services/job-finder/test-api", () => ({
  isDesktopTestApiEnabled: () => false,
}));
vi.mock("../services/applications", () => ({
  getApplicationService: () =>
    Promise.resolve({ stopApplication: mocks.stopApplication }),
}));
vi.mock("../services/browser/embedded-browser", () => ({
  getEmbeddedBrowser: vi.fn(),
}));
vi.mock("../services/job-finder/runtime", () => ({
  startJobFinderRuntime: () => Promise.resolve({}),
}));

import { executeApplicationStoreCommand } from "./application-store";

beforeEach(() => vi.clearAllMocks());

// The preload passes these calls through, so main is where they are checked.
describe("application commands in main", () => {
  it("rejects a malformed selection before anything is queued", async () => {
    await expect(
      executeApplicationStoreCommand("apply-jobs", {
        selection: { ids: [-1] },
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("reads a list with the query's defaults filled in", async () => {
    mocks.listApplications.mockReturnValue({ rows: [], nextCursor: null });
    await expect(
      executeApplicationStoreCommand("list-applications", {
        state: "queued",
        limit: 20,
      }),
    ).resolves.toEqual({ rows: [], nextCursor: null });
    expect(mocks.listApplications).toHaveBeenCalledWith({
      state: "queued",
      cursor: null,
      limit: 20,
    });
  });

  it("does not send the renderer a malformed stop result", async () => {
    mocks.stopApplication.mockResolvedValue({ stopped: "yes" });
    await expect(
      executeApplicationStoreCommand("stop-application", { id: 3 }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});
