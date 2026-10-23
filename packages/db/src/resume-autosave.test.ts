import { describe, expect, test } from "vitest";
import {
  ResumeDraftSchema,
  ResumeDraftRevisionSchema,
  ResumeValidationResultSchema,
} from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "./index";
import { createSeed } from "./test-fixtures";
import { createTempRepository } from "./file-repository.test-support";

for (const backend of ["memory", "sqlite"] as const) {
  describe(`autosave ledger (${backend})`, () => {
    test("replaces only the latest revision atomically, preserves its snapshot and survives reopen", async () => {
      const temp =
        backend === "sqlite"
          ? await createTempRepository("nestor-autosave-")
          : null;
      let repository = temp
        ? await temp.createRepository()
        : createInMemoryJobFinderRepository(createSeed());
      const original = ResumeDraftSchema.parse({
        id: "draft",
        jobId: "job",
        status: "needs_review",
        templateId: "classic_ats",
        sections: [],
        createdAt: "2026-10-23T00:00:00.000Z",
        updatedAt: "2026-10-23T00:00:00.000Z",
      });
      const first = {
        ...original,
        targetPageCount: 2,
        updatedAt: "2026-10-23T00:00:01.000Z",
      };
      const final = {
        ...first,
        targetPageCount: 3,
        updatedAt: "2026-10-23T00:00:02.000Z",
      };
      const revision = ResumeDraftRevisionSchema.parse({
        id: "revision",
        draftId: original.id,
        actor: "user",
        mutationKind: "manual_save",
        snapshotDraft: original,
        snapshotIdentity: original.identity,
        snapshotSections: original.sections,
        beforeHash: "before",
        afterHash: "first",
        createdAt: first.updatedAt,
      });
      const validation = ResumeValidationResultSchema.parse({
        id: "validation",
        draftId: original.id,
        issues: [],
        validatedAt: first.updatedAt,
      });
      try {
        await repository.upsertResumeDraft(original);
        await repository.applyResumePatchWithRevision({
          expectedDraftUpdatedAt: original.updatedAt,
          draft: first,
          revision,
          validation,
        });
        const replacement = { ...revision, afterHash: "final" };
        await repository.applyResumePatchWithRevision({
          coalesceRevision: { id: revision.id, afterHash: "first" },
          expectedDraftUpdatedAt: first.updatedAt,
          draft: final,
          revision: replacement,
          validation,
        });
        expect(await repository.listResumeDraftRevisions(original.id)).toEqual([
          replacement,
        ]);
        expect(
          (await repository.listResumeDraftRevisions(original.id))[0]!
            .snapshotDraft,
        ).toEqual(original);
        for (const badRevision of [
          { ...replacement, snapshotDraft: final },
          { ...replacement, beforeHash: "changed" },
          { ...replacement, parentRevisionId: "changed" },
        ]) {
          await expect(
            Promise.resolve().then(() =>
              repository.applyResumePatchWithRevision({
                coalesceRevision: { id: revision.id, afterHash: "final" },
                expectedDraftUpdatedAt: final.updatedAt,
                draft: { ...final, updatedAt: "2026-10-23T00:00:03.000Z" },
                revision: badRevision,
                validation,
              }),
            ),
          ).rejects.toThrow("history changed");
          expect(
            await repository.getResumeDraftByJobId(original.jobId),
          ).toEqual(final);
          expect(
            await repository.listResumeDraftRevisions(original.id),
          ).toEqual([replacement]);
        }
        if (temp) {
          await repository.close();
          repository = await temp.createRepository();
          expect(
            await repository.getResumeDraftByJobId(original.jobId),
          ).toEqual(final);
          expect(
            await repository.listResumeDraftRevisions(original.id),
          ).toEqual([replacement]);
        }
        const boundary = {
          ...replacement,
          id: "boundary",
          parentRevisionId: revision.id,
          createdAt: "2026-10-23T00:00:03.000Z",
          snapshotDraft: final,
        };
        await repository.upsertResumeDraftRevision(boundary);
        await expect(
          Promise.resolve().then(() =>
            repository.applyResumePatchWithRevision({
              coalesceRevision: { id: revision.id, afterHash: "final" },
              expectedDraftUpdatedAt: final.updatedAt,
              draft: final,
              revision: replacement,
              validation,
            }),
          ),
        ).rejects.toThrow("history changed");
        expect(await repository.getResumeDraftByJobId(original.jobId)).toEqual(
          final,
        );
      } finally {
        await repository.close();
        await temp?.cleanup();
      }
    });
  });
}
