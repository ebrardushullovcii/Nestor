import { useEffect, useState } from "react";
import type { JobListRow } from "@nestor/contracts";
import {
  compareDiscoveryFitTieBreaks,
  compareDiscoveryJobs,
  getClearMismatchPenalty,
  getDiscoveryListingRecencyKey,
  isProvisionalMatchAssessment,
} from "@nestor/job-finder/discovery-ordering";
import { createPerObjectCache } from "../../lib/identity-memo";

export type DiscoveryResultsSortField = "fit" | "recent" | "company";
export type DiscoveryResultsSortDirection = "asc" | "desc";

export interface DiscoveryResultsSort {
  readonly direction: DiscoveryResultsSortDirection;
  readonly field: DiscoveryResultsSortField;
}

export const DISCOVERY_RESULTS_DEFAULT_SORT: DiscoveryResultsSort = {
  direction: "desc",
  field: "fit",
};

const SORT_STORAGE_KEY = "nestor.job-finder.discovery.results-sort.v1";

// Switching pivots lands on the least surprising direction per field:
// alphabetical companies, strongest fits, newest listings.
const DEFAULT_DIRECTION_BY_FIELD: Record<
  DiscoveryResultsSortField,
  DiscoveryResultsSortDirection
> = {
  company: "asc",
  fit: "desc",
  recent: "desc",
};

function isSortField(value: unknown): value is DiscoveryResultsSortField {
  return value === "fit" || value === "recent" || value === "company";
}

function readPersistedSort(): DiscoveryResultsSort {
  try {
    const raw = window.localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return DISCOVERY_RESULTS_DEFAULT_SORT;
    const parsed = JSON.parse(raw) as {
      direction?: unknown;
      field?: unknown;
    };
    // Each field has one sensible direction and the toolbar offers only
    // that, so a direction persisted by the older flip control is ignored:
    // "Best match, lowest first" is not a view anyone asked for.
    return isSortField(parsed.field)
      ? { direction: DEFAULT_DIRECTION_BY_FIELD[parsed.field], field: parsed.field }
      : DISCOVERY_RESULTS_DEFAULT_SORT;
  } catch {
    // Unreadable preferences fall back to the shipped fit ranking.
    return DISCOVERY_RESULTS_DEFAULT_SORT;
  }
}

export function useDiscoveryResultsSort() {
  const [sort, setSort] = useState<DiscoveryResultsSort>(readPersistedSort);

  useEffect(() => {
    try {
      window.localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
    } catch {
      // Results still render when durable renderer preferences are unavailable.
    }
  }, [sort]);

  return {
    setSortField: (field: DiscoveryResultsSortField) =>
      setSort((current) =>
        current.field === field
          ? current
          : { direction: DEFAULT_DIRECTION_BY_FIELD[field], field },
      ),
    sort,
  };
}

// Renderer-facing name for the shared canonical Best-match comparator; the
// discovery screen pre-sorts results with it before the panel takes over.
export { compareDiscoveryJobs as compareDiscoveryFitOrder };

// The recency key follows the shared source-generic chain: parsed postedAt
// first, then an absolute postedAtText, then the provider's listing-update
// date only when no posting-date label exists. A relative label ("2 days
// ago") names no sortable instant, so it stays unknown rather than borrowing
// a hidden provider date or fabricating one. Shared with the
// discovery-ordering package so every consumer resolves recency identically.
export function getListingRecencyTimestamp(job: JobListRow): number | null {
  const recency = getDiscoveryListingRecencyKey({
    postedAt: job.postedAt,
    postedAtText: job.postedAtText,
    providerUpdatedAt: job.providerUpdatedAt,
  });
  return recency.basis === null ? null : recency.timestamp;
}

// Read once per row: sorting thousands of jobs by Newest parsed each row's
// dates on every comparison.
const getRowRecencyTimestamp = createPerObjectCache(getListingRecencyTimestamp);

const companyNameCollator = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true,
});

/**
 * Deterministic total ordering for discovery results. `sourceIndex` is each
 * job's position in the caller's incoming (already fit-ranked) list and breaks
 * every tie, so equal keys keep their stable relative order instead of
 * shuffling between renders.
 */
export function compareDiscoveryResults(
  left: JobListRow,
  right: JobListRow,
  sort: DiscoveryResultsSort,
  leftSourceIndex: number,
  rightSourceIndex: number,
): number {
  const mismatchOrder =
    getClearMismatchPenalty(left) - getClearMismatchPenalty(right);
  if (mismatchOrder !== 0) return mismatchOrder;

  switch (sort.field) {
    case "company": {
      const byCompany = companyNameCollator.compare(
        left.company,
        right.company,
      );
      if (byCompany !== 0) {
        return sort.direction === "asc" ? byCompany : -byCompany;
      }
      const byTitle = companyNameCollator.compare(left.title, right.title);
      if (byTitle !== 0) {
        return sort.direction === "asc" ? byTitle : -byTitle;
      }
      break;
    }
    case "recent": {
      const leftTimestamp = getRowRecencyTimestamp(left);
      const rightTimestamp = getRowRecencyTimestamp(right);
      if (leftTimestamp === null || rightTimestamp === null) {
        if (leftTimestamp !== rightTimestamp) {
          return leftTimestamp === null ? 1 : -1;
        }
        break;
      }
      const byRecency = leftTimestamp - rightTimestamp;
      if (byRecency !== 0) {
        return sort.direction === "desc" ? -byRecency : byRecency;
      }
      break;
    }
    case "fit":
    default: {
      if (sort.direction === "desc") {
        return compareDiscoveryJobs(left, right);
      }
      const leftProvisional = isProvisionalMatchAssessment(left);
      const rightProvisional = isProvisionalMatchAssessment(right);
      const byConfidence = Number(leftProvisional) - Number(rightProvisional);
      if (byConfidence !== 0) {
        return byConfidence;
      }
      if (!leftProvisional) {
        const byScore =
          right.matchAssessment.score - left.matchAssessment.score;
        if (byScore !== 0) {
          return -byScore;
        }
      }
      return compareDiscoveryFitTieBreaks(left, right);
    }
  }

  return leftSourceIndex - rightSourceIndex;
}
