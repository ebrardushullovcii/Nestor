// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobFinderResumePreview, ResumeDraft } from "@nestor/contracts";
import { useResumeWorkspacePreview } from "./use-resume-workspace-preview";

async function actAndFlush(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

interface DeferredPreview {
  promise: Promise<JobFinderResumePreview>;
  reject: (reason: unknown) => void;
  resolve: (value: JobFinderResumePreview) => void;
}

interface HookProps {
  draft: ResumeDraft | null;
  hasUnsavedChanges: boolean;
  onPreviewDraft: (
    draft: ResumeDraft,
    requestId?: string,
  ) => Promise<JobFinderResumePreview>;
}

function createDeferredPreview(): DeferredPreview {
  let resolve!: (value: JobFinderResumePreview) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<JobFinderResumePreview>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildDraft(
  overrides: Pick<ResumeDraft, "id" | "jobId"> &
    Partial<Omit<ResumeDraft, "id" | "jobId">>,
): ResumeDraft {
  return {
    status: "draft",
    templateId: "classic_ats",
    identity: null,
    sections: [],
    targetPageCount: 2,
    generationMethod: null,
    approvedAt: null,
    approvedExportId: null,
    staleReason: null,
    workHistoryReviewAcknowledgments: [],
    claimConfirmations: [],
    issueApprovals: [],
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    ...overrides,
  };
}

function toHookProps(
  draft: ResumeDraft | null,
  hasUnsavedChanges: boolean,
  onPreviewDraft: HookProps["onPreviewDraft"],
): HookProps {
  return { draft, hasUnsavedChanges, onPreviewDraft };
}

function buildPreview(draftId: string): JobFinderResumePreview {
  return {
    draftId,
    revisionKey: `resume_preview_${draftId}_revision`,
    html: `<!doctype html><html><body><p>Preview for ${draftId}</p></body></html>`,
    warnings: [],
    metadata: {
      templateId: "classic_ats",
      renderedAt: "2026-04-27T00:00:00.000Z",
      pageCount: 1,
      sectionCount: 1,
      entryCount: 1,
    },
  };
}

describe("useResumeWorkspacePreview", () => {
  let pendingPreviews: DeferredPreview[];

  beforeEach(() => {
    vi.useFakeTimers();
    pendingPreviews = [];
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function createOnPreviewDraft(): HookProps["onPreviewDraft"] {
    return vi.fn(() => {
      const deferred = createDeferredPreview();
      pendingPreviews.push(deferred);
      return deferred.promise;
    });
  }

  async function renderWithReadyPreview() {
    const onPreviewDraft = createOnPreviewDraft();
    const { result, rerender } = renderHook(
      (props: HookProps) =>
        useResumeWorkspacePreview({
          draft: props.draft,
          hasUnsavedChanges: props.hasUnsavedChanges,
          onPreviewDraft: props.onPreviewDraft,
        }),
      {
        initialProps: toHookProps(
          buildDraft({ id: "draft_1", jobId: "job_1" }),
          false,
          onPreviewDraft,
        ),
      },
    );

    await actAndFlush(() => {
      vi.advanceTimersByTime(100);
    });
    expect(pendingPreviews).toHaveLength(1);

    const firstPreview = buildPreview("draft_1");
    await actAndFlush(() => {
      pendingPreviews[0]?.resolve(firstPreview);
    });

    expect(result.current.previewStatus).toBe("ready");
    expect(result.current.preview).toEqual(firstPreview);

    return {
      firstPreview,
      onPreviewDraft,
      rerender,
      result,
    };
  }

  it("retains the previous preview while the same draft revalidates", async () => {
    const { onPreviewDraft, rerender, result } = await renderWithReadyPreview();

    // Same job/draft lineage, new revision: nothing may blank mid-typing.
    rerender({
      draft: buildDraft({
        id: "draft_1",
        jobId: "job_1",
        updatedAt: "2026-04-27T00:01:00.000Z",
      }),
      hasUnsavedChanges: true,
      onPreviewDraft,
    });
    expect(result.current.previewStatus).toBe("ready");
    expect(result.current.preview?.html).toContain("Preview for draft_1");

    await actAndFlush(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current.previewStatus).toBe("loading");
    expect(result.current.preview?.html).toContain("Preview for draft_1");

    const refreshedPreview = buildPreview("draft_1");
    await actAndFlush(() => {
      pendingPreviews[1]?.resolve(refreshedPreview);
    });
    expect(result.current.previewStatus).toBe("ready");
    expect(result.current.preview).toEqual(refreshedPreview);
  });

  it("clears a foreign preview immediately on job/draft switch and fences the in-flight stale response", async () => {
    const { onPreviewDraft, rerender, result } = await renderWithReadyPreview();

    rerender({
      draft: buildDraft({
        id: "draft_1",
        jobId: "job_1",
        updatedAt: "2026-04-27T00:01:00.000Z",
      }),
      hasUnsavedChanges: true,
      onPreviewDraft,
    });
    await actAndFlush(() => {
      vi.advanceTimersByTime(250);
    });
    expect(pendingPreviews).toHaveLength(2);

    // Switch to another job/draft while the previous request is in flight.
    rerender({
      draft: buildDraft({ id: "draft_2", jobId: "job_2" }),
      hasUnsavedChanges: false,
      onPreviewDraft,
    });

    expect(result.current.preview).toBeNull();
    expect(result.current.previewError).toBeNull();
    expect(result.current.previewStatus).toBe("loading");

    await actAndFlush(() => {
      vi.advanceTimersByTime(100);
    });
    expect(pendingPreviews).toHaveLength(3);

    // Late response for the abandoned draft must never be rendered.
    await actAndFlush(() => {
      pendingPreviews[1]?.resolve(buildPreview("draft_1"));
    });
    expect(result.current.preview).toBeNull();
    expect(result.current.previewStatus).toBe("loading");

    await actAndFlush(() => {
      pendingPreviews[2]?.resolve(buildPreview("draft_2"));
    });
    expect(result.current.previewStatus).toBe("ready");
    expect(result.current.preview?.draftId).toBe("draft_2");
    expect(result.current.preview?.html).toContain("Preview for draft_2");
  });

  it("applies responses in order so a slower older render cannot overwrite the newest", async () => {
    const { onPreviewDraft, rerender, result } = await renderWithReadyPreview();

    rerender({
      draft: buildDraft({
        id: "draft_1",
        jobId: "job_1",
        updatedAt: "2026-04-27T00:01:00.000Z",
      }),
      hasUnsavedChanges: true,
      onPreviewDraft,
    });
    await actAndFlush(() => {
      vi.advanceTimersByTime(250);
    });
    expect(pendingPreviews).toHaveLength(2);

    rerender({
      draft: buildDraft({
        id: "draft_1",
        jobId: "job_1",
        updatedAt: "2026-04-27T00:02:00.000Z",
      }),
      hasUnsavedChanges: true,
      onPreviewDraft,
    });
    await actAndFlush(() => {
      vi.advanceTimersByTime(250);
    });
    expect(pendingPreviews).toHaveLength(3);

    const newestPreview = buildPreview("draft_1");
    await actAndFlush(() => {
      pendingPreviews[2]?.resolve(newestPreview);
    });
    expect(result.current.preview).toEqual(newestPreview);
    expect(result.current.previewStatus).toBe("ready");

    // The older request settles last and must lose.
    await actAndFlush(() => {
      pendingPreviews[1]?.resolve(buildPreview("draft_1"));
    });
    expect(result.current.preview).toEqual(newestPreview);
    expect(result.current.previewStatus).toBe("ready");
  });

  it("drops the retained frame and reports failure honestly, then recovers on retry", async () => {
    const { onPreviewDraft, rerender, result } = await renderWithReadyPreview();

    rerender({
      draft: buildDraft({
        id: "draft_1",
        jobId: "job_1",
        updatedAt: "2026-04-27T00:01:00.000Z",
      }),
      hasUnsavedChanges: true,
      onPreviewDraft,
    });
    await actAndFlush(() => {
      vi.advanceTimersByTime(250);
    });
    expect(pendingPreviews).toHaveLength(2);
    expect(result.current.previewStatus).toBe("loading");
    expect(result.current.preview).not.toBeNull();

    await actAndFlush(() => {
      pendingPreviews[1]?.reject(new Error("render exploded"));
    });
    expect(result.current.previewStatus).toBe("error");
    expect(result.current.previewError).toBe("render exploded");
    expect(result.current.preview).toBeNull();

    act(() => {
      result.current.refreshPreview(
        buildDraft({
          id: "draft_1",
          jobId: "job_1",
          updatedAt: "2026-04-27T00:01:00.000Z",
        }),
      );
    });
    expect(pendingPreviews).toHaveLength(3);
    expect(result.current.previewStatus).toBe("loading");

    const recoveredPreview = buildPreview("draft_1");
    await actAndFlush(() => {
      pendingPreviews[2]?.resolve(recoveredPreview);
    });
    expect(result.current.previewStatus).toBe("ready");
    expect(result.current.preview).toEqual(recoveredPreview);
  });

  it("treats a response rendered for another draft as an error instead of showing it", async () => {
    const onPreviewDraft = vi.fn(() =>
      Promise.resolve(buildPreview("draft_other")),
    );

    const { result } = renderHook(
      (props: HookProps) =>
        useResumeWorkspacePreview({
          draft: props.draft,
          hasUnsavedChanges: props.hasUnsavedChanges,
          onPreviewDraft: props.onPreviewDraft,
        }),
      {
        initialProps: toHookProps(
          buildDraft({ id: "draft_1", jobId: "job_1" }),
          false,
          onPreviewDraft,
        ),
      },
    );

    await actAndFlush(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.previewStatus).toBe("error");
    expect(result.current.preview).toBeNull();
    expect(result.current.previewError).toBe(
      "The preview response did not match the current draft.",
    );
  });

  it("resets to idle without a draft and ignores late responses", async () => {
    const onPreviewDraft = createOnPreviewDraft();
    const { rerender, result } = renderHook(
      (props: HookProps) =>
        useResumeWorkspacePreview({
          draft: props.draft,
          hasUnsavedChanges: props.hasUnsavedChanges,
          onPreviewDraft: props.onPreviewDraft,
        }),
      {
        initialProps: toHookProps(
          buildDraft({ id: "draft_1", jobId: "job_1" }),
          false,
          onPreviewDraft,
        ),
      },
    );

    await actAndFlush(() => {
      vi.advanceTimersByTime(100);
    });
    expect(pendingPreviews).toHaveLength(1);

    rerender(toHookProps(null, false, onPreviewDraft));
    expect(result.current.previewStatus).toBe("idle");
    expect(result.current.preview).toBeNull();
    expect(result.current.previewError).toBeNull();

    await actAndFlush(() => {
      pendingPreviews[0]?.resolve(buildPreview("draft_1"));
    });
    expect(result.current.preview).toBeNull();
    expect(result.current.previewStatus).toBe("idle");
  });

  it("resetPreview clears state immediately and fences late responses", async () => {
    const { onPreviewDraft, rerender, result } = await renderWithReadyPreview();

    rerender(toHookProps(null, false, onPreviewDraft));
    expect(result.current.previewStatus).toBe("idle");

    rerender({
      draft: buildDraft({ id: "draft_1", jobId: "job_1" }),
      hasUnsavedChanges: false,
      onPreviewDraft,
    });
    await actAndFlush(() => {
      vi.advanceTimersByTime(100);
    });
    expect(pendingPreviews).toHaveLength(2);

    act(() => {
      result.current.resetPreview();
    });
    expect(result.current.previewStatus).toBe("idle");
    expect(result.current.preview).toBeNull();

    await actAndFlush(() => {
      pendingPreviews[1]?.resolve(buildPreview("draft_1"));
    });
    expect(result.current.preview).toBeNull();
    expect(result.current.previewStatus).toBe("idle");
  });
});
