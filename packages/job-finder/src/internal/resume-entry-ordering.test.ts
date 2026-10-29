import { describe, expect, test } from "vitest";
import type {
  ResumeDraftEntry,
  ResumeDraftSection,
} from "@nestor/contracts";
import {
  buildResumeEntryDateQualityIssues,
  moveSectionEntry,
  normalizeResumeDraftSectionEntryOrdering,
  orderEntriesNewestFirst,
  parseResumeEntryDateRange,
  resetSectionEntryOrderToChronology,
} from "./resume-entry-ordering";

const now = "2026-03-20T00:00:00.000Z";

function buildEntry(input: {
  id: string;
  dateRange?: string | null;
  included?: boolean;
  sortOrder: number;
  title?: string;
}): ResumeDraftEntry {
  return {
    id: input.id,
    entryType: "experience",
    title: input.title ?? input.id,
    subtitle: "Example Co",
    location: null,
    dateRange: input.dateRange ?? null,
    startDate: null,
    endDate: null,
    isCurrent: false,
    summary: `${input.id} summary`,
    bullets: [],
    origin: "imported",
    locked: false,
    included: input.included ?? true,
    sortOrder: input.sortOrder,
    profileRecordId: input.id,
    sourceRefs: [],
    updatedAt: now,
  };
}

function buildSection(
  entries: readonly ResumeDraftEntry[],
): ResumeDraftSection {
  return {
    id: "section_experience",
    kind: "experience",
    label: "Experience",
    text: null,
    bullets: [],
    entries: [...entries],
    origin: "imported",
    locked: false,
    included: true,
    sortOrder: 1,
    entryOrderMode: "chronology",
    profileRecordId: null,
    sourceRefs: [],
    updatedAt: now,
  };
}

describe("resume entry ordering", () => {
  test("parses common imported date ranges for ordering", () => {
    expect(parseResumeEntryDateRange("Jul 2023 - Present")).toMatchObject({
      hasParseableDate: true,
      isCurrent: true,
    });
    expect(parseResumeEntryDateRange("11/2021 - 07/2023")).toMatchObject({
      endMonth: 2023 * 12 + 6,
      startMonth: 2021 * 12 + 10,
    });
    expect(parseResumeEntryDateRange("Aug 2019 - Jan 2022")).toMatchObject({
      endMonth: 2022 * 12,
      startMonth: 2019 * 12 + 7,
    });
    expect(parseResumeEntryDateRange("01/11/2021 - 30/06/2023")).toMatchObject({
      endMonth: 2023 * 12 + 5,
      startMonth: 2021 * 12 + 10,
    });
    expect(
      parseResumeEntryDateRange("Jan 2020 through Feb 2021"),
    ).toMatchObject({
      endMonth: 2021 * 12 + 1,
      startMonth: 2020 * 12,
    });
    expect(parseResumeEntryDateRange(null)).toMatchObject({
      hasMissingDateRange: true,
      hasParseableDate: false,
    });
  });

  test("does not treat isCurrent alone as a structured date", () => {
    expect(
      parseResumeEntryDateRange({
        dateRange: null,
        startDate: null,
        endDate: null,
        isCurrent: true,
      }),
    ).toMatchObject({
      hasMissingDateRange: true,
      hasParseableDate: false,
      isCurrent: false,
    });
  });

  test("orders current roles first, then past roles newest first, and undated entries last", () => {
    const ordered = orderEntriesNewestFirst([
      buildEntry({
        id: "older",
        dateRange: "Aug 2019 - Jan 2022",
        sortOrder: 0,
      }),
      buildEntry({ id: "undated", dateRange: null, sortOrder: 1 }),
      buildEntry({
        id: "past_newer",
        dateRange: "11/2021 - 07/2023",
        sortOrder: 2,
      }),
      buildEntry({
        id: "past_day_month_year",
        dateRange: "01/11/2021 - 30/06/2023",
        sortOrder: 3,
      }),
      buildEntry({
        id: "same_date_alpha",
        dateRange: "Jan 2021 - Jan 2022",
        sortOrder: 4,
      }),
      buildEntry({
        id: "same_date_beta",
        dateRange: "Jan 2021 - Jan 2022",
        sortOrder: 5,
      }),
      buildEntry({
        id: "current_older_start",
        dateRange: "Jan 2022 - Present",
        sortOrder: 6,
      }),
      buildEntry({
        id: "current_newer_start",
        dateRange: "Jul 2023 - Present",
        sortOrder: 7,
      }),
    ]);

    expect(ordered.map((entry) => entry.id)).toEqual([
      "current_newer_start",
      "current_older_start",
      "past_newer",
      "past_day_month_year",
      "same_date_alpha",
      "same_date_beta",
      "older",
      "undated",
    ]);
    expect(ordered.map((entry) => entry.sortOrder)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  test("preserves manual ordering until reset to chronology", () => {
    const section = {
      ...buildSection([
        buildEntry({
          id: "current",
          dateRange: "2024 - Present",
          sortOrder: 0,
        }),
        buildEntry({ id: "past", dateRange: "2020 - 2021", sortOrder: 1 }),
      ]),
      entryOrderMode: "chronology" as const,
    };
    const moved = moveSectionEntry({
      anchorEntryId: "past",
      position: "after",
      section,
      targetEntryId: "current",
      updatedAt: "2026-03-20T10:03:00.000Z",
    });
    const normalizedManual = normalizeResumeDraftSectionEntryOrdering(moved);
    const reset = resetSectionEntryOrderToChronology(moved);

    expect(moved.entryOrderMode).toBe("manual");
    expect(normalizedManual.entries.map((entry) => entry.id)).toEqual([
      "past",
      "current",
    ]);
    expect(reset.entryOrderMode).toBe("chronology");
    expect(reset.entries.map((entry) => entry.id)).toEqual(["current", "past"]);
  });

  test("keeps hidden entries in their chronological slot when shown again", () => {
    const section = normalizeResumeDraftSectionEntryOrdering(
      buildSection([
        buildEntry({ id: "older", dateRange: "2018 - 2019", sortOrder: 0 }),
        buildEntry({
          id: "hidden_middle",
          dateRange: "2020 - 2021",
          included: false,
          sortOrder: 1,
        }),
        buildEntry({ id: "newer", dateRange: "2022 - 2023", sortOrder: 2 }),
      ]),
    );
    const shownAgain = normalizeResumeDraftSectionEntryOrdering({
      ...section,
      entries: section.entries.map((entry) =>
        entry.id === "hidden_middle" ? { ...entry, included: true } : entry,
      ),
    });

    expect(section.entries.map((entry) => entry.id)).toEqual([
      "newer",
      "hidden_middle",
      "older",
    ]);
    expect(shownAgain.entries.map((entry) => entry.id)).toEqual([
      "newer",
      "hidden_middle",
      "older",
    ]);
  });

  test("emits app-only date-quality issues for ambiguous chronology", () => {
    const draft = {
      id: "resume_draft_job_ready",
      jobId: "job_ready",
      status: "needs_review" as const,
      templateId: "classic_ats" as const,
      identity: null,
      sections: [
        buildSection([
          buildEntry({ id: "missing", dateRange: null, sortOrder: 0 }),
          buildEntry({
            id: "reversed",
            dateRange: "2024 - 2022",
            sortOrder: 1,
          }),
          buildEntry({
            id: "future",
            dateRange: "Jan 2030 - Dec 2030",
            sortOrder: 2,
          }),
          buildEntry({
            id: "current_a",
            dateRange: "2020 - Present",
            sortOrder: 3,
          }),
          buildEntry({
            id: "current_b",
            dateRange: "2021 - Present",
            sortOrder: 4,
          }),
        ]),
      ],
      targetPageCount: 2,
      generationMethod: "manual" as const,
      approvedAt: null,
      approvedExportId: null,
      staleReason: null,
      workHistoryReviewAcknowledgments: [],
      issueApprovals: [],
      createdAt: now,
      updatedAt: now,
    };

    const issueIds = buildResumeEntryDateQualityIssues(
      draft,
      new Date("2026-03-20T00:00:00.000Z"),
    ).map((issue) => issue.id);

    expect(issueIds).toEqual(
      expect.arrayContaining([
        "issue_date_missing_missing",
        "issue_date_reversed_reversed",
        "issue_date_future_future",
        "issue_date_duplicate_current_current_a",
        "issue_date_duplicate_current_current_b",
      ]),
    );
    expect(issueIds.some((id) => id.startsWith("issue_date_overlap_"))).toBe(
      true,
    );
  });

  describe("date-overlap tolerance for adjacent roles", () => {
    function buildOverlapDraft(ranges: readonly [string, string]) {
      return {
        id: "resume_draft_overlap",
        jobId: "job_overlap",
        status: "needs_review" as const,
        templateId: "classic_ats" as const,
        identity: null,
        sections: [
          buildSection([
            buildEntry({ id: "older", dateRange: ranges[0], sortOrder: 0 }),
            buildEntry({ id: "newer", dateRange: ranges[1], sortOrder: 1 }),
          ]),
        ],
        targetPageCount: 2,
        generationMethod: "manual" as const,
        approvedAt: null,
        approvedExportId: null,
        staleReason: null,
        workHistoryReviewAcknowledgments: [],
        issueApprovals: [],
        createdAt: now,
        updatedAt: now,
      };
    }

    function listOverlapIssueIds(ranges: readonly [string, string]) {
      return buildResumeEntryDateQualityIssues(
        buildOverlapDraft(ranges),
        new Date("2026-03-20T00:00:00.000Z"),
      )
        .map((issue) => issue.id)
        .filter((id) => id.startsWith("issue_date_overlap_"));
    }

    test("stays quiet when adjacent roles do not share any month", () => {
      expect(
        listOverlapIssueIds(["Nov 2019 - Nov 2021", "Dec 2021 - Feb 2026"]),
      ).toEqual([]);
    });

    test("stays quiet for a one-month handover boundary", () => {
      expect(
        listOverlapIssueIds(["Nov 2019 - Dec 2021", "Dec 2021 - Feb 2026"]),
      ).toEqual([]);
    });

    test("stays quiet when year-only roles meet in the same year", () => {
      expect(listOverlapIssueIds(["2019 - 2023", "2023 - Present"])).toEqual(
        [],
      );
    });

    test("flags year-only roles that run alongside each other for years", () => {
      expect(listOverlapIssueIds(["2018 - 2023", "2020 - Present"])).toEqual([
        "issue_date_overlap_older",
        "issue_date_overlap_newer",
      ]);
    });

    test("flags a genuine two-month concurrent stretch", () => {
      expect(
        listOverlapIssueIds(["Nov 2019 - Jan 2022", "Dec 2021 - Feb 2026"]),
      ).toEqual(["issue_date_overlap_older", "issue_date_overlap_newer"]);
    });
  });
});
