import { describe, expect, it, vi } from "vitest";
import type { SetStateAction } from "react";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
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
  searchPreferences: { tailoringMode: "aggressive", discovery: { targets: [] } },
  reviewQueue: [
    {
      jobId: "job_comet",
      assetStatus: "not_started",
      resumeApplicationMode: "original_resume",
      resumeTailoringMode: null,
    },
  ],
} as unknown as JobFinderRendererWorkspaceSnapshot;

function createHarness(outage = false) {
  let actionState: ActionState = { message: null };
  const calls: unknown[][] = [];
  const applyActionState = (next: SetStateAction<ActionState>) => {
    actionState = typeof next === "function" ? next(actionState) : next;
  };
  const { runAction, runResumeWorkspaceAction, withPendingScope } =
    createActionRunners({
      setActionState: applyActionState,
      setPendingActionState: vi.fn(),
    });
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return Promise.resolve(
        name === "send"
          ? []
          : name === "generate" && outage
            ? {
                ...workspace,
                tailoredAssets: [
                  {
                    jobId: "job_comet",
                    generationMethod: "deterministic",
                    generationReason: "provider_failed",
                  },
                ],
              }
            : workspace,
      );
    };
  const refreshResumeWorkspace = vi.fn(() => Promise.resolve(true));
  const pageActions = createPrimaryPageActions({
    actions: {
      setJobResumeApplicationMode: record("set_level"),
      generateResume: record("generate"),
      sendResumeAssistantMessage: record("send"),
    } as unknown as JobFinderShellActions,
    latestWorkspaceRef: { current: null },
    refreshResumeWorkspace,
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
    refreshResumeWorkspace,
  };
}

describe("Original job in Resume Studio", () => {
  it("one press moves the job to the saved level, writes the resume, and asks the Assistant again", async () => {
    const harness = createHarness();

    harness.pageActions.onWriteEditableResumeForOriginalJob(
      "job_comet",
      "Shorten the summary to one sentence.",
    );

    await vi.waitFor(() =>
      expect(harness.message).toBe(
        "Wrote an editable Aggressive resume and asked the Assistant again. Review its proposal.",
      ),
    );
    expect(harness.calls).toEqual([
      ["set_level", "job_comet", "tailored_per_job", "aggressive"],
      ["generate", "job_comet"],
      ["send", "job_comet", "Shorten the summary to one sentence."],
    ]);
    expect(harness.refreshResumeWorkspace).toHaveBeenCalledWith("job_comet", {
      updateAssistantMessages: true,
    });
  });

  it("without a waiting request it only writes the resume", async () => {
    const harness = createHarness();

    harness.pageActions.onWriteEditableResumeForOriginalJob("job_comet", null);

    await vi.waitFor(() =>
      expect(harness.message).toBe(
        "Wrote an editable Aggressive resume for this job.",
      ),
    );
    expect(harness.calls.map((call) => call[0])).toEqual([
      "set_level",
      "generate",
    ]);
  });
});

describe("resume runs that end without AI", () => {
  it("say AI was unavailable instead of claiming a created resume", async () => {
    const harness = createHarness(true);

    void harness.pageActions.onGenerateResume("job_comet");

    await vi.waitFor(() =>
      expect(harness.message).toBe(
        "AI was unavailable, so this resume keeps your saved wording. Press Try again with AI when you are ready.",
      ),
    );
  });
});
