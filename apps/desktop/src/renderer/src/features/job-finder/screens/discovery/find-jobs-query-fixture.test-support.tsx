import { useEffect, useMemo, useRef, type ComponentProps } from "react";
import { act } from "@testing-library/react";
import type {
  JobDiscoveryTarget,
  JobListRow,
  QueryJobListInput,
  QueryJobListResult,
  WorkspaceChanges,
  WorkspaceJobListRow,
} from "@nestor/contracts";
import {
  describeMatchTieBreakReason,
  getMatchAssessmentPresentation,
} from "../../lib/match-assessment-presentation";
import { isNewSinceVisit } from "../../hooks/use-since-last-visit";
import { normalizeCollectionSearch } from "../../components/collection-search-toolbar";
import {
  getDiscoveryResultGroup,
  isDiscoveryDecidedJob,
} from "./discovery-result-groups";
import {
  getDiscoveryResultFacets,
  matchesDiscoveryJobSearch,
  sortDiscoveryResults,
  SOURCE_UNAVAILABLE_FILTER,
  WORK_MODE_UNSPECIFIED_FILTER,
} from "./discovery-results-view.test-support";
import { DiscoveryResultsPanel } from "./discovery-results-panel";
import { DiscoveryScreen } from "./discovery-screen";
import type { FixtureWindow } from "./find-jobs-list-report.test-support";

/**
 * Test support: a `window.nestor.jobFinder.queries` that answers Find jobs'
 * list queries from plain job rows, using the renderer's earlier in-memory
 * list rules as the oracle (ADR 0071). A screen test then passes only when
 * the query-backed screen shows what those rules would have shown.
 */
export interface FindJobsQueryFixture {
  calls: QueryJobListInput[];
  setJobs: (jobs: readonly JobListRow[]) => void;
  setShortlistedJobIds: (jobIds: Iterable<string>) => void;
  setTargets: (targets: readonly JobDiscoveryTarget[] | undefined) => void;
  setVisibleJobIds: (jobIds: Iterable<string> | undefined) => void;
  /** Delivers a change-feed batch that touches the discovery list. */
  emitJobChange: (jobIds?: readonly string[]) => void;
  restore: () => void;
}

const DEFAULT_BANDS = ["matches", "unchecked"] as const;


/** Partial test rows may lack the lists a tie reason reads. */
function tieBreakReasonOf(job: JobListRow): string | null {
  try {
    return describeMatchTieBreakReason(job);
  } catch {
    return null;
  }
}

export function toQueryRow(
  job: JobListRow,
  context: {
    sourceLabels: readonly string[];
    indistinguishable: boolean;
    scoreTied: boolean;
  },
): WorkspaceJobListRow {
  const fit = getMatchAssessmentPresentation(job);
  const assessment = job.matchAssessment;
  const activity = job.listingActivity ?? { status: "unknown" as const };
  return {
    id: job.id,
    status: job.status,
    title: job.title,
    company: job.company,
    location: job.location ?? null,
    source: job.source,
    sourceJobId: job.sourceJobId,
    canonicalUrl: job.canonicalUrl,
    applicationUrl: job.applicationUrl ?? null,
    workMode: job.workMode,
    postedAt: job.postedAt ?? null,
    postedAtText: job.postedAtText ?? null,
    discoveredAt: job.discoveredAt,
    firstSeenAt: job.firstSeenAt ?? null,
    lastSeenAt: job.lastSeenAt ?? null,
    salaryText: job.salaryText ?? null,
    detailQuality: job.detailQuality,
    resumeApplicationMode: job.resumeApplicationMode ?? null,
    resumeTailoringMode: job.resumeTailoringMode ?? null,
    planId: null,
    score: assessment.score,
    recommendation: assessment.recommendation ?? "review_before_applying",
    judged: !fit.isNotJudged,
    provisional: fit.isProvisional,
    scoreWithheld: fit.isScoreWithheld,
    scoreIsUpperBound: Boolean(assessment.scoreIsUpperBound),
    titleFamilyMatch: assessment.titleFamilyMatch ?? null,
    locationReach: assessment.locationReach,
    listingClosed: activity.status === "inactive" || activity.status === "closed",
    listingActivity: activity,
    providerUpdatedAt: job.providerUpdatedAt ?? null,
    discoveryMethod: job.discoveryMethod,
    applyPath: job.applyPath,
    sourceLabels: [...context.sourceLabels],
    recommendationRationale: assessment.recommendationRationale ?? null,
    firstGap: assessment.gaps?.[0] ?? null,
    roleSuitabilityState: assessment.dimensions?.roleSuitability?.state ?? null,
    seniority: job.seniority ?? null,
    rescoredAfterListingRead: Boolean(job.rescoredAfterListingRead),
    tieBreakReason: tieBreakReasonOf(job),
    indistinguishable: context.indistinguishable,
    scoreTied: context.scoreTied,
    resultGroup: getDiscoveryResultGroup(job),
  } as WorkspaceJobListRow;
}

export function answerFindJobsQuery(
  allJobs: readonly JobListRow[],
  input: QueryJobListInput,
  options: {
    targets?: readonly JobDiscoveryTarget[];
    shortlistedJobIds?: ReadonlySet<string>;
    /**
     * The rows a panel test hands over as the shown list: the default
     * request lists exactly these, whatever their band, as the screen once
     * decided before handing the panel its rows.
     */
    visibleJobIds?: ReadonlySet<string>;
  } = {},
): QueryJobListResult {
  const filters = input.filters ?? {};
  const shortlisted = options.shortlistedJobIds ?? new Set<string>();
  // Screen tests build partial rows; list rules expect these arrays.
  const jobs = allJobs.map((job) =>
    job.workMode && job.provenance
      ? job
      : { ...job, workMode: job.workMode ?? [], provenance: job.provenance ?? [] },
  );
  // Rows a panel test hands over are shown as they are, decided or not.
  const undecided = options.visibleJobIds
    ? jobs
    : jobs.filter((job) => !isDiscoveryDecidedJob(job, shortlisted));
  const bands = new Set<string>(filters.discoveryBands ?? DEFAULT_BANDS);
  const visible = options.visibleJobIds;
  // The "all" list is every job in the plan, decided or not, in any band.
  const pool = input.list === "all" ? jobs : undecided.filter((job) =>
    visible && bands.size < 4
      ? filters.discoveryBands
        ? !visible.has(job.id)
        : visible.has(job.id)
      : bands.has(getDiscoveryResultGroup(job)),
  );
  const facets = getDiscoveryResultFacets(pool, options.targets ?? []);
  const labelsOf = (job: JobListRow) =>
    facets.sourceLabelsByJobId.get(job.id) ?? [SOURCE_UNAVAILABLE_FILTER];
  const query = normalizeCollectionSearch(input.search ?? "");
  const filtered = pool.filter((job) => {
    const recommendation =
      job.matchAssessment.recommendation ?? "review_before_applying";
    const modes = job.workMode.length
      ? job.workMode
      : [WORK_MODE_UNSPECIFIED_FILTER];
    const wanted = [
      ...(filters.workModes ?? []),
      ...(filters.workModeUnspecified ? [WORK_MODE_UNSPECIFIED_FILTER] : []),
    ];
    return (
      (!filters.recommendations?.length ||
        filters.recommendations.includes(recommendation)) &&
      (!filters.sourceLabels?.length ||
        labelsOf(job).some((label) => filters.sourceLabels!.includes(label))) &&
      (!wanted.length || modes.some((mode) => wanted.includes(mode))) &&
      (!filters.activities?.length ||
        filters.activities.includes(job.listingActivity?.status ?? "unknown")) &&
      (!filters.newOnly ||
        isNewSinceVisit(job, filters.newSince ?? null)) &&
      matchesDiscoveryJobSearch(job, query)
    );
  });
  const sort = input.sort ?? "best_match";
  const ordered = sortDiscoveryResults(
    filtered,
    sort === "newest" ? "recent" : sort === "company" ? "company" : "fit",
    sort === "company" ? "asc" : "desc",
  );
  const scores = new Map<number, number>();
  for (const job of ordered) {
    if (getMatchAssessmentPresentation(job).isScoreWithheld) continue;
    scores.set(job.matchAssessment.score, (scores.get(job.matchAssessment.score) ?? 0) + 1);
  }
  const offset = input.page?.offset ?? 0;
  const limit = input.page?.limit ?? 50;
  const rows = ordered.slice(offset, offset + limit).map((job) =>
    toQueryRow(job, {
      sourceLabels: facets.sourceLabelsByJobId.get(job.id) ?? [],
      indistinguishable: facets.indistinguishableJobIds.has(job.id),
      scoreTied:
        !getMatchAssessmentPresentation(job).isScoreWithheld &&
        (scores.get(job.matchAssessment.score) ?? 0) > 1,
    }),
  );
  const outline: NonNullable<QueryJobListResult["outline"]> = [];
  for (const job of ordered) {
    const group = getDiscoveryResultGroup(job);
    const last = outline.at(-1);
    if (last?.group === group) last.count += 1;
    else outline.push({ group, count: 1 });
  }
  const count = <T extends string>(values: readonly T[], of: (job: JobListRow) => readonly T[]) =>
    values.map((value) => ({
      value,
      count: pool.filter((job) => of(job).includes(value)).length,
    }));
  const judged = filtered.filter((job) => Boolean(job.matchAssessment.judgment));
  const reaches = [...new Set(judged.map((job) => job.matchAssessment.locationReach))];
  return {
    rows,
    total: ordered.length,
    counts: {
      discovery: undecided.filter((job) =>
        (DEFAULT_BANDS as readonly string[]).includes(getDiscoveryResultGroup(job)),
      ).length,
      dismissed: 0,
      shortlisted: shortlisted.size,
      applications: 0,
      companies: 0,
      all: jobs.length,
    },
    revision: 1,
    resumeDrafts: [],
    applications: [],
    applyResults: [],
    facets: {
      recommendations: count(facets.recommendationOptions, (job) => [
        job.matchAssessment.recommendation ?? "review_before_applying",
      ]),
      sources: count(facets.sourceOptions, labelsOf),
      workModes: count(facets.workModeOptions, (job) =>
        job.workMode.length ? job.workMode : [WORK_MODE_UNSPECIFIED_FILTER],
      ),
      activities: count(facets.activityOptions, (job) => [
        job.listingActivity?.status ?? "unknown",
      ]),
      locationReach: reaches.map((value) => ({
        value,
        count: judged.filter((job) => job.matchAssessment.locationReach === value).length,
      })),
      assessed: judged.length,
      newSince: filters.newSince
        ? pool.filter((job) => isNewSinceVisit(job, filters.newSince!)).length
        : null,
    },
    ...(input.include?.outline ? { outline } : {}),
    ...(input.include?.ids ? { ids: ordered.map((job) => job.id) } : {}),
  } as QueryJobListResult;
}

/** Installs the fixture on `window.nestor.jobFinder.queries`. */
export function installFindJobsQueries(
  initialJobs: readonly JobListRow[],
  options: {
    targets?: readonly JobDiscoveryTarget[];
    shortlistedJobIds?: Iterable<string>;
    visibleJobIds?: Iterable<string>;
  } = {},
): FindJobsQueryFixture {
  let jobs = initialJobs;
  let targets = options.targets;
  const calls: QueryJobListInput[] = [];
  const listeners = new Set<(changes: WorkspaceChanges) => void>();
  let shortlistedJobIds = new Set(options.shortlistedJobIds ?? []);
  let visibleJobIds = options.visibleJobIds
    ? new Set(options.visibleJobIds)
    : undefined;
  const nestor = ((window as unknown as { nestor?: Record<string, unknown> })
    .nestor ??= {});
  const jobFinder = ((nestor.jobFinder as Record<string, unknown> | undefined) ??
    (nestor.jobFinder = {}));
  const previous = jobFinder.queries;
  const previousDetail = jobFinder.getJobDetail as
    | ((jobId: string, planId: string | null) => Promise<unknown>)
    | undefined;
  let revision = 1;
  // Tests that stub the detail hook look the job up here synchronously.
  (window as unknown as FixtureWindow).__findJobsFixtureJob = (jobId) =>
    jobs.find((candidate) => candidate.id === jobId) ?? null;
  // The inspector reads the job by id, as it does from the database.
  jobFinder.getJobDetail = (jobId: string, planId: string | null) => {
    const job = jobs.find((candidate) => candidate.id === jobId);
    return job
      ? Promise.resolve({ job, planId })
      : (previousDetail?.(jobId, planId) ??
          Promise.reject(new Error("No such job")));
  };
  jobFinder.queries = {
    ...(previous as object | undefined),
    queryJobList: (input: QueryJobListInput) => {
      calls.push(input);
      return Promise.resolve(
        answerFindJobsQuery(jobs, input, {
          ...(targets ? { targets } : {}),
          shortlistedJobIds,
          ...(visibleJobIds ? { visibleJobIds } : {}),
        }),
      );
    },
    onChanges: (listener: (changes: WorkspaceChanges) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    calls,
    setJobs: (next) => {
      jobs = next;
    },
    setShortlistedJobIds: (next) => {
      shortlistedJobIds = new Set(next);
    },
    setTargets: (next) => {
      targets = next;
    },
    setVisibleJobIds: (next) => {
      visibleJobIds = next ? new Set(next) : undefined;
    },
    emitJobChange: (jobIds = []) => {
      revision += 1;
      const batch: WorkspaceChanges = {
        changes: jobIds.map((id) => ({
          revision,
          table: "saved_jobs",
          id,
          operation: "upsert" as const,
        })),
        revision,
        hasMore: false,
        lists: ["discovery"],
      };
      for (const listener of listeners) listener(batch);
    },
    restore: () => {
      jobFinder.queries = previous;
      jobFinder.getJobDetail = previousDetail;
    },
  };
}

/** Lets the list's pending queries answer and render. */
export async function flushFindJobsQueries(): Promise<void> {
  for (let index = 0; index < 4; index += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

/**
 * The results panel fed from `jobs` through the fixture, so a test written
 * against a job list keeps describing the same list.
 */
export function DiscoveryResultsPanelWithJobs(
  props: Omit<ComponentProps<typeof DiscoveryResultsPanel>, "planId"> & {
    jobs: readonly JobListRow[];
    /** Weaker matches the screen used to hold back; part of the pool now. */
    hiddenAlsoFoundJobs?: readonly JobListRow[];
    shortlistedJobIds?: Iterable<string>;
    // Counts the screen used to derive and pass in; the query answers them.
    alsoFoundCount?: number;
    hiddenAlsoFoundCount?: number;
    inAreaJobCount?: number;
    pendingLocationJobCount?: number;
    totalLocationJobCount?: number;
  },
) {
  const {
    jobs,
    hiddenAlsoFoundJobs,
    shortlistedJobIds,
    alsoFoundCount: _alsoFoundCount,
    hiddenAlsoFoundCount: _hiddenAlsoFoundCount,
    ...rest
  } = props;
  // The location counts the screen used to pass are derived by the query.
  const {
    inAreaJobCount: _inAreaJobCount,
    pendingLocationJobCount: _pendingLocationJobCount,
    totalLocationJobCount: _totalLocationJobCount,
    ...panelProps
  } = rest;
  void [_inAreaJobCount, _pendingLocationJobCount, _totalLocationJobCount];
  // A test that states only how many weaker matches are hidden gets that
  // many hidden rows, so the query counts them as the screen once did.
  const hiddenCount = Math.max(
    _hiddenAlsoFoundCount ?? 0,
    panelProps.areAlsoFoundShown ? 0 : (_alsoFoundCount ?? 0),
  );
  const pool = useMemo(() => {
    const hidden = (hiddenAlsoFoundJobs ?? []).filter(
      (candidate) => !jobs.some((job) => job.id === candidate.id),
    );
    const synthetic = Array.from(
      { length: Math.max(0, hiddenCount - hidden.length) },
      (_, index) => hiddenMismatchRow(index),
    );
    return [...jobs, ...hidden, ...synthetic];
  }, [hiddenAlsoFoundJobs, hiddenCount, jobs]);
  useFixtureJobs(pool, props.discoveryTargets, shortlistedJobIds, jobs);
  return <DiscoveryResultsPanel {...panelProps} />;
}

/** A judged clear mismatch nobody looks at, standing in for a hidden count. */
function hiddenMismatchRow(index: number): JobListRow {
  return {
    id: `hidden_mismatch_${index}`,
    source: "target_site",
    sourceJobId: `hidden_mismatch_${index}`,
    canonicalUrl: `https://jobs.example.test/hidden/${index}`,
    applicationUrl: null,
    title: `Hidden role ${index}`,
    company: "Elsewhere Inc",
    location: "Elsewhere",
    workMode: [],
    provenance: [],
    status: "discovered",
    discoveryMethod: "json_ld",
    applyPath: "external_redirect",
    discoveredAt: "2026-01-01T00:00:00.000Z",
    salaryText: null,
    detailQuality: "summary_only",
    matchAssessment: {
      score: 10,
      recommendation: "skip",
      reasons: [],
      gaps: [],
      contextFingerprint: "hidden-context",
      postingFingerprint: "hidden-posting",
      judgment: {
        source: "batch",
        judgedAt: "2026-01-01T00:00:00.000Z",
        score: 10,
        recommendation: "skip",
      },
    },
  } as unknown as JobListRow;
}

/** The Find jobs screen fed from `jobs` through the fixture. */
export function DiscoveryScreenWithJobs(
  props: Omit<ComponentProps<typeof DiscoveryScreen>, "planJobCount"> & {
    jobs: readonly JobListRow[];
  },
) {
  const { jobs, ...rest } = props;
  const screenProps = { ...rest, planJobCount: jobs.length };
  useFixtureJobs(
    jobs,
    props.searchPreferences.discovery.targets,
    (props.reviewQueue ?? []).map((item) => item.jobId),
  );
  return <DiscoveryScreen {...screenProps} />;
}

function useFixtureJobs(
  jobs: readonly JobListRow[],
  targets: readonly JobDiscoveryTarget[] | undefined,
  shortlistedJobIds: Iterable<string> | undefined,
  visibleJobs?: readonly JobListRow[],
) {
  const visibleJobIds = visibleJobs?.map((job) => job.id);
  const fixtureRef = useRef<FindJobsQueryFixture | null>(null);
  const shortlisted = [...(shortlistedJobIds ?? [])].join("\u0000");
  // Installed while rendering, so the panel's first query already sees it.
  if (!fixtureRef.current)
    fixtureRef.current = installFindJobsQueries(jobs, {
      ...(targets ? { targets } : {}),
      ...(shortlistedJobIds ? { shortlistedJobIds } : {}),
      ...(visibleJobIds ? { visibleJobIds } : {}),
    });
  // Updated while rendering, so the screen's own effects already read the
  // new rows; the change is announced once the render commits.
  const seenRef = useRef({ jobs, targets, shortlisted });
  const pendingChangeRef = useRef(false);
  const changedIdsRef = useRef<string[]>([]);
  const seen = seenRef.current;
  if (
    seen.jobs !== jobs ||
    seen.targets !== targets ||
    seen.shortlisted !== shortlisted
  ) {
    const before = new Map(seen.jobs.map((job) => [job.id, job]));
    changedIdsRef.current = jobs
      .filter((job) => before.get(job.id) !== job)
      .map((job) => job.id);
    seenRef.current = { jobs, targets, shortlisted };
    const fixture = fixtureRef.current;
    fixture.setJobs(jobs);
    fixture.setTargets(targets);
    fixture.setShortlistedJobIds(shortlistedJobIds ?? []);
    fixture.setVisibleJobIds(visibleJobIds);
    pendingChangeRef.current = true;
  }
  useEffect(() => {
    if (!pendingChangeRef.current) return;
    pendingChangeRef.current = false;
    fixtureRef.current?.emitJobChange(changedIdsRef.current);
  });
  useEffect(() => () => fixtureRef.current?.restore(), []);
}
