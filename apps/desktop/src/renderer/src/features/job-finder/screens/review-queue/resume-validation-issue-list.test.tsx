// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResumeValidationIssue } from "@nestor/contracts";
import {
  buildResumeValidationAiPrompt,
  countBlockingResumeValidationIssues,
  getResumeValidationIssueActionLabel,
  getResumeValidationIssueTargetId,
  hasResumeValidationIssueEditorDestination,
  isResumeValidationIssueAiPatchSupported,
  orderResumeValidationIssues,
  ResumeValidationIssueList,
} from "./resume-validation-issue-list";

const errorIssue: ResumeValidationIssue = {
  id: "issue_error",
  severity: "error",
  category: "invented_metric",
  sectionId: "section_experience",
  entryId: "entry_1",
  bulletId: null,
  message: "Metric not grounded in evidence.",
};

const warningIssue: ResumeValidationIssue = {
  id: "issue_warning",
  severity: "warning",
  category: "thin_output",
  sectionId: null,
  entryId: null,
  bulletId: null,
  message: "Output reads thin.",
};

const entryBulletIssue: ResumeValidationIssue = {
  ...errorIssue,
  id: "issue_bullet",
  category: "duplicate_bullet",
  bulletId: "bullet_9",
  message: "This bullet duplicates another line.",
};

const dateIssue: ResumeValidationIssue = {
  ...errorIssue,
  id: "issue_date_reversed",
  severity: "warning",
  category: "date_quality",
  bulletId: null,
  message: "This entry's end date appears earlier than its start date.",
};

const currentDateIssue: ResumeValidationIssue = {
  ...dateIssue,
  id: "issue_date_current",
  message: "Multiple entries are marked current.",
};

const identityIssue: ResumeValidationIssue = {
  ...warningIssue,
  id: "issue_identity",
  severity: "error",
  category: "identity_mismatch",
  message: "The imported resume email conflicts with the visible email.",
};

const workHistoryReviewIssue: ResumeValidationIssue = {
  ...warningIssue,
  id: "issue_work_history_review",
  category: "work_history_review",
  message: "A canonical work-history role is hidden from the visible resume.",
};

describe("resume validation issue helpers", () => {
  it("orders errors ahead of warnings and info without losing input order", () => {
    const infoIssue: ResumeValidationIssue = {
      ...warningIssue,
      id: "issue_info",
      severity: "info",
    };
    const ordered = orderResumeValidationIssues([
      warningIssue,
      infoIssue,
      errorIssue,
    ]);

    expect(ordered.map((issue) => issue.id)).toEqual([
      "issue_error",
      "issue_warning",
      "issue_info",
    ]);
  });

  it("maps issues onto exact editor targets and skips untargetable rows", () => {
    expect(
      getResumeValidationIssueTargetId({
        sectionId: "section_experience",
        entryId: "entry_1",
        bulletId: "bullet_9",
      }),
    ).toBe("entry:section_experience:entry_1:bullet:bullet_9");
    expect(
      getResumeValidationIssueTargetId({
        sectionId: "section_summary",
        entryId: null,
        bulletId: "bullet_2",
      }),
    ).toBe("section:section_summary:bullet:bullet_2");
    expect(getResumeValidationIssueTargetId(errorIssue)).toBe(
      "entry:section_experience:entry_1:summary",
    );
    expect(
      getResumeValidationIssueTargetId({
        sectionId: "section_skills",
        entryId: null,
        bulletId: null,
      }),
    ).toBe("section:section_skills:text");
    expect(getResumeValidationIssueTargetId(warningIssue)).toBeNull();
    expect(getResumeValidationIssueTargetId(dateIssue)).toBe(
      "entry:section_experience:entry_1:endDate",
    );
    expect(getResumeValidationIssueTargetId(currentDateIssue)).toBe(
      "entry:section_experience:entry_1:isCurrent",
    );
    expect(getResumeValidationIssueTargetId(identityIssue)).toBe(
      "identity:email",
    );
    expect(
      hasResumeValidationIssueEditorDestination(workHistoryReviewIssue),
    ).toBe(true);
    expect(hasResumeValidationIssueEditorDestination(warningIssue)).toBe(false);
    expect(
      countBlockingResumeValidationIssues([errorIssue, warningIssue]),
    ).toBe(1);
  });

  it("only marks patch-schema text targets as AI-supported", () => {
    expect(isResumeValidationIssueAiPatchSupported(errorIssue)).toBe(true);
    expect(isResumeValidationIssueAiPatchSupported(entryBulletIssue)).toBe(
      true,
    );
    expect(isResumeValidationIssueAiPatchSupported(dateIssue)).toBe(false);
    expect(isResumeValidationIssueAiPatchSupported(identityIssue)).toBe(false);
    expect(isResumeValidationIssueAiPatchSupported(warningIssue)).toBe(false);

    const prompt = buildResumeValidationAiPrompt(entryBulletIssue);
    expect(prompt).toContain("Issue category: duplicate_bullet.");
    expect(prompt).toContain(entryBulletIssue.message);
    expect(prompt).toContain(
      "entry:section_experience:entry_1:bullet:bullet_9",
    );
    expect(prompt).toContain("nothing changes until I accept");
  });

  it("returns a clear action label for every validation target family", () => {
    const identityCases: Array<[string, string]> = [
      ["", "Edit name"],
      ["headline", "Edit headline"],
      ["location", "Edit location"],
      ["email", "Edit email"],
      ["phone", "Edit phone"],
      ["LinkedIn", "Edit LinkedIn"],
      ["GitHub", "Edit GitHub"],
      ["portfolio", "Edit portfolio"],
      ["website", "Edit website"],
      ["additional link", "Edit links"],
    ];

    for (const [fieldHint, expectedLabel] of identityCases) {
      expect(
        getResumeValidationIssueActionLabel({
          ...identityIssue,
          message: fieldHint
            ? `The imported resume ${fieldHint} conflicts with the visible value.`
            : "The imported resume identifies a different person.",
        }),
      ).toBe(expectedLabel);
    }

    expect(getResumeValidationIssueActionLabel(dateIssue)).toBe(
      "Edit end date",
    );
    expect(getResumeValidationIssueActionLabel(currentDateIssue)).toBe(
      "Edit current-role status",
    );
    expect(
      getResumeValidationIssueActionLabel({
        ...dateIssue,
        message: "This entry is missing a start date.",
      }),
    ).toBe("Edit start date");
    expect(getResumeValidationIssueActionLabel(errorIssue)).toBe(
      "Edit entry summary",
    );
    expect(getResumeValidationIssueActionLabel(entryBulletIssue)).toBe(
      "Edit bullet",
    );
    expect(
      getResumeValidationIssueActionLabel({
        ...errorIssue,
        id: "issue_section_bullet",
        bulletId: "bullet_2",
        entryId: null,
        message: "Review this section bullet.",
      }),
    ).toBe("Edit bullet");
    expect(
      getResumeValidationIssueActionLabel({
        ...warningIssue,
        sectionId: "section_skills",
        message: "Review this section.",
      }),
    ).toBe("Edit section");
    expect(getResumeValidationIssueActionLabel(workHistoryReviewIssue)).toBe(
      "Review work history",
    );
    expect(getResumeValidationIssueActionLabel(warningIssue)).toBe(
      "Review issue",
    );
  });
});

describe("ResumeValidationIssueList", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders nothing without issues and names blockers when present", () => {
    const { container: emptyContainer } = render(
      <ResumeValidationIssueList issues={[]} onFixIssue={vi.fn()} />,
    );
    expect(emptyContainer.querySelector("section")).toBeNull();

    render(
      <ResumeValidationIssueList
        issues={[errorIssue, warningIssue]}
        onFixIssue={vi.fn()}
      />,
    );

    expect(screen.getByText("Blocks approval")).toBeTruthy();
    expect(screen.getByText("1 approval blocker")).toBeTruthy();
    expect(
      screen.getByText("Fix blockers before approval; notes stay review-only."),
    ).toBeTruthy();
    expect(screen.getByText("Metric not grounded in evidence.")).toBeTruthy();
    expect(
      document.querySelectorAll("[data-resume-validation-issue]"),
    ).toHaveLength(2);
  });

  it("keeps non-blocking suggestions out of the approval path", () => {
    const { container } = render(
      <ResumeValidationIssueList
        issues={[warningIssue]}
        onFixIssue={vi.fn()}
      />,
    );

    expect(container.querySelector("section")).toBeNull();
  });

  it("sends the affected issue to the fix handler", () => {
    const onFixIssue = vi.fn();
    render(
      <ResumeValidationIssueList
        issues={[errorIssue, warningIssue]}
        onFixIssue={onFixIssue}
      />,
    );

    const fixButtons = screen.getAllByRole("button", {
      name: `Edit entry summary: ${errorIssue.message}`,
    });
    expect(fixButtons).toHaveLength(1);
    fireEvent.click(fixButtons[0]!);

    expect(onFixIssue).toHaveBeenCalledWith(errorIssue);
  });

  it("labels work-history review as an editor destination without inventing a field", () => {
    render(
      <ResumeValidationIssueList
        issues={[{ ...workHistoryReviewIssue, severity: "error" }]}
        onFixIssue={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: `Review work history: ${workHistoryReviewIssue.message}`,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/No matching editor field/)).toBeNull();
  });

  it("keeps duplicate visible action labels distinguishable to assistive technology", () => {
    const firstBulletIssue: ResumeValidationIssue = {
      ...entryBulletIssue,
      id: "issue_bullet_first",
      bulletId: "bullet_first",
      message: "First bullet needs stronger evidence.",
    };
    const secondBulletIssue: ResumeValidationIssue = {
      ...entryBulletIssue,
      id: "issue_bullet_second",
      bulletId: "bullet_second",
      message: "Second bullet repeats the same claim.",
    };
    const onFixIssue = vi.fn();

    render(
      <ResumeValidationIssueList
        issues={[firstBulletIssue, secondBulletIssue]}
        onFixIssue={onFixIssue}
      />,
    );

    expect(screen.getAllByText("Edit bullet")).toHaveLength(2);
    expect(
      screen.getByRole("button", {
        name: `Edit bullet: ${firstBulletIssue.message}`,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: `Edit bullet: ${secondBulletIssue.message}`,
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Open editor")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: `Edit bullet: ${secondBulletIssue.message}`,
      }),
    );
    expect(onFixIssue).toHaveBeenCalledWith(secondBulletIssue);
  });

  it("does not turn optional suggestions into a global review task", () => {
    const reviewIssues = Array.from(
      { length: 8 },
      (_, index): ResumeValidationIssue => ({
        ...warningIssue,
        id: `issue_note_${index + 1}`,
        message: `Review note ${index + 1}.`,
      }),
    );

    const { container } = render(
      <ResumeValidationIssueList issues={reviewIssues} onFixIssue={vi.fn()} />,
    );

    expect(container.querySelector("section")).toBeNull();
  });

  it("keeps the blocker and notes disclosure natural-height", () => {
    const reviewIssues = Array.from(
      { length: 8 },
      (_, index): ResumeValidationIssue => ({
        ...warningIssue,
        id: `issue_compact_note_${index + 1}`,
        message: `Compact review note ${index + 1}.`,
      }),
    );

    render(
      <ResumeValidationIssueList
        issues={[errorIssue, ...reviewIssues]}
        onFixIssue={vi.fn()}
      />,
    );

    const validationRegion = document.querySelector<HTMLElement>(
      "[data-resume-validation-issues]",
    );
    const blockerList = document.querySelector<HTMLElement>(
      "[data-resume-validation-blockers]",
    );
    const notes = document.querySelector<HTMLElement>(
      "[data-resume-validation-notes]",
    );
    const notesList = notes?.querySelector<HTMLElement>("ul");

    expect(validationRegion?.className).not.toContain("h-[min(24rem,40vh)]");
    expect(validationRegion?.className).not.toContain(
      "max-h-[min(24rem,40vh)]",
    );
    expect(validationRegion?.className).not.toContain("overflow-hidden");
    expect(validationRegion?.className).not.toContain("overflow-y-auto");
    expect(screen.getByText("Fix before approval")).toBeTruthy();
    expect(screen.getByText(/Other suggestions \(8\)/)).toBeTruthy();
    expect(blockerList?.className).not.toContain("overflow-y-auto");
    expect(notesList?.className).not.toContain("overflow-y-auto");
    expect(notes?.querySelector("summary")).toBeTruthy();
    expect(notes?.hasAttribute("open")).toBe(false);
  });

  it("requests an AI suggestion without invoking manual editing", () => {
    const onAskAiFix = vi.fn();
    const onFixIssue = vi.fn();

    render(
      <ResumeValidationIssueList
        issues={[entryBulletIssue, dateIssue]}
        onAskAiFix={onAskAiFix}
        onFixIssue={onFixIssue}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Ask AI to suggest a fix" }),
    );

    expect(onAskAiFix).toHaveBeenCalledWith(entryBulletIssue);
    expect(onFixIssue).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "AI suggestion requested. Nothing changes until you accept a proposed patch in Guided Edits.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Ask AI to suggest a fix" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: `Edit bullet: ${entryBulletIssue.message}`,
      }),
    ).toBeTruthy();
  });

  it("does not elevate optional AI suggestions into the approval path", () => {
    const reviewBulletIssue: ResumeValidationIssue = {
      ...entryBulletIssue,
      id: "issue_review_bullet",
      severity: "warning",
      message: "This review bullet can be grounded more clearly.",
    };

    const { container } = render(
      <ResumeValidationIssueList
        issues={[reviewBulletIssue]}
        onAskAiFix={vi.fn()}
        onFixIssue={vi.fn()}
      />,
    );

    expect(container.querySelector("section")).toBeNull();
  });

  it("does not advertise AI suggestions without a handler or supported target", () => {
    const { unmount } = render(
      <ResumeValidationIssueList
        issues={[entryBulletIssue]}
        onFixIssue={vi.fn()}
      />,
    );

    expect(
      document.querySelector("[data-resume-validation-ai-availability]"),
    ).toBeNull();
    expect(screen.queryByText(/AI suggestion/)).toBeNull();
    unmount();

    render(
      <ResumeValidationIssueList
        issues={[dateIssue]}
        onAskAiFix={vi.fn()}
        onFixIssue={vi.fn()}
      />,
    );

    expect(
      document.querySelector("[data-resume-validation-ai-availability]"),
    ).toBeNull();
    expect(screen.queryByText(/AI suggestion/)).toBeNull();
  });
});

describe("blocked claim recovery actions", () => {
  afterEach(() => {
    cleanup();
  });

  const liveUngroundedSummary =
    "Senior Software Engineer with 10+ years building secure, scalable healthcare SaaS platforms with C#, .NET, ASP.NET Core, REST APIs, MongoDB, SQL Server, and Azure/AWS. Delivered microservices and EHR-adjacent integrations for scheduling and billing, with resilient third-party integrations, CI/CD, and observability for reliable Agile delivery.";
  const blockedClaimIssue: ResumeValidationIssue = {
    id: "issue_claim_grounding_summary",
    severity: "error",
    category: "unsupported_claim",
    sectionId: "section_summary",
    entryId: null,
    bulletId: null,
    message:
      "Your saved evidence does not back this generated claim. Rewrite it, or approve it as accurate if you can stand behind it.",
    flaggedText: liveUngroundedSummary,
  };

  it("names the flagged sentence and offers a one-click restore beside edit and ask-AI", () => {
    const onRestorePreviousText = vi.fn();
    const renderResult = render(
      <ResumeValidationIssueList
        issues={[blockedClaimIssue]}
        canRestorePreviousText={() => true}
        onAskAiFix={vi.fn()}
        onFixIssue={vi.fn()}
        onRestorePreviousText={onRestorePreviousText}
      />,
    );

    expect(
      renderResult.container.querySelector(
        "[data-resume-validation-flagged-text]",
      )?.textContent,
    ).toContain(liveUngroundedSummary);

    const restore = screen.getByRole("button", {
      name: `Restore previous text: ${blockedClaimIssue.message}`,
    });
    expect(screen.getByRole("button", { name: /^Edit section:/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Ask AI to suggest a fix" }),
    ).toBeTruthy();

    fireEvent.click(restore);
    expect(onRestorePreviousText).toHaveBeenCalledWith(blockedClaimIssue);
  });

  it("hides restore when nothing earlier can be restored", () => {
    render(
      <ResumeValidationIssueList
        issues={[blockedClaimIssue]}
        canRestorePreviousText={() => false}
        onFixIssue={vi.fn()}
        onRestorePreviousText={vi.fn()}
      />,
    );

    expect(screen.queryByText("Restore previous text")).toBeNull();
  });
});
