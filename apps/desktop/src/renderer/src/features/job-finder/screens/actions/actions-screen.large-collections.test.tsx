// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  ApplicationRecordSchema,
  ApplicationAttemptSchema,
  GroupedManualAnswerDecisionSchema,
  UserActionRequestSchema,
  type GroupedManualAnswerDecision,
  type ApplyGroupedManualAnswerInput,
} from "@nestor/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionsScreen } from "./actions-screen";

const now = "2026-10-13T10:00:00.000Z";

function makeLineage(index: number) {
  return {
    requestId: `request_${index}`,
    jobId: `job_${index}`,
    applicationRecordId: `application_${index}`,
    resultId: null,
    questionId: "question_years",
    answerRecordId: null,
    expectedRequestRevision: index + 1,
    expectedQuestionRevision: 1,
    expectedAnswerRevision: 0,
    appliedAt: null,
  };
}

function makeDecision(index = 0): GroupedManualAnswerDecision {
  return GroupedManualAnswerDecisionSchema.parse({
    id: `decision_${index}`,
    groupKey: `group_${index}`,
    requestId: `request_${index}`,
    applicationRecordId: `application_${index}`,
    jobId: `job_${index}`,
    questionId: "question_years",
    expectedRevision: 1,
    expectedQuestionRevision: 1,
    expectedAnswerRevision: 0,
    fingerprints: {
      questionMeaning: "a".repeat(64),
      answerPolicy: "b".repeat(64),
    },
    answer: { type: "text", value: `Reusable answer ${index}` },
    approval: "pending",
    conflict: { status: "none" },
    snooze: null,
    lineage: [makeLineage(index)],
    createdAt: now,
    updatedAt: now,
  });
}

function makeAwaitingRecord(index: number) {
  return ApplicationRecordSchema.parse({
    id: `application_${index}`,
    jobId: `job_${index}`,
    title: `Waiting role ${index}`,
    company: `Company ${index}`,
    status: "ready_for_review",
    lastAttemptState: "paused",
    consentSummary: { status: "requested", pendingCount: 1 },
    lastActionLabel: "Paused on the job site.",
    nextActionLabel: "Finish the sign-in step on the job site.",
    lastUpdatedAt: now,
  });
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Needs you bounded collection behavior", () => {
  const base = {
    discoveryJobs: [],
    isPending: () => false,
    onCommand: vi.fn(),
    onNavigate: vi.fn(),
    requests: [],
  };

  it("preserves an unfinished application answer when its card is paged out and back", async () => {
    const saveDraft = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("nestor", {
      jobFinder: { saveUserActionAnswerDraft: saveDraft },
    });
    const requests = Array.from({ length: 51 }, (_, i) =>
      UserActionRequestSchema.parse({
        id: `answer_request_${i}`,
        revision: 1,
        dedupeKey: `answer_dedupe_${i}`,
        kind: i === 0 ? "manual_answer" : "login",
        state: "pending",
        scope: {
          type: "application",
          runId: "run_answers",
          jobId: `job_${i}`,
          applicationRecordId: `application_${i}`,
          source: "target_site",
        },
        verification: {
          type: "page_blocker_absent",
          blockerFingerprint: "question",
        },
        title: `Answer step ${i}`,
        summary: "Answer the application question.",
        createdAt: now,
        updatedAt: now,
      }),
    );
    const attempt = ApplicationAttemptSchema.parse({
      id: "attempt_0",
      jobId: "job_0",
      applicationRecordId: "application_0",
      state: "paused",
      summary: "Needs an answer",
      detail: "Answer this question",
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      outcome: null,
      nextActionLabel: null,
      questions: [
        { id: "years", prompt: "Years of experience", detectedAt: now },
      ],
      blocker: {
        code: "missing_candidate_answer",
        summary: "Answer this question",
      },
    });
    render(
      <ActionsScreen
        {...base}
        requests={requests}
        applicationAttempts={[attempt]}
      />,
    );
    fireEvent.change(screen.getByLabelText("Years of experience"), {
      target: { value: "7" },
    });
    await waitFor(() => expect(saveDraft).toHaveBeenCalled());
    const pagination = screen.getByRole("navigation", {
      name: "application actions pagination",
    });
    fireEvent.click(
      within(pagination).getByRole("button", { name: "Next page" }),
    );
    expect(screen.queryByLabelText("Years of experience")).toBeNull();
    fireEvent.click(
      within(pagination).getByRole("button", { name: "Previous page" }),
    );
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Years of experience").value,
    ).toBe("7");
  });

  it("walks every awaiting application and navigates a late record by its complete ID", () => {
    const records = Array.from({ length: 123 }, (_, i) =>
      makeAwaitingRecord(i),
    );
    const onNavigate = vi.fn();
    const { container } = render(
      <ActionsScreen
        {...base}
        onNavigate={onNavigate}
        applicationRecords={records}
      />,
    );
    const seen = new Set<string>();
    const pagination = screen.getByRole("navigation", {
      name: "application actions pagination",
    });
    for (;;) {
      const cards = container.querySelectorAll("article");
      expect(cards.length).toBeLessThanOrEqual(50);
      for (const heading of container.querySelectorAll("article h3"))
        seen.add(heading.textContent ?? "");
      const next = within(pagination).getByRole<HTMLButtonElement>("button", {
        name: "Next page",
      });
      if (next.disabled) break;
      fireEvent.click(next);
    }
    expect(seen.size).toBe(123);
    const card = screen.getByText("Waiting role 122").closest("article")!;
    fireEvent.click(
      within(card).getByRole("button", { name: "Open this application" }),
    );
    expect(onNavigate.mock.calls[0]?.[0]).toContain(
      "applicationRecordId=application_122",
    );
  });

  it("searches all awaiting records and reusable answers with full result counts", () => {
    render(
      <ActionsScreen
        {...base}
        applicationRecords={Array.from({ length: 123 }, (_, i) =>
          makeAwaitingRecord(i),
        )}
        groupedDecisions={Array.from({ length: 123 }, (_, i) =>
          makeDecision(i),
        )}
      />,
    );
    expect(screen.getByText("246 results")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Find an action"), {
      target: { value: "application_122" },
    });
    expect(screen.getByText("2 of 246 results")).toBeTruthy();
    expect(screen.getByText("Waiting role 122")).toBeTruthy();
    expect(screen.getByText("Reusable answer 122")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Find an action"), {
      target: { value: "missing record" },
    });
    expect(screen.getByText("0 of 246 results")).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Clear search" })[0]!,
    );
    expect(screen.getByText("246 results")).toBeTruthy();
  });

  it("opens late selections immediately, including a selection that arrives before its records", () => {
    const records = Array.from({ length: 123 }, (_, i) =>
      makeAwaitingRecord(i),
    );
    const decisions = Array.from({ length: 123 }, (_, i) => makeDecision(i));
    const { rerender } = render(
      <ActionsScreen {...base} selectedApplicationRecordId="application_122" />,
    );
    rerender(
      <ActionsScreen
        {...base}
        applicationRecords={records}
        selectedApplicationRecordId="application_122"
        groupedDecisions={decisions}
        selectedDecisionId="decision_122"
      />,
    );
    expect(screen.getByText("Waiting role 122")).toBeTruthy();
    expect(screen.getByText("Reusable answer 122")).toBeTruthy();
    expect(screen.getAllByText("Page 3 of 3")).toHaveLength(2);
    rerender(
      <ActionsScreen
        {...base}
        applicationRecords={records}
        selectedApplicationRecordId="application_55"
        groupedDecisions={decisions}
        selectedDecisionId="decision_55"
      />,
    );
    expect(screen.getByText("Waiting role 55")).toBeTruthy();
    expect(screen.getByText("Reusable answer 55")).toBeTruthy();
  });

  it("opens a selected ordinary source request on its page", () => {
    const requests = Array.from({ length: 123 }, (_, i) =>
      UserActionRequestSchema.parse({
        id: `source_request_${i}`,
        dedupeKey: `source_dedupe_${i}`,
        revision: 1,
        kind: "login",
        state: "pending",
        scope: {
          type: "discovery_source",
          targetId: `source_${i}`,
          source: "target_site",
        },
        verification: {
          type: "source_access",
          targetId: `source_${i}`,
          blockerFingerprint: "login",
          expectedOrigin: "https://source.example.test",
        },
        title: `Source request ${i}`,
        summary: "Sign in on the source site.",
        createdAt: now,
        updatedAt: now,
      }),
    );
    render(
      <ActionsScreen
        {...base}
        requests={requests}
        selectedRequestId="source_request_122"
      />,
    );
    expect(screen.getByText("Source request 122")).toBeTruthy();
    expect(screen.getByText("Page 3 of 3")).toBeTruthy();
  });

  it("pages lineage details without hiding the answer or restricting approval to the page", () => {
    const decision = {
      ...makeDecision(),
      lineage: Array.from({ length: 123 }, (_, i) => makeLineage(i)),
    };
    const onApply = vi.fn<(input: ApplyGroupedManualAnswerInput) => void>();
    const { container } = render(
      <ActionsScreen
        {...base}
        groupedDecisions={[decision]}
        onApplyGroupedManualAnswer={onApply}
      />,
    );
    expect(container.querySelectorAll("article li")).toHaveLength(0);
    expect(screen.getByText("Reusable answer 0")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Show application questions (123)" }),
    );
    const pagination = screen.getByRole("navigation", {
      name: "application questions for decision_0 pagination",
    });
    const seen = new Set<string>();
    for (;;) {
      const items = container.querySelectorAll("article li");
      expect(items.length).toBeLessThanOrEqual(50);
      for (const item of items) seen.add(item.textContent ?? "");
      const next = within(pagination).getByRole<HTMLButtonElement>("button", {
        name: "Next page",
      });
      if (next.disabled) break;
      fireEvent.click(next);
    }
    expect(seen.size).toBe(123);
    expect([...seen].some((text) => text.includes("request_122"))).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Approve & reuse for 123 jobs" }),
    );
    expect(onApply).toHaveBeenCalledTimes(1);
    const input = onApply.mock.calls[0]![0];
    expect(input.requestIds).toEqual(
      decision.lineage.map((entry) => entry.requestId),
    );
    expect(Object.keys(input.expectedRequestRevisions)).toHaveLength(123);
    expect(input.expectedRequestRevisions.request_122).toBe(123);
  });

  it("shrinks a current page to its final valid page after records are removed", async () => {
    const records = Array.from({ length: 123 }, (_, i) =>
      makeAwaitingRecord(i),
    );
    const { rerender } = render(
      <ActionsScreen {...base} applicationRecords={records} />,
    );
    const pagination = screen.getByRole("navigation", {
      name: "application actions pagination",
    });
    fireEvent.click(
      within(pagination).getByRole("button", { name: "Next page" }),
    );
    fireEvent.click(
      within(pagination).getByRole("button", { name: "Next page" }),
    );
    rerender(
      <ActionsScreen {...base} applicationRecords={records.slice(0, 51)} />,
    );
    await waitFor(() => expect(screen.getByText("Page 2 of 2")).toBeTruthy());
    expect(screen.getByText("Waiting role 50")).toBeTruthy();
    rerender(<ActionsScreen {...base} applicationRecords={[records[0]!]} />);
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByText("All application actions shown (1).")).toBeTruthy();
  });
});
