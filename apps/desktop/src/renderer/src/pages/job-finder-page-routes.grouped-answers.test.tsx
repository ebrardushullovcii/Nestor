// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type {
  GroupedManualAnswerDecision,
  JobFinderRendererWorkspaceSnapshot,
} from "@nordri/contracts";
import type { JobFinderPageContext } from "./job-finder-page-context";
import { jobFinderPendingActions } from "./job-finder-pending-actions";
import { selectJobFinderActionsScope } from "./job-finder-page-routes";

function createDecision(): GroupedManualAnswerDecision {
  return {
    id: "group_1:abc123",
    groupKey: "group_1",
    kind: "manual_answer",
    blockerKind: "manual_answer",
    authority: "manual_answer",
    reuseScope: "reusable",
    requestId: "request_a",
    applicationRecordId: "application_job_a",
    jobId: "job_a",
    resultId: null,
    questionId: "question_years",
    expectedRevision: 1,
    expectedQuestionRevision: 1,
    expectedAnswerRevision: 0,
    fingerprints: {
      questionMeaning: "a".repeat(64),
      answerPolicy: "b".repeat(64),
    },
    answer: { type: "text", value: "5 years" },
    approval: "pending",
    approvedAt: null,
    conflict: {
      status: "none",
      detectedAt: null,
      resolvedAt: null,
      conflictingDecisionId: null,
      summary: null,
    },
    snooze: null,
    lineage: [
      {
        requestId: "request_a",
        jobId: "job_a",
        applicationRecordId: "application_job_a",
        resultId: null,
        questionId: "question_years",
        answerRecordId: null,
        expectedRequestRevision: 1,
        expectedQuestionRevision: 1,
        expectedAnswerRevision: 0,
        appliedAt: null,
      },
    ],
    createdAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T10:00:00.000Z",
  };
}

function createContext(
  overrides: Partial<JobFinderPageContext> = {},
): JobFinderPageContext {
  return {
    isPending: vi.fn(() => false),
    onApplyGroupedManualAnswer: vi.fn(() => undefined),
    onProjectGroupedManualAnswer: vi.fn(() => undefined),
    onSnoozeGroupedDecision: vi.fn(() => undefined),
    workspace: {
      intelligence: {
        groupedDecisions: [createDecision()],
      },
    } as unknown as JobFinderRendererWorkspaceSnapshot,
    ...overrides,
  } as unknown as JobFinderPageContext;
}

describe("selectJobFinderActionsScope", () => {
  it("consumes only the persisted groupedDecisions from the workspace intelligence", () => {
    const context = createContext();
    const scope = selectJobFinderActionsScope(context);

    expect(scope.groupedDecisions).toBe(
      context.workspace.intelligence.groupedDecisions,
    );
    expect(scope.groupedDecisions).toEqual([createDecision()]);
  });

  it("maps every grouped pending check to the existing context scopes", () => {
    const isPending = vi.fn(() => false);
    const context = createContext({ isPending });
    const scope = selectJobFinderActionsScope(context);

    scope.isGroupedApplyPending("group_1:abc123");
    expect(isPending).toHaveBeenCalledWith(
      jobFinderPendingActions.groupedManualAnswerApply("group_1:abc123"),
    );
    scope.isGroupedProjectPending("group_1");
    expect(isPending).toHaveBeenCalledWith(
      jobFinderPendingActions.groupedManualAnswerProject("group_1"),
    );
    scope.isGroupedSnoozePending("group_1:abc123");
    expect(isPending).toHaveBeenCalledWith(
      jobFinderPendingActions.groupedDecisionSnooze("group_1:abc123"),
    );
  });

  it("forwards the project, apply, and snooze handlers unchanged", () => {
    const context = createContext();
    const scope = selectJobFinderActionsScope(context);

    expect(scope.onProjectGroupedManualAnswer).toBe(
      context.onProjectGroupedManualAnswer,
    );
    expect(scope.onApplyGroupedManualAnswer).toBe(
      context.onApplyGroupedManualAnswer,
    );
    expect(scope.onSnoozeGroupedDecision).toBe(context.onSnoozeGroupedDecision);
  });
});
