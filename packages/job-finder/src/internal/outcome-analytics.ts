import {
  type ApplicationOutcome,
  type JobFinderIntelligenceState,
  JobFinderIntelligenceStateSchema,
  type OutcomeAnalyticsBucket,
  type OutcomeAnalyticsOverview,
  OutcomeAnalyticsBucketSchema,
  OutcomeAnalyticsOverviewSchema,
  type OutcomeBucketDimension,
  type OutcomeEvent,
  OutcomeEventSchema,
  type OutcomeSuggestionKind,
  type OutcomeUncertaintyLevel,
  outcomeBucketDimensionValues,
  UNKNOWN_JOB_SOURCE_BUCKET_KEY,
} from "@nestor/contracts";

/**
 * Pure outcome-analytics operations over `JobFinderIntelligenceState`.
 *
 * Every operation is side-effect free: it returns a fresh, schema-parsed
 * value and never mutates its inputs. Analytics are derived exclusively from
 * explicit user-controlled outcome events (`OutcomeEventSchema`); sample
 * sizes, rates, and bucket keys always come from real events and are never
 * fabricated. Suggestions are derived conservatively from those same events
 * and never change objective facts or filters; a user disable survives
 * re-derivation and a pending reset is consumed explicitly.
 */

/**
 * Matches the schema cap on the durable outcome event log. Appending past
 * this capacity fails loudly instead of silently dropping events.
 */
export const OUTCOME_EVENT_LOG_CAPACITY = 100_000;

/**
 * Documented minimum sample (default 10) before any bucket rate becomes
 * non-null. Below this sample all rates are `null` so small samples are
 * never presented as measured facts.
 */
export const OUTCOME_DEFAULT_MINIMUM_SAMPLE_FOR_RATES = 10;

/**
 * Sample size at which uncertainty leaves the "high" band and a Wilson 95%
 * confidence interval half-width is reported for the bucket's response rate.
 */
export const OUTCOME_DEFAULT_MINIMUM_SAMPLE_FOR_CONFIDENCE = 30;

/** Sample size at which uncertainty is considered "low". */
export const OUTCOME_DEFAULT_LOW_UNCERTAINTY_SAMPLE = 100;

/** z value for a 95% two-sided normal confidence interval. */
const WILSON_Z_95 = 1.96;

// ---------------------------------------------------------------------------
// Appending explicit user-controlled events
// ---------------------------------------------------------------------------

export interface AppendOutcomeEventInput {
  /**
   * Caller-owned event id. The operation never mints ids: `callerId` becomes
   * the event `id`, so the caller keeps full provenance over who recorded the
   * outcome. Must be unique across the outcome event log.
   */
  callerId: string;
  /** Application record the outcome refers to, when known. */
  applicationRecordId?: string | null;
  jobId: string;
  outcome: ApplicationOutcome;
  campaignId: string;
  source: string;
  /**
   * Saved source the job came from, when its discovery lineage records one.
   * Null is a fact, not a gap: those outcomes group under the unknown-source
   * bucket instead of vanishing from the source breakdown.
   */
  sourceTargetId?: string | null;
  company: string;
  jobTitle: string;
  /** Resume strategy in effect for the application, when recorded. */
  resumeStrategyId?: string | null;
  occurredAt: string;
  note?: string | null;
  /** Timestamp stamped on the durable state after the append. */
  now: string;
  /** Durable intelligence state to append to (never mutated). */
  state: JobFinderIntelligenceState;
}

/**
 * Appends one explicit user-controlled outcome event to a
 * `JobFinderIntelligenceState` and returns the updated state.
 *
 * The event is always stamped `userControlled: true`; there is no way to
 * append an inferred outcome through this operation. The caller supplies the
 * event id and the facts. Appending never recomputes analytics — callers
 * re-derive them with {@link deriveOutcomeAnalytics} so the overview stays
 * in sync with the log.
 *
 * Throws when the caller id is already present (duplicate provenance) or
 * when the log is at its documented capacity.
 */
export function appendOutcomeEvent(
  input: AppendOutcomeEventInput,
): JobFinderIntelligenceState {
  const event = OutcomeEventSchema.parse({
    id: input.callerId,
    outcome: input.outcome,
    applicationRecordId: input.applicationRecordId ?? null,
    jobId: input.jobId,
    campaignId: input.campaignId,
    source: input.source,
    sourceTargetId: input.sourceTargetId ?? null,
    company: input.company,
    jobTitle: input.jobTitle,
    resumeStrategyId: input.resumeStrategyId ?? null,
    occurredAt: input.occurredAt,
    note: input.note ?? null,
    userControlled: true,
  });

  if (input.state.outcomeEvents.length >= OUTCOME_EVENT_LOG_CAPACITY) {
    throw new Error(
      `Cannot append outcome event: the outcome event log is at its ${OUTCOME_EVENT_LOG_CAPACITY} event capacity.`,
    );
  }

  if (input.state.outcomeEvents.some((existing) => existing.id === event.id)) {
    throw new Error(
      `Cannot append outcome event "${event.id}": a user-controlled outcome event with this caller id already exists.`,
    );
  }

  return JobFinderIntelligenceStateSchema.parse({
    ...input.state,
    outcomeEvents: [...input.state.outcomeEvents, event],
    updatedAt: input.now,
  });
}

// ---------------------------------------------------------------------------
// Deriving analytics buckets from actual events
// ---------------------------------------------------------------------------

export interface DeriveOutcomeAnalyticsInput {
  /** Explicit user-controlled outcome events to bucket. */
  events: readonly OutcomeEvent[];
  generatedAt: string;
  /**
   * Dimensions to derive. Durable workspace analytics use the default (all
   * dimensions); scoped consumers can request only the active dimension so a
   * large event log does not pay for buckets that will not be read.
   */
  dimensions?: readonly OutcomeBucketDimension[];
  /**
   * Minimum sample before rates become non-null.
   * @default OUTCOME_DEFAULT_MINIMUM_SAMPLE_FOR_RATES (10)
   */
  minimumSampleForRates?: number;
  /**
   * Sample at which uncertainty leaves the "high" band and a confidence
   * interval half-width is reported.
   * @default OUTCOME_DEFAULT_MINIMUM_SAMPLE_FOR_CONFIDENCE (30)
   */
  minimumSampleForConfidence?: number;
  /**
   * Sample at which uncertainty becomes "low". Clamped to be at least the
   * confidence sample so the emitted uncertainty always satisfies the
   * contracts schema.
   * @default OUTCOME_DEFAULT_LOW_UNCERTAINTY_SAMPLE (100)
   */
  lowUncertaintySample?: number;
  /**
   * Previous analytics overview (normally the durable `state.outcomeAnalytics`)
   * so user-controlled suggestion state survives re-derivation: an explicit
   * user disable is preserved across new events, and a pending reset is
   * consumed and re-evaluated against the current events.
   */
  previousOverview?: OutcomeAnalyticsOverview | null;
}

/**
 * Derives an outcome analytics overview from actual events.
 *
 * Buckets are produced for every supported dimension (`campaign`, `source`,
 * `job_title`, `company`, `resume_strategy`), keyed by the raw fact recorded
 * on the events. A bucket's `sampleSize` is exactly the number of events in
 * it — the denominator is never fabricated — and every rate is the
 * corresponding outcome count divided by that sample.
 *
 * Rates stay `null` until the bucket reaches the documented minimum sample
 * (default 10). Uncertainty is visible on every bucket and tied to sample
 * size: "high" below the confidence sample, "medium" up to the low-uncertainty
 * sample, "low" beyond it; a Wilson 95% half-width for the response rate is
 * reported only once the confidence sample is reached.
 *
 * Suggestions are derived conservatively and only when a bucket reaches the
 * confidence sample (default 30) with a visible Wilson half-width. The
 * `campaign` dimension suggests `increase_volume` only when the interview
 * rate is at least 20%; `source`, `job_title`, `company`, and
 * `resume_strategy` buckets suggest pausing/switching only when the bucket
 * response rate plus its Wilson half-width stays below the overall
 * response-rate baseline. Suggestions never alter objective facts or filters.
 *
 * When `previousOverview` is supplied (normally the durable
 * `state.outcomeAnalytics`), user-controlled suggestion state survives
 * re-derivation: `disabledByUser` is preserved across new events and a
 * pending `resetRequested` is consumed, so the reset's re-evaluation is what
 * this derivation returns and no stale reset flag is persisted.
 *
 * Events without a recorded resume strategy are excluded from the
 * `resume_strategy` dimension rather than bucketed under a fabricated key.
 * Buckets are emitted in dimension declaration order; within a dimension,
 * larger samples come first with ties broken by key ascending.
 */
export function deriveOutcomeAnalytics(
  input: DeriveOutcomeAnalyticsInput,
): OutcomeAnalyticsOverview {
  const minimumSampleForRates =
    input.minimumSampleForRates ?? OUTCOME_DEFAULT_MINIMUM_SAMPLE_FOR_RATES;
  const minimumSampleForConfidence =
    input.minimumSampleForConfidence ??
    OUTCOME_DEFAULT_MINIMUM_SAMPLE_FOR_CONFIDENCE;
  const lowUncertaintySample = Math.max(
    input.lowUncertaintySample ?? OUTCOME_DEFAULT_LOW_UNCERTAINTY_SAMPLE,
    minimumSampleForConfidence,
  );

  // User-controlled suggestion state from the previous overview is carried
  // forward: an explicit disable survives new events and a pending reset is
  // consumed by this derivation.
  const previousBuckets = new Map<string, OutcomeAnalyticsBucket>();
  for (const bucket of input.previousOverview?.buckets ?? []) {
    previousBuckets.set(
      previousBucketKey(bucket.dimension, bucket.key),
      bucket,
    );
  }

  // The overall response-rate baseline that pause/switch suggestions are
  // compared against. It is only consulted once the whole sample reaches the
  // confidence sample, mirroring the bucket-level sufficiency gate.
  const globalSummary = summarizeEvents(input.events);
  const globalResponseRate =
    globalSummary.sampleSize >= minimumSampleForConfidence
      ? globalSummary.rateNumerators.response / globalSummary.sampleSize
      : null;

  const buckets: OutcomeAnalyticsBucket[] = [];

  // Preserve the historical all-dimension output by default while allowing
  // callers that render one dimension at a time to avoid five full passes
  // over a large event log. De-duplicate defensively so a caller cannot emit
  // duplicate buckets for one dimension.
  const dimensions = [
    ...new Set(input.dimensions ?? outcomeBucketDimensionValues),
  ];

  for (const dimension of dimensions) {
    const eventsByKey = new Map<string, OutcomeEvent[]>();

    for (const event of input.events) {
      const key = eventKeyForDimension(event, dimension);
      if (key === null) {
        continue;
      }
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
          minimumSampleForRates,
          minimumSampleForConfidence,
          lowUncertaintySample,
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

function eventKeyForDimension(
  event: OutcomeEvent,
  dimension: OutcomeBucketDimension,
): string | null {
  switch (dimension) {
    case "campaign":
      return event.campaignId;
    // Grouping on the recorded source *kind* produced one bucket holding
    // every outcome, because that enum has one value. The job's own source
    // lineage is the real dimension; outcomes without one are named rather
    // than dropped, so the buckets still add up to the log.
    case "source":
      return event.sourceTargetId ?? UNKNOWN_JOB_SOURCE_BUCKET_KEY;
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
  minimumSampleForRates: number;
  minimumSampleForConfidence: number;
  lowUncertaintySample: number;
  /** Bucket from the previous overview, when present. */
  previousBucket?: OutcomeAnalyticsBucket;
  /** Overall response rate across all events, or null when not reliable. */
  globalResponseRate: number | null;
}): OutcomeAnalyticsBucket {
  const summary = summarizeEvents(input.events);
  const sampleSize = summary.sampleSize;
  const appliedCount = summary.rateNumerators.applied;
  const responseCount = summary.rateNumerators.response;
  const interviewCount = summary.rateNumerators.interview;
  const offerCount = summary.rateNumerators.offer;

  // Rates are nullable until the documented minimum sample; the denominator
  // is always the real event count, never an invented figure.
  const ratesVisible = sampleSize >= input.minimumSampleForRates;

  const uncertaintyLevel: OutcomeUncertaintyLevel =
    sampleSize >= input.lowUncertaintySample
      ? "low"
      : sampleSize >= input.minimumSampleForConfidence
        ? "medium"
        : "high";

  // The half-width describes the bucket's response rate (the headline funnel
  // metric) using the Wilson score interval, which stays valid at 0% or 100%.
  const confidenceInterval95HalfWidth =
    ratesVisible && sampleSize >= input.minimumSampleForConfidence
      ? wilson95HalfWidth(responseCount, sampleSize)
      : null;

  return OutcomeAnalyticsBucketSchema.parse({
    dimension: input.dimension,
    key: input.key,
    // Labels are the raw fact recorded on the events (campaign id, source,
    // job title, company name, or strategy id); no enrichment is fabricated.
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
      minimumSampleForConfidence: input.minimumSampleForConfidence,
      confidenceInterval95HalfWidth,
    },
    // Suggestions are derived conservatively from real events and never alter
    // objective facts or filters. User-controlled state from the previous
    // overview is honored: an explicit disable is preserved and a pending
    // reset is consumed by this derivation.
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
      minimumSampleForConfidence: input.minimumSampleForConfidence,
      globalResponseRate: input.globalResponseRate,
    }),
    updatedAt: input.generatedAt,
  });
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

  // The Wilson interval always lies within [0, 1]; clamp defensively.
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
 * numerators used by every bucket and the overall baseline. The denominator
 * is the real number of distinct subjects (application record or job), never
 * a fabricated count.
 */
function summarizeEvents(events: readonly OutcomeEvent[]): EventSummary {
  const eventsBySubject = new Map<string, OutcomeEvent[]>();
  for (const event of events) {
    // Application records are the durable subject identity. Legacy events may
    // lack that identity; include the campaign in their fallback key so the
    // same job recorded in two campaigns is not merged into one sample.
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

/**
 * Conservative, inspectable suggestion derivation.
 *
 * Suggestions are only produced once the bucket reaches the confidence sample
 * (default 30) with a visible Wilson half-width; below that they stay hidden.
 * The `campaign` dimension suggests increasing volume only when the interview
 * rate is at least 20%. The other dimensions suggest pausing or switching
 * only when the bucket response rate plus its Wilson half-width stays below
 * the overall response-rate baseline.
 *
 * User-controlled state is honored: `disabledByUser` from the previous
 * overview is preserved across new events and always wins over any
 * data-driven suggestion, and a pending `resetRequested` is consumed here —
 * the emitted bucket never carries a pending reset.
 */
function deriveSuggestion(input: {
  dimension: OutcomeBucketDimension;
  key: string;
  sampleSize: number;
  responseRate: number | null;
  interviewRate: number | null;
  confidenceInterval95HalfWidth: number | null;
  previousSuggestion?: OutcomeAnalyticsBucket["suggestion"];
  minimumSampleForConfidence: number;
  globalResponseRate: number | null;
}): OutcomeAnalyticsBucket["suggestion"] {
  const disabledByUser = input.previousSuggestion?.disabledByUser ?? false;
  const lastResetAt = input.previousSuggestion?.lastResetAt ?? null;

  if (disabledByUser) {
    // The user's explicit opt-out wins over any data-driven suggestion.
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
    // The reset, if any, is consumed by this derivation.
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
  minimumSampleForConfidence: number;
  globalResponseRate: number | null;
}): {
  enabled: true;
  kind: OutcomeSuggestionKind;
  label: string;
  reason: string;
} | null {
  const { sampleSize, confidenceInterval95HalfWidth } = input;

  // Only conservative, inspectable suggestions: the bucket must reach the
  // confidence sample and expose a visible Wilson half-width.
  if (sampleSize < input.minimumSampleForConfidence) {
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

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

// ---------------------------------------------------------------------------
// Disabling and resetting suggestion state
// ---------------------------------------------------------------------------

export interface OutcomeSuggestionControlInput {
  /** Durable intelligence state to update (never mutated). */
  state: JobFinderIntelligenceState;
  dimension: OutcomeBucketDimension;
  /** Bucket key within the dimension, e.g. a campaign id or company name. */
  key: string;
  /** Timestamp stamped on the bucket and the durable state. */
  now: string;
}

/**
 * Disables a bucket's suggestion at the user's request, immutably.
 *
 * The suggestion is switched off (`enabled: false`), flagged as disabled by
 * the user, and stripped of any previous payload. The bucket and state
 * `updatedAt` are advanced. When the analytics overview or the target bucket
 * does not exist, the state is returned unchanged (safe no-op).
 */
export function disableOutcomeSuggestion(
  input: OutcomeSuggestionControlInput,
): JobFinderIntelligenceState {
  return updateOutcomeSuggestion(input, (suggestion) => ({
    ...suggestion,
    enabled: false,
    kind: "none",
    label: null,
    reason: null,
    disabledByUser: true,
    resetRequested: false,
    lastResetAt: null,
  }));
}

/**
 * Resets a bucket's suggestion at the user's request, immutably.
 *
 * The suggestion is turned off, any previous user disable is lifted
 * (`disabledByUser: false`), and `resetRequested` is set with the reset
 * timestamp so the system re-derives the suggestion fresh. When the analytics
 * overview or the target bucket does not exist, the state is returned
 * unchanged (safe no-op).
 */
export function resetOutcomeSuggestion(
  input: OutcomeSuggestionControlInput,
): JobFinderIntelligenceState {
  return updateOutcomeSuggestion(input, (suggestion) => ({
    ...suggestion,
    enabled: false,
    kind: "none",
    label: null,
    reason: null,
    disabledByUser: false,
    resetRequested: true,
    lastResetAt: input.now,
  }));
}

function updateOutcomeSuggestion(
  input: OutcomeSuggestionControlInput,
  mutate: (
    suggestion: OutcomeAnalyticsBucket["suggestion"],
  ) => OutcomeAnalyticsBucket["suggestion"],
): JobFinderIntelligenceState {
  const overview = input.state.outcomeAnalytics;
  if (!overview) {
    return input.state;
  }

  const targetIndex = overview.buckets.findIndex(
    (bucket) =>
      bucket.dimension === input.dimension && bucket.key === input.key,
  );
  if (targetIndex === -1) {
    return input.state;
  }

  const buckets = overview.buckets.map((bucket, index) =>
    index === targetIndex
      ? OutcomeAnalyticsBucketSchema.parse({
          ...bucket,
          suggestion: mutate(bucket.suggestion),
          updatedAt: input.now,
        })
      : bucket,
  );

  return JobFinderIntelligenceStateSchema.parse({
    ...input.state,
    outcomeAnalytics: OutcomeAnalyticsOverviewSchema.parse({
      ...overview,
      buckets,
    }),
    updatedAt: input.now,
  });
}
