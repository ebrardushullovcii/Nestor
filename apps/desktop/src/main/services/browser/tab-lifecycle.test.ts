import type { WebContents } from "electron";
import { expect, test, vi } from "vitest";
import { TabLifecycle } from "./tab-lifecycle";

test("an in-flight freeze completes before a wake and its following browser read", async () => {
  let finishFreeze!: () => void;
  const gate = new Promise<void>((resolve) => {
    finishFreeze = resolve;
  });
  const sendCommand = vi.fn(
    (method: string, params: Record<string, unknown>) =>
      method === "Page.setWebLifecycleState" && params.state === "frozen"
        ? gate
        : Promise.resolve(),
  );
  const contents = {
    id: 1,
    isDestroyed: () => false,
    debugger: { isAttached: () => true, sendCommand },
  } as unknown as WebContents;
  const lifecycle = new TabLifecycle();
  const freeze = lifecycle.setFrozen(contents, true);
  const wake = lifecycle.setFrozen(contents, false);
  await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(2));
  finishFreeze();
  await Promise.all([freeze, wake]);
  expect(
    sendCommand.mock.calls
      .filter((call) => call[0] === "Page.setWebLifecycleState")
      .map((call) => call[1].state),
  ).toEqual(["frozen", "active"]);
});

test("destroyed pages never receive deferred lifecycle commands", async () => {
  let destroyed = false;
  const sendCommand = vi.fn();
  const contents = {
    id: 1,
    isDestroyed: () => destroyed,
    debugger: { isAttached: () => true, sendCommand },
  } as unknown as WebContents;
  const lifecycle = new TabLifecycle();
  const pending = lifecycle.setFrozen(contents, true);
  destroyed = true;
  lifecycle.forget(1);
  await pending;
  expect(sendCommand).not.toHaveBeenCalled();
});
