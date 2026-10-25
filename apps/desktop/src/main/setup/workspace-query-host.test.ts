import type { BrowserWindow } from "electron";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
  once: vi.fn(),
  whenReady: vi.fn(() => Promise.resolve()),
  fork: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  screenReady: vi.fn(() => Promise.resolve()),
  contextReady: vi.fn(() => Promise.resolve()),
  setMode: vi.fn(),
  exists: vi.fn(() => true),
  service: vi.fn(() => Promise.resolve()),
  prepare: vi.fn(),
  child: { postMessage: vi.fn(), once: vi.fn(), stderr: null },
  port1: {},
  port2: {},
}));
vi.mock("electron", () => ({
  app: { once: mocks.once, whenReady: mocks.whenReady },
  ipcMain: { handle: mocks.handle, on: mocks.on },
  utilityProcess: { fork: mocks.fork },
  MessageChannelMain: class {
    port1 = mocks.port1;
    port2 = mocks.port2;
  },
}));
vi.mock("node:fs", () => ({ existsSync: mocks.exists }));
vi.mock("@nestor/db", () => ({
  prepareWorkspaceQueryDatabase: mocks.prepare,
}));
vi.mock("@nestor/db/workspace-commits", () => ({
  subscribeWorkspaceCommits: mocks.subscribe,
}));
vi.mock("../services/job-finder/paths", () => ({
  getJobFinderWorkspaceFilePath: () => "workspace.sqlite",
}));
vi.mock("../services/job-finder/query-update-mode", () => ({
  setWorkspaceQueryUpdateMode: mocks.setMode,
}));
vi.mock("../services/job-finder", () => ({
  getJobFinderWorkspaceService: mocks.service,
}));
vi.mock("./workspace-database-startup", () => ({
  prepareWorkspaceScreenReads: mocks.screenReady,
  prepareWorkspaceStartupContextReads: mocks.contextReady,
  waitForWorkspaceDatabaseMigrations: () => Promise.resolve(),
}));
import { createWorkspaceQueryHost } from "./workspace-query-host";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fork.mockReturnValue(mocks.child);
  mocks.child.once.mockImplementation((name: string, listener: () => void) => {
    if (name === "spawn") listener();
  });
  mocks.subscribe.mockReturnValue(mocks.unsubscribe);
  mocks.whenReady.mockReturnValue(Promise.resolve());
  mocks.screenReady.mockReturnValue(Promise.resolve());
  mocks.contextReady.mockReturnValue(Promise.resolve());
  mocks.exists.mockReturnValue(true);
});
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function fixture() {
  const host = createWorkspaceQueryHost();
  const frame = { postMessage: vi.fn() };
  const webContents = { id: 1, mainFrame: frame, isDestroyed: () => false };
  host.attach({
    webContents,
    once: vi.fn(),
    isDestroyed: () => false,
  } as unknown as BrowserWindow);
  const connect = mocks.on.mock.calls[0]![1] as (event: object) => void;
  const read = mocks.handle.mock.calls[0]![1] as (
    event: object,
    payload: unknown,
  ) => unknown;
  return {
    host,
    frame,
    webContents,
    connect,
    read,
    event: { sender: webContents, senderFrame: frame },
  };
}
function exit() {
  const handler = mocks.child.once.mock.calls.find(
    ([name]) => name === "exit",
  )?.[1] as (() => void) | undefined;
  handler?.();
}
test("only the attached main frame receives the private read port or changes query mode", async () => {
  const f = fixture();
  await flush();
  f.connect({ sender: f.webContents, senderFrame: {} });
  await flush();
  expect(f.frame.postMessage).not.toHaveBeenCalled();
  expect(() =>
    f.read(
      { sender: f.webContents, senderFrame: {} },
      { method: "setQueryUpdates", input: { active: true } },
    ),
  ).toThrow("unavailable");
  f.connect(f.event);
  await flush();
  expect(mocks.child.postMessage).toHaveBeenCalledWith({ type: "attach" }, [
    mocks.port2,
  ]);
  expect(f.frame.postMessage).toHaveBeenCalledWith(
    "workspace-query:port",
    null,
    [mocks.port1],
  );
  f.read(f.event, { method: "setQueryUpdates", input: { active: true } });
  expect(mocks.setMode).toHaveBeenCalledWith(1, true);
  expect(() =>
    f.read(f.event, { method: "getStartupContext", input: {} }),
  ).toThrow("preload connection");
  expect(() =>
    f.read(f.event, { method: "setQueryUpdates", input: { active: "yes" } }),
  ).toThrow();
  const stop = f.host.close();
  exit();
  await stop;
});
test("the header is released before inventory preparation without opening a reader in main", async () => {
  let release!: () => void;
  mocks.screenReady.mockReturnValue(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const { host } = fixture();
  await flush();
  expect(mocks.child.postMessage).toHaveBeenCalledWith({
    type: "context-ready",
  });
  expect(mocks.child.postMessage).not.toHaveBeenCalledWith({
    type: "queries-ready",
  });
  expect(mocks.service).not.toHaveBeenCalled();
  release();
  await flush();
  expect(mocks.child.postMessage).toHaveBeenCalledWith({
    type: "queries-ready",
  });
  const stop = host.close();
  exit();
  await stop;
});
test("shutdown waits for the reader to release WAL and sends close once", async () => {
  const { host } = fixture();
  await flush();
  const stopped = vi.fn();
  const first = host.close().then(stopped);
  const second = host.close();
  await flush();
  expect(stopped).not.toHaveBeenCalled();
  expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  expect(
    mocks.child.postMessage.mock.calls.filter(
      ([message]) => (message as { type?: unknown }).type === "close",
    ),
  ).toHaveLength(1);
  exit();
  await first;
  await second;
  expect(stopped).toHaveBeenCalledOnce();
});
test("quitting before Electron ready does not spawn a process or open services", async () => {
  let release!: () => void;
  mocks.whenReady.mockReturnValue(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const { host } = fixture();
  await host.close();
  release();
  await flush();
  expect(mocks.fork).not.toHaveBeenCalled();
  expect(mocks.service).not.toHaveBeenCalled();
});
test("a new workspace is initialized once before both read gates are released", async () => {
  mocks.exists.mockReturnValue(false);
  const { host } = fixture();
  await vi.waitFor(() =>
    expect(mocks.child.postMessage).toHaveBeenCalledWith({
      type: "queries-ready",
    }),
  );
  expect(mocks.service).toHaveBeenCalledOnce();
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(mocks.child.postMessage).toHaveBeenCalledWith({
    type: "context-ready",
  });
  expect(mocks.child.postMessage).toHaveBeenCalledWith({
    type: "queries-ready",
  });
  const stop = host.close();
  exit();
  await stop;
});
