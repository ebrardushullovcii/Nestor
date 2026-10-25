import { describe, expect, test } from "vitest";

import { toCandidate } from "./resume-import-candidate-utils";
import { promoteGroundedSharedMemoryCandidates } from "./resume-import-shared-memory-candidates";
import {
  createStageCandidate,
  createTestBundle,
} from "../workspace-service.resume-analysis.shared";

describe("promoteGroundedSharedMemoryCandidates", () => {
  test("drops proofs that repeat a work-history bullet verbatim, keeps richer proofs for review", () => {
    const now = "2026-07-31T04:00:00.000Z";
    const achievement =
      "Led a React and TypeScript shipment-tracking redesign used by 18 internal operations teams.";
    const bundle = createTestBundle({
      fullText: ["Senior Frontend Engineer", achievement].join("\n"),
    });
    const experience = toCandidate(
      bundle,
      "run_proof_deduplication",
      "parser_literal",
      now,
      createStageCandidate({
        target: {
          section: "experience",
          key: "record",
          recordId: "experience_northstar",
        },
        label: "Senior Frontend Engineer at Northstar Parcel Software",
        value: {
          id: "experience_northstar",
          companyName: "Northstar Parcel Software",
          companyUrl: null,
          title: "Senior Frontend Engineer",
          employmentType: null,
          location: "Portland, Oregon",
          workMode: [],
          startDate: "2021-03",
          endDate: null,
          isCurrent: true,
          isDraft: false,
          summary: null,
          achievements: [achievement],
          skills: ["React", "TypeScript"],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        sourceBlockIds: ["page_1_block_1", "page_1_block_2"],
        confidence: 0.96,
        recommendation: "auto_apply",
        overall: 0.96,
      }),
      0,
    );
    const redundantRoleProof = toCandidate(
      bundle,
      "run_proof_deduplication",
      "model_shared_memory",
      now,
      createStageCandidate({
        target: {
          section: "proof_point",
          key: "record",
          recordId: "proof_role_title",
        },
        label: "Senior Frontend Engineer proof at Northstar Parcel Software",
        value: {
          title: "Senior Frontend Engineer",
          claim: achievement,
          heroMetric: null,
          supportingContext: null,
          roleFamilies: [],
          projectIds: [],
          linkIds: [],
        },
        sourceBlockIds: ["page_1_block_2"],
        confidence: 0.42,
        recommendation: "needs_review",
        overall: 0.42,
      }),
      1,
    );
    const richerAchievementProof = toCandidate(
      bundle,
      "run_proof_deduplication",
      "model_shared_memory",
      now,
      createStageCandidate({
        target: {
          section: "proof_point",
          key: "record",
          recordId: "proof_shipment_redesign",
        },
        label: "Shipment tracking redesign impact",
        value: {
          title: "Led React/TypeScript Shipment-Tracking Redesign",
          claim:
            "Delivered a major redesign adopted by 18 internal operations teams.",
          heroMetric: "18 internal operations teams",
          supportingContext:
            "React and TypeScript implementation for Northstar Parcel Software",
          roleFamilies: ["Frontend Engineering"],
          projectIds: [],
          linkIds: [],
        },
        sourceBlockIds: ["page_1_block_2"],
        confidence: 0.94,
        recommendation: "needs_review",
        overall: 0.94,
      }),
      2,
    );

    const promoted = promoteGroundedSharedMemoryCandidates([
      experience,
      redundantRoleProof,
      richerAchievementProof,
    ]);

    expect(promoted[0]).toEqual(experience);
    expect(promoted[0]?.value).toEqual(
      expect.objectContaining({ achievements: [achievement] }),
    );
    expect(promoted[1]).toEqual(
      expect.objectContaining({
        resolution: "rejected",
        resolutionReason: "redundant_with_work_history",
      }),
    );
    expect(promoted[2]).toEqual(
      expect.objectContaining({ resolution: "needs_review" }),
    );
  });

  test("drops a professional story that repeats the imported summary verbatim", () => {
    const now = "2026-09-02T04:00:00.000Z";
    const summary =
      "Senior software engineer with 10+ years building secure healthcare and SaaS platforms.";
    const bundle = createTestBundle({ fullText: summary });
    const summaryCandidate = toCandidate(
      bundle,
      "run_summary_deduplication",
      "parser_literal",
      now,
      createStageCandidate({
        target: { section: "identity", key: "summary", recordId: null },
        label: "Summary",
        value: summary,
        sourceBlockIds: ["page_1_block_1"],
        confidence: 0.95,
        recommendation: "auto_apply",
        overall: 0.95,
      }),
      0,
    );
    const duplicateStory = toCandidate(
      bundle,
      "run_summary_deduplication",
      "model_shared_memory",
      now,
      createStageCandidate({
        target: {
          section: "narrative",
          key: "professionalStory",
          recordId: null,
        },
        label: "Professional story",
        value: summary,
        sourceBlockIds: ["page_1_block_1"],
        confidence: 0.46,
        recommendation: "needs_review",
        overall: 0.46,
      }),
      1,
    );

    const promoted = promoteGroundedSharedMemoryCandidates([
      summaryCandidate,
      duplicateStory,
    ]);

    // The same paragraph must not fill both the professional summary and the
    // professional story: one edit, one field.
    expect(promoted[1]).toEqual(
      expect.objectContaining({
        resolution: "rejected",
        resolutionReason: "redundant_with_professional_summary",
      }),
    );

    // Same when reconciliation already applied the story into the empty
    // narrative field.
    const appliedStory = {
      ...duplicateStory,
      resolution: "auto_applied" as const,
    };
    expect(
      promoteGroundedSharedMemoryCandidates([
        summaryCandidate,
        appliedStory,
      ])[1],
    ).toEqual(
      expect.objectContaining({
        resolution: "rejected",
        resolutionReason: "redundant_with_professional_summary",
      }),
    );
  });
});
