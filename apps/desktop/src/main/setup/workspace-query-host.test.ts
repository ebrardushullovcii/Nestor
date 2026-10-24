import type { BrowserWindow } from "electron";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  once: vi.fn(),
  prepare: vi.fn(),
  create: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  repository: {
    getChanges: vi.fn(() => ({ revision: 0 })),
    getStartupContext: vi.fn(() => ({})),
    close: vi.fn(),
  },
}));
vi.mock("electron", () => ({
  app: { once: mocks.once },
  ipcMain: { handle: mocks.handle },
}));
vi.mock("node:fs", () => ({ existsSync: () => true }));
vi.mock("@nestor/db", () => ({
  prepareWorkspaceQueryDatabase: mocks.prepare,
  createWorkspaceQueryRepository: mocks.create,
  subscribeWorkspaceCommits: mocks.subscribe,
}));
vi.mock("../services/job-finder/paths", () => ({
  getJobFinderWorkspaceFilePath: () => "workspace.sqlite",
}));
vi.mock("../services/job-finder/query-update-mode", () => ({
  setWorkspaceQueryUpdateMode: vi.fn(),
}));
vi.mock("./workspace-database-startup", () => ({
  prepareWorkspaceScreenReads: () => Promise.resolve(),
  waitForWorkspaceDatabaseMigrations: () => Promise.resolve(),
}));

import { createWorkspaceQueryHost } from "./workspace-query-host";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockReturnValue(mocks.repository);
  mocks.subscribe.mockReturnValue(mocks.unsubscribe);
});

function fixture() {
  const host = createWorkspaceQueryHost();
  const webContents = { id: 1, mainFrame: {} };
  host.attach({ webContents, once: vi.fn() } as unknown as BrowserWindow);
  const handler = mocks.handle.mock.calls[0]![1] as (
    event: { sender: typeof webContents; senderFrame: object },
    payload: unknown,
  ) => unknown;
  return {
    host,
    read: () =>
      handler(
        { sender: webContents, senderFrame: webContents.mainFrame },
        { method: "getStartupContext", input: {} },
      ),
  };
}

test("shutdown releases the reader once before the writer's clean close", async () => {
  const { host, read } = fixture();
  await read();
  expect(mocks.create).toHaveBeenCalledOnce();
  host.close();
  expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  expect(mocks.repository.close).toHaveBeenCalledOnce();
  await expect(read()).rejects.toThrow("The workspace is closing.");
  host.close();
  const willQuit = mocks.once.mock.calls[0]![1] as () => void;
  willQuit();
  expect(mocks.repository.close).toHaveBeenCalledOnce();
  expect(mocks.create).toHaveBeenCalledOnce();
});

test("quitting before the first query never opens a connection", async () => {
  const { host, read } = fixture();
  host.close();
  await expect(read()).rejects.toThrow("The workspace is closing.");
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});
