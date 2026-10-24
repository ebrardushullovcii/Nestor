import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  fitRecommendationValues,
  workModeValues,
  type WorkspaceJobListFacets,
} from "@nestor/contracts";
import { compareSourceLabels } from "@nestor/job-list-policy/sources";

export function createWorkspaceListFacets(db: DatabaseSync) {
  type Base = Omit<
    WorkspaceJobListFacets,
    "locationReach" | "assessed" | "newSince"
  >;
  const cache = new Map<string, { facets: Base; lookalikes: Set<string> }>();
  const filteredCache = new Map<
    string,
    {
      locationReach: WorkspaceJobListFacets["locationReach"];
      newCount: number | null;
      tiedScores: Set<number>;
    }
  >();
  let tiedScores = new Set<number>();
  db.function("workspace_score_tied", (score, unjudged, provisional) =>
    unjudged === 0 && provisional === 0 && tiedScores.has(Number(score))
      ? 1
      : 0,
  );
  const lookalikeKey = (
    title: unknown,
    company: unknown,
    location: unknown,
    labels: unknown,
  ) =>
    [title, company, location, JSON.parse(String(labels)) as string[]].join(
      "\u0000",
    );
  let lookalikes = new Set<string>();
  db.function("workspace_lookalike", (title, company, location, labels) =>
    lookalikes.has(lookalikeKey(title, company, location, labels)) ? 1 : 0,
  );
  let generation = "";
  return (
    version: string,
    from: string,
    pool: string,
    poolArgs: SQLInputValue[],
    condition: string,
    args: SQLInputValue[],
    newSince?: string,
  ): WorkspaceJobListFacets => {
    if (generation !== version) {
      cache.clear();
      filteredCache.clear();
      generation = version;
    }
    const key = JSON.stringify([pool, poolArgs]);
    let cached = cache.get(key);
    const group = (expression: string, where = pool, values = poolArgs) =>
      db
        .prepare(
          `SELECT ${expression} AS value,count(*) AS count ${from} WHERE ${where} GROUP BY ${expression}`,
        )
        .all(...values)
        .map((row) => ({ value: String(row.value), count: Number(row.count) }));
    if (!cached) {
      const modes = new Map<number, number>(
        group("i.work_mode").map((row) => [Number(row.value), row.count]),
      );
      const recommendations = group("i.recommendation");
      const activities = group("a.status");
      const sources = db
        .prepare(
          `SELECT s.value,count(*) AS count ${from},json_each(workspace_sources(i.source_provenance)) s WHERE ${pool} GROUP BY s.value`,
        )
        .all(...poolArgs)
        .map((row) => ({ value: String(row.value), count: Number(row.count) }))
        .sort((a, b) => compareSourceLabels(a.value, b.value));
      const base: Base = {
        recommendations: fitRecommendationValues.flatMap((value) =>
          recommendations
            .filter((row) => row.value === value)
            .map((row) => ({ value, count: row.count })),
        ),
        activities: (
          ["active", "inactive", "stale", "closed", "unknown"] as const
        ).flatMap((value) =>
          activities
            .filter((row) => row.value === value)
            .map((row) => ({ value, count: row.count })),
        ),
        sources,
        workModes: [
          ...workModeValues.flatMap((value, index) => {
            const count = [...modes].reduce(
              (sum, [mask, n]) => sum + ((mask & (1 << index)) !== 0 ? n : 0),
              0,
            );
            return count ? [{ value, count }] : [];
          }),
          ...(modes.get(0)
            ? [{ value: "Not specified", count: modes.get(0)! }]
            : []),
        ],
      };
      const duplicates = db
        .prepare(
          `SELECT i.title,i.company,COALESCE(i.location,'') AS location,workspace_sources(i.source_provenance) AS labels
        ${from} WHERE ${pool} GROUP BY i.title,i.company,COALESCE(i.location,''),labels HAVING count(*)>1`,
        )
        .all(...poolArgs);
      cached = {
        facets: base,
        lookalikes: new Set(
          duplicates.map((row) =>
            lookalikeKey(row.title, row.company, row.location, row.labels),
          ),
        ),
      };
      cache.set(key, cached);
    }
    lookalikes = cached.lookalikes;
    const filterKey = JSON.stringify([key, condition, args, newSince]);
    let filtered = filteredCache.get(filterKey);
    if (!filtered) {
      const locationReach = group(
        "COALESCE(i.location_reach,'unknown')",
        `${condition} AND i.unjudged=0`,
        args,
      ).map((row) => ({
        value:
          row.value as WorkspaceJobListFacets["locationReach"][number]["value"],
        count: row.count,
      }));
      const newCount = newSince
        ? Number(
            db
              .prepare(
                `SELECT count(*) AS count ${from} WHERE ${pool} AND workspace_listing_time(COALESCE(i.first_seen_at,i.discovered_at))>?`,
              )
              .get(...poolArgs, Date.parse(newSince))!.count,
          )
        : null;
      const ties = db
        .prepare(
          `SELECT i.score ${from} WHERE ${condition} AND i.unjudged=0 AND i.provisional=0 GROUP BY i.score HAVING count(*)>1`,
        )
        .all(...args);
      filtered = {
        locationReach,
        newCount,
        tiedScores: new Set(ties.map((row) => Number(row.score))),
      };
      filteredCache.set(filterKey, filtered);
    }
    tiedScores = filtered.tiedScores;
    return {
      ...structuredClone(cached.facets),
      locationReach: structuredClone(filtered.locationReach),
      assessed: filtered.locationReach.reduce((sum, row) => sum + row.count, 0),
      newSince: filtered.newCount,
    };
  };
}
