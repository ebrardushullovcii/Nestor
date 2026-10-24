import type { DatabaseSync } from "node:sqlite";
import { SavedJobSchema } from "@nestor/contracts";
import { isDeepStrictEqual } from "node:util";
import { backupBeforeStorageMigration } from "./storage-migration-backup";
import {
  ensureSavedJobRelations,
  savedJobValueSql,
  writeSavedJobStorage,
} from "./saved-job-storage";
import { notifyWorkspaceCommit } from "../workspace-commits";
import {
  savedJobFingerprintSelectSql,
  attachStoredSavedJobFingerprints,
  copySavedJobPreparation,
} from "./saved-job-fingerprints";

export function migrateSavedJobStorage(db: DatabaseSync): void {
  ensureSavedJobRelations(db);
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version = 28").get())
    return;
  const ids = db.prepare("SELECT id FROM saved_jobs ORDER BY id").all();
  if (ids.length) backupBeforeStorageMigration(db, 28);
  const read = db.prepare(
    `SELECT ${savedJobValueSql()} AS value${savedJobFingerprintSelectSql} FROM saved_jobs WHERE id = ?`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const { id } of ids) {
      const stored = read.get(String(id))!;
      const raw: unknown = JSON.parse(String(stored.value));
      const parsed = SavedJobSchema.safeParse(raw);
      // An old incomplete row is preserved byte-for-byte for its owning repair
      // path. This migration only removes exact, provably redundant copies.
      if (!parsed.success) continue;
      const before = copySavedJobPreparation(
        attachStoredSavedJobFingerprints(
          raw as object,
          stored.discovery_fingerprints,
        ),
        parsed.data,
      );
      writeSavedJobStorage(db, before);
      const after = JSON.parse(String(read.get(String(id))!.value)) as unknown;
      if (!isDeepStrictEqual(after, Object.fromEntries(Object.entries(before))))
        throw new Error(
          "Saved-job migration changed listing or assessment facts.",
        );
    }
    if (
      Number(db.prepare("SELECT count(*) AS n FROM saved_jobs").get()!.n) !==
      ids.length
    )
      throw new Error("Saved-job migration changed record counts.");
    db.prepare(
      "INSERT INTO schema_migrations(version, name) VALUES (28, 'saved_job_evidence_and_assessment_references')",
    ).run();
    db.exec("COMMIT");
    notifyWorkspaceCommit(db);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
