import { describe, expect, test } from "vitest";
import {
  ResumeClaimAssessmentSchema,
  ResumeDraftBulletSchema,
  ResumeDraftSchema,
  ResumeValidationIssueSchema,
  ResumeValidationResultSchema,
  resumeClaimAssessmentStatusValues,
  resumeDraftStatusValues,
  resumeValidationCategoryValues,
} from "./index";

const ISO_TIMESTAMP = "2026-03-20T10:05:00.000Z";

const legacyDraftInput = {
  id: "resume_draft_legacy",
  jobId: "job_1",
  status: "needs_review",
  templateId: "classic_ats",
  createdAt: ISO_TIMESTAMP,
  updatedAt: ISO_TIMESTAMP,
};

describe("contracts resume claim schemas", () => {
  test("defaults claim fields to empty/null on legacy drafts", () => {
    const parsed = ResumeDraftSchema.parse(legacyDraftInput);

    expect(parsed.workHistoryReviewAcknowledgments).toEqual([]);

    const drafted = ResumeDraftSchema.parse({
      ...legacyDraftInput,
      sections: [
        {
          id: "section_summary",
          kind: "summary",
          label: "Summary",
          origin: "ai_generated",
          sortOrder: 0,
          updatedAt: ISO_TIMESTAMP,
          bullets: [
            {
              id: "bullet_1",
              text: "Led design-system rollout across core surfaces.",
              origin: "ai_generated",
              updatedAt: ISO_TIMESTAMP,
            },
          ],
        },
      ],
    });

    const bullet = drafted.sections[0]?.bullets[0];
    expect(bullet?.lastGeneratedContentHash).toBeNull();
    expect(bullet?.locked).toBe(false);
    expect(bullet?.included).toBe(true);
  });

  test("keeps v1 verifier parseable while accepting evidence v2", () => {
    const baseAssessment = {
      id: "claim_1",
      field: "entry_bullet",
      sectionId: "section_experience",
      entryId: "experience_1",
      bulletId: "bullet_1",
      claimText: "Led design-system rollout across core surfaces.",
      claimOrigin: "ai_generated",
      contentHash: "fnv1a32:5678efab",
      status: "exact",
      assessedAt: ISO_TIMESTAMP,
    };

    const legacyResult = ResumeValidationResultSchema.parse({
      id: "resume_validation_legacy",
      draftId: "resume_draft_1",
      issues: [],
      claimAssessments: [
        {
          ...baseAssessment,
          verifier: "deterministic_candidate_evidence_v1",
        },
      ],
      pageCount: null,
      validatedAt: ISO_TIMESTAMP,
    });
    expect(legacyResult.claimAssessments[0]?.verifier).toBe(
      "deterministic_candidate_evidence_v1",
    );

    const v2Result = ResumeValidationResultSchema.parse({
      id: "resume_validation_v2",
      draftId: "resume_draft_1",
      issues: [],
      claimAssessments: [
        {
          ...baseAssessment,
          verifier: "deterministic_candidate_evidence_v2",
        },
      ],
      pageCount: null,
      validatedAt: ISO_TIMESTAMP,
    });
    expect(v2Result.claimAssessments[0]?.verifier).toBe(
      "deterministic_candidate_evidence_v2",
    );

    expect(() =>
      ResumeValidationResultSchema.parse({
        id: "resume_validation_unknown_verifier",
        draftId: "resume_draft_1",
        issues: [],
        claimAssessments: [
          {
            ...baseAssessment,
            verifier: "deterministic_candidate_evidence_v3",
          },
        ],
        pageCount: null,
        validatedAt: ISO_TIMESTAMP,
      }),
    ).toThrow();
  });

  test("accepts confirm_needed claims, rejects as draft status", () => {
    expect(resumeClaimAssessmentStatusValues).toContain("confirm_needed");
    expect(resumeDraftStatusValues).not.toContain("confirm_needed");

    const parsed = ResumeClaimAssessmentSchema.parse({
      id: "claim_confirm_needed",
      field: "entry_bullet",
      sectionId: "section_experience",
      entryId: "experience_1",
      bulletId: "bullet_1",
      claimText: "Led design-system rollout across core surfaces.",
      claimOrigin: "ai_generated",
      contentHash: "fnv1a32:5678efab",
      status: "confirm_needed",
      verifier: "deterministic_candidate_evidence_v2",
      assessedAt: ISO_TIMESTAMP,
    });
    expect(parsed.status).toBe("confirm_needed");

    expect(() =>
      ResumeDraftSchema.parse({
        ...legacyDraftInput,
        status: "confirm_needed",
      }),
    ).toThrow();

    expect(resumeValidationCategoryValues).toContain(
      "claim_confirmation_needed",
    );
    const issue = ResumeValidationIssueSchema.parse({
      id: "issue_1",
      severity: "warning",
      category: "claim_confirmation_needed",
      message: "Confirm this content before approval.",
    });
    expect(issue.category).toBe("claim_confirmation_needed");
  });

  test("round-trips explicit bullet generated content hashes", () => {
    const bullet = ResumeDraftBulletSchema.parse({
      id: "bullet_1",
      text: "Led design-system rollout across core surfaces.",
      origin: "ai_generated",
      lastGeneratedContentHash: "fnv1a32:65a923e6",
      updatedAt: ISO_TIMESTAMP,
    });
    expect(bullet.lastGeneratedContentHash).toBe("fnv1a32:65a923e6");

    expect(() =>
      ResumeDraftBulletSchema.parse({
        id: "bullet_1",
        text: "Led design-system rollout across core surfaces.",
        origin: "ai_generated",
        lastGeneratedContentHash: "hashy:12345678",
        updatedAt: ISO_TIMESTAMP,
      }),
    ).toThrow();
  });
});
