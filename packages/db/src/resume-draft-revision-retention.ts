import type { ResumeDraftRevision } from "@nestor/contracts";
import type { DatabaseSync } from "node:sqlite";
import { rebaseRetainedResumeRevisions } from "./internal/resume-revision-storage";

import { sortNewestFirst } from "./in-memory-repository-utils";

export const MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT = 100;

export function assertResumeRevisionCoalescing(
  previous: ResumeDraftRevision | undefined,
  next: ResumeDraftRevision,
  expected: { id: string; afterHash: string },
): void {
  if (
    !previous ||
    previous.id !== expected.id ||
    next.id !== previous.id ||
    previous.afterHash !== expected.afterHash ||
    previous.actor !== "user" ||
    previous.mutationKind !== "manual_save" ||
    next.actor !== previous.actor ||
    next.mutationKind !== previous.mutationKind ||
    next.parentRevisionId !== previous.parentRevisionId ||
    next.draftId !== previous.draftId ||
    next.restoredFromRevisionId !== previous.restoredFromRevisionId ||
    next.createdAt !== previous.createdAt ||
    next.beforeHash !== previous.beforeHash ||
    JSON.stringify(next.snapshotDraft) !==
      JSON.stringify(previous.snapshotDraft) ||
    JSON.stringify(next.snapshotSections) !==
      JSON.stringify(previous.snapshotSections) ||
    JSON.stringify(next.snapshotIdentity) !==
      JSON.stringify(previous.snapshotIdentity)
  )
    throw new Error(
      "Resume edit history changed before this autosave could be grouped.",
    );
}

export function retainResumeDraftRevisions(
  revisions: readonly ResumeDraftRevision[],
  draftId: string,
): ResumeDraftRevision[] {
  const retainedForDraft = sortNewestFirst(
    revisions.filter((revision) => revision.draftId === draftId),
  ).slice(0, MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT);

  return [
    ...revisions.filter((revision) => revision.draftId !== draftId),
    ...retainedForDraft,
  ];
}

export function prunePersistedResumeDraftRevisions(
  database: DatabaseSync,
  draftId: string,
): void {
  rebaseRetainedResumeRevisions(
    database,
    draftId,
    MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT,
  );
  database
    .prepare(
      `DELETE FROM resume_draft_revisions
       WHERE draft_id = ?
         AND id IN (
           SELECT id
           FROM resume_draft_revisions
           WHERE draft_id = ?
           ORDER BY created_at DESC, id ASC
           LIMIT -1 OFFSET ?
         )`,
    )
    .run(draftId, draftId, MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT);
}
