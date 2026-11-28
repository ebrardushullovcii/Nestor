import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import { afterEach, expect, test, vi } from "vitest";
import { withPageConnectionLiveness } from "./browser-navigation";

afterEach(() => vi.useRealTimers());

test("live browser traffic keeps the same call alive beyond three minutes, and silence releases it for a fresh call", async () => {
  vi.useFakeTimers();
  const traffic = Object.assign(new EventEmitter(), {
    send: vi.fn().mockResolvedValue(undefined),
  });
  const page = Object.assign(new EventEmitter(), {
    context: () => ({ newCDPSession: () => Promise.resolve(traffic) }),
  }) as unknown as Page;
  const work = vi.fn(() => new Promise<never>(() => {}));
  const finished = vi.fn();
  const first = withPageConnectionLiveness(page, work).catch(finished);
  await vi.advanceTimersByTimeAsync(0);
  for (let tick = 0; tick < 20; tick += 1) {
    await vi.advanceTimersByTimeAsync(12_000);
    traffic.emit("Network.dataReceived", { dataLength: 32 });
  }
  expect(finished).not.toHaveBeenCalled();
  expect(work).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(15_001);
  await first;
  expect(finished).toHaveBeenCalledOnce();
  expect(traffic.listenerCount("Network.dataReceived")).toBe(0);
  await expect(
    withPageConnectionLiveness(page, () => Promise.resolve("next read")),
  ).resolves.toBe("next read");
});
