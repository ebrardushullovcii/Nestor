import type { ApplyJobResultListRow, ApplyRunSummary } from "@nordri/contracts";
import {
  type ApplicationOutcome,
  type OutcomeAnalyticsBucket,
  type OutcomeAnalyticsOverview,
  OutcomeAnalyticsOverviewSchema,
  type OutcomeBucketDimension,
  type OutcomeEvent,
  type OutcomeSuggestionKind,
  type OutcomeUncertaintyLevel,
  outcomeBucketDimensionValues,
} from "@nordri/contracts";

import { recordedJobSourceName } from "../../lib/job-source-display-name";
import { UNKNOWN_JOB_SOURCE_BUCKET_KEY } from "@nordri/contracts";

/**
 * Pure presentation derivation for campaign-scoped outcome analytics.
 *
 * The durable analytics overview (`state.outcomeAnalytics`) is always the
 * authoritative all-campaigns view produced by the Job Finder service. This
 * module only derives the *scoped* overview the screen shows when the user
 * narrows to one campaign, mirroring the documented service algorithm so the
 * two views never disagree about rates, sample sizes, uncertainty, or
 * suggestions. It is side-effect free and never mutates its inputs; the
 * denominator is always the real distinct-application event count and rates
 * stay `null` below the documented minimum sample so small samples are never
 * presented as measured facts.
 */

export const OUTCOME_VIEW_MINIMUM_SAMPLE_FOR_RATES = 10;
export const OUTCOME_VIEW_MINIMUM_SAMPLE_FOR_CONFIDENCE = 30;
export const OUTCOME_VIEW_LOW_UNCERTAINTY_SAMPLE = 100;

const WILSON_Z_95 = 1.96;

export const outcomeDimensionLabels: Record<OutcomeBucketDimension, string> = {
  campaign: "Search plan",
  source: "Source",
  job_title: "Job title",
  company: "Company",
  resume_strategy: "Resume approach",
};

export const outcomeDimensionOrder: readonly OutcomeBucketDimension[] =
  outcomeBucketDimensionValues;

export function outcomeDimensionNoun(
  dimension: OutcomeBucketDimension,
  count?: number,
): string {
  if (count === 1) return outcomeDimensionLabels[dimension].toLowerCase();
  switch (dimension) {
    case "campaign":
      return "search plans";
    case "source":
      return "sources";
    case "job_title":
      return "job titles";
    case "company":
      return "companies";
    case "resume_strategy":
      return "resume approaches";
  }
}

export interface OutcomeAnalyticsViewInput {
  /** Explicit user-controlled outcome events to bucket. */
  events: readonly OutcomeEvent[];
  generatedAt: string;
  /**
   * Dimensions to derive. The screen normally asks for its active dimension
   * only; omitting this preserves the all-dimension presentation projection.
   */
  dimensions?: readonly OutcomeBucketDimension[];
  /**
   * Durable analytics overview so user-controlled suggestion state survives
   * the scoped derivation: an explicit user disable is preserved and a
   * pending reset is consumed exactly like the service derivation.
   */
  previousOverview?: OutcomeAnalyticsOverview | null;
}

/**
 * Derives a campaign-scoped analytics overview from the events of one
 * campaign. By default buckets are produced for every supported dimension;
 * callers rendering one active dimension can pass `dimensions` to avoid
 * deriving unused buckets. Keys always come from raw event facts; events
 * without a resume strategy are excluded from the `resume_strategy` dimension
 * rather than bucketed under a fabricated key. Rates stay null below the
 * minimum sample; uncertainty is tied to the sample size; suggestions follow
 * the same conservative gates as the service and honor durable user-disable
 * state.
 */
export function deriveCampaignScopedOutcomeAnalytics(
  input: OutcomeAnalyticsViewInput,
): OutcomeAnalyticsOverview {
  const previousBuckets = new Map<string, OutcomeAnalyticsBucket>();
  for (const bucket of input.previousOverview?.buckets ?? []) {
    previousBuckets.set(
      previousBucketKey(bucket.dimension, bucket.key),
      bucket,
    );
  }

  const globalSummary = summarizeEvents(input.events);
  const globalResponseRate =
    globalSummary.sampleSize >= OUTCOME_VIEW_MINIMUM_SAMPLE_FOR_CONFIDENCE
      ? globalSummary.rateNumerators.response / globalSummary.sampleSize
      : null;

  const buckets: OutcomeAnalyticsBucket[] = [];

  const dimensions = [
    ...new Set(input.dimensions ?? outcomeBucketDimensionValues),
  ];

  for (const dimension of dimensions) {
    const eventsByKey = new Map<string, OutcomeEvent[]>();
    for (const event of input.events) {
      const key = eventKeyForDimension(event, dimension);
      if (key === null) continue;
      const grouped = eventsByKey.get(key);
      if (grouped) {
        grouped.push(event);
      } else {
        eventsByKey.set(key, [event]);
      }
    }

    const dimensionBuckets = [...eventsByKey.entries()]
      .map(([key, events]) => {
        const previousBucket = previousBuckets.get(
          previousBucketKey(dimension, key),
        );
        return deriveBucket({
          dimension,
          key,
          events,
          generatedAt: input.generatedAt,
          ...(previousBucket === undefined ? {} : { previousBucket }),
          globalResponseRate,
        });
      })
      .sort(
        (left, right) =>
          right.sampleSize - left.sampleSize ||
          left.key.localeCompare(right.key),
      );

    buckets.push(...dimensionBuckets);
  }

  return OutcomeAnalyticsOverviewSchema.parse({
    buckets,
    generatedAt: input.generatedAt,
  });
}

/** Filters the outcome event log to one campaign (honest, non-mutating). */
export function outcomeEventsForCampaign(
  events: readonly OutcomeEvent[],
  campaignId: string,
): readonly OutcomeEvent[] {
  return events.filter((event) => event.campaignId === campaignId);
}

function eventKeyForDimension(
  event: OutcomeEvent,
  dimension: OutcomeBucketDimension,
): string | null {
  switch (dimension) {
    case "campaign":
      return event.campaignId;
    case "source":
      return event.source;
    case "job_title":
      return event.jobTitle;
    case "company":
      return event.company;
    case "resume_strategy":
      return event.resumeStrategyId;
  }
}

function deriveBucket(input: {
  dimension: OutcomeBucketDimension;
  key: string;
  events: readonly OutcomeEvent[];
  generatedAt: string;
  previousBucket?: OutcomeAnalyticsBucket;
  globalResponseRate: number | null;
}): OutcomeAnalyticsBucket {
  const summary = summarizeEvents(input.events);
  const sampleSize = summary.sampleSize;
  const appliedCount = summary.rateNumerators.applied;
  const responseCount = summary.rateNumerators.response;
  const interviewCount = summary.rateNumerators.interview;
  const offerCount = summary.rateNumerators.offer;

  const ratesVisible = sampleSize >= OUTCOME_VIEW_MINIMUM_SAMPLE_FOR_RATES;

  const uncertaintyLevel: OutcomeUncertaintyLevel =
    sampleSize >= OUTCOME_VIEW_LOW_UNCERTAINTY_SAMPLE
      ? "low"
      : sampleSize >= OUTCOME_VIEW_MINIMUM_SAMPLE_FOR_CONFIDENCE
        ? "medium"
        : "high";

  const confidenceInterval95HalfWidth =
    ratesVisible && sampleSize >= OUTCOME_VIEW_MINIMUM_SAMPLE_FOR_CONFIDENCE
      ? wilson95HalfWidth(responseCount, sampleSize)
      : null;

  return {
    dimension: input.dimension,
    key: input.key,
    label: input.key,
    sampleSize,
    outcomeCounts: summary.outcomeCounts,
    rateNumerators: summary.rateNumerators,
    appliedRate: ratesVisible ? appliedCount / sampleSize : null,
    responseRate: ratesVisible ? responseCount / sampleSize : null,
    interviewRate: ratesVisible ? interviewCount / sampleSize : null,
    offerRate: ratesVisible ? offerCount / sampleSize : null,
    uncertainty: {
      level: uncertaintyLevel,
      minimumSampleForConfidence: OUTCOME_VIEW_MINIMUM_SAMPLE_FOR_CONFIDENCE,
      confidenceInterval95HalfWidth,
    },
    suggestion: deriveSuggestion({
      dimension: input.dimension,
      key: input.key,
      sampleSize,
      responseRate: ratesVisible ? responseCount / sampleSize : null,
      interviewRate: ratesVisible ? interviewCount / sampleSize : null,
      confidenceInterval95HalfWidth,
      ...(input.previousBucket === undefined
        ? {}
        : { previousSuggestion: input.previousBucket.suggestion }),
      globalResponseRate: input.globalResponseRate,
    }),
    updatedAt: input.generatedAt,
  };
}

/** Wilson 95% score-interval half-width for a binomial proportion. */
function wilson95HalfWidth(successCount: number, sampleSize: number): number {
  const zSquared = WILSON_Z_95 * WILSON_Z_95;
  const proportion = successCount / sampleSize;
  const denominator = 1 + zSquared / sampleSize;
  const halfWidth =
    (WILSON_Z_95 *
      Math.sqrt(
        (proportion * (1 - proportion)) / sampleSize +
          zSquared / (4 * sampleSize * sampleSize),
      )) /
    denominator;
  return Math.min(1, Math.max(0, halfWidth));
}

interface EventSummary {
  sampleSize: number;
  outcomeCounts: Record<string, number>;
  rateNumerators: {
    applied: number;
    response: number;
    interview: number;
    offer: number;
  };
}

/**
 * Summarizes events into a distinct-application sample with the funnel
 * numerators used by every bucket. The denominator is the real number of
 * distinct subjects (application record or job), never a fabricated count.
 */
function summarizeEvents(events: readonly OutcomeEvent[]): EventSummary {
  const eventsBySubject = new Map<string, OutcomeEvent[]>();
  for (const event of events) {
    // Keep the fallback subject identity aligned with the durable model: a
    // legacy event without an application record is still campaign-scoped.
    const subjectId = event.applicationRecordId
      ? `application:${event.applicationRecordId}`
      : `job:${event.campaignId}:${event.jobId}`;
    const grouped = eventsBySubject.get(subjectId) ?? [];
    grouped.push(event);
    eventsBySubject.set(subjectId, grouped);
  }

  const sampleSize = eventsBySubject.size;
  const outcomeCounts: Record<string, number> = {};
  const rateNumerators = { applied: 0, response: 0, interview: 0, offer: 0 };
  for (const events of eventsBySubject.values()) {
    const outcomes = new Set(events.map((event) => event.outcome));
    for (const outcome of outcomes) {
      outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;
    }
    if (
      [
        "applied",
        "employer_response",
        "assessment",
        "interview",
        "offer",
        "rejected",
        "withdrawn",
        "no_response",
      ].some((outcome) => outcomes.has(outcome as ApplicationOutcome))
    ) {
      rateNumerators.applied += 1;
    }
    if (
      [
        "employer_response",
        "assessment",
        "interview",
        "offer",
        "rejected",
      ].some((outcome) => outcomes.has(outcome as ApplicationOutcome))
    ) {
      rateNumerators.response += 1;
    }
    if (outcomes.has("interview") || outcomes.has("offer")) {
      rateNumerators.interview += 1;
    }
    if (outcomes.has("offer")) {
      rateNumerators.offer += 1;
    }
  }

  return { sampleSize, outcomeCounts, rateNumerators };
}

function previousBucketKey(
  dimension: OutcomeBucketDimension,
  key: string,
): string {
  return `${dimension}\u0000${key}`;
}

type PauseOrSwitchKind =
  | "pause_source"
  | "pause_job_title"
  | "pause_company"
  | "switch_resume_strategy";

const pauseKindForDimension: Record<
  Exclude<OutcomeBucketDimension, "campaign">,
  PauseOrSwitchKind
> = {
  source: "pause_source",
  job_title: "pause_job_title",
  company: "pause_company",
  resume_strategy: "switch_resume_strategy",
};

const pauseActionForKind: Record<
  PauseOrSwitchKind,
  { label: string; verb: string; noun: string }
> = {
  pause_source: { label: "Pause source", verb: "pause", noun: "source" },
  pause_job_title: { label: "Pause title", verb: "pause", noun: "job title" },
  pause_company: { label: "Pause company", verb: "pause", noun: "company" },
  switch_resume_strategy: {
    label: "Switch resume strategy",
    verb: "switch",
    noun: "resume strategy",
  },
};

function deriveSuggestion(input: {
  dimension: OutcomeBucketDimension;
  key: string;
  sampleSize: number;
  responseRate: number | null;
  interviewRate: number | null;
  confidenceInterval95HalfWidth: number | null;
  previousSuggestion?: OutcomeAnalyticsBucket["suggestion"];
  globalResponseRate: number | null;
}): OutcomeAnalyticsBucket["suggestion"] {
  const disabledByUser = input.previousSuggestion?.disabledByUser ?? false;
  const lastResetAt = input.previousSuggestion?.lastResetAt ?? null;

  if (disabledByUser) {
    return {
      enabled: false,
      kind: "none",
      label: null,
      reason: null,
      disabledByUser: true,
      resetRequested: false,
      lastResetAt,
    };
  }

  const derived = suggestForBucket(input);

  return {
    enabled: derived?.enabled ?? false,
    kind: derived?.kind ?? "none",
    label: derived?.label ?? null,
    reason: derived?.reason ?? null,
    disabledByUser: false,
    resetRequested: false,
    lastResetAt,
  };
}

function suggestForBucket(input: {
  dimension: OutcomeBucketDimension;
  key: string;
  sampleSize: number;
  responseRate: number | null;
  interviewRate: number | null;
  confidenceInterval95HalfWidth: number | null;
  globalResponseRate: number | null;
}): {
  enabled: true;
  kind: OutcomeSuggestionKind;
  label: string;
  reason: string;
} | null {
  const { sampleSize, confidenceInterval95HalfWidth } = input;

  if (sampleSize < OUTCOME_VIEW_MINIMUM_SAMPLE_FOR_CONFIDENCE) {
    return null;
  }
  if (confidenceInterval95HalfWidth === null) {
    return null;
  }

  if (input.dimension === "campaign") {
    if (input.interviewRate !== null && input.interviewRate >= 0.2) {
      return {
        enabled: true,
        kind: "increase_volume",
        label: `Increase volume for ${input.key}`,
        reason: `Interview rate ${formatPercent(input.interviewRate)} meets or exceeds the 20% target — increase volume for this search plan.`,
      };
    }
    return null;
  }

  if (
    input.responseRate === null ||
    input.globalResponseRate === null ||
    input.responseRate + confidenceInterval95HalfWidth >=
      input.globalResponseRate
  ) {
    return null;
  }

  const kind = pauseKindForDimension[input.dimension];
  const action = pauseActionForKind[kind];
  return {
    enabled: true,
    kind,
    label: `${action.label} ${input.key}`,
    reason: `Response rate ${formatPercent(input.responseRate)} plus uncertainty ${formatPercent(confidenceInterval95HalfWidth)} is below the ${formatPercent(input.globalResponseRate)} overall baseline — ${action.verb} this ${action.noun}.`,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers used by the analytics screen
// ---------------------------------------------------------------------------

export function formatRate(rate: number | null): string {
  if (rate === null) {
    return "Not enough data";
  }
  return formatPercent(rate);
}

export function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function formatUncertainty(input: {
  level: OutcomeUncertaintyLevel;
  confidenceInterval95HalfWidth: number | null;
}): string {
  if (input.confidenceInterval95HalfWidth !== null) {
    return `${formatUncertaintyLevel(input.level)} ±${formatPercent(input.confidenceInterval95HalfWidth)}`;
  }
  return formatUncertaintyLevel(input.level);
}

export function formatUncertaintyLevel(level: OutcomeUncertaintyLevel): string {
  switch (level) {
    case "low":
      return "Low uncertainty";
    case "medium":
      return "Medium uncertainty";
    case "high":
      return "High uncertainty";
  }
}

export function formatSampleSize(sampleSize: number): string {
  return `${sampleSize} application${sampleSize === 1 ? "" : "s"}`;
}

/**
 * Resolves a bucket's display label: campaign and resume-strategy buckets are
 * keyed by id, so the screen maps them to their human names when available and
 * falls back to the raw id otherwise (never fabricating a label). Source
 * buckets are keyed by the stored source value, which is never shown as-is.
 */
export function bucketDisplayLabel(
  bucket: OutcomeAnalyticsBucket,
  resolvers: {
    campaignName: (campaignId: string) => string | null;
    resumeStrategyName: (strategyId: string) => string | null;
    /** The label the person gave the source this outcome came from. */
    sourceName?: (sourceTargetId: string) => string | null;
  },
): string {
  if (bucket.dimension === "campaign") {
    return resolvers.campaignName(bucket.key) ?? bucket.label ?? bucket.key;
  }
  if (bucket.dimension === "resume_strategy") {
    return (
      resolvers.resumeStrategyName(bucket.key) ?? bucket.label ?? bucket.key
    );
  }
  if (bucket.dimension === "source") {
    // Outcomes are bucketed by the originating source id now, so the name a
    // person gave that site is the label; only the unattributed bucket and a
    // legacy row keyed by the stored enum fall back.
    if (bucket.key === UNKNOWN_JOB_SOURCE_BUCKET_KEY) {
      return "Unknown source";
    }
    return (
      resolvers.sourceName?.(bucket.key) ?? recordedJobSourceName(bucket.key)
    );
  }
  return bucket.label ?? bucket.key;
}

/** Counts distinct events in the log (used for the screen summary strip). */
export function countOutcomeEvents(events: readonly OutcomeEvent[]): number {
  return events.length;
}

/** Verified employer receipts are the funnel denominator; reported outcomes stay distinct. */
export function deriveVerifiedApplicationFunnel(input: {
  results: readonly ApplyJobResultListRow[];
  runs: readonly ApplyRunSummary[];
  events: readonly OutcomeEvent[];
  campaignId?: string;
}) {
  const runById = new Map(input.runs.map((run) => [run.id, run]));
  const sent = new Map<string, { recordId: string | null; jobId: string }>();
  for (const result of input.results) {
    if (
      result.privacyReceipt?.finalSubmitOccurred !== true ||
      (result.privacyReceipt.submissionOutcome &&
        result.privacyReceipt.submissionOutcome.outcome !== "submitted")
    )
      continue;
    if (
      input.campaignId &&
      runById.get(result.runId)?.campaignId !== input.campaignId
    )
      continue;
    sent.set(result.applicationRecordId ?? result.jobId, {
      recordId: result.applicationRecordId,
      jobId: result.jobId,
    });
  }
  const responseOutcomes = new Set<ApplicationOutcome>([
    "employer_response",
    "assessment",
    "interview",
    "offer",
    "rejected",
  ]);
  const responses = [...sent.values()].filter((application) =>
    input.events.some(
      (event) =>
        responseOutcomes.has(event.outcome) &&
        (application.recordId && event.applicationRecordId
          ? application.recordId === event.applicationRecordId
          : application.jobId === event.jobId),
    ),
  ).length;
  return {
    sent: sent.size,
    responses,
    responseRate: sent.size ? responses / sent.size : null,
    smallSample: sent.size < 10,
  };
}
