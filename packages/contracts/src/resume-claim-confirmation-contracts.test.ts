import { describe, expect, test } from "vitest";
import {
  ResumeClaimAssessmentSchema,
  ResumeClaimConfirmationSchema,
  ResumeDraftBulletSchema,
  ResumeDraftSchema,
  ResumeValidationIssueSchema,
  ResumeValidationResultSchema,
  isResumeSkillClaimAssessment,
  resumeClaimAssessmentStatusValues,
  resumeClaimOwnershipStatement,
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

function buildValidConfirmationInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "claim_confirmation_1",
    draftId: "resume_draft_1",
    field: "entry_bullet",
    sectionId: "section_experience",
    entryId: "experience_1",
    bulletId: "bullet_1",
    confirmedClaimContentHash: "fnv1a32:5678efab",
    ownershipStatement: resumeClaimOwnershipStatement,
    confirmedAt: ISO_TIMESTAMP,
    ...overrides,
  };
}

describe("contracts resume claim confirmation schemas", () => {
  test("defaults claim fields to empty/null on legacy drafts", () => {
    const parsed = ResumeDraftSchema.parse(legacyDraftInput);

    expect(parsed.claimConfirmations).toEqual([]);
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

  test("parses a valid strict confirmation for every locator field", () => {
    const validLocators = [
      {
        field: "section_text",
        sectionId: "section_summary",
        entryId: null,
        bulletId: null,
      },
      {
        field: "section_bullet",
        sectionId: "section_summary",
        entryId: null,
        bulletId: "summary_bullet_1",
      },
      {
        field: "entry_summary",
        sectionId: "section_experience",
        entryId: "experience_1",
        bulletId: null,
      },
      {
        field: "entry_bullet",
        sectionId: "section_experience",
        entryId: "experience_1",
        bulletId: "bullet_1",
      },
    ];

    for (const locator of validLocators) {
      const parsed = ResumeClaimConfirmationSchema.parse({
        ...buildValidConfirmationInput(),
        ...locator,
      });
      expect(parsed.draftId).toBe("resume_draft_1");
      expect(parsed.confirmedClaimContentHash).toBe("fnv1a32:5678efab");
      expect(parsed.ownershipStatement).toBe(resumeClaimOwnershipStatement);
      expect(parsed.confirmedAt).toBe(ISO_TIMESTAMP);
    }
  });

  test("defaults omitted locator ids and enforces correlation", () => {
    const defaulted = ResumeClaimConfirmationSchema.parse({
      id: "claim_confirmation_defaulted",
      draftId: "resume_draft_1",
      field: "section_text",
      sectionId: "section_summary",
      confirmedClaimContentHash: "fnv1a32:5678efab",
      ownershipStatement: resumeClaimOwnershipStatement,
      confirmedAt: ISO_TIMESTAMP,
    });
    expect(defaulted.entryId).toBeNull();
    expect(defaulted.bulletId).toBeNull();

    expect(() =>
      ResumeClaimConfirmationSchema.parse({
        id: "claim_confirmation_missing_bullet",
        draftId: "resume_draft_1",
        field: "entry_bullet",
        sectionId: "section_experience",
        entryId: "experience_1",
        confirmedClaimContentHash: "fnv1a32:5678efab",
        ownershipStatement: resumeClaimOwnershipStatement,
        confirmedAt: ISO_TIMESTAMP,
      }),
    ).toThrow();
  });

  test("rejects unknown keys on confirmations", () => {
    expect(() =>
      ResumeClaimConfirmationSchema.parse(
        buildValidConfirmationInput({
          reason: "looks fine to me",
        }),
      ),
    ).toThrow();
  });

  test("requires the exact literal ownership statement", () => {
    expect(() =>
      ResumeClaimConfirmationSchema.parse(
        buildValidConfirmationInput({
          ownershipStatement:
            "I confirm this content is accurate and my own!",
        }),
      ),
    ).toThrow();

    expect(() =>
      ResumeClaimConfirmationSchema.parse(
        buildValidConfirmationInput({
          ownershipStatement:
            "i confirm this content is accurate and my own.",
        }),
      ),
    ).toThrow();
  });

  test("rejects impossible locator combinations", () => {
    const invalidLocators = [
      {
        // entry id unexpected for section-level text
        field: "section_text",
        sectionId: "section_summary",
        entryId: "experience_1",
        bulletId: null,
      },
      {
        // bullet id unexpected for section-level text
        field: "section_text",
        sectionId: "section_summary",
        entryId: null,
        bulletId: "bullet_1",
      },
      {
        // bullet id required for section-level bullets
        field: "section_bullet",
        sectionId: "section_summary",
        entryId: null,
        bulletId: null,
      },
      {
        // entry id unexpected for section-level bullets
        field: "section_bullet",
        sectionId: "section_summary",
        entryId: "experience_1",
        bulletId: "bullet_1",
      },
      {
        // entry id required for entry summaries
        field: "entry_summary",
        sectionId: "section_experience",
        entryId: null,
        bulletId: null,
      },
      {
        // bullet id unexpected for entry summaries
        field: "entry_summary",
        sectionId: "section_experience",
        entryId: "experience_1",
        bulletId: "bullet_1",
      },
      {
        // entry id required for entry bullets
        field: "entry_bullet",
        sectionId: "section_experience",
        entryId: null,
        bulletId: "bullet_1",
      },
      {
        // bullet id required for entry bullets
        field: "entry_bullet",
        sectionId: "section_experience",
        entryId: "experience_1",
        bulletId: null,
      },
    ];

    for (const locator of invalidLocators) {
      expect(() =>
        ResumeClaimConfirmationSchema.parse({
          ...buildValidConfirmationInput(),
          ...locator,
        }),
      ).toThrow();
    }
  });

  test("rejects malformed confirmed claim content hashes", () => {
    const malformedHashes = [
      "not-a-hash",
      "fnv1a32:",
      "fnv1a32:0a1b2c3",
      "fnv1a32:0a1b2c3de",
      "fnv1a32:0A1B2C3D",
      "fnv1a32:zzzzzzzz",
      "sha256:0a1b2c3d",
    ];

    for (const confirmedClaimContentHash of malformedHashes) {
      expect(() =>
        ResumeClaimConfirmationSchema.parse(
          buildValidConfirmationInput({ confirmedClaimContentHash }),
        ),
      ).toThrow();
    }
  });

  test("caps claim confirmations at 100 per draft", () => {
    const buildList = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        buildValidConfirmationInput({
          id: `claim_confirmation_${index}`,
          field: "section_text",
          sectionId: `section_${index}`,
          entryId: null,
          bulletId: null,
        }),
      );

    const atLimit = ResumeDraftSchema.parse({
      ...legacyDraftInput,
      claimConfirmations: buildList(100),
    });
    expect(atLimit.claimConfirmations).toHaveLength(100);

    expect(() =>
      ResumeDraftSchema.parse({
        ...legacyDraftInput,
        claimConfirmations: buildList(101),
      }),
    ).toThrow();
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

  test("identifies skills-section locators for bulk confirmation", () => {
    const draft = ResumeDraftSchema.parse({
      ...legacyDraftInput,
      sections: [
        {
          id: "section_skills",
          kind: "skills",
          label: "Core Skills",
          origin: "ai_generated",
          sortOrder: 0,
          updatedAt: ISO_TIMESTAMP,
          bullets: [
            {
              id: "skill_terraform",
              text: "Terraform",
              origin: "ai_generated",
              updatedAt: ISO_TIMESTAMP,
            },
          ],
        },
        {
          id: "section_experience",
          kind: "experience",
          label: "Experience",
          origin: "ai_generated",
          sortOrder: 1,
          updatedAt: ISO_TIMESTAMP,
        },
      ],
    });

    expect(
      isResumeSkillClaimAssessment(draft, {
        field: "section_bullet",
        sectionId: "section_skills",
      }),
    ).toBe(true);
    expect(
      isResumeSkillClaimAssessment(draft, {
        field: "entry_bullet",
        sectionId: "section_experience",
      }),
    ).toBe(false);
  });
});
