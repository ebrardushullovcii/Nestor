// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import {
  getResumeEntryFieldTargetId,
  type ResumeCoverageComparison,
  type ResumeDraft,
} from "@nordri/contracts";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ResumeWorkspaceEditorPanel } from "./resume-workspace-editor-panel";

const draft: ResumeDraft = {
  id: "draft_1",
  jobId: "job_1",
  status: "draft",
  templateId: "classic_ats",
  identity: {
    fullName: "Alex Vanguard",
    headline: "Senior systems designer",
    location: "London, UK",
    email: "alex@example.com",
    phone: "+44 7700 900123",
    portfolioUrl: "https://alex.example.com",
    linkedinUrl: "https://www.linkedin.com/in/alex-vanguard",
    githubUrl: null,
    personalWebsiteUrl: null,
    additionalLinks: [],
  },
  sections: [],
  targetPageCount: 2,
  generationMethod: null,
  approvedAt: null,
  approvedExportId: null,
  staleReason: null,
  workHistoryReviewAcknowledgments: [],
  claimConfirmations: [],
  issueApprovals: [],
  createdAt: "2026-04-26T12:00:00.000Z",
  updatedAt: "2026-04-26T12:00:00.000Z",
};

describe("ResumeWorkspaceEditorPanel", () => {
  const globalScope = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const originalActEnvironment = globalScope.IS_REACT_ACT_ENVIRONMENT;
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const renderPanel = (
    isWorkspacePending: boolean,
    extraProps: Partial<ComponentProps<typeof ResumeWorkspaceEditorPanel>> = {},
  ) => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ResumeWorkspaceEditorPanel
          {...extraProps}
          actionMessage={null}
          coverageComparison={null}
          draft={draft}
          hasUnsavedChanges={false}
          isWorkspacePending={isWorkspacePending}
          jobId="job_1"
          onApplyPatch={vi.fn()}
          onDraftChange={vi.fn()}
          onSectionChange={vi.fn()}
          onSelectEntry={vi.fn()}
          onSelectSection={vi.fn()}
          runWithSavedDraft={(next) => {
            void next();
          }}
          selectedEntryId={null}
          selectedSectionId={null}
          selectedTargetId={null}
          workHistoryAcknowledgments={[]}
          onAcknowledgeWorkHistoryOmission={vi.fn()}
          onRemoveWorkHistoryOmissionAcknowledgment={vi.fn()}
          workHistoryReviewSuggestions={[]}
        />,
      );
    });
  };

  beforeAll(() => {
    globalScope.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    if (originalActEnvironment === undefined) {
      delete globalScope.IS_REACT_ACT_ENVIRONMENT;
      return;
    }

    globalScope.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }

    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  it("keeps structured editing available while template selection lives elsewhere in studio", () => {
    renderPanel(false);

    const scrollRegion = container?.querySelector(
      "[data-resume-editor-scroll-region]",
    );
    const editableControls = Array.from(
      scrollRegion?.querySelectorAll("input, textarea, select, button") ?? [],
    );

    expect(scrollRegion?.textContent).toContain("Edit resume");
    expect(scrollRegion?.textContent).toContain("Resume identity");
    // The subtitle under "Edit resume" only said the heading again, in schema
    // words. The helper line that carries a fact stays.
    expect(scrollRegion?.textContent).not.toContain(
      "Change the schema-safe content behind the preview",
    );
    expect(scrollRegion?.textContent).toContain(
      "Click the live page to jump to the matching structured field.",
    );
    expect(scrollRegion?.textContent).not.toContain("Choose a family");
    expect(scrollRegion?.querySelectorAll('[role="radio"]')).toHaveLength(0);
    expect(editableControls.length).toBeGreaterThan(0);
    for (const control of editableControls) {
      expect(control.hasAttribute("disabled")).toBe(false);
      expect(control.getAttribute("aria-disabled")).not.toBe("true");
    }
  });

  it("exposes structured date controls as preview-edit targets", () => {
    const entrySection = {
      id: "section_experience",
      kind: "experience" as const,
      label: "Experience",
      text: null,
      bullets: [],
      entries: [
        {
          id: "experience_date_target",
          entryType: "experience" as const,
          title: "Systems designer",
          subtitle: "Signal Systems",
          location: null,
          dateRange: "2020-01 – Present",
          startDate: "2020-01",
          endDate: null,
          isCurrent: true,
          summary: null,
          bullets: [],
          origin: "imported" as const,
          locked: false,
          included: true,
          sortOrder: 0,
          profileRecordId: "experience_date_target",
          sourceRefs: [],
          updatedAt: "2026-04-26T12:00:00.000Z",
        },
      ],
      origin: "imported" as const,
      locked: false,
      included: true,
      sortOrder: 0,
      entryOrderMode: "chronology" as const,
      profileRecordId: null,
      sourceRefs: [],
      updatedAt: "2026-04-26T12:00:00.000Z",
    };
    const dateDraft: ResumeDraft = {
      ...draft,
      sections: [entrySection],
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <ResumeWorkspaceEditorPanel
          actionMessage={null}
          coverageComparison={null}
          draft={dateDraft}
          hasUnsavedChanges={false}
          isWorkspacePending={false}
          jobId="job_1"
          onApplyPatch={vi.fn()}
          onDraftChange={vi.fn()}
          onSectionChange={vi.fn()}
          onSelectEntry={vi.fn()}
          onSelectSection={vi.fn()}
          runWithSavedDraft={(next) => {
            void next();
          }}
          selectedEntryId="experience_date_target"
          selectedSectionId="section_experience"
          selectedTargetId={getResumeEntryFieldTargetId(
            "section_experience",
            "experience_date_target",
            "startDate",
          )}
          workHistoryAcknowledgments={[]}
          onAcknowledgeWorkHistoryOmission={vi.fn()}
          onRemoveWorkHistoryOmissionAcknowledgment={vi.fn()}
          workHistoryReviewSuggestions={[]}
        />,
      );
    });

    expect(
      container.querySelector(
        `[data-resume-editor-target="${getResumeEntryFieldTargetId(
          "section_experience",
          "experience_date_target",
          "startDate",
        )}"]`,
      ),
    ).toBeTruthy();
    const titleInput = container.querySelector<HTMLInputElement>(
      `[data-resume-editor-target="${getResumeEntryFieldTargetId(
        "section_experience",
        "experience_date_target",
        "title",
      )}"]`,
    );
    expect(titleInput?.id).toBeTruthy();
    expect(
      container.querySelector(`label[for="${titleInput?.id}"]`)?.textContent,
    ).toBe("Title");
    expect(container.querySelector("label label")).toBeNull();
    expect(
      container.querySelector(
        `[data-resume-editor-target="${getResumeEntryFieldTargetId(
          "section_experience",
          "experience_date_target",
          "endDate",
        )}"]`,
      ),
    ).toBeTruthy();
    expect(
      container.querySelector(
        `[data-resume-editor-target="${getResumeEntryFieldTargetId(
          "section_experience",
          "experience_date_target",
          "isCurrent",
        )}"]`,
      ),
    ).toBeTruthy();
  });

  it("shows on the card itself that an entry is hidden", () => {
    // The panel reported that "Show entry" did nothing: a hidden entry was
    // drawn exactly like a kept one, so the only thing the toggle changed was
    // the button's own label.
    const hiddenEntryDraft: ResumeDraft = {
      ...draft,
      sections: [
        {
          id: "section_experience",
          kind: "experience",
          label: "Experience",
          text: null,
          bullets: [],
          entries: [
            {
              id: "experience_hidden",
              entryType: "experience",
              title: "Systems designer",
              subtitle: "Signal Systems",
              location: null,
              dateRange: "2020-01 - Present",
              startDate: "2020-01",
              endDate: null,
              isCurrent: true,
              summary: null,
              bullets: [],
              origin: "imported",
              locked: false,
              included: false,
              sortOrder: 0,
              profileRecordId: "experience_hidden",
              sourceRefs: [],
              updatedAt: "2026-04-26T12:00:00.000Z",
            },
          ],
          origin: "imported",
          locked: false,
          included: true,
          sortOrder: 0,
          entryOrderMode: "chronology",
          profileRecordId: null,
          sourceRefs: [],
          updatedAt: "2026-04-26T12:00:00.000Z",
        },
      ],
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <ResumeWorkspaceEditorPanel
          actionMessage={null}
          coverageComparison={null}
          draft={hiddenEntryDraft}
          hasUnsavedChanges={false}
          isWorkspacePending={false}
          jobId="job_1"
          onApplyPatch={vi.fn()}
          onDraftChange={vi.fn()}
          onSectionChange={vi.fn()}
          onSelectEntry={vi.fn()}
          onSelectSection={vi.fn()}
          runWithSavedDraft={(next) => {
            void next();
          }}
          selectedEntryId="experience_hidden"
          selectedSectionId="section_experience"
          selectedTargetId={null}
          workHistoryAcknowledgments={[]}
          onAcknowledgeWorkHistoryOmission={vi.fn()}
          onRemoveWorkHistoryOmissionAcknowledgment={vi.fn()}
          workHistoryReviewSuggestions={[]}
        />,
      );
    });

    const card = container?.querySelector(
      '[data-resume-editor-entry="experience_hidden"]',
    );
    expect(card?.getAttribute("data-resume-editor-entry-hidden")).toBe("true");
    expect(
      card?.querySelector("[data-resume-editor-entry-hidden-note]")
        ?.textContent,
    ).toBe(
      "Hidden — this entry stays in your draft but is left off the resume.",
    );
    expect(
      card?.querySelector('[aria-label="Show Systems designer"]'),
    ).toBeTruthy();
  });

  it("leads each entry with one action and keeps the rest revealed by hover or focus", () => {
    // Four equal buttons on every entry line was the densest thing in the
    // editor. Hide/Show leads; Lock and the two reorder controls recede — but
    // they stay mounted, enabled and in the tab order, so a keyboard user
    // reaches them and focus inside the group paints them.
    const entryDraft: ResumeDraft = {
      ...draft,
      sections: [
        {
          id: "section_experience",
          kind: "experience",
          label: "Experience",
          text: null,
          bullets: [],
          entries: [
            {
              id: "experience_first",
              entryType: "experience",
              title: "Systems designer",
              subtitle: "Signal Systems",
              location: null,
              dateRange: "2020-01 - Present",
              startDate: "2020-01",
              endDate: null,
              isCurrent: true,
              summary: null,
              bullets: [],
              origin: "imported",
              locked: false,
              included: true,
              sortOrder: 0,
              profileRecordId: "experience_first",
              sourceRefs: [],
              updatedAt: "2026-04-26T12:00:00.000Z",
            },
            {
              id: "experience_second",
              entryType: "experience",
              title: "Platform engineer",
              subtitle: "Northwind",
              location: null,
              dateRange: "2016-01 - 2019-12",
              startDate: "2016-01",
              endDate: "2019-12",
              isCurrent: false,
              summary: null,
              bullets: [],
              origin: "imported",
              locked: false,
              included: true,
              sortOrder: 1,
              profileRecordId: "experience_second",
              sourceRefs: [],
              updatedAt: "2026-04-26T12:00:00.000Z",
            },
          ],
          origin: "imported",
          locked: false,
          included: true,
          sortOrder: 0,
          entryOrderMode: "chronology",
          profileRecordId: null,
          sourceRefs: [],
          updatedAt: "2026-04-26T12:00:00.000Z",
        },
      ],
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <ResumeWorkspaceEditorPanel
          actionMessage={null}
          coverageComparison={null}
          draft={entryDraft}
          hasUnsavedChanges={false}
          isWorkspacePending={false}
          jobId="job_1"
          onApplyPatch={vi.fn()}
          onDraftChange={vi.fn()}
          onSectionChange={vi.fn()}
          onSelectEntry={vi.fn()}
          onSelectSection={vi.fn()}
          runWithSavedDraft={(next) => {
            void next();
          }}
          selectedEntryId={null}
          selectedSectionId={null}
          selectedTargetId={null}
          workHistoryAcknowledgments={[]}
          onAcknowledgeWorkHistoryOmission={vi.fn()}
          onRemoveWorkHistoryOmissionAcknowledgment={vi.fn()}
          workHistoryReviewSuggestions={[]}
        />,
      );
    });

    const card = container?.querySelector(
      '[data-resume-editor-entry="experience_second"]',
    );
    const secondaryActions = card?.querySelector(
      "[data-resume-editor-entry-secondary-actions]",
    );

    // The one action that leads the line is outside the recessed group.
    const primaryAction = card?.querySelector(
      '[aria-label="Hide Platform engineer"]',
    );
    expect(primaryAction).toBeTruthy();
    expect(secondaryActions?.contains(primaryAction ?? null)).toBe(false);

    // Every other action is still there, still enabled, inside the group.
    const secondaryButtons = Array.from(
      secondaryActions?.querySelectorAll("button") ?? [],
    );
    expect(secondaryButtons).toHaveLength(3);
    expect(
      secondaryButtons.map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      null,
      "Move Platform engineer up",
      "Move Platform engineer down",
    ]);
    expect(secondaryActions?.textContent).toContain("Lock");
    // Lock and "move up" are available on this entry; only "move down" is
    // disabled, because it is the last entry in the section.
    expect(secondaryButtons[0]?.hasAttribute("disabled")).toBe(false);
    expect(secondaryButtons[1]?.hasAttribute("disabled")).toBe(false);

    // Hover and focus both paint the group, so it is never mouse-only.
    expect(secondaryActions?.className).toContain("group-hover:opacity-100");
    expect(secondaryActions?.className).toContain(
      "group-focus-within:opacity-100",
    );
    expect(secondaryActions?.className).toContain("focus-within:opacity-100");
    expect(card?.className).toContain("group");
  });

  it("disables structured editing controls while workspace work is pending", () => {
    renderPanel(true);

    const scrollRegion = container?.querySelector(
      "[data-resume-editor-scroll-region]",
    );
    const editableControls = Array.from(
      scrollRegion?.querySelectorAll("input, textarea, select, button") ?? [],
    );

    expect(editableControls.length).toBeGreaterThan(0);
    for (const control of editableControls) {
      expect(control.hasAttribute("disabled")).toBe(true);
    }
  });

  it("keeps entry movement enabled for locked entries because locks protect content edits only", () => {
    const lockedEntryDraft: ResumeDraft = {
      ...draft,
      sections: [
        {
          id: "section_experience",
          kind: "experience",
          label: "Experience",
          text: null,
          bullets: [],
          entries: [
            {
              id: "experience_locked",
              entryType: "experience",
              title: "Locked role",
              subtitle: "Signal Systems",
              location: null,
              dateRange: "2023 – Present",
              startDate: "2023",
              endDate: null,
              isCurrent: true,
              summary: "Locked content.",
              bullets: [],
              origin: "user_edited",
              locked: true,
              included: true,
              sortOrder: 0,
              profileRecordId: "experience_locked",
              sourceRefs: [],
              updatedAt: draft.updatedAt,
            },
            {
              id: "experience_editable",
              entryType: "experience",
              title: "Editable role",
              subtitle: "Northwind Labs",
              location: null,
              dateRange: "2021 – 2022",
              startDate: "2021",
              endDate: "2022",
              isCurrent: false,
              summary: "Editable content.",
              bullets: [],
              origin: "user_edited",
              locked: false,
              included: true,
              sortOrder: 1,
              profileRecordId: "experience_editable",
              sourceRefs: [],
              updatedAt: draft.updatedAt,
            },
          ],
          origin: "user_edited",
          locked: false,
          included: true,
          sortOrder: 1,
          entryOrderMode: "chronology",
          profileRecordId: null,
          sourceRefs: [],
          updatedAt: draft.updatedAt,
        },
      ],
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ResumeWorkspaceEditorPanel
          actionMessage={null}
          coverageComparison={null}
          draft={lockedEntryDraft}
          hasUnsavedChanges={false}
          isWorkspacePending={false}
          jobId="job_1"
          onApplyPatch={vi.fn()}
          onDraftChange={vi.fn()}
          onSectionChange={vi.fn()}
          onSelectEntry={vi.fn()}
          onSelectSection={vi.fn()}
          runWithSavedDraft={(next) => {
            void next();
          }}
          selectedEntryId={null}
          selectedSectionId={null}
          selectedTargetId={null}
          workHistoryAcknowledgments={[]}
          onAcknowledgeWorkHistoryOmission={vi.fn()}
          onRemoveWorkHistoryOmissionAcknowledgment={vi.fn()}
          workHistoryReviewSuggestions={[]}
        />,
      );
    });

    const lockedTitleInput = Array.from(
      container.querySelectorAll("input"),
    ).find((input) => input.id.includes("entry_title_experience_locked"));
    const moveDownButton = Array.from(
      container.querySelectorAll("button"),
    ).find(
      (button) => button.getAttribute("aria-label") === "Move Locked role down",
    );

    expect(lockedTitleInput?.value).toBe("Locked role");
    expect(lockedTitleInput?.disabled).toBe(true);
    expect(moveDownButton?.disabled).toBe(false);
  });

  it("lets the user restore original role content from the coverage comparison", () => {
    const comparison: ResumeCoverageComparison = {
      originalRoleCount: 1,
      representedRoleCount: 1,
      visibleRoleCount: 1,
      rewrittenRoleCount: 1,
      compactedRoleCount: 0,
      hiddenRoleCount: 0,
      missingRoleCount: 0,
      reorderedRoleCount: 0,
      addedClaimCount: 1,
      removedClaimCount: 1,
      duplicateIssueCount: 0,
      addedKeywords: ["TypeScript"],
      removedKeywords: [],
      pageImpact: "within_target",
      pageCount: 1,
      targetPageCount: 2,
      roles: [
        {
          profileRecordId: "experience_1",
          title: "Software Engineer",
          employer: "Signal Systems",
          sectionId: "section_experience",
          entryId: "experience_1",
          status: "rewritten",
          included: true,
          reordered: false,
          originalIndex: 0,
          tailoredIndex: 0,
          originalClaimCount: 1,
          retainedClaimCount: 0,
          addedClaims: [
            {
              field: "summary",
              text: "Reworded summary.",
              restorable: false,
            },
          ],
          removedClaims: [
            {
              field: "summary",
              text: "Original summary.",
              restorable: true,
            },
          ],
          reasons: ["The summary was rewritten for this role."],
        },
      ],
    };
    const onApplyPatch = vi.fn();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <ResumeWorkspaceEditorPanel
          actionMessage={null}
          coverageComparison={comparison}
          draft={draft}
          hasUnsavedChanges={false}
          isWorkspacePending={false}
          jobId="job_1"
          onApplyPatch={onApplyPatch}
          onDraftChange={vi.fn()}
          onSectionChange={vi.fn()}
          onSelectEntry={vi.fn()}
          onSelectSection={vi.fn()}
          runWithSavedDraft={(next) => {
            void next();
          }}
          selectedEntryId={null}
          selectedSectionId={null}
          selectedTargetId={null}
          workHistoryAcknowledgments={[]}
          onAcknowledgeWorkHistoryOmission={vi.fn()}
          onRemoveWorkHistoryOmissionAcknowledgment={vi.fn()}
          workHistoryReviewSuggestions={[]}
        />,
      );
    });

    const restoreButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Restore",
    );
    expect(container.textContent).toContain("Original vs tailored");
    expect(restoreButton).toBeTruthy();

    act(() => {
      restoreButton?.click();
    });

    expect(onApplyPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "replace_entry_summary",
        targetSectionId: "section_experience",
        targetEntryId: "experience_1",
        newText: "Original summary.",
      }),
      "Restored original summary for Software Engineer.",
    );
  });

  it("targets the hidden role so the patch restores both it and its parent section", () => {
    const hiddenDraft: ResumeDraft = {
      ...draft,
      sections: [
        {
          id: "section_experience",
          kind: "experience",
          label: "Experience",
          text: null,
          bullets: [],
          entries: [
            {
              id: "experience_1",
              entryType: "experience",
              title: "Software Engineer",
              subtitle: "Signal Systems",
              location: "Remote",
              dateRange: "2020 - Present",
              startDate: "2020",
              endDate: null,
              isCurrent: true,
              summary: "Original summary.",
              bullets: [],
              origin: "imported",
              locked: false,
              included: true,
              sortOrder: 0,
              profileRecordId: "experience_1",
              sourceRefs: [],
              updatedAt: draft.updatedAt,
            },
          ],
          origin: "imported",
          locked: false,
          included: false,
          sortOrder: 0,
          entryOrderMode: "chronology",
          profileRecordId: null,
          sourceRefs: [],
          updatedAt: draft.updatedAt,
        },
      ],
    };
    const comparison: ResumeCoverageComparison = {
      originalRoleCount: 1,
      representedRoleCount: 1,
      visibleRoleCount: 0,
      rewrittenRoleCount: 0,
      compactedRoleCount: 0,
      hiddenRoleCount: 1,
      missingRoleCount: 0,
      reorderedRoleCount: 0,
      addedClaimCount: 0,
      removedClaimCount: 1,
      duplicateIssueCount: 0,
      addedKeywords: [],
      removedKeywords: [],
      pageImpact: "unknown",
      pageCount: null,
      targetPageCount: 2,
      roles: [
        {
          profileRecordId: "experience_1",
          title: "Software Engineer",
          employer: "Signal Systems",
          sectionId: "section_experience",
          entryId: "experience_1",
          status: "hidden",
          included: false,
          reordered: false,
          originalIndex: 0,
          tailoredIndex: 0,
          originalClaimCount: 1,
          retainedClaimCount: 0,
          addedClaims: [],
          removedClaims: [
            {
              field: "summary",
              text: "Original summary.",
              restorable: false,
            },
          ],
          reasons: ["The experience section is hidden."],
        },
      ],
    };
    const onApplyPatch = vi.fn();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <ResumeWorkspaceEditorPanel
          actionMessage={null}
          coverageComparison={comparison}
          draft={hiddenDraft}
          hasUnsavedChanges={false}
          isWorkspacePending={false}
          jobId="job_1"
          onApplyPatch={onApplyPatch}
          onDraftChange={vi.fn()}
          onSectionChange={vi.fn()}
          onSelectEntry={vi.fn()}
          onSelectSection={vi.fn()}
          runWithSavedDraft={(next) => {
            void next();
          }}
          selectedEntryId={null}
          selectedSectionId={null}
          selectedTargetId={null}
          workHistoryAcknowledgments={[]}
          onAcknowledgeWorkHistoryOmission={vi.fn()}
          onRemoveWorkHistoryOmissionAcknowledgment={vi.fn()}
          workHistoryReviewSuggestions={[]}
        />,
      );
    });

    const showRoleButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Show role"));
    act(() => {
      showRoleButton?.click();
    });

    expect(onApplyPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "toggle_include",
        targetSectionId: "section_experience",
        targetEntryId: "experience_1",
        newIncluded: true,
      }),
      "Restored Software Engineer to the resume.",
    );
  });

  it("renders actionable work-history and identity editing before coverage details", () => {
    const comparison: ResumeCoverageComparison = {
      originalRoleCount: 1,
      representedRoleCount: 1,
      visibleRoleCount: 0,
      rewrittenRoleCount: 0,
      compactedRoleCount: 0,
      hiddenRoleCount: 1,
      missingRoleCount: 0,
      reorderedRoleCount: 0,
      addedClaimCount: 0,
      removedClaimCount: 0,
      duplicateIssueCount: 0,
      addedKeywords: [],
      removedKeywords: [],
      pageImpact: "unknown",
      pageCount: null,
      targetPageCount: 2,
      roles: [],
    };
    const suggestion = {
      id: "work_history_review_experience_1",
      profileRecordId: "experience_1",
      sectionId: "section_experience",
      entryId: null,
      kind: "weak_fit" as const,
      action: "consider_showing" as const,
      severity: "info" as const,
      message: "Hidden by default for review.",
      messageContentHash: "fnv1a32:b9eb28c6",
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <ResumeWorkspaceEditorPanel
          actionMessage={null}
          coverageComparison={comparison}
          draft={draft}
          hasUnsavedChanges={false}
          isWorkspacePending={false}
          jobId="job_1"
          onAcknowledgeWorkHistoryOmission={vi.fn()}
          onApplyPatch={vi.fn()}
          onDraftChange={vi.fn()}
          onRemoveWorkHistoryOmissionAcknowledgment={vi.fn()}
          onSectionChange={vi.fn()}
          onSelectEntry={vi.fn()}
          onSelectSection={vi.fn()}
          runWithSavedDraft={(next) => {
            void next();
          }}
          selectedEntryId={null}
          selectedSectionId={null}
          selectedTargetId={null}
          workHistoryAcknowledgments={[]}
          workHistoryReviewSuggestions={[suggestion]}
        />,
      );
    });

    const scrollRegion = container.querySelector(
      "[data-resume-editor-scroll-region]",
    );
    const coverageDetails = scrollRegion?.querySelector(
      "[data-resume-coverage-comparison]",
    );
    const decisionsSection = scrollRegion?.querySelector(
      "[data-resume-work-history-decisions]",
    );
    const identityHeading = Array.from(
      scrollRegion?.querySelectorAll("h3") ?? [],
    ).find((heading) => heading.textContent === "Resume identity");

    expect(coverageDetails).toBeTruthy();
    expect(decisionsSection).toBeTruthy();
    expect(identityHeading).toBeTruthy();
    if (!coverageDetails || !decisionsSection || !identityHeading) {
      throw new Error("Expected structured editor sections to render.");
    }

    expect(
      decisionsSection.compareDocumentPosition(identityHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      identityHeading.compareDocumentPosition(coverageDetails) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    expect(decisionsSection.className).toContain("grid-cols-1");
    expect(decisionsSection.className).toContain("min-w-0");
    expect(decisionsSection.className).not.toMatch(/w-\[\d+px\]/);
  });

  it("always discloses AI assistance while reserving line markers for aggressive tailoring", () => {
    const generatedDraft: ResumeDraft = {
      ...draft,
      generationMethod: "ai",
      sections: [
        {
          id: "section_summary",
          kind: "summary",
          label: "Summary",
          text: null,
          bullets: [
            {
              id: "bullet_generated",
              text: "Generated a measurable delivery metric line.",
              origin: "ai_generated",
              locked: false,
              included: true,
              sourceRefs: [],
              lastGeneratedContentHash: null,
              updatedAt: draft.updatedAt,
            },
          ],
          entries: [],
          origin: "ai_generated",
          locked: false,
          included: true,
          sortOrder: 0,
          entryOrderMode: "chronology",
          profileRecordId: null,
          sourceRefs: [],
          updatedAt: draft.updatedAt,
        },
      ],
    };

    const renderWithMarkers = (showMarkers: boolean) => {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      act(() => {
        root?.render(
          <ResumeWorkspaceEditorPanel
            actionMessage={null}
            coverageComparison={null}
            draft={generatedDraft}
            hasUnsavedChanges={false}
            isWorkspacePending={false}
            jobId="job_1"
            onApplyPatch={vi.fn()}
            onDraftChange={vi.fn()}
            onSectionChange={vi.fn()}
            onSelectEntry={vi.fn()}
            onSelectSection={vi.fn()}
            runWithSavedDraft={(next) => {
              void next();
            }}
            selectedEntryId={null}
            selectedSectionId={null}
            selectedTargetId={null}
            showGeneratedLineMarkers={showMarkers}
            workHistoryAcknowledgments={[]}
            onAcknowledgeWorkHistoryOmission={vi.fn()}
            onRemoveWorkHistoryOmissionAcknowledgment={vi.fn()}
            workHistoryReviewSuggestions={[]}
          />,
        );
      });
    };

    renderWithMarkers(false);
    const hiddenContainer = container as HTMLDivElement;
    expect(
      hiddenContainer.querySelector("[data-resume-inference-disclosure]"),
    ).toBeNull();
    expect(
      hiddenContainer.querySelector("[data-resume-ai-assistance-disclosure]")
        ?.textContent,
    ).toContain("created with AI assistance");
    expect(hiddenContainer.textContent).not.toContain("Aggressive tailoring");
    act(() => {
      root?.unmount();
    });

    renderWithMarkers(true);
    const markedContainer = container as HTMLDivElement;
    const disclosure = markedContainer.querySelector(
      "[data-resume-inference-disclosure]",
    );
    expect(disclosure?.textContent).toContain(
      "Aggressive tailoring generated 1 bullet line",
    );
    const details = disclosure?.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe(
      "See generated lines",
    );
    expect(details?.textContent).toContain("Summary");
    expect(details?.textContent).toContain(
      "Generated a measurable delivery metric line.",
    );
    expect(markedContainer.textContent).toContain("AI-generated");
    expect(
      markedContainer.querySelector("[data-resume-ai-assistance-disclosure]")
        ?.textContent,
    ).toContain("created with AI assistance");
  });

  it("explains a failed AI draft and routes the retry to the Assistant", () => {
    const onOpenAssistant = vi.fn();
    renderPanel(false, {
      onOpenAssistant,
      tailoredAssetGeneration: {
        generationMethod: "deterministic",
        generationReason: "provider_failed",
        generationDetail: "HTTP 502 from provider",
        notes: ["Used the built-in deterministic resume tailorer."],
      },
    });

    const disclosure = container?.querySelector(
      "[data-resume-deterministic-fallback-disclosure]",
    );
    expect(disclosure?.textContent).toContain(
      "The first draft came from the built-in generator because the AI draft failed (HTTP 502 from provider).",
    );
    const retryButton = container?.querySelector<HTMLButtonElement>(
      "[data-resume-open-assistant]",
    );
    expect(retryButton?.textContent).toBe("Ask the Assistant");

    act(() => {
      retryButton?.click();
    });

    expect(onOpenAssistant).toHaveBeenCalledTimes(1);
  });

  it("merges draft origin and applied assistant edits into one statement", () => {
    // The studio used to stack "1 AI edit applied" directly above "the AI
    // model returned no usable rewrite proposals", which reads as a
    // contradiction. One statement now separates who wrote the first draft
    // from what the user accepted afterwards.
    renderPanel(false, {
      acceptedAssistantEdits: {
        changedTargetIds: ["section_summary"],
        count: 1,
        label: "1 AI edit applied",
      },
      onOpenAssistant: vi.fn(),
      tailoredAssetGeneration: {
        generationMethod: "deterministic",
        generationReason: "provider_output_unverified",
        generationDetail:
          "AI could not produce usable rewrite suggestions this time",
        notes: [],
      },
      undoAiEditAction: <button type="button">Undo</button>,
    });

    const provenanceNotes = container?.querySelectorAll(
      "[data-resume-draft-provenance]",
    );
    expect(provenanceNotes?.length).toBe(1);

    const provenance = provenanceNotes?.[0];
    expect(provenance?.textContent).toContain(
      "AI could not produce usable rewrite suggestions this time. The first draft came from the built-in generator instead.",
    );
    expect(provenance?.textContent).toContain(
      "1 assistant edit has been applied since",
    );
    expect(provenance?.textContent).not.toContain("1 AI edit applied");
    // Both facts live on the same node, so a reader never sees them as two
    // competing claims.
    expect(
      provenance?.hasAttribute("data-resume-deterministic-fallback-disclosure"),
    ).toBe(true);
    expect(provenance?.hasAttribute("data-resume-applied-ai-edits")).toBe(true);
    expect(provenance?.textContent).toContain("Undo");
  });

  it("keeps the applied-edit statement alone when the model wrote the first draft", () => {
    renderPanel(false, {
      acceptedAssistantEdits: {
        changedTargetIds: ["section_summary"],
        count: 2,
        label: "2 AI edits applied",
      },
      tailoredAssetGeneration: {
        generationMethod: "ai_assisted",
        generationReason: null,
        generationDetail: null,
        notes: [],
      },
    });

    const provenance = container?.querySelector(
      "[data-resume-draft-provenance]",
    );
    expect(provenance?.textContent).toContain("2 AI edits applied");
    expect(provenance?.textContent).not.toContain("built-in generator");
    expect(
      provenance?.hasAttribute("data-resume-deterministic-fallback-disclosure"),
    ).toBe(false);
  });

  it("offers the AI retry when AI was unavailable, without blaming setup", () => {
    renderPanel(false, {
      onOpenAssistant: vi.fn(),
      tailoredAssetGeneration: {
        generationMethod: "deterministic",
        generationReason: "no_provider_configured",
        generationDetail: null,
        notes: ["Used the built-in deterministic resume tailorer."],
      },
    });

    expect(
      container?.querySelector(
        "[data-resume-deterministic-fallback-disclosure]",
      )?.textContent,
    ).toContain(
      "The first draft came from the built-in generator because AI writing is not available right now.",
    );
    // AI ships with the product, so its absence is an outage: retryable, and
    // never described as something the user failed to configure.
    expect(
      container?.querySelector("[data-resume-open-assistant]"),
    ).toBeTruthy();
  });
});
