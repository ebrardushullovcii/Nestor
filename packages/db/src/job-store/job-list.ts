import {
  JOB_TOTAL_CAP,
  JobListingFactsSchema,
  type JobDetail,
  type JobFilter,
  type JobFit,
  type JobListPage,
  type JobListQuery,
  type JobRow,
  type JobSort,
  type JobStage,
  type JobStageCounts,
  type WorkMode,
} from "@nestor/contracts";
import type { SQLInputValue } from "node:sqlite";

import type { Statements } from "./statements";

const WORK_MODE_BITS: Record<WorkMode, number> = {
  remote: 1,
  hybrid: 2,
  onsite: 4,
  flexible: 8,
};

export function toWorkModeMask(modes: readonly WorkMode[]): number {
  return modes.reduce((mask, mode) => mask | WORK_MODE_BITS[mode], 0);
}

function fromWorkModeMask(mask: number): WorkMode[] {
  return (Object.keys(WORK_MODE_BITS) as WorkMode[]).filter(
    (mode) => (mask & WORK_MODE_BITS[mode]) !== 0,
  );
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Each word must start a word in the title, company or location. */
export function toTextMatch(text: string): string | null {
  const words = text
    .split(/\s+/u)
    .map((word) => word.replace(/"/gu, "").trim())
    .filter(Boolean)
    .slice(0, 8);
  return words.length > 0 ? words.map((word) => `"${word}"*`).join(" ") : null;
}

export interface FilterSql {
  where: string;
  params: SQLInputValue[];
  /** True when the filter is only a stage, so its count is the stage count. */
  stageOnly: boolean;
}

/** Every stored mask holding any of `modes`, so the filter is index equality. */
function masksWithAny(modes: readonly WorkMode[]): number[] {
  const want = toWorkModeMask(modes);
  return Array.from({ length: 15 }, (_, i) => i + 1).filter(
    (mask) => (mask & want) !== 0,
  );
}

function sharedFilterSql(filter: JobFilter) {
  const clauses = ["j.stage = ?"];
  const params: SQLInputValue[] = [filter.stage];
  if (filter.searchId) {
    clauses.push("j.found_by = ?");
    params.push(filter.searchId);
  }
  const match = toTextMatch(filter.text);
  if (match) {
    clauses.push(
      "j.rowid IN (SELECT rowid FROM jobs_text WHERE jobs_text MATCH ?)",
    );
    params.push(match);
  }
  return { clauses, params };
}

/** The whole filter as one WHERE, for moves and Apply on every match. */
export function toFilterSql(filter: JobFilter): FilterSql {
  const { clauses, params } = sharedFilterSql(filter);
  if (filter.minFit !== null) {
    clauses.push("j.fit_score >= ?");
    params.push(filter.minFit);
  }
  if (filter.workModes.length > 0) {
    const masks = masksWithAny(filter.workModes);
    clauses.push(`j.work_modes IN (${masks.map(() => "?").join(", ")})`);
    params.push(...masks);
  }
  return {
    where: clauses.join(" AND "),
    params,
    stageOnly: clauses.length === 1,
  };
}

/**
 * The filter as disjoint index ranges, one WHERE each: one stored work-mode
 * mask, then assessed at or above the fit floor. A page
 * merges the ranges in sort order and a count adds them up, so neither reads
 * the jobs the filter leaves out, however many there are (schema.ts indexes
 * jobs_by_fit and jobs_by_mode_*).
 */
export function toFilterRanges(
  filter: JobFilter,
  additionalStages: readonly JobStage[] = [],
): FilterSql[] {
  if (additionalStages.length)
    return [filter.stage, ...additionalStages].flatMap((stage) =>
      toFilterRanges({ ...filter, stage }),
    );
  const shared = sharedFilterSql(filter);
  const modes: ([string, SQLInputValue] | null)[] =
    filter.workModes.length > 0
      ? masksWithAny(filter.workModes).map((mask) => ["j.work_modes = ?", mask])
      : [null];
  const fits: ([string, SQLInputValue] | null)[] =
    filter.minFit === null ? [null] : [["j.fit_score >= ?", filter.minFit]];
  return modes.flatMap((mode) =>
    fits.map((fit) => {
      const extra = [mode, fit].filter((part) => part !== null);
      return {
        where: [...shared.clauses, ...extra.map(([clause]) => clause)].join(
          " AND ",
        ),
        params: [...shared.params, ...extra.map(([, value]) => value)],
        stageOnly: shared.clauses.length === 1 && extra.length === 0,
      };
    }),
  );
}

/** Every order ends in `id`, so a page position is exact. All descending. */
const SORT_COLUMNS: Record<JobSort, readonly string[]> = {
  best_fit: ["fit_score", "found_at", "id"],
  newest: ["found_at", "id"],
  posted: ["posted_at", "found_at", "id"],
  recent: ["stage_at", "id"],
};

const ROW_COLUMNS = `j.id, j.stage, j.stage_at, j.stage_note, j.title, j.company, j.location,
  j.work_modes, j.salary_text, j.fit_score, j.fit_summary, j.posted_at,
  j.found_at, j.found_by, j.source_label, j.source_count`;

type RowRecord = {
  id: number;
  stage: JobStage;
  stage_at: number;
  stage_note: string | null;
  title: string;
  company: string;
  location: string;
  work_modes: number;
  salary_text: string | null;
  fit_score: number;
  fit_summary: string | null;
  posted_at: number;
  found_at: number;
  found_by: string | null;
  source_label: string;
  source_count: number;
};

function toRow(record: RowRecord): JobRow {
  return {
    id: record.id,
    stage: record.stage,
    stageChangedAt: toIso(record.stage_at),
    stageNote: record.stage_note,
    title: record.title,
    company: record.company,
    location: record.location,
    workModes: fromWorkModeMask(record.work_modes),
    salaryText: record.salary_text,
    fitScore: record.fit_score >= 0 ? record.fit_score : null,
    fitSummary: record.fit_summary,
    postedAt: record.posted_at > 0 ? toIso(record.posted_at) : null,
    foundAt: toIso(record.found_at),
    searchId: record.found_by,
    sourceLabel: record.source_label,
    sourceCount: record.source_count,
  };
}

function readCursor(
  cursor: string | null,
  length: number,
): (string | number)[] | null {
  if (!cursor) return null;
  try {
    const values: unknown = JSON.parse(cursor);
    if (
      Array.isArray(values) &&
      values.length === length &&
      values.every((v) => typeof v === "string" || typeof v === "number")
    ) {
      return values;
    }
  } catch {
    // A cursor from an older build starts the list over.
  }
  return null;
}

export function readStageCounts(sql: Statements): JobStageCounts {
  const counts: JobStageCounts = {
    found: 0,
    hidden: 0,
    shortlisted: 0,
    resume: 0,
    applied: 0,
  };
  for (const row of sql("SELECT stage, n FROM job_stage_counts").all() as {
    stage: JobStage;
    n: number;
  }[]) {
    counts[row.stage] = row.n;
  }
  return counts;
}

interface Sql {
  sql: string;
  params: SQLInputValue[];
}

/**
 * One page past the cursor: each filter range in index order, merged. A fit
 * floor's ranges come in fit order only, so in another order up to the
 * cap's worth of `matches` are read by their ranges and sorted; past the
 * cap, reading that order's index and skipping jobs below the floor ends
 * sooner.
 */
export function jobPageSql(
  query: JobListQuery,
  matches: number,
  additionalStages: readonly JobStage[] = [],
): Sql {
  const columns = SORT_COLUMNS[query.sort];
  const after = readCursor(query.cursor, columns.length);
  const floorApart = query.minFit !== null && query.sort !== "best_fit";
  const sortMatches = floorApart && matches <= JOB_TOTAL_CAP;
  const arms = toFilterRanges(query, additionalStages).map((range) => ({
    sql: `SELECT ${ROW_COLUMNS} FROM jobs j WHERE ${range.where}${
      after
        ? ` AND (${columns.map((c) => `j.${c}`).join(", ")}) < (${columns.map(() => "?").join(", ")})`
        : ""
    }`,
    params: [...range.params, ...(after ?? [])],
  }));
  const union = arms.map((arm) => arm.sql).join(" UNION ALL ");
  const order = `ORDER BY ${columns.map((c) => `${c} DESC`).join(", ")} LIMIT ?`;
  return {
    sql: sortMatches
      ? `WITH matches AS MATERIALIZED (${union}) SELECT * FROM matches ${order}`
      : `${union} ${order}`,
    params: [...arms.flatMap((arm) => arm.params), query.limit + 1],
  };
}

/**
 * How many jobs match, up to one past the cap (`exact` counts them all):
 * each range counted apart.
 */
export function jobCountSql(
  filter: JobFilter,
  exact = false,
  additionalStages: readonly JobStage[] = [],
): Sql {
  const ranges = toFilterRanges(filter, additionalStages);
  return {
    sql: `SELECT count(*) AS n FROM (${ranges
      .map((range) => `SELECT 1 FROM jobs j WHERE ${range.where}`)
      .join(" UNION ALL ")}${exact ? "" : ` LIMIT ${JOB_TOTAL_CAP + 1}`})`,
    params: ranges.flatMap((range) => range.params),
  };
}

/**
 * Scored jobs under the fit floor that the rest of the filter keeps, up to
 * one past the cap, from the same index ranges; null without a floor.
 */
export function belowFloorSql(
  filter: JobFilter,
  additionalStages: readonly JobStage[] = [],
): Sql | null {
  if (filter.minFit === null) return null;
  const ranges = toFilterRanges({ ...filter, minFit: null }, additionalStages);
  return {
    sql: `SELECT count(*) AS n FROM (${ranges
      .map(
        (range) =>
          `SELECT 1 FROM jobs j WHERE ${range.where} AND j.fit_score >= 0 AND j.fit_score < ?`,
      )
      .join(" UNION ALL ")} LIMIT ${JOB_TOTAL_CAP + 1})`,
    params: ranges.flatMap((range) => [...range.params, filter.minFit]),
  };
}

/** Every job the filter matches, counted exactly however many there are. */
export function countJobs(
  sql: Statements,
  filter: JobFilter,
  additionalStages: readonly JobStage[] = [],
): number {
  if (toFilterSql(filter).stageOnly) {
    const counts = readStageCounts(sql);
    return [filter.stage, ...additionalStages].reduce(
      (sum, stage) => sum + counts[stage],
      0,
    );
  }
  const count = jobCountSql(filter, true, additionalStages);
  return (sql(count.sql).get(...count.params) as { n: number }).n;
}

export function listJobs(
  sql: Statements,
  query: JobListQuery,
  additionalStages: readonly JobStage[] = [],
): JobListPage {
  const columns = SORT_COLUMNS[query.sort];
  const counts = readStageCounts(sql);
  const { stageOnly } = toFilterSql(query);
  const countSql = jobCountSql(query, false, additionalStages);
  const total = stageOnly
    ? [query.stage, ...additionalStages].reduce(
        (sum, stage) => sum + counts[stage],
        0,
      )
    : (sql(countSql.sql).get(...countSql.params) as { n: number }).n;
  const pageSql = jobPageSql(query, total, additionalStages);
  const records = sql(pageSql.sql).all(...pageSql.params) as RowRecord[];
  const below = belowFloorSql(query, additionalStages);
  const belowFloor = below
    ? (sql(below.sql).get(...below.params) as { n: number }).n
    : null;
  const hasMore = records.length > query.limit;
  const page = hasMore ? records.slice(0, query.limit) : records;
  const last = page.at(-1);
  return {
    rows: page.map(toRow),
    nextCursor:
      hasMore && last
        ? JSON.stringify(columns.map((c) => last[c as keyof RowRecord]))
        : null,
    total: stageOnly ? total : Math.min(total, JOB_TOTAL_CAP),
    totalCapped: !stageOnly && total > JOB_TOTAL_CAP,
    belowFloor:
      belowFloor === null ? null : Math.min(belowFloor, JOB_TOTAL_CAP),
    belowFloorCapped: belowFloor !== null && belowFloor > JOB_TOTAL_CAP,
    counts,
  };
}

type DetailRecord = RowRecord & {
  url: string;
  apply_url: string | null;
  seen_at: number;
  description: string;
  summary: string | null;
  seniority: string | null;
  employment_type: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  facts_json: string;
  fit_json: string | null;
  fit_stale: number;
};

export function getJob(sql: Statements, id: number): JobDetail | null {
  const record = sql(
    `SELECT ${ROW_COLUMNS}, j.url, j.apply_url, j.seen_at, d.description, d.summary,
       d.seniority, d.employment_type, d.salary_min, d.salary_max,
       d.salary_currency, d.facts_json, d.fit_json, j.fit_stale
     FROM jobs j JOIN job_details d ON d.job_id = j.id WHERE j.id = ?`,
  ).get(id) as DetailRecord | undefined;
  if (!record) return null;
  const sightings = sql(
    `SELECT source_id, source_label, url, apply_url, seen_at FROM job_sightings
     WHERE job_id = ? ORDER BY seen_at`,
  ).all(id) as {
    source_id: string;
    source_label: string;
    url: string;
    apply_url: string | null;
    seen_at: number;
  }[];
  const hasSalary =
    record.salary_min !== null ||
    record.salary_max !== null ||
    record.salary_currency !== null;
  return {
    ...toRow(record),
    url: record.url,
    applyUrl: record.apply_url,
    seenAt: toIso(record.seen_at),
    description: record.description,
    summary: record.summary,
    seniority: record.seniority,
    employmentType: record.employment_type,
    salary: hasSalary
      ? {
          min: record.salary_min,
          max: record.salary_max,
          currency: record.salary_currency,
        }
      : null,
    facts: JobListingFactsSchema.parse(JSON.parse(record.facts_json)),
    fit: record.fit_json ? (JSON.parse(record.fit_json) as JobFit) : null,
    fitStale: Boolean(record.fit_stale),
    sightings: sightings.map((s) => ({
      sourceId: s.source_id,
      sourceLabel: s.source_label,
      url: s.url,
      applyUrl: s.apply_url,
      seenAt: toIso(s.seen_at),
    })),
  };
}
