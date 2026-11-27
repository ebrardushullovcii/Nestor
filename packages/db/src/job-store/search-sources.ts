import {
  JobDiscoveryTargetSchema,
  type IndexPageLog,
  type JobDiscoveryTarget,
  type ListingCard,
  type SourceNavigationProgress,
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
CREATE TABLE IF NOT EXISTS search_source_queue (
  search_id TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  target_json TEXT NOT NULL,
  full INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  failure TEXT,
  PRIMARY KEY(search_id, source_id)
);
CREATE TABLE IF NOT EXISTS search_listing_queue (
  id INTEGER PRIMARY KEY,
  search_id TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  card_json TEXT NOT NULL,
  leased INTEGER NOT NULL DEFAULT 0,
  UNIQUE(search_id, source_id, url)
);
CREATE INDEX IF NOT EXISTS search_listing_queue_source ON search_listing_queue(search_id, source_id, id);
CREATE TABLE IF NOT EXISTS search_source_pages (
  search_id TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  links_json TEXT NOT NULL,
  PRIMARY KEY(search_id, source_id, url)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS search_source_navigation (
  search_id TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  start_url TEXT NOT NULL,
  progress_json TEXT NOT NULL,
  PRIMARY KEY(search_id, source_id, start_url)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS search_sources_finished AFTER UPDATE OF state ON searches
WHEN NEW.state IN ('stopped', 'failed') BEGIN
  UPDATE search_sources SET state = 'stopped', phase = NULL WHERE search_id = NEW.id AND state IN ('waiting', 'searching');
END;
`;
const COLUMNS = `source_id AS sourceId, label, url, state, lane, phase, cards, related, unrelated, seen,
 failed_reads AS failedReads, found, added, hidden, message`;
export function createSearchSourcesStore(store: JobStore) {
  const { sql } = store;
  /** Drops a source's queued cards and where its collection had got to. */
  const clearProgress = (searchId: string, sourceId: string): void => {
    for (const table of [
      "search_listing_queue",
      "search_source_pages",
      "search_source_navigation",
    ])
      sql(`DELETE FROM ${table} WHERE search_id=? AND source_id=?`).run(
        searchId,
        sourceId,
      );
  };
  return {
    get(searchId: string, sourceId: string): JobSearchSourceRow | null {
      return (
        (sql(
          `SELECT ${COLUMNS} FROM search_sources WHERE search_id=? AND source_id=?`,
        ).get(searchId, sourceId) as JobSearchSourceRow | undefined) ?? null
      );
    },
    plan(searchId: string, target: JobDiscoveryTarget, full: boolean): void {
      sql(`INSERT INTO search_source_queue(search_id, source_id, target_json, full)
        VALUES (?, ?, ?, ?) ON CONFLICT(search_id, source_id) DO UPDATE SET
        target_json=excluded.target_json, full=excluded.full, completed=0`).run(
        searchId,
        target.id,
        JSON.stringify(target),
        Number(full),
      );
    },
    /**
     * Acknowledges a source's result for this run. A source whose last
     * attempt failed keeps its queued cards and where it had got to, with
     * why it failed: a resume tries it again from there.
     */
    settle(
      searchId: string,
      sourceId: string,
      failure: string | null = null,
    ): boolean {
      if (failure === null) clearProgress(searchId, sourceId);
      return (
        Number(
          sql(`UPDATE search_source_queue SET completed=1, failure=?
        WHERE search_id=? AND source_id=? AND completed=0`).run(
            failure,
            searchId,
            sourceId,
          ).changes,
        ) > 0
      );
    },
    clearProgress,
    /** Why the source's last attempt in this search failed, if it did. */
    failure(searchId: string, sourceId: string): string | null {
      return (
        (
          sql(
            "SELECT failure FROM search_source_queue WHERE search_id=? AND source_id=?",
          ).get(searchId, sourceId) as { failure: string | null } | undefined
        )?.failure ?? null
      );
    },
    /**
     * Plans every source whose last attempt failed for another attempt, as
     * a resume does. Returns how many were settled before.
     */
    retryFailed(searchId: string): number {
      return Number(
        sql(`UPDATE search_source_queue SET completed=0
        WHERE search_id=? AND completed=1 AND failure IS NOT NULL`).run(
          searchId,
        ).changes,
      );
    },
    planned(searchId: string): boolean {
      return Boolean(
        sql("SELECT 1 FROM search_source_queue WHERE search_id=? LIMIT 1").get(
          searchId,
        ),
      );
    },
    pending(searchId: string): { target: JobDiscoveryTarget; full: boolean }[] {
      const rows = sql(
        "SELECT target_json, full FROM search_source_queue WHERE search_id=? AND completed=0 ORDER BY rowid",
      ).all(searchId) as { target_json: string; full: number }[];
      return rows.map((row) => ({
        target: JobDiscoveryTargetSchema.parse(JSON.parse(row.target_json)),
        full: Boolean(row.full),
      }));
    },
    cardUrls(searchId: string, sourceId: string): string[] {
      return (
        sql(
          "SELECT url FROM search_listing_queue WHERE search_id=? AND source_id=? ORDER BY id",
        ).all(searchId, sourceId) as { url: string }[]
      ).map((row) => row.url);
    },
    /**
     * The index pages this search has finished on one source. A restarted
     * process reads it back, so those pages are not fetched again.
     */
    pageLog(
      searchId: string,
      sourceId: string,
    ): IndexPageLog & { readonly restored: number } {
      const pages = new Map(
        (
          sql(
            "SELECT url, links_json FROM search_source_pages WHERE search_id=? AND source_id=?",
          ).all(searchId, sourceId) as { url: string; links_json: string }[]
        ).map((row) => [row.url, JSON.parse(row.links_json) as string[]]),
      );
      const restored = pages.size;
      const insert =
        sql(`INSERT INTO search_source_pages(search_id, source_id, url, links_json)
        VALUES (?, ?, ?, ?) ON CONFLICT(search_id, source_id, url) DO UPDATE SET links_json=excluded.links_json`);
      return {
        restored,
        links: (url) => pages.get(url) ?? null,
        record(url, finalUrl, links) {
          const value = [...new Set(links)];
          store.transaction(() => {
            for (const address of new Set([url, finalUrl])) {
              pages.set(address, value);
              insert.run(searchId, sourceId, address, JSON.stringify(value));
            }
          });
        },
      };
    },
    /** Where a browser collection that started at startUrl had got to. */
    navigation(
      searchId: string,
      sourceId: string,
      startUrl: string,
    ): SourceNavigationProgress | null {
      const row = sql(
        "SELECT progress_json FROM search_source_navigation WHERE search_id=? AND source_id=? AND start_url=?",
      ).get(searchId, sourceId, startUrl) as
        | { progress_json: string }
        | undefined;
      return row
        ? (JSON.parse(row.progress_json) as SourceNavigationProgress)
        : null;
    },
    saveNavigation(
      searchId: string,
      sourceId: string,
      startUrl: string,
      progress: SourceNavigationProgress,
    ): void {
      sql(`INSERT INTO search_source_navigation(search_id, source_id, start_url, progress_json)
        VALUES (?, ?, ?, ?) ON CONFLICT(search_id, source_id, start_url) DO UPDATE SET progress_json=excluded.progress_json`).run(
        searchId,
        sourceId,
        startUrl,
        JSON.stringify(progress),
      );
    },
    cardQueue(searchId: string) {
      // A new process owns no old in-flight wave. Its exact cards remain on
      // disk until the whole source result is acknowledged atomically.
      sql("UPDATE search_listing_queue SET leased=0 WHERE search_id=?").run(
        searchId,
      );
      const pending = new Map(
        (
          sql(
            "SELECT source_id, count(*) AS n FROM search_listing_queue WHERE search_id=? GROUP BY source_id ORDER BY min(id)",
          ).all(searchId) as { source_id: string; n: number }[]
        ).map((row) => [row.source_id, row.n]),
      );
      return {
        push(cards: readonly ListingCard[]): void {
          store.transaction(() => {
            for (const card of cards) {
              const inserted =
                sql(`INSERT INTO search_listing_queue(search_id,source_id,url,card_json)
              VALUES (?,?,?,?) ON CONFLICT(search_id,source_id,url) DO NOTHING`).run(
                  searchId,
                  card.sourceId,
                  card.url,
                  JSON.stringify(card),
                );
              if (Number(inserted.changes) > 0)
                pending.set(
                  card.sourceId,
                  (pending.get(card.sourceId) ?? 0) + 1,
                );
            }
          });
        },
        counts(): [string, number][] {
          return [...pending];
        },
        take(sourceId: string, size: number): ListingCard[] {
          return store.transaction(() => {
            const rows = sql(
              "SELECT id, card_json FROM search_listing_queue WHERE search_id=? AND source_id=? AND leased=0 ORDER BY id LIMIT ?",
            ).all(searchId, sourceId, size) as {
              id: number;
              card_json: string;
            }[];
            for (const row of rows)
              sql("UPDATE search_listing_queue SET leased=1 WHERE id=?").run(
                row.id,
              );
            const left = (pending.get(sourceId) ?? 0) - rows.length;
            if (left > 0) pending.set(sourceId, left);
            else pending.delete(sourceId);
            return rows.map((row) => JSON.parse(row.card_json) as ListingCard);
          });
        },
        complete(): void {
          /* settle() acknowledges the complete source, including deferred browser reads. */
        },
        drop(sourceId: string, urls: readonly string[]): string[] {
          return store.transaction(() => {
            const removed = urls.filter(
              (url) =>
                Number(
                  sql(
                    "DELETE FROM search_listing_queue WHERE search_id=? AND source_id=? AND url=? AND leased=0",
                  ).run(searchId, sourceId, url).changes,
                ) > 0,
            );
            const left = (pending.get(sourceId) ?? 0) - removed.length;
            if (left > 0) pending.set(sourceId, left);
            else pending.delete(sourceId);
            return removed;
          });
        },
      };
    },
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
    /** Only unfinished sites; completed and person-blocked sites require no automatic retry. */
    unfinishedIds(searchId: string): string[] {
      return (
        sql(
          "SELECT source_id FROM search_sources WHERE search_id = ? AND state IN ('partial', 'failed', 'stopped') ORDER BY id",
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
