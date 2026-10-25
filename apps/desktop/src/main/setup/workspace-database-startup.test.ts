import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  exists: vi.fn(() => true),
  workers: [] as Array<{ emit(type: string, value: unknown): boolean }>,
}));
vi.mock("node:fs", () => ({ existsSync: state.exists }));
vi.mock("../services/job-finder/paths", () => ({
  getJobFinderWorkspaceFilePath: () => "private-workspace.sqlite",
}));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      constructor() {
        super();
        state.workers.push(this);
      }
    },
  };
});
beforeEach(() => {
  vi.resetModules();
  state.exists.mockReturnValue(true);
  state.workers.length = 0;
});

test("screen reads and typed actions are released before evidence finishes", async () => {
  const startup = await import("./workspace-database-startup");
  const reads = startup.prepareWorkspaceScreenReads();
  const writer = startup.prepareWorkspaceWriter();
  let complete = false;
  const migration = startup.waitForWorkspaceDatabaseMigrations().then(() => {
    complete = true;
  });
  const worker = state.workers[0]!;
  worker.emit("message", "context-ready");
  worker.emit("message", "queries-ready");
  await reads;
  expect(complete).toBe(false);
  worker.emit("message", "writer-ready");
  expect(await writer).toBe(true);
  expect(complete).toBe(false);
  worker.emit("message", "complete");
  await migration;
  expect(complete).toBe(true);
});

test("new workspaces and failed preparation retain canonical migration opening", async () => {
  state.exists.mockReturnValue(false);
  let startup = await import("./workspace-database-startup");
  expect(await startup.prepareWorkspaceWriter()).toBe(false);
  expect(state.workers).toHaveLength(0);
  vi.resetModules();
  state.exists.mockReturnValue(true);
  startup = await import("./workspace-database-startup");
  const writer = startup.prepareWorkspaceWriter();
  state.workers[0]!.emit("error", new Error("Preparation failed"));
  expect(await writer).toBe(false);
});
