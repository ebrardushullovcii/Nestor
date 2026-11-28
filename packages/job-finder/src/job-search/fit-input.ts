import { buildListingFitPerson } from "@nestor/browser-agent";
import { createHash } from "node:crypto";
import { toJobSearchGoals, type JobDetail } from "@nestor/contracts";
import type { JobSearchContext } from "./types";

// Retires previous judgments when the listing-fit instructions change.
export const LISTING_FIT_SCORER_VERSION = 12;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function fitContextInput(context: JobSearchContext, request = "") {
  const p = context.profile;
  return {
    scorerVersion: LISTING_FIT_SCORER_VERSION,
    person: buildListingFitPerson(p),
    goals: toJobSearchGoals({
      ...context.searchPreferences,
      remoteCountsAsAnyLocation: context.remoteCountsAsAnyLocation ?? true,
    }),
    countryOptionFallbacks: context.countryOptionFallbacks ?? [],
    savedAnswers: context.savedAnswers ?? [],
    request,
  };
}

export const fitContextFingerprint = (
  context: JobSearchContext,
  request = "",
) => hash(fitContextInput(context, request));

export function fitContextFingerprints(context: JobSearchContext) {
  const input = fitContextInput(context);
  // Country-list fallbacks also come from the saved answer bank.
  const { scorerVersion, person, goals } = input;
  return {
    // Keep the combined hash byte-for-byte compatible with existing stores.
    fingerprint: hash(input),
    scoringFingerprint: hash({ scorerVersion, person, goals }),
  };
}

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
    postedAt: job.postedAt,
    fullListingRead: job.facts.fullListingRead ?? null,
    description: job.description,
  });
}
