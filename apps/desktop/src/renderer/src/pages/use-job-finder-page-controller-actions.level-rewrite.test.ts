import { describe, expect, it, vi } from "vitest";
import type { SetStateAction } from "react";
import type { JobFinderRendererWorkspaceSnapshot } from "@nordri/contracts";
import type {
  ActionState,
  JobFinderShellActions,
} from "@renderer/features/job-finder/lib/job-finder-types";
import {
  createActionRunners,
  createPrimaryPageActions,
} from "./use-job-finder-page-controller-actions";

type PrimaryPageActionArgs = Parameters<typeof createPrimaryPageActions>[0];

const workspace = {
  searchPreferences: { tailoringMode: "balanced", discovery: { targets: [] } },
  reviewQueue: [
    {
      jobId: "job_willow",
      assetStatus: "ready",
      resumeApplicationMode: "tailored_per_job",
      resumeTailoringMode: "conservative",
    },
    {
      jobId: "job_fresh",
      assetStatus: "not_started",
      resumeApplicationMode: "tailored_per_job",
      resumeTailoringMode: "conservative",
    },
  ],
} as unknown as JobFinderRendererWorkspaceSnapshot;

function createHarness(options: { rewriteFails?: boolean } = {}) {
  let actionState: ActionState = { message: null };
  const calls: string[] = [];
  const applyActionState = (next: SetStateAction<ActionState>) => {
    actionState = typeof next === "function" ? next(actionState) : next;
  };
  const { runAction, runResumeWorkspaceAction, withPendingScope } =
    createActionRunners({
      setActionState: applyActionState,
      setPendingActionState: vi.fn(),
    });
  const setJobResumeApplicationMode = vi.fn(
    (_jobId: string, _mode: string, tailoringMode?: string | null) => {
      calls.push(`set_level:${tailoringMode ?? "none"}`);
      return Promise.resolve(workspace);
    },
  );
  const regenerateResumeDraft = vi.fn(() => {
    calls.push("rewrite");
    return options.rewriteFails
      ? Promise.reject(
          new Error(
            "The AI could not write this resume, so nothing was changed. Try again.",
          ),
        )
      : Promise.resolve(workspace);
  });
  const pageActions = createPrimaryPageActions({
    actions: {
      setJobResumeApplicationMode,
      regenerateResumeDraft,
    } as unknown as JobFinderShellActions,
    latestWorkspaceRef: { current: null },
    runAction,
    runResumeWorkspaceAction,
    setActionState: applyActionState,
    setSelectedReviewJobId: vi.fn(),
    withPendingScope,
    workspace,
  } as unknown as PrimaryPageActionArgs);
  return {
    calls,
    get message() {
      return actionState.message;
    },
    pageActions,
  };
}

describe("changing one job's resume level", () => {
  it("rewrites a written resume at the new level in the same press", async () => {
    const harness = createHarness();

    harness.pageActions.onSetJobResumeApplicationMode(
      "job_willow",
      "tailored_per_job",
      "balanced",
    );

    await vi.waitFor(() =>
      expect(harness.message).toBe(
        "Resume rewritten at Tailored for this job.",
      ),
    );
    expect(harness.calls).toEqual(["set_level:balanced", "rewrite"]);
  });

  it("puts the old level back when the rewrite fails", async () => {
    const harness = createHarness({ rewriteFails: true });

    harness.pageActions.onSetJobResumeApplicationMode(
      "job_willow",
      "tailored_per_job",
      "aggressive",
    );

    await vi.waitFor(() =>
      expect(harness.message).toBe(
        "The AI could not write this resume, so nothing was changed. Try again.",
      ),
    );
    expect(harness.calls).toEqual([
      "set_level:aggressive",
      "rewrite",
      "set_level:conservative",
    ]);
  });

  it("only saves the level for Original or a job with no resume yet", async () => {
    const harness = createHarness();

    harness.pageActions.onSetJobResumeApplicationMode(
      "job_willow",
      "original_resume",
    );
    await vi.waitFor(() =>
      expect(harness.message).toBe(
        "This job will use your original resume unchanged.",
      ),
    );
    harness.pageActions.onSetJobResumeApplicationMode(
      "job_fresh",
      "tailored_per_job",
      "balanced",
    );
    await vi.waitFor(() =>
      expect(harness.message).toBe("This job will get a tailored resume."),
    );

    expect(harness.calls).toEqual(["set_level:none", "set_level:balanced"]);
  });
});
