import {
  assessJobPostingDetailQuality,
  JobPostingSchema,
  type FoundJob,
  type JobDetail,
  type JobDiscoveryTarget,
  type JobPosting,
  type JobSearchPreferences,
  type JobSearchSettings,
} from "@nestor/contracts";

function words(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function containsPhrase(text: string, phrase: string): boolean {
  const normalized = words(phrase);
  return (
    normalized.length > 0 && ` ${words(text)} `.includes(` ${normalized} `)
  );
}

export function keepPosting(
  posting: JobPosting,
  preferences: JobSearchPreferences,
  settings: JobSearchSettings,
  now: number,
): boolean {
  if (
    preferences.companyBlacklist.some((name) =>
      containsPhrase(posting.company, name),
    )
  )
    return false;
  if (
    preferences.excludedLocations.some((place) =>
      containsPhrase(posting.location, place),
    )
  )
    return false;
  const days =
    settings.postedWithin === "week"
      ? 7
      : settings.postedWithin === "month"
        ? 30
        : null;
  return (
    days === null ||
    !posting.postedAt ||
    !(Date.parse(posting.postedAt) < now - days * 86_400_000)
  );
}

export function toFoundJob(
  posting: JobPosting,
  target: JobDiscoveryTarget,
): FoundJob {
  return {
    ...(posting.searchRejection
      ? { hiddenReason: posting.searchRejection.reason }
      : {}),
    title: posting.title,
    company: posting.company,
    location: posting.location,
    workModes: posting.workMode,
    url: posting.canonicalUrl,
    applyUrl: posting.applicationUrl,
    sourceId: target.id,
    sourceLabel: target.label,
    sourceJobId: posting.sourceJobId,
    postedAt: posting.postedAt,
    salaryText: posting.salaryText,
    salaryMin: posting.normalizedCompensation.minAmount,
    salaryMax: posting.normalizedCompensation.maxAmount,
    salaryCurrency: posting.normalizedCompensation.currency,
    seniority: posting.seniority,
    employmentType: posting.employmentType,
    summary: posting.summary,
    description: posting.description,
    facts: {
      keySkills: posting.keySkills,
      responsibilities: posting.responsibilities,
      minimumQualifications: posting.minimumQualifications,
      preferredQualifications: posting.preferredQualifications,
      benefits: posting.benefits,
      department: posting.department,
      team: posting.team,
      employerDomain: posting.employerDomain,
      atsProvider: posting.atsProvider,
    },
  };
}

/** The store holds the listing body; read it once, only when a batch starts. */
export function toFitPosting(job: JobDetail): JobPosting {
  const posting = JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: String(job.id),
    canonicalUrl: job.url,
    applicationUrl: job.applyUrl,
    title: job.title,
    company: job.company,
    location: job.location,
    workMode: job.workModes,
    applyPath: "unknown",
    easyApplyEligible: false,
    discoveredAt: job.foundAt,
    postedAt: job.postedAt,
    salaryText: job.salaryText,
    normalizedCompensation: {
      minAmount: job.salary?.min ?? null,
      maxAmount: job.salary?.max ?? null,
      currency: job.salary?.currency ?? null,
    },
    seniority: job.seniority,
    employmentType: job.employmentType,
    summary: job.summary,
    description: job.description,
    ...job.facts,
  });
  return { ...posting, detailQuality: assessJobPostingDetailQuality(posting) };
}

/** Checkpoints contain the entire running list; only consume each identity once. */
export function postingKey(posting: JobPosting): string {
  return posting.sourceJobId || posting.canonicalUrl;
}
