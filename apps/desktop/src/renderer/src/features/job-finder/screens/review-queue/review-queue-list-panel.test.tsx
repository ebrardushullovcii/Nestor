// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReviewQueueItem, TailoredAsset } from "@nestor/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewQueueListPanel } from "./review-queue-list-panel";
import { describeApplyAllOutcome } from "./review-queue-mission-panel-helpers";
import { getReviewQueueWorkflowStatus } from "./review-queue-status";

afterEach(() => {
  cleanup();
  window.localStorage?.clear();
});

function createEligibleItem(jobId: string): ReviewQueueItem {
  return {
    jobId,
    title: `Role ${jobId}`,
    company: "Acme",
    location: "Remote",
    resumeApplicationMode: "tailored_per_job",
    resumeReview: { status: "not_started" },
    assetStatus: "not_started",
    progressPercent: 0,
  } as unknown as ReviewQueueItem;
}

function createReadyItem(jobId: string): ReviewQueueItem {
  return {
    jobId,
    title: `Role ${jobId}`,
    company: "Acme",
    location: "Remote",
    resumeApplicationMode: "tailored_per_job",
    resumeReview: {
      status: "approved",
      approvedAt: "2026-08-20T00:00:00.000Z",
      approvedExportId: `export_${jobId}`,
      approvedFormat: "pdf",
      approvedFilePath: `C:/${jobId}.pdf`,
    },
    assetStatus: "ready",
    progressPercent: 100,
    resumeAssetId: `asset_${jobId}`,
  } as unknown as ReviewQueueItem;
}

function renderPanel(
  overrides: Partial<Parameters<typeof ReviewQueueListPanel>[0]> = {},
) {
  const props = {
    isJobPending: () => false,
    onSelectItem: vi.fn(),
    queue: [] as readonly ReviewQueueItem[],
    selectedItem: null,
    ...overrides,
  };
  const view = render(
    <MemoryRouter>
      <ReviewQueueListPanel {...props} />
    </MemoryRouter>,
  );
  return { ...view, props };
}

describe("ReviewQueueListPanel", () => {
  it("shows background listing assessment until the saved result arrives", () => {
    renderPanel({
      queue: [
        { ...createEligibleItem("reading"), listingAssessmentPending: true },
      ],
    });
    expect(screen.getByText("Assessing listing")).toBeTruthy();
    expect(screen.queryByText("Resume not started")).toBeNull();
  });

  it("creates resumes only for the ticked jobs that need one, keeping ticks across filtering", () => {
    const onPrepareTailoredDrafts = vi.fn();
    renderPanel({
      onPrepareTailoredDrafts,
      queue: [
        createEligibleItem("one"),
        createEligibleItem("two"),
        createReadyItem("ready"),
      ],
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Role ready" }),
    );
    expect(
      screen
        .getByRole("button", { name: "Create 0 resumes" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Role two" }));
    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(
      screen.getByText(/1 of the selected jobs need a resume/),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "one" },
    });
    expect(
      screen.queryByRole("checkbox", { name: "Select Role two" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create 1 resume" }));
    expect(onPrepareTailoredDrafts).toHaveBeenCalledExactlyOnceWith(["two"]);
    expect(screen.queryByText(/selected$/)).toBeNull();
  });

  it("keeps ticked jobs across pages", () => {
    const onPrepareTailoredDrafts = vi.fn();
    renderPanel({
      onPrepareTailoredDrafts,
      queue: Array.from({ length: 51 }, (_, i) =>
        createEligibleItem(String(i)),
      ),
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Role 0" }));
    expect(screen.getByText("1–50 of 51")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("51–51 of 51")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Role 50" }));
    fireEvent.click(screen.getByRole("button", { name: "Create 2 resumes" }));
    expect(onPrepareTailoredDrafts).toHaveBeenCalledExactlyOnceWith([
      "0",
      "50",
    ]);
  });

  it("selects a range with Shift+click, the page with its checkbox, and clears with Escape", () => {
    const onPrepareTailoredDrafts = vi.fn();
    renderPanel({
      onPrepareTailoredDrafts,
      queue: Array.from({ length: 11 }, (_, i) =>
        createEligibleItem(String(i)),
      ),
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Role 2" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Role 6" }), {
      shiftKey: true,
    });
    expect(screen.getByText("5 selected")).toBeTruthy();
    const page = screen.getByRole("checkbox", {
      name: "Select the 11 jobs on this page",
    });
    expect(page.getAttribute("data-state")).toBe("indeterminate");
    fireEvent.click(page);
    expect(screen.getByText("11 selected")).toBeTruthy();
    expect(
      screen
        .getByRole("checkbox", { name: "Clear the 11 jobs on this page" })
        .getAttribute("data-state"),
    ).toBe("checked");
    fireEvent.keyDown(screen.getByRole("button", { name: /Role 3/ }), {
      key: "Escape",
    });
    expect(screen.queryByText("11 selected")).toBeNull();
    expect(onPrepareTailoredDrafts).not.toHaveBeenCalled();
  });

  it("ticks a row with Ctrl+click instead of opening it", () => {
    const onSelectItem = vi.fn();
    renderPanel({
      onSelectItem,
      onPrepareTailoredDrafts: vi.fn(),
      queue: [createEligibleItem("one"), createEligibleItem("two")],
    });
    fireEvent.click(screen.getByRole("button", { name: /Role two/ }), {
      ctrlKey: true,
    });
    expect(onSelectItem).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("checkbox", { name: "Select Role two" })
        .getAttribute("data-state"),
    ).toBe("checked");
    fireEvent.click(screen.getByRole("button", { name: /Role one/ }));
    expect(onSelectItem).toHaveBeenCalledWith("one");
  });

  it("removes the ticked jobs from the shortlist in one request", async () => {
    const onRemoveJobs = vi.fn(() => Promise.resolve());
    renderPanel({
      onRemoveJobs,
      onPrepareTailoredDrafts: vi.fn(),
      queue: [
        createEligibleItem("one"),
        createEligibleItem("two"),
        createReadyItem("ready"),
      ],
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Role one" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Role ready" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove from shortlist" }),
    );
    await vi.waitFor(() =>
      expect(onRemoveJobs).toHaveBeenCalledExactlyOnceWith(["one", "ready"]),
    );
  });

  it("drops ticks for jobs that left the shortlist and does not carry them into another campaign", () => {
    const onPrepareTailoredDrafts = vi.fn();
    const { rerender, props } = renderPanel({
      campaignId: "a",
      onPrepareTailoredDrafts,
      queue: [createEligibleItem("one"), createEligibleItem("two")],
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Role one" }));
    rerender(
      <MemoryRouter>
        <ReviewQueueListPanel {...props} queue={[createEligibleItem("two")]} />
      </MemoryRouter>,
    );
    expect(screen.queryByText("1 selected")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Role two" }));
    rerender(
      <MemoryRouter>
        <ReviewQueueListPanel {...props} campaignId="b" />
      </MemoryRouter>,
    );
    expect(screen.queryByText("1 selected")).toBeNull();
  });

  it("keeps shortlist status words intact beside long job titles", () => {
    renderPanel({
      queue: [
        {
          ...createEligibleItem("job_long_title"),
          title: "Senior Full Stack Developer (Remote)",
        },
      ],
    });

    // The caption below the title says the same words; the badge is the one
    // in the title line's badge slot.
    const status = screen
      .getAllByText("No resume yet")
      .find((element) => element.className.includes("shrink-0"))!;
    // One line, never wrapped mid-label: the badge keeps its width and the
    // title yields instead.
    expect(status.className).toContain("shrink-0");
    expect(status.className).toContain("whitespace-nowrap");
  });

  it("says the resume is being written while a level change rewrites it, not that the old one is ready", () => {
    const item = {
      ...createReadyItem("job_rewrite"),
      resumeReview: { status: "needs_review" },
    } as unknown as ReviewQueueItem;
    renderPanel({
      isJobPending: (jobId) => jobId === "job_rewrite",
      queue: [item],
    });

    expect(screen.getByText("Writing the resume…")).toBeTruthy();
    expect(screen.queryByText("Resume ready — Apply approves it")).toBeNull();
  });

  it("keeps the empty shortlist focused on finding jobs with one recovery action", () => {
    renderPanel({ queue: [] });

    expect(screen.queryByTestId("shortlisted-all-jobs")).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    const goToFindJobs = screen.getByRole("link", { name: "Go to Find jobs" });
    expect(goToFindJobs.getAttribute("href")).toBe("/job-finder/discovery");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers no list-management chrome or all-jobs row for a single shortlisted job", () => {
    renderPanel({ queue: [createEligibleItem("job_draft")] });

    expect(screen.queryByTestId("shortlisted-all-jobs")).toBeNull();
    expect(screen.queryByPlaceholderText("Search jobs")).toBeNull();
    expect(screen.queryByRole("button", { name: "Comfortable" })).toBeNull();
    expect(screen.queryByText("Batch actions")).toBeNull();
    expect(screen.queryByText("Select for batch")).toBeNull();
  });

  it("offers one press to create every missing resume and one to apply to every ready job", () => {
    const onPrepareTailoredDrafts = vi.fn();
    const onApplyToAllReady = vi.fn();
    renderPanel({
      onApplyToAllReady,
      onPrepareTailoredDrafts,
      queue: [
        createEligibleItem("job_a"),
        createEligibleItem("job_b"),
        createReadyItem("job_c"),
      ],
    });

    const row = screen.getByTestId("shortlisted-all-jobs");
    fireEvent.click(
      within(row).getByRole("button", { name: "Create 2 missing resumes" }),
    );
    expect(onPrepareTailoredDrafts).toHaveBeenCalledTimes(1);

    fireEvent.click(
      within(row).getByRole("button", { name: "Apply to the 1 ready job" }),
    );
    expect(onApplyToAllReady).toHaveBeenCalledWith(1);
    expect(within(row).getByText(/finished resumes are kept/)).toBeTruthy();
    expect(within(row).queryByText(/AI writers/)).toBeNull();
    // Nothing is ticked until the person ticks it; no per-batch mode choice.
    expect(screen.queryByText(/\d+ selected$/)).toBeNull();
    expect(screen.queryByText(/selected for/)).toBeNull();
    expect(screen.queryByText("Apply mode for this batch")).toBeNull();
  });

  it("says under Apply to all which saved mode the batch runs in", () => {
    renderPanel({
      applyAllOutcome: describeApplyAllOutcome("autonomous_submit"),
      onApplyToAllReady: vi.fn(),
      queue: [createReadyItem("job_a"), createReadyItem("job_b")],
    });

    expect(screen.getByTestId("apply-all-outcome").textContent).toBe(
      "Apply to all fills in and sends each application, and stops only for one that needs you.",
    );
  });

  it("leaves a job already in Applications out of the ready count", () => {
    renderPanel({
      onApplyToAllReady: vi.fn(),
      preparedJobIds: new Set(["job_done"]),
      queue: [createReadyItem("job_done"), createReadyItem("job_ready")],
    });

    expect(
      screen.getByRole("button", { name: "Apply to the 1 ready job" }),
    ).toBeTruthy();
    expect(screen.getByText("In Applications")).toBeTruthy();
  });

  it("queues all missing resumes in one run", () => {
    renderPanel({
      onPrepareTailoredDrafts: vi.fn(),
      queue: Array.from({ length: 12 }, (_, index) =>
        createEligibleItem(`job_${index}`),
      ),
    });

    expect(
      screen.getByRole("button", { name: "Create 12 missing resumes" }),
    ).toBeTruthy();
    expect(screen.queryByText(/per batch/)).toBeNull();
  });

  it("swaps the create-all action for live progress and a stop while resumes are written", () => {
    const onStopTailoredDraftPreparation = vi.fn();
    renderPanel({
      draftPreparation: {
        attemptedCount: 2,
        completedCount: 1,
        currentIndex: 2,
        eligibleRemainingCount: 0,
        failedCount: 0,
        status: "running",
        totalCount: 3,
      },
      onStopTailoredDraftPreparation,
      queue: [createEligibleItem("job_a"), createEligibleItem("job_b")],
    });

    expect(screen.getByRole("status").textContent).toContain(
      "Writing resumes · 1 of 3 finished",
    );
    expect(
      screen.queryByRole("button", { name: /Create .* missing/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop new resumes" }));
    expect(onStopTailoredDraftPreparation).toHaveBeenCalledTimes(1);
  });

  it("shows at once that Stop landed and offers no second Stop", () => {
    renderPanel({
      draftPreparation: {
        attemptedCount: 2,
        completedCount: 0,
        currentIndex: 2,
        eligibleRemainingCount: 0,
        failedCount: 0,
        status: "running",
        stopRequested: true,
        totalCount: 3,
      },
      queue: [createEligibleItem("job_a"), createEligibleItem("job_b")],
    });

    expect(screen.getByRole("status").textContent).toContain(
      "Stopping · finishing the resumes already started · 0 of 3 finished",
    );
    expect(
      screen.queryByRole("button", { name: "Stop new resumes" }),
    ).toBeNull();
  });

  it("reports the finished run in plain words and never claims anything was sent", () => {
    renderPanel({
      draftPreparation: {
        attemptedCount: 3,
        completedCount: 2,
        currentIndex: null,
        eligibleRemainingCount: 1,
        failedCount: 1,
        status: "failed",
        totalCount: 3,
      },
      queue: [createEligibleItem("job_a"), createReadyItem("job_b")],
    });

    const message = screen.getByRole("status").textContent ?? "";
    expect(message).toContain("Wrote 2 resumes; 1 failed.");
    expect(message).not.toContain("Nothing was sent.");
    expect(message).not.toMatch(/approved|queued|submitted/i);
  });

  it("replaces Apply to all with Open Safeguards while a safeguard holds, without internal codes", () => {
    const onOpenSafeguards = vi.fn();
    renderPanel({
      onApplyToAllReady: vi.fn(),
      onOpenSafeguards,
      queue: [createReadyItem("job_a"), createReadyItem("job_b")],
      safeguardBlocker:
        "Automatic runs are paused (abnormal_failure_pause: automatic_discovery_failures:campaign_default).",
    });

    expect(screen.queryByRole("button", { name: /Apply to all/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Safeguards" }));
    expect(onOpenSafeguards).toHaveBeenCalledOnce();
    expect(screen.getByTestId("apply-all-blocker").textContent).toBe(
      "Automatic runs are paused.",
    );
  });

  it("shows state-aware resume captions instead of always promising a future draft", () => {
    renderPanel({
      queue: [createEligibleItem("job_not_started"), createReadyItem("job_ok")],
    });

    expect(screen.getAllByText("No resume yet").length).toBeGreaterThan(0);
    expect(screen.getByText("Resume approved")).toBeTruthy();
    expect(screen.queryByText("Job-specific tailored resume")).toBeNull();
  });

  it("reads legacy restored rows and real failures identically in row badges and status detail", () => {
    const restoredItem: ReviewQueueItem = {
      jobId: "job_restored",
      title: "Role job_restored",
      company: "Acme",
      location: "Remote",
      matchScore: 80,
      applicationStatus: "shortlisted",
      assetStatus: "failed",
      progressPercent: null,
      resumeAssetId: "asset_restored",
      resumeApplicationMode: "tailored_per_job",
      resumeReview: { status: "needs_review" },
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    const failedItem: ReviewQueueItem = {
      ...restoredItem,
      jobId: "job_failed",
      title: "Role job_failed",
      resumeAssetId: "asset_failed",
      resumeReview: { status: "not_started" },
    };
    const restoredAsset: TailoredAsset = {
      id: "asset_restored",
      jobId: "job_restored",
      kind: "resume",
      status: "failed",
      label: "Tailored Resume",
      version: "v2",
      templateName: "Chronology Classic",
      compatibilityScore: 80,
      progressPercent: 100,
      updatedAt: "2026-08-20T00:00:00.000Z",
      storagePath: null,
      contentText: "Restored tailored content",
      previewSections: [],
      generationMethod: "deterministic",
      notes: [],
      // Legacy restore rows carry no failure detail: nothing failed.
      failureMessage: null,
      failedAt: null,
    };
    const failedAsset: TailoredAsset = {
      ...restoredAsset,
      id: "asset_failed",
      jobId: "job_failed",
      contentText: null,
      failureMessage: "Provider request timed out.",
      failedAt: "2026-08-21T00:00:00.000Z",
    };

    renderPanel({
      queue: [restoredItem, failedItem],
      tailoredAssets: [restoredAsset, failedAsset],
    });

    // Each card wraps its row button (data-collection-item-id); the status
    // badge is a sibling inside the same card.
    const restoredRow = screen
      .getByText("Role job_restored")
      .closest("[data-collection-item-id]")!.parentElement!;
    const failedRow = screen
      .getByText("Role job_failed")
      .closest("[data-collection-item-id]")!.parentElement!;

    expect(within(restoredRow).getByText("Review resume")).toBeTruthy();
    expect(within(restoredRow).queryByText("Resume failed")).toBeNull();
    expect(within(failedRow).getByText("Resume failed")).toBeTruthy();
    expect(within(failedRow).queryByText("Review resume")).toBeNull();

    // The selected-detail status helper agrees with each rendered row badge.
    expect(
      getReviewQueueWorkflowStatus(restoredItem, restoredAsset),
    ).toMatchObject({ label: "Review resume" });
    expect(getReviewQueueWorkflowStatus(failedItem, failedAsset)).toMatchObject(
      { label: "Resume failed" },
    );
  });

  it("keeps identical row box metrics and reserved lines when the selection moves", () => {
    const first = createReadyItem("job_first");
    const second = createReadyItem("job_second");
    const readBoxes = (container: HTMLElement) =>
      Array.from(
        container.querySelectorAll<HTMLElement>('[data-slot="selectable-row"]'),
      ).map((row) => ({
        className: row.className,
        lineCount: row.querySelectorAll('[data-slot="selectable-row-line"]')
          .length,
      }));

    const unselected = renderPanel({ queue: [first, second] });
    const unselectedBoxes = readBoxes(unselected.container);
    unselected.unmount();

    const selected = renderPanel({
      queue: [first, second],
      selectedItem: first,
    });
    const selectedBoxes = readBoxes(selected.container);

    // Selection may only change the tint and the inset accent bar, never the
    // row's own classes or how many content lines it reserves.
    expect(selectedBoxes.length).toBe(unselectedBoxes.length);
    selectedBoxes.forEach((box, index) => {
      expect(box.className).toBe(unselectedBoxes[index]!.className);
      expect(box.lineCount).toBe(unselectedBoxes[index]!.lineCount);
    });
    expect(
      selected.container
        .querySelector('[data-slot="selectable-row"]')
        ?.getAttribute("data-selected"),
    ).toBe("true");
  });
});

it("excludes a locally pending rewrite from the bulk ready count", () => {
  const items = [createReadyItem("pending"), createReadyItem("ready")];
  renderPanel({
    queue: items,
    isJobPending: (jobId) => jobId === "pending",
    onApplyToAllReady: vi.fn(),
  });
  expect(
    screen.getByRole("button", { name: "Apply to the 1 ready job" }),
  ).toBeTruthy();
});

it("shows listing assessment without a writing indicator for Original", () => {
  renderPanel({
    queue: [
      {
        ...createReadyItem("original"),
        resumeApplicationMode: "original_resume",
      },
    ],
    isJobPending: () => true,
  });
  expect(screen.getByText("Reading the listing")).toBeTruthy();
  expect(screen.queryByText(/Writing the resume/)).toBeNull();
  expect(screen.queryByRole("progressbar")).toBeNull();
});

it("shows a rewrite in progress over the last failure, and the failure without progress once it ends", () => {
  const queue = [
    { ...createReadyItem("failed"), assetStatus: "failed" as const },
  ];
  const view = renderPanel({ queue, isJobPending: () => true });
  expect(screen.getByText("Writing resume")).toBeTruthy();
  expect(screen.getByRole("progressbar")).toBeTruthy();
  view.unmount();
  renderPanel({ queue, isJobPending: () => false });
  expect(screen.getByText("Resume failed")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
});

it("states that bulk actions include jobs hidden by a shortlist filter", () => {
  renderPanel({
    queue: [createEligibleItem("one"), createEligibleItem("two")],
    onPrepareTailoredDrafts: vi.fn(),
  });
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "one" } });
  expect(
    screen.getByTestId("shortlist-bulk-filter-scope").textContent,
  ).toContain("including 1 the filter hides");
});

it("explains the next ten out of 53 ready applications before starting", () => {
  const onApplyToAllReady = vi.fn();
  renderPanel({
    queue: Array.from({ length: 53 }, (_, i) => createReadyItem(`ready_${i}`)),
    applicationBatchLimit: 10,
    onApplyToAllReady,
  });
  expect(
    screen.getByText(/53 ready jobs. 10 start now; 43 remain after this batch/),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Apply to next 10 ready jobs" }),
  );
  expect(onApplyToAllReady).toHaveBeenCalledWith(10);
});

it("names all 33 missing resumes in one control", () => {
  const onPrepareTailoredDrafts = vi.fn();
  renderPanel({
    queue: Array.from({ length: 33 }, (_, i) =>
      createEligibleItem(`missing_${i}`),
    ),
    onPrepareTailoredDrafts,
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Create 33 missing resumes" }),
  );
  expect(onPrepareTailoredDrafts).toHaveBeenCalledOnce();
  expect(onPrepareTailoredDrafts).toHaveBeenCalledWith(
    Array.from({ length: 33 }, (_, index) => `missing_${index}`),
  );
});

it("filters by resume status with counts while Create missing resumes stays plan-wide", () => {
  const onPrepareTailoredDrafts = vi.fn();
  const queue = Array.from({ length: 103 }, (_, index) =>
    createEligibleItem(`page-${index}`),
  );
  queue[50] = createReadyItem("page-50");
  queue[51] = createReadyItem("page-51");
  renderPanel({ queue, onPrepareTailoredDrafts });
  const filters = screen.getByRole("group", {
    name: "Show shortlisted jobs by status",
  });
  expect(
    within(filters).getByRole("button", { name: "All: 103 jobs" }),
  ).toBeTruthy();
  fireEvent.click(
    within(filters).getByRole("button", { name: "Ready to apply: 2 jobs" }),
  );
  expect(screen.getByText("Role page-50")).toBeTruthy();
  expect(screen.queryByText("Role page-0")).toBeNull();
  expect(screen.queryByRole("button", { name: /on this page/ })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Create 101 missing resumes" }),
  );
  expect(onPrepareTailoredDrafts).toHaveBeenCalledExactlyOnceWith(
    queue
      .filter((_, index) => index !== 50 && index !== 51)
      .map((item) => item.jobId),
  );
});

it("selects the page with its checkbox, everything with Select all, and clears", () => {
  const onPrepareTailoredDrafts = vi.fn();
  const queue = Array.from({ length: 103 }, (_, index) =>
    createEligibleItem(`pick-${index}`),
  );
  queue[0] = createReadyItem("pick-0");
  renderPanel({ queue, onPrepareTailoredDrafts });
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select the 50 jobs on this page" }),
  );
  // The ready job is ticked too; only the 49 that need a resume are written.
  expect(
    screen.getByRole("button", { name: "Create 49 resumes" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select the 50 jobs on this page" }),
  );
  expect(
    screen.getByRole("button", { name: "Create 99 resumes" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
  expect(
    screen.queryByRole("button", { name: /^Create \d+ resumes?$/ }),
  ).toBeNull();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "pick-100" },
  });
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select Role pick-100" }),
  );
  expect(screen.getByRole("button", { name: "Create 1 resume" })).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Select all 103" }));
  fireEvent.click(screen.getByRole("button", { name: "Create 102 resumes" }));
  expect(onPrepareTailoredDrafts).toHaveBeenCalledExactlyOnceWith(
    expect.arrayContaining(queue.slice(1).map((item) => item.jobId)),
  );
});
