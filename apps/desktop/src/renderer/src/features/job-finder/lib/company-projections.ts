import type {
  ApplicationRecord,
  CompanyEntity,
  JobListRow,
} from "@nordri/contracts";

/**
 * Renderer-safe display projections for the Companies screens. These mirror
 * the authoritative pure operations in `@nordri/job-finder` (which the
 * main process uses) without pulling the job-finder package into the renderer
 * bundle. Semantics are intentionally identical: identity is only ever linked
 * through exact employer identity, and ambiguous near matches are surfaced
 * for review, never silently merged.
 */

export type CompanyListingJob = JobListRow;

export type CompanyJobIndex = ReadonlyMap<string, CompanyListingJob>;

export function indexCompanyJobs(
  jobs: readonly CompanyListingJob[],
): CompanyJobIndex {
  const jobById = new Map<string, CompanyListingJob>();
  for (const job of jobs) {
    if (!jobById.has(job.id)) jobById.set(job.id, job);
  }
  return jobById;
}

export type CompanyOpeningsProjection = {
  companyId: string;
  lastSeenAvailable: CompanyListingJob[];
  needsVerification: CompanyListingJob[];
  reportedClosed: CompanyListingJob[];
  lastSeenAvailableCount: number;
  needsVerificationCount: number;
  reportedClosedCount: number;
  totalCount: number;
  lastOpenedAt: string | null;
};

function getListingOrderDate(job: JobListRow): string | null {
  return job.postedAt ?? job.providerUpdatedAt;
}

function compareOpenedAtDescending(
  first: CompanyListingJob,
  second: CompanyListingJob,
): number {
  const firstOpenedAt = getListingOrderDate(first);
  const secondOpenedAt = getListingOrderDate(second);
  if (firstOpenedAt && secondOpenedAt) {
    const difference = Date.parse(secondOpenedAt) - Date.parse(firstOpenedAt);
    if (difference !== 0) return difference;
  } else if (firstOpenedAt) {
    return -1;
  } else if (secondOpenedAt) {
    return 1;
  }
  return first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
}

export function projectCompanyOpenings(input: {
  company: CompanyEntity;
  jobs: readonly CompanyListingJob[];
  jobById?: CompanyJobIndex;
}): CompanyOpeningsProjection {
  const jobById = input.jobById ?? indexCompanyJobs(input.jobs);
  const linked: CompanyListingJob[] = [];
  const linkedJobIds = new Set<string>();
  for (const jobId of input.company.jobIds) {
    if (linkedJobIds.has(jobId)) continue;
    linkedJobIds.add(jobId);
    const job = jobById.get(jobId);
    if (job) linked.push(job);
  }
  const lastSeenAvailable: CompanyListingJob[] = [];
  const needsVerification: CompanyListingJob[] = [];
  const reportedClosed: CompanyListingJob[] = [];
  for (const job of linked) {
    const activityStatus = job.listingActivity?.status ?? "unknown";
    if (activityStatus === "active") {
      lastSeenAvailable.push(job);
    } else if (activityStatus === "closed") {
      reportedClosed.push(job);
    } else {
      needsVerification.push(job);
    }
  }
  lastSeenAvailable.sort(compareOpenedAtDescending);
  needsVerification.sort(compareOpenedAtDescending);
  reportedClosed.sort(compareOpenedAtDescending);

  let lastOpenedAt: string | null = null;
  for (const job of linked) {
    const openedAt = getListingOrderDate(job);
    if (!openedAt) continue;
    if (
      lastOpenedAt === null ||
      Date.parse(openedAt) > Date.parse(lastOpenedAt)
    ) {
      lastOpenedAt = openedAt;
    }
  }

  return {
    companyId: input.company.id,
    lastSeenAvailable,
    needsVerification,
    reportedClosed,
    lastSeenAvailableCount: lastSeenAvailable.length,
    needsVerificationCount: needsVerification.length,
    reportedClosedCount: reportedClosed.length,
    totalCount: linked.length,
    lastOpenedAt,
  };
}

export type CompanyApplicationHistoryProjection = {
  companyId: string;
  records: ApplicationRecord[];
  totalCount: number;
  statusCounts: Record<string, number>;
  earliestUpdatedAt: string | null;
  latestUpdatedAt: string | null;
};

export function projectCompanyApplicationHistory(input: {
  company: CompanyEntity;
  applicationRecords: readonly ApplicationRecord[];
}): CompanyApplicationHistoryProjection {
  const linked = input.applicationRecords.filter((record) =>
    input.company.applicationRecordIds.includes(record.id),
  );
  const sorted = [...linked].sort((first, second) => {
    const difference =
      Date.parse(second.lastUpdatedAt) - Date.parse(first.lastUpdatedAt);
    if (difference !== 0) return difference;
    return first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
  });

  const statusCounts: Record<string, number> = {};
  for (const record of sorted) {
    statusCounts[record.status] = (statusCounts[record.status] ?? 0) + 1;
  }

  return {
    companyId: input.company.id,
    records: sorted,
    totalCount: sorted.length,
    statusCounts,
    earliestUpdatedAt:
      sorted.length === 0 ? null : sorted.at(-1)!.lastUpdatedAt,
    latestUpdatedAt: sorted.length === 0 ? null : sorted[0]!.lastUpdatedAt,
  };
}

function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()'"\u2019\u201c\u201d]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeJobUrl(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\/+$/u, "");
}

export type CompanyDuplicateJobKind = "exact" | "possible";

export type CompanyDuplicateJobGroup = {
  id: string;
  kind: CompanyDuplicateJobKind;
  reason: string;
  jobIds: string[];
};

function jobIdentityKeys(job: JobListRow): {
  strong: ReadonlySet<string>;
  weak: ReadonlySet<string>;
} {
  const source = job.source.trim().toLocaleLowerCase() || null;
  const sourceJobId = job.sourceJobId.trim().toLocaleLowerCase() || null;
  const company = normalizeText(job.company);
  const canonicalHostname = (() => {
    try {
      return new URL(job.canonicalUrl).hostname.toLocaleLowerCase();
    } catch {
      return null;
    }
  })();
  const strong = new Set<string>();
  const weak = new Set<string>();

  if (job.canonicalUrl) {
    strong.add(`listing-url:${normalizeJobUrl(job.canonicalUrl)}`);
  }
  const applicationUrl = job.applicationUrl ?? job.canonicalUrl;
  if (applicationUrl) {
    strong.add(`employer-url:${normalizeJobUrl(applicationUrl)}`);
  }
  if (source && sourceJobId && canonicalHostname && company) {
    strong.add(
      `source-id:${source}:${canonicalHostname}:${company}:${sourceJobId}`,
    );
  }
  if (source && sourceJobId) {
    weak.add(`unscoped-source-id:${source}:${sourceJobId}`);
  }

  const title = normalizeText(job.title);
  const location = normalizeText(job.location);
  const postedDate = job.postedAt
    ? new Date(job.postedAt).toISOString().slice(0, 10)
    : null;
  if (title && company && location && postedDate) {
    weak.add(
      `facts:${title}\u0000${company}\u0000${location}\u0000${postedDate}`,
    );
  }

  return { strong, weak };
}

/**
 * Detects duplicate postings inside one company conservatively: a shared
 * listing/application URL or source posting id is an `exact` duplicate; a
 * shared normalized title + company + location + posted date is a `possible`
 * duplicate surfaced for review. Nothing is ever silently merged here.
 */
export function projectCompanyDuplicateJobs(input: {
  company: CompanyEntity;
  jobs: readonly JobListRow[];
}): CompanyDuplicateJobGroup[] {
  const linked = input.jobs.filter((job) =>
    input.company.jobIds.includes(job.id),
  );
  if (linked.length < 2) return [];

  const strongIndex = new Map<string, number[]>();
  const weakIndex = new Map<string, number[]>();
  for (const [jobIndex, job] of linked.entries()) {
    const keys = jobIdentityKeys(job);
    for (const key of keys.strong) {
      const bucket = strongIndex.get(key);
      if (bucket) {
        bucket.push(jobIndex);
      } else {
        strongIndex.set(key, [jobIndex]);
      }
    }
    for (const key of keys.weak) {
      const bucket = weakIndex.get(key);
      if (bucket) {
        bucket.push(jobIndex);
      } else {
        weakIndex.set(key, [jobIndex]);
      }
    }
  }

  type DuplicatePair = {
    firstIndex: number;
    secondIndex: number;
    kind: CompanyDuplicateJobKind;
  };
  const duplicatePairs = new Map<string, DuplicatePair>();

  const indexPairs = (
    index: ReadonlyMap<string, readonly number[]>,
    kind: CompanyDuplicateJobKind,
  ) => {
    for (const bucket of index.values()) {
      if (bucket.length < 2) continue;
      for (let firstOffset = 0; firstOffset < bucket.length; firstOffset += 1) {
        for (
          let secondOffset = firstOffset + 1;
          secondOffset < bucket.length;
          secondOffset += 1
        ) {
          const firstIndex = bucket[firstOffset]!;
          const secondIndex = bucket[secondOffset]!;
          const first = linked[firstIndex]!;
          const second = linked[secondIndex]!;
          const pairKey =
            first.id < second.id
              ? `${first.id}|${second.id}`
              : `${second.id}|${first.id}`;
          const existing = duplicatePairs.get(pairKey);
          if (existing?.kind === "exact" || existing?.kind === kind) {
            continue;
          }
          duplicatePairs.set(pairKey, {
            firstIndex,
            secondIndex,
            kind,
          });
        }
      }
    }
  };

  // Strong identity always wins when a pair also shares a weak fact key.
  indexPairs(strongIndex, "exact");
  indexPairs(weakIndex, "possible");

  const groups = [...duplicatePairs.values()].map((pair) => {
    const first = linked[pair.firstIndex]!;
    const second = linked[pair.secondIndex]!;
    return {
      id: `${pair.kind === "exact" ? "duplicate" : "duplicate_possible"}_${first.id}_${second.id}`,
      kind: pair.kind,
      reason:
        pair.kind === "exact"
          ? `"${first.title}" at ${first.company} matches an identical posting already saved here.`
          : `"${first.title}" at ${first.company} may repeat "${second.title}" from ${second.location}. Review before treating them as the same role.`,
      jobIds: [first.id, second.id].sort(),
    } satisfies CompanyDuplicateJobGroup;
  });

  return groups.sort((firstGroup, secondGroup) => {
    const firstJobId = firstGroup.jobIds[0] ?? "";
    const secondJobId = secondGroup.jobIds[0] ?? "";
    if (firstJobId !== secondJobId) {
      return firstJobId < secondJobId ? -1 : 1;
    }
    const firstSecondJobId = firstGroup.jobIds[1] ?? "";
    const secondSecondJobId = secondGroup.jobIds[1] ?? "";
    return firstSecondJobId < secondSecondJobId
      ? -1
      : firstSecondJobId > secondSecondJobId
        ? 1
        : 0;
  });
}
