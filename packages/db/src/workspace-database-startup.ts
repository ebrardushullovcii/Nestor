import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./internal/migrations";

/** Run one-time evidence conversions away from Electron's event loop. */
export function completeWorkspaceDatabaseMigrations(filePath: string): void {
  const database = new DatabaseSync(filePath);
  try {
    // Readers may open as soon as preparation signals ready. Install the wait
    // before runMigrations' WAL pragma can race that first read connection.
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY");
    runMigrations(database);
  } finally {
    database.close();
  }
}
