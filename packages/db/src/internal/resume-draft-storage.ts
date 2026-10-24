import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { ResumeDraft, ResumeDraftSourceRef } from "@nestor/contracts";

export function ensureResumeSourceTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS resume_source_texts(id INTEGER PRIMARY KEY, stable_key TEXT UNIQUE NOT NULL, text TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS resume_sources(id INTEGER PRIMARY KEY, stable_key TEXT UNIQUE NOT NULL,
      ref_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT, text_id INTEGER REFERENCES resume_source_texts(id));`);
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
function statement(db: DatabaseSync, sql: string): StatementSync {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map<string, StatementSync>()));
  let prepared = cache.get(sql);
  if (!prepared) cache.set(sql, (prepared = db.prepare(sql)));
  return prepared;
}

/** Sections store citation row IDs; source records and source text live once. */
export function compactResumeDraftStorage(
  db: DatabaseSync,
  draft: ResumeDraft,
): unknown {
  ensureResumeSourceTables(db);
  const byObject = new Map<ResumeDraftSourceRef, number>();
  const byValue = new Map<string, number>();
  const reference = (ref: ResumeDraftSourceRef): number => {
    const found = byObject.get(ref);
    if (found !== undefined) return found;
    const json = JSON.stringify(ref);
    const cached = byValue.get(json);
    if (cached !== undefined) {
      byObject.set(ref, cached);
      return cached;
    }
    let textId: number | null = null;
    if (ref.snippet !== null) {
      const key = hash(ref.snippet);
      statement(
        db,
        "INSERT OR IGNORE INTO resume_source_texts(stable_key, text) VALUES (?, ?)",
      ).run(key, ref.snippet);
      textId = Number(
        statement(
          db,
          "SELECT id FROM resume_source_texts WHERE stable_key = ?",
        ).get(key)!.id,
      );
    }
    const key = hash(json);
    statement(
      db,
      "INSERT OR IGNORE INTO resume_sources(stable_key, ref_id, source_kind, source_id, text_id) VALUES (?, ?, ?, ?, ?)",
    ).run(key, ref.id, ref.sourceKind, ref.sourceId, textId);
    const id = Number(
      statement(db, "SELECT id FROM resume_sources WHERE stable_key = ?").get(
        key,
      )!.id,
    );
    byObject.set(ref, id);
    byValue.set(json, id);
    return id;
  };
  const bullets = (rows: ResumeDraft["sections"][number]["bullets"]) =>
    rows.map((bullet) => ({
      ...bullet,
      sourceRefs: bullet.sourceRefs.map(reference),
    }));
  return {
    ...draft,
    sections: draft.sections.map((section) => ({
      ...section,
      sourceRefs: section.sourceRefs.map(reference),
      bullets: bullets(section.bullets),
      entries: section.entries.map((entry) => ({
        ...entry,
        sourceRefs: entry.sourceRefs.map(reference),
        bullets: bullets(entry.bullets),
      })),
    })),
  };
}

/** The canonical contract stays complete; only the opened draft needs citations. */
export function restoreResumeDraftStorage(
  db: DatabaseSync,
  input: unknown,
): ResumeDraft {
  const draft = input as ResumeDraft;
  const nodes: Array<{ sourceRefs: ResumeDraftSourceRef[] }> = [];
  for (const section of draft.sections) {
    nodes.push(section, ...section.bullets);
    for (const entry of section.entries) nodes.push(entry, ...entry.bullets);
  }
  const ids = [
    ...new Set(
      nodes
        .flatMap(
          (node) =>
            node.sourceRefs as unknown as Array<number | ResumeDraftSourceRef>,
        )
        .filter((id): id is number => typeof id === "number"),
    ),
  ];
  if (!ids.length) return draft;
  const refs = new Map<number, ResumeDraftSourceRef>();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const page = ids.slice(offset, offset + 500);
    for (const row of db
      .prepare(
        `SELECT s.id, s.ref_id, s.source_kind, s.source_id, t.text
      FROM resume_sources s LEFT JOIN resume_source_texts t ON t.id = s.text_id WHERE s.id IN (${page.map(() => "?").join(",")})`,
      )
      .all(...page))
      refs.set(Number(row.id), {
        id: String(row.ref_id),
        sourceKind: row.source_kind as ResumeDraftSourceRef["sourceKind"],
        sourceId: row.source_id as string | null,
        snippet: row.text as string | null,
      });
  }
  for (const node of nodes)
    node.sourceRefs = (
      node.sourceRefs as unknown as Array<number | ResumeDraftSourceRef>
    ).map((ref) => {
      if (typeof ref !== "number") return ref;
      const value = refs.get(ref);
      if (!value) throw new Error("Resume source evidence is missing.");
      return value;
    });
  return draft;
}
