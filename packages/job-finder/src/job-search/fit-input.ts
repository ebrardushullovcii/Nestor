import { createHash } from "node:crypto";
import { toJobSearchGoals, type JobDetail } from "@nestor/contracts";
import type { JobSearchContext } from "./types";

// Retires previous judgments when the listing-fit instructions change.
export const LISTING_FIT_SCORER_VERSION = 2;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function fitContextInput(context: JobSearchContext, request = "") {
  const p = context.profile;
  return {
    scorerVersion: LISTING_FIT_SCORER_VERSION,
    permissionDate: p.workEligibility.limitedWorkPermissions?.length
      ? new Date().toISOString().slice(0, 10)
      : undefined,
    person: {
      headline: p.headline,
      summary: p.summary,
      location: p.currentLocation,
      currentCity: p.currentCity,
      currentRegion: p.currentRegion,
      currentCountry: p.currentCountry,
      yearsExperience: p.yearsExperience,
      workEligibility: p.workEligibility,
      skills: p.skills,
      skillGroups: p.skillGroups,
      experiences: p.experiences,
      education: p.education,
      projects: p.projects,
      spokenLanguages: p.spokenLanguages,
      resume:
        p.experiences.length || p.skills.length
          ? undefined
          : p.baseResume.textContent,
    },
    goals: toJobSearchGoals({
      ...context.searchPreferences,
      remoteCountsAsAnyLocation: context.remoteCountsAsAnyLocation ?? true,
    }),
    countryOptionFallbacks: context.countryOptionFallbacks ?? [],
    request,
  };
}

export const fitContextFingerprint = (
  context: JobSearchContext,
  request = "",
) => hash(fitContextInput(context, request));
export function fitInputFingerprint(
  contextKey: string,
  job: JobDetail,
): string {
  return hash({
    contextKey,
    title: job.title,
    company: job.company,
    location: job.location,
    workModes: job.workModes,
    employmentType: job.employmentType,
    salaryText: job.salaryText,
    seniority: job.seniority,
    description: job.description,
  });
}
