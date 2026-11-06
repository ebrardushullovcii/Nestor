import { expect, test, vi } from "vitest";
import { runWithAgentRunCancellation } from "./cancellation";

test("a stopped run never starts a pending tool", async () => {
  const controller = new AbortController();
  const work = vi.fn(() => "Late work");
  const pending = runWithAgentRunCancellation(work, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(work).not.toHaveBeenCalled();
});

test("Stop ends an uncooperative tool wait and consumes its late rejection", async () => {
  const controller = new AbortController();
  let fail: (error: Error) => void = () => {};
  const pending = runWithAgentRunCancellation(
    () =>
      new Promise<never>((_resolve, reject) => {
        fail = reject;
      }),
    controller.signal,
  );
  await Promise.resolve();
  controller.abort(new Error("The person pressed Stop"));
  await expect(pending).rejects.toThrow("The person pressed Stop");
  fail(new Error("Late child failure"));
  await Promise.resolve();
});
