import {
  JobFinderActivityControlSchema,
  type JobFinderActivityControl,
} from "@nestor/contracts";
import type { JobStore } from "./job-store";

/** Whether background work is paused; no row means it runs. */
export const ACTIVITY_CONTROL_SCHEMA = `
CREATE TABLE IF NOT EXISTS activity_control(id INTEGER PRIMARY KEY CHECK(id=1),paused INTEGER NOT NULL,paused_at TEXT,reason TEXT,pause_behavior TEXT);
`;

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
      const row = JobFinderActivityControlSchema.parse(control);
      sql(
        `INSERT INTO activity_control(id,paused,paused_at,reason,pause_behavior) VALUES(1,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET paused=excluded.paused,paused_at=excluded.paused_at,reason=excluded.reason,pause_behavior=excluded.pause_behavior`,
      ).run(
        row.paused ? 1 : 0,
        row.pausedAt,
        row.reason,
        row.pauseBehavior ?? null,
      );
    },
  };
}
