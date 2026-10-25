import type { AssistantResumeBatchState } from "@nestor/contracts";
import { expect, it, vi } from "vitest";
import { createAssistantBridge } from "./assistant";

it("receives the main-process queue stop through the typed preload event", () => {
  const listeners = new Map<
    string,
    (event: unknown, payload: unknown) => void
  >();
  const removeListener = vi.fn();
  const bridge = createAssistantBridge({
    invoke: vi.fn(),
    on: (channel, listener) => {
      listeners.set(channel, listener);
    },
    removeListener,
    pathForFile: () => "",
  });
  const receive = vi.fn();
  const unsubscribe = bridge.onResumeBatchStop(receive);
  const emit = listeners.get("job-finder:assistant:resume-batch-stop")!;
  emit({}, { malformed: true });
  expect(receive).not.toHaveBeenCalled();
  emit({}, "batch_1");
  expect(receive).toHaveBeenCalledWith("batch_1");
  unsubscribe();
  expect(removeListener).toHaveBeenCalledWith(
    "job-finder:assistant:resume-batch-stop",
    emit,
  );
});

it("returns the current main-process stop flag before another UI draft can dispatch", async () => {
  const state: AssistantResumeBatchState = {
    id: "batch_1",
    jobIds: ["one", "two"],
    activeJobIds: ["one"],
    completedJobIds: [],
    done: false,
    stopRequested: false,
  };
  const invoke = vi.fn().mockResolvedValue({ ...state, stopRequested: true });
  const bridge = createAssistantBridge({
    invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
    pathForFile: () => "",
  });
  expect((await bridge.syncResumeBatch(state)).stopRequested).toBe(true);
  expect(invoke).toHaveBeenCalledWith(
    "job-finder:assistant:sync-resume-batch",
    state,
  );
});

it("schema-checks displayed navigation acknowledgments before sending to main", async () => {
  const invoke = vi.fn(() => Promise.resolve());
  const bridge = createAssistantBridge({
    invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
    pathForFile: () => "",
  });
  const ack = {
    conversationId: "conversation",
    navigationRequestId: "request",
    displayedRoute: "/job-finder/applications?view=tracker",
    section: "tracker",
    overlay: "none" as const,
    status: "displayed" as const,
    reason: null,
  };
  await bridge.acknowledgeNavigation(ack);
  expect(invoke).toHaveBeenCalledWith(
    "job-finder:assistant:acknowledge-navigation",
    ack,
  );
  const longAck = { ...ack, displayedRoute: "x".repeat(4000) };
  await bridge.acknowledgeNavigation(longAck);
  expect(invoke).toHaveBeenLastCalledWith(
    "job-finder:assistant:acknowledge-navigation",
    longAck,
  );
  await expect(
    bridge.acknowledgeNavigation({ ...ack, displayedRoute: "x".repeat(4001) }),
  ).rejects.toThrow();
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("sends the resume stop through the typed bridge", async () => {
  const invoke = vi.fn().mockResolvedValue(undefined);
  const bridge = createAssistantBridge({
    invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
    pathForFile: () => "",
  });
  await bridge.stopResumeBatch();
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "job-finder:assistant:stop-resume-batch",
  );
});
