// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  BrowserSessionState,
  ReviewQueueItem,
  SavedJob,
  TailoredAsset,
} from "@nestor/contracts";
import { ApplicationRecordSchema } from "@nestor/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewQueueMissionPanel } from "./review-queue-mission-panel";

afterEach(cleanup);

function createBrowserSession(
  status: BrowserSessionState["status"] = "ready",
): BrowserSessionState {
  return {
    source: "target_site",
    status,
    driver: "chrome_profile_agent",
    label: "Browser ready",
    detail: "Ready when needed.",
    lastCheckedAt: "2026-08-30T10:00:00.000Z",
  } as BrowserSessionState;
}

function createJob(): SavedJob {
  return {
    id: "job_1",
    title: "Product Designer",
    company: "Example Co",
    location: "Remote",
    canonicalUrl: "https://jobs.example/role",
    applicationUrl: "https://jobs.example/apply",
    applyPath: "easy_apply",
    easyApplyEligible: true,
    matchAssessment: { score: 90, reasons: [], gaps: [] },
  } as unknown as SavedJob;
}

function createItem(overrides: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    jobId: "job_1",
    title: "Product Designer",
    company: "Example Co",
    location: "Remote",
    matchScore: 90,
    applicationStatus: "shortlisted",
    assetStatus: "not_started",
    progressPercent: null,
    resumeAssetId: null,
    resumeApplicationMode: "tailored_per_job",
    resumeTailoringMode: "balanced",
    resumeReview: { status: "not_started" },
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function createApprovedItem(): ReviewQueueItem {
  return createItem({
    assetStatus: "ready",
    resumeAssetId: "asset_1",
    resumeReview: {
      status: "approved",
      approvedAt: "2026-08-20T00:00:00.000Z",
      approvedExportId: "export_1",
      approvedFormat: "pdf",
      approvedFilePath: "/tmp/resume.pdf",
    },
  });
}

function createReadyAsset(
  overrides: Partial<TailoredAsset> = {},
): TailoredAsset {
  return {
    id: "asset_1",
    jobId: "job_1",
    kind: "resume",
    status: "ready",
    label: "Tailored Resume",
    version: "v1",
    templateName: "Chronology Classic",
    compatibilityScore: 80,
    progressPercent: 100,
    updatedAt: "2026-08-20T00:00:00.000Z",
    storagePath: "/tmp/resume.pdf",
    contentText: "Resume",
    previewSections: [],
    generationMethod: "ai",
    generationReason: null,
    notes: [],
    failureMessage: null,
    failedAt: null,
    ...overrides,
  } as unknown as TailoredAsset;
}

function renderPanel(
  overrides: Partial<Parameters<typeof ReviewQueueMissionPanel>[0]> = {},
) {
  const props = {
    actionMessage: null,
    applicationRecords: [],
    browserSession: createBrowserSession(),
    pendingElapsedSeconds: 0,
    isApplyPending: false,
    isJobPending: () => false,
    onEditResumeWorkspace: vi.fn(),
    onGenerateResume: vi.fn().mockResolvedValue(true),
    onOpenBrowserSession: vi.fn(),
    onOpenJobDetails: vi.fn(),
    onOpenProfile: vi.fn(),
    onRemoveReviewJob: vi.fn(),
    onSetJobResumeApplicationMode: vi.fn(),
    onStartApplyCopilot: vi.fn(),
    selectedAsset: createReadyAsset(),
    selectedItem: createApprovedItem(),
    selectedJob: createJob(),
    ...overrides,
  };
  render(<ReviewQueueMissionPanel {...props} />);
  return props;
}

describe("ReviewQueueMissionPanel", () => {
  it("keeps a hard conflict visible beside Apply for an Original resume", () => {
    renderPanel({
      selectedItem: createItem({ resumeApplicationMode: "original_resume" }),
      selectedJob: {
        ...createJob(),
        matchAssessment: {
          ...createJob().matchAssessment,
          recommendation: "skip",
          recommendationRationale:
            "The listing belongs to a different occupational role.",
        },
      },
    });
    expect(screen.getByText("Probably skip")).toBeTruthy();
    expect(
      screen.getByText("The listing belongs to a different occupational role."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
  });
  it("shows the resume level, one Apply, and one sentence on what Apply does", () => {
    const props = renderPanel();

    expect(
      screen.getByRole("radiogroup", { name: "Resume level for this job" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("radio", {
        name: "Light Light edits; stays close to your wording.",
      }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("radio", { name: /Tailored/ })
        .getAttribute("aria-checked"),
    ).toBe("true");

    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply.hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId("apply-outcome").textContent).toBe(
      "Job Finder opens the application, fills it in, attaches this resume, and leaves the browser open for you to send.",
    );
    // A ready job needs no state sentence above the button.
    expect(screen.queryByTestId("shortlisted-state-line")).toBeNull();

    fireEvent.click(apply);
    expect(props.onStartApplyCopilot).toHaveBeenCalledWith({ jobId: "job_1" });
  });

  it("carries none of the old readiness chrome", () => {
    renderPanel();

    for (const text of [
      "Application readiness",
      "Before the browser opens",
      "What happens when you prepare",
      "Checklist",
      "Batch actions",
      "Apply mode for this batch",
      "More actions",
    ]) {
      expect(screen.queryByText(text)).toBeNull();
    }
    expect(
      screen.getByRole("button", { name: "Open the listing" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Move back to Find jobs" }),
    ).toBeTruthy();
  });

  it("says what Apply does in the send-for-me mode", () => {
    renderPanel({ applicationAutomationMode: "autonomous_submit" });

    expect(screen.getByTestId("apply-outcome").textContent).toContain(
      "and sends it. It stops and asks you only when the site needs you.",
    );
  });

  it("creates the resume first when there is none", () => {
    const props = renderPanel({
      selectedAsset: null,
      selectedItem: createItem(),
    });

    const create = screen.getByRole("button", { name: "Create the resume" });
    fireEvent.click(create);
    expect(props.onGenerateResume).toHaveBeenCalledWith("job_1");
    expect(screen.queryByTestId("apply-outcome")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit resume" })).toBeNull();
  });

  it("makes Apply the approval for a Tailored draft and offers Edit resume beside it", () => {
    const onApproveResumeAndApply = vi.fn();
    const props = renderPanel({
      onApproveResumeAndApply,
      selectedAsset: createReadyAsset({ storagePath: null }),
      selectedItem: createItem({
        assetStatus: "ready",
        resumeAssetId: "asset_1",
        resumeReview: { status: "needs_review" },
      }),
    });

    expect(screen.getByTestId("shortlisted-state-line").textContent).toBe(
      "The resume is ready. Apply approves it and starts the application.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApproveResumeAndApply).toHaveBeenCalledWith("job_1");

    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));
    expect(props.onEditResumeWorkspace).toHaveBeenCalledWith("job_1");
  });

  it("says when AI could not write the resume and retries in one press", () => {
    const props = renderPanel({
      onApproveResumeAndApply: vi.fn(),
      selectedAsset: createReadyAsset({
        storagePath: null,
        generationMethod: "deterministic",
        generationReason: "provider_failed",
      }),
      selectedItem: createItem({
        assetStatus: "ready",
        resumeAssetId: "asset_1",
        resumeReview: { status: "needs_review" },
      }),
    });

    expect(screen.getByTestId("shortlisted-state-line").textContent).toBe(
      "AI could not write this resume, so it keeps your saved wording. Try again, or apply it as it is.",
    );
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again with AI" }));
    expect(props.onGenerateResume).toHaveBeenCalledWith("job_1");
  });

  it("names the review step, not Apply, when an Aggressive built-in resume must be read", () => {
    renderPanel({
      selectedAsset: createReadyAsset({
        storagePath: null,
        generationMethod: "deterministic",
        generationReason: "provider_failed",
      }),
      selectedItem: createItem({
        assetStatus: "ready",
        resumeAssetId: "asset_1",
        resumeTailoringMode: "aggressive",
        resumeReview: { status: "needs_review" },
      }),
    });

    expect(screen.getByTestId("shortlisted-state-line").textContent).toBe(
      "AI could not write this resume, so it keeps your saved wording. Try again, or review it and use it as it is.",
    );
    expect(
      screen.getByRole("button", { name: "Review the resume" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("offers to write the resume for a job whose resume kept the original wording", () => {
    const onApproveResumeAndApply = vi.fn();
    const props = renderPanel({
      onApproveResumeAndApply,
      selectedAsset: createReadyAsset({
        storagePath: null,
        generationMethod: "deterministic",
        generationReason: "listing_text_missing",
      }),
      selectedItem: createItem({
        assetStatus: "ready",
        resumeAssetId: "asset_1",
        resumeTailoringMode: "aggressive",
        resumeReview: { status: "needs_review" },
        resumeWrittenWithoutListing: true,
      }),
    });

    // The job's own level stays chosen and choosable: writing uses it.
    const aggressive = screen.getByRole("radio", { name: /Aggressive/ });
    expect(aggressive.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("Not possible for this job")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create the resume" }));
    expect(props.onGenerateResume).toHaveBeenCalledWith("job_1");
    fireEvent.click(
      screen.getByRole("button", { name: "Apply with your original wording" }),
    );
    expect(onApproveResumeAndApply).toHaveBeenCalledWith("job_1");
  });

  it("does not offer an AI retry once the built-in resume is approved", () => {
    renderPanel({
      selectedAsset: createReadyAsset({
        generationMethod: "deterministic",
        generationReason: "provider_failed",
      }),
    });

    expect(
      screen.queryByRole("button", { name: "Try again with AI" }),
    ).toBeNull();
  });

  it("sends an Aggressive draft to review instead of Apply", () => {
    const props = renderPanel({
      selectedAsset: createReadyAsset({ storagePath: null }),
      selectedItem: createItem({
        assetStatus: "ready",
        resumeAssetId: "asset_1",
        resumeTailoringMode: "aggressive",
        resumeReview: { status: "needs_review" },
      }),
    });

    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review the resume" }));
    expect(props.onEditResumeWorkspace).toHaveBeenCalledWith("job_1");
    // The primary already opens the resume, so it is not offered twice.
    expect(screen.queryByRole("button", { name: "Edit resume" })).toBeNull();
    expect(screen.getByTestId("shortlisted-state-line").textContent).toContain(
      "Read the resume through, then approve it.",
    );
    // ADR 0051: no line-by-line chore for Aggressive stretches.
    expect(
      screen.getByTestId("shortlisted-state-line").textContent,
    ).not.toMatch(/flagged lines/);
  });

  it("shows a moving clock while the resume is written", () => {
    renderPanel({
      isJobPending: () => true,
      pendingElapsedSeconds: 42,
      selectedAsset: null,
      selectedItem: createItem(),
    });

    expect(
      screen.getByRole("button", { name: "Writing the resume…" }),
    ).toBeTruthy();
    expect(
      document.querySelector("[data-resume-draft-elapsed]")?.textContent,
    ).toBe("0:42");
    expect(
      screen.getByRole("progressbar", {
        name: "Resume preparation in progress",
      }),
    ).toBeTruthy();
  });

  it("switches the resume level for this job only", () => {
    const props = renderPanel({
      selectedAsset: null,
      selectedItem: createItem(),
    });

    fireEvent.click(screen.getByRole("radio", { name: /Aggressive/ }));
    expect(props.onSetJobResumeApplicationMode).toHaveBeenCalledWith(
      "job_1",
      "tailored_per_job",
      "aggressive",
    );
    fireEvent.click(screen.getByRole("radio", { name: /Original/ }));
    expect(props.onSetJobResumeApplicationMode).toHaveBeenCalledWith(
      "job_1",
      "original_resume",
    );
  });

  it("parks the level behind a disclosure once the resume is approved", () => {
    renderPanel();

    const disclosure = document.querySelector<HTMLDetailsElement>(
      "[data-resume-choice-disclosure]",
    );
    expect(disclosure).not.toBeNull();
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.querySelector("summary")?.textContent).toContain(
      "Tailored · change level",
    );
  });

  it("links to an existing Needs you application instead of starting another", () => {
    const onOpenApplication = vi.fn();
    renderPanel({
      applicationRecords: [
        ApplicationRecordSchema.parse({
          id: "application_existing",
          jobId: "job_1",
          title: "Product Designer",
          company: "Example Co",
          status: "approved",
          lastAttemptState: "paused",
          lastActionLabel: "Sign-in needed",
          nextActionLabel: "Sign in, then continue",
          lastUpdatedAt: "2026-08-30T10:00:00.000Z",
        }),
      ],
      onOpenApplication,
    });

    fireEvent.click(screen.getByRole("button", { name: "Open application" }));
    expect(onOpenApplication).toHaveBeenCalledWith("application_existing");
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.queryByTestId("apply-outcome")).toBeNull();
  });

  it.each([
    "ready",
    "submitted",
    "failed",
    "not_started",
    "in_progress",
  ] as const)(
    "opens an existing %s application without preparing another form",
    (lastAttemptState) => {
      const onOpenApplication = vi.fn();
      const props = renderPanel({
        applicationRecords: [
          ApplicationRecordSchema.parse({
            id: "application_existing",
            jobId: "job_1",
            title: "Product Designer",
            company: "Example Co",
            status: lastAttemptState === "submitted" ? "submitted" : "approved",
            lastAttemptState,
            lastActionLabel: "Existing application",
            nextActionLabel: "Open application",
            lastUpdatedAt: "2026-09-22T10:00:00.000Z",
          }),
        ],
        safeguardBlocker: "Automatic runs are paused.",
        onOpenApplication,
      });

      fireEvent.click(screen.getByRole("button", { name: "Open application" }));
      expect(onOpenApplication).toHaveBeenCalledWith("application_existing");
      expect(props.onStartApplyCopilot).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Open Safeguards" }),
      ).toBeNull();
      expect(screen.queryByTestId("apply-outcome")).toBeNull();
    },
  );

  it("opens the newest record for this job in one press even when an older one needs help", () => {
    const record = (id: string, jobId: string, lastUpdatedAt: string) =>
      ApplicationRecordSchema.parse({
        id,
        jobId,
        title: "Product Designer",
        company: "Example Co",
        status: "approved",
        lastAttemptState: id === "older" ? "paused" : "ready",
        lastActionLabel: "Existing application",
        nextActionLabel: "Open application",
        lastUpdatedAt,
      });
    const onOpenApplication = vi.fn();
    const props = renderPanel({
      applicationRecords: [
        record("older", "job_1", "2026-09-21T10:00:00.000Z"),
        record("unrelated", "job_2", "2026-09-23T10:00:00.000Z"),
        record("newest", "job_1", "2026-09-22T10:00:00.000Z"),
      ],
      onOpenApplication,
    });

    fireEvent.click(screen.getByRole("button", { name: "Open application" }));
    expect(onOpenApplication).toHaveBeenCalledWith("newest");
    expect(props.onStartApplyCopilot).not.toHaveBeenCalled();
    expect(screen.queryByText(/Continue one, or start new/)).toBeNull();
  });

  it("replaces Apply with Open Safeguards while a safeguard holds", () => {
    const onOpenSafeguards = vi.fn();
    renderPanel({
      onOpenSafeguards,
      safeguardBlocker:
        "Automatic runs are paused (abnormal_failure_pause: automatic_discovery_failures:campaign_default).",
    });

    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Safeguards" }));
    expect(onOpenSafeguards).toHaveBeenCalledOnce();
    expect(screen.getByTestId("shortlisted-state-line").textContent).toBe(
      "Automatic runs are paused.",
    );
  });

  it("keeps the button saying the form is being filled while the run record runs", () => {
    renderPanel({
      applyJobResults: [
        {
          jobId: "job_1",
          state: "filling",
          startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
        } as never,
      ],
    });

    const button = screen.getByRole("button", { name: /Filling in the form/ });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("uses the original resume unchanged and says so once", () => {
    renderPanel({
      originalResume: {
        id: "resume_base",
        fileName: "base-resume.md",
        uploadedAt: "2026-08-20T00:00:00.000Z",
      } as never,
      selectedAsset: null,
      selectedItem: createItem({
        assetStatus: "ready",
        resumeAssetId: "resume_base",
        resumeApplicationMode: "original_resume",
        resumeReview: {
          status: "original_resume",
          sourceDocumentId: "resume_base",
          fileName: "base-resume.md",
          filePath: "/tmp/base-resume.md",
        },
      }),
    });

    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
    expect(screen.getByTestId("apply-outcome").textContent).toContain(
      "attaches your original resume",
    );
    expect(
      screen.getByText(/base-resume\.md goes out with its content unchanged/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Forms that accept plain text receive an unchanged \.txt copy/,
      ),
    ).toBeTruthy();
    // Its studio is one press away: that is where the original becomes an
    // editable resume.
    expect(screen.getByRole("button", { name: "Edit resume" })).toBeTruthy();
  });
});

it("explains that changing a written level starts a draft before the click", () => {
  renderPanel();
  // The chosen level's description, then what another level costs.
  expect(
    screen.getByText(/Choosing another level writes a new draft\./),
  ).toBeTruthy();
  expect(
    screen.getByRole("radio", { name: /Light/ }).getAttribute("title"),
  ).toContain("Writes a new draft.");
});

it("lets a person remove a job during writing and explains remaining AI work", () => {
  const props = renderPanel({ isJobPending: () => true });
  fireEvent.click(
    screen.getByRole("button", { name: "Move back to Find jobs" }),
  );
  expect(props.onRemoveReviewJob).toHaveBeenCalledWith("job_1");
  expect(screen.getByText(/Removing this job stops the draft/)).toBeTruthy();
});

it("never describes an Original listing assessment as resume writing", () => {
  renderPanel({
    selectedItem: createItem({
      resumeApplicationMode: "original_resume",
      assetStatus: "ready",
      resumeAssetId: "original",
      resumeReview: {
        status: "original_resume",
        fileName: "synthetic.pdf",
        filePath: "/tmp/synthetic.pdf",
        sourceDocumentId: "synthetic",
      },
    }),
    isJobPending: () => true,
  });
  expect(screen.queryByText(/Writing resume/i)).toBeNull();
  expect(screen.queryByText(/Writing and checking/i)).toBeNull();
});
