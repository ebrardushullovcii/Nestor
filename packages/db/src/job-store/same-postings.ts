import type { JobStage } from "@nestor/contracts";
import {
  rolePrefix,
  samePostingCandidates,
  savedPostingFacts,
} from "./found-jobs";
import type { Statements } from "./statements";

export interface SamePostingMerge {
  kept: number;
  merged: number;
}

export interface SamePostingMergeReport {
  merged: SamePostingMerge[];
  /** Pairs left apart because each job has its own application, tracker or resume record. */
  keptApart: { ids: [number, number]; tables: string[] }[];
}

/** The person's furthest step wins; a person's hide outranks an untouched find. */
function progress(stage: JobStage, hideOwner: string | null): number {
  switch (stage) {
    case "applied":
      return 5;
    case "resume":
      return 4;
    case "shortlisted":
      return 3;
    case "hidden":
      return hideOwner === "person" || hideOwner === null ? 2 : 0;
    case "found":
      return 1;
  }
}

/** Tables that reference jobs, with the column and whether it holds one row per job. */
function jobReferences(
  sql: Statements,
): { table: string; column: string; onePerJob: boolean }[] {
  const tables = (
    sql(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all() as { name: string }[]
  ).map((row) => row.name);
  const references: { table: string; column: string; onePerJob: boolean }[] =
    [];
  for (const table of tables) {
    const keys = sql(
      "SELECT [table] AS target, [from] AS column FROM pragma_foreign_key_list(?)",
    ).all(table) as { target: string; column: string }[];
    for (const key of keys) {
      if (key.target !== "jobs") continue;
      const unique = (
        sql(
          `SELECT il.name FROM pragma_index_list(?) il WHERE il."unique" = 1`,
        ).all(table) as { name: string }[]
      ).some((index) => {
        const columns = (
          sql("SELECT name FROM pragma_index_info(?)").all(index.name) as {
            name: string | null;
          }[]
        ).map((column) => column.name);
        return columns.length === 1 && columns[0] === key.column;
      });
      const primary = (
        sql("SELECT name, pk FROM pragma_table_info(?) WHERE pk > 0").all(
          table,
        ) as { name: string; pk: number }[]
      ).map((column) => column.name);
      references.push({
        table,
        column: key.column,
        onePerJob:
          unique || (primary.length === 1 && primary[0] === key.column),
      });
    }
  }
  return references;
}

/**
 * Gives every saved job its employer-and-title key, then joins jobs that are
 * one posting seen on several boards, by the same rule a search uses when it
 * saves: same employer and title, no shared board, no different employer
 * apply target, and exactly one such earlier job. Every application,
 * tracker entry, resume, sighting and move moves to the kept job. A pair
 * where both jobs have their own record in a one-per-job table (two
 * applications, two tracker entries, two resumes) stays apart and is
 * reported. Safe to run again: merged jobs no longer exist.
 */
export function mergeSamePostings(sql: Statements): SamePostingMergeReport {
  const report: SamePostingMergeReport = { merged: [], keptApart: [] };
  const addKey = sql(
    "INSERT OR IGNORE INTO job_keys (key, job_id) VALUES (?, ?)",
  );
  for (const job of sql(
    `SELECT id, company, title FROM jobs j WHERE NOT EXISTS (
       SELECT 1 FROM job_keys k WHERE k.job_id = j.id AND k.key >= 'role:' AND k.key < 'role;')`,
  ).all() as { id: number; company: string; title: string }[]) {
    const prefix = rolePrefix(job.company, job.title);
    if (prefix) addKey.run(`${prefix}${job.id}`, job.id);
  }
  const groups = new Map<string, number[]>();
  for (const row of sql(
    "SELECT key, job_id FROM job_keys WHERE key >= 'role:' AND key < 'role;' ORDER BY key",
  ).all() as { key: string; job_id: number }[]) {
    const prefix = row.key.slice(0, row.key.lastIndexOf("|") + 1);
    const ids = groups.get(prefix) ?? [];
    if (!ids.includes(row.job_id)) ids.push(row.job_id);
    groups.set(prefix, ids);
  }
  const exists = sql("SELECT stage, hide_owner FROM jobs WHERE id = ?");
  let references: ReturnType<typeof jobReferences> | null = null;
  const apart = new Set<string>();
  for (const [prefix, ids] of groups) {
    if (ids.length < 2) continue;
    for (const id of [...ids].sort((a, b) => a - b)) {
      if (!exists.get(id)) continue;
      const own = savedPostingFacts(sql, id);
      // Only earlier jobs: a later one meets this job from its own turn.
      const candidates = samePostingCandidates(
        sql,
        prefix,
        own.boards,
        own.targets,
        id,
      ).filter((other) => other < id);
      if (candidates.length !== 1) continue;
      const other = candidates[0]!;
      const pair = `${other}:${id}`;
      if (apart.has(pair)) continue;
      references ??= jobReferences(sql);
      const result = mergePair(sql, references, other, id);
      if ("tables" in result) {
        apart.add(pair);
        report.keptApart.push({ ids: [other, id], tables: result.tables });
      } else report.merged.push(result);
    }
  }
  return report;
}

function mergePair(
  sql: Statements,
  references: ReturnType<typeof jobReferences>,
  first: number,
  second: number,
): SamePostingMerge | { tables: string[] } {
  const owned = (table: string, column: string, id: number) =>
    Boolean(
      sql(`SELECT 1 FROM "${table}" WHERE "${column}" = ? LIMIT 1`).get(id),
    );
  // The listing body, fit and other per-job derivations follow the kept job.
  const derived = new Set(["job_details"]);
  const records = references.filter(
    (reference) => reference.onePerJob && !derived.has(reference.table),
  );
  const both = records
    .filter(
      (reference) =>
        owned(reference.table, reference.column, first) &&
        owned(reference.table, reference.column, second),
    )
    .map((reference) => reference.table);
  if (both.length) return { tables: both };
  const rank = (id: number) => {
    const row = sql("SELECT stage, hide_owner FROM jobs WHERE id = ?").get(
      id,
    ) as { stage: JobStage; hide_owner: string | null };
    const records_ = records.filter((reference) =>
      owned(reference.table, reference.column, id),
    ).length;
    return records_ * 10 + progress(row.stage, row.hide_owner);
  };
  const [kept, merged] =
    rank(second) > rank(first) ? [second, first] : [first, second];
  for (const { table, column } of references)
    sql(
      `UPDATE OR IGNORE "${table}" SET "${column}" = ? WHERE "${column}" = ?`,
    ).run(kept, merged);
  sql(
    `UPDATE jobs SET
       found_at = min(found_at, (SELECT found_at FROM jobs WHERE id = ?)),
       seen_at = max(seen_at, (SELECT seen_at FROM jobs WHERE id = ?)),
       apply_url = coalesce(apply_url, (SELECT apply_url FROM jobs WHERE id = ?)),
       source_count = (SELECT count(DISTINCT site) FROM job_sightings WHERE job_id = ?)
     WHERE id = ?`,
  ).run(merged, merged, merged, kept, kept);
  // What could not move is a repeat of the kept job's own row.
  sql("DELETE FROM jobs WHERE id = ?").run(merged);
  return { kept, merged };
}
