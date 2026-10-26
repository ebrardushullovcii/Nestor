import { expect, it, vi } from "vitest";
import { createAssistantBridge } from "./assistant";

it("forwards displayed navigation acknowledgments for main to check", async () => {
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
});
