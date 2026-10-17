// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { JobFinderResumeWorkspaceSchema } from "@nestor/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createApplyQueueDemoState } from "../../../../../../main/adapters/job-finder-demo-state";
import { ResumeWorkspaceSidebar } from "./resume-workspace-sidebar";

const profileSummary =
  "I build durable workflow systems by pairing careful product discovery with accessible interaction design, measurable delivery practices, and cross-functional leadership across complex regulated environments without losing the candidate's original context.";
const screeningSummary =
  "Sponsorship is available for qualified candidates after a complete review of role alignment, location constraints, and the specific long-term needs of the platform organization.";
const proofClaim =
  "Led the redesign of a mission-critical operations platform from research through rollout, preserving auditability while reducing completion time for every regional team and documenting the complete measurable outcome.";
const researchTitle =
  "How the platform organization approaches resilient workflow architecture, inclusive product delivery, and long-term customer partnerships across regulated industries";
const unbrokenCue = `Architecture${"X".repeat(180)}`;

function buildWorkspace() {
  const state = createApplyQueueDemoState();
  const job = state.savedJobs.find((entry) => entry.id === "job_ready");
  const draft = state.resumeDrafts.find((entry) => entry.jobId === "job_ready");

  if (!job || !draft) {
    throw new Error("Expected the ready resume workspace demo fixture.");
  }

  return JobFinderResumeWorkspaceSchema.parse({
    job: {
      ...job,
      keywordSignals: [
        { id: "signal_1", label: "Systems design" },
        { id: "signal_2", label: "Product discovery" },
        { id: "signal_3", label: "Accessibility" },
        { id: "signal_4", label: unbrokenCue },
      ],
      responsibilities: [
        "Lead platform strategy",
        "Partner across functions",
        "Preserve complete responsibility context",
      ],
      minimumQualifications: ["Ten years of workflow design experience"],
      screeningHints: {
        ...job.screeningHints,
        sponsorshipText: screeningSummary,
      },
    },
    draft,
    research: [
      {
        id: "research_long_context",
        jobId: job.id,
        sourceUrl: "https://example.com/research/platform-organization",
        pageTitle: researchTitle,
        fetchedAt: "2026-08-23T12:00:00.000Z",
        fetchStatus: "success",
      },
    ],
    sharedProfile: {
      narrativeSummary: profileSummary,
      highlightedProofs: [
        {
          id: "proof_long_context",
          title: "Workflow transformation",
          claim: proofClaim,
          heroMetric: "42 percent faster completion across every regional team",
        },
      ],
    },
  });
}

describe("ResumeWorkspaceSidebar", () => {
  afterEach(cleanup);

  it("renders complete semantic context and wraps long values", () => {
    const { container } = render(
      <ResumeWorkspaceSidebar
        hasUnsavedChanges={false}
        workspace={buildWorkspace()}
      />,
    );
    const renderedText = container.textContent ?? "";

    expect(
      screen.getByText(profileSummary).classList.contains("break-words"),
    ).toBe(true);
    expect(screen.getByText(proofClaim).classList.contains("break-words")).toBe(
      true,
    );
    expect(
      screen.getByText(researchTitle).classList.contains("break-words"),
    ).toBe(true);
    expect(renderedText).toContain(screeningSummary);
    expect(renderedText).toContain(unbrokenCue);
    expect(renderedText).toContain("Preserve complete responsibility context");
    expect(renderedText).toContain("Ten years of workflow design experience");
  });
});
