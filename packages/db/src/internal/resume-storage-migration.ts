import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
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
  for (const step of migrateResumeStorageSteps(database)) void step;
}

/** Drafts and history decode either shape between bounded transactions. */
export function* migrateResumeStorageSteps(
  database: DatabaseSync,
): Generator<void> {
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
  function transaction(convert: () => void) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const counts = database
        .prepare(
          "SELECT (SELECT count(*) FROM resume_drafts) AS drafts, (SELECT count(*) FROM resume_draft_revisions) AS revisions",
        )
        .get();
      convert();
      const after = database
        .prepare(
          "SELECT (SELECT count(*) FROM resume_drafts) AS drafts, (SELECT count(*) FROM resume_draft_revisions) AS revisions",
        )
        .get();
      if (
        after?.drafts !== counts?.drafts ||
        after?.revisions !== counts?.revisions
      )
        throw new Error("Resume storage migration changed record counts.");
      database.exec("COMMIT");
      notifyWorkspaceCommit(database);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  transaction(() => {
    for (const row of database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'row_validations_%'",
      )
      .all())
      database.exec(`DROP TRIGGER ${String(row.name)}`);
    database.exec("DROP TABLE IF EXISTS row_validations");
  });
  for (let offset = 0; offset < drafts.length; offset += 4) {
    transaction(() => {
      // Moving citations must not consume a pending approval/staleness overlay.
      const approvalTrigger = database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name = 'resume_draft_approval_body_update'",
        )
        .get()?.sql;
      database.exec("DROP TRIGGER IF EXISTS resume_draft_approval_body_update");
      for (const { id } of drafts.slice(offset, offset + 4)) {
        const row = database
          .prepare("SELECT value FROM resume_drafts WHERE id = ?")
          .get(String(id));
        if (!row) continue;
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
      if (approvalTrigger) database.exec(String(approvalTrigger));
    });
    yield;
  }
  for (const { id } of revisions) {
    transaction(() => {
      const row = database
        .prepare("SELECT value FROM resume_draft_revisions WHERE id = ?")
        .get(String(id));
      if (!row) return;
      const revision = ResumeDraftRevisionSchema.parse(
        readResumeRevision(database, String(id), String(row.value)),
      );
      const value = serializeResumeRevision(database, revision, true);
      database
        .prepare("UPDATE resume_draft_revisions SET value = ? WHERE id = ?")
        .run(value, String(id));
      const restored = readResumeRevision(database, String(id));
      if (!isDeepStrictEqual(restored, revision))
        throw new Error("Resume revision migration changed stored facts.");
    });
    yield;
  }
  transaction(() => {
    database
      .prepare(
        "INSERT INTO schema_migrations(version, name) VALUES (26, 'resume_source_references_and_revision_changes')",
      )
      .run();
  });
}
