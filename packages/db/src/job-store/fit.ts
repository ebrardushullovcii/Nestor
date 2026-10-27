import { JobFitSchema, type JobFitSummary } from "@nestor/contracts";
import type { Statements } from "./statements";

export function syncFitContext(sql: Statements, fingerprint: string): boolean {
  const before = sql("SELECT fingerprint FROM fit_context WHERE id=1").get() as
    | { fingerprint: string }
    | undefined;
  if (before?.fingerprint === fingerprint) return false;
  sql(
    "INSERT INTO fit_context(id,fingerprint) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint",
  ).run(fingerprint);
  sql("UPDATE jobs SET fit_stale=1 WHERE stage='found'").run();
  return true;
}

export function fitCounts(sql: Statements): {
  checking: number;
  rechecking: number;
} {
  return sql(`SELECT count(*) AS checking,
    coalesce(sum(CASE WHEN fit_score >= 0 THEN 1 ELSE 0 END),0) AS rechecking
    FROM jobs WHERE stage='found' AND (fit_score=-1 OR fit_stale=1)`).get() as {
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
    sql(`UPDATE jobs SET stage='found',stage_at=?,stage_note=NULL,hide_owner=NULL,fit_stale=1
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
