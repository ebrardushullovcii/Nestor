import type { IpcMain } from "electron";
import { expect, it, vi } from "vitest";

const { runTrackerCommand } = vi.hoisted(() => ({
  runTrackerCommand: vi.fn(() => Promise.resolve({ id: 1 })),
}));
vi.mock("electron", () => ({ clipboard: {}, dialog: {} }));
vi.mock("./tracker", () => ({ runTrackerCommand }));
vi.mock("../services/live-assistant", () => ({
  getLiveAssistantService: vi.fn(),
}));
vi.mock("../setup/interview-overlay-windows", () => ({
  moveInterviewOverlayWindow: vi.fn(),
  syncInterviewOverlayWindows: vi.fn(),
  verifyInterviewOverlayCaptureProtection: vi.fn(),
}));

import { registerLiveAssistantRouteHandlers } from "./live-assistant";

function followUp() {
  const handlers = new Map<
    string,
    (event: unknown, payload: unknown) => unknown
  >();
  registerLiveAssistantRouteHandlers({
    handle: (
      channel: string,
      handler: (event: unknown, payload: unknown) => unknown,
    ) => handlers.set(channel, handler),
  } as unknown as IpcMain);
  return (payload: unknown) =>
    handlers.get("live-assistant:record-job-finder-follow-up")!(null, payload);
}

it("logs an interview and a follow-up note on the job in Applications", async () => {
  const record = followUp();
  await record({
    jobId: "7",
    sessionId: "session_1",
    action: "mark_interviewed",
  });
  await record({
    jobId: "7",
    sessionId: "session_1",
    action: "add_follow_up_note",
    note: "Send the portfolio link",
  });
  expect(runTrackerCommand).toHaveBeenNthCalledWith(1, "add_event", {
    jobId: 7,
    kind: "interview",
    title: "Interview completed",
    body: "Live Assistant session session_1.",
  });
  expect(runTrackerCommand).toHaveBeenNthCalledWith(2, "add_event", {
    jobId: 7,
    kind: "note",
    title: "Interview follow-up note",
    body: "Live Assistant session session_1: Send the portfolio link",
  });
});

it("says plainly when a session points at an application from before Applications moved", async () => {
  await expect(
    Promise.resolve(
      followUp()({
        jobId: "application_record_old",
        sessionId: "session_1",
        action: "mark_interviewed",
      }),
    ),
  ).rejects.toThrow(/before Applications moved/);
});
