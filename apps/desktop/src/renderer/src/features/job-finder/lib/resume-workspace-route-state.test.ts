import { describe, expect, it } from "vitest";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import {
  RESUME_WORKSPACE_REQUIRED_COLLECTIONS,
  resolveResumeWorkspaceRouteState,
} from "./resume-workspace-route-state";

type ReviewQueueItem = JobFinderRendererWorkspaceSnapshot["reviewQueue"][number];

function hydrate(
  phase: "bootstrap" | "complete",
  deferred: ReadonlyArray<
    JobFinderRendererWorkspaceSnapshot["hydration"]["deferredCollections"][number]
  > = [],
): JobFinderRendererWorkspaceSnapshot["hydration"] {
  return {
    phase,
    deferredCollections: phase === "bootstrap" ? [...deferred] : [],
  };
}

function queueItem(
  jobId: string,
  overrides: Partial<ReviewQueueItem> = {},
): ReviewQueueItem {
  return {
    jobId,
    title: "Senior Product Designer",
    company: "Signal Systems",
    location: "Remote",
    matchScore: 71,
    applicationStatus: "ready_for_review",
    resumeApplicationMode: "tailored_per_job",
    assetStatus: "ready",
    progressPercent: 100,
    resumeAssetId: null,
    resumeReview: { status: "needs_review" },
    updatedAt: "2026-03-20T10:04:00.000Z",
    ...overrides,
  };
}

describe("resolveResumeWorkspaceRouteState", () => {
  it("keeps the route hydrating while the deferred review queue has not loaded", () => {
    expect(
      resolveResumeWorkspaceRouteState({
        hydration: hydrate("bootstrap", [
          ...RESUME_WORKSPACE_REQUIRED_COLLECTIONS,
        ]),
        reviewQueue: [],
        jobId: "job_ready",
      }),
    ).toEqual({ kind: "hydrating" });
  });

  it("treats an empty review queue as unavailable only after hydration completes", () => {
    expect(
      resolveResumeWorkspaceRouteState({
        hydration: hydrate("complete"),
        reviewQueue: [],
        jobId: "job_ready",
      }),
    ).toEqual({ kind: "unavailable" });
  });

  it("keeps the route available across a benign background recompute", () => {
    const refresh = {
      hydration: hydrate("complete"),
      reviewQueue: [queueItem("job_ready", { matchScore: 71 })],
      jobId: "job_ready",
    };
    expect(resolveResumeWorkspaceRouteState(refresh)).toEqual({
      kind: "available",
    });
  });

  it("keeps the route available when another job leaves the hydrated queue", () => {
    expect(
      resolveResumeWorkspaceRouteState({
        hydration: hydrate("complete"),
        reviewQueue: [
          queueItem("job_ready", { matchScore: 71 }),
          queueItem("other_job", { matchScore: 50 }),
        ],
        jobId: "job_ready",
      }),
    ).toEqual({ kind: "available" });
  });

  it("reports a truly missing job as unavailable after hydration", () => {
    expect(
      resolveResumeWorkspaceRouteState({
        hydration: hydrate("complete"),
        reviewQueue: [queueItem("other_job", { matchScore: 50 })],
        jobId: "job_gone",
      }),
    ).toEqual({ kind: "unavailable" });
  });
});
