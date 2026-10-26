import { afterEach, describe, expect, it, vi } from "vitest";

import { runBoundedNewSourceReadabilityCheck } from "./new-source-readability-check";

describe("new source readability check", () => {
  afterEach(() => vi.useRealTimers());

  it("aborts the add-time check after its bounded timeout", async () => {
    vi.useFakeTimers();
    const run = vi.fn((signal: AbortSignal) => {
      void signal;
      return new Promise<string>(() => {});
    });
    const result = runBoundedNewSourceReadabilityCheck(run, 15_000);
    const rejection = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });

    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(run.mock.calls[0]?.[0].aborted).toBe(true);
  });
});
