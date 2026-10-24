import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./internal/migrations";

/** Run one-time evidence conversions away from Electron's event loop. */
export function completeWorkspaceDatabaseMigrations(filePath: string): void {
  const database = new DatabaseSync(filePath);
  try {
    runMigrations(database);
  } finally {
    database.close();
  }
}
