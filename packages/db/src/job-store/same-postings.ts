import type { JobStage } from "@nestor/contracts";
import {
  boardOf,
  employerApplyTarget,
  normalizeUrl,
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
  /** Jobs that let go of listings nothing tied to them, and how many. */
  untangled: { id: number; released: number }[];
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
  const report: SamePostingMergeReport = {
    untangled: untangleJobs(sql),
    merged: [],
    keptApart: [],
  };
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

/**
 * One listing on a board, across its hosts, its tracking parameters and the
 * sections it is filed under: We Work Remotely serves one posting at
 * /listings/<name> and /remote-jobs/<name>.
 */
function listingOf(url: string): string {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
    return `${boardOf(url)}/${name.toLowerCase()}`;
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Lets a job go of listings that were joined to it by mistake. A board's own
 * page that many listings carry as their apply link (a help article, an
 * account sign-up) and a board number that repeats across employers once
 * joined every such listing into one job, and the next full read of any of
 * them rewrote that job's facts. A job is tangled when its own board holds
 * another listing, or another board holds several, that neither its own
 * listing (its first URL, which is never rewritten) nor its employer's
 * application form ties to it. A tangled job keeps only those tied listings.
 * The rest are let go with their keys and remembered cards, and its own
 * card is forgotten too, so the next search reads each listing again and
 * saves or joins it by the current rules; reading its own page restores the
 * job's facts. Jobs whose listings are one per board are left alone.
 */
function untangleJobs(sql: Statements): { id: number; released: number }[] {
  const report: { id: number; released: number }[] = [];
  const jobs = sql(
    `SELECT j.id, j.url, j.apply_url FROM jobs j
     WHERE (SELECT count(*) FROM job_sightings s WHERE s.job_id = j.id) > 1`,
  ).all() as { id: number; url: string; apply_url: string | null }[];
  for (const job of jobs) {
    const sightings = sql(
      "SELECT url, apply_url FROM job_sightings WHERE job_id = ?",
    ).all(job.id) as { url: string; apply_url: string | null }[];
    const own = listingOf(job.url);
    const targets = new Set<string>();
    // Its facts and apply link may have been rewritten; its own listing's
    // sightings keep the link that listing gave.
    for (const row of sightings.filter((s) => listingOf(s.url) === own)) {
      const target = employerApplyTarget(row.url, row.apply_url);
      if (target) targets.add(target);
    }
    const tied = (row: { url: string; apply_url: string | null }) => {
      if (listingOf(row.url) === own) return true;
      const target = employerApplyTarget(row.url, row.apply_url);
      return target !== null && targets.has(target);
    };
    const listings = new Map<string, Set<string>>();
    for (const row of sightings) {
      const board = boardOf(row.url);
      const seen = listings.get(board) ?? new Set<string>();
      seen.add(listingOf(row.url));
      listings.set(board, seen);
    }
    const loose = sightings.filter((row) => !tied(row));
    const tangled = loose.some((row) => {
      const board = boardOf(row.url);
      return board === boardOf(job.url) || listings.get(board)!.size > 1;
    });
    if (!tangled) continue;
    const kept = sightings.filter(tied);
    for (const row of loose)
      sql("DELETE FROM job_sightings WHERE job_id = ? AND url = ?").run(
        job.id,
        row.url,
      );
    // Its keys came partly from listings that were never this job's, and
    // partly from shared board pages no key is made from any more. It keeps
    // the keys of its own listings and employer forms; its own page gives
    // back the rest when it is read again.
    sql(
      `DELETE FROM job_keys WHERE job_id = ? AND (key >= 'id:' AND key < 'id;'
         OR key >= 'url:' AND key < 'url;' OR key >= 'facts:' AND key < 'facts;'
         OR key >= 'role:' AND key < 'role;')`,
    ).run(job.id);
    const addKey = sql(
      "INSERT OR IGNORE INTO job_keys (key, job_id) VALUES (?, ?)",
    );
    addKey.run(`url:${normalizeUrl(job.url)}`, job.id);
    for (const row of kept) {
      addKey.run(`url:${normalizeUrl(row.url)}`, job.id);
      const target = employerApplyTarget(row.url, row.apply_url);
      if (target) addKey.run(`url:${target}`, job.id);
    }
    sql("DELETE FROM listing_card_evidence WHERE job_id = ?").run(job.id);
    if (!kept.some((row) => row.apply_url === job.apply_url))
      sql("UPDATE jobs SET apply_url = ? WHERE id = ?").run(
        kept.find((row) => listingOf(row.url) === own)?.apply_url ?? null,
        job.id,
      );
    sql(
      "UPDATE jobs SET source_count = (SELECT count(DISTINCT site) FROM job_sightings WHERE job_id = ?) WHERE id = ?",
    ).run(job.id, job.id);
    report.push({ id: job.id, released: loose.length });
  }
  return report;
}
