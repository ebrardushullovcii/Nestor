import {
  JobSearchSourceQuerySchema,
  type JobSearchSourceQuery,
  type JobSearchSourcePage,
  type JobSearchSourceRow,
  type JobSearchProgress,
} from "@nestor/contracts";
import type { JobStore } from "./job-store";

export const SEARCH_SOURCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS search_sources (
  id INTEGER PRIMARY KEY,
  search_id TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  label TEXT NOT NULL COLLATE NOCASE,
  url TEXT NOT NULL,
  state TEXT NOT NULL,
  lane TEXT,
  phase TEXT,
  cards INTEGER NOT NULL DEFAULT 0,
  related INTEGER NOT NULL DEFAULT 0,
  unrelated INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0,
  failed_reads INTEGER NOT NULL DEFAULT 0,
  found INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  UNIQUE(search_id, source_id)
);
CREATE INDEX IF NOT EXISTS search_sources_page ON search_sources(search_id, id);
CREATE INDEX IF NOT EXISTS search_sources_state ON search_sources(search_id, state, phase, id);
CREATE INDEX IF NOT EXISTS search_sources_label ON search_sources(search_id, label, id);
CREATE TRIGGER IF NOT EXISTS search_sources_finished AFTER UPDATE OF state ON searches
WHEN NEW.state IN ('stopped', 'failed') BEGIN
  UPDATE search_sources SET state = 'stopped', phase = NULL WHERE search_id = NEW.id AND state IN ('waiting', 'searching');
END;
`;
const COLUMNS = `source_id AS sourceId, label, url, state, lane, phase, cards, related, unrelated, seen,
 failed_reads AS failedReads, found, added, hidden, message`;
export function createSearchSourcesStore(store: JobStore) {
  const { sql } = store;
  return {
    put(searchId: string, row: JobSearchSourceRow): void {
      store.transaction(() => {
        sql(`INSERT INTO search_sources(search_id, source_id, label, url, state, lane, phase, cards, related, unrelated, seen, failed_reads, found, added, hidden, message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(search_id,source_id) DO UPDATE SET label=excluded.label, url=excluded.url, state=excluded.state, lane=excluded.lane, phase=excluded.phase,
        cards=excluded.cards, related=excluded.related, unrelated=excluded.unrelated, seen=excluded.seen, failed_reads=excluded.failed_reads,
        found=excluded.found, added=excluded.added, hidden=excluded.hidden, message=excluded.message`).run(
          searchId,
          row.sourceId,
          row.label,
          row.url,
          row.state,
          row.lane,
          row.phase,
          row.cards,
          row.related,
          row.unrelated,
          row.seen,
          row.failedReads,
          row.found,
          row.added,
          row.hidden,
          row.message,
        );
      });
    },
    list(input: JobSearchSourceQuery): JobSearchSourcePage {
      const q = JobSearchSourceQuerySchema.parse(input);
      const searchId = q.searchId ?? store.searches.latest()?.id ?? "";
      const pattern = `%${q.text.replace(/[\\%_]/gu, "\\$&")}%`;
      const where = `search_id = ? AND (? IS NULL OR state = ?) AND (label LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')`;
      const args = [searchId, q.state, q.state, pattern, pattern];
      const total = (
        sql(`SELECT count(*) AS n FROM search_sources WHERE ${where}`).get(
          ...args,
        ) as { n: number }
      ).n;
      const records = sql(
        `SELECT id, ${COLUMNS} FROM search_sources WHERE ${where} AND id > ? ORDER BY id LIMIT ?`,
      ).all(...args, q.after, q.limit + 1) as (JobSearchSourceRow & {
        id: number;
      })[];
      const visible = records.slice(0, q.limit);
      return {
        rows: visible.map(({ id, ...row }) => {
          void id;
          return row;
        }),
        nextCursor: records.length > q.limit ? visible.at(-1)!.id : null,
        total,
      };
    },
    /** The sites a search left with more listings to read. */
    partialIds(searchId: string): string[] {
      return (
        sql(
          "SELECT source_id FROM search_sources WHERE search_id = ? AND state = 'partial' ORDER BY id",
        ).all(searchId) as { source_id: string }[]
      ).map((row) => row.source_id);
    },
    compact(searchId: string): {
      sources: JobSearchSourceRow[];
      progress: JobSearchProgress;
    } {
      const sources = sql(
        `SELECT ${COLUMNS} FROM search_sources WHERE search_id = ? AND state = 'searching' ORDER BY id LIMIT 3`,
      ).all(searchId) as JobSearchSourceRow[];
      const rows = sql(
        `SELECT state, phase, count(*) AS n FROM search_sources WHERE search_id = ? GROUP BY state, phase`,
      ).all(searchId) as { state: string; phase: string | null; n: number }[];
      const progress = {
        httpQueued: 0,
        httpActive: 0,
        browserQueued: 0,
        browserActive: 0,
        processing: 0,
        fitQueued: 0,
        fitActive: 0,
        needsYou: 0,
        failed: 0,
        partial: 0,
      };
      for (const row of rows) {
        if (row.state === "waiting") {
          if (row.phase === "browser") progress.browserQueued += row.n;
          else progress.httpQueued += row.n;
        }
        if (row.state === "searching") {
          if (row.phase === "http") progress.httpActive += row.n;
          else if (row.phase === "browser") progress.browserActive += row.n;
          else progress.processing += row.n;
        }
        if (row.state === "needs_you") progress.needsYou += row.n;
        if (row.state === "failed") progress.failed += row.n;
        if (row.state === "partial") progress.partial += row.n;
      }
      return { sources, progress };
    },
  };
}
