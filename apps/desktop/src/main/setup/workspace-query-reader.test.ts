import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import type {
  WorkspaceChanges,
  QueryJobListResult,
  WorkspaceQueryPortMessage,
} from "@nestor/contracts";

const state = vi.hoisted(() => ({ trace: [] as string[] }));
vi.mock("@nestor/db", () => {
  const counts = {
    discovery: 0,
    dismissed: 0,
    shortlisted: 0,
    applications: 0,
    companies: 0,
    all: 0,
  };
  return {
    createWorkspaceQueryRepository: () => ({
      getChanges: (): WorkspaceChanges => ({
        changes: [],
        revision: 0,
        hasMore: false,
        lists: [],
      }),
      queryJobList: (): QueryJobListResult => {
        state.trace.push("page read");
        return {
          rows: [],
          total: 0,
          counts,
          revision: 0,
          facets: {
            recommendations: [],
            sources: [],
            workModes: [],
            activities: [],
            locationReach: [],
            assessed: 0,
            newSince: null,
          },
          resumeDrafts: [],
          applications: [],
          applyResults: [],
        };
      },
    }),
  };
});

const originalParent = Object.getOwnPropertyDescriptor(process, "parentPort");
afterEach(() => {
  if (originalParent)
    Object.defineProperty(process, "parentPort", originalParent);
  else Reflect.deleteProperty(process, "parentPort");
  state.trace.length = 0;
  vi.resetModules();
});

test("answers each queued read before starting the next", async () => {
  const parent = new EventEmitter();
  Object.defineProperty(process, "parentPort", {
    configurable: true,
    value: parent,
  });
  await import("./workspace-query-reader");
  class Port extends EventEmitter {
    start() {
      return undefined;
    }
    postMessage(message: WorkspaceQueryPortMessage) {
      if (message.type === "reply")
        state.trace.push(`reply ${message.id}`);
    }
  }
  const port = new Port();
  parent.emit("message", {
    data: { type: "initialize", filePath: "synthetic.sqlite" },
  });
  parent.emit("message", { data: { type: "attach" }, ports: [port] });
  port.emit("message", {
    data: {
      id: 1,
      request: { method: "queryJobList", input: { list: "discovery" } },
    },
  });
  port.emit("message", {
    data: {
      id: 2,
      request: { method: "queryJobList", input: { list: "discovery" } },
    },
  });
  parent.emit("message", { data: { type: "queries-ready" } });
  await vi.waitFor(() => expect(state.trace).toHaveLength(4), {
    timeout: 5_000,
  });
  expect(state.trace).toEqual([
    "page read",
    "reply 1",
    "page read",
    "reply 2",
  ]);
});
