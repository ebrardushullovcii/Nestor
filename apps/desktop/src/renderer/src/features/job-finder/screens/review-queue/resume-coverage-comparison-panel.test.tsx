// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResumeCoverageComparison } from "@nestor/contracts";
import { buildResumeCoverageComparisonRows } from "./resume-coverage-comparison-rows";
import { ResumeCoverageComparisonPanel } from "./resume-coverage-comparison-panel";

const baseComparison: ResumeCoverageComparison = {
  originalRoleCount: 1,
  representedRoleCount: 1,
  visibleRoleCount: 1,
  rewrittenRoleCount: 0,
  compactedRoleCount: 0,
  hiddenRoleCount: 0,
  missingRoleCount: 0,
  reorderedRoleCount: 0,
  addedClaimCount: 0,
  removedClaimCount: 0,
  duplicateIssueCount: 0,
  addedKeywords: [],
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
      status: "unchanged",
      included: true,
      reordered: false,
      originalIndex: 0,
      tailoredIndex: 0,
      originalClaimCount: 1,
      retainedClaimCount: 1,
      addedClaims: [],
      removedClaims: [],
      reasons: [],
    },
  ],
};

describe("ResumeCoverageComparisonPanel", () => {
  afterEach(cleanup);

  it("uses a full-strength focus ring so the disclosure stays >=3:1 in both themes", () => {
    // Audit: ring-primary/50 at 50% composites to ~2.03:1 on #c9cdd1 light and
    // 2.09:1 on #29313a dark — below WCAG 2.4.11 3:1. Full --ring is proven
    // >=3:1 in both themes by styles/globals.test.ts, so the <summary> must
    // bind to that token at full strength. Non-focus borders stay unchanged.
    const { container } = render(
      <ResumeCoverageComparisonPanel
        comparison={baseComparison}
        disabled={false}
        onRestoreClaim={vi.fn()}
        onRestoreRole={vi.fn()}
      />,
    );

    const summary = container.querySelector("summary");
    expect(summary).toBeTruthy();
    expect(summary?.className).toContain("focus-visible:ring-2");
    expect(summary?.className).toContain("focus-visible:ring-ring");
    expect(summary?.className).not.toMatch(/ring-primary\/\d/);
    // Ensure we didn't accidentally promote decorative borders.
    expect(container.innerHTML).toContain(
      "border border-(--surface-panel-border)",
    );
  });

  it("renders the summary with the full-strength ring class", () => {
    const { container } = render(
      <ResumeCoverageComparisonPanel
        comparison={baseComparison}
        disabled={false}
        onRestoreClaim={vi.fn()}
        onRestoreRole={vi.fn()}
      />,
    );

    const summary = container.querySelector("summary");
    expect(summary).toBeTruthy();
    expect(summary?.className).toContain("focus-visible:ring-2");
    expect(summary?.className).toContain("focus-visible:ring-ring");
    expect(summary?.className).not.toMatch(/ring-primary\/\d/);
  });
  it("gives every dropped line its own labelled Restore control", () => {
    const removedClaim = {
      field: "bullet" as const,
      text: "Developed internal tools and customer-facing pages with ASP.NET MVC.",
      restorable: true,
    };
    const onRestoreClaim = vi.fn();
    const { container } = render(
      <ResumeCoverageComparisonPanel
        comparison={{
          ...baseComparison,
          removedClaimCount: 1,
          roles: [
            {
              ...baseComparison.roles[0]!,
              status: "compacted",
              removedClaims: [removedClaim],
            },
          ],
        }}
        disabled={false}
        onRestoreClaim={onRestoreClaim}
        onRestoreRole={vi.fn()}
      />,
    );

    // Restore used to render inline at the end of the sentence, so it read as
    // the last word of the dropped line rather than an action.
    const restore = screen.getByRole("button", {
      name: `Restore this line: ${removedClaim.text}`,
    });
    const claimParagraph = within(container).getByText(
      `− ${removedClaim.text}`,
    );

    expect(claimParagraph.contains(restore)).toBe(false);
    expect(restore.closest("div")?.className).toContain("justify-end");

    fireEvent.click(restore);
    expect(onRestoreClaim).toHaveBeenCalledTimes(1);
  });
});

describe("reworded lines in the coverage comparison", () => {
  afterEach(cleanup);

  const comparisonWithRewording: ResumeCoverageComparison = {
    ...baseComparison,
    removedClaimCount: 3,
    addedClaimCount: 2,
    roles: [
      {
        ...baseComparison.roles[0]!,
        status: "rewritten",
        originalClaimCount: 3,
        retainedClaimCount: 0,
        addedClaims: [
          {
            field: "bullet",
            text: "Led the payments platform migration and cut checkout latency by 40 percent.",
            restorable: false,
          },
        ],
        removedClaims: [
          {
            field: "bullet",
            text: "Led the payments platform migration.",
            restorable: true,
          },
          {
            field: "bullet",
            text: "Cut checkout latency by 40 percent.",
            restorable: true,
          },
          {
            field: "bullet",
            text: "Mentored two interns through their first release.",
            restorable: true,
          },
        ],
      },
    ],
  };

  it("counts only lines with no wording left on the page", () => {
    render(
      <ResumeCoverageComparisonPanel
        comparison={comparisonWithRewording}
        disabled={false}
        onRestoreClaim={vi.fn()}
        onRestoreRole={vi.fn()}
      />,
    );

    // Two of the three originals were merged into one sentence that is on the
    // page; only the mentoring line is genuinely gone.
    expect(screen.getByText("1 line removed")).toBeTruthy();
    expect(screen.queryByText("3 lines removed")).toBeNull();
  });

  it("pairs a merged rewrite into one before/after row and never lists it as missing", () => {
    render(
      <ResumeCoverageComparisonPanel
        comparison={comparisonWithRewording}
        disabled={false}
        onRestoreClaim={vi.fn()}
        onRestoreRole={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Before: Led the payments platform migration."),
    ).toBeTruthy();
    expect(
      screen.getByText("Before: Cut checkout latency by 40 percent."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Now: Led the payments platform migration and cut checkout latency by 40 percent.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("− Mentored two interns through their first release."),
    ).toBeTruthy();
    // The reworded originals never appear under the "not on the page" list.
    expect(
      screen.queryByText("− Led the payments platform migration."),
    ).toBeNull();
  });
});

describe("lines the tailored resume moved to another role", () => {
  afterEach(cleanup);

  it("does not call a line missing when it is on the page under another role", () => {
    const movedLine =
      "Mentored two interns through their first production release.";
    const comparison: ResumeCoverageComparison = {
      ...baseComparison,
      removedClaimCount: 1,
      addedClaimCount: 1,
      roles: [
        {
          ...baseComparison.roles[0]!,
          status: "rewritten",
          originalClaimCount: 1,
          retainedClaimCount: 0,
          addedClaims: [],
          removedClaims: [
            { field: "bullet", text: movedLine, restorable: true },
          ],
        },
        {
          ...baseComparison.roles[0]!,
          profileRecordId: "experience_second",
          title: "Staff Engineer",
          employer: "Northwind",
          originalIndex: 1,
          status: "rewritten",
          originalClaimCount: 0,
          retainedClaimCount: 0,
          addedClaims: [
            { field: "bullet", text: movedLine, restorable: false },
          ],
          removedClaims: [],
        },
      ],
    };

    render(
      <ResumeCoverageComparisonPanel
        comparison={comparison}
        disabled={false}
        onRestoreClaim={vi.fn()}
        onRestoreRole={vi.fn()}
      />,
    );

    expect(screen.queryByText("1 line removed")).toBeNull();
    expect(screen.queryByText(`− ${movedLine}`)).toBeNull();
  });
});

it("pairs a translated or bilingual achievement by source identity without word overlap", () => {
  const result = buildResumeCoverageComparisonRows({
    addedClaims: [
      {
        field: "bullet",
        text: "Kommissionierfehler um 38 % reduziert.",
        restorable: false,
        sourceAchievementIds: ["achievement:0"],
      },
    ],
    removedClaims: [
      {
        field: "bullet",
        text: "Reduced picking errors 38%.",
        restorable: true,
        sourceAchievementIds: ["achievement:0"],
      },
    ],
  });
  expect(result).toMatchObject({
    removedLineCount: 0,
    addedLineCount: 0,
    rewordedLineCount: 1,
  });
  expect(result.rows[0]?.kind).toBe("reworded");
});

it("pairs translated lines by source even when their wording has no overlap", () => {
  const rows = buildResumeCoverageComparisonRows({
    removedClaims: [
      {
        field: "bullet",
        text: "Managed customer orders",
        restorable: true,
        sourceAchievementIds: ["experience:role:achievement:0"],
      },
    ],
    addedClaims: [
      {
        field: "bullet",
        text: "Bearbeitung von Kundenaufträgen",
        restorable: false,
        sourceAchievementIds: ["experience:role:achievement:0"],
      },
    ],
  });
  expect(rows.removedLineCount).toBe(0);
  expect(rows.addedLineCount).toBe(0);
  expect(rows.rows[0]?.kind).toBe("reworded");
});
