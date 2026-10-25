import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import {
  JOB_FINDER_WORKSPACE_UPDATED_CHANNEL,
  withJobFinderWorkspaceUpdates,
  scheduleAnswerDraftWorkspaceUpdate,
  onJobFinderWorkspaceUpdate,
} from "./workspace-updates";

describe("withJobFinderWorkspaceUpdates", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pushes the workspace within a second, then every few seconds, then at the end", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const target = { send, isDestroyed: () => false } as never;
    let finish!: () => void;
    const done = withJobFinderWorkspaceUpdates(
      target,
      () => new Promise<void>((resolve) => (finish = resolve)),
    );

    await vi.advanceTimersByTimeAsync(600);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(send).toHaveBeenCalledTimes(2);
    finish();
    await done;
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith(JOB_FINDER_WORKSPACE_UPDATED_CHANNEL);
  });
});

it("coalesces answer draft refreshes after the last saved keystroke", async () => {
  vi.useFakeTimers();
  const listener = vi.fn();
  const stop = onJobFinderWorkspaceUpdate(listener);
  scheduleAnswerDraftWorkspaceUpdate();
  await vi.advanceTimersByTimeAsync(100);
  scheduleAnswerDraftWorkspaceUpdate();
  await vi.advanceTimersByTimeAsync(149);
  expect(listener).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
  vi.useRealTimers();
});
