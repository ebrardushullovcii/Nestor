import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  isLikelyUtilityShortlistJob,
  resolveSavedJobCompany,
  resolveSavedJobLocation,
} from "@nestor/contracts";

/** The existing intake/display policy, with bodies read only if it needs one. */
export function registerWorkspaceStartupListFacts(db: DatabaseSync): void {
  const description = db.prepare(
    "SELECT json_extract(value,'$.description') AS value FROM saved_jobs WHERE id=?",
  );
  for (const field of ["visible", "company", "location"] as const) {
    db.function(
      `workspace_startup_${field}`,
      (id, title, company, canonicalUrl, location, status): SQLInputValue => {
        const job = {
          title: String(title ?? ""),
          company: String(company ?? ""),
          canonicalUrl: String(canonicalUrl ?? ""),
          location: String(location ?? ""),
          get description(): string {
            const value = description.get(id)?.value;
            return typeof value === "string" ? value : "";
          },
        };
        if (field === "company") return resolveSavedJobCompany(job);
        if (field === "location") return resolveSavedJobLocation(job);
        return status !== "discovered" || !isLikelyUtilityShortlistJob(job)
          ? 1
          : 0;
      },
    );
  }
}
