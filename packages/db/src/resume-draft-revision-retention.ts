import type { ResumeDraftRevision } from "@nestor/contracts";
import type { DatabaseSync } from "node:sqlite";

import { sortNewestFirst } from "./in-memory-repository-utils";

export const MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT = 100;

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