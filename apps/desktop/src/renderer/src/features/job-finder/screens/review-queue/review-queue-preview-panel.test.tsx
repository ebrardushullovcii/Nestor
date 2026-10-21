// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewQueuePreviewPanel } from "./review-queue-preview-panel";

describe("ReviewQueuePreviewPanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("routes first-run users back to Find jobs from the empty shortlist state", () => {
    render(
      <MemoryRouter>
        <ReviewQueuePreviewPanel
          pendingElapsedSeconds={0}
          onEditResumeWorkspace={vi.fn()}
          onGenerateResume={vi.fn()}
          previewState={null}
          queue={[]}
          selectedAsset={null}
          selectedItem={null}
          selectedJob={null}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("No shortlisted jobs yet")).toBeTruthy();
    expect(
      screen.getByText(
        "Find jobs first, then shortlist the strongest matches to start building tailored resumes.",
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Go to Find jobs" })
        .getAttribute("href"),
    ).toBe("/job-finder/discovery");
  });

  it("shows the imported resume and makes the unchanged-file behavior explicit", () => {
    const selectedItem = {
      jobId: "job_1",
      title: "Product Designer",
      company: "Signal Systems",
      location: "Remote",
      matchScore: 92,
      applicationStatus: "ready_for_review" as const,
      resumeApplicationMode: "original_resume" as const,
      assetStatus: "ready" as const,
      progressPercent: 100,
      resumeAssetId: "resume_1",
      resumeReview: {
        status: "original_resume" as const,
        sourceDocumentId: "resume_1",
        fileName: "alex-original.pdf",
        filePath: "/tmp/alex-original.pdf",
      },
      updatedAt: "2026-07-14T10:00:00.000Z",
    };

    render(
      <MemoryRouter>
        <ReviewQueuePreviewPanel
          pendingElapsedSeconds={0}
          onEditResumeWorkspace={vi.fn()}
          onGenerateResume={vi.fn()}
          originalResume={{
            id: "resume_1",
            fileName: "alex-original.pdf",
            uploadedAt: "2026-07-14T10:00:00.000Z",
            storagePath: "/tmp/alex-original.pdf",
            textContent: "Alex Example\nProduct designer\nFull work history",
            textUpdatedAt: "2026-07-14T10:00:00.000Z",
            extractionStatus: "ready",
            lastAnalyzedAt: "2026-07-14T10:00:00.000Z",
            analysisProviderKind: null,
            analysisProviderLabel: null,
            analysisWarnings: [],
          }}
          previewState={null}
          queue={[selectedItem]}
          selectedAsset={null}
          selectedItem={selectedItem}
          selectedJob={null}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Original resume · unchanged")).toBeTruthy();
    expect(screen.getAllByText("alex-original.pdf")).toHaveLength(2);
    expect(screen.getByText(/does not rewrite it, remove roles/i)).toBeTruthy();
    expect(screen.getByText("File selected for attachment")).toBeTruthy();
    expect(screen.getByText("Read-only extracted text preview")).toBeTruthy();
    expect(
      screen.getByText(/attachment remains the original imported file/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Check sensitive personal details before attaching/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/home address, date of birth, nationality/i),
    ).toBeTruthy();
    expect(screen.getByText(/Full work history/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /create tailored resume/i }),
    ).toBeNull();
  });

  it("keeps the elapsed clock readable outside the progress fill and claims no percentage", () => {
    const selectedItem = {
      jobId: "job_generating",
      title: "Senior Frontend Engineer",
      company: "Mercury",
      location: "Remote",
      matchScore: 86,
      applicationStatus: "shortlisted",
      resumeApplicationMode: "tailored_per_job",
      assetStatus: "generating",
      progressPercent: 69,
      resumeAssetId: null,
      resumeReview: {
        status: "not_started",
      },
      updatedAt: "2026-07-31T12:00:00.000Z",
    } as never;

    render(
      <MemoryRouter>
        <ReviewQueuePreviewPanel
          pendingElapsedSeconds={69}
          isGenerating
          onEditResumeWorkspace={vi.fn()}
          onGenerateResume={vi.fn()}
          previewState={null}
          queue={[selectedItem]}
          selectedAsset={null}
          selectedItem={selectedItem}
          selectedJob={null}
        />
      </MemoryRouter>,
    );

    const progress = screen.getByRole("progressbar", {
      name: "Resume preparation in progress",
    });

    // The pipeline reports no completion fraction, so the bar must not assert
    // one. It used to sit frozen at a fabricated 94% for ~42s of a 57.7s draft.
    expect(progress.getAttribute("aria-valuenow")).toBeNull();
    expect(progress.getAttribute("aria-valuetext")).toBeNull();
    expect(progress.getAttribute("data-progress-indeterminate")).not.toBeNull();
    expect(screen.queryByText(/% estimated/)).toBeNull();

    const elapsed = screen.getByText("1:09");
    expect(elapsed.getAttribute("data-resume-draft-elapsed")).not.toBeNull();
    expect(elapsed.className).toContain("text-(--text-headline)");
    expect(progress.contains(elapsed)).toBe(false);

    expect(
      screen.getByText(
        "Writing and checking the facts can take a few minutes, especially for Aggressive resumes.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/The resume keeps writing/i)).toBeTruthy();
  });
});

describe("ReviewQueuePreviewPanel locked pane scroll regions", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  function expectLeafRegions(scope: ParentNode): HTMLElement[] {
    const regions = Array.from(
      scope.querySelectorAll<HTMLElement>("[data-locked-pane-scroll-region]"),
    );
    for (const region of regions) {
      // A marked pane must own scrolling without nesting another marker.
      expect(
        region.querySelectorAll("[data-locked-pane-scroll-region]"),
      ).toHaveLength(0);
    }
    return regions;
  }

  it("marks only the imported resume card scroller and leaves the raw-text box nested and unmarked", () => {
    const selectedItem = {
      jobId: "job_1",
      title: "Product Designer",
      company: "Signal Systems",
      location: "Remote",
      matchScore: 92,
      applicationStatus: "ready_for_review" as const,
      resumeApplicationMode: "original_resume" as const,
      assetStatus: "ready" as const,
      progressPercent: 100,
      resumeAssetId: "resume_1",
      resumeReview: {
        status: "original_resume" as const,
        sourceDocumentId: "resume_1",
        fileName: "alex-original.pdf",
        filePath: "/tmp/alex-original.pdf",
      },
      updatedAt: "2026-07-14T10:00:00.000Z",
    };

    const { container } = render(
      <ReviewQueuePreviewPanel
        pendingElapsedSeconds={0}
        onEditResumeWorkspace={vi.fn()}
        onGenerateResume={vi.fn()}
        originalResume={{
          id: "resume_1",
          fileName: "alex-original.pdf",
          uploadedAt: "2026-07-14T10:00:00.000Z",
          storagePath: "/tmp/alex-original.pdf",
          textContent: "Alex Example\nProduct designer\nFull work history",
          textUpdatedAt: "2026-07-14T10:00:00.000Z",
          extractionStatus: "ready",
          lastAnalyzedAt: "2026-07-14T10:00:00.000Z",
          analysisProviderKind: null,
          analysisProviderLabel: null,
          analysisWarnings: [],
        }}
        previewState={null}
        queue={[selectedItem]}
        selectedAsset={null}
        selectedItem={selectedItem}
        selectedJob={null}
      />,
    );

    const regions = expectLeafRegions(container);
    expect(regions).toHaveLength(1);
    const resumeScroller = screen
      .getByText("Original resume · unchanged")
      .closest<HTMLElement>("[data-locked-pane-scroll-region]");
    expect(resumeScroller).toBeTruthy();
    expect(resumeScroller?.className).toContain(
      "px-5 pb-5 min-h-0 flex-1 overflow-y-auto",
    );
    // The extracted raw-text preview scrolls natively inside the card; it must
    // not carry a second nested locked-pane marker.
    const rawTextBox = screen.getByText(/Full work history/);
    expect(rawTextBox.hasAttribute("data-locked-pane-scroll-region")).toBe(
      false,
    );
    expect(resumeScroller?.contains(rawTextBox)).toBe(true);
  });

  it("marks only the tailored resume preview scroller for a ready asset", () => {
    const selectedItem = {
      jobId: "job_preview",
      title: "Senior Frontend Engineer",
      company: "Mercury",
      location: "Remote",
      matchScore: 86,
      applicationStatus: "shortlisted" as const,
      resumeApplicationMode: "tailored_per_job" as const,
      assetStatus: "ready" as const,
      progressPercent: 100,
      resumeAssetId: "asset_preview",
      resumeReview: { status: "needs_review" as const },
      updatedAt: "2026-07-31T12:00:00.000Z",
    } as never;

    const { container } = render(
      <ReviewQueuePreviewPanel
        pendingElapsedSeconds={0}
        onEditResumeWorkspace={vi.fn()}
        onGenerateResume={vi.fn()}
        previewState={null}
        queue={[selectedItem]}
        selectedAsset={
          {
            id: "asset_preview",
            jobId: "job_preview",
            kind: "resume",
            status: "ready",
            label: "Tailored resume v1",
            version: "v1",
            templateName: "standard",
            compatibilityScore: 92,
            progressPercent: 100,
            updatedAt: "2026-07-31T12:00:00.000Z",
            storagePath: null,
            contentText: null,
            previewSections: [
              { heading: "Summary", lines: ["Dependable product engineer."] },
            ],
            generationMethod: "deterministic",
            notes: [],
            failureMessage: null,
            failedAt: null,
          } as never
        }
        selectedItem={selectedItem}
        selectedJob={null}
      />,
    );

    const regions = expectLeafRegions(container);
    expect(regions).toHaveLength(1);
    const previewScroller = container
      .querySelector("[data-resume-preview-card]")
      ?.closest<HTMLElement>("[data-locked-pane-scroll-region]");
    expect(previewScroller).toBeTruthy();
    expect(previewScroller?.className).toContain(
      "px-5 pb-5 min-h-0 flex-1 overflow-y-auto",
    );
  });

  it("names the document the original resume when nothing could be tailored", () => {
    const selectedItem = {
      jobId: "job_untailorable",
      title: "Senior Frontend Engineer",
      company: "Mercury",
      location: "Remote",
      matchScore: 86,
      applicationStatus: "shortlisted" as const,
      resumeApplicationMode: "tailored_per_job" as const,
      assetStatus: "ready" as const,
      progressPercent: 100,
      resumeAssetId: "asset_untailorable",
      resumeReview: { status: "needs_review" as const },
      updatedAt: "2026-07-31T12:00:00.000Z",
    } as never;

    render(
      <ReviewQueuePreviewPanel
        pendingElapsedSeconds={0}
        onEditResumeWorkspace={vi.fn()}
        onGenerateResume={vi.fn()}
        previewState={null}
        queue={[selectedItem]}
        selectedAsset={
          {
            id: "asset_untailorable",
            jobId: "job_untailorable",
            kind: "resume",
            status: "ready",
            label: "Tailored resume v1",
            version: "v1",
            templateName: "standard",
            compatibilityScore: 92,
            progressPercent: 100,
            updatedAt: "2026-07-31T12:00:00.000Z",
            storagePath: null,
            contentText: null,
            previewSections: [
              { heading: "Summary", lines: ["Dependable product engineer."] },
            ],
            generationMethod: "deterministic",
            generationReason: "listing_text_missing",
            notes: [],
            failureMessage: null,
            failedAt: null,
          } as never
        }
        selectedItem={selectedItem}
        selectedJob={null}
      />,
    );

    expect(screen.getByText("Your original wording")).toBeTruthy();
    expect(screen.queryByText("Tailored resume v1")).toBeNull();
  });

  it.each(["conservative", "balanced", "aggressive"] as const)(
    "leaves the label and the approval step to the rows above for %s",
    (resumeTailoringMode) => {
      const selectedItem = {
        jobId: "job_tailored",
        title: "Senior Frontend Engineer",
        company: "Mercury",
        location: "Remote",
        matchScore: 86,
        applicationStatus: "shortlisted" as const,
        resumeApplicationMode: "tailored_per_job" as const,
        resumeTailoringMode,
        assetStatus: "ready" as const,
        progressPercent: 100,
        resumeAssetId: "asset_tailored",
        resumeReview: { status: "needs_review" as const },
        updatedAt: "2026-07-31T12:00:00.000Z",
      } as never;

      render(
        <ReviewQueuePreviewPanel
          pendingElapsedSeconds={0}
          onEditResumeWorkspace={vi.fn()}
          onGenerateResume={vi.fn()}
          previewState={null}
          queue={[selectedItem]}
          selectedAsset={
            {
              id: "asset_tailored",
              jobId: "job_tailored",
              kind: "resume",
              status: "ready",
              label: "Tailored resume v1",
              version: "v1",
              templateName: "standard",
              compatibilityScore: 92,
              progressPercent: 100,
              updatedAt: "2026-07-31T12:00:00.000Z",
              storagePath: null,
              contentText: null,
              previewSections: [
                { heading: "Summary", lines: ["Dependable product engineer."] },
              ],
              generationMethod: "ai",
              generationReason: null,
              notes: [],
              failureMessage: null,
              failedAt: null,
            } as never
          }
          selectedItem={selectedItem}
          selectedJob={null}
        />,
      );

      // The pane header names the job and the level row names the resume;
      // what to do with it is the Next step box's line. The card opens on
      // the resume itself.
      expect(screen.queryByText("Tailored resume v1")).toBeNull();
      expect(screen.queryByText("Your original wording")).toBeNull();
      expect(
        screen.queryByText(
          "Read this resume through, then approve it before applying.",
        ),
      ).toBeNull();
      expect(
        screen.queryByText(
          "This is the resume as it stands. Edit it if you like; Apply approves it.",
        ),
      ).toBeNull();
      expect(
        document.querySelector("[data-resume-preview-card]"),
      ).toBeTruthy();
    },
  );

  it("leaves the centered generation-state wrapper unmarked", () => {
    const selectedItem = {
      jobId: "job_generating",
      title: "Senior Frontend Engineer",
      company: "Mercury",
      location: "Remote",
      matchScore: 86,
      applicationStatus: "shortlisted" as const,
      resumeApplicationMode: "tailored_per_job" as const,
      assetStatus: "generating" as const,
      progressPercent: 40,
      resumeAssetId: null,
      resumeReview: { status: "not_started" as const },
      updatedAt: "2026-07-31T12:00:00.000Z",
    } as never;

    const { container } = render(
      <ReviewQueuePreviewPanel
        pendingElapsedSeconds={40}
        isGenerating
        onEditResumeWorkspace={vi.fn()}
        onGenerateResume={vi.fn()}
        previewState={null}
        queue={[selectedItem]}
        selectedAsset={null}
        selectedItem={selectedItem}
        selectedJob={null}
      />,
    );

    expect(
      screen.getByRole("progressbar", {
        name: "Resume preparation in progress",
      }),
    ).toBeTruthy();
    expect(expectLeafRegions(container)).toHaveLength(0);
  });
});
