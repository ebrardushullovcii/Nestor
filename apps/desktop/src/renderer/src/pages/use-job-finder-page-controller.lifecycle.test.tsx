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
    discoverySessions: [],
    sourceAccessPrompts: [],
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
        jobFinder: {
          getWorkspaceBootstrap: vi.fn(() => Promise.resolve(workspace)),
          mutateWorkspaceEntities,
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

  });
});
