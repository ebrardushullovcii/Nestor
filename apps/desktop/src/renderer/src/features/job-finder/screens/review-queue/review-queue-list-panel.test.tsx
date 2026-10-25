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
    // No dead "Create 0 resumes" control, and no line refusing it either.
    expect(
      screen.queryByRole("button", { name: /^Create \d+ resumes?$/ }),
    ).toBe(null);
    expect(screen.queryByText(/already ha(s|ve) a resume/)).toBeNull();
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

  it("drops the ticks of approved resumes once the approval lands", async () => {
    const toReview = (jobId: string) =>
      ({
        ...createReadyItem(jobId),
        resumeTailoringMode: "aggressive",
        resumeReview: { status: "not_started" },
      }) as unknown as ReviewQueueItem;
    const onApproveResumes = vi.fn(() => Promise.resolve());
    renderPanel({
      onApproveResumes,
      onPrepareTailoredDrafts: vi.fn(),
      queue: [toReview("one"), toReview("two"), createEligibleItem("three")],
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Role one" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Role two" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Role three" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve 2 resumes" }));
    expect(onApproveResumes).toHaveBeenCalledExactlyOnceWith(["one", "two"]);
    // The job that still needs a resume keeps its tick.
    await vi.waitFor(() => expect(screen.getByText("1 selected")).toBeTruthy());
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
      screen.getByRole("button", { name: "Move back to Find jobs" }),
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
      .getAllByText("Needs a resume")
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

    // The status is said once, by the badge.
    expect(screen.getByText("Writing resume")).toBeTruthy();
    expect(screen.queryByText("Writing the resume…")).toBeNull();
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
    const onApplyToJobs = vi.fn();
    renderPanel({
      onApplyToJobs,
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
    expect(onApplyToJobs).toHaveBeenCalledWith(["job_c"]);
    // The reassurance is the button's tooltip, not a paragraph under it.
    expect(
      within(row)
        .getByRole("button", { name: "Create 2 missing resumes" })
        .getAttribute("title"),
    ).toContain("finished resumes are kept");
    expect(within(row).queryByText(/AI writers/)).toBeNull();
    // Nothing is ticked until the person ticks it; no per-batch mode choice.
    expect(screen.queryByText(/\d+ selected$/)).toBeNull();
    expect(screen.queryByText(/selected for/)).toBeNull();
    expect(screen.queryByText("Apply mode for this batch")).toBeNull();
  });

  it("says under Apply to all which saved mode the batch runs in", () => {
    renderPanel({
      applyAllOutcome: describeApplyAllOutcome("autonomous_submit"),
      onApplyToJobs: vi.fn(),
      queue: [createReadyItem("job_a"), createReadyItem("job_b")],
    });

    expect(screen.getByTestId("apply-all-outcome").textContent).toBe(
      "Sends each application for you and stops only for one that needs you. Ten at a time, with no more presses.",
    );
  });

  it("leaves a job already in Applications out of the ready count", () => {
    renderPanel({
      onApplyToJobs: vi.fn(),
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

  it("shows state-aware resume captions instead of always promising a future draft", () => {
    renderPanel({
      queue: [createEligibleItem("job_not_started"), createReadyItem("job_ok")],
    });

    // Each row says its status once: the badge. A caption that only
    // repeated it ("No resume yet" under "Needs a resume", "Resume
    // approved" under "Ready to apply") is gone. The badge says the status
    // in full; its tab uses a shorter name.
    expect(screen.queryByText("No resume yet")).toBeNull();
    expect(
      screen
        .getAllByText("Needs a resume")
        .filter((element) => element.className.includes("shrink-0")),
    ).toHaveLength(1);
    expect(screen.getByText("Ready to apply")).toBeTruthy();
    expect(screen.queryByText("Resume approved")).toBeNull();
    expect(screen.queryByText("Job-specific tailored resume")).toBeNull();
  });

  it("keeps a caption the badge cannot say and names a duplicate quietly", () => {
    const kept = {
      ...createReadyItem("job_kept"),
      resumeApplicationMode: "original_resume",
      resumeReview: { status: "original_resume" },
    } as unknown as ReviewQueueItem;
    const twin = { ...createEligibleItem("job_twin"), title: "Same role" };
    renderPanel({
      queue: [kept, twin, { ...twin, jobId: "job_twin_2" }],
    });

    expect(screen.getByText("Original resume, unchanged")).toBeTruthy();
    const duplicates = screen.getAllByTestId("review-queue-possible-duplicate");
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0]!.textContent).toContain("Possible duplicate");
    expect(screen.queryByText(/Possibly saved twice/)).toBeNull();
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

    expect(within(restoredRow).getByText("To review")).toBeTruthy();
    expect(within(restoredRow).queryByText("Resume failed")).toBeNull();
    expect(within(failedRow).getByText("Resume failed")).toBeTruthy();
    expect(within(failedRow).queryByText("To review")).toBeNull();

    // The selected-detail status helper agrees with each rendered row badge.
    expect(
      getReviewQueueWorkflowStatus(restoredItem, restoredAsset),
    ).toMatchObject({ label: "To review" });
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
    onApplyToJobs: vi.fn(),
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
  expect(screen.getByTestId("shortlist-bulk-filter-scope").textContent).toBe(
    "This button acts on all shortlisted jobs, not just the ones shown.",
  );
});

it("counts a job whose resume is being written under Writing, as its row says", () => {
  renderPanel({
    isJobPending: (jobId) => jobId === "two",
    queue: [
      createEligibleItem("one"),
      createEligibleItem("two"),
      createReadyItem("ready"),
    ],
    onPrepareTailoredDrafts: vi.fn(),
  });
  expect(
    screen.getByRole("button", { name: "No resume: 1 jobs" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Writing: 1 jobs" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Create the missing resume" }),
  ).toBeTruthy();
});

it("says nothing about the filter when every job the button covers is shown", () => {
  const ready = createReadyItem("ready");
  renderPanel({
    queue: [createEligibleItem("one"), createEligibleItem("two"), ready],
    onPrepareTailoredDrafts: vi.fn(),
  });
  fireEvent.click(screen.getByRole("button", { name: /^No resume: 2/ }));
  expect(
    screen.getByRole("button", { name: "Create 2 missing resumes" }),
  ).toBeTruthy();
  expect(screen.queryByTestId("shortlist-bulk-filter-scope")).toBeNull();
});

it("opens the first job of a status tab when the open job is not in it, and keeps one that is", () => {
  const onSelectItem = vi.fn();
  const onShowItem = vi.fn();
  const ready = createReadyItem("ready");
  const first = createEligibleItem("first");
  const second = createEligibleItem("second");
  const view = renderPanel({
    queue: [ready, first, second],
    onSelectItem,
    onShowItem,
    selectedItem: ready,
  });
  fireEvent.click(screen.getByRole("button", { name: /^No resume: 2/ }));
  expect(onShowItem).toHaveBeenCalledExactlyOnceWith("first");
  expect(onSelectItem).not.toHaveBeenCalled();
  view.unmount();

  onShowItem.mockClear();
  renderPanel({
    queue: [ready, first, second],
    onShowItem,
    selectedItem: second,
  });
  fireEvent.click(screen.getByRole("button", { name: /^No resume: 2/ }));
  expect(onShowItem).not.toHaveBeenCalled();
});

it("queues all 53 ready applications with one press, or just this page", () => {
  const onApplyToJobs = vi.fn();
  renderPanel({
    queue: Array.from({ length: 53 }, (_, i) => createReadyItem(`ready_${i}`)),
    onApplyToJobs,
  });
  expect(screen.queryByText(/start now/)).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Apply to all 53 ready" }),
  );
  expect(onApplyToJobs).toHaveBeenLastCalledWith(
    Array.from({ length: 53 }, (_, i) => `ready_${i}`),
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply to these 50" }));
  expect(onApplyToJobs.mock.lastCall?.[0]).toHaveLength(50);
});

it("leaves jobs an Apply queue already holds out of the ready count", () => {
  renderPanel({
    queue: [createReadyItem("queued"), createReadyItem("free")],
    queuedJobIds: new Set(["queued"]),
    onApplyToJobs: vi.fn(),
  });
  expect(
    screen.getByRole("button", { name: "Apply to the 1 ready job" }),
  ).toBeTruthy();
});

it("applies to the ticked ready jobs and says how many still need a resume", () => {
  const onApplyToJobs = vi.fn();
  renderPanel({
    queue: [
      createReadyItem("ready_a"),
      createReadyItem("ready_b"),
      createEligibleItem("missing_a"),
    ],
    onApplyToJobs,
    applyVerb: "Prepare",
  });
  for (const checkbox of screen.getAllByRole("checkbox").slice(1)) {
    fireEvent.click(checkbox);
  }
  expect(screen.getByTestId("apply-selected-not-ready").textContent).toBe(
    "1 of the selected needs its resume first; Create 1 resume writes the missing ones.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Prepare 2 selected" }));
  expect(onApplyToJobs).toHaveBeenCalledWith(
    expect.arrayContaining(["ready_a", "ready_b"]),
  );
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
    within(filters).getByRole("button", { name: "Ready: 2 jobs" }),
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

// 103 rows and full-page role queries: about 1.5 s alone, past 5 s under a
// busy full run.
it(
  "selects the page with its checkbox, everything with Select all, and clears",
  { timeout: 20_000 },
  () => {
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
    expect(
      screen.getByRole("button", { name: "Create 1 resume" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Select all 103" }));
    fireEvent.click(screen.getByRole("button", { name: "Create 102 resumes" }));
    expect(onPrepareTailoredDrafts).toHaveBeenCalledExactlyOnceWith(
      expect.arrayContaining(queue.slice(1).map((item) => item.jobId)),
    );
  },
);
