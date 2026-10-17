// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResumeTemplateDefinition } from "@nestor/contracts";
import { ResumeWorkspaceTemplatePanel } from "./resume-workspace-template-panel";

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
    id: "technical_matrix",
    label: "Engineering Spec",
    familyId: "engineering_spec",
    familyLabel: "Engineering Spec",
    familyDescription: "Spec-like ATS-safe layouts.",
    variantLabel: "Skills First",
    description: "Skills-forward single-column layout.",
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
    sortOrder: 20,
  },
];

function renderPanel(input?: {
  eligible?: boolean;
  onChange?: (templateId: string) => void;
}) {
  return render(
    <ResumeWorkspaceTemplatePanel
      disabled={false}
      recommendationContext={null}
      selectedTemplateApprovalEligible={input?.eligible ?? true}
      selectedThemeId="classic_ats"
      themes={themes}
      onChange={input?.onChange ?? vi.fn()}
    />,
  );
}

describe("ResumeWorkspaceTemplatePanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("collapses the chosen template to one summary row with a change action", () => {
    const { container } = renderPanel();

    expect(
      screen.getAllByText("Chronology Classic · Recruiter Standard").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("A clean all-rounder.").length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText("Apply-safe").length).toBeGreaterThan(0);
    // The header chip that repeated the row's own lane badge is gone; only
    // the blocking case still gets a header.
    expect(screen.queryByText("Cannot be used for applications")).toBeNull();

    const options = container.querySelector("#resume-template-chooser-options");
    expect(options?.className).toContain("hidden");

    const toggle = screen.getByRole("button", { name: "Change template" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("auto-opens and keeps the full chooser reachable when selection is blocked", () => {
    renderPanel({ eligible: false });

    expect(screen.getByText("Cannot be used for applications")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Change template" }),
    ).toBeNull();
    expect(screen.getByText("Choose a template")).toBeTruthy();
    expect(
      screen.getAllByRole("button", {
        name: "Selected template: Chronology Classic · Recruiter Standard",
      }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", {
        name: "Use template: Engineering Spec · Skills First",
      }).length,
    ).toBeGreaterThan(0);
    expect(
      document.querySelector("[data-resume-template-option]"),
    ).toBeTruthy();
  });

  it("expands on demand to the exact option hooks and collapses after a choice", () => {
    const onChange = vi.fn();
    const { container } = renderPanel({ onChange });

    fireEvent.click(screen.getByRole("button", { name: "Change template" }));

    expect(
      container.querySelector("#resume-template-chooser-options")?.className,
    ).not.toContain("hidden");
    const toggleAfterExpand = screen.getByRole("button", {
      name: "Hide choices",
    });
    expect(toggleAfterExpand.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getAllByRole("button", {
        name: "Use template: Engineering Spec · Skills First",
      }).length,
    ).toBeGreaterThan(0);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Use template: Engineering Spec · Skills First",
      }),
    );

    expect(onChange).toHaveBeenCalledWith("technical_matrix");
    expect(
      container.querySelector("#resume-template-chooser-options")?.className,
    ).toContain("hidden");
    expect(
      screen
        .getByRole("button", { name: "Change template" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });
});
