import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  CandidateProfileSchema,
  ResumeImportFieldCandidateSchema,
  ResumeImportRunSchema,
  type CandidateExperience,
  type ResumeImportFieldCandidate,
} from "@nestor/contracts";

import {
  applyResumeTimelineRepairAction,
  deriveResumeTimelineRepairProposals,
  persistResumeTimelineRepairAction,
} from "./resume-timeline-repair";
import { createJobFinderRepository, openJobStore } from "@nestor/db/job-store";
import { createSeededRepository } from "../profile-service.test-support";
import { createSeed } from "../test-fixtures";

function experience(
  id: string,
  overrides: Partial<CandidateExperience> = {},
): CandidateExperience {
  return {
    id,
    companyName: "Acme",
    companyUrl: null,
    title: "Engineer",
    employmentType: null,
    location: null,
    workMode: [],
    startDate: "2020-01",
    endDate: "2021-01",
    isCurrent: false,
    isDraft: false,
    summary: null,
    achievements: [],
    skills: [],
    domainTags: [],
    peopleManagementScope: null,
    ownershipScope: null,
    ...overrides,
  };
}

function candidate(
  record: CandidateExperience,
  index: number,
): ResumeImportFieldCandidate {
  return ResumeImportFieldCandidateSchema.parse({
    id: `candidate_${record.id}`,
    runId: "resume_import_run_timeline",
    target: { section: "experience", key: "record", recordId: record.id },
    label: record.title ?? record.companyName ?? `Experience ${index}`,
    sourceKind: "model_experience",
    value: record,
    normalizedValue: record,
    valuePreview: `${record.title ?? "Unknown title"} at ${record.companyName ?? "Unknown employer"}`,
    evidenceText: `Evidence ${index}: ${record.title ?? "[missing title]"} at ${record.companyName ?? "[missing employer]"} ${record.startDate ?? "[missing start]"} to ${record.endDate ?? "[missing end]"}`,
    sourceBlockIds: [`block_${index}`],
    confidence: 0.72,
    notes: [],
    alternatives: [],
    resolution: "needs_review",
    createdAt: "2026-07-31T10:00:00.000Z",
    resolvedAt: null,
  });
}

describe("resume timeline repair", () => {
  test("derives evidence-cited proposals for every planned timeline issue without inventing uncertain dates", () => {
    const records = [
      experience("reversed", { startDate: "2024-06", endDate: "2023-01" }),
      experience("ambiguous", { companyName: "Beta", startDate: "03/04/2020", endDate: "05/06/2021" }),
      experience("missing_employer", { companyName: null, title: "Designer", startDate: "2017-01", endDate: "2018-01" }),
      experience("missing_title", { companyName: "Gamma", title: null, startDate: "2018-03", endDate: "2019-03" }),
      experience("duplicate_a", { companyName: "Delta", title: "Lead", startDate: "2021-01", endDate: "2022-01", achievements: ["Led launch"] }),
      experience("duplicate_b", { companyName: "Delta", title: "Lead", startDate: "2021-01", endDate: "2022-01", achievements: ["Led launch"] }),
      experience("split_a", { companyName: "Echo", title: "Manager", startDate: "2022-02", endDate: "2023-02", achievements: ["Built team"] }),
      experience("split_b", { companyName: "Echo", title: "Manager", startDate: "2022-02", endDate: "2023-02", achievements: ["Shipped platform"] }),
      experience("early", { companyName: "Foxtrot", startDate: "2010-01", endDate: "2011-01" }),
      experience("late", { companyName: "Golf", startDate: "2013-01", endDate: "2014-01" }),
      experience("overlap", { companyName: "Hotel", startDate: "2013-06", endDate: "2015-01" }),
    ];

    const proposals = deriveResumeTimelineRepairProposals({
      runId: "resume_import_run_timeline",
      candidates: records.map(candidate),
      createdAt: "2026-07-31T10:01:00.000Z",
    });
    const issueKinds = new Set(proposals.map((proposal) => proposal.issueKind));

    expect(issueKinds).toEqual(
      new Set([
        "overlapping_dates",
        "timeline_gap",
        "ambiguous_dates",
        "reversed_dates",
        "split_record",
        "duplicate_record",
        "missing_employer",
        "missing_title",
      ]),
    );
    expect(proposals.every((proposal) => proposal.evidence.length > 0)).toBe(true);
    expect(
      proposals.every((proposal) =>
        proposal.evidence.every(
          (entry) => entry.candidateId && entry.excerpt && entry.sourceBlockIds.length > 0,
        ),
      ),
    ).toBe(true);

    const ambiguous = proposals.find(
      (proposal) => proposal.issueKind === "ambiguous_dates",
    );
    expect(ambiguous?.certainty).toBe("review_only");
    expect(ambiguous?.proposedExperiences).toEqual(ambiguous?.beforeExperiences);

    const reversed = proposals.find(
      (proposal) => proposal.issueKind === "reversed_dates",
    );
    expect(reversed?.certainty).toBe("deterministic_normalization");
    expect(reversed?.proposedExperiences[0]).toMatchObject({
      startDate: "2023-01",
      endDate: "2024-06",
    });
  });

  test("accepts, rejects, and undoes proposals independently", () => {
    const reversedRecord = experience("reversed", {
      startDate: "2024-06",
      endDate: "2023-01",
    });
    const missingEmployerRecord = experience("missing_employer", {
      companyName: null,
    });
    const proposals = deriveResumeTimelineRepairProposals({
      runId: "resume_import_run_timeline",
      candidates: [
        candidate(reversedRecord, 1),
        candidate(missingEmployerRecord, 2),
      ],
      createdAt: "2026-07-31T10:01:00.000Z",
    });
    const reversedProposal = proposals.find(
      (proposal) => proposal.issueKind === "reversed_dates",
    );
    const missingEmployerProposal = proposals.find(
      (proposal) => proposal.issueKind === "missing_employer",
    );
    expect(reversedProposal).toBeDefined();
    expect(missingEmployerProposal).toBeDefined();

    const profile = CandidateProfileSchema.parse({
      id: "candidate_1",
      firstName: "Casey",
      lastName: "Candidate",
      fullName: "Casey Candidate",
      headline: "Engineer",
      summary: "Engineer",
      currentLocation: "Remote",
      yearsExperience: 5,
      baseResume: {
        id: "resume_1",
        fileName: "resume.pdf",
        uploadedAt: "2026-07-31T09:00:00.000Z",
        storagePath: null,
        textContent: "Resume source text",
        textUpdatedAt: "2026-07-31T09:00:00.000Z",
        extractionStatus: "ready",
        lastAnalyzedAt: "2026-07-31T10:00:00.000Z",
        analysisProviderKind: "deterministic",
        analysisProviderLabel: "Deterministic",
        analysisWarnings: [],
      },
      experiences: [reversedRecord, missingEmployerRecord],
    });

    const accepted = applyResumeTimelineRepairAction({
      profile,
      proposals,
      proposalId: reversedProposal!.id,
      action: "accept",
      occurredAt: "2026-07-31T10:02:00.000Z",
    });
    expect(accepted.profile.experiences.find((entry) => entry.id === "reversed")).toMatchObject({
      startDate: "2023-01",
      endDate: "2024-06",
    });
    expect(accepted.proposals.find((entry) => entry.id === reversedProposal!.id)?.status).toBe("accepted");
    expect(accepted.proposals.find((entry) => entry.id === missingEmployerProposal!.id)?.status).toBe("pending");

    const rejected = applyResumeTimelineRepairAction({
      profile: accepted.profile,
      proposals: accepted.proposals,
      proposalId: missingEmployerProposal!.id,
      action: "reject",
      occurredAt: "2026-07-31T10:03:00.000Z",
    });
    expect(rejected.proposals.find((entry) => entry.id === missingEmployerProposal!.id)?.status).toBe("rejected");

    const undoRejected = applyResumeTimelineRepairAction({
      profile: rejected.profile,
      proposals: rejected.proposals,
      proposalId: missingEmployerProposal!.id,
      action: "undo",
      occurredAt: "2026-07-31T10:04:00.000Z",
    });
    expect(undoRejected.proposals.find((entry) => entry.id === missingEmployerProposal!.id)?.status).toBe("pending");

    const undoAccepted = applyResumeTimelineRepairAction({
      profile: undoRejected.profile,
      proposals: undoRejected.proposals,
      proposalId: reversedProposal!.id,
      action: "undo",
      occurredAt: "2026-07-31T10:05:00.000Z",
    });
    expect(undoAccepted.profile.experiences.find((entry) => entry.id === "reversed")).toMatchObject({
      startDate: "2024-06",
      endDate: "2023-01",
    });
    expect(undoAccepted.proposals.find((entry) => entry.id === reversedProposal!.id)?.status).toBe("pending");
    expect(undoAccepted.proposals.find((entry) => entry.id === reversedProposal!.id)?.actionHistory.map((entry) => entry.action)).toEqual(["accept", "undo"]);
  });

  test("refuses to overwrite a field changed after the proposal was created", () => {
    const record = experience("reversed", {
      startDate: "2024-06",
      endDate: "2023-01",
    });
    const proposals = deriveResumeTimelineRepairProposals({
      runId: "resume_import_run_timeline",
      candidates: [candidate(record, 1)],
      createdAt: "2026-07-31T10:01:00.000Z",
    });
    const proposal = proposals.find(
      (entry) => entry.issueKind === "reversed_dates",
    );
    const profile = CandidateProfileSchema.parse({
      id: "candidate_1",
      firstName: "Casey",
      lastName: "Candidate",
      fullName: "Casey Candidate",
      headline: "Engineer",
      summary: "Engineer",
      currentLocation: "Remote",
      yearsExperience: 5,
      baseResume: {
        id: "resume_1",
        fileName: "resume.pdf",
        uploadedAt: "2026-07-31T09:00:00.000Z",
        storagePath: null,
        textContent: "Resume source text",
        textUpdatedAt: "2026-07-31T09:00:00.000Z",
        extractionStatus: "ready",
        lastAnalyzedAt: "2026-07-31T10:00:00.000Z",
        analysisProviderKind: "deterministic",
        analysisProviderLabel: "Deterministic",
        analysisWarnings: [],
      },
      experiences: [{ ...record, startDate: "2022-01" }],
    });

    expect(() =>
      applyResumeTimelineRepairAction({
        profile,
        proposals,
        proposalId: proposal!.id,
        action: "accept",
        occurredAt: "2026-07-31T10:02:00.000Z",
      }),
    ).toThrow("changed after this timeline proposal was created");
  });
  test("persists accepted and undone proposal state with the profile across SQLite restart", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-timeline-repair-"),
    );
    const filePath = path.join(tempDirectory, "job-finder.sqlite");
    const record = experience("persisted_reversed", {
      startDate: "2024-06",
      endDate: "2023-01",
    });
    const sourceCandidate = candidate(record, 1);
    const proposals = deriveResumeTimelineRepairProposals({
      runId: "resume_import_run_timeline",
      candidates: [sourceCandidate],
      createdAt: "2026-07-31T10:01:00.000Z",
    });
    const proposal = proposals.find(
      (entry) => entry.issueKind === "reversed_dates",
    );
    expect(proposal).toBeDefined();
    const seed = createSeed();
    const profile = CandidateProfileSchema.parse({
      ...seed.profile,
      experiences: [record],
    });
    const run = ResumeImportRunSchema.parse({
      id: "resume_import_run_timeline",
      sourceResumeId: profile.baseResume.id,
      sourceResumeFileName: profile.baseResume.fileName,
      trigger: "import",
      status: "review_ready",
      startedAt: "2026-07-31T10:00:00.000Z",
      completedAt: "2026-07-31T10:01:00.000Z",
      primaryParserKind: null,
      parserKinds: [],
      warnings: [],
      errorMessage: null,
      candidateCounts: { total: 1, needsReview: 1 },
      timelineRepairProposals: proposals,
    });
    const repositorySeed = {
      ...seed,
      profile,
      resumeImportRuns: [run],
      resumeImportFieldCandidates: [sourceCandidate],
      resumeImportDocumentBundles: [],
    };
    let store = openJobStore(filePath);
    let repository = await createSeededRepository(repositorySeed, store);
    const reopen = () => {
      store.close();
      store = openJobStore(filePath);
      return createJobFinderRepository(store);
    };

    try {
      await persistResumeTimelineRepairAction({
        repository,
        runId: run.id,
        proposalId: proposal!.id,
        action: "accept",
        occurredAt: "2026-07-31T10:02:00.000Z",
      });
      repository = reopen();

      expect(
        (await repository.getProfile()).experiences.find(
          (entry) => entry.id === record.id,
        ),
      ).toMatchObject({ startDate: "2023-01", endDate: "2024-06" });
      expect(
        (await repository.listResumeImportRuns()).find(
          (entry) => entry.id === run.id,
        )?.timelineRepairProposals?.[0]?.status,
      ).toBe("accepted");

      await persistResumeTimelineRepairAction({
        repository,
        runId: run.id,
        proposalId: proposal!.id,
        action: "undo",
        occurredAt: "2026-07-31T10:03:00.000Z",
      });
      repository = reopen();

      expect(
        (await repository.getProfile()).experiences.find(
          (entry) => entry.id === record.id,
        ),
      ).toMatchObject({ startDate: "2024-06", endDate: "2023-01" });
      const reopenedRun = (await repository.listResumeImportRuns()).find(
        (entry) => entry.id === run.id,
      );
      expect(reopenedRun?.timelineRepairProposals?.[0]).toMatchObject({
        status: "pending",
        resolvedAt: null,
      });
      expect(
        reopenedRun?.timelineRepairProposals?.[0]?.actionHistory.map(
          (entry) => entry.action,
        ),
      ).toEqual(["accept", "undo"]);
    } finally {
      store.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});