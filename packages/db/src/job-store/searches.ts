import {
  JobSearchSettingsSchema,
  type JobSearchRecord,
  type JobSearchSettings,
  type JobSearchState,
} from "@nestor/contracts";
import { randomUUID } from "node:crypto";

import { toIso } from "./job-list";
import type { Statements } from "./statements";

type SearchCounts = Pick<
  JobSearchRecord,
  "sourcesDone" | "found" | "added" | "merged" | "scored"
>;

export interface JobSearches {
  start(settings: JobSearchSettings, sourcesTotal: number): JobSearchRecord;
  /** Adds to the running counts. */
  count(id: string, increments: Partial<SearchCounts>): JobSearchRecord | null;
  finish(
    id: string,
    state: Exclude<JobSearchState, "running">,
    error?: string | null,
  ): JobSearchRecord | null;
  get(id: string): JobSearchRecord | null;
  latest(): JobSearchRecord | null;
}

type SearchRecord = {
  id: string;
  state: JobSearchState;
  settings_json: string;
  started_at: number;
  finished_at: number | null;
  sources_total: number;
  sources_done: number;
  found: number;
  added: number;
  merged: number;
  scored: number;
  error: string | null;
};

function toSearch(record: SearchRecord | undefined): JobSearchRecord | null {
  if (!record) return null;
  return {
    id: record.id,
    state: record.state,
    settings: JobSearchSettingsSchema.parse(JSON.parse(record.settings_json)),
    startedAt: toIso(record.started_at),
    finishedAt: record.finished_at === null ? null : toIso(record.finished_at),
    sourcesTotal: record.sources_total,
    sourcesDone: record.sources_done,
    found: record.found,
    added: record.added,
    merged: record.merged,
    scored: record.scored,
    error: record.error,
  };
}

export function createSearches(sql: Statements): JobSearches {
  // A search still marked running was cut off when the app last closed.
  sql(
    "UPDATE searches SET state = 'stopped', finished_at = ? WHERE state = 'running'",
  ).run(Date.now());
  const get = (id: string) =>
    toSearch(
      sql("SELECT * FROM searches WHERE id = ?").get(id) as
        | SearchRecord
        | undefined,
    );
  return {
    start(settings, sourcesTotal) {
      const id = `search_${randomUUID()}`;
      sql(
        `INSERT INTO searches (id, state, settings_json, started_at, sources_total)
         VALUES (?, 'running', ?, ?, ?)`,
      ).run(id, JSON.stringify(settings), Date.now(), sourcesTotal);
      return get(id)!;
    },
    count(id, increments) {
      sql(
        `UPDATE searches SET sources_done = sources_done + ?, found = found + ?,
           added = added + ?, merged = merged + ?, scored = scored + ?
         WHERE id = ?`,
      ).run(
        increments.sourcesDone ?? 0,
        increments.found ?? 0,
        increments.added ?? 0,
        increments.merged ?? 0,
        increments.scored ?? 0,
        id,
      );
      return get(id);
    },
    finish(id, state, error = null) {
      sql(
        `UPDATE searches SET state = ?, finished_at = ?, error = ?
         WHERE id = ? AND state = 'running'`,
      ).run(state, Date.now(), error, id);
      return get(id);
    },
    get,
    latest: () =>
      toSearch(
        sql("SELECT * FROM searches ORDER BY started_at DESC LIMIT 1").get() as
          | SearchRecord
          | undefined,
      ),
  };
}
