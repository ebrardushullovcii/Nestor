import { describe, expect, it, vi } from "vitest";
import type { SetStateAction } from "react";
import {
  DiscoveryActivityEventSchema,
  type DiscoveryActivityEvent,
  type JobFinderAgentDiscoveryResult,
  type JobFinderRendererWorkspaceSnapshot,
  type ResumeAssistantMessage,
} from "@nordri/contracts";
import type {
  ActionState,
  JobFinderShellActions,
} from "@renderer/features/job-finder/lib/job-finder-types";
import type { DiscoveryRunFeedback } from "@renderer/features/job-finder/screens/discovery/discovery-run-feedback";
import {
  createActionRunners,
  createPrimaryPageActions,
} from "./use-job-finder-page-controller-actions";

type PrimaryPageActionArgs = Parameters<typeof createPrimaryPageActions>[0];

const workspace = {
  searchPreferences: {
    discovery: {
      targets: [
        {
          id: "source_1",
          label: "Stripe Careers",
          enabled: true,
          startingUrl: "https://jobs.example.com",
        },
      ],
    },
  },
} as unknown as JobFinderRendererWorkspaceSnapshot;

function createAgentDiscoveryResult(
  outcome: JobFinderAgentDiscoveryResult["outcome"],
  snapshot: Record<string, unknown> = {},
): JobFinderAgentDiscoveryResult {
  return {
    outcome,
    snapshot: snapshot as JobFinderRendererWorkspaceSnapshot,
  };
}

function cancelledRunSnapshot(validJobsFound: number | null) {
  return {
    recentDiscoveryRuns:
      validJobsFound === null
        ? []
        : [
            {
              state: "cancelled",
              summary: { validJobsFound },
            },
          ],
  };
}

function createDiscoveryFeedbackHarness(input: {
  runAgentDiscovery: JobFinderShellActions["runAgentDiscovery"];
  workspace?: JobFinderRendererWorkspaceSnapshot;
  runActionOverride?: PrimaryPageActionArgs["runAction"];
  actions?: Partial<JobFinderShellActions>;
}) {
  let actionState: ActionState = { message: null };
  const feedbackUpdates: DiscoveryRunFeedback[] = [];
  let liveEvents: DiscoveryActivityEvent[] = [];

  const applyActionState = (next: SetStateAction<ActionState>) => {
    actionState = typeof next === "function" ? next(actionState) : next;
  };
  const setDiscoveryRunFeedback = (
    next: SetStateAction<DiscoveryRunFeedback | null>,
  ) => {
    const resolved =
      typeof next === "function" ? next(feedbackUpdates.at(-1) ?? null) : next;
    if (resolved !== null) {
      feedbackUpdates.push(resolved);
    }
  };

  const { runAction, runResumeWorkspaceAction, withPendingScope } =
    createActionRunners({
      setActionState: applyActionState,
      setPendingActionState: vi.fn(),
    });
  const setSelectedReviewJobId = vi.fn();
  const pageActions = createPrimaryPageActions({
    actions: {
      refreshWorkspace: vi
        .fn<JobFinderShellActions["refreshWorkspace"]>()
        .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot),
      runAgentDiscovery: input.runAgentDiscovery,
      ...input.actions,
    } as unknown as JobFinderShellActions,
    runAction: input.runActionOverride ?? runAction,
    refreshResumeWorkspace: vi.fn().mockResolvedValue(true),
    runResumeWorkspaceAction,
    setActionState: applyActionState,
    setDiscoveryRunFeedback,
    setLiveDiscoveryEvents: (
      next: SetStateAction<DiscoveryActivityEvent[]>,
    ) => {
      liveEvents = typeof next === "function" ? next(liveEvents) : next;
    },
    setSelectedReviewJobId,
    withPendingScope,
    workspace: input.workspace ?? workspace,
  } as unknown as PrimaryPageActionArgs);

  return {
    get actionState() {
      return actionState;
    },
    feedbackUpdates,
    setSelectedReviewJobId,
    pageActions,
  };
}

describe("shared discovery run feedback handler", () => {
  it("shows pending then a browser recovery error when the runtime is closed", async () => {
    const runAgentDiscovery = vi
      .fn<JobFinderShellActions["runAgentDiscovery"]>()
      .mockRejectedValue(
        new Error(
          "Error invoking remote method 'job-finder:run-agent-discovery': Error: The dedicated browser profile could not start because Chrome is closed.",
        ),
      );
    const harness = createDiscoveryFeedbackHarness({ runAgentDiscovery });

    harness.pageActions.onRunAgentDiscovery();

    await vi.waitFor(() => {
      expect(harness.feedbackUpdates.at(-1)?.status).toBe("failed");
    });

    expect(runAgentDiscovery).toHaveBeenCalledTimes(1);
    expect(harness.feedbackUpdates[0]?.status).toBe("started");
    expect(harness.feedbackUpdates[0]?.recovery).toBeNull();
    expect(harness.feedbackUpdates[1]?.recovery?.kind).toBe("browser_session");
    expect(harness.actionState.message).toContain("dedicated browser");
    expect(harness.actionState.message).not.toContain("remote method");
  });

  it("keeps the specific recovery action when the cause carries an internal identifier", async () => {
    // The detail channel proves itself here. This failure names the browser
    // AND carries a run id, so the user-copy classifier
    // (`getJobFinderErrorMessage`) replaces the whole sentence with the
    // generic "Something went wrong" line — which mentions no browser, so
    // `getDiscoveryRunFailureRecovery` degrades to the generic "retry"
    // callout and the person loses the one control that fixes it: opening the
    // Job Finder browser. Feeding the raw detail keeps that action.
    const runAgentDiscovery = vi
      .fn<JobFinderShellActions["runAgentDiscovery"]>()
      .mockRejectedValue(
        new Error(
          "Error invoking remote method 'job-finder:run-agent-discovery': Error: discovery_run_9f2c41 could not launch the dedicated browser profile.",
        ),
      );
    const harness = createDiscoveryFeedbackHarness({ runAgentDiscovery });

    harness.pageActions.onRunAgentDiscovery();

    await vi.waitFor(() => {
      expect(harness.feedbackUpdates.at(-1)?.status).toBe("failed");
    });

    const terminal = harness.feedbackUpdates.at(-1);
    expect(terminal?.recovery?.kind).toBe("browser_session");
    expect(terminal?.recovery?.actionLabel).not.toBeNull();
    expect(terminal?.recovery?.kind).not.toBe("retry");
    // Verbatim service detail, with only Electron's transport wrapper gone.
    expect(terminal?.detail).toBe(
      "discovery_run_9f2c41 could not launch the dedicated browser profile.",
    );
    expect(terminal?.detail).not.toContain("remote method");
  });

  it("classifies provider and network transport failures as connection issues", async () => {
    const runAgentDiscovery = vi
      .fn<JobFinderShellActions["runAgentDiscovery"]>()
      .mockRejectedValue(new Error("fetch failed"));
    const harness = createDiscoveryFeedbackHarness({ runAgentDiscovery });

    harness.pageActions.onRunAgentDiscovery();

    await vi.waitFor(() => {
      expect(harness.feedbackUpdates.at(-1)?.status).toBe("failed");
    });
    expect(harness.feedbackUpdates.at(-1)?.recovery?.kind).toBe("connection");
    expect(harness.feedbackUpdates.at(-1)?.detail).toBe("fetch failed");
  });

  it("deep-links a missing single source to the exact source setup owner", async () => {
    const runAgentDiscovery = vi
      .fn<JobFinderShellActions["runAgentDiscovery"]>()
      .mockRejectedValue(
        new Error("single_target: target not found or unavailable"),
      );
    const harness = createDiscoveryFeedbackHarness({ runAgentDiscovery });

    harness.pageActions.onRunDiscoveryForTarget("removed_source");

    await vi.waitFor(() => {
      expect(harness.feedbackUpdates.at(-1)?.status).toBe("failed");
    });
    expect(harness.feedbackUpdates.at(-1)?.recovery?.kind).toBe("source_setup");
  });

  it("rejects an all-source search locally when no source is enabled", () => {
    const runAgentDiscovery =
      vi.fn<JobFinderShellActions["runAgentDiscovery"]>();
    const harness = createDiscoveryFeedbackHarness({
      runAgentDiscovery,
      workspace: {
        ...workspace,
        searchPreferences: {
          ...workspace.searchPreferences,
          discovery: {
            ...workspace.searchPreferences.discovery,
            targets: [],
          },
        },
      } as unknown as JobFinderRendererWorkspaceSnapshot,
    });

    harness.pageActions.onRunAgentDiscovery();

    expect(runAgentDiscovery).not.toHaveBeenCalled();
    expect(harness.feedbackUpdates.at(-1)?.status).toBe("failed");
    expect(harness.feedbackUpdates.at(-1)?.recovery?.kind).toBe("source_setup");
  });

  it("resolves to truthful success feedback after a completed search", async () => {
    const runAgentDiscovery = vi
      .fn<JobFinderShellActions["runAgentDiscovery"]>()
      .mockResolvedValue(createAgentDiscoveryResult("completed"));
    const harness = createDiscoveryFeedbackHarness({ runAgentDiscovery });

    harness.pageActions.onRunAgentDiscovery();

    await vi.waitFor(() => {
      expect(harness.feedbackUpdates.at(-1)?.status).toBe("succeeded");
    });
    expect(harness.feedbackUpdates.at(-1)?.headline).toBe(
      "Search finished and results were saved on this device.",
    );
    expect(harness.actionState.message).toBeNull();
  });

  it("explains zero-new repeat searches from the refreshed run summary", async () => {
    const runAgentDiscovery = vi
      .fn<JobFinderShellActions["runAgentDiscovery"]>()
      .mockResolvedValue(
        createAgentDiscoveryResult("completed", {
          // Intentionally stale/empty so feedback must prefer the refreshed
          // workspace returned by flushFinal/refreshWorkspace.
          recentDiscoveryRuns: [],
        }),
      );
    const refreshWorkspace = vi
      .fn<JobFinderShellActions["refreshWorkspace"]>()
      .mockResolvedValue({
        recentDiscoveryRuns: [
          {
            id: "run_repeat",
            state: "completed",
            startedAt: "2026-08-27T01:00:00.000Z",
            summary: {
              validJobsFound: 0,
              duplicatesMerged: 12,
              sourceHealth: [],
            },
          },
        ],
      } as unknown as JobFinderRendererWorkspaceSnapshot);
    const harness = createDiscoveryFeedbackHarness({
      runAgentDiscovery,
      actions: { refreshWorkspace },
    });

    harness.pageActions.onRunAgentDiscovery();

    await vi.waitFor(() => {
      expect(harness.feedbackUpdates.at(-1)?.status).toBe("succeeded");
    });
    expect(harness.feedbackUpdates.at(-1)?.headline).toContain(
      "12 listings were already saved",
    );
    expect(harness.feedbackUpdates.at(-1)?.headline).toContain("unchanged");
  });

  it("names the configured source in single-source outcome feedback", async () => {
    const runAgentDiscovery = vi
      .fn<JobFinderShellActions["runAgentDiscovery"]>()
      .mockResolvedValue(createAgentDiscoveryResult("completed"));
    const harness = createDiscoveryFeedbackHarness({ runAgentDiscovery });

    harness.pageActions.onRunDiscoveryForTarget("source_1");

    await vi.waitFor(() => {
      expect(harness.feedbackUpdates.at(-1)?.status).toBe("succeeded");
    });
    expect(harness.feedbackUpdates.at(-1)?.targetLabel).toBe("Stripe Careers");
    expect(harness.feedbackUpdates.at(-1)?.headline).toContain(
      "Stripe Careers",
    );
  });

  it("prevents a duplicate click while the first search is pending", async () => {
    let releaseFirstRun!: (result: JobFinderAgentDiscoveryResult) => void;
    const runAgentDiscovery = vi
      .fn<JobFinderShellActions["runAgentDiscovery"]>()
      .mockImplementationOnce(
        () =>
          new Promise<JobFinderAgentDiscoveryResult>((resolve) => {
            releaseFirstRun = resolve;
          }),
      );
    const harness = createDiscoveryFeedbackHarness({ runAgentDiscovery });

    harness.pageActions.onRunAgentDiscovery();
    harness.pageActions.onRunAgentDiscovery();

    expect(runAgentDiscovery).toHaveBeenCalledTimes(1);
    expect(harness.feedbackUpdates.at(-1)?.status).toBe("started");

    releaseFirstRun(createAgentDiscoveryResult("completed"));
    await vi.waitFor(() => {
      expect(harness.feedbackUpdates.at(-1)?.status).toBe("succeeded");
    });
  });

  it("launches exactly one run across an action-factory rebuild", async () => {
    let releaseFirstRun!: (result: JobFinderAgentDiscoveryResult) => void;
    const firstRunAgentDiscovery = vi
      .fn<JobFinderShellActions["runAgentDiscovery"]>()
      .mockImplementationOnce(
        () =>
          new Promise<JobFinderAgentDiscoveryResult>((resolve) => {
            releaseFirstRun = resolve;
          }),
      );
    const beforeRebuild = createDiscoveryFeedbackHarness({
      runAgentDiscovery: firstRunAgentDiscovery,
    });

    beforeRebuild.pageActions.onRunAgentDiscovery();
    expect(firstRunAgentDiscovery).toHaveBeenCalledTimes(1);

    // A live-event or workspace update rebuilds buildJobFinderPageContext,
    // which re-runs createPrimaryPageActions. The rebuilt actions must not
    // launch a second discovery while the first is still active.
    const afterRebuild = createDiscoveryFeedbackHarness({
      runAgentDiscovery: vi.fn<JobFinderShellActions["runAgentDiscovery"]>(),
    });
    afterRebuild.pageActions.onRunAgentDiscovery();

    expect(afterRebuild.feedbackUpdates).toHaveLength(0);

    releaseFirstRun(createAgentDiscoveryResult("completed"));
    await vi.waitFor(() => {
      expect(beforeRebuild.feedbackUpdates.at(-1)?.status).toBe("succeeded");
    });

    afterRebuild.pageActions.onRunAgentDiscovery();
    await vi.waitFor(() => {
      expect(afterRebuild.feedbackUpdates.at(-1)?.status).toBe("succeeded");
    });
  });

  it("replaces started feedback when the post-run refresh fails after completion", async () => {
    const harness = createDiscoveryFeedbackHarness({
      // runAction resolving false models a handled refresh error on a
      // terminal path; the search itself finished.
      runAgentDiscovery: vi.fn<JobFinderShellActions["runAgentDiscovery"]>(),
      runActionOverride: () => Promise.resolve(false),
    });

    harness.pageActions.onRunAgentDiscovery();

    await vi.waitFor(() => {
      expect(harness.feedbackUpdates.at(-1)?.headline).toContain(
        "could not refresh automatically",
      );
    });
    expect(harness.feedbackUpdates[0]?.status).toBe("started");
    expect(harness.feedbackUpdates.at(-1)?.status).toBe("succeeded");
    expect(harness.actionState.message).toBeNull();
  });

  it("reports cancelled feedback — never success — after stopping a run that had committed jobs", async () => {
    const runAgentDiscovery = vi
      .fn<JobFinderShellActions["runAgentDiscovery"]>()
      .mockResolvedValue(
        createAgentDiscoveryResult("cancelled", cancelledRunSnapshot(3)),
      );
    const harness = createDiscoveryFeedbackHarness({ runAgentDiscovery });

    harness.pageActions.onRunAgentDiscovery();

    await vi.waitFor(() => {
      expect(harness.feedbackUpdates.at(-1)?.status).toBe("cancelled");
    });
    expect(harness.feedbackUpdates.at(-1)?.headline).toBe(
      "Search stopped. Jobs found so far were kept on this device.",
    );
    expect(harness.feedbackUpdates.at(-1)?.recovery).toBeNull();
    // Terminal discovery copy lives in discoveryRunFeedback only.
    expect(harness.actionState.message).toBeNull();
    expect(harness.feedbackUpdates.at(-1)?.headline).not.toContain("finished");
  });

  it("keeps stop-before-finish wording for a cancel with no committed jobs", async () => {
    const runAgentDiscovery = vi
      .fn<JobFinderShellActions["runAgentDiscovery"]>()
      .mockResolvedValue(
        createAgentDiscoveryResult("cancelled", cancelledRunSnapshot(null)),
      );
    const harness = createDiscoveryFeedbackHarness({ runAgentDiscovery });

    harness.pageActions.onRunAgentDiscovery();

    await vi.waitFor(() => {
      expect(harness.feedbackUpdates.at(-1)?.status).toBe("cancelled");
    });
    expect(harness.feedbackUpdates.at(-1)?.headline).toBe(
      "The search stopped before it could finish.",
    );
  });

  it("names the stopped source in single-source cancelled feedback", async () => {
    const runAgentDiscovery = vi
      .fn<JobFinderShellActions["runAgentDiscovery"]>()
      .mockResolvedValue(
        createAgentDiscoveryResult("cancelled", cancelledRunSnapshot(2)),
      );
    const harness = createDiscoveryFeedbackHarness({ runAgentDiscovery });

    harness.pageActions.onRunDiscoveryForTarget("source_1");

    await vi.waitFor(() => {
      expect(harness.feedbackUpdates.at(-1)?.status).toBe("cancelled");
    });
    expect(harness.feedbackUpdates.at(-1)?.targetLabel).toBe("Stripe Careers");
    expect(harness.feedbackUpdates.at(-1)?.headline).toBe(
      "Search stopped for Stripe Careers. Jobs found so far were kept on this device.",
    );
  });

  it("stays cancelled instead of claiming a refresh problem when the post-cancel refresh fails", async () => {
    const harness = createDiscoveryFeedbackHarness({
      runAgentDiscovery: vi
        .fn<JobFinderShellActions["runAgentDiscovery"]>()
        .mockResolvedValue(
          createAgentDiscoveryResult("cancelled", cancelledRunSnapshot(0)),
        ),
      // The search itself finished (the runner awaited it); only the final
      // view refresh was handled as failed.
      runActionOverride: async (action: () => Promise<unknown>) => {
        await action();
        return false;
      },
    });

    harness.pageActions.onRunAgentDiscovery();

    await vi.waitFor(() => {
      expect(harness.feedbackUpdates.at(-1)?.status).toBe("cancelled");
    });
    expect(harness.feedbackUpdates.at(-1)?.status).not.toBe("succeeded");
    expect(harness.actionState.message).toBeNull();
  });

  it("keeps could-not-start wording only for a rejection before any progress", async () => {
    const runAgentDiscovery = vi
      .fn<JobFinderShellActions["runAgentDiscovery"]>()
      .mockRejectedValue(new Error("single_target: target not found"));
    const harness = createDiscoveryFeedbackHarness({ runAgentDiscovery });

    harness.pageActions.onRunDiscoveryForTarget("removed_source");

    await vi.waitFor(() => {
      expect(harness.feedbackUpdates.at(-1)?.status).toBe("failed");
    });
    expect(harness.feedbackUpdates.at(-1)?.headline).toBe(
      "Search could not start.",
    );
    expect(harness.feedbackUpdates.at(-1)?.recovery?.kind).toBe("source_setup");
  });

  it("reports a mid-run failure after progress instead of claiming the start failed", async () => {
    const progressEvent = DiscoveryActivityEventSchema.parse({
      id: "event_progress_1",
      runId: "run_progress_1",
      timestamp: "2026-08-23T10:00:00.000Z",
      kind: "progress",
      stage: "navigation",
      targetId: null,
      message: "Loading job list",
    });
    const runAgentDiscovery = vi
      .fn<JobFinderShellActions["runAgentDiscovery"]>()
      .mockImplementation((onEvent) => {
        onEvent?.(progressEvent);
        return Promise.reject(new Error("fetch failed"));
      });
    const harness = createDiscoveryFeedbackHarness({ runAgentDiscovery });

    harness.pageActions.onRunAgentDiscovery();

    await vi.waitFor(() => {
      expect(harness.feedbackUpdates.at(-1)?.status).toBe("failed");
    });
    expect(harness.feedbackUpdates.at(-1)?.headline).toBe(
      "The search stopped before it could finish.",
    );
    expect(harness.feedbackUpdates.at(-1)?.detail).toBe("fetch failed");
    expect(harness.feedbackUpdates.at(-1)?.recovery?.kind).toBe("connection");
    expect(harness.feedbackUpdates.at(-1)?.recovery?.headline).not.toBe(
      harness.feedbackUpdates.at(-1)?.headline,
    );
  });

  it("classifies a tool-calling gap after progress without duplicating stopped copy", async () => {
    const progressEvent = DiscoveryActivityEventSchema.parse({
      id: "event_progress_tools",
      runId: "run_progress_tools",
      timestamp: "2026-08-27T10:00:00.000Z",
      kind: "progress",
      stage: "navigation",
      targetId: null,
      message: "Starting browser",
    });
    const runAgentDiscovery = vi
      .fn<JobFinderShellActions["runAgentDiscovery"]>()
      .mockImplementation((onEvent) => {
        onEvent?.(progressEvent);
        return Promise.reject(
          new Error(
            "AI client does not support tool calling. Cannot run agent discovery.",
          ),
        );
      });
    const harness = createDiscoveryFeedbackHarness({ runAgentDiscovery });

    harness.pageActions.onRunAgentDiscovery();

    await vi.waitFor(() => {
      expect(harness.feedbackUpdates.at(-1)?.status).toBe("failed");
    });
    const terminal = harness.feedbackUpdates.at(-1);
    expect(terminal?.recovery?.headline).toContain("Live search needs AI");
    expect(terminal?.recovery?.headline).not.toBe(terminal?.headline);
    expect(`${terminal?.headline} ${terminal?.recovery?.headline}`).not.toMatch(
      /The search stopped before it could finish\..*The search stopped before it could finish\./,
    );
  });
});

describe("onQueueJob request-local shortlist outcome", () => {
  function createShortlistHarness(
    queueJobForReview: JobFinderShellActions["queueJobForReview"],
  ) {
    return createDiscoveryFeedbackHarness({
      runAgentDiscovery: vi.fn<JobFinderShellActions["runAgentDiscovery"]>(),
      actions: { queueJobForReview },
    });
  }

  it("resolves an awaited typed success while keeping the shared route message", async () => {
    const queueJobForReview = vi
      .fn<JobFinderShellActions["queueJobForReview"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const harness = createShortlistHarness(queueJobForReview);

    await expect(harness.pageActions.onQueueJob("job_1")).resolves.toEqual({
      message: "Job added to Shortlisted.",
      status: "success",
    });

    expect(queueJobForReview).toHaveBeenCalledWith("job_1");
    expect(harness.setSelectedReviewJobId).toHaveBeenCalledWith("job_1");
    expect(harness.actionState.message).toBe("Job added to Shortlisted.");
  });

  it("resolves a typed failure carrying the same surfaced error copy", async () => {
    const queueJobForReview = vi
      .fn<JobFinderShellActions["queueJobForReview"]>()
      .mockRejectedValue(new Error("offline"));
    const harness = createShortlistHarness(queueJobForReview);

    await expect(harness.pageActions.onQueueJob("job_1")).resolves.toEqual({
      message: "offline",
      status: "failure",
    });

    expect(harness.actionState.message).toBe("offline");
  });
});

describe("onRegenerateResumeSection proposal-only truth", () => {
  function createAssistantMessage(input: {
    createdAt: string;
    id: string;
    proposalStatus: ResumeAssistantMessage["proposalStatus"];
  }): ResumeAssistantMessage {
    return {
      id: input.id,
      jobId: "job_ready",
      role: "assistant",
      content: "assistant reply",
      patches: [],
      proposalStatus: input.proposalStatus,
      baseDraftUpdatedAt: null,
      resolvedPatchIds: [],
      resolvedAt: null,
      proposalError: null,
      createdAt: input.createdAt,
    };
  }

  function createRegenerationHarness(input: {
    regenerateResumeSection: JobFinderShellActions["regenerateResumeSection"];
    getResumeAssistantMessages: JobFinderShellActions["getResumeAssistantMessages"];
  }) {
    return createDiscoveryFeedbackHarness({
      runAgentDiscovery: vi.fn<JobFinderShellActions["runAgentDiscovery"]>(),
      actions: {
        getResumeAssistantMessages: input.getResumeAssistantMessages,
        regenerateResumeSection: input.regenerateResumeSection,
      },
    });
  }

  it("reports a pending proposal without claiming the section changed", async () => {
    const regenerateResumeSection = vi
      .fn<JobFinderShellActions["regenerateResumeSection"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const getResumeAssistantMessages = vi
      .fn<JobFinderShellActions["getResumeAssistantMessages"]>()
      .mockResolvedValue([
        createAssistantMessage({
          createdAt: "2026-08-24T10:00:00.000Z",
          id: "message_old",
          proposalStatus: "none",
        }),
        createAssistantMessage({
          createdAt: "2026-08-24T10:01:00.000Z",
          id: "message_pending",
          proposalStatus: "pending",
        }),
      ]);
    const harness = createRegenerationHarness({
      getResumeAssistantMessages,
      regenerateResumeSection,
    });

    harness.pageActions.onRegenerateResumeSection(
      "job_ready",
      "section_summary",
    );

    await vi.waitFor(() => {
      expect(harness.actionState.message).toBe(
        "Rewrite proposed for review. Nothing changed yet.",
      );
    });
    expect(regenerateResumeSection).toHaveBeenCalledWith(
      "job_ready",
      "section_summary",
    );
    expect(getResumeAssistantMessages).toHaveBeenCalledWith("job_ready");
    expect(harness.actionState.message).not.toBe("Section refreshed.");
  });

  it("reports when no changes were proposed instead of claiming a refresh", async () => {
    const regenerateResumeSection = vi
      .fn<JobFinderShellActions["regenerateResumeSection"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const getResumeAssistantMessages = vi
      .fn<JobFinderShellActions["getResumeAssistantMessages"]>()
      .mockResolvedValue([
        createAssistantMessage({
          createdAt: "2026-08-24T10:01:00.000Z",
          id: "message_no_change",
          proposalStatus: "none",
        }),
      ]);
    const harness = createRegenerationHarness({
      getResumeAssistantMessages,
      regenerateResumeSection,
    });

    harness.pageActions.onRegenerateResumeSection(
      "job_ready",
      "section_summary",
    );

    await vi.waitFor(() => {
      expect(harness.actionState.message).toBe(
        "No changes were proposed for this section.",
      );
    });
    expect(harness.actionState.message).not.toBe("Section refreshed.");
  });

  it("keeps the existing regeneration action errors untouched", async () => {
    const regenerateResumeSection = vi
      .fn<JobFinderShellActions["regenerateResumeSection"]>()
      .mockRejectedValue(
        new Error("Unlock the 'Summary' section before regenerating it."),
      );
    const getResumeAssistantMessages =
      vi.fn<JobFinderShellActions["getResumeAssistantMessages"]>();
    const harness = createRegenerationHarness({
      getResumeAssistantMessages,
      regenerateResumeSection,
    });

    harness.pageActions.onRegenerateResumeSection(
      "job_ready",
      "section_locked",
    );

    await vi.waitFor(() => {
      expect(harness.actionState.message).toBe(
        "Unlock the 'Summary' section before regenerating it.",
      );
    });
    // The outcome read never runs for a rejected action.
    expect(getResumeAssistantMessages).not.toHaveBeenCalled();
  });
});
