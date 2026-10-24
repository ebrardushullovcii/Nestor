import type { DatabaseSync } from "node:sqlite";
import {
  getDiscoveryListingRecencyKey,
  toSortableListingTime,
} from "@nestor/job-list-policy/ordering";

/** SQLite exposes no ICU collation callback. Rank distinct scalar strings with the exact existing collators. */
export function createWorkspaceListOrdering(db: DatabaseSync) {
  let generation = "";
  const lexical = new Map<string, number>(),
    company = new Map<string, number>();
  const collator = new Intl.Collator("en", {
    sensitivity: "base",
    numeric: true,
  });
  const key = (value: unknown) => (typeof value === "string" ? value : "");
  db.function("workspace_lexical", (value) => lexical.get(key(value)) ?? 0);
  db.function(
    "workspace_company_order",
    (value) => company.get(key(value)) ?? 0,
  );
  db.function("workspace_listing_time", (value) => {
    const time = toSortableListingTime(
      typeof value === "string" ? value : null,
    );
    return Number.isFinite(time) ? time : null;
  });
  db.function(
    "workspace_newest",
    (postedAt, postedAtText, providerUpdatedAt) => {
      const recency = getDiscoveryListingRecencyKey({
        postedAt: postedAt as string | null,
        postedAtText: postedAtText as string | null,
        providerUpdatedAt: providerUpdatedAt as string | null,
      });
      return recency.basis === null ? null : recency.timestamp;
    },
  );
  return (version: string) => {
    if (generation === version) return;
    const values = db
      .prepare(
        "SELECT title AS value FROM workspace_job_index UNION SELECT company FROM workspace_job_index UNION SELECT id FROM workspace_job_index",
      )
      .all()
      .map((row) => String(row.value));
    for (const [target, compare] of [
      [lexical, (a: string, b: string) => a.localeCompare(b)],
      [company, (a: string, b: string) => collator.compare(a, b)],
    ] as const) {
      target.clear();
      let rank = 0;
      let previous: string | undefined;
      for (const value of [...values].sort(compare)) {
        if (previous !== undefined && compare(previous, value) !== 0) rank++;
        target.set(value, rank);
        previous = value;
      }
    }
    generation = version;
  };
}

const fit = `i.unjudged, (a.status='closed'), i.mismatch, i.provisional, i.outside, i.rank_score DESC,
 i.title_family, workspace_listing_time(i.recency) DESC, i.detail,
 workspace_lexical(i.title),workspace_lexical(i.company),workspace_lexical(i.id)`;
export const workspaceJobOrder = {
  best_match: `CASE i.result_group WHEN 'matches' THEN 0 WHEN 'weaker' THEN 1 WHEN 'mismatches' THEN 2 ELSE 3 END, i.mismatch, ${fit}`,
  newest: `i.mismatch,workspace_newest(i.posted_at,i.posted_text,i.provider_updated_at) DESC,${fit}`,
  company: `i.mismatch,workspace_company_order(i.company),workspace_company_order(i.title),${fit}`,
  title: `workspace_lexical(i.title),workspace_lexical(i.company),${fit}`,
  recently_seen: `workspace_listing_time(i.seen) DESC,${fit}`,
};

/** Reuse the same total order across pages and membership-only triage edits. */
export function createWorkspacePageOrder(db: DatabaseSync) {
  db.exec(`CREATE TEMP TABLE workspace_page_order (
    plan_id TEXT, sort TEXT, position INTEGER, origin TEXT, id TEXT,
    PRIMARY KEY(plan_id,sort,position),UNIQUE(plan_id,sort,origin,id))`);
  const versions = new Map<string, string>();
  return {
    ensure(
      planId: string,
      sort: keyof typeof workspaceJobOrder,
      version: string,
      from: string,
    ) {
      const key = `${planId}\u0000${sort}`;
      if (versions.get(key) === version) return;
      db.prepare(
        "DELETE FROM workspace_page_order WHERE plan_id=? AND sort=?",
      ).run(planId, sort);
      const put = db.prepare(
        "INSERT INTO workspace_page_order VALUES (?,?,?,?,?)",
      );
      let position = 0;
      for (const row of db
        .prepare(
          `SELECT i.origin,i.id ${from} WHERE i.plan_id=? ORDER BY ${workspaceJobOrder[sort]}`,
        )
        .iterate(planId))
        put.run(planId, sort, position++, row.origin!, row.id!);
      versions.set(key, version);
    },
    invalidate() {
      versions.clear();
    },
  };
}
