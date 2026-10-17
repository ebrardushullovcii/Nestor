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
  return jobs
    .filter((job) => {
      if (job.applyPath !== "easy_apply" || !job.easyApplyEligible) {
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
      return matchesRole && matchesLocation;
    })
    .slice(0, options.targetJobCount);
}
