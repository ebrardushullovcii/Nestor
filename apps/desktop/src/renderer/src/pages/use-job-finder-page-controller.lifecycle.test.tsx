// @vitest-environment jsdom

import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "@renderer/components/ui/toast";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { JobFinderShellActions } from "@renderer/features/job-finder/lib/job-finder-types";
import { useJobFinderPageController } from "./use-job-finder-page-controller";

function createReviewQueueItem(jobId: string) {
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

function createBatchWorkspace(
  jobCount = 3,
): JobFinderRendererWorkspaceSnapshot {
  const reviewQueue = Array.from({ length: jobCount }, (_, index) =>
    createReviewQueueItem(`job_${index + 1}`),
  );
  return {
    hydration: { phase: "complete", deferredCollections: [] },
    activeCampaignId: "campaign_1",
    campaigns: [
      { id: "campaign_1", jobIds: reviewQueue.map((item) => item.jobId) },
    ],
    discoveryJobs: [],
    dismissedDiscoveryJobs: [],
    recentDiscoveryRuns: [],
    discoverySessions: [],
    sourceAccessPrompts: [],
    activeDiscoveryRun: null,
    reviewQueue,
    tailoredAssets: [],
    applicationRecords: [],
    applicationAttempts: [],
    applyRuns: [],
    applyJobResults: [],
    selectedDiscoveryJobId: null,
    selectedReviewJobId: null,
    selectedApplicationRecordId: null,
    selectedApplyRunId: null,
    settings: { appearanceTheme: "system" },
    profileSetupState: { status: "completed", reviewItems: [] },
    profileCopilotMessages: [],
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

type JobFinderPageController = ReturnType<typeof useJobFinderPageController>;

// The data router constructs a real fetch Request for every navigation.
// jsdom's AbortSignal fails Node's brand check inside the Request constructor,
// so hand React Router a stub with the tiny request surface it reads (url,
// method, signal).
class NavigationRequestStub {
  method: string;
  signal: unknown;
  url: string;

  constructor(
    input: string | URL,
    init?: { method?: string; signal?: unknown },
  ) {
    this.url = String(input);
    this.method = (init?.method ?? "GET").toUpperCase();
    this.signal = init?.signal ?? null;
  }
}

beforeAll(() => {
  vi.stubGlobal("Request", NavigationRequestStub);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("useJobFinderPageController cross-route status lifetime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "nestor");
  });

  function mountStatusHarness(options: {
    initialEntry: string;
    mutateWorkspaceEntities?: (input: {
      baseRevision: number | null;
      mutation: { type: string; jobId: string };
    }) => Promise<{
      kind: "snapshot";
      currentRevision: number;
      snapshot: JobFinderRendererWorkspaceSnapshot;
    }>;
    startApplyCopilotRun?: JobFinderShellActions["startApplyCopilotRun"];
  }) {
    const workspace = createBatchWorkspace();
    const mutateWorkspaceEntities = vi.fn(
      options.mutateWorkspaceEntities ??
        (() =>
          Promise.resolve({
            kind: "snapshot" as const,
            currentRevision: 1,
            snapshot: workspace,
          })),
    );
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        ping: vi.fn(() => Promise.resolve({ platform: "darwin" as const })),
        assistant: {
          syncResumeBatch: (state: unknown) => Promise.resolve(state),
          onResumeBatchStop: () => () => undefined,
        },
        jobFinder: {
          getWorkspaceBootstrap: vi.fn(() => Promise.resolve(workspace)),
          mutateWorkspaceEntities,
          startApplyCopilotRun:
            options.startApplyCopilotRun ?? (() => Promise.resolve(workspace)),
          setActivityControl: vi.fn(() => Promise.resolve(workspace)),
        },
      } as unknown as Window["nestor"],
    });

    const mounted: { current: JobFinderPageController | null } = {
      current: null,
    };

    function ControllerProbe() {
      mounted.current = useJobFinderPageController();
      return null;
    }

    const router = createMemoryRouter(
      [{ path: "*", element: <ControllerProbe /> }],
      { initialEntries: [options.initialEntry] },
    );

    const view = render(
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>,
    );

    return {
      get current() {
        return mounted.current;
      },
      mutateWorkspaceEntities,
      router,
      unmount: view.unmount,
    };
  }

  async function waitForReady(harness: ReturnType<typeof mountStatusHarness>) {
    await waitFor(() => {
      expect(harness.current?.workspaceState.status).toBe("ready");
      expect(harness.current?.context).not.toBeNull();
    });
  }

  it("reports Activity resumed through the toast and clears the route status", async () => {
    const harness = mountStatusHarness({
      initialEntry: "/job-finder/discovery",
    });
    await waitForReady(harness);
    await act(async () => {
      await harness.current?.context?.onSetActivityControl({ paused: false });
    });
    expect(screen.getByRole("status").textContent).toContain(
      "Activity resumed.",
    );
    expect(
      screen.getByText("Activity resumed.").closest("[data-toast]"),
    ).toBeTruthy();
    expect(harness.current?.context?.actionState.message).toBeNull();
    await act(async () => {
      await harness.router.navigate("/job-finder/applications");
    });
    expect(harness.current?.context?.actionState.message).toBeNull();
    expect(screen.getAllByText("Activity resumed.")).toHaveLength(1);
  });

  it("reports a finished shortlist on Find jobs as a toast, not a route status", async () => {
    const harness = mountStatusHarness({
      initialEntry: "/job-finder/discovery",
    });
    await waitForReady(harness);

    await act(async () => {
      await harness.current?.context?.onQueueJob("job_discovery_1");
    });
    // ADR 0044: a success on Find jobs is news, so it is a toast with its
    // Undo, and nothing is left behind to replay on a later visit.
    expect(await screen.findByText("Job added to Shortlisted.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(harness.current?.context?.actionState.message).toBeNull();
  });

  it("keeps a failed status on its owning route and never leaks it to a sibling route", async () => {
    const harness = mountStatusHarness({
      initialEntry: "/job-finder/discovery",
      mutateWorkspaceEntities: () =>
        Promise.reject(new Error("The shortlist could not be saved.")),
    });
    await waitForReady(harness);

    let failure: string | null = null;
    // Awaiting inside act pins the tested lifecycle: the status write lands
    // before the shortlist promise resolves.
    await act(async () => {
      const outcome =
        await harness.current?.context?.onQueueJob("job_discovery_1");
      failure = outcome?.message ?? null;
    });
    expect(failure).not.toBeNull();
    // A failure never becomes a toast.
    await waitFor(() => {
      expect(harness.current?.context?.actionState.message).toBe(failure);
    });
    expect(harness.current?.context?.actionState.tone).toBe("failure");

    act(() => {
      harness.current?.context?.onNavigateSafely("/job-finder/applications");
    });
    await waitFor(() => {
      expect(harness.router.state.location.pathname).toBe(
        "/job-finder/applications",
      );
    });
    await waitFor(() => {
      expect(harness.current?.context?.actionState.message).toBeNull();
    });

    // The status stays attached to its owning route: coming back restores it
    // instead of a fresh unrelated route silently showing a stale status.
    act(() => {
      harness.current?.context?.onNavigateSafely("/job-finder/discovery");
    });
    await waitFor(() => {
      expect(harness.current?.context?.actionState.message).toBe(failure);
    });
  });

  it("carries an action's completion status to the route it navigates to", async () => {
    const startApplyCopilotRun = vi
      .fn<JobFinderShellActions["startApplyCopilotRun"]>()
      .mockResolvedValue(createBatchWorkspace());
    const harness = mountStatusHarness({
      initialEntry: "/job-finder/review-queue",
      startApplyCopilotRun,
    });
    await waitForReady(harness);

    act(() => {
      harness.current?.context?.onApproveApply("job_review_approve");
    });
    await waitFor(() => {
      expect(harness.router.state.location.pathname).toBe(
        "/job-finder/applications",
      );
    });
    // The finished action is reported once, as a toast, on the screen it
    // led to; no route status is left above the Applications list.
    expect(
      await screen.findByText(
        "Applications updated. Check the latest attempt and next step there.",
      ),
    ).toBeTruthy();
    expect(harness.current?.context?.actionState.message ?? "").not.toContain(
      "Applications updated",
    );
  });

  it("keeps a status written after a sibling navigation on the route that owns it", async () => {
    let releaseQueue: () => void = () => undefined;
    let hasParked = false;
    const harness = mountStatusHarness({
      initialEntry: "/job-finder/discovery",
      mutateWorkspaceEntities: () =>
        new Promise((resolve, reject) => {
          if (!hasParked) {
            // The late completion fails, so its status stays on the route
            // that owns it (a success would be a toast, ADR 0044).
            releaseQueue = () => {
              hasParked = true;
              reject(new Error("The shortlist could not be saved."));
            };
            return;
          }
          resolve({
            kind: "snapshot" as const,
            currentRevision: 1,
            snapshot: createBatchWorkspace(),
          });
        }),
    });
    await waitForReady(harness);

    let lateOutcome: Promise<{ message: string } | undefined> | undefined;
    act(() => {
      // Intentionally un-awaited: this first shortlist stays parked until
      // `releaseQueue` settles it after the navigation below, which is the
      // exact late-completion lifecycle under test.
      lateOutcome = harness.current?.context?.onQueueJob("job_discovery_1");
    });
    await waitFor(() => {
      expect(harness.mutateWorkspaceEntities).toHaveBeenCalledTimes(1);
    });

    // The user leaves the discovery route while the action is still running.
    act(() => {
      harness.current?.context?.onNavigateSafely("/job-finder/applications");
    });
    await waitFor(() => {
      expect(harness.router.state.location.pathname).toBe(
        "/job-finder/applications",
      );
    });

    act(() => {
      releaseQueue();
    });
    await waitFor(() => {
      expect(hasParked).toBe(true);
    });
    const failure = (await lateOutcome)?.message ?? null;
    expect(failure).not.toBeNull();
    await waitFor(() => {
      expect(harness.current?.context?.actionState.message).toBeNull();
    });

    // The late completion belongs to the discovery route, not to whatever
    // route the user was on when it landed.
    act(() => {
      harness.current?.context?.onNavigateSafely("/job-finder/discovery");
    });
    await waitFor(() => {
      expect(harness.current?.context?.actionState.message).toBe(failure);
    });
  });
});
