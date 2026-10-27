import type { JobStore } from "./job-store";

/** Adds source tickets beside application tickets without changing their columns. */
export const SOURCE_ACCESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS source_needs_you (
  source_id INTEGER PRIMARY KEY REFERENCES job_sites(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL UNIQUE REFERENCES needs_you(id) ON DELETE CASCADE,
  requested_url TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS source_access_removed AFTER DELETE ON source_needs_you BEGIN
  UPDATE needs_you SET resolved_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE id = OLD.task_id AND resolved_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS source_access_url_changed AFTER UPDATE OF url ON job_sites
WHEN OLD.url <> NEW.url BEGIN
  UPDATE needs_you SET resolved_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE id IN (SELECT task_id FROM source_needs_you WHERE source_id = NEW.id) AND resolved_at IS NULL;
END;
`;

export function createSourceAccessStore(store: JobStore) {
  const { sql } = store;
  const changed = () =>
    store.notify({
      cause: "application",
      stages: ["resume", "applied"],
      ids: [],
      searchId: null,
    });
  return {
    pending(sourceId: number): boolean {
      return !!sql(`SELECT 1 FROM source_needs_you n JOIN needs_you t ON t.id = n.task_id
        JOIN job_sites s ON s.id = n.source_id
        WHERE n.source_id = ? AND t.resolved_at IS NULL AND n.requested_url = s.url`).get(
        sourceId,
      );
    },
    request(sourceId: number, prompt: string): number | null {
      return store.transaction(() => {
        const site = sql("SELECT url FROM job_sites WHERE id = ?").get(
          sourceId,
        ) as { url: string } | undefined;
        if (!site) return null;
        const existing =
          sql(`SELECT t.id, t.resolved_at, t.prompt, n.requested_url
          FROM source_needs_you n JOIN needs_you t ON t.id = n.task_id WHERE n.source_id = ?`).get(
            sourceId,
          ) as
            | {
                id: number;
                resolved_at: number | null;
                prompt: string;
                requested_url: string;
              }
            | undefined;
        const message = prompt.trim().slice(0, 1000);
        if (existing) {
          if (
            existing.resolved_at !== null ||
            existing.prompt !== message ||
            existing.requested_url !== site.url
          ) {
            sql(
              "UPDATE needs_you SET resolved_at = NULL, prompt = ?, site_origin = ?, answer = NULL WHERE id = ?",
            ).run(message, new URL(site.url).origin, existing.id);
            sql(
              "UPDATE source_needs_you SET requested_url = ? WHERE source_id = ?",
            ).run(site.url, sourceId);
            changed();
          }
          return existing.id;
        }
        const result =
          sql(`INSERT INTO needs_you (kind, answer_key, country, site_origin, prompt, input, options_json, opened_at)
          VALUES ('sign_in', ?, '', ?, ?, 'text', '[]', ?)`).run(
            `source-access:${sourceId}`,
            new URL(site.url).origin,
            message,
            Date.now(),
          );
        const id = Number(result.lastInsertRowid);
        sql(
          "INSERT INTO source_needs_you(source_id, task_id, requested_url) VALUES (?, ?, ?)",
        ).run(sourceId, id, site.url);
        changed();
        return id;
      });
    },
    /** Call only after inventory and all required detail reads succeed. */
    complete(sourceId: number): boolean {
      return store.transaction(() => {
        const result =
          sql(`UPDATE needs_you SET resolved_at = ? WHERE resolved_at IS NULL AND id IN (
          SELECT n.task_id FROM source_needs_you n JOIN job_sites s ON s.id = n.source_id
          WHERE n.source_id = ? AND n.requested_url = s.url)`).run(
            Date.now(),
            sourceId,
          );
        if (result.changes) changed();
        return !!result.changes;
      });
    },
  };
}
