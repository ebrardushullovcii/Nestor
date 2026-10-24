import type { DatabaseSync } from "node:sqlite";
import {
  ResumeDraftSchema,
  ResumeDraftRevisionSchema,
} from "@nestor/contracts";
import { backupBeforeStorageMigration } from "./storage-migration-backup";
import {
  serializeResumeRevision,
  readResumeRevision,
} from "./resume-revision-storage";
import {
  compactResumeDraftStorage,
  restoreResumeDraftStorage,
  ensureResumeSourceTables,
} from "./resume-draft-storage";
import { notifyWorkspaceCommit } from "../workspace-commits";

/** A forward migration validates imported old shapes once, then trusts writes. */
export function migrateResumeStorage(database: DatabaseSync): void {
  if (
    database.prepare("SELECT 1 FROM schema_migrations WHERE version = 26").get()
  )
    return;
  ensureResumeSourceTables(database);
  const drafts = database
    .prepare("SELECT id FROM resume_drafts ORDER BY id")
    .all();
  const revisions = database
    .prepare("SELECT id FROM resume_draft_revisions ORDER BY created_at, id")
    .all();
  if (drafts.length || revisions.length)
    backupBeforeStorageMigration(database, 26);
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const row of database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'row_validations_%'",
      )
      .all())
      database.exec(`DROP TRIGGER ${String(row.name)}`);
    database.exec("DROP TABLE IF EXISTS row_validations");
    for (const { id } of drafts) {
      const row = database
        .prepare("SELECT value FROM resume_drafts WHERE id = ?")
        .get(String(id))!;
      const draft = ResumeDraftSchema.parse(
        restoreResumeDraftStorage(
          database,
          JSON.parse(String(row.value)) as unknown,
        ),
      );
      const compact = compactResumeDraftStorage(database, draft);
      database
        .prepare("UPDATE resume_drafts SET value = ? WHERE id = ?")
        .run(JSON.stringify(compact), String(id));
    }
    for (const { id } of revisions) {
      const row = database
        .prepare("SELECT value FROM resume_draft_revisions WHERE id = ?")
        .get(String(id))!;
      const revision = ResumeDraftRevisionSchema.parse(
        readResumeRevision(database, String(id), String(row.value)),
      );
      const value = serializeResumeRevision(database, revision, true);
      database
        .prepare("UPDATE resume_draft_revisions SET value = ? WHERE id = ?")
        .run(value, String(id));
      const restored = readResumeRevision(database, String(id));
      if (restored.id !== revision.id || restored.draftId !== revision.draftId)
        throw new Error("Resume revision migration changed identity.");
    }
    const draftCount = Number(
      database.prepare("SELECT count(*) AS count FROM resume_drafts").get()!
        .count,
    );
    const revisionCount = Number(
      database
        .prepare("SELECT count(*) AS count FROM resume_draft_revisions")
        .get()!.count,
    );
    if (draftCount !== drafts.length || revisionCount !== revisions.length)
      throw new Error("Resume storage migration changed record counts.");
    database
      .prepare(
        "INSERT INTO schema_migrations(version, name) VALUES (26, 'resume_source_references_and_revision_changes')",
      )
      .run();
    database.exec("COMMIT");
    notifyWorkspaceCommit(database);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
