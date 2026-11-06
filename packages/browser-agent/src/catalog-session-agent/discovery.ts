import { reportSelfLimitHit, selfLimitSlice } from "@nestor/core";
import type { JobPosting, JobSearchPreferences } from "@nestor/contracts";
import type { CatalogSessionAgentDiscoveryOptions } from "./session-agent";
import {
  matchesAnyPhrase,
  meetsCompensationMinimum,
  normalizeText,
} from "./shared";

export function buildDiscoveryQuerySummary(
  searchPreferences: JobSearchPreferences,
): string {
  const roles = searchPreferences.targetRoles.join(", ") || "all roles";
  const locations = searchPreferences.locations.join(", ") || "all locations";
  const workModes = searchPreferences.workModes.join(", ") || "all work modes";

  return `${roles} | ${locations} | ${workModes}`;
}

export function filterCatalogDiscoveryJobs(
  jobs: readonly JobPosting[],
  searchPreferences: JobSearchPreferences,
): JobPosting[] {
  return jobs.filter((job) => {
    if (job.applyPath !== "easy_apply" || !job.easyApplyEligible) {
      reportSelfLimitHit({
        limit: "catalog_apply_path_veto",
        kind: "veto",
        value: "easy_apply only",
        where: "packages/browser-agent/src/catalog-session-agent/discovery.ts",
      });
      return false;
    }

    if (
      searchPreferences.companyBlacklist.some(
        (company) => normalizeText(company) === normalizeText(job.company),
      )
    ) {
      return false;
    }

    const matchesRole = matchesAnyPhrase(
      job.title,
      searchPreferences.targetRoles,
    );
    const matchesLocation = matchesAnyPhrase(
      job.location,
      searchPreferences.locations,
    );
    const matchesWorkMode =
      searchPreferences.workModes.length === 0 ||
      searchPreferences.workModes.includes("flexible") ||
      job.workMode.length === 0 ||
      job.workMode.includes("flexible") ||
      job.workMode.some((mode) => searchPreferences.workModes.includes(mode));
    const meetsSalaryExpectation = meetsCompensationMinimum(
      job.salaryText,
      searchPreferences.compensation,
    );

    if (!matchesRole || !matchesLocation)
      reportSelfLimitHit({
        limit: "catalog_keyword_veto",
        kind: "veto",
        value: "title/location phrase match",
        where: "packages/browser-agent/src/catalog-session-agent/discovery.ts",
      });
    return (
      matchesRole &&
      matchesLocation &&
      matchesWorkMode &&
      meetsSalaryExpectation
    );
  });
}

export function filterCatalogAgentDiscoveryJobs(
  jobs: readonly JobPosting[],
  options: CatalogSessionAgentDiscoveryOptions,
): JobPosting[] {
  return selfLimitSlice(
    jobs.filter((job) => {
      if (job.applyPath !== "easy_apply" || !job.easyApplyEligible) {
        reportSelfLimitHit({
          limit: "catalog_apply_path_veto",
          kind: "veto",
          value: "easy_apply only",
          where:
            "packages/browser-agent/src/catalog-session-agent/discovery.ts",
        });
        return false;
      }

      if (
        options.searchPreferences.companyBlacklist.some(
          (company) => normalizeText(company) === normalizeText(job.company),
        )
      ) {
        return false;
      }

      const matchesRole = matchesAnyPhrase(
        job.title,
        options.searchPreferences.targetRoles,
      );
      const matchesLocation = matchesAnyPhrase(
        job.location,
        options.searchPreferences.locations,
      );
      if (!matchesRole || !matchesLocation)
        reportSelfLimitHit({
          limit: "catalog_keyword_veto",
          kind: "veto",
          value: "title/location phrase match",
          where:
            "packages/browser-agent/src/catalog-session-agent/discovery.ts",
        });
      return matchesRole && matchesLocation;
    }),
    0,
    options.targetJobCount,
    "packages/browser-agent/src/catalog-session-agent/discovery.ts:82",
  );
}
