import { expect, test, vi } from "vitest";
import type { ListingCard } from "@nestor/contracts";
import { createCardWaves } from "./card-waves";

const card = {
  sourceId: "synthetic",
  url: "https://example.com/job",
  title: "Nurse",
  text: "Nurse",
  sourceLabel: "Synthetic",
  cardFingerprint: "one",
} satisfies ListingCard;

test("a checkpoint flushes a small page, then restores pooling for later pages", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  try {
    const consume = vi.fn(() => Promise.resolve());
    const waves = createCardWaves(controller.signal, consume);
    await waves.push([card]);
    expect(consume).not.toHaveBeenCalled();
    await waves.checkpoint();
    expect(consume).toHaveBeenCalledTimes(1);
    await waves.push([card]);
    expect(consume).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(consume).toHaveBeenCalledTimes(2);
    await waves.drain();
  } finally {
    controller.abort();
    vi.useRealTimers();
  }
});

test("Stop releases a checkpoint waiting on processing", async () => {
  const controller = new AbortController();
  const waves = createCardWaves(controller.signal, () => new Promise(() => {}));
  await waves.push([card]);
  const check = expect(waves.checkpoint()).rejects.toThrow("Stopped");
  controller.abort(new Error("Stopped"));
  await check;
});

test("a processing error reaches its checkpoint", async () => {
  const controller = new AbortController();
  try {
    const waves = createCardWaves(controller.signal, () =>
      Promise.reject(new Error("Screen failed")),
    );
    await waves.push([card]);
    await expect(waves.checkpoint()).rejects.toThrow("Screen failed");
  } finally {
    controller.abort();
  }
});
