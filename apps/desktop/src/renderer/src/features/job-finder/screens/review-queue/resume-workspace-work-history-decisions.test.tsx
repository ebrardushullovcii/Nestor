// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  WorkHistoryReviewAcknowledgment,
  WorkHistoryReviewSuggestion,
} from "@nordri/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWorkHistoryReviewAcknowledgmentCommandInput,
  listUnresolvedWorkHistoryOmissionSuggestions,
  matchWorkHistoryOmissionDecisionAcknowledgment,
  ResumeWorkHistoryDecisions,
} from "./resume-workspace-work-history-decisions";

const weakFitSuggestion: WorkHistoryReviewSuggestion = {
  id: "work_history_review_experience_9",
  profileRecordId: "experience_9",
  sectionId: "section_experience",
  entryId: null,
  kind: "weak_fit",
  action: "consider_showing",
  severity: "info",
  message: "Hidden for review: this role has a weaker career-family fit.",
  messageContentHash: "fnv1a32:2fd013c2",
};

const gapCoverageSuggestion: WorkHistoryReviewSuggestion = {
  ...weakFitSuggestion,
  id: "work_history_review_experience_7",
  profileRecordId: "experience_7",
  kind: "gap_coverage",
  message: "Hidden for review: this role could close a priority gap.",
  messageContentHash: "fnv1a32:4b377b82",
};

const compactSuggestion: WorkHistoryReviewSuggestion = {
  ...weakFitSuggestion,
  id: "work_history_review_compact",
  profileRecordId: "experience_5",
  kind: "compact_recommended",
  action: "keep_compact",
  message: "This resume is compact enough as-is.",
  messageContentHash: "fnv1a32:d13046da",
};

const matchingAcknowledgment: WorkHistoryReviewAcknowledgment = {
  id: "work_history_ack_experience_9_1",
  draftId: "draft_1",
  profileRecordId: "experience_9",
  kind: "weak_fit",
  action: "consider_showing",
  messageContentHash: "fnv1a32:2fd013c2",
  reason: "intentional_omission",
  acknowledgedAt: "2026-08-20T10:00:00.000Z",
};

describe("work-history decision helpers", () => {
  const draft = {
    id: "draft_1",
    updatedAt: "2026-08-20T09:00:00.000Z",
    workHistoryReviewAcknowledgments: [matchingAcknowledgment],
  };

  it("matches acknowledgments only on exact identity including hash", () => {
    expect(
      matchWorkHistoryOmissionDecisionAcknowledgment({
        acknowledgments: [matchingAcknowledgment],
        draftId: "draft_1",
        suggestion: weakFitSuggestion,
      })?.id,
    ).toBe("work_history_ack_experience_9_1");
    expect(
      matchWorkHistoryOmissionDecisionAcknowledgment({
        acknowledgments: [matchingAcknowledgment],
        draftId: "draft_2",
        suggestion: weakFitSuggestion,
      }),
    ).toBeNull();
    expect(
      matchWorkHistoryOmissionDecisionAcknowledgment({
        acknowledgments: [matchingAcknowledgment],
        draftId: "draft_1",
        suggestion: {
          ...weakFitSuggestion,
          messageContentHash: "fnv1a32:00000000",
        },
      }),
    ).toBeNull();
  });

  it("lists only unresolved omission suggestions, never compact or date suggestions", () => {
    expect(
      listUnresolvedWorkHistoryOmissionSuggestions({
        acknowledgments: [],
        draftId: "draft_1",
        suggestions: [
          weakFitSuggestion,
          gapCoverageSuggestion,
          compactSuggestion,
        ],
      }).map((suggestion) => suggestion.id),
    ).toEqual([
      "work_history_review_experience_9",
      "work_history_review_experience_7",
    ]);
    expect(
      listUnresolvedWorkHistoryOmissionSuggestions({
        acknowledgments: [matchingAcknowledgment],
        draftId: "draft_1",
        suggestions: [weakFitSuggestion, gapCoverageSuggestion],
      }).map((suggestion) => suggestion.id),
    ).toEqual(["work_history_review_experience_7"]);
  });

  it("builds the acknowledge command from current draft fields and projected suggestions", () => {
    const input = buildWorkHistoryReviewAcknowledgmentCommandInput({
      decision: {
        intent: "acknowledge",
        suggestion: {
          id: weakFitSuggestion.id,
          profileRecordId: weakFitSuggestion.profileRecordId,
          kind: weakFitSuggestion.kind,
          action: weakFitSuggestion.action,
          messageContentHash: weakFitSuggestion.messageContentHash,
        },
      },
      draft: { ...draft, workHistoryReviewAcknowledgments: [] },
      jobId: "job_1",
      suggestions: [weakFitSuggestion],
    });

    expect(input).toEqual({
      intent: "acknowledge",
      jobId: "job_1",
      draftId: "draft_1",
      expectedDraftUpdatedAt: "2026-08-20T09:00:00.000Z",
      suggestionId: "work_history_review_experience_9",
      profileRecordId: "experience_9",
      kind: "weak_fit",
      action: "consider_showing",
      messageContentHash: "fnv1a32:2fd013c2",
      reason: "intentional_omission",
    });
  });

  it("rejects acknowledge commands whose captured identity no longer matches the projection", () => {
    expect(
      buildWorkHistoryReviewAcknowledgmentCommandInput({
        decision: {
          intent: "acknowledge",
          suggestion: {
            ...weakFitSuggestion,
            messageContentHash: "fnv1a32:00000000",
          },
        },
        draft,
        jobId: "job_1",
        suggestions: [weakFitSuggestion],
      }),
    ).toBeNull();
    expect(
      buildWorkHistoryReviewAcknowledgmentCommandInput({
        decision: {
          intent: "acknowledge",
          suggestion: {
            ...weakFitSuggestion,
            kind: "compact_recommended",
            action: "keep_compact",
          },
        },
        draft,
        jobId: "job_1",
        suggestions: [weakFitSuggestion, compactSuggestion],
      }),
    ).toBeNull();
    expect(
      buildWorkHistoryReviewAcknowledgmentCommandInput({
        decision: {
          intent: "acknowledge",
          suggestion: weakFitSuggestion,
        },
        draft,
        jobId: "job_1",
        suggestions: [],
      }),
    ).toBeNull();
  });

  it("builds the remove command only from an acknowledgment on the same draft", () => {
    expect(
      buildWorkHistoryReviewAcknowledgmentCommandInput({
        decision: {
          intent: "remove",
          acknowledgmentId: "work_history_ack_experience_9_1",
        },
        draft,
        jobId: "job_1",
        suggestions: [weakFitSuggestion],
      }),
    ).toEqual({
      intent: "remove",
      jobId: "job_1",
      draftId: "draft_1",
      expectedDraftUpdatedAt: "2026-08-20T09:00:00.000Z",
      acknowledgmentId: "work_history_ack_experience_9_1",
    });
    expect(
      buildWorkHistoryReviewAcknowledgmentCommandInput({
        decision: {
          intent: "remove",
          acknowledgmentId: "work_history_ack_missing",
        },
        draft,
        jobId: "job_1",
        suggestions: [weakFitSuggestion],
      }),
    ).toBeNull();
  });
});

describe("ResumeWorkHistoryDecisions", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing when no role was left off", () => {
    const { container } = render(
      <ResumeWorkHistoryDecisions
        acknowledgments={[]}
        disabled={false}
        draftId="draft_1"
        suggestions={[compactSuggestion]}
        onAcknowledge={vi.fn()}
        onIncludeRole={vi.fn()}
        onRemoveAcknowledgment={vi.fn()}
      />,
    );

    expect(container.querySelector("section")).toBeNull();
  });

  it("lists the roles left off this resume quietly, each with Add back, and asks for no decision", () => {
    const onIncludeRole = vi.fn();
    render(
      <ResumeWorkHistoryDecisions
        acknowledgments={[]}
        disabled={false}
        draftId="draft_1"
        suggestions={[weakFitSuggestion, gapCoverageSuggestion]}
        onAcknowledge={vi.fn()}
        onIncludeRole={onIncludeRole}
        onRemoveAcknowledgment={vi.fn()}
      />,
    );

    expect(screen.getByText("Left off this resume")).toBeTruthy();
    const addBack = screen.getAllByRole("button", { name: /^Add back:/ });
    expect(addBack).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: /Leave this role off/ }),
    ).toBeNull();
    const section = document.querySelector(
      "[data-resume-work-history-decisions]",
    );
    expect(section?.className).not.toContain("warning");

    fireEvent.click(addBack[0]!);
    expect(onIncludeRole).toHaveBeenCalledWith(weakFitSuggestion);
  });

  it("keeps Add back inert while workspace work is pending", () => {
    const onIncludeRole = vi.fn();
    render(
      <ResumeWorkHistoryDecisions
        acknowledgments={[]}
        disabled
        draftId="draft_1"
        suggestions={[weakFitSuggestion]}
        onAcknowledge={vi.fn()}
        onIncludeRole={onIncludeRole}
        onRemoveAcknowledgment={vi.fn()}
      />,
    );

    const addBack = screen.getByRole("button", { name: /^Add back:/ });
    expect(addBack.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(addBack);
    expect(onIncludeRole).not.toHaveBeenCalled();
  });
});
