// @vitest-environment jsdom

import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import type { JobFinderPageContext } from "./job-finder-page-context";
import { JobFinderResumeWorkspaceRoute } from "./job-finder-page-routes";

vi.mock(
  "@renderer/features/job-finder/screens/review-queue/resume-workspace-screen",
  () => ({
    ResumeWorkspaceScreen: (props: { jobId?: string }) => (
      <div data-testid="resume-workspace-screen">workspace:{props.jobId}</div>
    ),
  }),
);

const REVIEW_QUEUE_ITEM = {
  jobId: "job_ready",
  title: "Senior Product Designer",
  company: "Signal Systems",
  location: "Remote",
  matchScore: 96,
  applicationStatus: "ready_for_review",
  resumeApplicationMode: "tailored_per_job",
  assetStatus: "ready",
  progressPercent: 100,
  resumeAssetId: "asset_job_ready",
  resumeReview: {
    status: "approved",
    approvedAt: "2026-03-20",
    approvedExportId: "export",
    approvedFormat: "pdf",
    approvedFilePath: "/tmp/ready-resume.pdf",
  },
  updatedAt: "2026-03-20T10:04:00.000Z",
} satisfies NonNullable<
  JobFinderRendererWorkspaceSnapshot["reviewQueue"][number]
>;

function createWorkspace(
  overrides: Partial<
    Pick<JobFinderRendererWorkspaceSnapshot, "hydration" | "reviewQueue">
  > = {},
): JobFinderRendererWorkspaceSnapshot {
  return {
    hydration: { phase: "complete", deferredCollections: [] },
    reviewQueue: [
      REVIEW_QUEUE_ITEM,
      {
        ...REVIEW_QUEUE_ITEM,
        jobId: "job_other",
        title: "Other role",
        company: "Other Co",
        matchScore: 71,
      },
    ],
    ...overrides,
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

function createContext(
  overrides: Partial<JobFinderPageContext> = {},
): JobFinderPageContext {
  return {
    actionState: { message: null },
    isPending: vi.fn(() => false),
    assistantMessages: [],
    onApproveCurrentResume: vi.fn(),
    onApproveResume: vi.fn(),
    onBack: vi.fn(),
    onClearResumeApproval: vi.fn(),
    onDirtyChange: vi.fn(),
    onExportPdf: vi.fn(),
    onApplyPatch: vi.fn(),
    onNavigateSafely: vi.fn(),
    onPreviewDraft: vi.fn(),
    onRefresh: vi.fn(),
    onRegenerateDraft: vi.fn(),
    onRegenerateSection: vi.fn(),
    onRestoreRevision: vi.fn(),
    onSaveDraft: vi.fn(),
    onSaveDraftAndThen: vi.fn(),
    onSendAssistantMessage: vi.fn(),
    onResolveAssistantProposal: vi.fn(),
    resumeAssistantMessages: [],
    resumeAssistantPending: false,
    resumeWorkspace: {
      job: { id: "job_ready" },
    } as unknown as JobFinderPageContext["resumeWorkspace"],
    workspace: createWorkspace(),
    ...overrides,
  } as unknown as JobFinderPageContext;
}

function buildRouteTree(context: JobFinderPageContext) {
  return (
    <MemoryRouter
      initialEntries={["/job-finder/review-queue/job_ready/resume"]}
    >
      <Routes>
        <Route path="/job-finder" element={<Outlet context={context} />}>
          <Route
            path="review-queue/:jobId/resume"
            element={
              <Suspense fallback={<div data-testid="route-fallback" />}>
                <JobFinderResumeWorkspaceRoute />
              </Suspense>
            }
          />
          <Route
            path="review-queue"
            element={<div data-testid="review-queue-route" />}
          />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function renderRoute(context: JobFinderPageContext) {
  return render(buildRouteTree(context));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("JobFinderResumeWorkspaceRoute", () => {
  it("keeps the workspace open across a benign background recompute", async () => {
    const firstWorkspace = createWorkspace();
    const { rerender } = render(
      buildRouteTree(createContext({ workspace: firstWorkspace })),
    );

    expect(await screen.findByTestId("resume-workspace-screen")).toBeTruthy();
    expect(screen.queryByTestId("review-queue-route")).toBeNull();

    // A background refresh replaces the snapshot with the same membership but
    // recomputed fit scores and a new generatedAt.
    const recomputedWorkspace = createWorkspace({
      reviewQueue: [
        { ...REVIEW_QUEUE_ITEM, matchScore: 71 },
        {
          ...REVIEW_QUEUE_ITEM,
          jobId: "job_other",
          title: "Other role",
          company: "Other Co",
          matchScore: 53,
        },
      ],
    });
    rerender(buildRouteTree(createContext({ workspace: recomputedWorkspace })));

    expect(await screen.findByTestId("resume-workspace-screen")).toBeTruthy();
    expect(screen.queryByTestId("review-queue-route")).toBeNull();
    expect(screen.queryByText("Resume no longer available")).toBeNull();
  });

  it("keeps the workspace open while the deferred review queue is still hydrating", () => {
    const hydratingWorkspace = createWorkspace({
      hydration: { phase: "bootstrap", deferredCollections: ["review_queue"] },
      reviewQueue: [],
    });
    renderRoute(createContext({ workspace: hydratingWorkspace }));

    expect(screen.queryByTestId("resume-workspace-screen")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Loading your workspace",
    );
    expect(screen.queryByTestId("review-queue-route")).toBeNull();
    expect(screen.queryByText("Resume no longer available")).toBeNull();
  });

  it("shows an explicit unavailable state instead of silently bouncing when the job is truly gone", async () => {
    const missingJobWorkspace = createWorkspace({
      reviewQueue: [
        {
          ...REVIEW_QUEUE_ITEM,
          jobId: "job_other",
          title: "Other role",
          company: "Other Co",
          matchScore: 71,
        },
      ],
    });
    const context = createContext({ workspace: missingJobWorkspace });
    renderRoute(context);

    expect(screen.queryByTestId("resume-workspace-screen")).toBeNull();
    expect(screen.queryByTestId("review-queue-route")).toBeNull();
    expect(await screen.findByText("Resume no longer available")).toBeTruthy();
    expect(
      screen.getByText(
        /no longer available because the job is no longer in Shortlisted/i,
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "View Shortlisted" }));
    expect(context.onNavigateSafely).toHaveBeenCalledWith(
      "/job-finder/review-queue",
    );
  });
});
