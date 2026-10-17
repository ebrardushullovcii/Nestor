import { describe, expect, it } from "vitest";
import type {
  ResumeDraft,
  ResumeDraftRevision,
  ResumeValidationIssue,
} from "@nestor/contracts";
import { findResumeValidationRestoreCandidate } from "./resume-validation-restore";

const liveUngroundedSummary =
  "Senior Software Engineer with 10+ years building secure, scalable healthcare SaaS platforms with C#, .NET, ASP.NET Core, REST APIs, MongoDB, SQL Server, and Azure/AWS. Delivered microservices and EHR-adjacent integrations for scheduling and billing, with resilient third-party integrations, CI/CD, and observability for reliable Agile delivery.";
const previousSummary =
  "Software engineer focused on internal scheduling tools and reporting.";

function buildDraft(summaryText: string): ResumeDraft {
  const updatedAt = "2026-09-02T00:00:00.000Z";

  return {
    id: "draft_restore",
    jobId: "job_restore",
    status: "draft",
    templateId: "classic_ats",
    identity: null,
    sections: [
      {
        id: "sec_summary",
        kind: "summary",
        label: "Summary",
        text: summaryText,
        bullets: [],
        entries: [],
        origin: "assistant_edited",
        locked: false,
        included: true,
        sortOrder: 0,
        entryOrderMode: "chronology",
        profileRecordId: null,
        sourceRefs: [],
        updatedAt,
      },
    ],
    targetPageCount: 2,
    generationMethod: "ai",
    approvedAt: null,
    approvedExportId: null,
    staleReason: null,
    workHistoryReviewAcknowledgments: [],
    claimConfirmations: [],
    issueApprovals: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

function buildRevision(input: {
  id: string;
  createdAt: string;
  snapshotDraft: ResumeDraft | null;
}): ResumeDraftRevision {
  return {
    id: input.id,
    draftId: "draft_restore",
    parentRevisionId: null,
    actor: "assistant",
    mutationKind: "assistant_patch",
    snapshotDraft: input.snapshotDraft,
    snapshotIdentity: input.snapshotDraft?.identity ?? null,
    snapshotSections: input.snapshotDraft?.sections ?? [],
    beforeHash: null,
    afterHash: null,
    diff: null,
    restoredFromRevisionId: null,
    createdAt: input.createdAt,
    reason: null,
  };
}

const blockedIssue: ResumeValidationIssue = {
  id: "issue_claim_grounding_summary",
  severity: "error",
  category: "unsupported_claim",
  sectionId: "sec_summary",
  entryId: null,
  bulletId: null,
  message:
    "Your saved evidence does not back this generated claim. Rewrite it, or approve it as accurate if you can stand behind it.",
  flaggedText: liveUngroundedSummary,
};

describe("findResumeValidationRestoreCandidate", () => {
  it("returns the newest earlier text and a user patch that puts it back", () => {
    const candidate = findResumeValidationRestoreCandidate({
      draft: buildDraft(liveUngroundedSummary),
      issue: blockedIssue,
      revisions: [
        buildRevision({
          id: "rev_old",
          createdAt: "2026-09-01T00:00:00.000Z",
          snapshotDraft: buildDraft("An even older summary."),
        }),
        buildRevision({
          id: "rev_new",
          createdAt: "2026-09-01T12:00:00.000Z",
          snapshotDraft: buildDraft(previousSummary),
        }),
      ],
    });

    expect(candidate?.previousText).toBe(previousSummary);
    expect(candidate?.patch).toMatchObject({
      draftId: "draft_restore",
      operation: "replace_section_text",
      origin: "user",
      targetSectionId: "sec_summary",
      newText: previousSummary,
    });
  });

  it("refuses when the saved text no longer matches the flagged sentence", () => {
    expect(
      findResumeValidationRestoreCandidate({
        draft: buildDraft("Already rewritten by hand."),
        issue: blockedIssue,
        revisions: [
          buildRevision({
            id: "rev_new",
            createdAt: "2026-09-01T12:00:00.000Z",
            snapshotDraft: buildDraft(previousSummary),
          }),
        ],
      }),
    ).toBeNull();
  });

  it("refuses when no earlier snapshot holds different text", () => {
    expect(
      findResumeValidationRestoreCandidate({
        draft: buildDraft(liveUngroundedSummary),
        issue: blockedIssue,
        revisions: [
          buildRevision({
            id: "rev_same",
            createdAt: "2026-09-01T12:00:00.000Z",
            snapshotDraft: buildDraft(liveUngroundedSummary),
          }),
          buildRevision({
            id: "rev_snapshotless",
            createdAt: "2026-09-01T06:00:00.000Z",
            snapshotDraft: null,
          }),
        ],
      }),
    ).toBeNull();
  });
});
