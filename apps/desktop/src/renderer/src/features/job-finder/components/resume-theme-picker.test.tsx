// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ResumeTemplateDefinition } from "@nestor/contracts";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  buildResumeThemePickerRecommendations,
  ResumeThemePicker,
  type ResumeThemePickerRecommendationContext,
} from "./resume-theme-picker";

const themes: readonly ResumeTemplateDefinition[] = [
  {
    id: "classic_ats",
    label: "Chronology Classic",
    familyId: "chronology_classic",
    familyLabel: "Chronology Classic",
    familyDescription: "Calm ATS-safe layouts.",
    variantLabel: "Recruiter Standard",
    description:
      "Single-column, conservative, and recruiter-friendly for high parsing reliability.",
    fitSummary: "A clean all-rounder.",
    avoidSummary: "Less distinctive for project-led portfolios.",
    bestFor: ["General applications"],
    visualTags: ["Minimal", "Balanced"],
    density: "balanced",
    deliveryLane: "apply_safe",
    atsConfidence: "high",
    applyEligible: true,
    approvalEligible: true,
    benchmarkEligible: true,
    sortOrder: 10,
  },
  {
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
    bestFor: ["Experienced candidates"],
    visualTags: ["Dense", "Centered header"],
    density: "compact",
    deliveryLane: "apply_safe",
    atsConfidence: "high",
    applyEligible: true,
    approvalEligible: true,
    benchmarkEligible: true,
    sortOrder: 20,
  },
  {
    id: "technical_matrix",
    label: "Engineering Spec",
    familyId: "engineering_spec",
    familyLabel: "Engineering Spec",
    familyDescription: "Spec-like ATS-safe layouts.",
    variantLabel: "Skills First",
    description:
      "Skills-forward single-column layout that highlights technical depth before chronology.",
    fitSummary: "Best when systems depth should land early.",
    avoidSummary: "Can feel too technical for generalist roles.",
    bestFor: ["Engineering roles"],
    visualTags: ["Skills matrix", "Technical"],
    density: "compact",
    deliveryLane: "apply_safe",
    atsConfidence: "high",
    applyEligible: true,
    approvalEligible: true,
    benchmarkEligible: true,
    sortOrder: 30,
  },
  {
    id: "project_showcase",
    label: "Proof Portfolio",
    familyId: "proof_portfolio",
    familyLabel: "Proof Portfolio",
    familyDescription: "Proof-led ATS-safe layouts.",
    variantLabel: "Projects First",
    description:
      "Project-forward single-column layout for candidates whose proof lands best through shipped work.",
    fitSummary: "Useful when shipped work is your strongest evidence.",
    avoidSummary: "Less ideal for conservative chronology-first screens.",
    bestFor: ["Portfolio-heavy candidates"],
    visualTags: ["Projects first", "Proof led"],
    density: "comfortable",
    deliveryLane: "apply_safe",
    atsConfidence: "high",
    applyEligible: true,
    approvalEligible: true,
    benchmarkEligible: true,
    sortOrder: 40,
  },
  {
    id: "credentials_focus",
    label: "Formal Proof",
    familyId: "credential_ledger",
    familyLabel: "Formal Proof",
    familyDescription: "Formal-proof ATS-safe layouts.",
    variantLabel: "Certs & Education",
    description:
      "Formal-proof single-column layout that surfaces certifications and education earlier without leaving ATS-safe structure.",
    fitSummary: "Stronger when credentials materially change recruiter trust.",
    avoidSummary: "Less effective if your strongest evidence is shipped work.",
    bestFor: ["Certification-heavy roles"],
    visualTags: ["Formal proof first", "Balanced"],
    density: "balanced",
    deliveryLane: "apply_safe",
    atsConfidence: "high",
    applyEligible: true,
    approvalEligible: true,
    benchmarkEligible: true,
    sortOrder: 50,
  },
];

function buildRecommendationContext(): ResumeThemePickerRecommendationContext {
  return {
    jobTitle: "Staff Frontend Engineer",
    jobKeywords: ["React", "TypeScript", "Accessibility", "Platform"],
    hasProjects: true,
    hasCertifications: false,
    hasFormalEducation: true,
    experienceEntryCount: 4,
    totalIncludedBulletCount: 12,
  };
}

describe("ResumeThemePicker", () => {
  const globalScope = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  const originalReactActEnvironment = globalScope.IS_REACT_ACT_ENVIRONMENT;

  beforeAll(() => {
    globalScope.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    if (originalReactActEnvironment === undefined) {
      delete globalScope.IS_REACT_ACT_ENVIRONMENT;
      return;
    }

    globalScope.IS_REACT_ACT_ENVIRONMENT = originalReactActEnvironment;
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

  it("builds deterministic recommendations from workspace context", () => {
    expect(
      buildResumeThemePickerRecommendations({
        recommendationContext: buildRecommendationContext(),
        themes,
      }),
    ).toEqual([
      expect.objectContaining({ templateId: "technical_matrix" }),
      expect.objectContaining({ templateId: "project_showcase" }),
      expect.objectContaining({ templateId: "compact_exec" }),
    ]);
  });

  it("supports recommended-only filtering in the catalog", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ResumeThemePicker
          onChange={vi.fn()}
          recommendationContext={buildRecommendationContext()}
          selectedThemeId="classic_ats"
          themes={themes}
        />,
      );
    });

    expect(container?.textContent).toContain("Current selection");
    expect(container?.textContent).toContain("Chronology Classic");
    expect(container?.textContent).toContain("Choose a template");
    expect(container?.textContent).toContain("Engineering Spec · Skills First");
    expect(container?.textContent).toContain("Recommended");
    expect(container?.textContent).toContain(
      "The preview below uses sample content, not your resume.",
    );
    const pickerGroup = container?.querySelector('[role="group"]');
    const pickerLabelId = pickerGroup?.getAttribute("aria-labelledby");
    expect(pickerLabelId).toBeTruthy();
    expect(container?.querySelector(`#${pickerLabelId}`)?.textContent).toBe(
      "Resume template",
    );
    expect(container?.querySelectorAll('[role="radio"]')).toHaveLength(0);
    const templateButtons = [
      ...(container?.querySelectorAll<HTMLButtonElement>(
        "[data-resume-template-select]",
      ) ?? []),
    ];
    expect(templateButtons).not.toHaveLength(0);
    expect(
      templateButtons.every(
        (button) =>
          button.getAttribute("aria-label")?.includes(" · ") &&
          button.hasAttribute("aria-pressed"),
      ),
    ).toBe(true);
    expect(
      new Set(
        templateButtons.map((button) => button.getAttribute("aria-label")),
      ).size,
    ).toBe(templateButtons.length);
  });
});
