import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JobFinderResumeWorkspaceStrategyContextSchema } from "@nestor/contracts";
import { ResumeStrategyContextPanel } from "./resume-strategy-context-panel";

describe("ResumeStrategyContextPanel", () => {
  it("renders nothing when no strategy context exists so the editor stays primary", () => {
    const markup = renderToStaticMarkup(
      <ResumeStrategyContextPanel context={null} />,
    );

    expect(markup).toBe("");
  });

  it("still names the global default when no strategy is selected", () => {
    const markup = renderToStaticMarkup(
      <ResumeStrategyContextPanel
        context={null}
        effectiveTailoringStrength="aggressive"
      />,
    );

    expect(markup).toContain("Your default:");
    expect(markup).toContain("Aggressive: may stretch, with your say-so");
    expect(markup).toContain("clear screening for a first interview");
  });

  it("keeps strategy context as a collapsed advisory accordion with safety copy", () => {
    const context = JobFinderResumeWorkspaceStrategyContextSchema.parse({
      recommendedStrategyId: "strategy_signals",
      recommendedStrategyName: "Signal-first tailoring",
      recommendationSource: "role_family",
      recommendationReason: "Matches the systems-designer role family.",
      roleFamily: "systems_design",
    });
    const markup = renderToStaticMarkup(
      <ResumeStrategyContextPanel context={context} />,
    );

    expect(markup).toContain("<details");
    expect(markup).not.toContain("<details open");
    expect(markup).toContain("Resume approach");
    expect(markup).toContain("Advisory only");
    expect(markup).toContain("Signal-first tailoring");
  });

  it("rewords a legacy persisted strategy reason to approach wording for display only", () => {
    const context = JobFinderResumeWorkspaceStrategyContextSchema.parse({
      selectedStrategyId: "strategy_legacy",
      selectedStrategyName: "Legacy tailoring",
      selectionSource: "user",
      selectionReason: 'User chose strategy "Legacy tailoring" for this job.',
      selectedAt: "2026-08-20T10:00:00.000Z",
    });
    const markup = renderToStaticMarkup(
      <ResumeStrategyContextPanel context={context} />,
    );

    expect(markup).toContain(
      "User chose approach &quot;Legacy tailoring&quot;",
    );
    expect(markup).not.toContain("chose strategy");
  });

  it("names the global default when a strategy is present but does not set a strength", () => {
    const context = JobFinderResumeWorkspaceStrategyContextSchema.parse({
      recommendedStrategyId: null,
      recommendedStrategyName: null,
      recommendationSource: "none",
      recommendationReason: "No match.",
    });
    const markup = renderToStaticMarkup(
      <ResumeStrategyContextPanel
        context={context}
        effectiveTailoringStrength="aggressive"
      />,
    );

    expect(markup).toContain("Your default:");
    expect(markup).toContain("Aggressive: may stretch, with your say-so");
  });
});
