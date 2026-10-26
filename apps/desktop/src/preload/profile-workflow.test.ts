import { PROFILE_WORKFLOW_IMPORT_CHANNEL } from "@nestor/contracts";
import { describe, expect, it, vi } from "vitest";

import { createProfileWorkflowBridge } from "./profile-workflow";

function createIpc() {
  return {
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
}

describe("profile workflow resume import boundary", () => {
  it("cleans up the listener and single-flight lock when invoke throws synchronously", async () => {
    const ipc = createIpc();
    const bridge = createProfileWorkflowBridge(ipc as never);
    ipc.invoke.mockImplementationOnce(() => {
      throw new Error("renderer is tearing down");
    });

    await expect(bridge.importResume(vi.fn())).rejects.toThrow(
      "renderer is tearing down",
    );
    const [channel, listener] = ipc.on.mock.calls[0] as [string, unknown];
    expect(channel).toMatch(/^job-finder:resume-import-progress:/);
    expect(ipc.off).toHaveBeenCalledWith(channel, listener);

    // The failed request must not strand the lock for the next import.
    const result = { state: {}, message: "Imported." };
    ipc.invoke.mockResolvedValue(result);
    await expect(bridge.importResume(vi.fn())).resolves.toEqual(result);
  });

  it("fences a cancelled picker with its request identity", async () => {
    const ipc = createIpc();
    const bridge = createProfileWorkflowBridge(ipc as never);
    ipc.invoke.mockReturnValueOnce(new Promise(() => undefined));

    const parked = bridge.importResume(vi.fn());
    const [importChannel, payload] = ipc.invoke.mock.calls[0] as [
      string,
      { requestId: string },
    ];
    expect(importChannel).toBe(PROFILE_WORKFLOW_IMPORT_CHANNEL);
    expect(payload.requestId).toMatch(/^resume_import_/);
    await expect(bridge.importResume(vi.fn())).rejects.toThrow(
      "A resume import is already running.",
    );

    bridge.cancelImportResume();
    expect(ipc.send).toHaveBeenCalledWith("job-finder:cancel-import-resume", {
      requestId: payload.requestId,
    });

    // The lock is free for a retry; the parked import cannot clear it later.
    const result = { state: {}, message: "Imported." };
    ipc.invoke.mockResolvedValueOnce(result);
    await expect(bridge.importResume(vi.fn())).resolves.toEqual(result);
    void parked;
  });
});
