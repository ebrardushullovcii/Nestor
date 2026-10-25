import { expect, it, vi } from "vitest";
import { createAssistantBridge } from "./assistant";

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
