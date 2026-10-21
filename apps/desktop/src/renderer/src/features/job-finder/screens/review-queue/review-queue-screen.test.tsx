// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { ApplicationRecordSchema } from "@nestor/contracts";
import type {
  ApplicationAutomationMode,
  ApplicationRecord,
  BrowserSessionState,
  GlobalDailyApplicationPreparationCapacity,
  ResumeSourceDocument,
  ReviewQueueItem,
  SavedJob,
  TailoredAsset,
} from "@nestor/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { JobFinderAutoApplyQueueStartOutcome } from "@renderer/features/job-finder/lib/job-finder-types";
import { clearJobDetailCache } from "../../hooks/use-job-detail";
import { ReviewQueueScreen } from "./review-queue-screen";
import type { TailoredDraftPreparationViewState } from "./review-queue-status";

beforeEach(() => {
  window.localStorage?.clear();

  class ResizeObserverMock {
    observe() {}

    disconnect() {}

    unobserve() {}
  }

  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => {
  cleanup();
  clearJobDetailCache();
  vi.unstubAllGlobals();
});

function createIdleDraftPreparation(): TailoredDraftPreparationViewState {
  return {
    attemptedCount: 0,
    completedCount: 0,
    currentIndex: null,
    eligibleRemainingCount: 0,
    failedCount: 0,
    status: "idle",
    totalCount: 0,
  };
}

function createEligibleItem(jobId: string): ReviewQueueItem {
  return {
    jobId,
    title: `Role ${jobId}`,
    company: "Acme",
    location: "Remote",
    matchScore: 80,
    applicationStatus: "shortlisted",
    assetStatus: "not_started",
    progressPercent: null,
    resumeAssetId: null,
    resumeApplicationMode: "tailored_per_job",
    resumeReview: { status: "not_started" },
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

function createBrowserSession(): BrowserSessionState {
  return {
    source: "user",
    status: "unknown",
    driver: "catalog_seed",
    label: "Browser",
    detail: null,
    lastCheckedAt: "2026-08-20T00:00:00.000Z",
  } as unknown as BrowserSessionState;
}

function createOriginalResume(): ResumeSourceDocument {
  return {
    id: "resume_base",
    fileName: "base-resume.pdf",
    uploadedAt: "2026-08-20T00:00:00.000Z",
  } as unknown as ResumeSourceDocument;
}

function omitListingText(job: SavedJob) {
  const row: Omit<SavedJob, "description" | "summary"> &
    Partial<Pick<SavedJob, "description" | "summary">> = { ...job };
  delete row.description;
  delete row.summary;
  return row;
}

function renderScreen(props: {
  resumeBatchCheckpoint?: Parameters<
    typeof ReviewQueueScreen
  >[0]["resumeBatchCheckpoint"];
  applicationAutomationMode?: ApplicationAutomationMode;
  applicationRecords?: readonly ApplicationRecord[];
  dailyCapacity?: GlobalDailyApplicationPreparationCapacity;
  resumeOperationStarts?: Readonly<Record<string, number>>;
  browserSession?: BrowserSessionState;
  isJobPending?: (jobId: string) => boolean;
  campaignId?: string;
  draftPreparation?: TailoredDraftPreparationViewState;
  onGenerateResume?: (
    jobId: string,
    options?: { selectAfter?: boolean },
  ) => Promise<boolean>;
  onPrepareTailoredDrafts?: () => void;
  onStartAutoApplyQueue?: (
    jobIds: string[],
    applicationAutomationMode?: ApplicationAutomationMode,
  ) => Promise<JobFinderAutoApplyQueueStartOutcome>;
  onStopTailoredDraftPreparation?: () => void;
  onSelectItem?: (jobId: string) => void;
  onReadJobListing?: (jobId: string) => Promise<void>;
  queue: readonly ReviewQueueItem[];
  selectedItem?: ReviewQueueItem | null;
  selectedJob?: SavedJob | null;
  selectedAsset?: TailoredAsset | null;
}) {
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      ...window.nestor,
      jobFinder: {
        ...window.nestor?.jobFinder,
        getJobDetail: vi.fn((_jobId: string, planId: string | null) =>
          Promise.resolve({
            job: props.selectedJob,
            planId,
          }),
        ),
      },
    },
  });
  const selectedRow = props.selectedJob
    ? omitListingText(props.selectedJob)
    : null;
  return render(
    <MemoryRouter>
      <ReviewQueueScreen
        applicationAutomationMode={
          props.applicationAutomationMode ?? "prepare_only"
        }
        resumeOperationStarts={props.resumeOperationStarts}
        applicationRecords={props.applicationRecords ?? []}
        actionState={{ message: null }}
        browserSession={props.browserSession ?? createBrowserSession()}
        campaignId={props.campaignId ?? "campaign_1"}
        resumeBatchCheckpoint={props.resumeBatchCheckpoint}
        draftPreparation={
          props.draftPreparation ?? createIdleDraftPreparation()
        }
        globalDailyApplicationPreparationCapacity={props.dailyCapacity ?? null}
        isApplyPending={false}
        isJobPending={props.isJobPending ?? (() => false)}
        onPrepareTailoredDrafts={props.onPrepareTailoredDrafts ?? vi.fn()}
        onStopTailoredDraftPreparation={
          props.onStopTailoredDraftPreparation ?? vi.fn()
        }
        onStartAutoApplyQueue={
          props.onStartAutoApplyQueue ??
          vi.fn<
            NonNullable<
              Parameters<typeof renderScreen>[0]["onStartAutoApplyQueue"]
            >
          >(() => Promise.resolve({ status: "confirmed" }))
        }
        onStartApplyCopilot={vi.fn()}
        onEditResumeWorkspace={vi.fn()}
        onGenerateResume={
          props.onGenerateResume ??
          vi.fn<
            (
              jobId: string,
              options?: { selectAfter?: boolean },
            ) => Promise<boolean>
          >(() => Promise.resolve(true))
        }
        onOpenBrowserSession={vi.fn()}
        onOpenJobDetails={vi.fn()}
        onOpenProfile={vi.fn()}
        onRemoveReviewJob={vi.fn()}
        onSetJobResumeApplicationMode={vi.fn()}
        onSelectItem={props.onSelectItem ?? vi.fn()}
        {...(props.onReadJobListing
          ? { onReadJobListing: props.onReadJobListing }
          : {})}
        originalResume={createOriginalResume()}
        queue={props.queue}
        selectedAsset={props.selectedAsset ?? null}
        selectedItem={props.selectedItem ?? null}
        selectedJob={selectedRow}
      />
    </MemoryRouter>,
  );
}

describe("ReviewQueueScreen tailored draft preparation (controlled)", () => {
  it("shows a moving elapsed clock and a stated expectation instead of a fabricated percentage", () => {
    vi.useFakeTimers();

    try {
      const selectedItem: ReviewQueueItem = {
        ...createEligibleItem("job_generating"),
        assetStatus: "generating",
      };

      const operationStartedAt = Date.now();
      const props = {
        resumeOperationStarts: { job_generating: operationStartedAt },
        isJobPending: (jobId: string) => jobId === "job_generating",
        queue: [selectedItem],
        selectedItem,
        selectedJob: {
          id: selectedItem.jobId,
          title: "Senior Frontend Engineer",
          company: "Acme",
          location: "Remote",
          summary: "Build dependable hiring tooling.",
          description: "Build dependable hiring tooling.",
          matchAssessment: {
            score: 82,
            reasons: ["Relevant experience"],
            gaps: [],
            recommendation: "review_before_applying",
            recommendationRationale: null,
            requirements: [],
          },
        } as unknown as SavedJob,
      };
      const view = renderScreen(props);

      const elapsed = document.querySelector("[data-resume-draft-elapsed]");
      expect(elapsed).not.toBeNull();
      expect(elapsed?.textContent).toBe("0:00");

      // The old bar climbed a made-up percentage to a 94% ceiling and froze
      // there; nothing in the pipeline can substantiate a completion fraction.
      expect(document.body.textContent).not.toContain("% estimated");
      for (const bar of document.querySelectorAll('[role="progressbar"]')) {
        expect(bar.getAttribute("aria-valuenow")).toBeNull();
      }

      expect(
        document.querySelector("[data-resume-draft-expected-wait]")
          ?.textContent,
      ).toBe(
        "Writing and checking the facts can take a few minutes, especially for Aggressive resumes.",
      );

      act(() => {
        vi.advanceTimersByTime(3_000);
      });

      expect(
        document.querySelector("[data-resume-draft-elapsed]")?.textContent,
      ).toBe("0:03");
      view.unmount();
      act(() => {
        vi.advanceTimersByTime(12_000);
      });
      renderScreen(props);
      expect(
        document.querySelector("[data-resume-draft-elapsed]")?.textContent,
      ).toBe("0:15");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses canonical workflow status for a ready asset that still needs approval", () => {
    const selectedItem: ReviewQueueItem = {
      ...createEligibleItem("job_needs_approval"),
      assetStatus: "ready",
      progressPercent: 100,
      resumeAssetId: "asset_needs_approval",
      resumeReview: { status: "draft" },
    };

    renderScreen({ queue: [selectedItem], selectedItem });

    // The row and the detail header must name the same canonical state,
    // never two names for one job. Once on the selected row (rows keep their
    // badge when selected) and once in the detail header.
    expect(screen.getAllByText("Ready to apply").length).toBe(2);
    expect(screen.queryByText("Review resume")).toBeNull();
  });

  it("delegates the create-all run to the page controller without owning it", () => {
    const onPrepareTailoredDrafts = vi.fn();
    const onGenerateResume = vi
      .fn<
        (jobId: string, options?: { selectAfter?: boolean }) => Promise<boolean>
      >()
      .mockResolvedValue(true);

    renderScreen({
      onGenerateResume,
      onPrepareTailoredDrafts,
      queue: [
        createEligibleItem("job_1"),
        createEligibleItem("job_2"),
        createEligibleItem("job_3"),
      ],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Create 3 missing resumes" }),
    );

    expect(onPrepareTailoredDrafts).toHaveBeenCalledTimes(1);
    expect(onGenerateResume).not.toHaveBeenCalled();
  });

  it("renders running progress from controller state and forwards cooperative stop", () => {
    const onStopTailoredDraftPreparation = vi.fn();

    renderScreen({
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
      queue: [
        createEligibleItem("job_1"),
        createEligibleItem("job_2"),
        createEligibleItem("job_3"),
      ],
    });

    expect(screen.getByText(/Writing resumes · 1 of 3 finished/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Stop new resumes" }));

    expect(onStopTailoredDraftPreparation).toHaveBeenCalledTimes(1);
  });

  it("renders the finished aggregate result from controller state", () => {
    renderScreen({
      draftPreparation: {
        attemptedCount: 3,
        completedCount: 3,
        currentIndex: null,
        eligibleRemainingCount: 0,
        failedCount: 0,
        status: "completed",
        totalCount: 3,
      },
      queue: [
        createEligibleItem("job_1"),
        createEligibleItem("job_2"),
        createEligibleItem("job_3"),
      ],
    });

    expect(screen.getByText(/Wrote 3 resumes/)).toBeTruthy();
  });

  it("offers the full missing-resume queue in one start", () => {
    const onPrepareTailoredDrafts = vi.fn();
    const queue = Array.from({ length: 12 }, (_, index) =>
      createEligibleItem(`job_${index}`),
    );

    renderScreen({ onPrepareTailoredDrafts, queue });

    fireEvent.click(
      screen.getByRole("button", { name: "Create 12 missing resumes" }),
    );
    expect(screen.queryByText(/more after that/)).toBeNull();
    expect(onPrepareTailoredDrafts).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 2])(
    "keeps a ready batch within %i remaining daily slots",
    async (remaining) => {
      const onStartAutoApplyQueue = vi
        .fn<
          (jobIds: string[]) => Promise<JobFinderAutoApplyQueueStartOutcome>
        >()
        .mockResolvedValue({ status: "confirmed" });
      renderScreen({
        dailyCapacity: {
          limit: 2,
          used: 2 - remaining,
          legacyUncertain: 0,
          remaining,
          localDate: "2026-09-26",
          resetsAt: "2026-09-27T00:00:00.000Z",
        },
        onStartAutoApplyQueue,
        queue: ["job_a", "job_b"].map((jobId) => ({
          ...createEligibleItem(jobId),
          assetStatus: "ready",
          resumeAssetId: `asset_${jobId}`,
          resumeReview: { status: "needs_review" },
        })),
      });

      if (remaining === 0) {
        expect(screen.queryByTestId("apply-all-ready")).toBeNull();
        expect(onStartAutoApplyQueue).not.toHaveBeenCalled();
        return;
      }
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name:
              remaining === 1
                ? "Apply to the 1 ready job"
                : "Apply to all 2 ready jobs",
          }),
        );
        await Promise.resolve();
      });
      expect(onStartAutoApplyQueue).toHaveBeenCalledWith(
        ["job_a", "job_b"].slice(0, remaining),
        "prepare_only",
      );
    },
  );

  it.each([
    "prepare_only",
    "confirm_before_submit",
    "autonomous_submit",
  ] as const)(
    "applies to every ready job in one press with %s, leaving jobs already in Applications alone",
    async (applicationAutomationMode) => {
      const onStartAutoApplyQueue = vi
        .fn<
          (jobIds: string[]) => Promise<JobFinderAutoApplyQueueStartOutcome>
        >()
        .mockResolvedValue({ status: "confirmed" });
      const ready = (jobId: string): ReviewQueueItem => ({
        ...createEligibleItem(jobId),
        assetStatus: "ready",
        resumeAssetId: `asset_${jobId}`,
        resumeReview: { status: "needs_review" },
      });

      renderScreen({
        applicationAutomationMode,
        applicationRecords: [
          ApplicationRecordSchema.parse({
            id: "application_done",
            jobId: "job_done",
            title: "Role job_done",
            company: "Acme",
            status: "ready_for_review",
            lastAttemptState: null,
            lastActionLabel: "Prepared",
            nextActionLabel: "Send",
            lastUpdatedAt: "2026-08-30T10:00:00.000Z",
          }),
        ],
        onStartAutoApplyQueue,
        queue: [ready("job_a"), ready("job_b"), ready("job_done")],
      });

      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Apply to all 2 ready jobs" }),
        );
        await Promise.resolve();
      });

      expect(onStartAutoApplyQueue).toHaveBeenCalledWith(
        ["job_a", "job_b"],
        applicationAutomationMode,
      );
    },
  );
});

describe("ReviewQueueScreen single-column workspace", () => {
  function createSelectedJob(jobId: string): SavedJob {
    return {
      id: jobId,
      title: `Role ${jobId}`,
      company: "Acme",
      location: "Remote",
      summary: "Build dependable hiring tooling.",
      description: "Build dependable hiring tooling.",
      matchAssessment: {
        score: 82,
        reasons: ["Relevant experience"],
        gaps: [],
        recommendation: "review_before_applying",
        recommendationRationale: null,
        requirements: [],
      },
    } as unknown as SavedJob;
  }

  it("has no tab strip: the shortlisted job is one linear column", () => {
    const selectedItem = createEligibleItem("job_column");
    renderScreen({
      queue: [selectedItem],
      selectedItem,
      selectedJob: createSelectedJob(selectedItem.jobId),
    });

    // Readiness / Resume / Job details split one strictly ordered job across
    // three destinations, two of which were nearly empty.
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();

    const column = screen.getByTestId("review-queue-workspace-column");
    // State and next action first, the job facts under them, one job title in
    // the detail header.
    expect(column.textContent).toContain("Open full job details");
    expect(column.textContent).toContain("About this job");
    expect(
      screen.getAllByRole("heading", { name: `Role ${selectedItem.jobId}` }),
    ).toHaveLength(1);
  });

  it("holds the scoring breakdown behind one disclosure", () => {
    const selectedItem = createEligibleItem("job_scored");
    renderScreen({
      queue: [selectedItem],
      selectedItem,
      selectedJob: createSelectedJob(selectedItem.jobId),
    });

    const disclosure = screen
      .getByText("How this was scored")
      .closest("details");
    expect(disclosure).toBeInstanceOf(HTMLDetailsElement);
    expect((disclosure as HTMLDetailsElement).open).toBe(false);
  });

  it("shows no resume section until a resume exists", () => {
    const selectedItem = createEligibleItem("job_no_resume");
    renderScreen({
      queue: [selectedItem],
      selectedItem,
      selectedJob: createSelectedJob(selectedItem.jobId),
    });

    // The Resume tab was a ~600px empty box duplicating the primary above it.
    expect(
      screen.queryByRole("heading", { level: 2, name: "Resume" }),
    ).toBeNull();
  });
});

describe("ReviewQueueScreen locked pane scroll regions", () => {
  function createSelectedJob(jobId: string): SavedJob {
    return {
      id: jobId,
      title: `Role ${jobId}`,
      company: "Acme",
      location: "Remote",
      summary: "Build dependable hiring tooling.",
      description: "Build dependable hiring tooling.",
      matchAssessment: {
        score: 82,
        reasons: ["Relevant experience"],
        gaps: [],
        recommendation: "review_before_applying",
        recommendationRationale: null,
        requirements: [],
      },
    } as unknown as SavedJob;
  }

  it("owns exactly one scroller per column", () => {
    const selectedItem = createEligibleItem("job_region");
    renderScreen({
      queue: [selectedItem],
      selectedItem,
      selectedJob: createSelectedJob(selectedItem.jobId),
    });

    // The shortlist column and the workspace column: the stacked panels
    // inside the workspace never add a second nested scroll owner.
    const regions = Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-locked-pane-scroll-region]",
      ),
    );
    expect(regions).toHaveLength(2);
    for (const region of regions) {
      expect(region.className).toContain("overflow-y-auto");
      expect(
        region.querySelectorAll("[data-locked-pane-scroll-region]"),
      ).toHaveLength(0);
    }
    expect(
      screen
        .getByTestId("review-queue-workspace-column")
        .getAttribute("data-locked-pane-scroll-region"),
    ).not.toBeNull();
  });

  it("keeps the resume preview inside the one workspace scroller", () => {
    const selectedItem: ReviewQueueItem = {
      ...createEligibleItem("job_tailored_preview"),
      assetStatus: "ready",
      progressPercent: 100,
      resumeAssetId: "asset_tailored_preview",
      resumeReview: { status: "needs_review" },
    };
    const selectedAsset: TailoredAsset = {
      id: "asset_tailored_preview",
      jobId: "job_tailored_preview",
      kind: "resume",
      status: "ready",
      label: "Tailored resume v1",
      version: "v1",
      templateName: "standard",
      compatibilityScore: 92,
      progressPercent: 100,
      updatedAt: "2026-08-20T00:00:00.000Z",
      storagePath: null,
      contentText: null,
      previewSections: [
        { heading: "Summary", lines: ["Dependable product engineer."] },
      ],
      generationMethod: "deterministic",
      notes: [],
      failureMessage: null,
      failedAt: null,
    };

    renderScreen({
      queue: [selectedItem],
      selectedItem,
      selectedAsset,
      selectedJob: createSelectedJob(selectedItem.jobId),
    });

    const column = screen.getByTestId("review-queue-workspace-column");
    expect(
      column.querySelector("[data-resume-preview-card]"),
    ).toBeTruthy();
    expect(
      column.querySelectorAll("[data-locked-pane-scroll-region]"),
    ).toHaveLength(0);
  });

  it("leaves empty shortlist states unmarked", () => {
    renderScreen({ queue: [] });

    // No selected job: only the workspace column is a scroll owner.
    expect(
      document.querySelectorAll("[data-locked-pane-scroll-region]"),
    ).toHaveLength(1);
  });
});

describe("ReviewQueueScreen job details honesty", () => {
  function buildJob(input: {
    jobId: string;
    summary: string;
    title: string;
  }): SavedJob {
    return {
      id: input.jobId,
      title: input.title,
      company: "Acme",
      location: "Remote",
      summary: input.summary,
      description: input.summary,
      discoveryMethod: "browser_agent",
      matchAssessment: {
        score: 64,
        reasons: ["Role title aligns with the current target roles."],
        gaps: [],
        recommendation: "review_before_applying",
        recommendationRationale: null,
        requirements: [],
        contextFingerprint: "context_v1",
        postingFingerprint: "posting_v1",
      },
    } as unknown as SavedJob;
  }

  it("presents an unverified score provisionally and drops an echoed summary", async () => {
    const selectedItem = createEligibleItem("job_title_only");
    renderScreen({
      queue: [selectedItem],
      selectedItem,
      selectedJob: buildJob({
        jobId: selectedItem.jobId,
        // The only "summary" the listing carried is its own title.
        summary: selectedItem.title,
        title: selectedItem.title,
      }),
    });

    // The withheld rule now names what was actually checked instead of
    // printing a percentage the app has not earned.
    expect(screen.getByTestId("review-queue-fit-score").textContent).toBe(
      "Not judged yet",
    );
    // The preview points to the available full-details control; the stored
    // assessment explanation remains inside its breakdown, which reads the
    // full assessment with the job detail.
    expect(
      await screen.findAllByText(
        "The AI judges each job against your profile and goals after a search. Choose Read and assess listing to judge this one now.",
      ),
    ).toHaveLength(1);
    expect(
      await screen.findByText(
        "The listing text was not captured. Open the full job details to read it.",
      ),
    ).toBeTruthy();

    // The route to the real posting sits with the job, not below the
    // evidence cards.
    const openListing = screen.getByRole("button", {
      name: "Open full job details",
    });
    const breakdown = screen.getByRole("region", {
      name: /score and evidence/iu,
    });
    expect(
      openListing.compareDocumentPosition(breakdown) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("offers to read a missing listing again and says why a read failed", async () => {
    const selectedItem = createEligibleItem("job_card_only");
    let fail: (error: Error) => void = () => undefined;
    const onReadJobListing = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    );
    renderScreen({
      queue: [selectedItem],
      selectedItem,
      onReadJobListing,
      selectedJob: buildJob({
        jobId: selectedItem.jobId,
        summary: selectedItem.title,
        title: selectedItem.title,
      }),
    });
    const read = await screen.findByRole("button", {
      name: "Read the listing again",
    });
    fireEvent.click(read);
    expect(onReadJobListing).toHaveBeenCalledWith(selectedItem.jobId);
    expect(
      screen.getByRole("button", {
        name: /Reading the listing/u,
      }),
    ).toBeTruthy();
    await act(async () => {
      fail(new Error("The site refused the request."));
      await Promise.resolve();
    });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Read the listing again" }),
    ).toBeTruthy();
  });

  it("withholds the score for the shape the real scorer emits for a card-only listing", () => {
    // Regression guard: the bare fixture above passed while the shape the
    // matching engine actually produces — an "adjacent" role verdict plus a
    // saved-preference location requirement that stayed unknown — printed a
    // bare percentage on this screen and on Find jobs.
    const selectedItem = createEligibleItem("job_real_title_only");
    const job = buildJob({
      jobId: selectedItem.jobId,
      summary: selectedItem.title,
      title: selectedItem.title,
    });
    renderScreen({
      queue: [selectedItem],
      selectedItem,
      selectedJob: {
        ...job,
        matchAssessment: {
          ...job.matchAssessment,
          score: 54,
          compensationFit: { state: "unknown" },
          dimensions: {
            roleSuitability: {
              state: "adjacent",
              explanation:
                "The title matches, but the listing text was not captured, so nothing beyond the title could be checked.",
              evidence: [],
            },
            preferenceAlignment: { state: "unknown", evidence: [] },
            applicationEffort: { level: "unknown", evidence: [] },
            evidenceConfidence: { level: "unavailable", evidence: [] },
          },
          requirements: [
            {
              id: "location_not_stated",
              category: "location",
              label: "Location (not stated in listing)",
              importance: "required",
              status: "unknown",
              jobEvidence: "The listing does not state a location.",
              resumeEvidence: [],
              explanation:
                "The listing does not state a location, so it could not be compared with the saved search areas.",
            },
          ],
        },
      } as unknown as SavedJob,
    });

    expect(screen.getByTestId("review-queue-fit-score").textContent).toBe(
      "Not judged yet",
    );
    // No number anywhere until the model has judged the job (ADR 0041).
    expect(screen.queryByText(/54%/)).toBeNull();
  });

  it("keeps real listing text and a plain score when evidence was checked", async () => {
    const selectedItem = createEligibleItem("job_verified");
    const job = buildJob({
      jobId: selectedItem.jobId,
      summary: "Own the deployment pipeline for the payments platform.",
      title: selectedItem.title,
    });
    renderScreen({
      queue: [selectedItem],
      selectedItem,
      selectedJob: {
        ...job,
        matchAssessment: {
          ...job.matchAssessment,
          judgment: {
            source: "batch",
            judgedAt: "2026-10-02T10:00:00.000Z",
            score: 64,
            recommendation: "review_before_applying",
          },
          requirements: [
            {
              id: "req_1",
              label: "Backend services",
              importance: "required",
              status: "supported",
              explanation: "Matches saved backend experience.",
              jobEvidence: "Own backend services.",
              resumeEvidence: [],
            },
          ],
        },
      } as unknown as SavedJob,
    });

    expect(screen.getByTestId("review-queue-fit-score").textContent).toBe(
      "64% fit",
    );
    expect(
      await screen.findByText(
        "Own the deployment pipeline for the payments platform.",
      ),
    ).toBeTruthy();
  });
  it("keeps country suitability beside original-resume readiness (R3-177)", async () => {
    const item = {
      ...createEligibleItem("job_overseas"),
      resumeApplicationMode: "original_resume" as const,
    };
    const job = buildJob({
      jobId: item.jobId,
      title: item.title,
      summary: "Customer success",
    });
    renderScreen({
      queue: [item],
      selectedItem: item,
      selectedJob: {
        ...job,
        resumeApplicationMode: "original_resume",
        matchAssessment: {
          ...job.matchAssessment,
          recommendation: "review_before_applying",
          locationReach: "outside_area",
          gaps: ["UK work permission is not confirmed."],
          dimensions: {
            ...job.matchAssessment.dimensions,
            preferenceAlignment: {
              state: "conflict",
              explanation: "Remote UK only; you can work in the United States.",
              evidence: [],
            },
          },
        },
      } as SavedJob,
    });
    // The written preference verdict arrives with the job detail.
    await vi.waitFor(() =>
      expect(
        screen.getByTestId("queue-suitability-warning").textContent,
      ).toContain("Remote UK only"),
    );
    expect(
      screen.getByTestId("queue-suitability-warning").textContent,
    ).toContain("UK work permission");
    expect(screen.getByTestId("application-action-row").textContent).toContain(
      "Apply",
    );
  });

  it("shows why a completed read changed the score (R3-106)", () => {
    const item = createEligibleItem("job_rescored");
    const job = buildJob({
      jobId: item.jobId,
      title: item.title,
      summary: "Customer success",
    });
    const reason =
      "After reading the listing, your fit changed from 48% to 32%. Required enterprise-sales experience is not evidenced.";
    renderScreen({
      queue: [item],
      selectedItem: item,
      selectedJob: {
        ...job,
        matchAssessment: {
          ...job.matchAssessment,
          recommendation: "review_before_applying",
          recommendationRationale: reason,
          judgment: {
            source: "full",
            judgedAt: "2026-10-04T00:00:00Z",
            score: 32,
            recommendation: "review_before_applying",
          },
        },
      } as SavedJob,
    });
    expect(screen.getByTestId("queue-full-assessment-reason").textContent).toBe(
      reason,
    );
  });
});

describe("ReviewQueueScreen readiness agreement", () => {
  it("badges an already-prepared job the same way in the list and the header", () => {
    // The panel saw "RESUME NEEDS REVIEW" and "READY TO APPLY" for one job
    // seconds apart: the row read the prepared-application set and the
    // workspace header computed its own verdict without it.
    const item: ReviewQueueItem = {
      ...createEligibleItem("job_prepared"),
      assetStatus: "ready",
      resumeAssetId: "asset_prepared",
      resumeReview: {
        status: "approved",
        approvedAt: "2026-08-20T00:00:00.000Z",
        approvedExportId: "export_prepared",
        approvedFormat: "pdf",
        approvedFilePath: "/tmp/prepared.pdf",
      },
    };

    renderScreen({
      applicationRecords: [
        ApplicationRecordSchema.parse({
          id: "application_prepared",
          jobId: "job_prepared",
          title: "Role job_prepared",
          company: "Acme",
          status: "ready_for_review",
          lastActionLabel: "Prepared application",
          nextActionLabel: "Review",
          lastUpdatedAt: "2026-08-20T00:00:00.000Z",
        }),
      ],
      queue: [item],
      selectedItem: item,
    });

    const badges = screen.getAllByText("In Applications");
    expect(badges.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("Ready to apply")).toBeNull();
  });
});
it("offers no second button for unfinished jobs that Create missing resumes already covers", () => {
  const onPrepareTailoredDrafts = vi.fn();
  renderScreen({
    queue: [createEligibleItem("unfinished"), createEligibleItem("untouched")],
    resumeBatchCheckpoint: {
      id: "batch",
      jobIds: ["finished", "unfinished"],
      activeJobIds: ["unfinished"],
      completedJobIds: ["finished"],
      done: false,
      stopRequested: false,
    },
    onPrepareTailoredDrafts,
  });
  expect(screen.queryByText(/resume batch did not finish/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Continue batch" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Create 2 missing resumes" }),
  );
  expect(onPrepareTailoredDrafts).toHaveBeenCalledWith([
    "unfinished",
    "untouched",
  ]);
});

it("keeps the unfinished-batch notice when the batch carries a per-job choice", () => {
  const onPrepareTailoredDrafts = vi.fn();
  renderScreen({
    queue: [createEligibleItem("unfinished"), createEligibleItem("untouched")],
    resumeBatchCheckpoint: {
      id: "batch",
      jobIds: ["finished", "unfinished"],
      activeJobIds: [],
      completedJobIds: ["finished"],
      done: false,
      stopRequested: false,
      requests: [{ jobId: "unfinished", level: "aggressive" }],
    },
    onPrepareTailoredDrafts,
  });
  // A quiet line under the title, not a box above the list (issue #50).
  const line = screen.getByText(
    "The last resume batch did not finish: 1 resume not written yet.",
  );
  expect(line.closest("[data-page-header-status]")).toBeTruthy();
  expect(document.querySelector("[data-interrupted-resume-notice]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Continue batch" }));
  expect(onPrepareTailoredDrafts).toHaveBeenCalledWith(["unfinished"]);
});

it("says nothing about a batch whose unfinished jobs already have a resume or need one", () => {
  const withResume = {
    ...createEligibleItem("written_meanwhile"),
    assetStatus: "ready",
    resumeAssetId: "asset_written_meanwhile",
    resumeReview: { status: "needs_review" },
  } as unknown as ReviewQueueItem;
  renderScreen({
    queue: [createEligibleItem("unfinished"), withResume],
    resumeBatchCheckpoint: {
      id: "batch",
      jobIds: ["finished", "unfinished", "written_meanwhile"],
      activeJobIds: [],
      completedJobIds: ["finished"],
      done: false,
      stopRequested: false,
    },
  });
  expect(screen.queryByText(/resume batch/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Continue batch" })).toBeNull();
});

it("does not call a live assistant queue interrupted, and recovers unfinished existing drafts", () => {
  const item = createEligibleItem("rewrite");
  const checkpoint = {
    id: "assistant",
    jobIds: [item.jobId],
    activeJobIds: [],
    completedJobIds: [],
    done: false,
    stopRequested: false,
    running: true,
    requests: [{ jobId: item.jobId, regenerate: true, language: "German" }],
  };
  renderScreen({ queue: [item], resumeBatchCheckpoint: checkpoint });
  expect(screen.queryByRole("button", { name: "Continue batch" })).toBeNull();
  cleanup();
  renderScreen({
    queue: [
      { ...item, assetStatus: "ready", resumeReview: { status: "draft" } },
    ],
    resumeBatchCheckpoint: { ...checkpoint, running: false },
  });
  expect(screen.getByRole("button", { name: "Continue batch" })).toBeTruthy();
});

it("R3-184 shows measured time left only after two resumes finish", () => {
  const preparation = {
    ...createIdleDraftPreparation(),
    status: "running" as const,
    totalCount: 8,
    completedCount: 2,
    attemptedCount: 4,
    durationsMs: [120000, 180000],
  };
  renderScreen({
    queue: [createEligibleItem("one")],
    draftPreparation: preparation,
  });
  expect(screen.getByText(/about 8 min left/)).toBeTruthy();
});

it("offers the saved batch when its jobs are outside the current campaign", () => {
  const onPrepareTailoredDrafts = vi.fn();
  renderScreen({
    queue: [createEligibleItem("another_campaign")],
    resumeBatchCheckpoint: {
      id: "saved_batch",
      jobIds: ["elsewhere"],
      activeJobIds: [],
      completedJobIds: [],
      done: false,
      stopRequested: false,
      running: false,
    },
    onPrepareTailoredDrafts,
  });
  expect(
    screen.getByText(
      "The last resume batch did not finish: 1 resume not written yet.",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Continue batch" }));
  expect(onPrepareTailoredDrafts).toHaveBeenCalledWith(["elsewhere"]);
});

it("shows an assistant-owned batch in the usual control with progress, time left and Stop", async () => {
  const previous = window.nestor;
  const stopResumeBatch = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: { assistant: { stopResumeBatch } },
  });
  try {
    renderScreen({
      queue: [
        createEligibleItem("one"),
        createEligibleItem("two"),
        createEligibleItem("three"),
      ],
      resumeBatchCheckpoint: {
        id: "assistant",
        jobIds: ["one", "two", "three"],
        activeJobIds: ["three"],
        completedJobIds: ["one", "two"],
        done: false,
        stopRequested: false,
        running: true,
        durationsMs: [60000, 60000],
      },
    });
    expect(
      screen.getByText(/Writing resumes · 2 of 3 finished · about 1 min left/),
    ).toBeTruthy();
    expect(screen.queryByTestId("create-missing-resumes")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop new resumes" }));
    await vi.waitFor(() => expect(stopResumeBatch).toHaveBeenCalledOnce());
  } finally {
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: previous,
    });
  }
});

it("a 200-job unfinished batch of missing resumes is picked up by Create missing resumes and ticked jobs", () => {
  const queue = Array.from({ length: 200 }, (_, index) =>
    createEligibleItem(`unfinished-${index}`),
  );
  const checkpoint = {
    id: "large-batch",
    jobIds: queue.map((item) => item.jobId),
    activeJobIds: [],
    completedJobIds: [],
    done: false,
    stopRequested: false,
  };
  const onPrepareTailoredDrafts = vi.fn();
  renderScreen({
    queue,
    resumeBatchCheckpoint: checkpoint,
    onPrepareTailoredDrafts,
  });
  expect(screen.queryByText(/resume batch/)).toBeNull();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select the 50 jobs on this page" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select Role unfinished-50" }),
  );
  expect(
    screen.getByRole("button", { name: "Create 51 resumes" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Create 200 missing resumes" }),
  );
  expect(onPrepareTailoredDrafts).toHaveBeenCalledExactlyOnceWith(
    checkpoint.jobIds,
  );
});

it("shows a durable provider pause reason and retains a dismissible Continue control", () => {
  const queue = [
    createEligibleItem("blocked-one"),
    createEligibleItem("blocked-two"),
  ];
  const onPrepareTailoredDrafts = vi.fn();
  const providerBlock = {
    reason: "funding" as const,
    message:
      "The AI service is unavailable because its provider rejected the request for insufficient funds. Try again after service is restored.",
  };
  const checkpoint = {
    id: "funding-blocked-batch",
    jobIds: queue.map((item) => item.jobId),
    activeJobIds: [],
    completedJobIds: [],
    done: false,
    stopRequested: true,
    running: false,
    providerBlock,
  };
  const view = renderScreen({
    queue,
    resumeBatchCheckpoint: checkpoint,
    onPrepareTailoredDrafts,
    draftPreparation: {
      status: "stopped",
      attemptedCount: 50,
      completedCount: 0,
      failedCount: 0,
      totalCount: 2,
      eligibleRemainingCount: 2,
      currentIndex: null,
      providerBlock,
    },
  });
  expect(
    screen.getByText(/The resume batch is paused.*insufficient funds/),
  ).toBeTruthy();
  expect(screen.queryByText(/Run it again to retry the failed/)).toBeNull();
  expect(onPrepareTailoredDrafts).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Continue batch" }));
  expect(onPrepareTailoredDrafts).toHaveBeenCalledWith(checkpoint.jobIds);
  fireEvent.click(
    screen.getByRole("button", {
      name: /^Hide for now: The resume batch is paused/,
    }),
  );
  expect(
    screen.queryByText(/The resume batch is paused.*insufficient funds/),
  ).toBeNull();
  view.unmount();
  renderScreen({
    queue,
    resumeBatchCheckpoint: checkpoint,
    onPrepareTailoredDrafts,
  });
  expect(
    screen.queryByText(/The resume batch is paused.*insufficient funds/),
  ).toBeNull();
});
