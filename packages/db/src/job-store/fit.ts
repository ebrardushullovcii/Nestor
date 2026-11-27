import { JobFitSchema, type JobFitSummary } from "@nestor/contracts";
import type { Statements } from "./statements";

// fit_stale: 0 = current, 1 = ready to recheck, 2 = earlier score awaiting view.
const IMMEDIATE_SAVED_FIT =
  "(j.stage IN ('shortlisted','resume') OR j.fit_score>=40)";
export const READY_FOR_FIT = `(j.fit_score=-1 OR j.fit_stale=1
  OR (j.fit_stale=2 AND ${IMMEDIATE_SAVED_FIT}))`;

export function syncFitContext(sql: Statements, fingerprint: string): boolean {
  const before = sql("SELECT fingerprint FROM fit_context WHERE id=1").get() as
    | { fingerprint: string }
    | undefined;
  if (before?.fingerprint === fingerprint) return false;
  sql(
    "INSERT INTO fit_context(id,fingerprint) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint",
  ).run(fingerprint);
  sql(`UPDATE jobs AS j SET fit_stale=CASE WHEN ${IMMEDIATE_SAVED_FIT} THEN 1 ELSE 2 END
    WHERE j.fit_score>=0 AND j.stage IN ('found','shortlisted','resume','hidden')
    AND j.hide_owner IS NOT 'closed_listing'`).run();
  return true;
}

/** Seeing a deferred job puts its refresh in the durable fit queue. */
export function requestDeferredFits(
  sql: Statements,
  ids: readonly number[],
): number[] {
  if (!ids.length) return [];
  return (
    sql(`UPDATE jobs SET fit_stale=1 WHERE fit_stale=2 AND stage<>'applied'
      AND hide_owner IS NOT 'closed_listing'
      AND id IN (SELECT value FROM json_each(?)) RETURNING id`).all(
      JSON.stringify(ids),
    ) as { id: number }[]
  ).map((row) => row.id);
}

export function unscoredJobIds(sql: Statements, limit: number): number[] {
  return (
    sql(`SELECT j.id FROM jobs j
      WHERE (j.stage IN ('found','shortlisted','resume') OR
        (j.stage='hidden' AND (j.hide_owner='age_retention' OR j.fit_score>=0)))
        AND j.hide_owner IS NOT 'closed_listing' AND ${READY_FOR_FIT}
      ORDER BY CASE j.stage WHEN 'found' THEN 0 ELSE 1 END, j.fit_score DESC, j.found_at DESC LIMIT ?`).all(
      limit,
    ) as { id: number }[]
  ).map((row) => row.id);
}

export function fitCounts(sql: Statements): {
  checking: number;
  rechecking: number;
} {
  return sql(`SELECT count(*) AS checking,
    coalesce(sum(CASE WHEN fit_score >= 0 THEN 1 ELSE 0 END),0) AS rechecking
    FROM jobs j WHERE j.stage='found' AND ${READY_FOR_FIT}`).get() as {
    checking: number;
    rechecking: number;
  };
}

export function fitSummary(sql: Statements, floor: number): JobFitSummary {
  const groups =
    sql(`SELECT json_extract(d.fit_json,'$.limit') AS limit_json, count(*) AS n
    FROM jobs j JOIN job_details d ON d.job_id=j.id
    WHERE j.stage='found' AND j.fit_score >= 0 AND j.fit_score < ?
    GROUP BY json_extract(d.fit_json,'$.limit') ORDER BY n DESC`).all(
      floor,
    ) as { limit_json: string | null; n: number }[];
  return {
    total: groups.reduce((sum, row) => sum + row.n, 0),
    checking: fitCounts(sql).checking,
    limits: groups.flatMap((row) => {
      const parsed = JobFitSchema.shape.limit.safeParse(
        row.limit_json ? JSON.parse(row.limit_json) : undefined,
      );
      return parsed.success && parsed.data
        ? [{ ...parsed.data, count: row.n }]
        : [];
    }),
  };
}

export function restoreAgeHidden(
  sql: Statements,
  cutoff: number | null,
): number {
  return Number(
    sql(`UPDATE jobs SET stage='found',stage_at=?,stage_note=NULL,hide_owner=NULL
    WHERE stage='hidden' AND hide_owner='age_retention' AND (? IS NULL OR posted_at=0 OR posted_at>=?)`).run(
      Date.now(),
      cutoff,
      cutoff,
    ).changes,
  );
}

/** Recognize only the exact notes emitted by the old retention writer. */
export function migrateHideOwners(sql: Statements): void {
  sql(`UPDATE jobs SET hide_owner=CASE
    WHEN stage_note IN ('Posted more than 7 days ago; this search kept newer listings. You can show it again.',
      'Posted more than 30 days ago; this search kept newer listings. You can show it again.') THEN 'age_retention'
    WHEN stage_note='Closed: this vacancy is no longer accepting applications.' THEN 'closed_listing'
    ELSE 'person' END WHERE stage='hidden' AND hide_owner IS NULL`).run();
}
