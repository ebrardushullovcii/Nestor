import {
  ResumeDraftRevisionSchema,
  ResumeDraftSchema,
  ResumeValidationResultSchema,
  type ResumeDraft,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  cleanupTempDirectoryWithRetry,
  createTempRepository,
  type FileRepository,
} from "./file-repository.test-support";
import { MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT } from "./resume-draft-revision-retention";

const PERFORMANCE_SAMPLE_COUNT = 20;

function timestamp(index: number): string {
  return new Date(Date.UTC(2026, 6, 30, 10, 0, index)).toISOString();
}

function createDraft(): ResumeDraft {
  return ResumeDraftSchema.parse({
    id: "resume_draft_performance",
    jobId: "job_resume_performance",
    status: "needs_review",
    templateId: "classic_ats",
    identity: null,
    sections: [],
    targetPageCount: 2,
    generationMethod: "manual",
    approvedAt: null,
    approvedExportId: null,
    staleReason: null,
    createdAt: timestamp(0),
    updatedAt: timestamp(100),
  });
}

function createRevision(input: {
  currentDraft: ResumeDraft;
  index: number;
  mutationKind: "manual_save" | "restore";
  parentRevisionId: string | null;
  restoredFromRevisionId?: string | null;
}) {
  return ResumeDraftRevisionSchema.parse({
    id: `resume_performance_revision_${String(input.index).padStart(3, "0")}`,
    draftId: input.currentDraft.id,
    parentRevisionId: input.parentRevisionId,
    actor: "user",
    mutationKind: input.mutationKind,
    snapshotDraft: input.currentDraft,
    snapshotIdentity: input.currentDraft.identity,
    snapshotSections: input.currentDraft.sections,
    beforeHash: null,
    afterHash: null,
    diff: null,
    restoredFromRevisionId: input.restoredFromRevisionId ?? null,
    createdAt: timestamp(input.index),
    reason:
      input.mutationKind === "restore"
        ? "Performance restore mutation"
        : "Performance save mutation",
  });
}

function createValidation(draft: ResumeDraft, index: number) {
  return ResumeValidationResultSchema.parse({
    id: `resume_performance_validation_${String(index).padStart(3, "0")}`,
    draftId: draft.id,
    issues: [],
    draftContentHash: null,
    claimAssessments: [],
    pageCount: null,
    validatedAt: draft.updatedAt,
  });
}

describe("resume revision retention at capacity", () => {
  test("keeps atomic saves and restores at the retained history cap", async () => {
    const temp = await createTempRepository("nestor-db-revision-perf-");
    let repository: FileRepository | null = null;

    try {
      repository = await temp.createRepository();
      let currentDraft = createDraft();
      await repository.upsertResumeDraft(currentDraft);

      for (
        let index = 0;
        index < MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT;
        index += 1
      ) {
        await repository.upsertResumeDraftRevision(
          createRevision({
            currentDraft,
            index,
            mutationKind: "manual_save",
            parentRevisionId:
              index === 0
                ? null
                : `resume_performance_revision_${String(index - 1).padStart(3, "0")}`,
          }),
        );
      }

      await expect(
        repository.listResumeDraftRevisions(currentDraft.id),
      ).resolves.toHaveLength(MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT);

      let parentRevisionId = "resume_performance_revision_099";
      for (let sample = 0; sample < PERFORMANCE_SAMPLE_COUNT; sample += 1) {
        const index = MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT + sample;
        const nextDraft = ResumeDraftSchema.parse({
          ...currentDraft,
          templateId: sample % 2 === 0 ? "compact_exec" : "classic_ats",
          updatedAt: timestamp(index + 1),
        });
        const revision = createRevision({
          currentDraft,
          index,
          mutationKind: "manual_save",
          parentRevisionId,
        });

        await repository.applyResumePatchWithRevision({
          expectedDraftUpdatedAt: currentDraft.updatedAt,
          draft: nextDraft,
          revision,
          validation: createValidation(nextDraft, index),
        });

        currentDraft = nextDraft;
        parentRevisionId = revision.id;
        await expect(
          repository.listResumeDraftRevisions(currentDraft.id),
        ).resolves.toHaveLength(MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT);
      }

      const restoreSourceRevisionId = "resume_performance_revision_099";
      for (let sample = 0; sample < PERFORMANCE_SAMPLE_COUNT; sample += 1) {
        const index =
          MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT +
          PERFORMANCE_SAMPLE_COUNT +
          sample;
        const restoredDraft = ResumeDraftSchema.parse({
          ...currentDraft,
          status: "needs_review",
          templateId: "classic_ats",
          approvedAt: null,
          approvedExportId: null,
          updatedAt: timestamp(index + 1),
        });
        const revision = createRevision({
          currentDraft,
          index,
          mutationKind: "restore",
          parentRevisionId,
          restoredFromRevisionId: restoreSourceRevisionId,
        });

        await repository.applyResumePatchWithRevision({
          expectedDraftUpdatedAt: currentDraft.updatedAt,
          draft: restoredDraft,
          revision,
          validation: createValidation(restoredDraft, index),
        });

        currentDraft = restoredDraft;
        parentRevisionId = revision.id;
        await expect(
          repository.listResumeDraftRevisions(currentDraft.id),
        ).resolves.toHaveLength(MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT);
      }

      await expect(
        repository.getResumeDraftByJobId(currentDraft.jobId),
      ).resolves.toEqual(currentDraft);
      const finalRevisions = await repository.listResumeDraftRevisions(
        currentDraft.id,
      );
      expect(finalRevisions).toHaveLength(MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT);
      expect(finalRevisions[0]).toEqual(
        expect.objectContaining({
          id: parentRevisionId,
          mutationKind: "restore",
          restoredFromRevisionId: restoreSourceRevisionId,
        }),
      );
    } finally {
      await repository?.close();
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  }, 30000);
});
