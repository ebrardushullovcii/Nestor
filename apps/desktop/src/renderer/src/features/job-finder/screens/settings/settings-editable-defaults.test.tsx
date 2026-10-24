// @vitest-environment jsdom

import { act } from "react";
import type {
  JobFinderSettings,
  ResumeTemplateDefinition,
} from "@nestor/contracts";
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
import { SettingsEditableDefaults } from "./settings-editable-defaults";
import { getApplySafeguardCopy } from "./settings-runtime-summary";
import type { JobFinderSaveState } from "@renderer/pages/job-finder-save-state";

function makeResumeTemplate(
  overrides: Partial<ResumeTemplateDefinition> &
    Pick<ResumeTemplateDefinition, "id" | "label">,
): ResumeTemplateDefinition {
  return {
    familyId: "chronology_classic",
    familyLabel: "Chronology Classic",
    familyDescription: "Calm ATS-safe layouts.",
    variantLabel: "Recruiter Standard",
    description:
      "Single-column, conservative, and recruiter-friendly for high parsing reliability.",
    fitSummary: "A clean all-rounder.",
    avoidSummary: "Less distinctive for project-led portfolios.",
    bestFor: ["General applications", "Recruiter-heavy funnels"],
    visualTags: ["Minimal", "Balanced"],
    density: "balanced",
    deliveryLane: "apply_safe",
    atsConfidence: "high",
    applyEligible: true,
    approvalEligible: true,
    benchmarkEligible: true,
    sortOrder: 10,
    ...overrides,
  };
}

const idleSaveState = {
  state: "idle",
  version: 0,
} satisfies JobFinderSaveState;

const resumeTemplateFixtures = {
  classicAts: makeResumeTemplate({
    id: "classic_ats",
    label: "Chronology Classic",
  }),
  compactExec: makeResumeTemplate({
    id: "compact_exec",
    label: "Senior Brief",
    familyId: "senior_brief",
    familyLabel: "Senior Brief",
    familyDescription: "Leadership-oriented ATS-safe layouts.",
    variantLabel: "Dense Timeline",
    description:
      "Single-column, tighter spacing, and still ATS-safe for concise two-page submissions.",
    fitSummary: "Good for dense senior resumes.",
    avoidSummary: "Can feel tight for early-career profiles.",
    bestFor: ["Experienced candidates", "Content-dense resumes"],
    visualTags: ["Dense", "Centered header"],
    density: "compact",
    sortOrder: 20,
  }),
} satisfies Record<string, ResumeTemplateDefinition>;

describe("SettingsEditableDefaults", () => {
  const globalScope = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const originalActEnvironment = globalScope.IS_REACT_ACT_ENVIRONMENT;
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

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

  it("shows available ATS-safe templates and the selected template description", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <SettingsEditableDefaults
          actionMessage={null}
          availableResumeTemplates={[
            resumeTemplateFixtures.classicAts,
            resumeTemplateFixtures.compactExec,
          ]}
          isSavePending={false}
          onSaveSettings={vi.fn()}
          saveState={idleSaveState}
          settings={{
            resumeFormat: "pdf",
            resumeTemplateId: "compact_exec",
            fontPreset: "inter_requisite",
            appearanceTheme: "system",
            humanReviewRequired: true,
            allowAutoSubmitOverride: false,
            keepSessionAlive: false,
            discoveryOnly: false,
          }}
        />,
      );
    });

    expect(container?.textContent).toContain("Default resume template");
    expect(container?.textContent).toContain("Senior Brief");
    expect(container?.textContent).toContain(
      "Single-column, tighter spacing, and still ATS-safe for concise two-page submissions.",
    );
    expect(container?.textContent).toContain("Dense Timeline");
    expect(container?.textContent).toContain("Apply-safe");
    expect(container?.textContent).toContain("Default template picker");
    expect(container?.textContent).toContain("Applies to new drafts");
    expect(container?.textContent).toContain(
      "The preview uses sample resume content rendered through the same template engine used for exports.",
    );
  });

  it("keeps nested default controls shrinkable at narrow CSS widths", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <SettingsEditableDefaults
          actionMessage={null}
          availableResumeTemplates={[resumeTemplateFixtures.classicAts]}
          isSavePending={false}
          onSaveSettings={vi.fn()}
          saveState={idleSaveState}
          settings={{
            resumeFormat: "pdf",
            resumeTemplateId: "classic_ats",
            fontPreset: "inter_requisite",
            appearanceTheme: "system",
            humanReviewRequired: true,
            allowAutoSubmitOverride: false,
            keepSessionAlive: false,
            discoveryOnly: false,
          }}
        />,
      );
    });

    const panel = container.firstElementChild;
    const modeGroup = container.querySelector('[role="radiogroup"]');
    const previewFrame = container.querySelector("iframe");
    const selectTriggers = [
      ...container.querySelectorAll('[data-slot="select-trigger"]'),
    ];

    expect(panel?.className).toContain("min-w-0");
    expect(modeGroup?.className).toContain("min-w-0");
    expect(selectTriggers.length).toBeGreaterThan(0);
    expect(
      selectTriggers.every((trigger) => trigger.className.includes("min-w-0")),
    ).toBe(true);
    expect(previewFrame?.className).toContain("min-w-0");
    expect(
      container.querySelector("[data-resume-preview-box]")?.className,
    ).toContain("max-w-");
    expect(previewFrame?.parentElement?.className).toContain("min-w-0");
  });

  it("disables form controls and marks save as pending while saving", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <SettingsEditableDefaults
          actionMessage={null}
          availableResumeTemplates={[resumeTemplateFixtures.classicAts]}
          isSavePending
          onSaveSettings={vi.fn()}
          saveState={idleSaveState}
          settings={{
            resumeFormat: "pdf",
            resumeTemplateId: "classic_ats",
            fontPreset: "inter_requisite",
            appearanceTheme: "system",
            humanReviewRequired: true,
            allowAutoSubmitOverride: false,
            keepSessionAlive: false,
            discoveryOnly: false,
          }}
        />,
      );
    });

    expect(container?.textContent).toContain("Default resume template");
    expect(container?.textContent).toContain("Chronology Classic");

    const button = Array.from(container?.querySelectorAll("button") ?? []).find(
      (element) => element.textContent?.trim() === "Save settings",
    );
    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(button?.getAttribute("data-pending")).toBe("true");

    // Pending keeps the save control exposed but inert instead of natively
    // disabled, so focus survives the in-flight save.
    expect(button?.hasAttribute("disabled")).toBe(false);
    expect(button?.getAttribute("aria-disabled")).toBe("true");

    const disabledNonSaveControls = Array.from(
      container?.querySelectorAll("button, input, select, textarea") ?? [],
    ).filter(
      (element) =>
        element !== button &&
        (element.hasAttribute("disabled") ||
          element.getAttribute("aria-disabled") === "true"),
    );
    expect(disabledNonSaveControls.length).toBeGreaterThan(0);
  });

  it("saves original-resume mode as an explicit application workflow choice", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onSaveSettings = vi.fn();

    act(() => {
      root?.render(
        <SettingsEditableDefaults
          actionMessage={null}
          availableResumeTemplates={[resumeTemplateFixtures.classicAts]}
          isSavePending={false}
          onSaveSettings={onSaveSettings}
          saveState={idleSaveState}
          settings={{
            resumeFormat: "pdf",
            resumeTemplateId: "classic_ats",
            fontPreset: "inter_requisite",
            appearanceTheme: "system",
            humanReviewRequired: true,
            allowAutoSubmitOverride: false,
            keepSessionAlive: false,
            discoveryOnly: false,
          }}
        />,
      );
    });

    const originalCvChoice = Array.from(
      container.querySelectorAll("button"),
    ).find((button) =>
      button.textContent?.includes("Use my original resume unchanged"),
    );
    expect(originalCvChoice?.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Saved default");

    act(() => originalCvChoice?.click());

    expect(originalCvChoice?.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("Selected · save to apply");
    expect(container.textContent).toContain(
      "You have unsaved settings changes.",
    );
    expect(container.textContent).toContain(
      "Save this preference before leaving Settings.",
    );
    const nearbySaveButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "Save resume preference");
    expect(nearbySaveButton?.hasAttribute("disabled")).toBe(false);
    act(() => nearbySaveButton?.click());

    expect(onSaveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ resumeApplicationMode: "original_resume" }),
    );
    expect(container.textContent).toContain(
      "preserves the imported file byte for byte",
    );
  });

  it("saves the complete staged form from the nearby resume control and reports typed save truth", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onSaveSettings = vi.fn();
    const settings: JobFinderSettings = {
      resumeFormat: "pdf" as const,
      resumeTemplateId: "classic_ats",
      fontPreset: "inter_requisite" as const,
      appearanceTheme: "system" as const,
      humanReviewRequired: true,
      allowAutoSubmitOverride: false,
      keepSessionAlive: false,
      discoveryOnly: false,
    };
    const render = (
      saveState: JobFinderSaveState,
      isSavePending = false,
      persistedSettings = settings,
    ) => {
      act(() => {
        root?.render(
          <SettingsEditableDefaults
            actionMessage={
              saveState.state === "idle" ? null : saveState.message
            }
            availableResumeTemplates={[resumeTemplateFixtures.classicAts]}
            isSavePending={isSavePending}
            onSaveSettings={onSaveSettings}
            saveState={saveState}
            settings={persistedSettings}
          />,
        );
      });
    };

    render(idleSaveState);

    const originalCvChoice = Array.from(
      container.querySelectorAll("button"),
    ).find((button) =>
      button.textContent?.includes("Use my original resume unchanged"),
    );
    const keepBrowserOpen = container.querySelector<HTMLElement>(
      '[role="switch"][aria-describedby]',
    );

    act(() => {
      originalCvChoice?.click();
      keepBrowserOpen?.click();
    });

    render(idleSaveState, false, { ...settings });

    expect(originalCvChoice?.getAttribute("aria-checked")).toBe("true");
    expect(keepBrowserOpen?.getAttribute("aria-checked")).toBe("true");

    const nearbySaveButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "Save resume preference");
    expect(nearbySaveButton?.hasAttribute("disabled")).toBe(false);

    act(() => nearbySaveButton?.click());

    expect(onSaveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        keepSessionAlive: true,
        resumeApplicationMode: "original_resume",
      }),
    );

    render(
      {
        state: "saving",
        version: 1,
        attempt: 1,
        surface: "settings",
        label: "Settings",
        message: "Saving settings…",
        canRetry: false,
      },
      true,
    );

    expect(container.textContent).toContain("Saving resume preference");
    expect(
      container.querySelector('[data-settings-save-state="saving"]')
        ?.textContent,
    ).toContain("Saving settings");
    expect(
      Array.from(container.querySelectorAll("button"))
        .find((button) =>
          button.textContent?.includes("Saving resume preference"),
        )
        ?.getAttribute("aria-busy"),
    ).toBe("true");

    render({
      state: "failed",
      version: 1,
      attempt: 1,
      surface: "settings",
      label: "Settings",
      message: "Settings were not saved. Retry before leaving this page.",
      canRetry: true,
    });

    const retryButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Retry resume preference",
    );
    expect(retryButton?.hasAttribute("disabled")).toBe(false);
    expect(
      container.querySelector('[data-settings-save-state="failed"]')
        ?.textContent,
    ).toContain("Settings were not saved");

    render(
      {
        state: "saved",
        version: 1,
        attempt: 2,
        surface: "settings",
        label: "Settings",
        message: "Settings saved. Your exact imported resume is now used.",
        canRetry: false,
      },
      false,
      {
        ...settings,
        keepSessionAlive: true,
        resumeApplicationMode: "original_resume",
      },
    );

    const savedButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Resume preference saved",
    );
    expect(savedButton?.hasAttribute("disabled")).toBe(true);
    expect(
      container.querySelector('[data-settings-save-state="saved"]')
        ?.textContent,
    ).toContain("exact imported resume");
  });

  it("shows original-resume mode as the saved default after persistence", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <SettingsEditableDefaults
          actionMessage="Settings saved. Newly shortlisted jobs will start with your original resume unchanged."
          availableResumeTemplates={[resumeTemplateFixtures.classicAts]}
          isSavePending={false}
          onSaveSettings={vi.fn()}
          saveState={idleSaveState}
          settings={{
            resumeFormat: "pdf",
            resumeTemplateId: "classic_ats",
            fontPreset: "inter_requisite",
            appearanceTheme: "system",
            humanReviewRequired: true,
            allowAutoSubmitOverride: false,
            keepSessionAlive: false,
            discoveryOnly: false,
            resumeApplicationMode: "original_resume",
          }}
        />,
      );
    });

    const originalCvChoice = Array.from(
      container.querySelectorAll("button"),
    ).find((button) =>
      button.textContent?.includes("Use my original resume unchanged"),
    );
    expect(originalCvChoice?.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("Saved default · no rewriting");
    expect(container.textContent).toContain(
      "Original resume is the saved application default.",
    );
    expect(container.textContent).toContain("Newly shortlisted jobs");
    expect(
      Array.from(container.querySelectorAll("button"))
        .find(
          (button) => button.textContent?.trim() === "Save resume preference",
        )
        ?.hasAttribute("disabled"),
    ).toBe(true);
  });
  it("describes original-resume safety without requiring a tailored PDF", () => {
    const copy = getApplySafeguardCopy(true);
    expect(copy.title).toBe("Original resume required");
    expect(copy.description).toContain("exact imported resume");
    expect(copy.description).toContain(
      "Sending follows the mode you choose under Applying.",
    );
  });
});
