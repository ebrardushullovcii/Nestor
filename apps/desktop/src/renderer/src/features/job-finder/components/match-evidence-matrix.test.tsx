// @vitest-environment jsdom

import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { MatchAssessmentSchema } from "@nestor/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { MatchEvidenceMatrix } from "./match-evidence-matrix";

afterEach(cleanup);

function buildAssessment(
  requirements: ReadonlyArray<Record<string, unknown>>,
): ReturnType<typeof MatchAssessmentSchema.parse> {
  return MatchAssessmentSchema.parse({
    scorerVersion: 6,
    contextFingerprint: null,
    postingFingerprint: null,
    score: 58,
    reasons: [],
    gaps: [],
    recommendation: "review_before_applying",
    recommendationRationale: "Review the listing before applying.",
    requirements,
  });
}

describe("MatchEvidenceMatrix required-gap summary", () => {
  it("labels a truncated capture as partial listing text", () => {
    const assessment = MatchAssessmentSchema.parse({
      ...buildAssessment([]),
      dimensions: {
        evidenceConfidence: {
          level: "moderate",
          explanation: "Some listing evidence was available.",
          evidence: [
            {
              source: "listing",
              label: "Listing detail depth",
              detail: "partial detail",
            },
          ],
        },
      },
    });
    const view = render(<MatchEvidenceMatrix assessment={assessment} />);

    expect(view.getByText("Scored from partial listing text.")).toBeTruthy();
    expect(view.queryByText("The full listing detail was available.")).toBeNull();
  });

  it("reads as a grammatical sentence for one and for several gaps", () => {
    const gap = (id: string) => ({
      id,
      category: "skill",
      label: `Skill ${id}`,
      importance: "required",
      status: "missing",
      jobEvidence: "Required by the listing.",
      resumeEvidence: [],
      explanation: "No matching resume evidence was located.",
    });

    const single = render(
      <MatchEvidenceMatrix assessment={buildAssessment([gap("one")])} />,
    );
    expect(
      within(single.container).getByText(
        "1 required item still needs evidence or conflicts with your profile.",
      ),
    ).toBeTruthy();
    cleanup();

    const several = render(
      <MatchEvidenceMatrix
        assessment={buildAssessment([gap("one"), gap("two")])}
      />,
    );
    expect(
      within(several.container).getByText(
        "2 required items still need evidence or conflict with your profile.",
      ),
    ).toBeTruthy();
  });
});

describe("MatchEvidenceMatrix", () => {
  it("shows five plain-language dimensions and keeps detailed evidence behind a disclosure", () => {
    const assessment = MatchAssessmentSchema.parse({
      scorerVersion: 3,
      contextFingerprint: null,
      postingFingerprint: null,
      score: 63,
      compensationFit: {
        state: "below_minimum",
        confidence: "high",
        minimumSalaryUsd: 120_000,
        listingMinimumAnnualUsd: 95_000,
        listingCurrency: "USD",
        explanation: "The listing minimum is below the saved USD minimum.",
      },
      dimensions: {
        roleSuitability: {
          state: "conflict",
          explanation: "The listing belongs to a different saved role family.",
          evidence: [
            {
              source: "listing",
              label: "Listing title",
              detail: "Account Executive",
            },
          ],
        },
        preferenceAlignment: {
          state: "mixed",
          explanation: "The location aligns, but the work mode does not.",
          evidence: [
            {
              source: "preference",
              label: "Work-mode comparison",
              detail: "On-site compared with remote.",
            },
          ],
        },
        applicationEffort: {
          level: "low",
          explanation: "The listing exposes an in-platform application path.",
          evidence: [
            {
              source: "listing",
              label: "Application path",
              detail: "easy apply",
            },
          ],
        },
        evidenceConfidence: {
          level: "high",
          explanation:
            "The detailed listing supports most extracted comparisons; this is evidence coverage, not hiring confidence.",
          evidence: [
            {
              source: "derived",
              label: "Requirement supportability",
              detail: "2 of 2 requirements have explicit evidence.",
            },
          ],
          supportedCount: 1,
          missingCount: 1,
        },
      },
      reasons: ["The role title matches."],
      gaps: ["FastAPI is not present."],
      recommendation: "skip",
      recommendationRationale:
        "A hard role conflict needs review before this job is considered.",
      requirements: [
        {
          id: "requirement_skill_python",
          category: "skill",
          label: "Python",
          importance: "required",
          status: "supported",
          jobEvidence: "Production Python experience is required.",
          resumeEvidence: [
            {
              sourceKind: "experience",
              sourceId: "experience_1",
              label: "Senior Engineer at Example",
              detail: "Built Python automation services.",
            },
          ],
          explanation: "The resume contains explicit Python evidence.",
        },
        {
          id: "requirement_skill_fastapi",
          category: "skill",
          label: "FastAPI",
          importance: "required",
          status: "missing",
          jobEvidence: "Production FastAPI experience is required.",
          resumeEvidence: [],
          explanation: "No FastAPI evidence was found.",
        },
      ],
    });

    const view = render(<MatchEvidenceMatrix assessment={assessment} />);
    const region = view.getByRole("region", { name: "Score and evidence" });
    const terms = within(region)
      .getAllByRole("term")
      .map((term) => term.textContent);

    expect(terms).toEqual([
      "Role and requirements",
      "Your preferences",
      "Compensation",
      "Application effort",
      "How much could be checked",
    ]);
    expect(
      within(view.getByTestId("fit-dimension-role-suitability")).getByText(
        "Role conflict",
      ),
    ).toBeTruthy();
    expect(
      within(view.getByTestId("fit-dimension-application-effort")).getByText(
        "Lower effort",
      ),
    ).toBeTruthy();
    expect(
      within(view.getByTestId("fit-dimension-compensation")).getByText(
        "Below minimum",
      ),
    ).toBeTruthy();
    expect(
      within(view.getByTestId("fit-dimension-evidence-confidence")).getByText(
        "High coverage",
      ),
    ).toBeTruthy();
    expect(
      view.getByText(
        /1 required item still needs evidence or conflicts with your profile\./,
      ),
    ).toBeTruthy();
    expect(view.queryByTestId("legacy-fit-summary")).toBeNull();

    const dimensions = view.getByTestId("fit-dimensions");
    expect(dimensions.className).toContain("min-w-0");
    expect(dimensions.className).not.toContain("grid-cols");

    const summary = view.getByRole("button", {
      name: "Review requirement evidence — 1 of 2 supported",
    });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    const disclosure = summary.parentElement!;
    expect(
      within(disclosure).getByText(
        /Production FastAPI experience is required\./,
      ),
    ).toBeTruthy();
    expect(
      within(disclosure).getByText("Built Python automation services."),
    ).toBeTruthy();
  });

  it("shows saved legacy reasons and gaps when detailed evidence is unavailable", () => {
    const assessment = MatchAssessmentSchema.parse({
      score: 52,
      reasons: ["The saved profile includes relevant frontend experience."],
      gaps: ["The listing asks for GraphQL evidence that was not found."],
    });
    const view = render(
      <MatchEvidenceMatrix
        assessment={assessment}
        showRecommendation={false}
      />,
    );
    const summary = view.getByTestId("legacy-fit-summary");

    expect(
      within(summary).getByText(
        "The saved profile includes relevant frontend experience.",
      ),
    ).toBeTruthy();
    expect(
      within(summary).getByText(
        "The listing asks for GraphQL evidence that was not found.",
      ),
    ).toBeTruthy();
    expect(within(summary).getByText("Why it may fit")).toBeTruthy();
    expect(within(summary).getByText("Questions to review")).toBeTruthy();
  });

  it("drops every uninformative dimension instead of printing five unknowns", () => {
    const assessment = MatchAssessmentSchema.parse({ score: 52 });
    const view = render(
      <MatchEvidenceMatrix
        assessment={assessment}
        showRecommendation={false}
      />,
    );

    // Nothing was checked, so nothing is claimed: the five UNKNOWN /
    // NOT REQUESTED / UNAVAILABLE cards that restated the title-only note in
    // ~900px are gone, replaced by one line.
    for (const dimension of [
      "role-suitability",
      "preference-alignment",
      "compensation",
      "application-effort",
      "evidence-confidence",
    ]) {
      expect(view.queryByTestId(`fit-dimension-${dimension}`)).toBeNull();
    }
    expect(view.queryByTestId("fit-dimensions")).toBeNull();
    // The app exposes no external-URL action anywhere in renderer or preload,
    // so this line must not promise one. It names the action that does exist,
    // matching the title-only note's wording.
    expect(view.getByTestId("fit-dimensions-empty").textContent).toBe(
      "Nothing else has been checked yet. Copy the listing link to check the role, preference, pay, and evidence details.",
    );
    expect(view.getByTestId("fit-dimensions-empty").textContent).not.toContain(
      "Open the listing",
    );
    expect(view.queryByText("Strong fit")).toBeNull();
    // The hedge itself still appears exactly once, at the top.
    expect(view.getByTestId("fit-title-only-note").textContent).toBe(
      "The AI judges each job against your profile and goals after a search. Choose Judge fit to do this one now.",
    );
    expect(view.getByText("Score and evidence")).toBeTruthy();
    expect(
      view.queryByText(
        "Requirement-by-requirement evidence is unavailable for this listing.",
      ),
    ).toBeNull();
  });

  it("keeps the plain heading and no provisional note once a check succeeded", () => {
    const assessment = MatchAssessmentSchema.parse({
      score: 64,
      judgment: {
        source: "batch",
        judgedAt: "2026-10-02T10:00:00.000Z",
        score: 64,
        recommendation: "review_before_applying",
      },
      dimensions: {
        roleSuitability: {
          state: "exact",
          explanation: "Matches a saved target role.",
          evidence: [],
        },
      },
    });
    const view = render(
      <MatchEvidenceMatrix
        assessment={assessment}
        showRecommendation={false}
      />,
    );

    expect(view.queryByTestId("fit-title-only-note")).toBeNull();
    expect(view.getByText("Score and evidence")).toBeTruthy();
    expect(view.getByTestId("fit-breakdown-score").textContent).toBe("64% fit");
  });
});

describe("MatchEvidenceMatrix requirement rows", () => {
  it("collapses requirements with no evidence on either side into one sentence", () => {
    // The panel found the disclosure full of rows that named a requirement
    // and then said nothing about it: no listing quote, no resume evidence.
    const assessment = buildAssessment([
      {
        id: "skill_excel",
        category: "skill",
        label: "Excel",
        importance: "required",
        status: "unknown",
        jobEvidence: "The listing text was not captured.",
        resumeEvidence: [],
        explanation: "The listing text was not captured.",
      },
      {
        id: "skill_workday",
        category: "skill",
        label: "Workday",
        importance: "preferred",
        status: "unknown",
        jobEvidence: "The listing text was not captured.",
        resumeEvidence: [],
        explanation: "The listing text was not captured.",
      },
      {
        id: "skill_figma",
        category: "skill",
        label: "Figma",
        importance: "required",
        status: "supported",
        jobEvidence: "Figma is used daily.",
        resumeEvidence: [],
        explanation: "The resume shows Figma evidence.",
      },
    ]);

    const { container } = render(<MatchEvidenceMatrix assessment={assessment} />);
    fireEvent.click(
      within(container).getByRole("button", {
        name: "Review requirement evidence — 1 of 3 supported",
      }),
    );

    expect(
      within(container).getByTestId("fit-requirements-unchecked").textContent,
    ).toBe(
      "2 requirements were not checked — Excel, Workday. Neither the listing nor your resume gave anything to compare.",
    );
    // The one requirement that does carry evidence keeps its full row.
    expect(within(container).getByText("Figma")).toBeTruthy();
    expect(within(container).queryByText("Excel")).toBeNull();
    // The count above the disclosure still describes every requirement.
    expect(
      within(container).getByText(
        "Review requirement evidence — 1 of 3 supported",
      ),
    ).toBeTruthy();
  });
});
