import type { DatabaseSync } from "node:sqlite";
import {
  workModeValues,
  isLikelyUtilityShortlistJob,
  type JobDiscoveryTarget,
} from "@nestor/contracts";
import {
  getDiscoverySourceLabels,
  type SourceAttribution,
} from "@nestor/job-list-policy/sources";

// Existing row-search labels from match-assessment/listing-activity presentation.
const recommendationLabels: Record<string, string> = {
  strong_fit: "Strong fit",
  apply_with_original: "Original resume is credible",
  review_before_applying: "Review before applying",
  skip: "Probably skip",
};
const activityLabels: Record<string, string> = {
  active: "Active",
  inactive: "Inactive",
  stale: "May be closed",
  closed: "Closed",
  unknown: "Unknown",
};

export function createWorkspaceListFilters(db: DatabaseSync) {
  let generation = "";
  let targets: Array<Pick<JobDiscoveryTarget, "id" | "label">> = [];
  let targetKey = "";
  const labels = new Map<string, string>();
  const pendingVisibility = new Map<string, number>();
  const readPendingBody = db.prepare(
    "SELECT json_extract(value,'$.description') AS description FROM discovery_pending_jobs WHERE id=?",
  );
  db.function(
    "workspace_pending_visible",
    (id, title, company, canonicalUrl, status) => {
      if (status !== "discovered") return 1;
      const key = String(id);
      const cached = pendingVisibility.get(key);
      if (cached !== undefined) return cached;
      const facts = {
        title: String(title),
        company: String(company),
        canonicalUrl: String(canonicalUrl),
      };
      let read = false,
        description: string | undefined;
      Object.defineProperty(facts, "description", {
        get() {
          if (!read) {
            const value = readPendingBody.get(key)?.description;
            description = typeof value === "string" ? value : undefined;
            read = true;
          }
          return description;
        },
      });
      const visible = isLikelyUtilityShortlistJob(facts) ? 0 : 1;
      pendingVisibility.set(key, visible);
      return visible;
    },
  );
  db.function("workspace_sources", (value) => {
    const text = typeof value === "string" ? value : "[]";
    let found = labels.get(text);
    if (found === undefined) {
      const resolved = getDiscoverySourceLabels(
        JSON.parse(text) as SourceAttribution[],
        targets,
      );
      found = JSON.stringify(
        resolved.length ? resolved : ["Source unavailable"],
      );
      labels.set(text, found);
    }
    return found;
  });
  db.function(
    "workspace_search",
    (
      title,
      company,
      location,
      salary,
      status,
      applyPath,
      mode,
      recommendation,
      activity,
      search,
    ) => {
      const query = String(search).trim().toLocaleLowerCase();
      const values = [
        title,
        company,
        location,
        salary,
        status,
        applyPath,
        ...workModeValues.filter((_, i) => (Number(mode) & (1 << i)) !== 0),
        recommendationLabels[String(recommendation)],
        activityLabels[String(activity)],
      ];
      return values.some(
        (value) =>
          typeof value === "string" &&
          value.toLocaleLowerCase().includes(query),
      )
        ? 1
        : 0;
    },
  );
  return (version: string) => {
    if (generation === version) return;
    const normalized = !!db
      .prepare("SELECT 1 FROM schema_migrations WHERE version=27")
      .get();
    targets = normalized
      ? db
          .prepare(
            `SELECT json_extract(j.value,'$.id') AS id,json_extract(j.value,'$.label') AS label
        FROM singleton_state s JOIN search_preference_sources p ON p.preference_id=json_extract(s.value,'$.preferenceId')
        JOIN job_sources j ON j.id=p.source_version_id WHERE s.key='search_preferences' ORDER BY p.position`,
          )
          .all()
          .map((row) => ({ id: String(row.id), label: String(row.label) }))
      : db
          .prepare(
            `SELECT json_extract(t.value,'$.id') AS id,json_extract(t.value,'$.label') AS label
        FROM singleton_state s,json_each(s.value,'$.discovery.targets') t WHERE s.key='search_preferences'`,
          )
          .all()
          .map((row) => ({ id: String(row.id), label: String(row.label) }));
    const nextKey = JSON.stringify(targets);
    if (targetKey !== nextKey || labels.size > 32768) {
      labels.clear();
      targetKey = nextKey;
    }
    pendingVisibility.clear();
    generation = version;
  };
}
