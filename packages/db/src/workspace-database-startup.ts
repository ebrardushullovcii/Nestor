import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./internal/migrations";
import { migrateSavedJobStorageSteps } from "./internal/saved-job-storage-migration";
import { migrateResumeStorageSteps } from "./internal/resume-storage-migration";
import { withStorageMigrationBackups } from "./internal/storage-migration-backup";

/** Run one-time evidence conversions away from Electron's event loop. */
export async function completeWorkspaceDatabaseMigrations(
  filePath: string,
): Promise<void> {
  const database = new DatabaseSync(filePath);
  try {
    // Readers may open as soon as preparation signals ready. Install the wait
    // before runMigrations' WAL pragma can race that first read connection.
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY");
    await withStorageMigrationBackups(database, async () => {
      runMigrations(database, { deferEvidenceConversion: true });
      for (const step of migrateSavedJobStorageSteps(database)) {
        void step;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      for (const step of migrateResumeStorageSteps(database)) {
        void step;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    });
  } finally {
    database.close();
  }
}
