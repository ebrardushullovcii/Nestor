import { describe, expect, it, vi } from "vitest";
import type { SetStateAction } from "react";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import type {
  ActionState,
  JobFinderShellActions,
} from "@renderer/features/job-finder/lib/job-finder-types";
import { buildJobFinderPageContext } from "./use-job-finder-page-controller-context";
import {
  type PendingActionState,
  jobFinderPendingActions,
} from "./job-finder-pending-actions";

type BuildContextArgs = Parameters<typeof buildJobFinderPageContext>[0];

function createContext(actions: Partial<JobFinderShellActions>) {
  let actionState: ActionState = { message: null };
  let pendingActionState: PendingActionState = {};
  const context = buildJobFinderPageContext({
    actions: actions as JobFinderShellActions,
    setActionState: (next: SetStateAction<ActionState>) => {
      actionState = typeof next === "function" ? next(actionState) : next;
    },
    setPendingActionState: (next: SetStateAction<PendingActionState>) => {
      pendingActionState =
        typeof next === "function" ? next(pendingActionState) : next;
    },
  } as unknown as BuildContextArgs);

  return {
    context,
    readActionState: () => actionState,
    readPendingActionState: () => pendingActionState,
  };
}

describe("buildJobFinderPageContext grouped manual-answer handlers", () => {
  it("projects a grouped answer through the action runner with its own pending scope", async () => {
    const projectGroupedManualAnswer =
      vi.fn<JobFinderShellActions["projectGroupedManualAnswer"]>();
    let resolveProject: (
      value: JobFinderRendererWorkspaceSnapshot,
    ) => void = () => undefined;
    projectGroupedManualAnswer.mockReturnValue(
      new Promise((resolve) => {
        resolveProject = resolve;
      }),
    );
    const { context, readActionState, readPendingActionState } = createContext({
      projectGroupedManualAnswer,
    });

    context.onProjectGroupedManualAnswer({
      groupKey: "group_1",
      requestId: "request_a",
      expectedRequestRevision: 1,
      answer: { type: "text", value: "5 years" },
      saveScope: "reusable_profile",
    });

    expect(readPendingActionState()).toEqual({
      [jobFinderPendingActions.groupedManualAnswerProject("group_1")]: 1,
    });
    expect(readActionState().message).toBeNull();

    resolveProject({} as JobFinderRendererWorkspaceSnapshot);
    await vi.waitFor(() => {
      expect(readPendingActionState()).toEqual({});
      expect(readActionState().message).toMatch(/created for review/i);
    });
    expect(projectGroupedManualAnswer).toHaveBeenCalledWith({
      groupKey: "group_1",
      requestId: "request_a",
      expectedRequestRevision: 1,
      answer: { type: "text", value: "5 years" },
      saveScope: "reusable_profile",
    });
  });

  it("applies a grouped answer with a distinct fill-only message and decision scope", async () => {
    const applyGroupedManualAnswer = vi
      .fn<JobFinderShellActions["applyGroupedManualAnswer"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const { context, readActionState, readPendingActionState } = createContext({
      applyGroupedManualAnswer,
    });
    const input = {
      decisionId: "group_1:abc123",
      requestIds: ["request_a", "request_b"],
      expectedRequestRevisions: { request_a: 1, request_b: 1 },
      answer: { type: "text" as const, value: "5 years" },
    };

    context.onApplyGroupedManualAnswer(input);

    await vi.waitFor(() => {
      expect(applyGroupedManualAnswer).toHaveBeenCalledWith(input);
      expect(readPendingActionState()).toEqual({});
      expect(readActionState().message).toMatch(
        /final submission and account creation remain disabled/i,
      );
    });
  });

  it("snoozes a grouped decision with a note-aware message", async () => {
    const snoozeGroupedDecision = vi
      .fn<JobFinderShellActions["snoozeGroupedDecision"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const { context, readActionState, readPendingActionState } = createContext({
      snoozeGroupedDecision,
    });

    context.onSnoozeGroupedDecision({
      decisionId: "group_1:abc123",
      expectedRevision: 1,
      until: "2026-08-17T10:00:00.000Z",
      reason: "Ask the recruiter",
    });

    await vi.waitFor(() => {
      expect(snoozeGroupedDecision).toHaveBeenCalledWith({
        decisionId: "group_1:abc123",
        expectedRevision: 1,
        until: "2026-08-17T10:00:00.000Z",
        reason: "Ask the recruiter",
      });
      expect(readPendingActionState()).toEqual({});
      expect(readActionState().message).toMatch(/snoozed with your note/i);
    });
  });
});
