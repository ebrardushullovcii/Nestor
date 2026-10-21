import type {
  JobDiscoveryTarget,
  JobListRow,
  ListingActivity,
} from "@nestor/contracts";
import { fitRecommendationValues, workModeValues } from "@nestor/contracts";
import { matchesCollectionSearch } from "../../components/collection-search-toolbar";
import {
  createIdentityMemo,
  createPerObjectCache,
} from "../../lib/identity-memo";
import {
  listingActivityStatuses,
  presentListingActivity,
} from "../../lib/listing-activity-presentation";
import { fitRecommendationCopy } from "../../lib/match-assessment-presentation";
import {
  compareDiscoveryResultGroups,
  orderDiscoveryResultsByGroup,
} from "./discovery-result-groups";
import {
  compareDiscoveryResults,
  type DiscoveryResultsSortDirection,
  type DiscoveryResultsSortField,
} from "./discovery-results-sort";
import {
  compareSourceLabels,
  getDiscoverySourceLabels,
} from "./discovery-source-attribution";

/**
 * The derived views behind the Find jobs results list, computed once per job
 * collection rather than once per render.
 *
 * Typing in "Find a job" used to rebuild every row's searchable text (and
 * format a listing date for it) for all saved jobs on each keystroke, then
 * sort the matches again; opening the screen re-sorted and re-faceted the same
 * unchanged collection on every visit. Rows are immutable, so each row's text
 * is built once, the collection is sorted once per order, and a search only
 * filters the already-sorted list. Filtering keeps relative order, and every
 * order here is a strict total order, so the result is the same list the old
 * sort-after-filter produced.
 */

export const SOURCE_UNAVAILABLE_FILTER = "Source unavailable";
export const WORK_MODE_UNSPECIFIED_FILTER = "Not specified";

function getListingActivity(job: JobListRow): ListingActivity {
  return job.listingActivity ?? { status: "unknown" };
}

/** Every value a results search matches against, in the order shown. */
export function getDiscoveryJobSearchValues(
  job: JobListRow,
): readonly (string | null | undefined)[] {
  const recommendation =
    job.matchAssessment.recommendation ?? "review_before_applying";
  return [
    job.title,
    job.company,
    job.location,
    job.salaryText,
    job.status,
    job.applyPath,
    ...job.workMode,
    fitRecommendationCopy[recommendation].label,
    presentListingActivity(getListingActivity(job)).label,
  ];
}

// No typed query can contain this character, so a match can never span two
// values joined by it.
const SEARCH_VALUE_SEPARATOR = "\u0000";

const getDiscoveryJobSearchText = createPerObjectCache((job: JobListRow) =>
  getDiscoveryJobSearchValues(job)
    .flatMap((value) =>
      typeof value === "string" && value.length > 0
        ? [value.toLocaleLowerCase()]
        : [],
    )
    .join(SEARCH_VALUE_SEPARATOR),
);

/**
 * Same answer as `matchesCollectionSearch(query, getDiscoveryJobSearchValues
 * (job))`, from text built once per row. `normalizedQuery` is the query after
 * `normalizeCollectionSearch`.
 */
export function matchesDiscoveryJobSearch(
  job: JobListRow,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return true;
  if (normalizedQuery.includes(SEARCH_VALUE_SEPARATOR)) {
    return matchesCollectionSearch(
      normalizedQuery,
      getDiscoveryJobSearchValues(job),
    );
  }
  return getDiscoveryJobSearchText(job).includes(normalizedQuery);
}

const BEST_MATCH_SORT = { direction: "desc", field: "fit" } as const;

/**
 * Best match: the bands in order, each in the canonical fit order. That
 * order is total (it ends in the job id), so the bands and the order make
 * one comparator.
 */
function compareBestMatch(left: JobListRow, right: JobListRow): number {
  return (
    compareDiscoveryResultGroups(left, right) ||
    compareDiscoveryResults(left, right, BEST_MATCH_SORT, 0, 0)
  );
}

/** Rows changed per refresh below which the last order is patched. */
const MAX_PATCHED_SHARE = 1 / 8;

let lastBestMatch: {
  input: readonly JobListRow[];
  output: readonly JobListRow[];
} | null = null;

/**
 * The Best-match order, patched from the last one when few rows changed:
 * each answer from main replaces a handful of the thousands of rows, and
 * sorting them all again cost a few milliseconds of every answer. Rows are
 * immutable, so a row kept from last time keeps its place; the rest are
 * merged in. Same list as a full sort, since the order is total.
 */
function sortByBestMatch(jobs: readonly JobListRow[]): readonly JobListRow[] {
  const output =
    (lastBestMatch && patchBestMatchOrder(lastBestMatch, jobs)) ??
    orderDiscoveryResultsByGroup(
      [...jobs].sort((left, right) =>
        compareDiscoveryResults(left, right, BEST_MATCH_SORT, 0, 0),
      ),
    );
  lastBestMatch = { input: jobs, output };
  return output;
}

function patchBestMatchOrder(
  last: { input: readonly JobListRow[]; output: readonly JobListRow[] },
  jobs: readonly JobListRow[],
): JobListRow[] | null {
  const current = new Set(jobs);
  const previous = new Set(last.input);
  // Repeated rows make "the same rows" ambiguous; those are sorted fully.
  if (current.size !== jobs.length || previous.size !== last.input.length)
    return null;
  const added = jobs.filter((job) => !previous.has(job));
  const removed = last.input.length - (jobs.length - added.length);
  if (added.length + removed > Math.max(64, jobs.length * MAX_PATCHED_SHARE))
    return null;
  added.sort(compareBestMatch);
  const kept = last.output.filter((job) => current.has(job));
  const merged: JobListRow[] = [];
  let from = 0;
  for (const job of added) {
    let low = from;
    let high = kept.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareBestMatch(kept[middle]!, job) < 0) low = middle + 1;
      else high = middle;
    }
    for (let index = from; index < low; index += 1) merged.push(kept[index]!);
    merged.push(job);
    from = low;
  }
  for (let index = from; index < kept.length; index += 1)
    merged.push(kept[index]!);
  return merged;
}

/**
 * The collection in the chosen order: the canonical Best-match bands for
 * "fit" descending, otherwise the comparator with each job's incoming position
 * as the last tie-break.
 */
export const sortDiscoveryResults = createIdentityMemo(
  (
    jobs: readonly JobListRow[],
    field: DiscoveryResultsSortField,
    direction: DiscoveryResultsSortDirection,
  ): readonly JobListRow[] => {
    const sort = { direction, field };
    if (direction === "desc" && field === "fit") {
      return sortByBestMatch(jobs);
    }
    return jobs
      .map((job, sourceIndex) => ({ job, sourceIndex }))
      .sort((left, right) =>
        compareDiscoveryResults(
          left.job,
          right.job,
          sort,
          left.sourceIndex,
          right.sourceIndex,
        ),
      )
      .map((entry) => entry.job);
  },
);

export interface DiscoveryResultFacets {
  /** Rows sharing title, employer, place and source, which need a reference. */
  indistinguishableJobIds: ReadonlySet<string>;
  activityOptions: readonly ListingActivity["status"][];
  recommendationOptions: readonly (typeof fitRecommendationValues)[number][];
  sourceLabelsByJobId: ReadonlyMap<string, readonly string[]>;
  sourceOptions: readonly string[];
  workModeOptions: readonly string[];
}

interface RowSourceFacts {
  /** What the row's sources are called, or "Source unavailable". */
  labels: readonly string[];
  /** Title, employer, place and sources: rows sharing it look identical. */
  lookalikeKey: string;
  targets: readonly JobDiscoveryTarget[];
}

// Per row and source list: a changed workspace replaces only the rows that
// changed, so the rest keep their labels instead of being labelled again.
const rowSourceFacts = new WeakMap<JobListRow, RowSourceFacts>();

function getRowSourceFacts(
  job: JobListRow,
  discoveryTargets: readonly JobDiscoveryTarget[],
): RowSourceFacts {
  const cached = rowSourceFacts.get(job);
  if (cached?.targets === discoveryTargets) return cached;
  const found = getDiscoverySourceLabels(
    job.provenance ?? [],
    discoveryTargets,
  );
  const labels = found.length > 0 ? found : [SOURCE_UNAVAILABLE_FILTER];
  const facts: RowSourceFacts = {
    labels,
    lookalikeKey: [job.title, job.company, job.location, labels].join("\u0000"),
    targets: discoveryTargets,
  };
  rowSourceFacts.set(job, facts);
  return facts;
}

/** Source labels and the filter options the collection actually offers. */
export const getDiscoveryResultFacets = createIdentityMemo(
  (
    jobs: readonly JobListRow[],
    discoveryTargets: readonly JobDiscoveryTarget[],
  ): DiscoveryResultFacets => {
    const sourceLabelsByJobId = new Map<string, readonly string[]>();
    const groups = new Map<string, string[]>();
    for (const job of jobs) {
      const facts = getRowSourceFacts(job, discoveryTargets);
      sourceLabelsByJobId.set(job.id, facts.labels);
      const key = facts.lookalikeKey;
      const ids = groups.get(key) ?? [];
      ids.push(job.id);
      groups.set(key, ids);
    }
    const indistinguishableJobIds = new Set(
      [...groups.values()].filter((ids) => ids.length > 1).flat(),
    );
    const recommendations = new Set(
      jobs.map(
        (job) => job.matchAssessment.recommendation ?? "review_before_applying",
      ),
    );
    const workModes = new Set(jobs.flatMap((job) => job.workMode));
    const activityStatuses = new Set(
      jobs.map((job) => getListingActivity(job).status),
    );
    return {
      activityOptions: listingActivityStatuses.filter((status) =>
        activityStatuses.has(status),
      ),
      indistinguishableJobIds,
      recommendationOptions: fitRecommendationValues.filter((value) =>
        recommendations.has(value),
      ),
      sourceLabelsByJobId,
      sourceOptions: [
        ...new Set([...sourceLabelsByJobId.values()].flat()),
      ].sort(compareSourceLabels),
      workModeOptions: [
        ...workModeValues.filter((value) => workModes.has(value)),
        ...(jobs.some((job) => job.workMode.length === 0)
          ? [WORK_MODE_UNSPECIFIED_FILTER]
          : []),
      ],
    };
  },
);
