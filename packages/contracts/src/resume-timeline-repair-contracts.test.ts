import { describe, expect, test } from "vitest";

import {
  JobFinderResumeTimelineRepairActionInputSchema,
  ResumeTimelineRepairProposalSchema,
  ResumeImportRunSchema,
} from "./index";

const experience = {
  id: "experience_1",
  companyName: "Acme",
  companyUrl: null,
  title: "Engineer",
  employmentType: null,
  location: null,
  workMode: [],
  startDate: "2024-06",
  endDate: "2023-01",
  isCurrent: false,
  isDraft: false,
  summary: null,
  achievements: [],
  skills: [],
  domainTags: [],
  peopleManagementScope: null,
  ownershipScope: null,
};

describe("resume timeline repair contracts", () => {
  test("parses evidence-cited reversible proposals and action history", () => {
    const proposal = ResumeTimelineRepairProposalSchema.parse({
      id: "timeline_repair_reversed_experience_1",
      runId: "resume_import_run_1",
      issueKind: "reversed_dates",
      status: "accepted",
      certainty: "deterministic_normalization",
      title: "Review reversed dates for Engineer at Acme",
      explanation: "The extracted start date is later than the extracted end date.",
      affectedExperienceIds: ["experience_1"],
      beforeExperiences: [experience],
      proposedExperiences: [
        { ...experience, startDate: "2023-01", endDate: "2024-06" },
      ],
      evidence: [
        {
          candidateId: "candidate_experience_1",
          sourceBlockIds: ["block_7"],
          excerpt: "Engineer, Acme | Jun 2024 - Jan 2023",
        },
      ],
      createdAt: "2026-07-31T10:00:00.000Z",
      resolvedAt: "2026-07-31T10:01:00.000Z",
      actionHistory: [
        { action: "accept", occurredAt: "2026-07-31T10:01:00.000Z" },
      ],
    });

    expect(proposal.proposedExperiences[0]?.startDate).toBe("2023-01");
    expect(proposal.evidence[0]?.sourceBlockIds).toEqual(["block_7"]);
  });

  test("parses only typed workspace actions", () => {
    expect(
      JobFinderResumeTimelineRepairActionInputSchema.parse({
        runId: "resume_import_run_1",
        proposalId: "timeline_repair_reversed_experience_1",
        action: "accept",
      }),
    ).toEqual({
      runId: "resume_import_run_1",
      proposalId: "timeline_repair_reversed_experience_1",
      action: "accept",
    });
    expect(() =>
      JobFinderResumeTimelineRepairActionInputSchema.parse({
        runId: "resume_import_run_1",
        proposalId: "timeline_repair_reversed_experience_1",
        action: "submit",
      }),
    ).toThrow();
  });

  test("defaults legacy import runs to an empty proposal ledger", () => {
    const run = ResumeImportRunSchema.parse({
      id: "resume_import_run_legacy",
      sourceResumeId: "resume_1",
      sourceResumeFileName: "resume.pdf",
      trigger: "import",
      status: "review_ready",
      startedAt: "2026-07-31T10:00:00.000Z",
      completedAt: "2026-07-31T10:01:00.000Z",
      primaryParserKind: null,
      parserKinds: [],
      warnings: [],
      errorMessage: null,
      candidateCounts: {},
    });

    expect(run.timelineRepairProposals ?? []).toEqual([]);
  });

  test("rejects proposals without source evidence", () => {
    expect(() =>
      ResumeTimelineRepairProposalSchema.parse({
        id: "timeline_repair_missing_evidence",
        runId: "resume_import_run_1",
        issueKind: "missing_employer",
        status: "pending",
        certainty: "review_only",
        title: "Review missing employer",
        explanation: "The employer was not extracted.",
        affectedExperienceIds: ["experience_1"],
        beforeExperiences: [experience],
        proposedExperiences: [experience],
        evidence: [],
        createdAt: "2026-07-31T10:00:00.000Z",
        resolvedAt: null,
        actionHistory: [],
      }),
    ).toThrow();
  });
});