import { afterEach, expect, test, vi } from "vitest";
import { createConnectionIdleTimeout } from "./connection-idle";
afterEach(() => vi.useRealTimers());
test("progress outlives the old total clock; silence aborts and cleanup removes the timer", async () => {
  vi.useFakeTimers();
  const idle = createConnectionIdleTimeout(100);
  for (let tick = 0; tick < 100; tick++) {
    await vi.advanceTimersByTimeAsync(90);
    idle.progress();
    expect(idle.signal.aborted).toBe(false);
  }
  await vi.advanceTimersByTimeAsync(201);
  expect(idle.signal.aborted).toBe(true);
  idle.cleanup();
  expect(vi.getTimerCount()).toBe(0);
});
