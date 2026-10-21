import { createHash, randomUUID } from "node:crypto";
import {
  TailoredAssetSummarySchema,
  ApplyJobResultListRowSchema,
  ApplicationAttemptListRowSchema,
} from "@nestor/contracts";
import type {
  DiscoveryRunRecord,
  JobFinderWorkspaceSnapshot,
  SavedJob,
  DiscoveryJobView,
  JobListRow,
  JobListMatchAssessment,
  MatchAssessment,
  JobFinderRendererWorkspaceSnapshot,
  TailoredAsset,
  TailoredAssetSummary,
  ApplyJobResult,
  ApplyJobResultListRow,
  ApplicationAttempt,
  ApplicationAttemptListRow,
} from "@nestor/contracts";

const listRows = new WeakMap<DiscoveryJobView, JobListRow>();

/** One small row per validated main job; no full listing crosses list IPC. */
export function toRendererJob(job: DiscoveryJobView): JobListRow {
  // Display projections borrow frozen repository values. Canonical reads and
  // fixtures are caller-owned and may be edited in place between responses.
  const reusable = Object.isFrozen(job);
  const cached = reusable ? listRows.get(job) : undefined;
  if (cached) return cached;
  const row: JobListRow = {
    id: job.id,
    campaignIds: job.campaignIds ?? [],
    personSupplied: job.personSupplied,
    source: job.source,
    sourceJobId: job.sourceJobId,
    discoveryMethod: job.discoveryMethod,
    collectionMethod: job.collectionMethod,
    canonicalUrl: job.canonicalUrl,
    applicationUrl: job.applicationUrl,
    title: job.title,
    company: job.company,
    location: job.location,
    workMode: job.workMode,
    applyPath: job.applyPath,
    easyApplyEligible: job.easyApplyEligible,
    postedAt: job.postedAt,
    postedAtText: job.postedAtText,
    providerUpdatedAt: job.providerUpdatedAt,
    discoveredAt: job.discoveredAt,
    firstSeenAt: job.firstSeenAt,
    lastSeenAt: job.lastSeenAt,
    lastVerifiedActiveAt: job.lastVerifiedActiveAt,
    salaryText: job.salaryText,
    normalizedCompensation: job.normalizedCompensation,
    detailQuality: job.detailQuality,
    listingDetailCapture: job.listingDetailCapture,
    seniority: job.seniority,
    employmentType: job.employmentType,
    employerDomain: job.employerDomain,
    status: job.status,
    matchAssessment: toListMatchAssessment(job.matchAssessment),
    provenance: job.provenance.map((entry) => {
      const sighting = { ...entry };
      delete sighting.listingFacts;
      return reusable ? Object.freeze(sighting) : sighting;
    }),
    discoveryFeedback: job.discoveryFeedback,
    resumeApplicationMode: job.resumeApplicationMode,
    resumeTailoringMode: job.resumeTailoringMode ?? null,
    listingActivity: job.listingActivity,
    detailRevision: reusable ? frozenRowRevision(job) : jobDetailRevision(job),
    rescoredAfterListingRead: Boolean(
      job.latestMatchAssessmentAudit?.inputChanges.some(
        (change) => change.code === "listing_evidence_changed",
      ) &&
      job.latestMatchAssessmentAudit.outputChanges.some(
        (change) => change.code === "score_changed",
      ),
    ),
  };
  if (reusable) {
    Object.freeze(row.provenance);
    Object.freeze(row);
    listRows.set(job, row);
  }
  return row;
}

/**
 * The fit facts a list row shows. Explanations, evidence and fingerprints are
 * most of an assessment's size and are read with the job detail.
 */
export function toListMatchAssessment(
  assessment: MatchAssessment,
): JobListMatchAssessment {
  const { compensationFit, dimensions, judgment } = assessment;
  const confidence = dimensions.evidenceConfidence;
  return {
    scorerVersion: assessment.scorerVersion,
    contextFingerprint: assessment.contextFingerprint,
    postingFingerprint: assessment.postingFingerprint,
    score: assessment.score,
    scoreIsUpperBound: assessment.scoreIsUpperBound,
    compensationFit: {
      state: compensationFit.state,
      confidence: compensationFit.confidence,
      minimumSalaryUsd: compensationFit.minimumSalaryUsd,
      listingMinimumAnnualUsd: compensationFit.listingMinimumAnnualUsd,
      listingCurrency: compensationFit.listingCurrency,
    },
    locationReach: assessment.locationReach,
    ...(assessment.titleFamilyMatch === undefined
      ? {}
      : { titleFamilyMatch: assessment.titleFamilyMatch }),
    dimensions: {
      roleSuitability: { state: dimensions.roleSuitability.state },
      preferenceAlignment: { state: dimensions.preferenceAlignment.state },
      applicationEffort: { level: dimensions.applicationEffort.level },
      evidenceConfidence: {
        level: confidence.level,
        supportedCount: confidence.supportedCount,
        partialCount: confidence.partialCount,
        missingCount: confidence.missingCount,
        unknownCount: confidence.unknownCount,
        conflictCount: confidence.conflictCount,
      },
    },
    reasons: assessment.reasons,
    gaps: assessment.gaps,
    recommendation: assessment.recommendation,
    recommendationRationale: assessment.recommendationRationale,
    requirements: assessment.requirements.map(
      ({ id, category, label, importance, status }) => ({
        id,
        category,
        label,
        importance,
        status,
      }),
    ),
    ...(assessment.requirementsSource === undefined
      ? {}
      : { requirementsSource: assessment.requirementsSource }),
    ...(judgment === undefined
      ? {}
      : {
          judgment: judgment && {
            source: judgment.source,
            judgedAt: judgment.judgedAt,
            score: judgment.score,
            recommendation: judgment.recommendation,
            role: judgment.role,
            preferences: judgment.preferences,
            locationReach: judgment.locationReach,
            reasons: judgment.reasons,
            gaps: judgment.gaps,
            ...(judgment.summary === undefined
              ? {}
              : { summary: judgment.summary }),
            listingClosed: judgment.listingClosed,
          },
        }),
  };
}

/**
 * A frozen repository row cannot change, and the repository hands out a new
 * row whenever a stored job changes, so the row's identity is its revision.
 * The epoch keeps a number from an earlier run of the app from matching a
 * different row now. Hashing every job's detail instead cost about 0.7 s of
 * each start on 6,284 jobs.
 */
const rowRevisionEpoch = randomUUID().slice(0, 8);
let nextRowRevision = 0;
const rowRevisions = new WeakMap<object, string>();
function frozenRowRevision(job: DiscoveryJobView): string {
  let revision = rowRevisions.get(job);
  if (!revision) {
    nextRowRevision += 1;
    revision = `${rowRevisionEpoch}-${nextRowRevision}`;
    rowRevisions.set(job, revision);
  }
  return revision;
}

/** Detail-only revision, cached with the job, independent of delta comparisons. */
export function jobDetailRevision(job: SavedJob): string {
  return createHash("sha256")
    .update(job.description)
    .update(
      JSON.stringify([
        job.needsRenderedPage,
        job.searchRejection,
        job.producingPageUrl,
        job.summary,
        job.keySkills,
        job.responsibilities,
        job.minimumQualifications,
        job.preferredQualifications,
        job.department,
        job.team,
        job.employerWebsiteUrl,
        job.atsProvider,
        job.providerKey,
        job.providerBoardToken,
        job.providerIdentifier,
        job.titleTriageOutcome,
        job.sourceIntelligence,
        job.screeningHints,
        job.keywordSignals,
        job.benefits,
        job.listingDetailFetch,
        job.latestMatchAssessmentAudit,
        job.planAssessments,
        job.provenance,
        job.matchAssessment,
      ]),
    )
    .digest("hex");
}

const jobCollections = new WeakMap<DiscoveryJobView[], JobListRow[]>();
const assetRows = new WeakMap<TailoredAsset, TailoredAssetSummary>();
const assetCollections = new WeakMap<TailoredAsset[], TailoredAssetSummary[]>();
function toRendererAssets(assets: TailoredAsset[]): TailoredAssetSummary[] {
  const reusable = Object.isFrozen(assets);
  const cached = reusable ? assetCollections.get(assets) : undefined;
  if (cached) return cached;
  const rows = assets.map((asset) => {
    const borrowed = Object.isFrozen(asset);
    const previous = borrowed ? assetRows.get(asset) : undefined;
    if (previous) return previous;
    const metadata: Partial<TailoredAsset> = { ...asset };
    delete metadata.contentText;
    delete metadata.previewSections;
    const summary = TailoredAssetSummarySchema.parse(metadata);
    Object.freeze(summary.notes);
    if (borrowed) {
      Object.freeze(summary);
      assetRows.set(asset, summary);
    }
    return summary;
  });
  if (reusable) {
    Object.freeze(rows);
    assetCollections.set(assets, rows);
  }
  return rows;
}

const resultRows = new WeakMap<ApplyJobResult, ApplyJobResultListRow>();
const resultCollections = new WeakMap<
  ApplyJobResult[],
  ApplyJobResultListRow[]
>();
function toRendererResults(results: ApplyJobResult[]): ApplyJobResultListRow[] {
  const reusable = Object.isFrozen(results);
  const cached = reusable ? resultCollections.get(results) : undefined;
  if (cached) return cached;
  const rows = results.map((result) => {
    const borrowed = Object.isFrozen(result);
    const previous = borrowed ? resultRows.get(result) : undefined;
    if (previous) return previous;
    const row: Partial<ApplyJobResult> = { ...result };
    delete row.visualObservationSets;
    delete row.visualCheckpoints;
    // Already repository-validated; parse only the DTO on its first projection.
    const projected = ApplyJobResultListRowSchema.parse(row);
    if (borrowed) {
      Object.freeze(projected);
      resultRows.set(result, projected);
    }
    return projected;
  });
  if (reusable) {
    Object.freeze(rows);
    resultCollections.set(results, rows);
  }
  return rows;
}
const attemptRows = new WeakMap<
  ApplicationAttempt,
  ApplicationAttemptListRow
>();
const attemptCollections = new WeakMap<
  ApplicationAttempt[],
  ApplicationAttemptListRow[]
>();
function toRendererAttempts(
  attempts: ApplicationAttempt[],
): ApplicationAttemptListRow[] {
  const reusable = Object.isFrozen(attempts);
  const cached = reusable ? attemptCollections.get(attempts) : undefined;
  if (cached) return cached;
  const rows = attempts.map((attempt) => {
    const borrowed = Object.isFrozen(attempt);
    const previous = borrowed ? attemptRows.get(attempt) : undefined;
    if (previous) return previous;
    const row: Partial<ApplicationAttempt> = { ...attempt };
    delete row.checkpoints;
    delete row.visualEvidence;
    delete row.visualObservationSets;
    delete row.visualCheckpoints;
    const projected = ApplicationAttemptListRowSchema.parse(row);
    if (borrowed) {
      Object.freeze(projected);
      attemptRows.set(attempt, projected);
    }
    return projected;
  });
  if (reusable) {
    Object.freeze(rows);
    attemptCollections.set(attempts, rows);
  }
  return rows;
}
function toRendererJobs(jobs: DiscoveryJobView[]): JobListRow[] {
  const cached = jobCollections.get(jobs);
  if (cached) return cached;
  const reusable = Object.isFrozen(jobs) && jobs.every(Object.isFrozen);
  const rows = jobs.map(toRendererJob);
  if (reusable) {
    Object.freeze(rows);
    jobCollections.set(jobs, rows);
  }
  return rows;
}

/** Steps of a finished search the window keeps beyond each source's last one. */
export const FINISHED_RUN_RECENT_ACTIVITY = 400;

/**
 * A finished search keeps every source's final step (what each source found,
 * or why it stopped) and its most recent steps for the window. One 897-source
 * search logged 11,000 steps, 7.8 MB that every screen held and every refresh
 * compared; the full log stays stored in main.
 */
function compactFinishedRunActivity(
  activity: DiscoveryRunRecord["activity"],
): DiscoveryRunRecord["activity"] {
  if (activity.length <= FINISHED_RUN_RECENT_ACTIVITY * 1.5) return activity;
  const recentFrom = activity.length - FINISHED_RUN_RECENT_ACTIVITY;
  return activity.filter(
    (event, index) =>
      index >= recentFrom ||
      (event.terminalState !== null && event.terminalState !== undefined),
  );
}

const rendererRuns = new WeakMap<DiscoveryRunRecord, DiscoveryRunRecord>();

type TargetExecution = DiscoveryRunRecord["targetExecutions"][number];

function carriesMainOnlyState(entry: TargetExecution): boolean {
  return (
    entry.agentCheckpoint !== null ||
    entry.inspectedJobIds !== undefined ||
    entry.encounteredJobIds.length > 0
  );
}

function toRendererTargetExecution(entry: TargetExecution): TargetExecution {
  if (!carriesMainOnlyState(entry)) return entry;
  const projected = {
    ...entry,
    agentCheckpoint: null,
    encounteredJobIds: [],
  };
  delete projected.inspectedJobIds;
  return projected;
}

/**
 * A source's resume checkpoint holds every posting it collected so far, so
 * an interrupted search can go on, and the inspected and encountered job ids
 * feed plan membership and counts. Only main reads them; across 897 sources
 * they were over a megabyte per search. Finished runs also send a compact
 * activity log (see above).
 */
export function toRendererRun(
  run: DiscoveryRunRecord,
  options: { finished?: boolean } = {},
): DiscoveryRunRecord {
  const reusable = Object.isFrozen(run);
  const cacheable = reusable && options.finished === true;
  const cached = cacheable ? rendererRuns.get(run) : undefined;
  if (cached) return cached;
  const activity = options.finished
    ? compactFinishedRunActivity(run.activity)
    : run.activity;
  const keepsExecutions = !run.targetExecutions.some(carriesMainOnlyState);
  if (keepsExecutions && activity === run.activity) return run;
  const projected: DiscoveryRunRecord = {
    ...run,
    activity,
    targetExecutions: keepsExecutions
      ? run.targetExecutions
      : run.targetExecutions.map(toRendererTargetExecution),
  };
  if (cacheable) {
    Object.freeze(projected);
    rendererRuns.set(run, projected);
  }
  return projected;
}

/**
 * Every job identity stays available; only selected panels read full evidence.
 */
export function toRendererWorkspaceSnapshot(
  snapshot: JobFinderWorkspaceSnapshot,
): JobFinderRendererWorkspaceSnapshot {
  const discoveryJobs = toRendererJobs(snapshot.discoveryJobs);
  const dismissedDiscoveryJobs = toRendererJobs(
    snapshot.dismissedDiscoveryJobs,
  );
  const companyJobs = toRendererJobs(snapshot.companyJobs);
  const activeDiscoveryRun = snapshot.activeDiscoveryRun
    ? toRendererRun(snapshot.activeDiscoveryRun)
    : null;
  const trimmedRecentRuns = snapshot.recentDiscoveryRuns.map((run) =>
    toRendererRun(run, {
      finished: run.id !== snapshot.activeDiscoveryRun?.id,
    }),
  );
  const recentDiscoveryRuns = trimmedRecentRuns.every(
    (run, index) => run === snapshot.recentDiscoveryRuns[index],
  )
    ? snapshot.recentDiscoveryRuns
    : trimmedRecentRuns;
  return {
    ...snapshot,
    tailoredAssets: toRendererAssets(snapshot.tailoredAssets ?? []),
    applyJobResults: toRendererResults(snapshot.applyJobResults),
    applicationAttempts: toRendererAttempts(snapshot.applicationAttempts),
    discoveryJobs,
    dismissedDiscoveryJobs,
    companyJobs,
    activeDiscoveryRun,
    recentDiscoveryRuns,
  };
}
