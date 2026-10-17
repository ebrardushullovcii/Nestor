// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  JobListRowSchema,
  SavedJobSchema,
  type JobFinderJobDetail,
} from "@nestor/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearJobDetailCache,
  createJobDetailCache,
  useJobDetail,
} from "./use-job-detail";

function detail(id: string, planId = "plan", text = "Full stored description") {
  return {
    planId,
    job: SavedJobSchema.parse({
      id,
      source: "target_site",
      sourceJobId: id,
      canonicalUrl: `https://example.test/${id}`,
      title: `Role ${id}`,
      company: "Example",
      location: "Remote",
      workMode: ["remote"],
      applyPath: "external_redirect",
      easyApplyEligible: false,
      salaryText: null,
      description: text,
      responsibilities: ["Complete detail evidence"],
      discoveredAt: "2026-10-13T00:00:00.000Z",
      status: "discovered",
      matchAssessment: { score: 80 },
    }),
  };
}
function row(id: string, revision = "1") {
  return JobListRowSchema.parse({
    ...detail(id).job,
    detailRevision: revision,
  });
}
function deferred() {
  let resolve!: (value: JobFinderJobDetail) => void;
  const promise = new Promise<JobFinderJobDetail>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const read =
  vi.fn<
    (jobId: string, planId: string | null) => Promise<JobFinderJobDetail>
  >();
beforeEach(() => {
  clearJobDetailCache();
  read.mockReset();
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: { jobFinder: { getJobDetail: read } },
  });
});
afterEach(() => {
  cleanup();
  clearJobDetailCache();
});

describe("selected local job detail", () => {
  it("fences rapid selection responses and keeps the full stored evidence", async () => {
    const first = deferred(),
      second = deferred();
    read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = renderHook(({ selected }) => useJobDetail(selected, "plan"), {
      initialProps: { selected: row("a") },
    });
    view.rerender({ selected: row("b") });
    await act(async () => {
      first.resolve(detail("a"));
      await first.promise;
    });
    expect(view.result.current.job).toBeNull();
    await act(async () => {
      second.resolve(
        detail("b", "plan", "All 10KB of listing text. ".repeat(500)),
      );
      await second.promise;
    });
    expect(view.result.current.job?.id).toBe("b");
    expect(view.result.current.job?.description).toHaveLength(
      "All 10KB of listing text. ".repeat(500).trim().length,
    );
    expect(view.result.current.job?.responsibilities).toEqual([
      "Complete detail evidence",
    ]);
  });

  it("fences a prior plan and a pending read across reset", async () => {
    const oldPlan = deferred(),
      nextPlan = deferred(),
      afterReset = deferred();
    read
      .mockReturnValueOnce(oldPlan.promise)
      .mockReturnValueOnce(nextPlan.promise)
      .mockReturnValueOnce(afterReset.promise);
    const selected = row("a");
    const view = renderHook(({ plan }) => useJobDetail(selected, plan), {
      initialProps: { plan: "old" },
    });
    view.rerender({ plan: "new" });
    await act(async () => {
      oldPlan.resolve(detail("a", "old"));
      await oldPlan.promise;
    });
    expect(view.result.current.job).toBeNull();
    act(clearJobDetailCache);
    await act(async () => {
      nextPlan.resolve(detail("a", "new", "Before reset"));
      await nextPlan.promise;
    });
    expect(view.result.current.job).toBeNull();
    await act(async () => {
      afterReset.resolve(detail("a", "new", "After reset"));
      await afterReset.promise;
    });
    expect(view.result.current.job?.description).toBe("After reset");
  });

  it("reloads a changed detail revision and reuses the body for workflow-only updates", async () => {
    read
      .mockResolvedValueOnce(detail("a"))
      .mockResolvedValueOnce(detail("a", "plan", "Updated stored body"));
    const selected = row("a");
    const view = renderHook(({ selected }) => useJobDetail(selected, "plan"), {
      initialProps: { selected },
    });
    await act(async () => {});
    view.rerender({
      selected: {
        ...selected,
        status: "shortlisted",
        // The row carries only the short assessment; the full one is the
        // detail's, and a changed assessment arrives with a new revision.
        matchAssessment: { ...selected.matchAssessment, score: 20 },
      },
    });
    expect(view.result.current.job?.status).toBe("shortlisted");
    expect(view.result.current.job?.matchAssessment.score).toBe(80);
    expect(read).toHaveBeenCalledTimes(1);
    view.rerender({ selected: row("a", "2") });
    expect(view.result.current.job).toBeNull();
    await act(async () => {});
    expect(view.result.current.job?.description).toBe("Updated stored body");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rejects mismatched detail responses and lets the person retry the local read", async () => {
    read
      .mockResolvedValueOnce(detail("wrong-job"))
      .mockResolvedValueOnce(detail("a"));
    const view = renderHook(() => useJobDetail(row("a"), "plan"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.result.current.job).toBeNull();
    expect(view.result.current.error).toContain(
      "do not belong to this job and search plan",
    );
    act(() => view.result.current.retry());
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.result.current.job?.id).toBe("a");
    expect(view.result.current.error).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("bounds retained full details, shares reads and discards pre-reset cache writes", async () => {
    const cache = createJobDetailCache(3);
    const pending = deferred();
    const load = vi.fn(() => pending.promise);
    const first = cache.load("a", load),
      duplicate = cache.load("a", load);
    expect(load).toHaveBeenCalledTimes(1);
    cache.clear();
    pending.resolve(detail("a"));
    await Promise.all([first, duplicate]);
    expect(cache.size()).toBe(0);
    for (let index = 0; index < 10; index += 1)
      await cache.load(String(index), () =>
        Promise.resolve(detail(String(index))),
      );
    expect(cache.size()).toBe(3);
    expect(cache.peek("0")).toBeNull();
    expect(cache.peek("9")?.job.id).toBe("9");
    const defaultCache = createJobDetailCache();
    for (let index = 0; index < 10; index += 1)
      await defaultCache.load(String(index), () =>
        Promise.resolve(detail(String(index))),
      );
    expect(defaultCache.size()).toBe(8);
    expect(defaultCache.peek("0")).toBeNull();
    expect(defaultCache.peek("9")?.job.description).toBe(
      "Full stored description",
    );
  });
});
