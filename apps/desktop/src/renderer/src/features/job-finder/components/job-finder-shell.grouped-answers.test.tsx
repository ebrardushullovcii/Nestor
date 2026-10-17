// @vitest-environment jsdom

import type { JobFinderRendererWorkspaceSnapshot } from "@nordri/contracts";
import {
  GroupedManualAnswerDecisionSchema,
  type GroupedManualAnswerDecision,
  type UserActionRequest,
} from "@nordri/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobFinderShell, countUnresolvedUserActions } from "./job-finder-shell";

const windowControlsState = {
  isClosable: true,
  isFullScreen: false,
  isMaximized: false,
  isMinimizable: true,
} as const;

function createWorkspace(input: {
  decisions?: readonly GroupedManualAnswerDecision[];
  requests?: readonly UserActionRequest[];
}): JobFinderRendererWorkspaceSnapshot {
  return {
    applicationRecords: [],
    discoveryJobs: [],
    intelligence: { groupedDecisions: input.decisions ?? [] },
    profileSetupState: {
      completedAt: null,
      currentStep: "import",
      lastResumedAt: null,
      reviewItems: [],
      status: "not_started",
    },
    reviewQueue: [],
    userActionRequests: input.requests ?? [],
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

function createRequest(id: string, state: string): UserActionRequest {
  return {
    id,
    state,
  } as unknown as UserActionRequest;
}

function createPendingDecision(): GroupedManualAnswerDecision {
  return GroupedManualAnswerDecisionSchema.parse({
    id: "group_1:abc123",
    groupKey: "group_1",
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
    conflict: { status: "none" },
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
      {
        requestId: "request_b",
        jobId: "job_b",
        applicationRecordId: "application_job_b",
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
  });
}

describe("JobFinderShell Needs-you badge with grouped reusable answers", () => {
  beforeEach(() => {
    Object.defineProperty(window, "nordri", {
      configurable: true,
      value: {
        window: {
          close: vi.fn().mockResolvedValue(undefined),
          getControlsState: vi.fn().mockResolvedValue(windowControlsState),
          minimize: vi.fn().mockResolvedValue(windowControlsState),
          onControlsStateChange: vi.fn(() => vi.fn()),
          toggleMaximize: vi.fn().mockResolvedValue(windowControlsState),
        },
      },
    });

    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("counts only unrepresented unresolved requests plus pending decisions", () => {
    const decision = createPendingDecision();
    const requests = [
      createRequest("request_a", "pending"),
      createRequest("request_b", "pending"),
      createRequest("request_c", "pending"),
    ];

    expect(countUnresolvedUserActions(requests, [decision])).toBe(2);

    const approved = {
      ...decision,
      approval: "approved" as const,
      approvedAt: "2026-08-16T10:00:00.000Z",
    };
    expect(countUnresolvedUserActions(requests, [approved])).toBe(3);
    expect(countUnresolvedUserActions(requests, [])).toBe(3);
    expect(countUnresolvedUserActions(undefined, [decision])).toBe(1);
  });

  it("shows one badge item for a pending decision that represents two requests", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/actions"]}>
        <JobFinderShell
          platform="win32"
          workspace={createWorkspace({
            decisions: [createPendingDecision()],
            requests: [
              createRequest("request_a", "pending"),
              createRequest("request_b", "pending"),
            ],
          })}
        >
          <div>Actions</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const notificationGroup = screen.getByRole("group", {
      name: "Notifications and actions",
    });
    expect(
      within(notificationGroup).getByRole("button", {
        name: "Needs you: 1 unresolved",
      }),
    ).toBeTruthy();
  });

  it("counts member requests again once the decision is approved", () => {
    const approved = {
      ...createPendingDecision(),
      approval: "approved" as const,
      approvedAt: "2026-08-16T10:00:00.000Z",
    };
    render(
      <MemoryRouter initialEntries={["/job-finder/actions"]}>
        <JobFinderShell
          platform="win32"
          workspace={createWorkspace({
            decisions: [approved],
            requests: [
              createRequest("request_a", "verifying"),
              createRequest("request_b", "verifying"),
            ],
          })}
        >
          <div>Actions</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const notificationGroup = screen.getByRole("group", {
      name: "Notifications and actions",
    });
    expect(
      within(notificationGroup).getByRole("button", {
        name: "Needs you: 2 unresolved",
      }),
    ).toBeTruthy();
  });
});
