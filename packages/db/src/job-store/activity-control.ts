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

const UNREADABLE_OLD_PAUSE =
  "Nestor couldn't read whether background work was paused before this update. Resume it when you're ready.";

/**
 * Kept while a reset runs. Neither the repository reset nor the job-store
 * clear lowers it; the whole reset's caller does, as its very last step.
 */
export const RESET_IN_PROGRESS_PAUSE: JobFinderActivityControl = {
  paused: true,
  pausedAt: null,
  reason:
    "Reset everything didn't finish. Restart Nestor to finish it, then resume.",
};

/**
 * What the old workspace file says about the pause. Only a stored value that
 * is a JSON object naming `paused` once, exactly `false`, means work ran;
 * every other
 * value (no row, `true`, `"true"`, `1`, `null`, a missing field, text that
 * isn't JSON, a missing table, a file that won't open) is read as paused.
 */
export function readOldPause(
  oldWorkspaceFile: string,
): "running" | "paused" | "unreadable" {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(oldWorkspaceFile, { readOnly: true });
  } catch {
    return "unreadable";
  }
  try {
    const row = database
      .prepare("SELECT value FROM singleton_state WHERE key='activity_control'")
      .get();
    if (!row || typeof row.value !== "string") return "unreadable";
    // JSON.parse keeps the last of duplicate keys and decodes escaped ones,
    // so {"paused":true,"paused":false} would read as running. The text must
    // name `paused` exactly once, with no escapes, before the value counts.
    if (
      row.value.includes("\\") ||
      (row.value.match(/"paused"\s*:/gu) ?? []).length !== 1
    )
      return "unreadable";
    const value: unknown = JSON.parse(row.value);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return "unreadable";
    const paused = (value as { paused?: unknown }).paused;
    if (paused === false) return "running";
    return paused === true ? "paused" : "unreadable";
  } catch {
    return "unreadable";
  } finally {
    database.close();
  }
}

/**
 * The pause is a safety control the person set, so an update must not drop
 * it. The first time the store has no pause row, it takes only the pause
 * flag from the old workspace file, once; after that the old file is never
 * read for it again. With no old file (a fresh install) nothing is opened
 * and work runs. Anything but a clean "not paused" in the old file leaves
 * work paused.
 */
export function carryOverOldPause(
  store: JobStore,
  oldWorkspaceFile: string,
): void {
  const { sql } = store;
  if (sql("SELECT 1 FROM activity_control WHERE id=1").get()) return;
  const old = existsSync(oldWorkspaceFile)
    ? readOldPause(oldWorkspaceFile)
    : "running";
  const control: JobFinderActivityControl =
    old === "running"
      ? { paused: false, pausedAt: null, reason: null }
      : {
          paused: true,
          pausedAt: new Date().toISOString(),
          reason: old === "unreadable" ? UNREADABLE_OLD_PAUSE : null,
        };
  // Another writer may have saved a pause since the check; that one stands.
  sql(`${INSERT_CONTROL} ON CONFLICT(id) DO NOTHING`).run(
    ...controlRow(control),
  );
}
