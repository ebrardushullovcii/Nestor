// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { ReviewQueueItemSchema } from "@nestor/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { useResumeOperationStarts } from "./use-resume-operation-starts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("keeps concurrent operation clocks through rerenders and resets a completed job on retry", () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const queue = ["a", "b"].map((jobId) =>
    ReviewQueueItemSchema.parse({
      jobId,
      title: "Engineer",
      company: "Example",
      location: "Remote",
      matchScore: 80,
      applicationStatus: "shortlisted",
      assetStatus: "not_started",
      progressPercent: null,
      resumeAssetId: null,
      updatedAt: new Date().toISOString(),
    }),
  );
  const { result, rerender } = renderHook(
    ({ pending }) =>
      useResumeOperationStarts(queue, (id) => pending.includes(id)),
    { initialProps: { pending: ["a"] } },
  );
  expect(result.current.a).toBe(10_000);
  vi.setSystemTime(25_000);
  rerender({ pending: ["a", "b"] });
  expect(result.current).toEqual({ a: 10_000, b: 25_000 });
  rerender({ pending: ["b"] });
  expect(result.current.a).toBeUndefined();
  vi.setSystemTime(40_000);
  rerender({ pending: ["a", "b"] });
  expect(result.current).toEqual({ a: 40_000, b: 25_000 });
});
