// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProfileSetupState,
  ResumeImportProgressEvent,
} from "@nestor/contracts";
import { ProfileSetupSummaryCards } from "./profile-setup-screen-sections";

describe("ProfileSetupSummaryCards", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
  });

  type SummaryProps = {
    actionMessage: string | null;
    hasImportedResume: boolean;
    importDisabledReason: string | null;
    isImportResumePending: boolean;
    isProfileSetupPending: boolean;
    resumeImportProgress: ResumeImportProgressEvent | null;
    profileSetupState: ProfileSetupState;
  };

  function buildSummaryProps(options: {
    hasImportedResume: boolean;
    reviewItemCount: number;
    optionalReviewItemCount?: number;
    isImportResumePending?: boolean;
    isProfileSetupPending?: boolean;
    resumeImportProgress?: ResumeImportProgressEvent | null;
    actionMessage?: string | null;
    importDisabledReason?: string | null;
  }): SummaryProps {
    const profileSetupState: ProfileSetupState = {
      status: options.hasImportedResume ? "in_progress" : "not_started",
      currentStep: options.hasImportedResume ? "background" : "import",
      completedAt: null,
      lastResumedAt: null,
      reviewItems: [],
    };

    return {
      actionMessage: options.actionMessage ?? null,
      hasImportedResume: options.hasImportedResume,
      importDisabledReason: options.importDisabledReason ?? null,
      isImportResumePending: options.isImportResumePending ?? false,
      isProfileSetupPending: options.isProfileSetupPending ?? false,
      resumeImportProgress: options.resumeImportProgress ?? null,
      profileSetupState,
    };
  }

  function getContainerOrThrow(): HTMLDivElement {
    if (!container) {
      throw new Error("Expected container to be mounted");
    }
    return container;
  }

  function getRootOrThrow(): Root {
    if (!root) {
      throw new Error("Expected root to be mounted");
    }
    return root;
  }

  function getButtonOrThrow(
    buttons: HTMLButtonElement[],
    index: number,
  ): HTMLButtonElement {
    const button = buttons[index];
    if (!button) {
      throw new Error(`Expected button at index ${index} to exist`);
    }
    return button;
  }

  function mountSummary(
    props: SummaryProps,
    handlers: {
      onImportResume: ReturnType<typeof vi.fn>;
      onResumeCurrentStep: ReturnType<typeof vi.fn>;
      onStartManually: ReturnType<typeof vi.fn>;
    },
  ) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      getRootOrThrow().render(
        <ProfileSetupSummaryCards
          {...props}
          onImportResume={handlers.onImportResume}
          onStartManually={handlers.onStartManually}
        />,
      );
    });
  }

  function renderSummary(
    hasImportedResume: boolean,
    reviewItemCount: number,
    optionalReviewItemCount = 0,
    isImportResumePending = false,
    actionMessage: string | null = null,
    importDisabledReason: string | null = null,
    isProfileSetupPending = false,
  ) {
    const onResumeCurrentStep = vi.fn();
    const onImportResume = vi.fn();
    const onStartManually = vi.fn();
    const handlers = { onResumeCurrentStep, onImportResume, onStartManually };
    mountSummary(
      buildSummaryProps({
        hasImportedResume,
        reviewItemCount,
        optionalReviewItemCount,
        isImportResumePending,
        actionMessage,
        importDisabledReason,
        isProfileSetupPending,
      }),
      handlers,
    );

    return handlers;
  }

  function listButtons(): HTMLButtonElement[] {
    const currentContainer = getContainerOrThrow();
    return Array.from(currentContainer.querySelectorAll("button")).filter(
      (element): element is HTMLButtonElement =>
        element instanceof HTMLButtonElement,
    );
  }

  function dispatchClick(button: HTMLButtonElement): MouseEvent {
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(event);
    return event;
  }

  it("uses truthful neutral language before any resume analysis", () => {
    const { onImportResume, onResumeCurrentStep, onStartManually } =
      renderSummary(false, 0);

    expect(container?.textContent).toContain(
      "Start with the resume you already have.",
    );
    expect(container?.textContent).toContain("asks only about the gaps");
    expect(container?.textContent).toContain(
      "sent to Job Finder's AI to fill in your profile",
    );
    // The AI-provider statement appears once, and the legal-style employer
    // footer no longer competes with the first decision on this screen.
    expect(container?.textContent).not.toContain("Employer access stays off");
    expect(container?.textContent).not.toContain("connected in Settings");
    expect(container?.textContent).not.toContain("in good shape");
    // The recommended import choice names the file-picker affordance while
    // keeping formats and review truth visible.
    expect(
      [...getContainerOrThrow().querySelectorAll("button")].map(
        (button) => button.textContent,
      ),
    ).toEqual([
      "Recommended. Choose my resume filePDF, DOCX, TXT, or Markdown. You review everything before it is used.Scanned image PDFs have no readable text.",
      "Enter details manuallyBegin with contact details and target roles; add the rest when it becomes useful.Start manually",
    ]);

    act(() => {
      const buttons = listButtons();
      const importButton = getButtonOrThrow(buttons, 0);
      const manualButton = getButtonOrThrow(buttons, 1);
      importButton.click();
      manualButton.click();
    });
    expect(onImportResume).toHaveBeenCalledTimes(1);
    expect(onStartManually).toHaveBeenCalledTimes(1);
    expect(onResumeCurrentStep).not.toHaveBeenCalled();
  });

  it("renders nothing but the step editor once setup has started", () => {
    // The separate readiness strip is gone: the stepper chips carry per-step
    // counts and the sticky footer states whether setup can finish, so no
    // screenshot of setup can show two different totals.
    mountSummary(
      buildSummaryProps({ hasImportedResume: true, reviewItemCount: 0 }),
      {
        onImportResume: vi.fn(),
        onResumeCurrentStep: vi.fn(),
        onStartManually: vi.fn(),
      },
    );

    expect(getContainerOrThrow().textContent).toBe("");
    expect(
      getContainerOrThrow().querySelector(
        "[data-profile-setup-readiness-cards]",
      ),
    ).toBeNull();
  });

  it("prepares recovery up front for files without readable text", () => {
    renderSummary(false, 0);

    const text = container?.textContent ?? "";

    // A persisted import can end in needs_text; the caveat now sits with the
    // file picker as one short hint instead of inside the intro paragraph.
    expect(text).toContain("Scanned image PDFs have no readable text");
    // The recovery path itself (manual entry) sits beside the import card;
    // the note only needs to name the limitation.
  });

  it("explains commitments with plain language and compact effort framing", () => {
    renderSummary(false, 0);

    const text = container?.textContent ?? "";

    // No dangling internal references before steps have been introduced.
    expect(text).not.toContain("enabled in Targeting");
    expect(text).not.toContain("follows your configured provider");
    expect(text).toContain("One public job page for Job Finder to search");

    // Effort framing stays compact: total size plus recoverability, without
    // enumerating individual steps before the first choice is made.
    expect(text).toContain("Five short steps, saved as you go");
    expect(text).toContain("Stop after any step and pick up later");
    expect(text).not.toContain("in this order");

    // Legal-style disclaimers are gone from the first screen.
    expect(text).not.toContain("not a promise of job results");
  });

  it("keeps manual setup available while the native resume picker is pending", () => {
    const { onImportResume, onStartManually } = renderSummary(
      false,
      0,
      0,
      true,
    );
    const buttons = listButtons();

    expect(buttons).toHaveLength(2);
    // Pending keeps both controls exposed and focusable instead of flipping
    // them to native disabled (which would drop focus mid-import).
    expect(buttons.every((button) => !button.hasAttribute("disabled"))).toBe(
      true,
    );
    expect(buttons[0]?.getAttribute("aria-disabled")).toBe("true");
    // A picker wait has no processing progress yet, so manual setup remains a
    // recovery path if the local pending lifecycle becomes stale.
    expect(buttons[1]?.getAttribute("aria-disabled")).toBeNull();
    expect(buttons[0]?.textContent).toContain("File browser open…");
    expect(buttons[1]?.textContent).toContain(
      "If the file browser does not return, continue here",
    );
    const importButton = getButtonOrThrow(buttons, 0);
    const manualButton = getButtonOrThrow(buttons, 1);
    expect(importButton.getAttribute("aria-busy")).toBe("true");
    expect(manualButton.getAttribute("aria-busy")).toBeNull();
    expect(onImportResume).not.toHaveBeenCalled();
    expect(onStartManually).not.toHaveBeenCalled();

    act(() => {
      dispatchClick(importButton);
      dispatchClick(manualButton);
    });
    expect(onImportResume).not.toHaveBeenCalled();
    expect(onStartManually).toHaveBeenCalledTimes(1);
  });

  it("R3-163 lets the person stop a processing import and start manually", () => {
    const onResumeCurrentStep = vi.fn();
    const onImportResume = vi.fn();
    const onStartManually = vi.fn();
    mountSummary(
      buildSummaryProps({
        hasImportedResume: false,
        reviewItemCount: 0,
        isImportResumePending: true,
        resumeImportProgress: {
          stage: "reading_document",
          message: "Reading the selected resume.",
          occurredAt: "2026-08-30T10:00:00.000Z",
        },
      }),
      { onResumeCurrentStep, onImportResume, onStartManually },
    );

    const buttons = listButtons();
    const manualButton = getButtonOrThrow(buttons, 1);
    expect(manualButton.getAttribute("aria-disabled")).toBeNull();
    expect(manualButton.textContent).toContain(
      "Stop import and start manually",
    );
    act(() => {
      dispatchClick(manualButton);
    });
    expect(onStartManually).toHaveBeenCalledOnce();
  });

  it("keeps focus on the import control across the pending transition and restores activation", () => {
    const onResumeCurrentStep = vi.fn();
    const onImportResume = vi.fn();
    const onStartManually = vi.fn();
    const handlers = { onResumeCurrentStep, onImportResume, onStartManually };

    mountSummary(
      buildSummaryProps({ hasImportedResume: false, reviewItemCount: 0 }),
      handlers,
    );
    const buttonsBefore = listButtons();
    const importButton = getButtonOrThrow(buttonsBefore, 0);
    const manualButton = getButtonOrThrow(buttonsBefore, 1);

    act(() => {
      importButton.focus();
      manualButton.focus();
    });
    expect(document.activeElement).toBe(manualButton);

    act(() => {
      getRootOrThrow().render(
        <ProfileSetupSummaryCards
          {...buildSummaryProps({
            hasImportedResume: false,
            reviewItemCount: 0,
            isImportResumePending: true,
          })}
          onImportResume={onImportResume}
          onStartManually={onStartManually}
        />,
      );
    });

    // The busy transition must not throw keyboard focus back to <body>.
    expect(document.activeElement).toBe(manualButton);
    expect(manualButton.hasAttribute("disabled")).toBe(false);
    expect(
      importButton.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      ),
    ).toBe(false);
    expect(onImportResume).not.toHaveBeenCalled();
    act(() => {
      dispatchClick(manualButton);
    });
    expect(onStartManually).toHaveBeenCalledTimes(1);

    act(() => {
      getRootOrThrow().render(
        <ProfileSetupSummaryCards
          {...buildSummaryProps({
            hasImportedResume: false,
            reviewItemCount: 0,
          })}
          onImportResume={onImportResume}
          onStartManually={onStartManually}
        />,
      );
    });

    expect(manualButton.getAttribute("aria-disabled")).toBeNull();
    expect(manualButton.getAttribute("aria-busy")).toBeNull();
    act(() => {
      manualButton.click();
    });
    expect(onStartManually).toHaveBeenCalledTimes(2);
  });

  it("associates the visible import guard reason with the import control", () => {
    const reason =
      "Save your current profile or setup draft before importing so those unsaved edits do not get overwritten.";
    const { onImportResume, onStartManually } = renderSummary(
      false,
      0,
      0,
      false,
      null,
      reason,
    );
    const buttons = listButtons();
    const importButton = getButtonOrThrow(buttons, 0);
    const manualButton = getButtonOrThrow(buttons, 1);

    // A hard import guard keeps native disabled semantics.
    expect(importButton.disabled).toBe(true);
    expect(manualButton.hasAttribute("disabled")).toBe(false);

    const describedById = importButton.getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    const describedElement = describedById
      ? document.getElementById(describedById)
      : null;
    if (!describedElement) {
      throw new Error("Expected aria-describedby element to exist");
    }
    expect(describedElement.textContent).toBe(reason);

    act(() => {
      importButton.click();
      manualButton.click();
    });
    expect(onImportResume).not.toHaveBeenCalled();
    expect(onStartManually).toHaveBeenCalledTimes(1);
  });

  it("prefers pending semantics over the hard guard so in-flight imports keep focus", () => {
    renderSummary(
      false,
      0,
      0,
      true,
      null,
      "Save your current profile or setup draft before importing.",
    );
    const buttons = listButtons();
    const importButton = getButtonOrThrow(buttons, 0);

    expect(importButton.hasAttribute("disabled")).toBe(false);
    expect(importButton.getAttribute("aria-disabled")).toBe("true");
    expect(importButton.getAttribute("aria-busy")).toBe("true");
    expect(importButton.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("stops rendering entirely once setup has started, in every state", () => {
    // Nothing survives the entry card: no review count, no readiness value,
    // no action message pinned to the step the user has already reached.
    for (const props of [
      buildSummaryProps({ hasImportedResume: true, reviewItemCount: 2 }),
      {
        ...buildSummaryProps({ hasImportedResume: true, reviewItemCount: 0 }),
        actionMessage: "Saved.",
      },
      {
        ...buildSummaryProps({ hasImportedResume: true, reviewItemCount: 0 }),
        profileSetupState: {
          ...buildSummaryProps({ hasImportedResume: true, reviewItemCount: 0 })
            .profileSetupState,
          status: "completed" as const,
          completedAt: "2026-08-30T10:00:00.000Z",
        },
      },
    ]) {
      mountSummary(props, {
        onImportResume: vi.fn(),
        onResumeCurrentStep: vi.fn(),
        onStartManually: vi.fn(),
      });

      expect(getContainerOrThrow().textContent).toBe("");
      expect(getContainerOrThrow().querySelectorAll("button")).toHaveLength(0);

      act(() => getRootOrThrow().unmount());
      root = null;
      container?.remove();
      container = null;
    }
  });
});
