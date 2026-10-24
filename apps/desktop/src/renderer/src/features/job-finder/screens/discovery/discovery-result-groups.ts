import type { JobListRow } from "@nestor/contracts";
import {
  DISCOVERY_CLEAR_MISMATCH_SCORE_FLOOR,
  DISCOVERY_WEAKER_MATCH_SCORE_FLOOR,
  countDiscoveryStrongMatches,
  getDiscoveryResultGroup,
  isDiscoveryClearMismatch,
  isDiscoveryWorthOpeningResult,
  type DiscoveryResultGroupId,
} from "@nestor/job-finder/discovery-result-bands";
import { createPerObjectCache } from "../../lib/identity-memo";

/**
 * Banding rules moved to `@nestor/job-finder/discovery-result-bands` so a
 * finished run can freeze its own "worth opening" count with the same rule
 * this screen applies. Re-exported here because every Find jobs surface
 * already imports them from this module.
 */
export {
  DISCOVERY_CLEAR_MISMATCH_SCORE_FLOOR,
  DISCOVERY_WEAKER_MATCH_SCORE_FLOOR,
  countDiscoveryStrongMatches,
  getDiscoveryResultGroup,
  isDiscoveryClearMismatch,
  isDiscoveryWorthOpeningResult,
  type DiscoveryResultGroupId,
};

/**
 * A row's band, read once per row object. The band is a pure function of the
 * row, and grouping, counting and dividing the list asked for it several times
 * per job on every render.
 */
const getRowResultGroup = createPerObjectCache((job: JobListRow) =>
  getDiscoveryResultGroup(job),
);

export interface DiscoveryResultGroupHeading {
  count: number;
  description: string;
  id: DiscoveryResultGroupId;
  label: string;
}

/**
 * Listings whose only checkable evidence was the title, plus rows carrying no
 * current assessment at all. They are kept visible — they were never judged
 * against — but they are never counted as recommended results.
 */
export function isDiscoveryUncheckedResult(job: JobListRow): boolean {
  return getRowResultGroup(job) === "unchecked";
}

/**
 * Everything the app actively scored below the saved targets. Weaker rows and
 * clear mismatches are one pool for counting and for the single reveal
 * control; the unchecked band is deliberately not in it, because hiding a row
 * behind "also found" is a judgement and no judgement was made.
 */
export function isDiscoveryAlsoFoundResult(job: JobListRow): boolean {
  const group = getRowResultGroup(job);
  return group === "weaker" || group === "mismatches";
}

// Not "shortlisted": taking a job off Shortlisted writes that status, and the
// job is back to waiting on a decision. Being in Shortlisted is the review
// queue, which the caller passes in.
const DECIDED_JOB_STATUSES: ReadonlySet<JobListRow["status"]> = new Set([
  "drafting",
  "ready_for_review",
  "approved",
  "submitted",
  "assessment",
  "interview",
  "rejected",
  "offer",
  "withdrawn",
]);

/**
 * A job the person already decided on: in Shortlisted or applied to. Find
 * jobs is the list of jobs still waiting on a decision, so these leave it the
 * way a hidden job does. With 200 shortlisted, the first four pages were rows
 * whose checkbox could not be ticked, and the list, the badge, "Select all"
 * and the triage progress each printed a different number.
 */
export function isDiscoveryDecidedJob(
  job: JobListRow,
  shortlistedJobIds: ReadonlySet<string>,
): boolean {
  return shortlistedJobIds.has(job.id) || DECIDED_JOB_STATUSES.has(job.status);
}

/**
 * How many results the Results view lists by default — the recommended band
 * plus the unchecked band. Only the also-found pool sits behind the reveal,
 * so this is exactly the row count a user sees on Find jobs, which is what
 * the sidebar badge must agree with. It is deliberately not the recommended
 * count: a search that checked nothing past the titles still found jobs, and
 * a badge reading nothing beside a list of 13 rows is its own untruth.
 */
export function countDiscoveryDefaultVisibleResults(
  jobs: readonly JobListRow[],
): number {
  let count = 0;
  for (const job of jobs) {
    if (!isDiscoveryAlsoFoundResult(job)) {
      count += 1;
    }
  }
  return count;
}

/** How many results were found by title alone and never checked further. */
export function countDiscoveryUncheckedResults(
  jobs: readonly JobListRow[],
): number {
  let count = 0;
  for (const job of jobs) {
    if (isDiscoveryUncheckedResult(job)) {
      count += 1;
    }
  }
  return count;
}

const DISCOVERY_RESULT_GROUP_ORDER: Record<DiscoveryResultGroupId, number> = {
  matches: 0,
  weaker: 1,
  mismatches: 2,
  unchecked: 3,
};

/**
 * Keeps each caption in one contiguous band in the canonical ranking. Scores
 * still decide order inside a band; they must not split the same caption into
 * two runs with a differently-captioned band between them.
 */
/** The band order of two rows: negative when `left`'s band comes first. */
export function compareDiscoveryResultGroups(
  left: JobListRow,
  right: JobListRow,
): number {
  return (
    DISCOVERY_RESULT_GROUP_ORDER[getRowResultGroup(left)] -
    DISCOVERY_RESULT_GROUP_ORDER[getRowResultGroup(right)]
  );
}

export function orderDiscoveryResultsByGroup(
  jobs: readonly JobListRow[],
): JobListRow[] {
  return jobs
    .map((job, sourceIndex) => ({ job, sourceIndex }))
    .sort((left, right) => {
      const groupOrder =
        DISCOVERY_RESULT_GROUP_ORDER[getRowResultGroup(left.job)] -
        DISCOVERY_RESULT_GROUP_ORDER[getRowResultGroup(right.job)];
      return groupOrder || left.sourceIndex - right.sourceIndex;
    })
    .map(({ job }) => job);
}

const groupCopy: Record<
  DiscoveryResultGroupId,
  { description: string; label: string }
> = {
  matches: {
    description:
      "Back in the main results: these were checked against your saved targets and scored above them.",
    label: "Matches",
  },
  unchecked: {
    description:
      "The full requirements have not been assessed. Check the role and level before applying.",
    label: "Not yet assessed",
  },
  // Both of the bands below are the two halves of the one pool the reveal
  // control calls "weaker matches". They stay separate bands — "scored below
  // your targets" and "conflicts with your requirements" are different
  // verdicts and earn different explainers — and each divider says its own
  // verdict plainly so the list reads without a glossary.
  weaker: {
    description:
      "These scored well below your saved targets. Open one before trusting its score.",
    label: "Weaker matches",
  },
  mismatches: {
    description:
      "Hidden by default because they conflict with your saved roles, locations, or other requirements. Nothing was deleted.",
    label: "Clear mismatches",
  },
};

export interface DiscoveryResultGroupHeadingOptions {
  /**
   * These rows continue a longer list that started on an earlier page, so the
   * band they open is a continuation rather than the natural start of the
   * results. Its heading must still be drawn: without it, a page that opens
   * mid-band is indistinguishable from a page of leading matches.
   */
  continuesEarlierPage?: boolean;
  /**
   * The half-open slice of `jobs` that is actually rendered. Pass the whole
   * ranked list with this window rather than the page slice alone: a divider
   * has to count the whole run it names, because the reveal control beside it
   * counts the whole pool. A 60-row band paginated 40/20 printed "(40)" then
   * "(20)" under a button reading "Hide also found (60)", with nothing on
   * screen to reconcile them. Defaults to the whole list.
   */
  window?: { end: number; start: number };
}

/**
 * Maps the job id that opens each band to the heading that must be rendered
 * above it. Headings are only meaningful while the list is in its canonical
 * best-match order, so an explicit `ranked` flag turns them off for every
 * other sort.
 *
 * Headings describe *runs*, not bands. The canonical order sorts every bound
 * row by score, while a row whose score is withheld keeps the main band at
 * whatever score position it lands on, so a band can be interrupted and then
 * resume. Heading one run each — and counting that run — keeps every divider
 * true to the rows directly beneath it; a first-occurrence heading would
 * instead claim rows that sit under a later divider, or leave a resumed run
 * filed under the previous band's label.
 *
 * Counts are run-scoped, never page-scoped: the divider states how many rows
 * the run holds, which is the number the also-found reveal control counts too.
 * Pass the whole ranked list plus a `window` when the list is paginated.
 */
export function buildDiscoveryResultGroupHeadings(
  jobs: readonly JobListRow[],
  ranked: boolean,
  options: DiscoveryResultGroupHeadingOptions = {},
): ReadonlyMap<string, DiscoveryResultGroupHeading> {
  return buildRunHeadings(
    jobs.map((job) => job.id),
    jobs.map(getRowResultGroup),
    ranked,
    options,
  );
}

/**
 * The same headings from the list's ids and bands in order, which Find jobs
 * reads from the database instead of holding every row (ADR 0071).
 */
export function buildRunHeadings(
  ids: readonly string[],
  groups: readonly DiscoveryResultGroupId[],
  ranked: boolean,
  options: DiscoveryResultGroupHeadingOptions = {},
): ReadonlyMap<string, DiscoveryResultGroupHeading> {
  const headings = new Map<string, DiscoveryResultGroupHeading>();
  forEachHeadedDiscoveryResultRun(groups, ranked, options, (run) => {
    headings.set(ids[run.headingIndex]!, {
      count: run.end - run.start,
      description: groupCopy[run.group].description,
      id: run.group,
      label: groupCopy[run.group].label,
    });
  });
  return headings;
}

/**
 * Which band heading is actually rendered *above* each row.
 *
 * This is not the same question as {@link getDiscoveryResultGroup}: a row can
 * belong to a band whose divider was never drawn (any sort other than the
 * canonical one, or the leading run of plain matches on page one). A row may
 * only stay quiet about something a divider states, so the panel has to ask
 * about the rendered divider rather than the row's own band. Rows in an
 * unheaded run are absent from the map.
 */
export function buildDiscoveryHeadedGroupByJobId(
  jobs: readonly JobListRow[],
  ranked: boolean,
  options: DiscoveryResultGroupHeadingOptions = {},
): ReadonlyMap<string, DiscoveryResultGroupId> {
  return buildRunHeadedGroups(
    jobs.map((job) => job.id),
    jobs.map(getRowResultGroup),
    ranked,
    options,
  );
}

/** {@link buildDiscoveryHeadedGroupByJobId} from ids and bands in order. */
export function buildRunHeadedGroups(
  ids: readonly string[],
  groups: readonly DiscoveryResultGroupId[],
  ranked: boolean,
  options: DiscoveryResultGroupHeadingOptions = {},
): ReadonlyMap<string, DiscoveryResultGroupId> {
  const headed = new Map<string, DiscoveryResultGroupId>();
  forEachHeadedDiscoveryResultRun(groups, ranked, options, (run) => {
    for (let index = run.headingIndex; index < run.visibleEnd; index += 1) {
      headed.set(ids[index]!, run.group);
    }
  });
  return headed;
}

interface DiscoveryResultRun {
  /** Exclusive end of the whole run, which is what the divider counts. */
  end: number;
  group: DiscoveryResultGroupId;
  /** The row the divider is drawn above: the run's first *visible* row. */
  headingIndex: number;
  /** Inclusive start of the whole run, including rows on an earlier page. */
  start: number;
  /** Exclusive end of the visible part of the run. */
  visibleEnd: number;
}

/**
 * Walks the ranked rows once and yields every run that earns a divider.
 *
 * Headings describe *runs*, not bands. The canonical order sorts every bound
 * row by score, while a row whose score is withheld keeps the main band at
 * whatever score position it lands on, so a band can be interrupted and then
 * resume. Heading one run each — and counting that run — keeps every divider
 * true to the rows directly beneath it; a first-occurrence heading would
 * instead claim rows that sit under a later divider, or leave a resumed run
 * filed under the previous band's label.
 */
function forEachHeadedDiscoveryResultRun(
  groups: readonly DiscoveryResultGroupId[],
  ranked: boolean,
  options: DiscoveryResultGroupHeadingOptions,
  visit: (run: DiscoveryResultRun) => void,
): void {
  if (!ranked) {
    return;
  }

  const windowStart = Math.max(0, options.window?.start ?? 0);
  const windowEnd = Math.min(
    groups.length,
    options.window?.end ?? groups.length,
  );
  let start = 0;
  while (start < groups.length) {
    const group = groups[start]!;
    let end = start + 1;
    while (end < groups.length && groups[end] === group) {
      end += 1;
    }

    // Only ONE run goes unlabelled: a leading run of plain matches on the
    // first page. That band is the list's baseline — "these were checked and
    // they scored well" is what an unlabelled result list already means — and
    // it has nothing above it to be divided from.
    //
    // Every other opening run is headed. A list that opens with the unchecked
    // band is the case this matters most for: with the heading suppressed,
    // a search that read nothing past the titles rendered as a bare list of
    // 14 rows with no statement anywhere that they were never read, which is
    // precisely the claim the band exists to make. The same holds for a list
    // that opens with weaker or mismatched rows, and for any run that opens a
    // continuation page, where what the band is divided from is off-screen.
    const visibleStart = Math.max(start, windowStart);
    const visibleEnd = Math.min(end, windowEnd);
    // A run entirely on another page draws nothing here.
    if (visibleStart < visibleEnd) {
      // A run that began before this page IS a continuation, so it is headed
      // even when it is the main band.
      const continuesEarlierPage =
        start < windowStart || Boolean(options.continuesEarlierPage);
      const skip = start === 0 && group === "matches" && !continuesEarlierPage;
      if (!skip) {
        visit({
          end,
          group,
          headingIndex: visibleStart,
          start,
          visibleEnd,
        });
      }
    }

    start = end;
  }
}
