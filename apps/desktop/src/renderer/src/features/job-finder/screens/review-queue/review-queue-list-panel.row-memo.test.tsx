// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReviewQueueItem } from "@nordri/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ReviewQueueRowProps,
  ReviewQueueRow as ReviewQueueRowType,
} from "./review-queue-list-row";

/**
 * Batch preparation is one run that finishes one job at a time. Each of those
 * steps used to re-render every row in the Shortlisted list — forty subtrees
 * rebuilt to move one badge, under a pointer that was hovering one of them.
 *
 * The rows are memoised, so a row re-renders exactly when the panel hands it a
 * prop that changed. This counts the renders of each row across an update that
 * touches one job, with the queue arriving as wholly new objects (which is what
 * a refresh from the main process actually delivers) and with the panel's
 * callbacks written inline on every pass.
 */
const { rowRenderCounts } = vi.hoisted(() => ({
  rowRenderCounts: new Map<string, number>(),
}));

vi.mock("./review-queue-list-row", async () => {
  const react = await import("react");
  const actual = await vi.importActual<{
    ReviewQueueRow: typeof ReviewQueueRowType;
  }>("./review-queue-list-row");

  return {
    ...actual,
    // Wrapped in its own `memo` with the same props the panel passes, so the
    // counter only ticks when React would have re-rendered the real row.
    ReviewQueueRow: react.memo((props: ReviewQueueRowProps) => {
      rowRenderCounts.set(
        props.jobId,
        (rowRenderCounts.get(props.jobId) ?? 0) + 1,
      );
      return react.createElement(actual.ReviewQueueRow, props);
    }),
  };
});

const { ReviewQueueListPanel } = await import("./review-queue-list-panel");

afterEach(() => {
  cleanup();
  rowRenderCounts.clear();
  window.localStorage?.clear();
});

function queueItem(
  jobId: string,
  state: "needs_resume" | "approved",
): ReviewQueueItem {
  return {
    jobId,
    title: `Role ${jobId}`,
    company: "Acme",
    location: "Remote",
    resumeApplicationMode: "tailored_per_job",
    resumeReview:
      state === "approved"
        ? {
            status: "approved",
            approvedAt: "2026-08-20T00:00:00.000Z",
            approvedExportId: `export_${jobId}`,
            approvedFormat: "pdf",
            approvedFilePath: `C:/${jobId}.pdf`,
          }
        : { status: "not_started" },
    assetStatus: state === "approved" ? "ready" : "not_started",
    progressPercent: state === "approved" ? 100 : 0,
    ...(state === "approved" ? { resumeAssetId: `asset_${jobId}` } : {}),
  } as unknown as ReviewQueueItem;
}

/** Every prop is rebuilt, exactly as a re-rendering parent would rebuild it. */
function panel(queue: readonly ReviewQueueItem[]) {
  return (
    <MemoryRouter>
      <ReviewQueueListPanel
        isJobPending={(jobId) => jobId === "never"}
        onSelectItem={(jobId) => void jobId}
        queue={queue}
        selectedItem={null}
      />
    </MemoryRouter>
  );
}

describe("ReviewQueueListPanel row memoisation", () => {
  it("ships the row as a memoised component", async () => {
    // The counters below observe the panel's half of the contract: untouched
    // rows keep shallow-equal props. This pins the row's half, so removing
    // `memo` from the shipped component cannot pass silently.
    const actual = await vi.importActual<{
      ReviewQueueRow: { $$typeof?: symbol };
    }>("./review-queue-list-row");
    const row = actual.ReviewQueueRow;

    expect(row.$$typeof).toBe(Symbol.for("react.memo"));
  });

  it("re-renders only the row whose status changed", () => {
    const { container, rerender } = render(
      panel([
        queueItem("job_1", "needs_resume"),
        queueItem("job_2", "needs_resume"),
        queueItem("job_3", "needs_resume"),
      ]),
    );

    expect([...rowRenderCounts.entries()].sort()).toEqual([
      ["job_1", 1],
      ["job_2", 1],
      ["job_3", 1],
    ]);

    const untouchedRowBefore = container.querySelector(
      '[data-collection-item-id="job_1"]',
    );
    expect(untouchedRowBefore).not.toBeNull();

    rerender(
      panel([
        queueItem("job_1", "needs_resume"),
        queueItem("job_2", "approved"),
        queueItem("job_3", "needs_resume"),
      ]),
    );

    // Only the changed job's row rendered again; the other two skipped even
    // though their item objects, the queue array and every callback are new.
    expect([...rowRenderCounts.entries()].sort()).toEqual([
      ["job_1", 1],
      ["job_2", 2],
      ["job_3", 1],
    ]);

    // The untouched rows were never remounted, so hover, focus and the list's
    // scroll position survive a batch step.
    expect(container.querySelector('[data-collection-item-id="job_1"]')).toBe(
      untouchedRowBefore,
    );
    expect(container.textContent).toContain("Ready to apply");
  });

  it("re-renders only the newly selected row and the one it replaced", () => {
    const queue = [
      queueItem("job_1", "needs_resume"),
      queueItem("job_2", "needs_resume"),
      queueItem("job_3", "needs_resume"),
    ];

    const { rerender } = render(
      <MemoryRouter>
        <ReviewQueueListPanel
          isJobPending={() => false}
          onSelectItem={vi.fn()}
          queue={queue}
          selectedItem={queue[0] ?? null}
        />
      </MemoryRouter>,
    );

    rowRenderCounts.clear();

    rerender(
      <MemoryRouter>
        <ReviewQueueListPanel
          isJobPending={() => false}
          onSelectItem={vi.fn()}
          queue={queue}
          selectedItem={queue[2] ?? null}
        />
      </MemoryRouter>,
    );

    expect(rowRenderCounts.get("job_1")).toBe(1);
    expect(rowRenderCounts.get("job_3")).toBe(1);
    expect(rowRenderCounts.get("job_2")).toBeUndefined();
  });
});
