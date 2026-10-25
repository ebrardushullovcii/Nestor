// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockedScreenLayout } from "../../components/locked-screen-layout";
import { ResumeWorkspaceStudioShell } from "./resume-workspace-studio-shell";

describe("ResumeWorkspaceStudioShell", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "matchMedia");
    vi.restoreAllMocks();
  });

  it("takes a template-blocked user directly to the chooser and blocks premature export", () => {
    const onExportPdf = vi.fn();
    const onSetMobileStudioTab = vi.fn();
    const scrollIntoView = vi.fn();

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume={false}
        canClearApproval={false}
        editorPanel={<div>Editor</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={onExportPdf}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={onSetMobileStudioTab}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible={false}
        studioStatusMessage="Choose a template"
        templatePanel={<button type="button">Use this template</button>}
      />,
    );

    expect(
      document.querySelector("[data-resume-workspace-top-actions]"),
    ).toBeTruthy();

    // One toolbar per rendered layout. The compact copy now lives inside the
    // Tools tab (as it always has on desktop), and only the active tab mounts,
    // so with Preview selected the desktop tools column owns the only copy.
    const exportButtons = screen.queryAllByRole("button", {
      name: "Download PDF",
    });
    expect(exportButtons).toHaveLength(1);
    expect(
      exportButtons.every((button) => button.hasAttribute("disabled")),
    ).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Choose an apply-safe template" }),
    );

    expect(onSetMobileStudioTab).toHaveBeenCalledWith("editor");
    expect(onExportPdf).not.toHaveBeenCalled();
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
    expect(
      document.activeElement?.hasAttribute("data-resume-template-chooser"),
    ).toBe(true);
  });

  it("says an Original job's draft is not used and offers one press to an editable draft instead of approval", () => {
    const onWriteEditableResume = vi.fn();

    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume
        canClearApproval={false}
        editorPanel={<div>Editor</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        originalResume={{
          levelLabel: "Tailored",
          onWriteEditableResume,
          filePanel: <div>Actual attachment</div>,
        }}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="Ready"
        templatePanel={<div>Templates</div>}
      />,
    );

    expect(
      document.querySelector("[data-resume-studio-original-notice]")
        ?.textContent,
    ).toContain("This job sends your original file, shown below, unchanged.");
    expect(screen.queryByRole("button", { name: /Approve resume/ })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /Write an editable Tailored resume/ }),
    );
    expect(onWriteEditableResume).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Actual attachment")).toBeTruthy();
    expect(screen.queryByText("Preview", { selector: "div" })).toBeNull();
    expect(screen.queryByText("Templates")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download PDF" })).toBeNull();
  });

  it("keeps saying the editable resume is being written until it is done, never offering approval of the old draft", () => {
    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume
        canClearApproval={false}
        editorPanel={<div>Editor</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        originalResume={{
          levelLabel: "Light",
          writing: true,
          onWriteEditableResume: vi.fn(),
        }}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="Ready"
        templatePanel={<div>Templates</div>}
      />,
    );

    expect(
      document.querySelector("[data-resume-studio-original-notice]")
        ?.textContent,
    ).toContain("Writing an editable Light resume for this job.");
    expect(screen.queryByRole("button", { name: /Approve resume/ })).toBeNull();
  });

  it("uses instant navigation for the template chooser when reduced motion is requested", () => {
    const scrollIntoView = vi.fn();

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume={false}
        canClearApproval={false}
        editorPanel={<div>Editor</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible={false}
        studioStatusMessage="Choose a template"
        templatePanel={<button type="button">Use this template</button>}
      />,
    );

    fireEvent.click(
      screen.getAllByRole("button", {
        name: "Choose an apply-safe template",
      })[0]!,
    );

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "start",
    });
  });

  it("blocks every export entry point and links directly to unsupported claims", () => {
    const onExportPdf = vi.fn();
    const onReviewBlockingIssues = vi.fn();

    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume={false}
        canClearApproval={false}
        editorPanel={<div>Editor</div>}
        exportBlockedReason="2 generated or unsupported claims must be grounded before export."
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={onExportPdf}
        onReviewBlockingIssues={onReviewBlockingIssues}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="Review claims"
        templatePanel={<div>Templates</div>}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "2 generated or unsupported claims",
    );
    const topActions = document.querySelector(
      "[data-resume-workspace-top-actions]",
    );
    if (!topActions) {
      throw new Error("Expected resume workspace top actions");
    }

    expect(
      screen
        .getAllByRole("button", { name: "Download PDF" })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Review blocked claims" }),
    );
    expect(onReviewBlockingIssues).toHaveBeenCalledOnce();
    expect(onExportPdf).not.toHaveBeenCalled();
  });

  it("retains every lifecycle action while dropping decorative status chips", () => {
    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume
        canClearApproval={false}
        editorPanel={<div>Editor</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="Ready to approve."
        templatePanel={<div>Templates</div>}
      />,
    );

    // Preview is the active tab, so the desktop tools column owns the only
    // rendered toolbar; the compact copy mounts with the Tools tab.
    expect(screen.getAllByRole("button", { name: "Save draft" })).toHaveLength(
      1,
    );
    // "Refresh draft" was the same whole-draft AI rewrite as "Retry with AI"
    // under a second name; the studio now has exactly one AI control.
    expect(
      screen.queryAllByRole("button", { name: "Refresh draft" }),
    ).toHaveLength(0);
    expect(
      screen.queryAllByRole("button", { name: "Download PDF" }),
    ).toHaveLength(1);

    const enabledApproveButtons = screen
      .getAllByRole("button", { name: "Approve resume" })
      .filter((button) => !button.hasAttribute("disabled"));
    expect(enabledApproveButtons).toHaveLength(1);

    expect(
      screen
        .getAllByRole("button", { name: "Save draft" })
        .every((button) => button.getAttribute("data-variant") === "secondary"),
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Approve current PDF" }),
    ).toBeNull();

    const primaryButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-variant="primary"]'),
    ).filter((button) => !button.hasAttribute("disabled"));
    expect(primaryButtons).toHaveLength(1);
    expect(primaryButtons[0]!.textContent).toContain("Approve resume");

    expect(screen.queryByText("Preview-led review")).toBeNull();
    expect(screen.queryByText("Approval eligible")).toBeNull();
    expect(screen.queryByText("Approval blocked")).toBeNull();
    expect(screen.queryByText("Saved draft")).toBeNull();
    // Before approval there is no PDF to talk about, so nothing is said.
    expect(document.querySelector("[data-resume-pdf-status]")).toBeNull();
  });

  it("moves clear approval behind its explanation and keeps approval out of the toolbars", () => {
    const onClearApproval = vi.fn();
    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel="Approved"
        canApproveResume={false}
        canClearApproval
        editorPanel={<div>Editor</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={onClearApproval}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="A PDF from this saved draft is already approved."
        templatePanel={<div>Templates</div>}
      />,
    );

    // Exactly one `Clear approval` renders, in the layout that is displayed.
    // On desktop that is the tools column's status row, beside the sentence
    // that explains what clearing approval costs.
    const clearButtons = screen.getAllByRole("button", {
      name: "Clear approval",
    });
    expect(clearButtons).toHaveLength(1);
    for (const button of clearButtons) {
      expect(button.getAttribute("data-variant")).toBe("ghost");
      const statusRow = button.closest("[data-resume-studio-status]");
      expect(statusRow?.textContent).toContain(
        "A PDF from this saved draft is already approved.",
      );
    }

    // After approval the compact band is gone, so the desktop status row is
    // the only one left — and it is the one that announces.
    const liveStatusRows = Array.from(
      document.querySelectorAll('[data-resume-studio-status][role="status"]'),
    );
    expect(liveStatusRows).toHaveLength(1);
    expect(liveStatusRows[0]?.getAttribute("aria-live")).toBe("polite");
    expect(
      document.querySelectorAll("[data-resume-studio-status]"),
    ).toHaveLength(1);

    fireEvent.click(clearButtons[0]!);
    expect(onClearApproval).toHaveBeenCalledOnce();
  });

  it("announces studio status from the compact row only below the desktop breakpoint", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
      })),
    });

    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume={false}
        canClearApproval={false}
        editorPanel={<div>Editor</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible={false}
        studioStatusMessage="Choose a template"
        templatePanel={<div>Templates</div>}
      />,
    );

    // Below the breakpoint the desktop tools column is not mounted at all, so
    // the compact band is the only status row and the one live region. (It
    // used to be one of two rows, with the hidden desktop copy also in the
    // DOM alongside a second preview iframe and a second editor tree.)
    const statusRows = Array.from(
      document.querySelectorAll<HTMLElement>("[data-resume-studio-status]"),
    );
    expect(statusRows).toHaveLength(1);
    const [compactRow] = statusRows;
    expect(compactRow?.getAttribute("role")).toBe("status");
    expect(
      compactRow?.closest("[data-resume-studio-compact-status]"),
    ).toBeTruthy();
    expect(
      document.querySelector("[data-resume-studio-desktop-grid]"),
    ).toBeNull();
  });

  it("announces studio status from the desktop row only above the breakpoint", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: true,
        removeEventListener: vi.fn(),
      })),
    });

    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume={false}
        canClearApproval={false}
        editorPanel={<div>Editor</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible={false}
        studioStatusMessage="Choose a template"
        templatePanel={<div>Templates</div>}
      />,
    );

    // Exactly one row is a live region at either width, so assistive tech
    // never announces the same status twice.
    const liveRows = Array.from(
      document.querySelectorAll<HTMLElement>("[data-resume-studio-status]"),
    ).filter((row) => row.getAttribute("role") === "status");
    expect(liveRows).toHaveLength(1);
    expect(
      liveRows[0]?.closest("[data-resume-studio-desktop-grid]"),
    ).not.toBeNull();
    // The compact tab surface is not mounted here, so only one preview pane
    // and one tools tree exist.
    expect(
      document.querySelectorAll('[data-slot="tabs-trigger"]'),
    ).toHaveLength(0);
  });

  it("never switches tabs when the desktop layout ends, because the Assistant is not a tab", () => {
    // The Assistant used to be a docked desktop column and a compact tab, so
    // narrowing 1440 -> 1200 with it open had to move the tab selection. It is
    // one floating panel now: crossing the breakpoint changes nothing.
    const listeners: Array<() => void> = [];
    let matches = true;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: (_event: string, listener: () => void) => {
          listeners.push(listener);
        },
        get matches() {
          return matches;
        },
        removeEventListener: vi.fn(),
      })),
    });

    const onSetMobileStudioTab = vi.fn();
    const props = {
      approvalBlockedReason: null,
      approvalStateLabel: null,
      canApproveResume: false,
      canClearApproval: false,
      editorPanel: <div>Editor</div>,
      exportBlockedReason: null,
      hasUnsavedChanges: false,
      historyPanel: <div>History</div>,
      isWorkspacePending: false,
      mobileStudioTab: "preview" as const,
      onApproveCurrentPdf: vi.fn(),
      onClearApproval: vi.fn(),
      onContinueToShortlisted: vi.fn(),
      onExportPdf: vi.fn(),
      onReviewBlockingIssues: vi.fn(),
      onSaveDraft: vi.fn(),
      onSetMobileStudioTab,
      previewPane: <div>Preview</div>,
      selectedTemplateApprovalEligible: false,
      studioStatusMessage: "Choose a template",
      templatePanel: <div>Templates</div>,
    };

    const { rerender } = render(<ResumeWorkspaceStudioShell {...props} />);
    expect(onSetMobileStudioTab).not.toHaveBeenCalled();

    act(() => {
      matches = false;
      for (const listener of listeners) {
        listener();
      }
    });
    rerender(<ResumeWorkspaceStudioShell {...props} />);

    expect(onSetMobileStudioTab).not.toHaveBeenCalled();
    expect(screen.queryByRole("tab", { name: "Assistant" })).toBeNull();
  });

  it("leaves the tab alone across the breakpoint when the Assistant is closed", () => {
    const listeners: Array<() => void> = [];
    let matches = true;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: (_event: string, listener: () => void) => {
          listeners.push(listener);
        },
        get matches() {
          return matches;
        },
        removeEventListener: vi.fn(),
      })),
    });

    const onSetMobileStudioTab = vi.fn();
    const props = {
      approvalBlockedReason: null,
      approvalStateLabel: null,
      canApproveResume: false,
      canClearApproval: false,
      editorPanel: <div>Editor</div>,
      exportBlockedReason: null,
      hasUnsavedChanges: false,
      historyPanel: <div>History</div>,
      isWorkspacePending: false,
      mobileStudioTab: "preview" as const,
      onApproveCurrentPdf: vi.fn(),
      onClearApproval: vi.fn(),
      onContinueToShortlisted: vi.fn(),
      onExportPdf: vi.fn(),
      onReviewBlockingIssues: vi.fn(),
      onSaveDraft: vi.fn(),
      onSetMobileStudioTab,
      previewPane: <div>Preview</div>,
      selectedTemplateApprovalEligible: false,
      studioStatusMessage: "Choose a template",
      templatePanel: <div>Templates</div>,
    };

    const { rerender } = render(<ResumeWorkspaceStudioShell {...props} />);
    act(() => {
      matches = false;
      for (const listener of listeners) {
        listener();
      }
    });
    rerender(<ResumeWorkspaceStudioShell {...props} />);

    expect(onSetMobileStudioTab).not.toHaveBeenCalled();
  });

  it("exposes prepare application after the exact PDF is approved", () => {
    const onPrepareApplication = vi.fn();

    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel="Approved"
        canApproveResume={false}
        canClearApproval
        editorPanel={<div>Editor</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onPrepareApplication={onPrepareApplication}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="A PDF from this saved draft is already approved."
        templatePanel={<div>Templates</div>}
      />,
    );

    const prepareButtons = screen.getAllByRole("button", {
      name: "Apply",
    });
    expect(prepareButtons).toHaveLength(1);
    fireEvent.click(prepareButtons[0]!);
    expect(onPrepareApplication).toHaveBeenCalledOnce();
  });

  it("lists named validation issues before export and deep-links into the matching field", () => {
    const onSetMobileStudioTab = vi.fn();
    const onSelectValidationIssue = vi.fn();
    const scrollIntoView = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume={false}
        canClearApproval={false}
        editorPanel={
          <textarea
            data-resume-editor-target="entry:section_experience:entry_1:summary"
            aria-label="Entry summary target"
          />
        }
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSelectValidationIssue={onSelectValidationIssue}
        onSetMobileStudioTab={onSetMobileStudioTab}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="Ready."
        templatePanel={<div>Templates</div>}
        validationIssues={[
          {
            id: "issue_warning_1",
            severity: "warning",
            category: "thin_output",
            sectionId: "section_summary",
            entryId: null,
            bulletId: null,
            message: "The summary reads thin for this seniority.",
          },
          {
            id: "issue_error_1",
            severity: "error",
            category: "invented_metric",
            sectionId: "section_experience",
            entryId: "entry_1",
            bulletId: null,
            message: "Bullet cites a metric that is not in your evidence.",
          },
        ]}
      />,
    );

    const issueRegion = document.querySelector(
      "[data-resume-validation-issues]",
    );
    expect(issueRegion?.textContent).toContain("Fix before approval");
    expect(issueRegion?.textContent).toContain("1 approval blocker");
    expect(issueRegion?.textContent).toContain(
      "Bullet cites a metric that is not in your evidence.",
    );
    const issueRows = document.querySelectorAll(
      "[data-resume-validation-issue]",
    );
    expect(issueRows[0]?.getAttribute("data-resume-validation-issue")).toBe(
      "issue_error_1",
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit entry summary: Bullet cites a metric that is not in your evidence.",
      }),
    );

    expect(onSetMobileStudioTab).toHaveBeenCalledWith("editor");
    expect(onSelectValidationIssue).toHaveBeenCalledWith(
      expect.objectContaining({ id: "issue_error_1" }),
      "entry:section_experience:entry_1:summary",
    );
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(
      document.activeElement?.getAttribute("data-resume-editor-target"),
    ).toBe("entry:section_experience:entry_1:summary");
  });

  it("waits for the editor tab to mount before focusing an exact field", () => {
    const onSetMobileStudioTab = vi.fn();
    const scrollIntoView = vi.fn();
    const frames: Array<(time: number) => void> = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    const shellProps = {
      approvalBlockedReason: null,
      approvalStateLabel: null,
      canApproveResume: false,
      canClearApproval: false,
      editorPanel: (
        <textarea
          aria-label="Entry summary target"
          data-resume-editor-target="entry:section_experience:entry_1:summary"
        />
      ),
      exportBlockedReason: null,
      hasUnsavedChanges: false,
      historyPanel: <div>History</div>,
      isWorkspacePending: false,
      onApproveCurrentPdf: vi.fn(),
      onClearApproval: vi.fn(),
      onContinueToShortlisted: vi.fn(),
      onExportPdf: vi.fn(),
      onRegenerateDraft: vi.fn(),
      onReviewBlockingIssues: vi.fn(),
      onSaveDraft: vi.fn(),
      onSetMobileStudioTab,
      previewPane: <div>Preview</div>,
      selectedTemplateApprovalEligible: true,
      studioStatusMessage: "Ready.",
      templatePanel: <div>Templates</div>,
      validationIssues: [
        {
          id: "issue_mount_exact",
          severity: "error" as const,
          category: "invented_metric" as const,
          sectionId: "section_experience",
          entryId: "entry_1",
          bulletId: null,
          message: "A metric needs review.",
        },
      ],
    };

    const { rerender } = render(
      <ResumeWorkspaceStudioShell {...shellProps} mobileStudioTab="preview" />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit entry summary: A metric needs review.",
      }),
    );
    expect(onSetMobileStudioTab).toHaveBeenCalledWith("editor");
    expect(frames).not.toHaveLength(0);

    rerender(
      <ResumeWorkspaceStudioShell {...shellProps} mobileStudioTab="editor" />,
    );
    act(() => {
      frames.at(-1)?.(0);
    });

    expect(
      document.activeElement?.getAttribute("data-resume-editor-target"),
    ).toBe("entry:section_experience:entry_1:summary");
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(
      screen.getByText("Opened the matching editor field for this issue."),
    ).toBeTruthy();
  });

  it("opens a section card for a section-only issue without claiming an exact field", () => {
    const scrollIntoView = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume
        canClearApproval={false}
        editorPanel={
          <article data-resume-editor-section="section_skills" tabIndex={-1}>
            <textarea data-resume-editor-target="section:section_skills:text" />
          </article>
        }
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="Ready."
        templatePanel={<div>Templates</div>}
        validationIssues={[
          {
            id: "issue_section_only",
            severity: "error",
            category: "empty_section",
            sectionId: "section_skills",
            entryId: null,
            bulletId: null,
            message: "Review the skills section.",
          },
        ]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit section: Review the skills section.",
      }),
    );

    expect(
      document.activeElement?.getAttribute("data-resume-editor-section"),
    ).toBe("section_skills");
    expect(
      screen.getByText("Opened the matching section in the editor."),
    ).toBeTruthy();
    expect(
      screen.queryByText("Opened the matching editor field for this issue."),
    ).toBeNull();
  });

  it("falls back from a disabled exact field to the nearest editable entry", () => {
    const onSelectValidationIssue = vi.fn();
    const scrollIntoView = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    const issue = {
      id: "issue_disabled_exact",
      severity: "error" as const,
      category: "invented_metric" as const,
      sectionId: "section_experience",
      entryId: "entry_1",
      bulletId: null,
      message: "The metric needs review.",
    };

    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume={false}
        canClearApproval={false}
        editorPanel={
          <article
            data-resume-editor-section="section_experience"
            tabIndex={-1}
          >
            <article data-resume-editor-entry="entry_1" tabIndex={-1}>
              <input
                data-resume-editor-target="entry:section_experience:entry_1:summary"
                disabled
                value="Locked summary"
                readOnly
                onChange={() => undefined}
              />
              <input
                data-resume-editor-target="entry:section_experience:entry_1:title"
                value="Editable title"
                onChange={() => undefined}
              />
            </article>
          </article>
        }
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSelectValidationIssue={onSelectValidationIssue}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="Ready."
        templatePanel={<div>Templates</div>}
        validationIssues={[issue]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit entry summary: The metric needs review.",
      }),
    );

    expect(onSelectValidationIssue).toHaveBeenCalledWith(
      issue,
      "entry:section_experience:entry_1:summary",
    );
    expect(onSelectValidationIssue).toHaveBeenLastCalledWith(issue, null);
    expect(
      document.activeElement?.getAttribute("data-resume-editor-entry"),
    ).toBe("entry_1");
    expect(
      screen.getByText(
        "Opened the nearest editable entry in the editor; the exact field was not available.",
      ),
    ).toBeTruthy();
  });

  it("routes work-history review to the decisions panel and clears field selection", () => {
    const onSelectValidationIssue = vi.fn();
    const onSetMobileStudioTab = vi.fn();
    const scrollIntoView = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    const issue = {
      id: "issue_work_history_route",
      severity: "error" as const,
      category: "work_history_review" as const,
      sectionId: null,
      entryId: null,
      bulletId: null,
      message: "A canonical work-history role is hidden from the resume.",
    };

    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume
        canClearApproval={false}
        editorPanel={
          <section data-resume-work-history-decisions tabIndex={-1}>
            Work-history decisions
          </section>
        }
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSelectValidationIssue={onSelectValidationIssue}
        onSetMobileStudioTab={onSetMobileStudioTab}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="Ready."
        templatePanel={<div>Templates</div>}
        validationIssues={[issue]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Review work history: A canonical work-history role is hidden from the resume.",
      }),
    );

    expect(onSetMobileStudioTab).toHaveBeenCalledWith("editor");
    expect(onSelectValidationIssue).toHaveBeenCalledWith(issue, null);
    expect(
      document.activeElement?.hasAttribute(
        "data-resume-work-history-decisions",
      ),
    ).toBe(true);
    expect(
      screen.getByText(
        "Opened the work-history decisions panel in the editor.",
      ),
    ).toBeTruthy();
  });

  it("keeps the ready preview and tools panes without a global optional-notes task", () => {
    const reviewIssues = Array.from({ length: 8 }, (_, index) => ({
      id: `issue_note_${index + 1}`,
      severity: "warning" as const,
      category: "thin_output" as const,
      sectionId: null,
      entryId: null,
      bulletId: null,
      message: `Review note ${index + 1}.`,
    }));

    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume
        canClearApproval={false}
        editorPanel={<div>Editor tools</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Ready preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="Ready."
        templatePanel={<div>Templates</div>}
        validationIssues={reviewIssues}
      />,
    );

    expect(screen.getAllByText("Ready preview")).not.toHaveLength(0);
    expect(screen.getAllByText("Editor tools")).not.toHaveLength(0);
    const issueRegion = document.querySelector(
      "[data-resume-validation-issues]",
    );
    expect(issueRegion).toBeNull();
    expect(
      document.querySelector("[data-resume-workspace-scroll-region]"),
    ).toBeTruthy();
  });

  it("does not offer a misleading editor action for a note without a target", () => {
    const onSetMobileStudioTab = vi.fn();
    const scrollIntoView = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume
        canClearApproval={false}
        editorPanel={<div>Editor</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={onSetMobileStudioTab}
        previewPane={<div>Ready preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="Ready."
        templatePanel={<div>Templates</div>}
        validationIssues={[
          {
            id: "issue_page_overflow",
            severity: "warning",
            category: "page_overflow",
            sectionId: null,
            entryId: null,
            bulletId: null,
            message: "The rendered resume may exceed one page.",
          },
        ]}
      />,
    );

    expect(
      screen.queryByText("The rendered resume may exceed one page."),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Review issue" })).toBeNull();
    expect(onSetMobileStudioTab).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("replaces approval/export with recovery that focuses the first blocker", () => {
    const onExportPdf = vi.fn();
    const onApproveCurrentPdf = vi.fn();
    const scrollIntoView = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume
        canClearApproval={false}
        editorPanel={<div>Editor</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={onApproveCurrentPdf}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={onExportPdf}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="Ready."
        templatePanel={<div>Templates</div>}
        validationIssues={[
          {
            id: "issue_error_2",
            severity: "error",
            category: "unsupported_claim",
            sectionId: "section_summary",
            entryId: null,
            bulletId: null,
            message: "Claim has no candidate evidence.",
          },
        ]}
      />,
    );

    expect(
      screen.getByText("Fix the first validation error before approval."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve resume" })).toBeNull();
    const recovery = screen.getByRole("button", {
      name: "Fix approval blocker",
    });
    expect(recovery.getAttribute("data-variant")).toBe("primary");

    fireEvent.click(recovery);
    expect(
      document.activeElement?.getAttribute("data-resume-validation-issue"),
    ).toBe("issue_error_2");
    expect(onApproveCurrentPdf).not.toHaveBeenCalled();
    expect(onExportPdf).not.toHaveBeenCalled();
  });

  it("keeps a warning-only exported PDF approvable", () => {
    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume
        canClearApproval={false}
        editorPanel={<div>Editor</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="Ready."
        templatePanel={<div>Templates</div>}
        validationIssues={[
          {
            id: "issue_warning_only",
            severity: "warning",
            category: "thin_output",
            sectionId: null,
            entryId: null,
            bulletId: null,
            message: "Review the short summary.",
          },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "Approve resume" })).toBeTruthy();
    expect(
      document.querySelector("[data-resume-validation-issues]"),
    ).toBeNull();
    expect(
      screen.getByText("Approve the resume shown in the preview."),
    ).toBeTruthy();
    expect(screen.queryByText("No approval blockers")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Fix approval blocker" }),
    ).toBeNull();
  });

  it("blocks approval with a separate decisions reason and focuses the work-history list", () => {
    const onExportPdf = vi.fn();
    const onApproveCurrentPdf = vi.fn();
    const scrollIntoView = vi.fn();

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason="1 hidden role is off this resume. Leave it off, or add it back under Experience, before you can approve. You can still export a PDF."
        approvalStateLabel="Approval needs decisions"
        canApproveResume={false}
        canClearApproval={false}
        editorPanel={
          <section data-resume-work-history-decisions tabIndex={-1}>
            Work-history decisions
          </section>
        }
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={onApproveCurrentPdf}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={onExportPdf}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="Decide first"
        templatePanel={<div>Templates</div>}
      />,
    );

    expect(screen.getAllByRole("alert").length).toBe(1);
    expect(
      screen
        .getAllByRole("alert")[0]!
        .textContent.includes("You can still export a PDF"),
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Approve resume" })).toBeNull();
    expect(
      screen
        .getAllByRole("button", { name: "Review hidden roles" })
        .every((button) => !button.hasAttribute("disabled")),
    ).toBe(true);

    fireEvent.click(
      screen.getAllByRole("button", {
        name: "Review hidden roles",
      })[0]!,
    );

    expect(scrollIntoView).toHaveBeenCalled();
    expect(
      document.activeElement?.hasAttribute(
        "data-resume-work-history-decisions",
      ),
    ).toBe(true);
    expect(onApproveCurrentPdf).not.toHaveBeenCalled();
    expect(onExportPdf).not.toHaveBeenCalled();
  });

  it("keeps the ready studio visible while a native PDF export is pending", () => {
    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume={false}
        canClearApproval={false}
        editorPanel={<div>Editor</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isExportPending
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Ready preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="Ready."
        templatePanel={<div>Templates</div>}
      />,
    );

    const exportButton = screen.getByRole("button", { name: /Exporting PDF/ });
    expect(exportButton.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getAllByText("Ready preview")).not.toHaveLength(0);
    expect(screen.queryByText("Updating your resume")).toBeNull();
  });
});

describe("ResumeWorkspaceStudioShell review pass", () => {
  afterEach(() => {
    cleanup();
  });

  function renderReviewShell(
    overrides: {
      canApproveResume?: boolean;
      nextTitle?: string | null;
    } = {},
  ) {
    const onApproveAndNext = vi.fn();
    const onSkip = vi.fn();
    const onApproveCurrentPdf = vi.fn();
    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume={overrides.canApproveResume ?? true}
        canClearApproval={false}
        editorPanel={<div>Editor</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={onApproveCurrentPdf}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Preview</div>}
        reviewFlow={{
          reviewed: 12,
          total: 193,
          nextTitle:
            overrides.nextTitle === undefined
              ? "Staff Engineer"
              : overrides.nextTitle,
          failures: [],
          onApproveAndNext,
          onSkip: overrides.nextTitle === null ? null : onSkip,
          onOpenJob: vi.fn(),
        }}
        selectedTemplateApprovalEligible
        studioStatusMessage="Review the preview, then approve when you are ready."
        templatePanel={<div>Templates</div>}
      />,
    );
    return { onApproveAndNext, onApproveCurrentPdf, onSkip };
  }

  it("approves and opens the next resume from the button and from Ctrl+Enter, with the progress beside it", () => {
    const { onApproveAndNext, onApproveCurrentPdf, onSkip } =
      renderReviewShell();
    expect(screen.getByText("12 of 193 reviewed")).toBeTruthy();
    const approve = screen.getByRole("button", { name: /Approve and next/ });
    expect(approve.getAttribute("aria-keyshortcuts")).toMatch(/\+Enter$/);
    fireEvent.click(approve);
    expect(onApproveAndNext).toHaveBeenCalledTimes(1);
    expect(onApproveCurrentPdf).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(onApproveAndNext).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("does not approve from the keyboard while something blocks approval", () => {
    const { onApproveAndNext } = renderReviewShell({ canApproveResume: false });
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(onApproveAndNext).not.toHaveBeenCalled();
  });

  it("says Approve resume on the last one and offers no Skip", () => {
    renderReviewShell({ nextTitle: null });
    expect(
      screen.getByRole("button", { name: /^Approve resume/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
  });
});

describe("ResumeWorkspaceStudioShell locked-pane ownership", () => {
  class ResizeObserverMock {
    observe() {}
    disconnect() {}
    unobserve() {}
  }

  function buildStudioShellProps() {
    return {
      approvalBlockedReason: null,
      approvalStateLabel: null,
      canApproveResume: false,
      canClearApproval: false,
      editorPanel: <div>Editor</div>,
      exportBlockedReason: null,
      hasUnsavedChanges: false,
      historyPanel: <div>History</div>,
      isWorkspacePending: false,
      mobileStudioTab: "preview" as const,
      onApproveCurrentPdf: vi.fn(),
      onClearApproval: vi.fn(),
      onContinueToShortlisted: vi.fn(),
      onExportPdf: vi.fn(),
      onRegenerateDraft: vi.fn(),
      onReviewBlockingIssues: vi.fn(),
      onSaveDraft: vi.fn(),
      onSetMobileStudioTab: vi.fn(),
      previewPane: <div>Preview</div>,
      selectedTemplateApprovalEligible: true,
      studioStatusMessage: "Ready.",
      templatePanel: (
        <button data-testid="rail-action" type="button">
          Use this template
        </button>
      ),
    };
  }

  it("keeps one compact sticky row and no notice outside a scroll region", () => {
    const { container } = render(
      <ResumeWorkspaceStudioShell
        {...buildStudioShellProps()}
        approvalBlockedReason="2 hidden roles are off this resume. Leave them off, or add them back under Experience, before you can approve. You can still export a PDF."
        exportBlockedReason="35 generated or unsupported claims must be removed, rewritten, or grounded in candidate evidence before this resume can be exported."
        setAsideProposalNote="1 pending suggestion was set aside."
        validationIssues={[
          {
            id: "issue one",
            severity: "error",
            category: "unsupported_claim",
            sectionId: "sec summary",
            entryId: null,
            bulletId: null,
            message: "This claim is not supported by saved evidence.",
          },
        ]}
      />,
    );

    // The header stack that used to pin ~270px of an 860px window is now one
    // row: state, next-step sentence, attention chip, primary action.
    const pinnedHeader = container.querySelector<HTMLElement>(
      "[data-resume-studio-compact-header]",
    );
    expect(pinnedHeader).toBeTruthy();
    expect(pinnedHeader?.className).toContain("py-1.5");
    expect(
      container.querySelectorAll("[data-resume-studio-compact-header]").length,
    ).toBe(1);

    // Everything else the shell owns at the top of the panel is now inside the
    // tools column, which is the studio's own scroll region.
    const scrollRegion = container.querySelector<HTMLElement>(
      "[data-resume-workspace-scroll-region]",
    );
    expect(scrollRegion?.className).toContain("overflow-y-auto");

    for (const selector of [
      "[data-resume-studio-attention-panel]",
      "[data-resume-validation-issues]",
      "[data-resume-set-aside-proposal-note]",
    ]) {
      const node = container.querySelector<HTMLElement>(selector);
      expect(node, `${selector} renders`).toBeTruthy();
      expect(scrollRegion?.contains(node), `${selector} is scrollable`).toBe(
        true,
      );
    }

    // No notice may sit between the sticky header and the panes.
    const panes = container.querySelector<HTMLElement>(
      "[data-resume-studio-desktop-grid]",
    );
    expect(panes).toBeTruthy();
    expect(pinnedHeader?.nextElementSibling?.className).not.toContain(
      "border-(--warning-border)",
    );
  });

  it("summarises the pinned notices as one attention chip", () => {
    const onSetMobileStudioTab = vi.fn();
    render(
      <ResumeWorkspaceStudioShell
        {...buildStudioShellProps()}
        approvalBlockedReason="1 hidden work-history role is waiting on a decision."
        exportBlockedReason="35 generated or unsupported claims must be removed."
        onSetMobileStudioTab={onSetMobileStudioTab}
        validationIssues={[
          {
            id: "issue one",
            severity: "error",
            category: "unsupported_claim",
            sectionId: "sec summary",
            entryId: null,
            bulletId: null,
            message: "This claim is not supported by saved evidence.",
          },
        ]}
      />,
    );

    const chip = screen.getByRole("button", {
      name: "3 items need attention",
    });
    fireEvent.click(chip);
    expect(onSetMobileStudioTab).toHaveBeenCalledWith("editor");
  });

  it("offers one route back to Shortlisted after approval", () => {
    const approved = render(
      <ResumeWorkspaceStudioShell
        {...buildStudioShellProps()}
        canClearApproval
        onPrepareApplication={vi.fn()}
      />,
    );

    // `Continue to Shortlisted →` used to sit beside `Apply →`
    // while `← Back to Shortlisted` was ~100px away in the workspace header.
    expect(
      screen.queryByRole("button", { name: /Continue to Shortlisted/ }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: /Apply/ })).toBeTruthy();
    approved.unmount();

    render(
      <ResumeWorkspaceStudioShell
        {...buildStudioShellProps()}
        canClearApproval
      />,
    );
    expect(
      screen.getByRole("button", { name: /Back to Shortlisted/ }),
    ).toBeTruthy();
  });

  function stubCollapsedHeaderMetrics() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return {
          bottom: 200,
          height: 200,
          left: 0,
          right: 100,
          top: 0,
          width: this.hasAttribute("data-resume-studio-panes") ? 1000 : 100,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
  }

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("innerWidth", 1440);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("marks the desktop studio rail as the only owned scroll pane", () => {
    const { container } = render(
      <ResumeWorkspaceStudioShell {...buildStudioShellProps()} />,
    );

    const rail = container.querySelector<HTMLElement>(
      "[data-resume-workspace-scroll-region]",
    );

    expect(rail?.hasAttribute("data-locked-pane-scroll-region")).toBe(true);
    expect(rail?.getAttribute("role")).toBe("region");
    expect(rail?.getAttribute("aria-label")).toBe("Resume studio tools");
    expect(rail?.getAttribute("tabindex")).toBe("0");
    expect(
      container.querySelectorAll("[data-locked-pane-scroll-region]"),
    ).toHaveLength(1);
    expect(
      rail?.querySelectorAll("[data-locked-pane-scroll-region]"),
    ).toHaveLength(0);
  });

  it("leaves the wheel to the rail natively while the rail still has range", () => {
    stubCollapsedHeaderMetrics();

    const { container } = render(
      <LockedScreenLayout topContent={<div>Workspace context</div>}>
        <ResumeWorkspaceStudioShell {...buildStudioShellProps()} />
      </LockedScreenLayout>,
    );
    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const rail = container.querySelector<HTMLElement>(
      "[data-resume-workspace-scroll-region]",
    );
    if (!(rail instanceof HTMLElement)) {
      throw new Error("Expected the desktop studio rail to render.");
    }
    Object.defineProperties(rail, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 900 },
    });
    if (outerScroller) {
      outerScroller.scrollTop = 200;
    }
    rail.scrollTop = 250;

    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: 100,
    });
    rail
      .querySelector<HTMLElement>("[data-resume-template-chooser]")
      ?.dispatchEvent(wheelEvent);

    // The rail has 350px of range left in this direction, so the browser owns
    // the event: no `preventDefault`, no manual `scrollTop` write, and the
    // outer route owner does not move. Custom arbitration is reserved for a
    // true boundary.
    expect(wheelEvent.defaultPrevented).toBe(false);
    expect(rail.scrollTop).toBe(250);
    expect(outerScroller?.scrollTop).toBe(200);
  });

  it("leaves boundary chaining to the browser when the rail is exhausted", () => {
    stubCollapsedHeaderMetrics();

    const { container } = render(
      <LockedScreenLayout topContent={<div>Workspace context</div>}>
        <ResumeWorkspaceStudioShell {...buildStudioShellProps()} />
      </LockedScreenLayout>,
    );
    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const rail = container.querySelector<HTMLElement>(
      "[data-resume-workspace-scroll-region]",
    );
    if (!(rail instanceof HTMLElement)) {
      throw new Error("Expected the desktop studio rail to render.");
    }
    Object.defineProperties(outerScroller as HTMLElement, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    Object.defineProperties(rail, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 900 },
    });
    if (outerScroller) {
      outerScroller.scrollTop = 200;
    }
    rail.scrollTop = 600;

    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: 120,
    });
    rail
      .querySelector<HTMLElement>("[data-resume-template-chooser]")
      ?.dispatchEvent(wheelEvent);

    // With the rail exhausted and the header already collapsed there is
    // nothing left for the layout to arbitrate, so the event stays native and
    // the browser chains it outward with real momentum.
    expect(wheelEvent.defaultPrevented).toBe(false);
    expect(rail.scrollTop).toBe(600);
    expect(outerScroller?.scrollTop).toBe(200);
  });

  it("keeps keyboard scrolling with the focused rail and Space with buttons", () => {
    stubCollapsedHeaderMetrics();

    const { container } = render(
      <LockedScreenLayout topContent={<div>Workspace context</div>}>
        <ResumeWorkspaceStudioShell {...buildStudioShellProps()} />
      </LockedScreenLayout>,
    );
    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const rail = container.querySelector<HTMLElement>(
      "[data-resume-workspace-scroll-region]",
    );
    if (!(rail instanceof HTMLElement)) {
      throw new Error("Expected the desktop studio rail to render.");
    }
    Object.defineProperties(rail, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 900 },
    });
    if (outerScroller) {
      outerScroller.scrollTop = 200;
    }
    rail.focus();

    const pageDown = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "PageDown",
    });
    rail.dispatchEvent(pageDown);
    expect(pageDown.defaultPrevented).toBe(true);
    expect(rail.scrollTop).toBe(300);

    const arrowUp = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowUp",
    });
    rail.scrollTop = 600;
    rail.dispatchEvent(arrowUp);
    expect(arrowUp.defaultPrevented).toBe(true);
    expect(rail.scrollTop).toBe(560);

    const action = rail.querySelector<HTMLElement>(
      '[data-testid="rail-action"]',
    );
    if (!(action instanceof HTMLElement)) {
      throw new Error("Expected the rail template action button to render.");
    }
    expect(fireEvent.keyDown(action, { key: " " })).toBe(true);
    fireEvent.click(action);
    expect(screen.getByText("Use this template")).toBeTruthy();
  });
});

describe("ResumeWorkspaceStudioShell focus ring contrast", () => {
  afterEach(() => {
    // This block pins the compact media query partway through its one test, so
    // it has to hand the default back rather than leaving the next block to
    // discover a stubbed `matchMedia`.
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("uses full-strength ring for all keyboard focus targets (diluted primary <3:1)", () => {
    // Audit: ring-primary/60 at 60% composites to 2.42:1 dark / 2.42:1 light worst-case,
    // well below WCAG 2.4.11 3:1. Full --ring is proven >=3:1 in both themes.
    const { container } = render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume={false}
        canClearApproval={false}
        editorPanel={<div>Editor</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="Ready."
        templatePanel={<div>Templates</div>}
      />,
    );

    const summaries = container.querySelectorAll("summary");
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    const historySummaries = Array.from(summaries).filter((el) =>
      el.textContent?.includes("Version history"),
    );
    expect(historySummaries.length).toBeGreaterThanOrEqual(1);
    for (const historySummary of historySummaries) {
      expect(historySummary.className).toContain("focus-visible:ring-2");
      expect(historySummary.className).toContain("focus-visible:ring-ring");
      expect(historySummary.className).not.toMatch(/ring-primary\/\d/);
    }

    const templateChoosers = container.querySelectorAll(
      "[data-resume-template-chooser]",
    );
    // preview tab hides the mobile chooser; at least the desktop chooser must be present
    expect(templateChoosers.length).toBeGreaterThanOrEqual(1);
    for (const chooser of Array.from(templateChoosers)) {
      expect((chooser as HTMLElement).className).toContain(
        "focus-visible:ring-2",
      );
      expect((chooser as HTMLElement).className).toContain(
        "focus-visible:ring-ring",
      );
      expect((chooser as HTMLElement).className).not.toMatch(
        /ring-primary\/\d/,
      );
    }

    // Non-focus decoration stays diluted by design — capture before unmount.
    const previewHtml = container.innerHTML;
    expect(previewHtml).toContain("border-primary/40");
    expect(previewHtml).toContain("bg-primary/10");

    // Also verify the editor tab exposes the mobile chooser with the same
    // token. The compact tab surface only mounts below the breakpoint, so the
    // media query has to say so.
    cleanup();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
      })),
    });
    const { container: editorContainer } = render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume={false}
        canClearApproval={false}
        editorPanel={<div>Editor</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="editor"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="Ready."
        templatePanel={<div>Templates</div>}
      />,
    );
    const editorChoosers = editorContainer.querySelectorAll(
      "[data-resume-template-chooser]",
    );
    // One chooser, not two: the desktop copy is no longer mounted alongside
    // the compact one.
    expect(editorChoosers.length).toBe(1);
    expect(
      editorChoosers[0]?.closest("[data-resume-studio-compact-layout]"),
    ).not.toBeNull();
    for (const chooser of Array.from(editorChoosers)) {
      expect((chooser as HTMLElement).className).toContain(
        "focus-visible:ring-ring",
      );
    }
  });
});

describe("ResumeWorkspaceStudioShell desktop grid is Assistant-independent", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "matchMedia");
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    // The studio split view is the layout under test; pin the desktop
    // media query instead of relying on the jsdom default.
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  function renderShell() {
    render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume={false}
        canClearApproval={false}
        editorPanel={<div>Editor</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab="preview"
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible
        studioStatusMessage="Ready."
        templatePanel={<div>Templates</div>}
      />,
    );

    return document.querySelector<HTMLElement>(
      "[data-resume-studio-grid-columns]",
    );
  }

  it("keeps preview and tools as the only two columns, with no Assistant dock", () => {
    const grid = renderShell();

    expect(grid?.getAttribute("data-resume-studio-grid-columns")).toBe(
      "preview-tools",
    );
    expect(grid?.className).toContain(
      "xl:grid-cols-[minmax(0,1.15fr)_minmax(26rem,0.85fr)]",
    );
    // The retired docked rail added a `min(24rem,30vw)` third track and
    // squeezed both panes the moment the Assistant opened.
    expect(grid?.className).not.toContain("min(24rem,30vw)");
    expect(document.querySelector("[data-resume-assistant-dock]")).toBeNull();
  });

  it("cannot change the grid or the panes with the Assistant's open state", () => {
    // The shell has no Assistant-open input at all any more, so the column
    // template and both panes are structurally identical open, minimized and
    // closed. This is the whole point of the floating panel.
    const shellSource = ResumeWorkspaceStudioShell.toString();
    expect(shellSource).not.toContain("isAssistantRailOpen");

    const grid = renderShell();
    const previewPane = grid?.querySelector<HTMLElement>(
      "[data-resume-studio-preview-pane]",
    );
    const toolsPane = grid?.querySelector<HTMLElement>(
      "[data-resume-studio-tools-pane]",
    );

    expect(previewPane?.className).toBe(
      "h-full min-h-[18rem] min-w-0 overflow-hidden xl:min-h-0",
    );
    expect(toolsPane?.className).toBe(
      "flex h-full min-h-[18rem] min-w-0 flex-col gap-2.5 overflow-y-auto overflow-x-hidden pr-1 xl:min-h-0",
    );
    expect(toolsPane?.className).toContain("overflow-y-auto");
  });

  it("carries no launcher clearance on the tools column at all", () => {
    // Two reservations were tried and both failed. `xl:h-[calc(100%-3.5rem)]`
    // shortened the column and left an empty dark strip under "Edit resume";
    // `pb-14` fixed only the END of the scroll, so mid-scroll the template card
    // and the fallback disclosure still passed under the fixed pill. The
    // launcher does not float over this column any more, so the column
    // reserves nothing.
    const grid = renderShell();
    const toolsPane = grid?.querySelector<HTMLElement>(
      "[data-resume-studio-tools-pane]",
    );

    expect(toolsPane?.className).not.toContain("pb-14");
    expect(toolsPane?.className).not.toContain("pb-16");
    expect(toolsPane?.className).not.toMatch(/xl:h-\[calc\(/);
    expect(toolsPane?.className).toContain("h-full");
  });

  it("offers the Assistant launcher slot in the row that owns the screen's actions", () => {
    const grid = renderShell();
    const slot = document.querySelector<HTMLElement>(
      "[data-resume-studio-assistant-launcher-slot]",
    );

    expect(slot).not.toBeNull();
    // It sits in the sticky header beside Approve resume, not over a pane.
    expect(slot?.closest("[data-resume-studio-compact-header]")).not.toBeNull();
    expect(
      grid?.querySelector("[data-resume-studio-assistant-launcher-slot]"),
    ).toBeNull();
  });

  it("runs the tools column the full studio height and reserves nothing at its end", () => {
    // Previously: `expect(toolsPane?.className).toContain(
    //   "xl:h-[calc(100%-3.5rem)]")` — that shortened the column by the pill's
    // band, which is exactly the reported defect: the column ended ~56px above
    // the preview's bottom edge and left an empty dark strip under "Edit
    // resume". The clearance now lives inside the scroll region as bottom
    // padding of the same band, so the column is full height AND nothing can
    // scroll under the pill. The reservation is unconditional, so opening the
    // Assistant still moves nothing here.
    const grid = renderShell();
    const toolsPane = grid?.querySelector<HTMLElement>(
      "[data-resume-studio-tools-pane]",
    );

    expect(toolsPane?.className).not.toContain("xl:h-[calc(100%-3.5rem)]");
    expect(toolsPane?.className).toContain("h-full");
    expect(toolsPane?.className).not.toContain("pb-16");
  });

  it("gives the tools column the same height model as the preview column", () => {
    // The empty strip was visible precisely because these two disagreed.
    const grid = renderShell();
    const previewPane = grid?.querySelector<HTMLElement>(
      "[data-resume-studio-preview-pane]",
    );
    const toolsPane = grid?.querySelector<HTMLElement>(
      "[data-resume-studio-tools-pane]",
    );

    for (const pane of [previewPane, toolsPane]) {
      expect(pane?.className).toContain("h-full");
      expect(pane?.className).not.toMatch(/xl:h-\[calc\(/);
    }
  });

  it("never reserves empty padding beside the studio grid", () => {
    renderShell();

    const desktopGrid = document.querySelector<HTMLElement>(
      "[data-resume-studio-desktop-grid]",
    );

    expect(desktopGrid?.className).not.toContain("xl:pr-[");
    expect(desktopGrid?.className).toContain("p-2.5");
  });
});

describe("ResumeWorkspaceStudioShell bounded compact tabs", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "matchMedia");
  });

  // These tabs only exist below the desktop split view, and the shell reads
  // that breakpoint in JS so exactly one Assistant transcript is mounted.
  function stubCompactViewport() {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
      })),
    });
  }

  function stubDesktopViewport() {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: true,
        removeEventListener: vi.fn(),
      })),
    });
  }

  function renderCompactShell(
    overrides?: Partial<{
      assistantDocked: boolean;
      canClearApproval: boolean;
      /** Renders the desktop split view instead, with the same props. */
      desktop: boolean;
      exportBlockedReason: string | null;
      mobileStudioTab: "preview" | "editor";
      setAsideProposalNote: string;
    }>,
  ) {
    if (overrides?.desktop) {
      stubDesktopViewport();
    } else {
      stubCompactViewport();
    }

    return render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        assistantDocked={overrides?.assistantDocked ?? false}
        canApproveResume={false}
        canClearApproval={overrides?.canClearApproval ?? false}
        editorPanel={<div>Editor</div>}
        exportBlockedReason={overrides?.exportBlockedReason ?? null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab={overrides?.mobileStudioTab ?? "editor"}
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<div>Preview</div>}
        selectedTemplateApprovalEligible
        {...(overrides?.setAsideProposalNote
          ? { setAsideProposalNote: overrides.setAsideProposalNote }
          : {})}
        studioStatusMessage="Ready."
        templatePanel={<div>Templates</div>}
      />,
    );
  }

  it("bounds the studio and every tab so tab content cannot grow the route", () => {
    const { container } = renderCompactShell();

    // The studio fills the height its caller gives it at every width; before,
    // `xl:h-full` left the compact tab surface free to grow with its content
    // and one grounded proposal pushed the route past 38,000px.
    const studio = container.firstElementChild as HTMLElement | null;
    expect(studio?.className).toContain("h-full");
    expect(studio?.className).toContain("min-h-0");
    expect(studio?.className).toContain("overflow-hidden");
    expect(studio?.className).not.toContain("xl:h-full");

    const activeTab = container.querySelector<HTMLElement>(
      '[data-slot="tabs-content"][data-state="active"]',
    );
    expect(activeTab?.className).toContain("h-full");
    expect(activeTab?.className).toContain("min-h-0");

    // Two tabs, not three: the Assistant is the floating panel here too, so
    // there is no compact variant of it to grow the route.
    const tabs = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="tabs-trigger"]'),
    ).map((tab) => tab.textContent);
    expect(tabs).toEqual(["Preview", "Tools"]);
  });

  // At 1200x640 the approved studio rendered two contiguous rows totalling
  // 116px: a 53px state row and a 63px band repeating the same fact and owning
  // `Clear approval`. At 1440 it was correctly one row.
  it("renders exactly one approval row at compact width after approval", () => {
    renderCompactShell({ canClearApproval: true, mobileStudioTab: "preview" });

    // The compact status band is gone, and the desktop tools column is not
    // mounted at this width at all, so no status row renders here: the sticky
    // row below owns the approved state outright.
    const statusRows = Array.from(
      document.querySelectorAll<HTMLElement>("[data-resume-studio-status]"),
    );
    expect(statusRows).toHaveLength(0);
    expect(
      document.querySelector("[data-resume-studio-desktop-grid]"),
    ).toBeNull();

    const stickyRow = document.querySelector<HTMLElement>(
      "[data-resume-studio-compact-header]",
    );
    expect(stickyRow).not.toBeNull();
    expect(
      document.querySelectorAll("[data-resume-studio-compact-header]").length,
    ).toBe(1);

    // `Clear approval` moved into that row rather than disappearing with the
    // band, and it is still the secondary action beside the primary one.
    const clearButtons = screen.getAllByRole("button", {
      name: "Clear approval",
    });
    expect(clearButtons).toHaveLength(1);
    expect(stickyRow?.contains(clearButtons[0]!)).toBe(true);
    expect(clearButtons[0]?.getAttribute("data-variant")).toBe("ghost");

    // The one thing the retired band said that the sticky row did not still
    // reaches the reader.
    const note = stickyRow?.querySelector(
      "[data-resume-studio-compact-approval-note]",
    );
    expect(note?.textContent).toContain("Any new edit needs approval again.");
  });

  // A 1440 -> 1200 -> 1440 excursion used to swap the Assistant between a
  // docked column and a CSS-hidden tab, which left two mounted copies of the
  // same live region, composer and proposal controls. The studio no longer
  // renders the Assistant at any width — the floating panel owns the single
  // transcript — so no width can duplicate it.
  it("mounts no Assistant surface of its own at any width", () => {
    const props = {
      approvalBlockedReason: null,
      approvalStateLabel: null,
      canApproveResume: false,
      canClearApproval: false,
      editorPanel: <div>Editor</div>,
      exportBlockedReason: null,
      hasUnsavedChanges: false,
      historyPanel: <div>History</div>,
      isWorkspacePending: false,
      mobileStudioTab: "editor" as const,
      onApproveCurrentPdf: vi.fn(),
      onClearApproval: vi.fn(),
      onContinueToShortlisted: vi.fn(),
      onExportPdf: vi.fn(),
      onReviewBlockingIssues: vi.fn(),
      onSaveDraft: vi.fn(),
      onSetMobileStudioTab: vi.fn(),
      previewPane: <div>Preview</div>,
      selectedTemplateApprovalEligible: true,
      studioStatusMessage: "Ready.",
      templatePanel: <div>Templates</div>,
    };

    const { rerender } = render(<ResumeWorkspaceStudioShell {...props} />);

    const assistantSurfaceCount = () =>
      document.querySelectorAll(
        "[data-resume-assistant-panel], [data-resume-guided-edits-transcript]",
      ).length;

    // 1440.
    expect(assistantSurfaceCount()).toBe(0);
    expect(screen.queryByRole("tab", { name: "Assistant" })).toBeNull();

    // 1200.
    stubCompactViewport();
    rerender(<ResumeWorkspaceStudioShell {...props} />);
    expect(assistantSurfaceCount()).toBe(0);
    expect(screen.queryByRole("tab", { name: "Assistant" })).toBeNull();
  });

  it.each([
    ["desktop", true],
    ["compact", false],
  ] as const)(
    "gives the open Assistant its own %s column beside the panes, below the approval row",
    (_label, desktop) => {
      // No-overlap guarantee, by structure: the dock is an in-flow flex
      // sibling of the panes column, below the row that owns Approve, and
      // never positioned over anything.
      const { container } = renderCompactShell({
        assistantDocked: true,
        desktop,
      });
      const studio = container.firstElementChild as HTMLElement;
      const body = studio.querySelector<HTMLElement>(
        "[data-resume-studio-body]",
      );
      const dock = studio.querySelector<HTMLElement>(
        "[data-resume-studio-assistant-dock-slot]",
      );
      const approvalRow = studio.querySelector<HTMLElement>(
        "[data-resume-workspace-top-actions]",
      );

      expect(body?.className).toContain("flex");
      expect(dock?.parentElement).toBe(body);
      expect(body?.lastElementChild).toBe(dock);
      expect(dock?.previousElementSibling?.className).toContain("flex-1");
      expect(dock?.className).toContain("w-(--resume-assistant-dock-width)");
      expect(dock?.className).toContain("shrink-0");
      expect(dock?.className).not.toMatch(/\b(fixed|absolute|sticky)\b/);
      expect(dock?.getAttribute("data-resume-studio-assistant-docked")).toBe(
        "true",
      );
      // The approval row sits above the body, so the dock can never reach it.
      expect(
        approvalRow &&
          body &&
          approvalRow.compareDocumentPosition(body) &
            Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(body?.contains(approvalRow)).toBe(false);

      if (desktop) {
        const grid = studio.querySelector<HTMLElement>(
          "[data-resume-studio-grid-columns]",
        );
        // The tools column may narrow while the Assistant is docked.
        expect(grid?.className).toContain(
          "xl:grid-cols-[minmax(0,1fr)_minmax(19rem,0.8fr)]",
        );
      }
    },
  );

  it("keeps the dock slot empty and hidden while the Assistant is closed", () => {
    const { container } = renderCompactShell({ desktop: true });
    const dock = container.querySelector<HTMLElement>(
      "[data-resume-studio-assistant-dock-slot]",
    );
    const grid = container.querySelector<HTMLElement>(
      "[data-resume-studio-grid-columns]",
    );

    expect(dock?.className).toContain("hidden");
    expect(dock?.childElementCount).toBe(0);
    expect(grid?.className).toContain(
      "xl:grid-cols-[minmax(0,1.15fr)_minmax(26rem,0.85fr)]",
    );
  });

  it("leaves exactly one always-visible studio row above the desktop panes", () => {
    // G3: the stack above the content used to be 117px of shell + a ~90px
    // workspace title row + this 53px state row. The title row now scrolls with
    // the locked layout, so on desktop this is the only row between the shell
    // and the panes. The desktop grid only mounts above the breakpoint now, so
    // this measures the real desktop stack rather than inferring it from a
    // CSS-hidden copy rendered at compact width.
    const { container } = renderCompactShell({ desktop: true });
    const studio = container.firstElementChild as HTMLElement;
    const rows = Array.from(studio.children) as HTMLElement[];

    const stickyRow = studio.querySelector<HTMLElement>(
      "[data-resume-studio-compact-header]",
    );
    const desktopGrid = studio.querySelector<HTMLElement>(
      "[data-resume-studio-desktop-grid]",
    );

    // The panes live in the studio body, beside the (closed, hidden)
    // Assistant dock slot.
    const body = studio.querySelector<HTMLElement>("[data-resume-studio-body]");

    expect(stickyRow?.parentElement).toBe(studio);
    expect(body?.parentElement).toBe(studio);
    expect(desktopGrid?.parentElement?.parentElement).toBe(body);
    expect(
      Array.from(desktopGrid?.parentElement?.children ?? []),
      "on desktop the panes column holds only the desktop grid",
    ).toEqual([desktopGrid]);
    expect(stickyRow?.className).toContain("shrink-0");

    // Desktop mounts no duplicate compact status band between the sticky row
    // and its panes.
    const between = rows.slice(
      rows.indexOf(stickyRow as HTMLElement) + 1,
      rows.indexOf(body as HTMLElement),
    );
    expect(between).toHaveLength(0);
  });

  it("scrolls the Tools tab inside the studio instead of growing it", () => {
    const { container } = renderCompactShell({ mobileStudioTab: "editor" });

    const toolsTab = container.querySelector<HTMLElement>(
      '[data-slot="tabs-content"][data-state="active"]',
    );

    expect(toolsTab?.className).toContain("h-full");
    expect(toolsTab?.className).toContain("overflow-y-auto");
    // Compact widths sit below the locked-pane breakpoint, so the tab must not
    // claim wheel-chain ownership.
    expect(toolsTab?.hasAttribute("data-locked-pane-scroll-region")).toBe(
      false,
    );
  });

  it("offers the attention chip for every notice the panel can show, and titles the panel truthfully", () => {
    // The attention panel lives in the Tools tab at compact widths, so this
    // reads the tab that owns it.
    const quiet = renderCompactShell({ mobileStudioTab: "editor" });

    expect(
      quiet.container.querySelector("[data-resume-studio-attention-chip]"),
    ).toBeNull();
    // A panel called "Needs your attention" with nothing outstanding is a lie.
    expect(quiet.container.textContent).toContain("Resume checks");
    expect(quiet.container.textContent).not.toContain("Needs your attention");

    cleanup();

    const noisy = renderCompactShell({
      exportBlockedReason: "Two claims are blocked.",
      mobileStudioTab: "editor",
      setAsideProposalNote: "A suggestion was set aside when you approved.",
    });
    const chip = noisy.container.querySelector<HTMLElement>(
      "[data-resume-studio-attention-chip]",
    );

    expect(chip?.textContent).toContain("2 items need attention");
    expect(noisy.container.textContent).toContain("Needs your attention");
  });
});

describe("ResumeWorkspaceStudioShell mounts one studio layout at a time", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "matchMedia");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubViewport(desktop: boolean) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: desktop,
        removeEventListener: vi.fn(),
      })),
    });
  }

  function renderAtWidth(
    desktop: boolean,
    mobileStudioTab: "preview" | "editor",
  ) {
    stubViewport(desktop);

    return render(
      <ResumeWorkspaceStudioShell
        approvalBlockedReason={null}
        approvalStateLabel={null}
        canApproveResume={false}
        canClearApproval={false}
        editorPanel={<div data-test-editor-panel>Editor</div>}
        exportBlockedReason={null}
        hasUnsavedChanges={false}
        historyPanel={<div>History</div>}
        isWorkspacePending={false}
        mobileStudioTab={mobileStudioTab}
        onApproveCurrentPdf={vi.fn()}
        onClearApproval={vi.fn()}
        onContinueToShortlisted={vi.fn()}
        onExportPdf={vi.fn()}
        onReviewBlockingIssues={vi.fn()}
        onSaveDraft={vi.fn()}
        onSetMobileStudioTab={vi.fn()}
        previewPane={<iframe title="Resume preview" />}
        selectedTemplateApprovalEligible
        studioStatusMessage="Ready."
        supportingDetailsPanel={
          <details id="resume-proof-details">
            <summary>About this tailored resume</summary>
          </details>
        }
        templatePanel={<div>Templates</div>}
      />,
    );
  }

  // Rendering both layouts parsed two live `<iframe srcDoc>` preview documents
  // on every draft revision, each with its own ResizeObserver and iframe event
  // bindings, and duplicated `id="resume-proof-details"`.
  it("never mounts two preview iframes or two proof disclosures at any width or tab", () => {
    for (const desktop of [true, false]) {
      for (const mobileStudioTab of ["preview", "editor"] as const) {
        renderAtWidth(desktop, mobileStudioTab);

        expect(
          document.querySelectorAll("iframe").length,
          `iframes at ${desktop ? "desktop" : "compact"}/${mobileStudioTab}`,
        ).toBeLessThanOrEqual(1);
        expect(
          document.querySelectorAll("#resume-proof-details").length,
          `proof nodes at ${desktop ? "desktop" : "compact"}/${mobileStudioTab}`,
        ).toBeLessThanOrEqual(1);
        expect(
          document.querySelectorAll("[data-test-editor-panel]").length,
          `editor trees at ${desktop ? "desktop" : "compact"}/${mobileStudioTab}`,
        ).toBeLessThanOrEqual(1);

        cleanup();
      }
    }
  });

  it("mounts exactly one preview and one proof disclosure on the desktop split view", () => {
    renderAtWidth(true, "preview");

    const iframes = document.querySelectorAll("iframe");
    const proofNodes = document.querySelectorAll("#resume-proof-details");

    expect(iframes).toHaveLength(1);
    expect(proofNodes).toHaveLength(1);
    // The visible one, not a `display:none` compact copy ahead of it in
    // document order.
    expect(
      iframes[0]?.closest("[data-resume-studio-desktop-grid]"),
    ).not.toBeNull();
    expect(
      proofNodes[0]?.closest("[data-resume-studio-desktop-grid]"),
    ).not.toBeNull();
  });

  it("mounts exactly one preview and one proof disclosure across the compact tabs", () => {
    renderAtWidth(false, "preview");
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(
      document
        .querySelector("iframe")
        ?.closest("[data-resume-studio-compact-layout]"),
    ).not.toBeNull();
    expect(
      document.querySelector("[data-resume-studio-desktop-grid]"),
    ).toBeNull();
    cleanup();

    renderAtWidth(false, "editor");
    expect(document.querySelectorAll("#resume-proof-details")).toHaveLength(1);
    expect(
      document
        .querySelector("#resume-proof-details")
        ?.closest("[data-resume-studio-compact-layout]"),
    ).not.toBeNull();
    expect(
      document.querySelector("[data-resume-studio-desktop-grid]"),
    ).toBeNull();
  });

  it("keeps the tools accessible when the assistant narrows a wide window", () => {
    const callbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1000,
    } as DOMRect);
    renderAtWidth(true, "editor");
    expect(
      document.querySelector("[data-resume-studio-desktop-grid]"),
    ).not.toBeNull();

    act(() =>
      callbacks[0]!(
        [{ contentRect: { width: 760 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      ),
    );
    expect(
      screen.getByRole("tab", { name: "Tools" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(document.querySelector("[data-test-editor-panel]")).not.toBeNull();
    expect(
      document.querySelector("[data-resume-studio-desktop-grid]"),
    ).toBeNull();
    expect(document.querySelectorAll("#resume-proof-details")).toHaveLength(1);

    act(() =>
      callbacks[0]!(
        [{ contentRect: { width: 1000 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      ),
    );
    expect(
      document.querySelector("[data-resume-studio-desktop-grid]"),
    ).not.toBeNull();
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(document.querySelectorAll("[data-test-editor-panel]")).toHaveLength(
      1,
    );
  });
});
