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
import { orderDiscoveryResultsByGroup } from "./discovery-result-groups";
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
      return orderDiscoveryResultsByGroup(
        [...jobs].sort((left, right) =>
          compareDiscoveryResults(left, right, sort, 0, 0),
        ),
      );
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
