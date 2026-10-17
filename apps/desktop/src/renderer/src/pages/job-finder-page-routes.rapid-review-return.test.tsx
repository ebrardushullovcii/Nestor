// @vitest-environment jsdom

import { Suspense } from "react";
import type { JobFinderRendererWorkspaceSnapshot } from "@nordri/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  MemoryRouter,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobFinderPageContext } from "./job-finder-page-context";
import {
  JobFinderDiscoveryRoute,
  JobFinderRapidReviewRoute,
} from "./job-finder-page-routes";

const RAPID_REVIEW_RETURN_PARAM = encodeURIComponent(
  "/job-finder/rapid-review",
);

vi.mock(
  "@renderer/features/job-finder/screens/rapid-review/rapid-review-screen",
  () => ({
    RapidReviewScreen: (props: Record<string, unknown>) => (
      <div>
        <p data-testid="rr-campaign">{String(props.campaignId)}</p>
        <p data-testid="rr-jobs">
          {(props.jobs as ReadonlyArray<{ id: string }>)
            .map((job) => job.id)
            .join(",")}
        </p>
        <button
          data-testid="rr-inspect"
          onClick={() =>
            (props.onInspectJob as (jobId: string) => void)("job_a")
          }
          type="button"
        >
          inspect
        </button>
      </div>
    ),
  }),
);

vi.mock(
  "@renderer/features/job-finder/screens/discovery/discovery-screen",
  () => ({
    DiscoveryScreen: (props: Record<string, unknown>) => (
      <div>
        <p data-testid="disc-job">
          {(props.selectedJob as { id: string } | null)?.id ?? "none"}
        </p>
        {props.onBackToRapidReview ? (
          <button
            data-testid="disc-back"
            onClick={() => (props.onBackToRapidReview as () => void)()}
            type="button"
          >
            back
          </button>
        ) : null}
      </div>
    ),
  }),
);

function workspace(): JobFinderRendererWorkspaceSnapshot {
  return {
    activeCampaignId: "campaign_1",
    campaigns: [
      { id: "campaign_1", name: "Campaign One", jobIds: ["job_a", "job_b"] },
      { id: "campaign_2", name: "Campaign Two", jobIds: ["job_c"] },
    ],
    discoveryJobs: [
      { id: "job_a", title: "Job A" },
      { id: "job_b", title: "Job B" },
      { id: "job_c", title: "Job C" },
    ],
    dismissedDiscoveryJobs: [],
    recentDiscoveryRuns: [],
    discoverySessions: [],
    sourceAccessPrompts: [],
    browserSession: {},
    intelligence: {
      rapidReviewLogs: [],
      // Home reads the safeguards block on every render; a parsed snapshot
      // always carries it (the contract defaults it), so the fixture must too.
      safeguards: {
        abnormalFailurePauses: [],
        companyApplicationCaps: [],
        contradictoryAnswerDetections: [],
        listingSignals: [],
        preparedBatchSampleReviews: [],
        safeguardDismissals: [],
        simultaneousApplicationConflicts: [],
        updatedAt: null,
      },
    },
    hydration: { phase: "ready", deferredCollections: [] },
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

function createContext(
  overrides: Partial<JobFinderPageContext> = {},
): JobFinderPageContext {
  return {
    actionState: { message: null },
    discoveryRunFeedback: null,
    liveDiscoveryEvents: [],
    isAnyPending: vi.fn(() => false),
    isPending: vi.fn(() => false),
    onSelectDiscoveryJob: vi.fn(),
    workspace: workspace(),
    ...overrides,
  } as unknown as JobFinderPageContext;
}

let navigatedPaths: string[];
let currentLocation: { pathname: string; search: string };

function Probe() {
  const location = useLocation();
  currentLocation = { pathname: location.pathname, search: location.search };
  return null;
}

function renderRoutes(initialEntry: string, context: JobFinderPageContext) {
  navigatedPaths = [];
  function Harness() {
    const navigate = useNavigate();
    return (
      <Outlet
        context={{
          ...context,
          onNavigateSafely: (path: string) => {
            navigatedPaths.push(path);
            void navigate(path);
          },
        }}
      />
    );
  }

  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Probe />
      <Routes>
        <Route element={<Harness />}>
          <Route
            path="/job-finder/rapid-review"
            element={
              <Suspense fallback={null}>
                <JobFinderRapidReviewRoute />
              </Suspense>
            }
          />
          <Route
            path="/job-finder/discovery"
            element={
              <Suspense fallback={null}>
                <JobFinderDiscoveryRoute />
              </Suspense>
            }
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("Rapid Review inspect return routing", () => {
  afterEach(cleanup);

  it("navigates inspect to discovery with an explicit safe return context", async () => {
    const context = createContext();
    renderRoutes("/job-finder/rapid-review", context);

    fireEvent.click(await screen.findByTestId("rr-inspect"));

    const discJob = await screen.findByTestId("disc-job");
    expect(discJob.textContent).toBe("job_a");
    expect(context.onSelectDiscoveryJob).toHaveBeenCalledWith("job_a");
    expect(currentLocation).toEqual({
      pathname: "/job-finder/discovery",
      search: `?jobId=job_a&returnTo=${RAPID_REVIEW_RETURN_PARAM}`,
    });
  });

  it("returns directly to rapid review preserving campaign and job scope", async () => {
    const context = createContext({
      onSelectDiscoveryJob: vi.fn(),
    });
    renderRoutes(
      `/job-finder/discovery?jobId=job_a&returnTo=${RAPID_REVIEW_RETURN_PARAM}`,
      context,
    );

    fireEvent.click(await screen.findByTestId("disc-back"));

    const rrCampaign = await screen.findByTestId("rr-campaign");
    expect(rrCampaign.textContent).toBe("campaign_1");
    expect(screen.getByTestId("rr-jobs").textContent).toBe("job_a,job_b");
    expect(currentLocation).toEqual({
      pathname: "/job-finder/rapid-review",
      search: "",
    });
    expect(navigatedPaths).toEqual(["/job-finder/rapid-review"]);
  });

  it("renders no return action when the return param is not allow-listed", async () => {
    renderRoutes(
      "/job-finder/discovery?returnTo=https%3A%2F%2Fevil.example%2Fsteal",
      createContext(),
    );

    await screen.findByTestId("disc-job");

    expect(screen.queryByTestId("disc-back")).toBeNull();
  });

  it("keeps the plain discovery surface free of return actions", async () => {
    renderRoutes("/job-finder/discovery", createContext());

    await screen.findByTestId("disc-job");

    expect(screen.queryByTestId("disc-back")).toBeNull();
  });
});
