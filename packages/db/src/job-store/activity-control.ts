import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  JobFinderActivityControlSchema,
  type JobFinderActivityControl,
} from "@nestor/contracts";
import type { JobStore } from "./job-store";

/** Whether background work is paused; no row means it runs. */
export const ACTIVITY_CONTROL_SCHEMA = `
CREATE TABLE IF NOT EXISTS activity_control(id INTEGER PRIMARY KEY CHECK(id=1),paused INTEGER NOT NULL,paused_at TEXT,reason TEXT,pause_behavior TEXT);
`;

const INSERT_CONTROL = `INSERT INTO activity_control(id,paused,paused_at,reason,pause_behavior) VALUES(1,?,?,?,?)`;

function controlRow(control: JobFinderActivityControl) {
  const row = JobFinderActivityControlSchema.parse(control);
  return [
    row.paused ? 1 : 0,
    row.pausedAt,
    row.reason,
    row.pauseBehavior ?? null,
  ] as const;
}

export function createActivityControlStore(store: JobStore) {
  const { sql } = store;
  return {
    read(): JobFinderActivityControl {
      const row = sql(
        "SELECT paused,paused_at,reason,pause_behavior FROM activity_control WHERE id=1",
      ).get();
      return JobFinderActivityControlSchema.parse(
        row
          ? {
              paused: row.paused === 1,
              pausedAt: row.paused_at,
              reason: row.reason,
              ...(row.pause_behavior
                ? { pauseBehavior: row.pause_behavior }
                : {}),
            }
          : {},
      );
    },
    save(control: JobFinderActivityControl): void {
      sql(
        `${INSERT_CONTROL}
        ON CONFLICT(id) DO UPDATE SET paused=excluded.paused,paused_at=excluded.paused_at,reason=excluded.reason,pause_behavior=excluded.pause_behavior`,
      ).run(...controlRow(control));
    },
  };
}

/** Whether the old workspace file says background work was paused. */
function readOldPause(oldWorkspaceFile: string): boolean {
  const database = new DatabaseSync(oldWorkspaceFile, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT value FROM singleton_state WHERE key='activity_control'")
      .get();
    if (!row) return false;
    const value = JSON.parse(String(row.value)) as { paused?: unknown };
    return value.paused === true;
  } finally {
    database.close();
  }
}

/**
 * The pause is a safety control the person set, so an update must not drop
 * it. The first time the store has no pause row, it takes only the pause
 * flag from the old workspace file, once; after that the old file is never
 * read for it again. With no old file (a fresh install) nothing is opened and
 * work runs. An old file that can't be read leaves work paused, with a
 * reason, rather than starting it.
 */
export function carryOverOldPause(
  store: JobStore,
  oldWorkspaceFile: string,
): void {
  const { sql } = store;
  if (sql("SELECT 1 FROM activity_control WHERE id=1").get()) return;
  let control: JobFinderActivityControl = {
    paused: false,
    pausedAt: null,
    reason: null,
  };
  if (existsSync(oldWorkspaceFile)) {
    let paused: boolean;
    let reason: string | null = null;
    try {
      paused = readOldPause(oldWorkspaceFile);
    } catch {
      paused = true;
      reason =
        "Nestor couldn't read whether background work was paused before this update. Resume it when you're ready.";
    }
    if (paused)
      control = { paused, pausedAt: new Date().toISOString(), reason };
  }
  // Another writer may have saved a pause since the check; that one stands.
  sql(`${INSERT_CONTROL} ON CONFLICT(id) DO NOTHING`).run(
    ...controlRow(control),
  );
}
