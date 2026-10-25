// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApplicationRecordSchema,
  MatchAssessmentChangeAuditSchema,
  MatchAssessmentSchema,
  type ListingActivity,
  type SavedJob,
} from "@nestor/contracts";
import {
  DISCOVERY_DETAIL_HEADING_ID,
  DISCOVERY_DETAIL_REGION_ID,
} from "./discovery-accessibility";
import { JOB_FINDER_REVEAL_SCROLL_MARGIN_CLASSES } from "../../lib/job-finder-scroll-reveal";
import {
  SHELL_HEADER_MASK_HEIGHT_CLASS,
  SHELL_HEADER_MASK_HEIGHT_PX,
  SHELL_HEADER_MASK_OPAQUE_STOP_CLASS,
  SHELL_HEADER_MASK_OPAQUE_STOP_FRACTION,
  getMaskOpaqueBandPx,
  getMinimumMaskHeightPxForGutter,
} from "../../lib/job-finder-shell-gutters";

import {
  DISCOVERY_DETAIL_SCROLL_EDGE_HEIGHT_PX,
  DISCOVERY_DETAIL_SCROLL_GUTTER_PX,
  DiscoveryDetailPanel,
  listFlaggedKeywordTerms,
  MatchAssessmentChangeDisclosure,
  SourceDiagnostics,
} from "./discovery-detail-panel";

/**
 * Reads a Tailwind spacing utility straight off a rendered element, so the
 * relationship below is pinned against what the component actually paints
 * rather than against a number restated in the test. Tailwind's spacing scale
 * is 4px per step.
 */
function readSpacingPx(className: string, prefix: string): number {
  const match = new RegExp(`(?:^| )${prefix}-(\\d+)(?: |$)`).exec(className);
  if (!match) {
    throw new Error(`Expected a ${prefix}-* utility in "${className}".`);
  }
  return Number(match[1]) * 4;
}

const baseSelectedJob = {
  id: "job_base",
  title: "Base role",
  company: "Example Co",
  location: "Remote",
  status: "discovered",
  canonicalUrl: "https://example.test/jobs/base",
  matchAssessment: { score: 82, reasons: [], gaps: [] },
  workMode: ["remote"],
  sourceIntelligence: null,
  normalizedCompensation: null,
  description: "Build accessible interfaces.",
  descriptionFormat: "text",
  keySkills: [],
  keywordSignals: [],
  provenance: [],
  screeningHints: {
    relocationText: null,
    remoteGeographies: [],
    requiresSecurityClearance: null,
    sponsorshipText: null,
    travelText: null,
  },
  sourceTargetId: null,
} as unknown as SavedJob;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("DiscoveryDetailPanel listing capture copy", () => {
  afterEach(cleanup);

  it("copies the canonical listing URL through the desktop bridge", async () => {
    const writeClipboardText = vi.fn().mockResolvedValue({ written: true });
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: { jobFinder: { writeClipboardText } },
    });

    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          applicationRecords={[]}
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onOpenApplication={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={baseSelectedJob}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));

    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith(
        baseSelectedJob.canonicalUrl,
      );
      expect(screen.getByRole("button", { name: "Link copied" })).toBeTruthy();
    });
  });

  it("explains a refused detail read as a not judged yet", () => {
    const blockedJob = {
      ...baseSelectedJob,
      description: "Headway Featured Full-Time United States of America",
      listingDetailCapture: { state: "blocked" },
      listingDetailFetch: {
        attemptedAt: "2026-09-12T10:00:00.000Z",
        outcome: "blocked",
        method: null,
        detail: "The page answered 403.",
      },
    } as unknown as SavedJob;

    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          applicationRecords={[]}
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onOpenApplication={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={blockedJob}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByText("This site did not let Job Finder read the listing"),
    ).toBeTruthy();
    expect(
      screen.queryByText("Headway Featured Full-Time United States of America"),
    ).toBeNull();
  });

  it("explains thin listing content without calling it an access refusal", () => {
    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          applicationRecords={[]}
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onOpenApplication={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={
            {
              ...baseSelectedJob,
              description: "A short listing card",
              listingDetailCapture: { state: "blocked", textHash: null },
              listingDetailFetch: {
                attemptedAt: "2026-09-12T10:00:00.000Z",
                outcome: "no_detail",
                method: null,
                detail: "The page published too little readable text.",
              },
            } as SavedJob
          }
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByTestId("discovery-detail-listing-text").textContent,
    ).toContain("too little readable job detail");
    expect(
      screen.getByTestId("discovery-detail-listing-text").textContent,
    ).not.toContain("did not let");
  });
});

describe("DiscoveryDetailPanel application handoff", () => {
  it("opens an existing Needs you application instead of offering to shortlist again", () => {
    const onOpenApplication = vi.fn();
    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          applicationRecords={[
            ApplicationRecordSchema.parse({
              id: "application_base",
              jobId: baseSelectedJob.id,
              title: baseSelectedJob.title,
              company: baseSelectedJob.company,
              status: "approved",
              lastAttemptState: "paused",
              lastActionLabel: "Sign-in needed",
              nextActionLabel: "Sign in, then continue",
              lastUpdatedAt: "2026-08-30T10:00:00.000Z",
            }),
          ]}
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onOpenApplication={onOpenApplication}
          onQueueJob={vi.fn()}
          selectedJob={baseSelectedJob}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Needs you · Open application" }),
    );
    expect(onOpenApplication).toHaveBeenCalledWith("application_base");
    expect(screen.queryByRole("button", { name: /shortlist job/i })).toBeNull();
  });
});

function createSelectedJob(
  overrides: Partial<SavedJob> &
    Pick<SavedJob, "id"> & { listingActivity?: ListingActivity },
): SavedJob {
  return { ...baseSelectedJob, ...overrides };
}

describe("MatchAssessmentChangeDisclosure", () => {
  afterEach(cleanup);

  it("keeps a concise rank explanation behind a closed disclosure", () => {
    const audit = MatchAssessmentChangeAuditSchema.parse({
      recordedAt: "2026-08-09T10:05:00.000Z",
      status: "assessment_changed_with_unknown_cause",
      causeConfidence: "unknown",
      rankingSignalChanged: true,
      summary: "The exact cause is unknown.",
      reasons: [],
      previousMetadata: {
        scorerVersion: 4,
        contextFingerprint: "match_context_v4_candidate",
        postingFingerprint: "match_posting_v4_listing",
      },
      currentMetadata: {
        scorerVersion: 4,
        contextFingerprint: "match_context_v4_candidate",
        postingFingerprint: "match_posting_v4_listing",
      },
      inputChanges: [],
      previousRank: 5,
      currentRank: 2,
      outputChanges: [
        {
          code: "rank_position_changed",
          subject: "rank_position",
          title: "Queue rank changed",
          detail:
            "The queue rank changed from #5 to #2 because other jobs changed around it.",
          previousValue: "5",
          currentValue: "2",
        },
      ],
    });
    const { getByText, getByTestId } = render(
      <MatchAssessmentChangeDisclosure audit={audit} />,
    );

    const disclosure = getByTestId(
      "match-assessment-change-audit",
    ) as HTMLDetailsElement;
    expect(disclosure.open).toBe(false);
    expect(getByText(/Why this result changed/iu)).toBeTruthy();
    expect(getByText("#5 → #2")).toBeTruthy();
    expect(
      getByText(/other visible results entered, left, or changed/iu),
    ).toBeTruthy();
  });
});

describe("SourceDiagnostics", () => {
  afterEach(cleanup);

  it("keeps provider internals behind a closed diagnostics disclosure", () => {
    const { getByText } = render(
      <SourceDiagnostics
        summaries={[
          {
            title: "Provider intelligence",
            items: [{ label: "Board token", value: "internal-board-token" }],
          },
        ]}
      />,
    );

    const disclosure = getByText("Source diagnostics").closest("details");

    expect(disclosure).toBeTruthy();
    expect((disclosure as HTMLDetailsElement).open).toBe(false);
    expect(
      getByText(
        "Technical collection details for troubleshooting this saved source.",
      ),
    ).toBeTruthy();
  });
});

describe("DiscoveryDetailPanel", () => {
  afterEach(cleanup);

  it("contains the recommendation badge inside the narrow detail pane at the supported 1024px width", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    window.dispatchEvent(new Event("resize"));

    const selectedJob = {
      id: "job_narrow_actions",
      title: "Senior Frontend Engineer",
      company: "Example Co",
      location: "Remote",
      status: "discovered",
      canonicalUrl: "https://example.test/jobs/frontend",
      matchAssessment: {
        score: 82,
        reasons: ["Duplicate role reason"],
        gaps: ["Duplicate role gap"],
      },
      workMode: ["remote"],
      sourceIntelligence: null,
      normalizedCompensation: null,
      description: "Build accessible interfaces.",
      descriptionFormat: "text",
      keySkills: [],
      keywordSignals: [],
      provenance: [],
      screeningHints: {
        relocationText: null,
        remoteGeographies: [],
        requiresSecurityClearance: null,
        sponsorshipText: null,
        travelText: null,
      },
      sourceTargetId: null,
    } as unknown as SavedJob;

    const onDismissJob = vi.fn();
    const onQueueJob = vi.fn();
    const { getAllByRole, getByLabelText, getByRole, getByTestId, getByText } =
      render(
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={onDismissJob}
          onQueueJob={onQueueJob}
          selectedJob={selectedJob}
        />,
      );

    const actionRegion = getByTestId("discovery-detail-actions");
    const primaryActionRegion = getByTestId("discovery-detail-primary-action");
    const detailScrollArea = getByTestId("discovery-detail-scroll-area");

    // The breakdown is behind "How this was scored" now, so it is opened
    // explicitly before it can be located.
    const scoringDisclosure = getByText("How this was scored").closest(
      "details",
    ) as HTMLDetailsElement;
    scoringDisclosure.open = true;
    const fitBreakdown = getByRole("region", { name: "Score and evidence" });
    const detailRegion = getByRole("region", { name: "Job details" });
    const detailHeading = getByRole("heading", {
      name: "Senior Frontend Engineer",
    });

    expect(detailRegion.id).toBe(DISCOVERY_DETAIL_REGION_ID);
    expect(detailHeading.id).toBe(DISCOVERY_DETAIL_HEADING_ID);
    expect(detailHeading.getAttribute("tabindex")).toBe("-1");
    expect(detailHeading.className).toContain("focus-visible:ring");
    expect(detailRegion.contains(detailHeading)).toBe(true);
    // Both stacked reveal anchors carry the shared responsive scroll-margin
    // trio so native reveals clear the shell header at every breakpoint.
    for (const revealAnchor of [detailRegion, detailHeading]) {
      expect(revealAnchor.className).toContain(
        JOB_FINDER_REVEAL_SCROLL_MARGIN_CLASSES.base,
      );
      expect(revealAnchor.className).toContain(
        JOB_FINDER_REVEAL_SCROLL_MARGIN_CLASSES.fixedHeader,
      );
      expect(revealAnchor.className).toContain(
        JOB_FINDER_REVEAL_SCROLL_MARGIN_CLASSES.wideFixedHeader,
      );
    }
    expect(getByRole("group", { name: "Selected job summary" })).toBe(
      primaryActionRegion,
    );
    expect(primaryActionRegion.className).toContain("shrink-0");
    expect(detailScrollArea.className).toContain("overflow-y-auto");
    expect(detailScrollArea).toBe(
      getByRole("region", { name: "Job detail content" }),
    );
    expect(detailScrollArea.getAttribute("tabindex")).toBe("0");
    expect(
      detailScrollArea.getAttribute("data-locked-pane-scroll-region"),
    ).not.toBeNull();
    expect(
      primaryActionRegion.compareDocumentPosition(detailScrollArea) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(getAllByRole("button", { name: "Shortlist job" })).toHaveLength(1);
    const shortlistAction = getByRole("button", { name: "Shortlist job" });
    expect(primaryActionRegion.contains(shortlistAction)).toBe(true);
    expect(actionRegion.contains(shortlistAction)).toBe(false);
    expect(shortlistAction.getAttribute("aria-describedby")).toBe(
      DISCOVERY_DETAIL_HEADING_ID,
    );
    fireEvent.click(shortlistAction);
    expect(onQueueJob).toHaveBeenCalledTimes(1);
    expect(onQueueJob).toHaveBeenCalledWith(selectedJob.id);
    expect(detailScrollArea.contains(actionRegion)).toBe(false);
    expect(actionRegion.className).not.toContain("grid-cols-3");
    expect(actionRegion.className).not.toContain("absolute");
    expect(detailScrollArea.className).toContain("pb-6");
    expect(actionRegion.previousElementSibling?.contains(fitBreakdown)).toBe(
      true,
    );
    const whyItFits = getByTestId("discovery-detail-why-it-fits");

    expect(window.innerWidth).toBe(1024);
    const recommendationBadge = getByText("Review before applying");

    expect(whyItFits.contains(recommendationBadge)).toBe(true);
    expect(recommendationBadge.className).toContain("max-w-full");
    expect(recommendationBadge.className).toContain("inline-block");
    expect(recommendationBadge.className).toContain("w-auto");
    expect(recommendationBadge.className).toContain("min-w-0");
    expect(recommendationBadge.className).toContain("whitespace-normal");
    expect(recommendationBadge.className).toContain("break-words");
    expect(recommendationBadge.className).toContain("[overflow-wrap:anywhere]");
    expect(recommendationBadge.className).toContain("shrink");
    expect(recommendationBadge.className).not.toMatch(
      /(?:^|\s)whitespace-nowrap(?:\s|$)/u,
    );
    expect(recommendationBadge.className).not.toMatch(
      /(?:^|\s)shrink-0(?:\s|$)/u,
    );

    // The job comes first: listing text, pay and place sit above the score.
    const listingText = getByTestId("discovery-detail-listing-text");
    expect(
      listingText.compareDocumentPosition(whyItFits) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(getByText("Build accessible interfaces.")).toBeTruthy();
    expect(getByText("Salary")).toBeTruthy();
    expect(getByText("Location and work mode")).toBeTruthy();
    expect(getByLabelText("Overall fit: not assessed")).toBeTruthy();
    expect(getByText("Review before applying")).toBeTruthy();
    expect(getByText("Duplicate role reason.")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Not interested" }));
    expect(
      getByText(
        "Optional feedback stays local. It hides this result but never changes job facts or fit scoring.",
      ),
    ).toBeTruthy();
    // With the feedback choices open, the job text stays clipped to its
    // frame and the actions scroll within their share of the panel, so
    // "About this job" never paints over "Not interested because…".
    expect(getByTestId("discovery-detail-scroll-frame").className).toContain(
      "overflow-hidden",
    );
    expect(getByTestId("discovery-detail-actions").className).toContain(
      "overflow-y-auto",
    );
    expect(getByTestId("discovery-detail-actions").className).toContain(
      "max-h-[55%]",
    );
    const locationReason = getByRole("button", { name: "Location" });
    fireEvent.click(locationReason);
    expect(locationReason.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(getByRole("button", { name: "Hide this job only" }));
    expect(onDismissJob).toHaveBeenCalledWith(
      selectedJob.id,
      ["location"],
      "hide_job",
      null,
    );
    expect(getByRole("button", { name: "Copy link" })).toBeTruthy();
    expect(getByRole("status")).toBeTruthy();
  });

  it("reads the readiness Shortlisted computed instead of deriving its own", () => {
    // The stored job status still says the resume is waiting for review while
    // Shortlisted already approved it; one value has to win, and it is the
    // Shortlisted one.
    const selectedJob = createSelectedJob({
      id: "job_ready",
      status: "ready_for_review",
    });

    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onQueueJob={vi.fn()}
          reviewQueue={[
            {
              jobId: "job_ready",
              title: "Office Administrative Assistant",
              company: "Cardinal Field Services",
              location: "Remote",
              matchScore: 80,
              applicationStatus: "ready_for_review",
              assetStatus: "ready",
              progressPercent: null,
              resumeAssetId: "asset_ready",
              resumeApplicationMode: "tailored_per_job",
              resumeReview: {
                status: "approved",
                approvedAt: "2026-08-20T00:00:00.000Z",
                approvedExportId: "export_ready",
                approvedFormat: "pdf",
                approvedFilePath: "C:/exports/ready.pdf",
              },
              updatedAt: "2026-08-20T00:00:00.000Z",
            },
          ]}
          selectedJob={selectedJob}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByText("Resume needs review")).toBeNull();
    expect(screen.getByText("Ready to apply")).toBeTruthy();
  });

  it("confirms the exact job identity after a shortlist outcome", () => {
    const selectedJob = createSelectedJob({
      id: "job_office",
      title: "Office Administrative Assistant",
      company: "Cardinal Field Services",
    });

    render(
      <DiscoveryDetailPanel
        discoveryTargets={[]}
        isJobPending={() => false}
        onDismissJob={vi.fn()}
        onQueueJob={vi.fn()}
        queueFeedback={{
          message: "Job added to Shortlisted.",
          status: "success",
        }}
        selectedJob={selectedJob}
      />,
    );

    expect(
      screen.getByTestId("discovery-detail-queue-feedback").textContent,
    ).toBe("Job added to Shortlisted.");
    expect(
      screen.getByTestId("discovery-detail-queue-identity").textContent,
    ).toBe(
      "Selected for Shortlisted: Office Administrative Assistant at Cardinal Field Services.",
    );
  });

  it("offers exact employer exclusion after Company feedback without disabling job-only", async () => {
    const onDismissJob = vi.fn();
    const onPreviewEmployerExclusion = vi.fn(() =>
      Promise.resolve({
        status: "available" as const,
        jobId: "job_employer",
        displayCompanyName: "Example Co",
        normalizedCompanyName: "example co",
        employerDomain: "example.test",
      }),
    );
    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={onDismissJob}
          onPreviewEmployerExclusion={onPreviewEmployerExclusion}
          onQueueJob={vi.fn()}
          selectedJob={createSelectedJob({
            id: "job_employer",
            employerDomain: "example.test",
          })}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Not interested" }));
    fireEvent.click(screen.getByRole("button", { name: "Company" }));
    expect(onPreviewEmployerExclusion).toHaveBeenCalledWith("job_employer");
    const reusable = await screen.findByRole("radio", {
      name: "Hide and exclude employer",
    });
    expect(reusable.hasAttribute("disabled")).toBe(false);
    expect(
      screen.getByText(/exact normalized company name “example co”/iu),
    ).toBeTruthy();
    expect(
      screen.getByText(/Domain evidence only: example.test/iu),
    ).toBeTruthy();
    fireEvent.click(reusable);
    fireEvent.click(
      screen.getByRole("button", { name: "Hide and exclude employer" }),
    );
    expect(onDismissJob).toHaveBeenCalledWith(
      "job_employer",
      ["company"],
      "hide_and_exclude_employer",
      "example co",
    );
  });

  it("keeps job-only usable when reusable employer exclusion is unavailable", async () => {
    const onDismissJob = vi.fn();
    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={onDismissJob}
          onPreviewEmployerExclusion={() =>
            Promise.resolve({
              status: "unavailable",
              jobId: "job_unsafe_employer",
              reason: "provider_domain_only",
              employerDomain: "provider.test",
            })
          }
          onQueueJob={vi.fn()}
          selectedJob={createSelectedJob({ id: "job_unsafe_employer" })}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Not interested" }));
    fireEvent.click(screen.getByRole("button", { name: "Company" }));

    expect(
      await screen.findByText(/You can still hide only this job/iu),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("radio", { name: "Hide and exclude employer" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Hide this job only" }));
    expect(onDismissJob).toHaveBeenCalledWith(
      "job_unsafe_employer",
      ["company"],
      "hide_job",
      null,
    );
  });

  it("ignores an out-of-order employer preview after the selected job changes", async () => {
    const firstPreview = deferred<{
      status: "available";
      jobId: string;
      displayCompanyName: string;
      normalizedCompanyName: string;
      employerDomain: string | null;
    }>();
    const secondPreview = deferred<{
      status: "available";
      jobId: string;
      displayCompanyName: string;
      normalizedCompanyName: string;
      employerDomain: string | null;
    }>();
    const onPreviewEmployerExclusion = vi.fn((jobId: string) =>
      jobId === "job_first_preview"
        ? firstPreview.promise
        : secondPreview.promise,
    );
    const onDismissJob = vi.fn();
    const renderPanel = (selectedJob: SavedJob) => (
      <DiscoveryDetailPanel
        discoveryTargets={[]}
        isJobPending={() => false}
        onDismissJob={onDismissJob}
        onPreviewEmployerExclusion={onPreviewEmployerExclusion}
        onQueueJob={vi.fn()}
        selectedJob={selectedJob}
      />
    );
    const { rerender } = render(
      renderPanel(createSelectedJob({ id: "job_first_preview" })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Not interested" }));
    fireEvent.click(screen.getByRole("button", { name: "Company" }));

    rerender(renderPanel(createSelectedJob({ id: "job_second_preview" })));
    fireEvent.click(screen.getByRole("button", { name: "Not interested" }));
    fireEvent.click(screen.getByRole("button", { name: "Company" }));

    await act(async () => {
      secondPreview.resolve({
        status: "available",
        jobId: "job_second_preview",
        displayCompanyName: "Second Co",
        normalizedCompanyName: "second co",
        employerDomain: null,
      });
      await secondPreview.promise;
    });
    expect(
      screen.getByText(/exact normalized company name “second co”/iu),
    ).toBeTruthy();

    await act(async () => {
      firstPreview.resolve({
        status: "available",
        jobId: "job_first_preview",
        displayCompanyName: "First Co",
        normalizedCompanyName: "first co",
        employerDomain: null,
      });
      await firstPreview.promise;
    });
    expect(screen.queryByText(/first co/iu)).toBeNull();
    expect(
      screen
        .getByRole("radio", { name: "Hide and exclude employer" })
        .hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("radio", { name: "Hide and exclude employer" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Hide and exclude employer" }),
    );
    expect(onDismissJob).toHaveBeenCalledWith(
      "job_second_preview",
      ["company"],
      "hide_and_exclude_employer",
      "second co",
    );
  });

  it("invalidates a pending employer preview when feedback closes or the panel unmounts", async () => {
    type AvailablePreview = {
      status: "available";
      jobId: string;
      displayCompanyName: string;
      normalizedCompanyName: string;
      employerDomain: string | null;
    };
    const closedPreview = deferred<AvailablePreview>();
    const unmountedPreview = deferred<AvailablePreview>();
    const onPreviewEmployerExclusion = vi
      .fn()
      .mockReturnValueOnce(closedPreview.promise)
      .mockReturnValueOnce(unmountedPreview.promise);
    const { unmount } = render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onPreviewEmployerExclusion={onPreviewEmployerExclusion}
          onQueueJob={vi.fn()}
          selectedJob={createSelectedJob({ id: "job_closed_preview" })}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Not interested" }));
    fireEvent.click(screen.getByRole("button", { name: "Company" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Not interested" }));

    await act(async () => {
      closedPreview.resolve({
        status: "available",
        jobId: "job_closed_preview",
        displayCompanyName: "Closed Co",
        normalizedCompanyName: "closed co",
        employerDomain: null,
      });
      await closedPreview.promise;
    });
    expect(screen.queryByText(/closed co/iu)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Company" }));
    unmount();
    await act(async () => {
      unmountedPreview.resolve({
        status: "available",
        jobId: "job_closed_preview",
        displayCompanyName: "Unmounted Co",
        normalizedCompanyName: "unmounted co",
        employerDomain: null,
      });
      await unmountedPreview.promise;
    });
  });

  it("retains feedback and exact preview when dismissal fails", async () => {
    const onDismissJob = vi.fn(() => Promise.reject(new Error("failed")));
    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={onDismissJob}
          onPreviewEmployerExclusion={() =>
            Promise.resolve({
              status: "available",
              jobId: "job_failed_dismiss",
              displayCompanyName: "Example Co",
              normalizedCompanyName: "example co",
              employerDomain: null,
            })
          }
          onQueueJob={vi.fn()}
          selectedJob={createSelectedJob({ id: "job_failed_dismiss" })}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Not interested" }));
    fireEvent.click(screen.getByRole("button", { name: "Company" }));
    const exclusionRadio = await screen.findByRole("radio", {
      name: "Hide and exclude employer",
    });
    await waitFor(() =>
      expect(exclusionRadio.hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(exclusionRadio);
    fireEvent.click(
      screen.getByRole("button", { name: "Hide and exclude employer" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Your choices were kept. Try again.",
    );
    expect(
      screen
        .getByRole("button", { name: "Company" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByText(/exact normalized company name “example co”/iu),
    ).toBeTruthy();
    expect((exclusionRadio as HTMLInputElement).checked).toBe(true);
  });

  it("blocks duplicate pending dismissals and closes feedback only after success", async () => {
    const dismissal = deferred<void>();
    const onDismissJob = vi.fn(() => dismissal.promise);
    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={onDismissJob}
          onQueueJob={vi.fn()}
          selectedJob={createSelectedJob({ id: "job_pending_dismiss" })}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Not interested" }));
    fireEvent.click(screen.getByRole("button", { name: "Location" }));
    const submit = screen.getByRole("button", { name: "Hide this job only" });
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(onDismissJob).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Hiding job…" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
    ).toBe(true);

    await act(async () => {
      dismissal.resolve();
      await dismissal.promise;
    });
    expect(screen.getByRole("button", { name: "Not interested" })).toBeTruthy();
    expect(onDismissJob).toHaveBeenCalledTimes(1);
  });

  it("keeps the scroller clear of the shortlist block and the not-interested footer", () => {
    // The live walkthrough showed a half-height fact card butted straight
    // against the Shortlist block, and "How this was scored" cut off flush at
    // the Not interested footer, so the clipped rows read as a collision.
    const selectedJob = createSelectedJob({ id: "job_scroll_boundaries" });
    const { getByTestId } = render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={selectedJob}
        />
      </MemoryRouter>,
    );

    const scrollArea = getByTestId("discovery-detail-scroll-area");
    const primaryAction = getByTestId("discovery-detail-primary-action");
    const actions = getByTestId("discovery-detail-actions");

    // Both bars are siblings of the scroller, never its ancestors, so no
    // detail row can ever render underneath either of them.
    expect(scrollArea.contains(primaryAction)).toBe(false);
    expect(scrollArea.contains(actions)).toBe(false);
    expect(primaryAction.contains(scrollArea)).toBe(false);
    expect(actions.contains(scrollArea)).toBe(false);
    expect(primaryAction.className).toContain("shrink-0");
    expect(actions.className).toContain("shrink-0");

    // Top and bottom padding keep the first and last rows off both edges, and
    // the matching scroll padding keeps programmatic reveals off them too.
    for (const token of [
      "pt-6",
      "pb-6",
      "scroll-pt-6",
      "scroll-pb-6",
      "overflow-y-auto",
      "min-h-0",
    ]) {
      expect(scrollArea.className).toContain(token);
    }
    expect(scrollArea.className).not.toContain("pt-5");
    expect(scrollArea.className).not.toContain("pb-5");

    // Each clipped edge gets one decorative, non-interactive boundary that is
    // hidden while nothing is clipped on that side.
    const topEdge = getByTestId("discovery-detail-scroll-edge-top");
    const bottomEdge = getByTestId("discovery-detail-scroll-edge-bottom");
    for (const edge of [topEdge, bottomEdge]) {
      expect(edge.getAttribute("aria-hidden")).toBe("true");
      expect(edge.className).toContain("pointer-events-none");
      expect(edge.className).toContain("absolute");
      expect(scrollArea.contains(edge)).toBe(false);
    }
    // Each treatment must be opaque across the WHOLE gutter before it fades.
    // Without the opaque stop the gradient started fading at its very first
    // pixel, so a row part-way into the band rendered semi-transparent and
    // read as a glyph sliced through the middle ("MODE" halved, "Not stated"
    // orphaned from its label).
    for (const edge of [topEdge, bottomEdge]) {
      expect(edge.className).toContain(SHELL_HEADER_MASK_OPAQUE_STOP_CLASS);
      expect(edge.className).toContain("to-transparent");
    }
    expect(topEdge.className).toContain("bg-gradient-to-b");
    expect(bottomEdge.className).toContain("bg-gradient-to-t");
    // The opaque stop is the shell's, not a second local copy: the two chrome
    // defects this fixes both came from independently derived numbers.
    expect(SHELL_HEADER_MASK_OPAQUE_STOP_CLASS).toBe(
      `from-${Math.round(SHELL_HEADER_MASK_OPAQUE_STOP_FRACTION * 100)}%`,
    );

    // The invariant, read off what is actually painted rather than off
    // numbers restated here: raising the scroller's own edge padding without
    // raising the mask height must fail, because it would push content past
    // the opaque band and bring the mid-glyph slice straight back. Asserting
    // "h-10" alone would keep passing while silently becoming wrong.
    const gutterPx = readSpacingPx(scrollArea.className, "pt");
    expect(readSpacingPx(scrollArea.className, "pb")).toBe(gutterPx);
    expect(gutterPx).toBe(DISCOVERY_DETAIL_SCROLL_GUTTER_PX);

    for (const edge of [topEdge, bottomEdge]) {
      const maskHeightPx = readSpacingPx(edge.className, "h");
      expect(maskHeightPx).toBe(DISCOVERY_DETAIL_SCROLL_EDGE_HEIGHT_PX);
      expect(getMaskOpaqueBandPx(maskHeightPx)).toBeGreaterThanOrEqual(
        gutterPx,
      );
      // And no taller than it needs to be: the fade tail beyond the gutter is
      // a cost on pixels, so the height is the minimum that satisfies the
      // invariant rather than a round number someone liked.
      expect(maskHeightPx).toBe(getMinimumMaskHeightPxForGutter(gutterPx));
    }

    // jsdom reports zero scroll geometry, so nothing is clipped and no edge
    // treatment is shown.
    expect(topEdge.hasAttribute("hidden")).toBe(true);
    expect(bottomEdge.hasAttribute("hidden")).toBe(true);
  });

  it("masks the content passing under the pinned summary row below the two-pane breakpoint", () => {
    const selectedJob = createSelectedJob({ id: "job_pinned_summary_mask" });
    const { getByTestId } = render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={selectedJob}
        />
      </MemoryRouter>,
    );

    const pinnedSummary = getByTestId("discovery-detail-primary-action");
    const mask = getByTestId("discovery-detail-pinned-summary-mask");

    // Below xl the summary row is pinned and the whole detail body scrolls
    // under it, so its bottom border cut rows through the middle of a glyph
    // ("How this was scored" sliced in half). The mask ends the page there.
    expect(pinnedSummary.className).toContain("sticky");
    expect(pinnedSummary.contains(mask)).toBe(true);
    expect(mask.getAttribute("aria-hidden")).toBe("true");
    expect(mask.className).toContain("pointer-events-none");
    // Painted immediately below the chrome it belongs to.
    expect(mask.className).toContain("top-full");
    expect(mask.className).toContain("bg-gradient-to-b");
    expect(mask.className).toContain("from-(--surface-panel)");
    expect(mask.className).toContain("to-transparent");
    // Height and opaque stop come from the shell's shared values. A local copy
    // of either number is the defect class this is guarding against.
    expect(mask.className).toContain(SHELL_HEADER_MASK_HEIGHT_CLASS);
    expect(mask.className).toContain(SHELL_HEADER_MASK_OPAQUE_STOP_CLASS);
    expect(SHELL_HEADER_MASK_HEIGHT_CLASS).toBe(
      `h-${SHELL_HEADER_MASK_HEIGHT_PX / 4}`,
    );
    // From xl up the row is static above the pane's own scroller, so nothing
    // passes under it and the mask must not paint over live content.
    expect(pinnedSummary.className).toContain("xl:static");
    expect(mask.className).toContain("xl:hidden");
  });

  it("shows the top boundary once the scroller has moved away from its first row", () => {
    const selectedJob = createSelectedJob({ id: "job_scroll_edge_state" });
    const { getByTestId } = render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={selectedJob}
        />
      </MemoryRouter>,
    );

    const scrollArea = getByTestId("discovery-detail-scroll-area");
    Object.defineProperty(scrollArea, "scrollHeight", {
      configurable: true,
      value: 900,
    });
    Object.defineProperty(scrollArea, "clientHeight", {
      configurable: true,
      value: 400,
    });
    scrollArea.scrollTop = 120;
    act(() => {
      fireEvent.scroll(scrollArea);
    });

    expect(
      getByTestId("discovery-detail-scroll-edge-top").hasAttribute("hidden"),
    ).toBe(false);
    expect(
      getByTestId("discovery-detail-scroll-edge-bottom").hasAttribute("hidden"),
    ).toBe(false);

    scrollArea.scrollTop = 500;
    act(() => {
      fireEvent.scroll(scrollArea);
    });

    expect(
      getByTestId("discovery-detail-scroll-edge-top").hasAttribute("hidden"),
    ).toBe(false);
    expect(
      getByTestId("discovery-detail-scroll-edge-bottom").hasAttribute("hidden"),
    ).toBe(true);
  });

  it("returns the independent detail scroller to the top only when the selected job changes", () => {
    const firstJob = {
      id: "job_first",
      title: "First role",
      company: "Example Co",
      location: "Remote",
      status: "discovered",
      canonicalUrl: "https://example.test/jobs/first",
      matchAssessment: { score: 82, reasons: [], gaps: [] },
      workMode: ["remote"],
      sourceIntelligence: null,
      normalizedCompensation: null,
      description: "First description",
      descriptionFormat: "text",
      keySkills: [],
      keywordSignals: [],
      provenance: [],
      screeningHints: {
        relocationText: null,
        remoteGeographies: [],
        requiresSecurityClearance: null,
        sponsorshipText: null,
        travelText: null,
      },
      sourceTargetId: null,
    } as unknown as SavedJob;
    const renderPanel = (selectedJob: SavedJob) => (
      <DiscoveryDetailPanel
        discoveryTargets={[]}
        isJobPending={() => false}
        onDismissJob={vi.fn()}
        onQueueJob={vi.fn()}
        selectedJob={selectedJob}
      />
    );
    const { getByTestId, rerender } = render(renderPanel(firstJob));
    const scrollArea = getByTestId("discovery-detail-scroll-area");

    scrollArea.scrollTop = 2236;
    rerender(renderPanel({ ...firstJob, title: "First role refreshed" }));
    expect(scrollArea.scrollTop).toBe(2236);

    rerender(
      renderPanel({
        ...firstJob,
        id: "job_second",
        title: "Second role",
        canonicalUrl: "https://example.test/jobs/second",
      }),
    );
    expect(scrollArea.scrollTop).toBe(0);
  });

  it("offers a single forward continuation for an already-shortlisted job", () => {
    const selectedJob = createSelectedJob({
      id: "job_shortlisted",
      title: "Senior Frontend Engineer",
      status: "drafting",
    });
    const onQueueJob = vi.fn();

    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onQueueJob={onQueueJob}
          selectedJob={selectedJob}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("button", { name: "Shortlist job" })).toBeNull();
    expect(screen.queryByText("Already shortlisted")).toBeNull();
    expect(screen.getByText("No resume yet")).toBeTruthy();
    const openLink = screen.getByRole("link", { name: "Open in Shortlisted" });
    expect(
      screen.getByTestId("discovery-detail-primary-action").contains(openLink),
    ).toBe(true);
    expect(openLink.getAttribute("href")).toBe(
      "/job-finder/review-queue?jobId=job_shortlisted",
    );
    expect(openLink.getAttribute("aria-describedby")).toBe(
      DISCOVERY_DETAIL_HEADING_ID,
    );
    fireEvent.click(screen.getByRole("button", { name: "Not interested" }));
    expect(
      screen.getByText(
        "Optional feedback stays local. It hides this result but never changes job facts or fit scoring.",
      ),
    ).toBeTruthy();
  });

  it("renders an application route URL identical to the canonical listing only once", () => {
    const sharedUrl = "https://example.test/jobs/shared";

    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={createSelectedJob({
            id: "job_dedupe",
            title: "Dedupe role",
            applicationUrl: sharedUrl,
            canonicalUrl: sharedUrl,
          })}
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByText(sharedUrl)).toHaveLength(1);
    expect(screen.queryByText("Application route")).toBeNull();
    expect(screen.getByText("Original listing")).toBeTruthy();
  });

  it("keeps distinct application route and original listing URLs visible", () => {
    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={createSelectedJob({
            id: "job_split",
            title: "Split route role",
            applicationUrl: "https://apply.example.test/jobs/split",
            canonicalUrl: "https://example.test/jobs/split",
          })}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Application route")).toBeTruthy();
    expect(screen.getByText("Original listing")).toBeTruthy();
    expect(
      screen.getByText("https://apply.example.test/jobs/split"),
    ).toBeTruthy();
    expect(screen.getByText("https://example.test/jobs/split")).toBeTruthy();
  });

  it("shows active and unknown availability neutrally without blocking shortlist", () => {
    const { unmount } = render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={createSelectedJob({
            id: "job_active",
            listingActivity: {
              status: "active",
              observedAt: "2026-08-23T10:00:00.000Z",
              evidence: "last_seen_at",
            },
          })}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Last seen on source 23 Aug 2026.")).toBeTruthy();
    const listingActivityCard = screen.getByTestId(
      "discovery-detail-listing-activity",
    );
    const listingActivityLabel = screen.getByText("Listing status");
    const activeBadge = screen.getByText("Active");
    expect(listingActivityCard.contains(listingActivityLabel)).toBe(true);
    expect(listingActivityCard.contains(activeBadge)).toBe(true);
    expect(listingActivityLabel.parentElement).toBe(activeBadge.parentElement);
    expect(activeBadge.className).toContain("text-(length:--text-tiny)");
    expect(activeBadge.className).toContain("tracking-[0.04em]");
    expect(
      screen
        .getByRole("button", { name: "Shortlist job" })
        .hasAttribute("disabled"),
    ).toBe(false);
    unmount();

    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={createSelectedJob({
            id: "job_unknown",
            listingActivity: { status: "unknown" },
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Listing availability is unknown.")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Shortlist job" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it.each([
    {
      activity: {
        status: "inactive",
        observedAt: "2026-08-22T10:00:00.000Z",
        ledgerEntryId: "ledger_1",
        provenance: "discovery_ledger",
        explanation: "The complete refresh did not return this job.",
      } satisfies ListingActivity,
      wording:
        "Not found in latest full source refresh on 22 Aug 2026. This does not prove the listing is closed.",
    },
    {
      activity: {
        status: "stale",
        observedAt: "2026-08-21T10:00:00.000Z",
        signalId: "signal_stale",
        provenance: "browser",
        explanation: "The apply control was unavailable.",
        detail: "A long source warning remains fully readable.",
        confidence: 0.8,
      } satisfies ListingActivity,
      wording:
        "This listing may no longer be open — opening the page last saw it on 21 Aug 2026.",
    },
  ])(
    "requires source verification before shortlisting a $activity.status listing",
    ({ activity, wording }) => {
      const onQueueJob = vi.fn();
      render(
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onQueueJob={onQueueJob}
          selectedJob={createSelectedJob({
            id: `job_${activity.status}`,
            listingActivity: activity,
          })}
        />,
      );

      expect(
        screen.getByText((content) => content.includes(wording)),
      ).toBeTruthy();
      expect(
        screen.getByText(/Verify availability on the original source/iu),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Shortlist anyway" }));
      expect(onQueueJob).toHaveBeenCalledWith(`job_${activity.status}`);
    },
  );

  it("disables shortlist for a reported-closed listing while retaining its source link and provenance", () => {
    const canonicalUrl = "https://example.test/jobs/reported-closed";
    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={createSelectedJob({
            id: "job_closed",
            canonicalUrl,
            listingActivity: {
              status: "closed",
              observedAt: "2026-08-20T10:00:00.000Z",
              signalId: "signal_closed",
              provenance: "provider",
              explanation: "The provider reported that applications ended.",
              detail: null,
              confidence: 1,
            },
          })}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByText(
        /Reported closed by the job site's own listing feed on 20 Aug 2026/iu,
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Reported closed" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText(canonicalUrl)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
  });

  it("moves source chronology behind a closed source timeline disclosure", () => {
    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={createSelectedJob({
            id: "job_timeline",
            title: "Timeline role",
            firstSeenAt: "2026-08-01T00:00:00.000Z",
            lastVerifiedActiveAt: "2026-08-20T00:00:00.000Z",
          })}
        />
      </MemoryRouter>,
    );

    const disclosure = screen
      .getByText("Source timeline")
      .closest("details") as HTMLDetailsElement;
    expect(disclosure).toBeTruthy();
    expect(disclosure.open).toBe(false);
    expect(disclosure.textContent).toContain("First seen");
    expect(disclosure.textContent).toContain("Last seen");
    expect(disclosure.textContent).toContain("Last verified active");
    expect(disclosure.textContent).toContain("01 Aug 2026");
    expect(disclosure.textContent).toContain("20 Aug 2026");
  });

  it("omits the source timeline disclosure when chronology is unknown", () => {
    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={createSelectedJob({
            id: "job_no_timeline",
            title: "No timeline role",
          })}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByText("Source timeline")).toBeNull();
  });

  it("keeps removed and multiple source provenance informative without exposing query URLs", () => {
    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={createSelectedJob({
            id: "job_removed_sources",
            provenance: [
              {
                targetId: "removed_zeta",
                adapterKind: "auto",
                resolvedAdapterKind: "target_site",
                startingUrl: "https://www.zeta.example.test/jobs?q=private",
                discoveredAt: "2026-08-22T10:00:00.000Z",
                collectionMethod: "listing_route",
                providerKey: null,
                providerBoardToken: null,
                titleTriageOutcome: "pass",
              },
              {
                targetId: "removed_alpha",
                adapterKind: "auto",
                resolvedAdapterKind: null,
                startingUrl: "malformed source URL",
                discoveredAt: "2026-08-23T10:00:00.000Z",
                collectionMethod: "fallback_search",
                providerKey: null,
                providerBoardToken: null,
                titleTriageOutcome: "pass",
              },
            ],
          })}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("zeta.example.test")).toBeTruthy();
    expect(screen.getByText("Auto · Fallback search")).toBeTruthy();
    expect(screen.queryByText(/private/iu)).toBeNull();
    expect(screen.queryByText("Saved source")).toBeNull();
  });
});

describe("DiscoveryDetailPanel listing facts", () => {
  afterEach(cleanup);

  it("hides the date fact when neither a posted nor an updated date exists", () => {
    const { container } = render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={createSelectedJob({
            id: "job_no_dates",
            title: "Undated role",
          })}
        />
      </MemoryRouter>,
    );

    const factGrid = container.querySelector("[data-job-fact-grid]");
    expect(factGrid).not.toBeNull();
    expect(screen.queryByText("Updated")).toBeNull();
    expect(screen.queryByText("Posted")).toBeNull();
    // A bare "Updated — Unknown" date fact must not reappear; only the
    // listing-activity card may legitimately report unknown availability.
    expect(factGrid?.textContent).not.toContain("UpdatedUnknown");
    expect(
      container.querySelector("[data-job-detail-fact-grid]")?.textContent,
    ).toContain("Listing statusUnknown");
  });

  it("keeps a known listing date visible", () => {
    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={createSelectedJob({
            id: "job_posted",
            title: "Dated role",
            postedAtText: "01 Jun 2026",
          } as Partial<SavedJob> & Pick<SavedJob, "id">)}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Posted")).toBeTruthy();
    expect(screen.getByText("01 Jun 2026")).toBeTruthy();
  });

  it("presents the application method under the original listing instead of as a bare fact card", () => {
    const { container } = render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={createSelectedJob({
            id: "job_method",
            title: "Method role",
          })}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByText("Application method")).toBeNull();
    const method = screen.getByTestId("discovery-detail-application-method");
    expect(method.textContent).toBe("Application method: Manual application");

    // The listing URL and its method live behind "Source details" now; the
    // pane's open area keeps only what decides a shortlist.
    const listingCard = container.querySelector(
      '[data-testid="discovery-detail-source-details"]',
    );
    expect(listingCard?.textContent).toContain("Original listing");
    expect(listingCard?.contains(method)).toBe(true);
  });
});

describe("job inspector fit honesty", () => {
  it("withholds the percentage in the inspector headline for a title-only listing", () => {
    // The third surface that reads the shared rule. Locking the rendered
    // string here means Find jobs, Shortlisted and the inspector cannot drift
    // apart about the same job again.
    render(
      <DiscoveryDetailPanel
        discoveryTargets={[]}
        isJobPending={() => false}
        onDismissJob={vi.fn()}
        onQueueJob={vi.fn()}
        selectedJob={createSelectedJob({
          id: "job_inspector_title_only",
          location: "Location not stated",
          // The shape `createMatchAssessment` emits for a card-only listing:
          // the title matched, and a saved-preference location requirement
          // exists but was never decided.
          matchAssessment: MatchAssessmentSchema.parse({
            score: 54,
            contextFingerprint: "match_context_v4_candidate",
            postingFingerprint: "match_posting_v4_listing",
            compensationFit: { state: "unknown" },
            dimensions: {
              roleSuitability: {
                state: "adjacent",
                explanation:
                  "The title matches, but the listing text was not captured, so nothing beyond the title could be checked.",
              },
              preferenceAlignment: { state: "unknown" },
              evidenceConfidence: { level: "unavailable" },
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
          }),
        })}
      />,
    );

    expect(screen.getByTestId("discovery-detail-fit-score").textContent).toBe(
      "Not judged yet",
    );
    expect(screen.queryByText(/^54% fit$/)).toBeNull();
  });
});

describe("job inspector compact action reachability", () => {
  // Earlier suites in this file render without their own teardown, so the
  // shared document is cleared before each case here as well as after it.
  beforeEach(cleanup);
  afterEach(cleanup);

  function renderInspector() {
    return render(
      <DiscoveryDetailPanel
        discoveryTargets={[]}
        isJobPending={() => false}
        onDismissJob={vi.fn()}
        onQueueJob={vi.fn()}
        selectedJob={createSelectedJob({ id: "job_compact_actions" })}
      />,
    );
  }

  it("pins the primary job action to the top of the stacked inspector so it stays inside the pane's first viewport at 1024x768", () => {
    const { getByRole, getByTestId } = renderInspector();

    const detailRegion = getByRole("region", { name: "Job details" });
    const primaryActionRegion = getByTestId("discovery-detail-primary-action");

    // Below the two-pane breakpoint the inspector stacks under the whole
    // result list and grows to its natural height, so the job's own action
    // scrolled away as soon as the user read past the summary. The row is
    // pinned to the top of the route scroller instead.
    expect(primaryActionRegion.className).toContain("sticky");
    expect(primaryActionRegion.className).toContain("top-0");
    expect(primaryActionRegion.className).toContain("z-20");
    // A pinned row must paint over the detail text passing under it.
    expect(primaryActionRegion.className).toContain("bg-(--surface-panel)");
    // `position: sticky` resolves against the nearest scrolling ancestor. The
    // stacked pane must therefore not clip itself: a clip would make it its
    // own never-scrolling scroll container and the pinned row inert.
    expect(detailRegion.className).toContain("overflow-visible");
    expect(
      primaryActionRegion.contains(
        getByRole("button", { name: "Shortlist job" }),
      ),
    ).toBe(true);
  });

  it("returns the pane to its bounded two-pane geometry at xl so selection still moves no rect at 1440", () => {
    const { getByRole, getByTestId } = renderInspector();

    const detailRegion = getByRole("region", { name: "Job details" });
    const primaryActionRegion = getByTestId("discovery-detail-primary-action");

    // From the two-pane breakpoint up the row is static again above the
    // pane's own bounded scroller, exactly as before, and the pane clips that
    // scroller to its rounded corners. Nothing about the pin survives there.
    expect(primaryActionRegion.className).toContain("xl:static");
    expect(primaryActionRegion.className).toContain("shrink-0");
    expect(detailRegion.className).toContain("xl:overflow-hidden");
    expect(detailRegion.className).toContain("xl:h-full");
    expect(detailRegion.className).toContain("xl:min-h-0");
    // The stacked-only utilities must never be repeated with an `xl:` prefix,
    // which would reintroduce them above the breakpoint.
    for (const wideVariant of [
      /(?:^|\s)xl:sticky(?:\s|$)/u,
      /(?:^|\s)xl:top-0(?:\s|$)/u,
    ]) {
      expect(primaryActionRegion.className).not.toMatch(wideVariant);
    }
    expect(detailRegion.className).not.toMatch(
      /(?:^|\s)xl:overflow-visible(?:\s|$)/u,
    );
  });

  it("keeps exactly one naturally focusable primary action ahead of the detail scroller", () => {
    const { getAllByRole, getByRole, getByTestId } = renderInspector();

    // Reachability must never be bought by duplicating the control into a
    // second focusable copy, or by taking it out of the tab order.
    expect(getAllByRole("button", { name: "Shortlist job" })).toHaveLength(1);
    const shortlistAction = getByRole("button", { name: "Shortlist job" });
    expect(shortlistAction.hasAttribute("tabindex")).toBe(false);
    expect(shortlistAction.hasAttribute("disabled")).toBe(false);
    expect(
      getByTestId("discovery-detail-primary-action").compareDocumentPosition(
        getByTestId("discovery-detail-scroll-area"),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("calls a rate-limited read a request to slow down, never a sign-in wall", () => {
    const rateLimitedJob = {
      ...baseSelectedJob,
      description: "Headway Featured Full-Time United States of America",
      listingDetailCapture: { state: "blocked" },
      listingDetailFetch: {
        attemptedAt: "2026-09-12T10:00:00.000Z",
        outcome: "blocked",
        method: null,
        detail:
          "The site asked Job Finder to slow down (HTTP 429). The listing is read again on the next search.",
        retryAfterAt: "2026-09-12T10:00:02.000Z",
      },
    } as unknown as SavedJob;

    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          applicationRecords={[]}
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onOpenApplication={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={rateLimitedJob}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByText(
        "This site asked Job Finder to slow down, so the listing has not been read yet. It will be read on the next search.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("This site did not let Job Finder read the listing"),
    ).toBeNull();
  });
});

describe("listFlaggedKeywordTerms", () => {
  it("keeps short terms, drops listing sentences and skills already shown", () => {
    expect(
      listFlaggedKeywordTerms(
        [
          { id: "k1", label: "TypeScript", kind: "skill", weight: 5 },
          { id: "k2", label: "Kubernetes", kind: "tool", weight: 4 },
          {
            id: "k3",
            label: "Design and ship maintainable software with TypeScript.",
            kind: "responsibility",
            weight: 3,
          },
          {
            id: "k4",
            label: "Professional software development experience.",
            kind: "qualification",
            weight: 4,
          },
          { id: "k5", label: "kubernetes", kind: "skill", weight: 3 },
          { id: "k6", label: "Fintech", kind: "industry", weight: 2 },
        ],
        ["TypeScript", "SQL"],
      ),
    ).toEqual(["Kubernetes", "Fintech"]);
  });
});

describe("requested listing assessment", () => {
  afterEach(cleanup);
  it("exposes read and assess, reports failure, and returns to results", async () => {
    const onAssessJobListing = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "The listing could not be read from this page. Open the listing and try again.",
        ),
      );
    const onBackToResults = vi.fn();
    render(
      <MemoryRouter>
        <DiscoveryDetailPanel
          discoveryTargets={[]}
          isJobPending={() => false}
          onDismissJob={vi.fn()}
          onQueueJob={vi.fn()}
          selectedJob={baseSelectedJob}
          onAssessJobListing={onAssessJobListing}
          onBackToResults={onBackToResults}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Judge fit" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          "The listing could not be read from this page. Open the listing and try again.",
        ),
      ).toBeTruthy(),
    );
    expect(onAssessJobListing).toHaveBeenCalledWith(baseSelectedJob.id);
    fireEvent.click(screen.getByRole("button", { name: "Back to results" }));
    expect(onBackToResults).toHaveBeenCalledOnce();
  });
});

it("hides a listing without optional reasons and lets a removed shortlist job be added again", async () => {
  const onDismiss = vi.fn().mockResolvedValue(undefined);
  const onQueue = vi.fn();
  render(
    <MemoryRouter>
      <DiscoveryDetailPanel
        discoveryTargets={[]}
        isJobPending={() => false}
        onDismissJob={onDismiss}
        onQueueJob={onQueue}
        selectedJob={createSelectedJob({
          id: "returned_job",
          status: "shortlisted",
        })}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Shortlist job" }));
  expect(onQueue).toHaveBeenCalledWith("returned_job");
  expect(screen.queryByText("Open in Shortlisted")).toBeNull();
  expect(screen.queryByText("Shortlisted")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Not interested" }));
  fireEvent.click(screen.getByRole("button", { name: "Hide this job only" }));
  await waitFor(() =>
    expect(onDismiss).toHaveBeenCalledWith(
      "returned_job",
      [],
      "hide_job",
      null,
    ),
  );
});

it("keeps long German listing words inside the shrinking detail column", () => {
  cleanup();
  const text = "EntwicklungszusammenarbeitundQualitaetssicherungsverantwortung";
  render(
    <MemoryRouter>
      <DiscoveryDetailPanel
        applicationRecords={[]}
        discoveryTargets={[]}
        isJobPending={() => false}
        onDismissJob={vi.fn()}
        onOpenApplication={vi.fn()}
        onQueueJob={vi.fn()}
        selectedJob={{ ...baseSelectedJob, description: text } as SavedJob}
      />
    </MemoryRouter>,
  );
  const listing = screen.getByTestId("discovery-detail-listing-text");
  expect(listing.parentElement?.className).toContain("min-w-0");
  expect(listing.parentElement?.className).toContain(
    "[overflow-wrap:anywhere]",
  );
  expect(listing.textContent).toContain(text);
});

it("wraps a long employer name in the Companies button instead of widening the column", () => {
  cleanup();
  render(
    <MemoryRouter>
      <DiscoveryDetailPanel
        applicationRecords={[]}
        discoveryTargets={[]}
        isJobPending={() => false}
        onDismissJob={vi.fn()}
        onOpenApplication={vi.fn()}
        onOpenCompany={vi.fn()}
        onQueueJob={vi.fn()}
        selectedJob={
          {
            ...baseSelectedJob,
            company: "Nordlicht Logistik Speditionsgesellschaft mbH",
          } as SavedJob
        }
        selectedJobCompanyId="company_long"
      />
    </MemoryRouter>,
  );
  const button = screen.getByRole("button", { name: /in Companies$/ });
  expect(button.className).toContain("whitespace-normal");
  expect(button.className).toContain("max-w-full");
});

it("puts the verdict, the deciding facts and the triage actions above the listing text", () => {
  cleanup();
  const onShortlist = vi.fn();
  const onNotInterested = vi.fn();
  const onSkip = vi.fn();
  render(
    <MemoryRouter>
      <DiscoveryDetailPanel
        discoveryTargets={[]}
        isJobPending={() => false}
        onDismissJob={vi.fn()}
        onQueueJob={vi.fn()}
        selectedJob={createSelectedJob({ id: "job_triage" })}
        triage={{
          goneThrough: 23,
          total: 678,
          weaker: false,
          nextTitle: "Staff Engineer",
          onShortlist,
          onNotInterested,
          onSkip,
          undo: { label: "Undo: show Role again", onUndo: vi.fn() },
          failure: null,
        }}
      />
    </MemoryRouter>,
  );
  const summary = screen.getByTestId("discovery-detail-primary-action");
  const verdict = screen.getByTestId("discovery-detail-verdict");
  expect(summary.contains(verdict)).toBe(true);
  expect(
    summary.contains(screen.getByTestId("discovery-detail-key-facts")),
  ).toBe(true);
  // One verdict, at the top: the scroll area does not repeat it.
  expect(screen.getAllByTestId("discovery-detail-why-it-fits")).toHaveLength(1);
  expect(
    verdict.compareDocumentPosition(
      screen.getByTestId("discovery-detail-listing-text"),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.getByText("23 of 678 gone through")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /^Shortlist job/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Not interested$/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Skip/ }));
  expect(onShortlist).toHaveBeenCalledTimes(1);
  expect(onNotInterested).toHaveBeenCalledTimes(1);
  expect(onSkip).toHaveBeenCalledTimes(1);
  // Not interested is offered once; the form below adds only the employer.
  expect(
    screen.getAllByRole("button", { name: /Not interested/ }),
  ).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "Hide this employer…" }),
  ).toBeTruthy();
});
