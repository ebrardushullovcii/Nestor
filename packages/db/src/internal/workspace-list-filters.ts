import type { DatabaseSync } from "node:sqlite";
import { workModeValues } from "@nestor/contracts";
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
  const labels = new Map<string, string>();
  db.function("workspace_sources", (value) => {
    const text = typeof value === "string" ? value : "[]";
    let found = labels.get(text);
    if (found === undefined) {
      const resolved = getDiscoverySourceLabels(
        JSON.parse(text) as SourceAttribution[],
        [],
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
    void version;
    if (labels.size > 32768) labels.clear();
  };
}
