import {
  JobFinderResumeWorkspaceSchema,
  JobFinderSetResumeClaimConfirmationInputSchema,
  resumeClaimOwnershipStatement,
  type JobFinderResumeWorkspace,
  type ResumeClaimAssessment,
  type ResumeClaimConfirmation,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import { createApplyQueueDemoState } from "../../../../../../main/adapters/job-finder-demo-state";
import { buildResumeClaimConfirmationCommandInput } from "./resume-claim-confirmation-panel";

function buildWorkspace(
  claimConfirmations: readonly ResumeClaimConfirmation[] = [],
): JobFinderResumeWorkspace {
  const state = createApplyQueueDemoState();
  const job = state.savedJobs.find((entry) => entry.id === "job_ready");
  const baseDraft = state.resumeDrafts.find(
    (entry) => entry.jobId === "job_ready",
  );

  if (!job || !baseDraft) {
    throw new Error(
      "Expected demo state to contain the ready resume workspace fixture.",
    );
  }

  return JobFinderResumeWorkspaceSchema.parse({
    job,
    draft: { ...baseDraft, claimConfirmations },
    exports: [],
    research: [],
    assistantMessages: [],
    tailoredAsset: null,
    sharedProfile: {},
    workHistoryReviewSuggestions: [],
  });
}

const confirmNeededBullet: ResumeClaimAssessment = {
  id: "claim_assessment_bullet",
  field: "entry_bullet",
  sectionId: "section_experience",
  entryId: "entry_signal_systems",
  bulletId: "bullet_signal_rollout",
  claimText: "Led design-system rollout across core workflow surfaces.",
  claimOrigin: "ai_generated",
  contentHash: "fnv1a32:11111111",
  status: "confirm_needed",
  evidenceRefs: [],
  verifier: "deterministic_candidate_evidence_v2",
  assessedAt: "2026-08-20T10:00:00.000Z",
};

function buildConfirmation(
  overrides?: Partial<ResumeClaimConfirmation>,
): ResumeClaimConfirmation {
  return {
    id: "claim_confirmation_1",
    draftId: "draft_under_test",
    field: confirmNeededBullet.field,
    sectionId: confirmNeededBullet.sectionId,
    entryId: confirmNeededBullet.entryId,
    bulletId: confirmNeededBullet.bulletId,
    confirmedClaimContentHash: confirmNeededBullet.contentHash,
    ownershipStatement: resumeClaimOwnershipStatement,
    confirmedAt: "2026-08-20T11:00:00.000Z",
    ...overrides,
  };
}

describe("resume claim confirmation helpers", () => {
  it("builds the add command with saved revision, locator, hash, and literal ownership statement", () => {
    const draft = buildWorkspace().draft;
    const input = buildResumeClaimConfirmationCommandInput({
      claimAssessments: [confirmNeededBullet],
      draft,
      jobId: "job_ready",
      request: { intent: "add", target: confirmNeededBullet },
    });

    expect(input).toEqual({
      intent: "add",
      jobId: "job_ready",
      draftId: draft.id,
      expectedDraftUpdatedAt: draft.updatedAt,
      field: "entry_bullet",
      sectionId: "section_experience",
      entryId: "entry_signal_systems",
      bulletId: "bullet_signal_rollout",
      confirmedClaimContentHash: confirmNeededBullet.contentHash,
      ownershipStatement: resumeClaimOwnershipStatement,
    });
    expect(() =>
      JobFinderSetResumeClaimConfirmationInputSchema.parse(input),
    ).not.toThrow();
  });

  it("refuses add commands whose captured wording no longer matches the projection", () => {
    const draft = buildWorkspace().draft;

    expect(
      buildResumeClaimConfirmationCommandInput({
        claimAssessments: [confirmNeededBullet],
        draft,
        jobId: "job_ready",
        request: {
          intent: "add",
          target: { ...confirmNeededBullet, contentHash: "fnv1a32:33333333" },
        },
      }),
    ).toBeNull();
    // A generated claim the evidence cannot prove is approvable; the same
    // wording written by the person is only a note and has nothing to approve.
    expect(
      buildResumeClaimConfirmationCommandInput({
        claimAssessments: [
          { ...confirmNeededBullet, status: "review", claimOrigin: "imported" },
        ],
        draft,
        jobId: "job_ready",
        request: { intent: "add", target: confirmNeededBullet },
      }),
    ).toBeNull();
    expect(
      buildResumeClaimConfirmationCommandInput({
        claimAssessments: [
          {
            ...confirmNeededBullet,
            status: "review",
            claimOrigin: "ai_generated",
          },
        ],
        draft,
        jobId: "job_ready",
        request: { intent: "add", target: confirmNeededBullet },
      })?.intent,
    ).toBe("add");
    expect(
      buildResumeClaimConfirmationCommandInput({
        claimAssessments: [
          {
            ...confirmNeededBullet,
            verifier: "deterministic_candidate_evidence_v1",
          },
        ],
        draft,
        jobId: "job_ready",
        request: { intent: "add", target: confirmNeededBullet },
      }),
    ).toBeNull();
  });

  it("builds the remove command only from a confirmation stored on the same draft", () => {
    const confirmation = buildConfirmation({ draftId: "draft_1" });
    const draft = { ...buildWorkspace([confirmation]).draft, id: "draft_1" };

    expect(
      buildResumeClaimConfirmationCommandInput({
        claimAssessments: [confirmNeededBullet],
        draft,
        jobId: "job_ready",
        request: { intent: "remove", confirmationId: confirmation.id },
      }),
    ).toEqual({
      intent: "remove",
      jobId: "job_ready",
      draftId: "draft_1",
      expectedDraftUpdatedAt: draft.updatedAt,
      confirmationId: confirmation.id,
    });
    expect(
      buildResumeClaimConfirmationCommandInput({
        claimAssessments: [confirmNeededBullet],
        draft: { ...draft, id: "draft_2" },
        jobId: "job_ready",
        request: { intent: "remove", confirmationId: confirmation.id },
      }),
    ).toBeNull();
  });

  it("builds add_many from current confirm_needed skill locators", () => {
    const terraform: ResumeClaimAssessment = {
      ...confirmNeededBullet,
      id: "claim_terraform",
      field: "section_bullet",
      sectionId: "section_skills",
      entryId: null,
      bulletId: "skill_terraform",
      claimText: "Terraform",
      contentHash: "fnv1a32:aaaa1111",
    };
    const kubernetes: ResumeClaimAssessment = {
      ...terraform,
      id: "claim_kubernetes",
      bulletId: "skill_kubernetes",
      claimText: "Kubernetes",
      contentHash: "fnv1a32:bbbb2222",
    };
    const draft = buildWorkspace().draft;
    const input = buildResumeClaimConfirmationCommandInput({
      claimAssessments: [terraform, kubernetes],
      draft,
      jobId: "job_ready",
      request: { intent: "add_many", targets: [terraform, kubernetes] },
    });

    expect(input).toEqual({
      intent: "add_many",
      jobId: "job_ready",
      draftId: draft.id,
      expectedDraftUpdatedAt: draft.updatedAt,
      ownershipStatement: resumeClaimOwnershipStatement,
      targets: [
        {
          field: "section_bullet",
          sectionId: "section_skills",
          entryId: null,
          bulletId: "skill_terraform",
          confirmedClaimContentHash: "fnv1a32:aaaa1111",
        },
        {
          field: "section_bullet",
          sectionId: "section_skills",
          entryId: null,
          bulletId: "skill_kubernetes",
          confirmedClaimContentHash: "fnv1a32:bbbb2222",
        },
      ],
    });
    expect(() =>
      JobFinderSetResumeClaimConfirmationInputSchema.parse(input),
    ).not.toThrow();
  });
});
