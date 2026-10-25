import { beforeEach, expect, test, vi } from "vitest";
import type {
  WorkspaceChanges,
  WorkspaceListCounts,
  WorkspaceQueryPortMessage,
} from "@nestor/contracts";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event?: unknown) => void>(),
  on: vi.fn(),
  send: vi.fn(),
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("electron", () => ({
  ipcRenderer: { on: mocks.on, send: mocks.send, invoke: mocks.invoke },
}));
import { createWorkspaceQueryBridge } from "./workspace-query";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.on.mockImplementation(
    (channel: string, handler: (event?: unknown) => void) => {
      mocks.handlers.set(channel, handler);
    },
  );
});
function connection() {
  const port = {
    postMessage: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
    onmessage: undefined as
      | ((event: { data: WorkspaceQueryPortMessage }) => void)
      | undefined,
    onmessageerror: undefined as (() => void) | undefined,
  };
  mocks.handlers.get("workspace-query:port")?.({ ports: [port] });
  return {
    port,
    emit: (message: WorkspaceQueryPortMessage) =>
      port.onmessage?.({ data: message }),
  };
}
const counts = (n: number): WorkspaceListCounts => ({
  discovery: n,
  dismissed: 0,
  shortlisted: 0,
  applications: 0,
  companies: 0,
  all: n,
});
test("requests queued before port transfer resolve by id, even out of order", async () => {
  const api = createWorkspaceQueryBridge();
  const first = api.getListCounts(),
    second = api.getListCounts({ planId: null });
  expect(mocks.send).toHaveBeenCalledWith("workspace-query:connect");
  const { port, emit } = connection();
  expect(port.postMessage).toHaveBeenCalledTimes(2);
  emit({ type: "reply", id: 2, ok: true, value: counts(2) });
  emit({ type: "reply", id: 1, ok: true, value: counts(1) });
  await expect(first).resolves.toEqual(counts(1));
  await expect(second).resolves.toEqual(counts(2));
  expect(mocks.invoke).not.toHaveBeenCalled();
});
test("the port reports validation errors and forwards change batches to current subscribers", async () => {
  const api = createWorkspaceQueryBridge();
  const listener = vi.fn(),
    off = api.onChanges(listener);
  const { emit } = connection();
  const read = api.getListCounts();
  emit({ type: "reply", id: 1, ok: false, error: "Invalid workspace query." });
  await expect(read).rejects.toThrow("Invalid workspace query.");
  const batch: WorkspaceChanges = {
    changes: [],
    revision: 5,
    hasMore: false,
    lists: ["discovery"],
  };
  emit({ type: "changes", value: batch });
  expect(listener).toHaveBeenCalledWith(batch);
  off();
  emit({ type: "changes", value: batch });
  expect(listener).toHaveBeenCalledOnce();
});
test("reader loss rejects pending and later reads instead of leaving them waiting", async () => {
  const api = createWorkspaceQueryBridge();
  const { port } = connection();
  const read = api.getListCounts();
  mocks.handlers.get("workspace-query:unavailable")?.();
  await expect(read).rejects.toThrow("unavailable");
  await expect(api.getListCounts()).rejects.toThrow("unavailable");
  expect(port.close).toHaveBeenCalledOnce();
});
test("legacy query-update mode still uses the authorized main IPC", async () => {
  const api = createWorkspaceQueryBridge();
  await api.setQueryUpdates(true);
  expect(mocks.invoke).toHaveBeenCalledWith("workspace-query:read", {
    method: "setQueryUpdates",
    input: { active: true },
  });
});
