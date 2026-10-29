import { describe, expect, test } from "vitest";
import {
  ResumeImportFieldCandidateSummarySchema,
  ResumeImportRunSchema,
} from "@nestor/contracts";
import {
  getVisibleYearsExperience,
  getRunningResumeImportProgress,
} from "./profile-resume-panel-utils";

describe("profile resume panel utils", () => {
  test("does not present unreviewed years as a saved experience total", () => {
    const yearsCandidate = ResumeImportFieldCandidateSummarySchema.parse({
      id: "years_candidate",
      target: { section: "identity", key: "yearsExperience", recordId: null },
      label: "Years of experience",
      value: 7,
      valuePreview: "7 years",
      evidenceText: "7+ years",
      confidence: 0.82,
      resolution: "needs_review",
      resolutionReason: null,
      notes: [],
    });

    expect(
      getVisibleYearsExperience({
        profileYearsExperience: null,
        reviewCandidates: [yearsCandidate],
      }),
    ).toBeNull();
  });

  test("prefers canonical years of experience when already saved", () => {
    const yearsCandidate = ResumeImportFieldCandidateSummarySchema.parse({
      id: "years_candidate",
      target: { section: "identity", key: "yearsExperience", recordId: null },
      label: "Years of experience",
      value: 7,
      valuePreview: "7 years",
      evidenceText: "7+ years",
      confidence: 0.82,
      resolution: "needs_review",
      resolutionReason: null,
      notes: [],
    });

    expect(
      getVisibleYearsExperience({
        profileYearsExperience: 10,
        reviewCandidates: [yearsCandidate],
      }),
    ).toBe(10);
  });

  test("estimates years only from confirmed experience dates", () => {
    const experienceCandidates = [
      ResumeImportFieldCandidateSummarySchema.parse({
        id: "experience_candidate_1",
        target: {
          section: "experience",
          key: "record",
          recordId: "experience_1",
        },
        label: "Senior Software Engineer at Mercury",
        value: {
          companyName: "Mercury",
          title: "Senior Software Engineer",
          startDate: "Aug 2024",
          endDate: "",
          isCurrent: true,
        },
        valuePreview: "Mercury | Senior Software Engineer | Aug 2024",
        evidenceText: "Aug 2024 – Present",
        confidence: 0.84,
        resolution: "needs_review",
        resolutionReason: null,
        notes: [],
      }),
      ResumeImportFieldCandidateSummarySchema.parse({
        id: "experience_candidate_2",
        target: {
          section: "experience",
          key: "record",
          recordId: "experience_2",
        },
        label: "Software Engineer at Leif",
        value: {
          companyName: "Leif",
          title: "Software Engineer",
          startDate: "Jun 2018",
          endDate: "Jul 2021",
          isCurrent: false,
        },
        valuePreview: "Leif | Software Engineer | Jun 2018 | Jul 2021",
        evidenceText: "Jun 2018 – Jul 2021",
        confidence: 0.84,
        resolution: "needs_review",
        resolutionReason: null,
        notes: [],
      }),
    ];

    expect(
      getVisibleYearsExperience({
        profileYearsExperience: null,
        reviewCandidates: experienceCandidates,
      }),
    ).toBeNull();
    const confirmedCandidates = experienceCandidates.map((candidate) => ({
      ...candidate,
      resolution: "auto_applied" as const,
      resolutionReason: "review_confirmed",
    }));
    expect(
      getVisibleYearsExperience({
        profileYearsExperience: 0,
        reviewCandidates: confirmedCandidates,
        today: new Date(Date.UTC(2026, 3, 15)),
      }),
    ).toBe(4);
  });

  test("parses slash dates and does not double count overlapping jobs", () => {
    const overlappingCandidates = [
      ResumeImportFieldCandidateSummarySchema.parse({
        id: "experience_candidate_overlap_1",
        target: {
          section: "experience",
          key: "record",
          recordId: "experience_1",
        },
        label: "Lead Engineer at Company A",
        value: {
          companyName: "Company A",
          title: "Lead Engineer",
          startDate: "01/2020",
          endDate: "12/2021",
          isCurrent: false,
        },
        valuePreview: "Company A | Lead Engineer | 01/2020 | 12/2021",
        evidenceText: "01/2020 – 12/2021",
        confidence: 0.84,
        resolution: "auto_applied",
        resolutionReason: "review_confirmed",
        notes: [],
      }),
      ResumeImportFieldCandidateSummarySchema.parse({
        id: "experience_candidate_overlap_2",
        target: {
          section: "experience",
          key: "record",
          recordId: "experience_2",
        },
        label: "Consultant at Company B",
        value: {
          companyName: "Company B",
          title: "Consultant",
          startDate: "07/2021",
          endDate: "06/2022",
          isCurrent: false,
        },
        valuePreview: "Company B | Consultant | 07/2021 | 06/2022",
        evidenceText: "07/2021 – 06/2022",
        confidence: 0.84,
        resolution: "auto_applied",
        resolutionReason: "review_confirmed",
        notes: [],
      }),
      ResumeImportFieldCandidateSummarySchema.parse({
        id: "experience_candidate_gap",
        target: {
          section: "experience",
          key: "record",
          recordId: "experience_3",
        },
        label: "Engineer at Company C",
        value: {
          companyName: "Company C",
          title: "Engineer",
          startDate: "08/2022",
          endDate: "07/2023",
          isCurrent: false,
        },
        valuePreview: "Company C | Engineer | 08/2022 | 07/2023",
        evidenceText: "08/2022 – 07/2023",
        confidence: 0.84,
        resolution: "auto_applied",
        resolutionReason: "review_confirmed",
        notes: [],
      }),
    ];

    expect(
      getVisibleYearsExperience({
        profileYearsExperience: 0,
        reviewCandidates: overlappingCandidates,
      }),
    ).toBe(3);
  });
});

test("unknown years stay empty", () => {
  expect(
    getVisibleYearsExperience({
      profileYearsExperience: null,
      reviewCandidates: [],
    }),
  ).toBeNull();
});

test.each(["queued", "parsing", "extracting", "reconciling"] as const)(
  "R2-050 restores progress from persisted %s state",
  (status) => {
    const run = ResumeImportRunSchema.parse({
      id: "running",
      sourceResumeId: "synthetic",
      sourceResumeFileName: "synthetic.txt",
      trigger: "import",
      status,
      startedAt: "2026-10-02T10:00:00.000Z",
    });
    expect(getRunningResumeImportProgress(run)?.stage).toBe(
      status === "reconciling"
        ? "saving_results"
        : status === "extracting"
          ? "building_profile"
          : "reading_document",
    );
    expect(
      getRunningResumeImportProgress({ ...run, status: "failed" }),
    ).toBeNull();
    expect(
      getRunningResumeImportProgress({ ...run, status: "applied" }),
    ).toBeNull();
  },
);

for (const status of ["applied", "review_ready"] as const) {
  test(`deferred vision and adjudication keep ${status} imports active`, () => {
    for (const role of ["vision", "adjudication"] as const) {
      const run = ResumeImportRunSchema.parse({
        id: "deferred",
        sourceResumeId: "synthetic",
        sourceResumeFileName: "three-page.pdf",
        trigger: "import",
        status,
        startedAt: "2026-10-29T00:00:00Z",
        modelRoles: { [role]: { status: "running" } },
      });
      expect(getRunningResumeImportProgress(run)?.stage).toBe("saving_results");
      const settled = ResumeImportRunSchema.parse({
        ...run,
        modelRoles: { [role]: { status: "completed" } },
      });
      expect(getRunningResumeImportProgress(settled)).toBeNull();
    }
  });
}
