import {
  type JobFinderIntelligenceState,
  JobFinderIntelligenceStateSchema,
  type OutcomeAnalyticsBucket,
  type OutcomeAnalyticsOverview,
  OutcomeAnalyticsBucketSchema,
  OutcomeAnalyticsOverviewSchema,
  type OutcomeBucketDimension,
  type OutcomeEvent,
  OutcomeEventSchema,
  UNKNOWN_JOB_SOURCE_BUCKET_KEY,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import {
  OUTCOME_DEFAULT_MINIMUM_SAMPLE_FOR_CONFIDENCE,
  OUTCOME_DEFAULT_MINIMUM_SAMPLE_FOR_RATES,
  OUTCOME_EVENT_LOG_CAPACITY,
  type AppendOutcomeEventInput,
  appendOutcomeEvent,
  deriveOutcomeAnalytics,
  disableOutcomeSuggestion,
  resetOutcomeSuggestion,
} from "./outcome-analytics";

const now = "2026-08-15T10:00:00.000Z";
const later = "2026-08-16T10:00:00.000Z";

function state(): JobFinderIntelligenceState {
  return JobFinderIntelligenceStateSchema.parse({});
}

function event(overrides: Partial<OutcomeEvent> = {}): OutcomeEvent {
  const id = overrides.id ?? "event-1";
  return OutcomeEventSchema.parse({
    id,
    outcome: "applied",
    jobId: overrides.jobId ?? `job-${id}`,
    campaignId: "campaign-1",
    source: "example",
    company: "Example Corp",
    jobTitle: "Software Engineer",
    occurredAt: now,
    userControlled: true,
    ...overrides,
  });
}

function appendInput(
  overrides: Partial<AppendOutcomeEventInput> = {},
): AppendOutcomeEventInput {
  return {
    state: state(),
    callerId: "caller-1",
    jobId: "job-1",
    outcome: "applied",
    campaignId: "campaign-1",
    source: "example",
    company: "Example Corp",
    jobTitle: "Software Engineer",
    occurredAt: now,
    now,
    ...overrides,
  };
}

function bucketOf(
  overview: OutcomeAnalyticsOverview,
  dimension: OutcomeBucketDimension,
  key: string,
): OutcomeAnalyticsBucket {
  const bucket = overview.buckets.find(
    (candidate) => candidate.dimension === dimension && candidate.key === key,
  );
  if (!bucket) {
    throw new Error(`Missing ${dimension} bucket for key ${key}`);
  }
  return bucket;
}

describe("appendOutcomeEvent", () => {
  it("appends an explicit user-controlled event stamped with the caller id", () => {
    const next = appendOutcomeEvent(
      appendInput({
        callerId: "user_action_42",
        outcome: "interview",
      }),
    );

    expect(next.outcomeEvents).toHaveLength(1);
    expect(next.outcomeEvents[0]).toMatchObject({
      id: "user_action_42",
      userControlled: true,
      outcome: "interview",
      jobId: "job-1",
      campaignId: "campaign-1",
      source: "example",
      company: "Example Corp",
      jobTitle: "Software Engineer",
    });
  });

  it("defaults optional facts to null", () => {
    const next = appendOutcomeEvent(appendInput());

    expect(next.outcomeEvents[0]).toMatchObject({
      applicationRecordId: null,
      resumeStrategyId: null,
      note: null,
    });
  });

  it("preserves caller-provided optional facts", () => {
    const next = appendOutcomeEvent(
      appendInput({
        applicationRecordId: "application-9",
        resumeStrategyId: "strategy-1",
        note: "Recruiter reached out on LinkedIn",
      }),
    );

    expect(next.outcomeEvents[0]).toMatchObject({
      applicationRecordId: "application-9",
      resumeStrategyId: "strategy-1",
      note: "Recruiter reached out on LinkedIn",
    });
  });

  it("is immutable and preserves append order", () => {
    const original = state();
    const first = appendOutcomeEvent(appendInput({ callerId: "caller-1" }));
    const second = appendOutcomeEvent(
      appendInput({ state: first, callerId: "caller-2" }),
    );

    expect(original.outcomeEvents).toHaveLength(0);
    expect(first.outcomeEvents).toHaveLength(1);
    expect(second.outcomeEvents.map((entry) => entry.id)).toEqual([
      "caller-1",
      "caller-2",
    ]);
    expect(second).not.toBe(first);
    expect(second.outcomeEvents).not.toBe(first.outcomeEvents);
  });

  it("stamps the durable state updatedAt with the caller's now", () => {
    const next = appendOutcomeEvent(appendInput({ now: later }));

    expect(next.updatedAt).toBe(later);
  });

  it("leaves analytics untouched until re-derived", () => {
    const overview = OutcomeAnalyticsOverviewSchema.parse({
      generatedAt: now,
      buckets: [],
    });
    const original = JobFinderIntelligenceStateSchema.parse({
      outcomeAnalytics: overview,
      updatedAt: now,
    });
    const next = appendOutcomeEvent(appendInput({ state: original }));

    expect(next.outcomeAnalytics).toEqual(overview);
  });

  it("rejects a duplicate caller id", () => {
    const first = appendOutcomeEvent(appendInput());

    expect(() =>
      appendOutcomeEvent(appendInput({ state: first, callerId: "caller-1" })),
    ).toThrow(/caller id already exists/i);
  });

  it("rejects appends past the documented event log capacity", () => {
    const fullState = {
      ...state(),
      outcomeEvents: Array.from({ length: OUTCOME_EVENT_LOG_CAPACITY }, () =>
        event({ id: "filled" }),
      ),
    } as JobFinderIntelligenceState;

    expect(() => appendOutcomeEvent(appendInput({ state: fullState }))).toThrow(
      /capacity/i,
    );
  });

  it("rejects invalid facts through the outcome event schema", () => {
    expect(() =>
      appendOutcomeEvent(appendInput({ outcome: "mystery" as never })),
    ).toThrow();
    expect(() => appendOutcomeEvent(appendInput({ source: "   " }))).toThrow();
  });
});

describe("deriveOutcomeAnalytics", () => {
  it("derives one requested dimension deterministically for 10k events", () => {
    const events = Array.from({ length: 10_000 }, (_, index) =>
      event({
        id: `large-${index}`,
        jobId: `large-job-${index}`,
        campaignId: `large-campaign-${index % 4}`,
        sourceTargetId: `source-${String(index % 100).padStart(3, "0")}`,
        company: `Company ${index % 25}`,
        jobTitle: `Role ${index % 10}`,
        resumeStrategyId: `strategy-${index % 5}`,
        outcome:
          index % 3 === 0
            ? "interview"
            : index % 3 === 1
              ? "rejected"
              : "applied",
      }),
    );
    const input = {
      events,
      generatedAt: now,
      dimensions: ["source"] as const,
    };

    const first = deriveOutcomeAnalytics(input);
    const second = deriveOutcomeAnalytics(input);

    expect(first).toEqual(second);
    expect([
      ...new Set(first.buckets.map((bucket) => bucket.dimension)),
    ]).toEqual(["source"]);
    expect(first.buckets).toHaveLength(100);
    expect(first.buckets.slice(0, 3).map((bucket) => bucket.key)).toEqual([
      "source-000",
      "source-001",
      "source-002",
    ]);
    expect(first.buckets.every((bucket) => bucket.sampleSize === 100)).toBe(
      true,
    );
  });

  it("derives buckets for every supported dimension from actual events", () => {
    const events: OutcomeEvent[] = [
      ...Array.from({ length: 12 }, (_, index) =>
        event({
          id: `a-${index}`,
          campaignId: "campaign-a",
          sourceTargetId: "source-x",
          jobTitle: "Engineer",
          company: "Acme",
          resumeStrategyId: "strategy-1",
        }),
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        event({
          id: `b-${index}`,
          campaignId: "campaign-b",
          sourceTargetId: "source-y",
          jobTitle: "Designer",
          company: "Beta",
          resumeStrategyId: "strategy-2",
        }),
      ),
    ];
    const overview = deriveOutcomeAnalytics({ events, generatedAt: now });

    expect(bucketOf(overview, "campaign", "campaign-a").sampleSize).toBe(12);
    expect(bucketOf(overview, "campaign", "campaign-b").sampleSize).toBe(3);
    expect(bucketOf(overview, "source", "source-x").sampleSize).toBe(12);
    expect(bucketOf(overview, "job_title", "Engineer").sampleSize).toBe(12);
    expect(bucketOf(overview, "company", "Acme").sampleSize).toBe(12);
    expect(bucketOf(overview, "resume_strategy", "strategy-1").sampleSize).toBe(
      12,
    );
    expect(new Set(overview.buckets.map((bucket) => bucket.dimension))).toEqual(
      new Set([
        "campaign",
        "source",
        "job_title",
        "company",
        "resume_strategy",
      ]),
    );
  });

  it("never fabricates a resume_strategy bucket for events without a strategy", () => {
    const events = [
      event({ id: "e1", resumeStrategyId: null }),
      event({ id: "e2", resumeStrategyId: "strategy-1" }),
    ];
    const overview = deriveOutcomeAnalytics({ events, generatedAt: now });

    expect(
      overview.buckets.filter((b) => b.dimension === "resume_strategy"),
    ).toHaveLength(1);
    expect(bucketOf(overview, "resume_strategy", "strategy-1").sampleSize).toBe(
      1,
    );
  });

  it("uses the real event count as the sample size with no fabricated denominator", () => {
    const events = Array.from({ length: 7 }, (_, index) =>
      event({
        id: `c-${index}`,
        campaignId: "campaign-c",
        outcome: index % 2 === 0 ? "applied" : "rejected",
      }),
    );
    const bucket = bucketOf(
      deriveOutcomeAnalytics({ events, generatedAt: now }),
      "campaign",
      "campaign-c",
    );

    expect(bucket.sampleSize).toBe(7);
    const counted = Object.values(bucket.outcomeCounts).reduce(
      (sum, count) => sum + count,
      0,
    );
    expect(counted).toBe(bucket.sampleSize);
    expect(bucket.outcomeCounts.applied).toBe(4);
    expect(bucket.outcomeCounts.rejected).toBe(3);
  });

  it("keeps rates null below the documented minimum sample and visible at it", () => {
    const small = bucketOf(
      deriveOutcomeAnalytics({
        events: Array.from({ length: 9 }, (_, index) =>
          event({ id: `s-${index}`, campaignId: "campaign-small" }),
        ),
        generatedAt: now,
      }),
      "campaign",
      "campaign-small",
    );
    expect(small.sampleSize).toBe(OUTCOME_DEFAULT_MINIMUM_SAMPLE_FOR_RATES - 1);
    expect(small.appliedRate).toBeNull();
    expect(small.responseRate).toBeNull();
    expect(small.interviewRate).toBeNull();
    expect(small.offerRate).toBeNull();

    const atMinimum = bucketOf(
      deriveOutcomeAnalytics({
        events: Array.from({ length: 10 }, (_, index) =>
          event({ id: `m-${index}`, campaignId: "campaign-min" }),
        ),
        generatedAt: now,
      }),
      "campaign",
      "campaign-min",
    );
    expect(atMinimum.sampleSize).toBe(OUTCOME_DEFAULT_MINIMUM_SAMPLE_FOR_RATES);
    expect(atMinimum.appliedRate).toBe(1);
    expect(atMinimum.responseRate).toBe(0);
    expect(atMinimum.interviewRate).toBe(0);
    expect(atMinimum.offerRate).toBe(0);
  });

  it("treats employer rejection as proof that an application was sent", () => {
    const events = Array.from({ length: 10 }, (_, index) =>
      event({
        id: `ap-${index}`,
        campaignId: "campaign-applied",
        outcome: index < 3 ? "applied" : "rejected",
      }),
    );
    const bucket = bucketOf(
      deriveOutcomeAnalytics({ events, generatedAt: now }),
      "campaign",
      "campaign-applied",
    );

    expect(bucket.appliedRate).toBe(1);
  });

  it("computes the response rate from employer_response, assessment, interview, and offer counts", () => {
    const outcomes: OutcomeEvent["outcome"][] = [
      "employer_response",
      "assessment",
      "interview",
      "offer",
      "applied",
      "applied",
      "applied",
      "rejected",
      "withdrawn",
      "no_response",
    ];
    const events = outcomes.map((outcome, index) =>
      event({
        id: `funnel-${index}`,
        campaignId: "campaign-funnel",
        outcome,
      }),
    );
    const bucket = bucketOf(
      deriveOutcomeAnalytics({ events, generatedAt: now }),
      "campaign",
      "campaign-funnel",
    );

    expect(bucket.sampleSize).toBe(10);
    expect(bucket.responseRate).toBeCloseTo(0.5, 10);
    expect(bucket.interviewRate).toBeCloseTo(0.2, 10);
    expect(bucket.offerRate).toBeCloseTo(0.1, 10);
    expect(bucket.appliedRate).toBe(1);
  });

  it("counts employer rejection as an application and a response", () => {
    const events = Array.from({ length: 10 }, (_, index) =>
      event({
        id: `z-${index}`,
        campaignId: "campaign-zero",
        outcome: "rejected",
      }),
    );
    const bucket = bucketOf(
      deriveOutcomeAnalytics({ events, generatedAt: now }),
      "campaign",
      "campaign-zero",
    );

    expect(bucket.appliedRate).toBe(1);
    expect(bucket.responseRate).toBe(1);
    expect(bucket.interviewRate).toBe(0);
    expect(bucket.offerRate).toBe(0);
  });

  it("counts one application once even when its timeline has several outcomes", () => {
    const events = [
      event({ id: "timeline-applied", jobId: "same-job", outcome: "applied" }),
      event({
        id: "timeline-interview",
        jobId: "same-job",
        outcome: "interview",
      }),
      event({ id: "timeline-offer", jobId: "same-job", outcome: "offer" }),
    ];
    const bucket = bucketOf(
      deriveOutcomeAnalytics({
        events,
        generatedAt: now,
        minimumSampleForRates: 1,
      }),
      "campaign",
      "campaign-1",
    );

    expect(bucket.sampleSize).toBe(1);
    expect(bucket.outcomeCounts).toMatchObject({
      applied: 1,
      interview: 1,
      offer: 1,
    });
    expect(bucket.rateNumerators).toEqual({
      applied: 1,
      response: 1,
      interview: 1,
      offer: 1,
    });
  });

  it("ties the visible uncertainty level to the sample size", () => {
    const deriveFor = (count: number) =>
      bucketOf(
        deriveOutcomeAnalytics({
          events: Array.from({ length: count }, (_, index) =>
            event({ id: `u-${index}`, campaignId: "campaign-uncertainty" }),
          ),
          generatedAt: now,
        }),
        "campaign",
        "campaign-uncertainty",
      );

    expect(deriveFor(9).uncertainty.level).toBe("high");
    expect(deriveFor(30).uncertainty.level).toBe("medium");
    expect(deriveFor(100).uncertainty.level).toBe("low");
  });

  it("reports a confidence interval half-width only at the confidence sample, narrowing with more data", () => {
    const deriveFor = (count: number, interviewShare: number) =>
      bucketOf(
        deriveOutcomeAnalytics({
          events: Array.from({ length: count }, (_, index) =>
            event({
              id: `hw-${index}`,
              campaignId: "campaign-halfwidth",
              outcome:
                index < Math.round(count * interviewShare)
                  ? "interview"
                  : "rejected",
            }),
          ),
          generatedAt: now,
        }),
        "campaign",
        "campaign-halfwidth",
      );

    const below = deriveFor(
      OUTCOME_DEFAULT_MINIMUM_SAMPLE_FOR_CONFIDENCE - 1,
      0.5,
    );
    expect(below.uncertainty.confidenceInterval95HalfWidth).toBeNull();

    const atConfidence = deriveFor(
      OUTCOME_DEFAULT_MINIMUM_SAMPLE_FOR_CONFIDENCE,
      0.5,
    );
    expect(
      atConfidence.uncertainty.confidenceInterval95HalfWidth,
    ).not.toBeNull();
    expect(
      atConfidence.uncertainty.confidenceInterval95HalfWidth ?? 0,
    ).toBeGreaterThan(0);

    const large = deriveFor(300, 0.5);
    expect(large.uncertainty.confidenceInterval95HalfWidth ?? 0).toBeLessThan(
      atConfidence.uncertainty.confidenceInterval95HalfWidth ?? 0,
    );
  });

  it("respects an explicit minimum sample override", () => {
    const events = Array.from({ length: 5 }, (_, index) =>
      event({ id: `o-${index}`, campaignId: "campaign-override" }),
    );
    const bucket = bucketOf(
      deriveOutcomeAnalytics({
        events,
        generatedAt: now,
        minimumSampleForRates: 5,
      }),
      "campaign",
      "campaign-override",
    );

    expect(bucket.appliedRate).toBe(1);
  });

  it("orders buckets deterministically: dimension-major, sample descending, ties by key", () => {
    const events: OutcomeEvent[] = [
      ...Array.from({ length: 12 }, (_, index) =>
        event({
          id: `ord-a-${index}`,
          campaignId: "campaign-a",
          sourceTargetId: "zeta",
        }),
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        event({
          id: `ord-b-${index}`,
          campaignId: "campaign-b",
          sourceTargetId: "zeta",
        }),
      ),
    ];
    const overview = deriveOutcomeAnalytics({ events, generatedAt: now });

    expect(overview.buckets[0]!.dimension).toBe("campaign");
    expect(overview.buckets[0]!.key).toBe("campaign-a");
    expect(overview.buckets[1]!.key).toBe("campaign-b");
    expect(overview.buckets[1]!.dimension).toBe("campaign");

    const sources = overview.buckets.filter((b) => b.dimension === "source");
    expect(sources.map((b) => b.key)).toEqual(["zeta"]);
  });

  it("groups outcomes by their saved source and names the unknown rest", () => {
    // The recorded source enum has one value, so the source dimension was a
    // single bucket holding every outcome ever recorded.
    const events = [
      event({ id: "s-1", sourceTargetId: "target_boards" }),
      event({ id: "s-2", sourceTargetId: "target_boards" }),
      event({ id: "s-3", sourceTargetId: "target_company" }),
      event({ id: "s-4" }),
    ];
    const overview = deriveOutcomeAnalytics({ events, generatedAt: now });
    const sources = overview.buckets.filter((b) => b.dimension === "source");

    expect(sources.map((b) => b.key)).toEqual([
      "target_boards",
      "target_company",
      UNKNOWN_JOB_SOURCE_BUCKET_KEY,
    ]);
    // Nothing is hidden: the buckets still add up to the events recorded.
    expect(sources.reduce((total, b) => total + b.sampleSize, 0)).toBe(
      events.length,
    );
  });

  it("breaks equal-sample ties by key ascending", () => {
    const events = [
      event({ id: "tie-1", sourceTargetId: "zeta" }),
      event({ id: "tie-2", sourceTargetId: "alpha" }),
      event({ id: "tie-3", sourceTargetId: "alpha" }),
    ];
    const overview = deriveOutcomeAnalytics({ events, generatedAt: now });
    const sources = overview.buckets.filter((b) => b.dimension === "source");

    expect(sources.map((b) => b.key)).toEqual(["alpha", "zeta"]);
  });

  it("returns an empty overview for no events", () => {
    const overview = deriveOutcomeAnalytics({ events: [], generatedAt: now });

    expect(overview.buckets).toEqual([]);
    expect(overview.generatedAt).toBe(now);
  });

  it("defaults derived suggestions to hidden and disabled", () => {
    const overview = deriveOutcomeAnalytics({
      events: Array.from({ length: 12 }, (_, index) =>
        event({ id: `d-${index}`, campaignId: "campaign-defaults" }),
      ),
      generatedAt: now,
    });
    const bucket = bucketOf(overview, "campaign", "campaign-defaults");

    expect(bucket.suggestion).toEqual({
      enabled: false,
      kind: "none",
      label: null,
      reason: null,
      disabledByUser: false,
      resetRequested: false,
      lastResetAt: null,
    });
  });

  it("derives a campaign increase_volume suggestion only at the confidence sample with at least a 20% interview rate", () => {
    const belowTarget = deriveOutcomeAnalytics({
      events: Array.from({ length: 30 }, (_, index) =>
        event({
          id: `iv-${index}`,
          campaignId: "campaign-interviews",
          jobId: `iv-job-${index}`,
          outcome: index < 5 ? "interview" : "rejected",
        }),
      ),
      generatedAt: now,
    });
    expect(
      bucketOf(belowTarget, "campaign", "campaign-interviews").suggestion,
    ).toMatchObject({ enabled: false, kind: "none" });

    const atTarget = deriveOutcomeAnalytics({
      events: Array.from({ length: 30 }, (_, index) =>
        event({
          id: `iv2-${index}`,
          campaignId: "campaign-interviews",
          jobId: `iv2-job-${index}`,
          outcome: index < 10 ? "interview" : "rejected",
        }),
      ),
      generatedAt: now,
    });
    const atTargetSuggestion = bucketOf(
      atTarget,
      "campaign",
      "campaign-interviews",
    ).suggestion;
    expect(atTargetSuggestion).toMatchObject({
      enabled: true,
      kind: "increase_volume",
      label: "Increase volume for campaign-interviews",
      disabledByUser: false,
      resetRequested: false,
      lastResetAt: null,
    });
    expect(atTargetSuggestion.reason).toContain("33%");
  });

  it("keeps suggestions hidden below the confidence sample even with favorable rates", () => {
    const overview = deriveOutcomeAnalytics({
      events: Array.from({ length: 20 }, (_, index) =>
        event({
          id: `sm-${index}`,
          campaignId: "campaign-small-sample",
          jobId: `sm-job-${index}`,
          outcome: index < 15 ? "interview" : "rejected",
        }),
      ),
      generatedAt: now,
    });

    expect(
      bucketOf(overview, "campaign", "campaign-small-sample").suggestion,
    ).toMatchObject({
      enabled: false,
      kind: "none",
      disabledByUser: false,
      resetRequested: false,
    });
  });

  it("suggests pausing a source only when its response rate plus Wilson half-width is below the global baseline", () => {
    const slowSource = Array.from({ length: 30 }, (_, index) =>
      event({
        id: `slow-${index}`,
        sourceTargetId: "slow-source",
        jobId: `slow-job-${index}`,
        outcome: index < 2 ? "employer_response" : "applied",
      }),
    );
    const healthySource = Array.from({ length: 30 }, (_, index) =>
      event({
        id: `ok-${index}`,
        sourceTargetId: "healthy-source",
        jobId: `ok-job-${index}`,
        outcome: index < 25 ? "employer_response" : "applied",
      }),
    );
    const overview = deriveOutcomeAnalytics({
      events: [...slowSource, ...healthySource],
      generatedAt: now,
    });

    const slowSourceSuggestion = bucketOf(
      overview,
      "source",
      "slow-source",
    ).suggestion;
    expect(slowSourceSuggestion).toMatchObject({
      enabled: true,
      kind: "pause_source",
      label: "Pause source slow-source",
      disabledByUser: false,
      resetRequested: false,
    });
    expect(slowSourceSuggestion.reason).toContain("45%");
    expect(
      bucketOf(overview, "source", "healthy-source").suggestion,
    ).toMatchObject({ enabled: false, kind: "none" });
  });

  it("maps pause-or-switch suggestions to their dimension kind", () => {
    const build = (dimension: OutcomeBucketDimension, key: string) => {
      const stale = Array.from({ length: 30 }, (_, index) =>
        event({
          id: `${dimension}-stale-${index}`,
          jobId: `${dimension}-stale-job-${index}`,
          sourceTargetId: "healthy-source",
          company: "Healthy Corp",
          jobTitle: "Healthy Engineer",
          outcome: index < 2 ? "employer_response" : "applied",
          ...(dimension === "source" ? { sourceTargetId: key } : {}),
          ...(dimension === "company" ? { company: key } : {}),
          ...(dimension === "job_title" ? { jobTitle: key } : {}),
          ...(dimension === "resume_strategy" ? { resumeStrategyId: key } : {}),
        }),
      );
      const healthy = Array.from({ length: 30 }, (_, index) =>
        event({
          id: `${dimension}-healthy-${index}`,
          jobId: `${dimension}-healthy-job-${index}`,
          sourceTargetId: "other-source",
          company: "Other Corp",
          jobTitle: "Other Engineer",
          outcome: index < 25 ? "employer_response" : "applied",
        }),
      );
      return deriveOutcomeAnalytics({
        events: [...stale, ...healthy],
        generatedAt: now,
      });
    };

    expect(
      bucketOf(build("source", "stale-source"), "source", "stale-source")
        .suggestion,
    ).toMatchObject({ enabled: true, kind: "pause_source" });
    expect(
      bucketOf(
        build("job_title", "Stale Engineer"),
        "job_title",
        "Stale Engineer",
      ).suggestion,
    ).toMatchObject({ enabled: true, kind: "pause_job_title" });
    expect(
      bucketOf(build("company", "Stale Corp"), "company", "Stale Corp")
        .suggestion,
    ).toMatchObject({ enabled: true, kind: "pause_company" });
    expect(
      bucketOf(
        build("resume_strategy", "strategy-stale"),
        "resume_strategy",
        "strategy-stale",
      ).suggestion,
    ).toMatchObject({ enabled: true, kind: "switch_resume_strategy" });
  });

  it("preserves a user disable across re-derivation with new events", () => {
    const initialEvents = Array.from({ length: 30 }, (_, index) =>
      event({
        id: `pres-${index}`,
        campaignId: "campaign-preserve",
        jobId: `pres-job-${index}`,
        outcome: index < 10 ? "interview" : "rejected",
      }),
    );
    const initialOverview = deriveOutcomeAnalytics({
      events: initialEvents,
      generatedAt: now,
    });
    expect(
      bucketOf(initialOverview, "campaign", "campaign-preserve").suggestion
        .enabled,
    ).toBe(true);

    const disabled = disableOutcomeSuggestion({
      state: JobFinderIntelligenceStateSchema.parse({
        outcomeAnalytics: initialOverview,
        updatedAt: now,
      }),
      dimension: "campaign",
      key: "campaign-preserve",
      now: later,
    });
    expect(disabled.outcomeAnalytics?.buckets[0]!.suggestion).toMatchObject({
      enabled: false,
      disabledByUser: true,
    });

    const rederived = deriveOutcomeAnalytics({
      events: [
        ...initialEvents,
        event({
          id: "pres-extra",
          jobId: "pres-job-extra",
          campaignId: "campaign-preserve",
          outcome: "interview",
        }),
      ],
      generatedAt: later,
      previousOverview: disabled.outcomeAnalytics,
    });
    expect(
      bucketOf(rederived, "campaign", "campaign-preserve").suggestion,
    ).toEqual({
      enabled: false,
      kind: "none",
      label: null,
      reason: null,
      disabledByUser: true,
      resetRequested: false,
      lastResetAt: null,
    });
  });

  it("consumes a reset on re-derivation and re-evaluates the suggestion", () => {
    const events = Array.from({ length: 30 }, (_, index) =>
      event({
        id: `rst-${index}`,
        campaignId: "campaign-reset",
        jobId: `rst-job-${index}`,
        outcome: index < 10 ? "interview" : "rejected",
      }),
    );
    const initialOverview = deriveOutcomeAnalytics({
      events,
      generatedAt: now,
    });
    const reset = resetOutcomeSuggestion({
      state: JobFinderIntelligenceStateSchema.parse({
        outcomeAnalytics: initialOverview,
        updatedAt: now,
      }),
      dimension: "campaign",
      key: "campaign-reset",
      now: later,
    });
    expect(reset.outcomeAnalytics?.buckets[0]!.suggestion).toMatchObject({
      enabled: false,
      resetRequested: true,
      lastResetAt: later,
      disabledByUser: false,
    });

    const rederived = deriveOutcomeAnalytics({
      events,
      generatedAt: later,
      previousOverview: reset.outcomeAnalytics,
    });
    const resetSuggestion = bucketOf(
      rederived,
      "campaign",
      "campaign-reset",
    ).suggestion;
    expect(resetSuggestion).toMatchObject({
      enabled: true,
      kind: "increase_volume",
      label: "Increase volume for campaign-reset",
      disabledByUser: false,
      resetRequested: false,
      lastResetAt: later,
    });
    expect(resetSuggestion.reason).toContain("33%");
  });

  it("turns a previously enabled suggestion off when the data stops supporting it", () => {
    const supporting = Array.from({ length: 30 }, (_, index) =>
      event({
        id: `data-${index}`,
        campaignId: "campaign-data",
        jobId: `data-job-${index}`,
        outcome: index < 10 ? "interview" : "rejected",
      }),
    );
    const first = deriveOutcomeAnalytics({
      events: supporting,
      generatedAt: now,
    });
    expect(
      bucketOf(first, "campaign", "campaign-data").suggestion.enabled,
    ).toBe(true);

    const diluted = [
      ...supporting,
      ...Array.from({ length: 30 }, (_, index) =>
        event({
          id: `data2-${index}`,
          campaignId: "campaign-data",
          jobId: `data2-job-${index}`,
          outcome: "rejected",
        }),
      ),
    ];
    const second = deriveOutcomeAnalytics({
      events: diluted,
      generatedAt: later,
      previousOverview: first,
    });
    expect(
      bucketOf(second, "campaign", "campaign-data").suggestion,
    ).toMatchObject({
      enabled: false,
      kind: "none",
      disabledByUser: false,
      resetRequested: false,
      lastResetAt: null,
    });
  });

  it("schema-validates every emitted bucket", () => {
    const overview = deriveOutcomeAnalytics({
      events: Array.from({ length: 12 }, (_, index) =>
        event({
          id: `v-${index}`,
          campaignId: "campaign-valid",
          outcome: index % 3 === 0 ? "offer" : "applied",
        }),
      ),
      generatedAt: now,
    });

    expect(OutcomeAnalyticsOverviewSchema.safeParse(overview).success).toBe(
      true,
    );
    for (const bucket of overview.buckets) {
      expect(OutcomeAnalyticsBucketSchema.safeParse(bucket).success).toBe(true);
    }
  });
});

describe("suggestion disable/reset", () => {
  const enabledSuggestionOverview = (): OutcomeAnalyticsOverview =>
    OutcomeAnalyticsOverviewSchema.parse({
      generatedAt: now,
      buckets: [
        {
          dimension: "campaign",
          key: "campaign-1",
          label: "campaign-1",
          sampleSize: 12,
          outcomeCounts: { offer: 3, applied: 12 },
          rateNumerators: {
            applied: 12,
            response: 3,
            interview: 3,
            offer: 3,
          },
          appliedRate: 1,
          responseRate: 0.25,
          interviewRate: 0.25,
          offerRate: 0.25,
          uncertainty: {
            level: "medium",
            minimumSampleForConfidence: 30,
            confidenceInterval95HalfWidth: 0.1,
          },
          suggestion: {
            enabled: true,
            kind: "pause_company",
            label: "Pause Acme",
            reason: "Repeated stale listings",
            disabledByUser: false,
            resetRequested: false,
            lastResetAt: null,
          },
          updatedAt: now,
        },
      ],
    });

  it("disables a suggestion immutably with a clean payload", () => {
    const original = JobFinderIntelligenceStateSchema.parse({
      outcomeAnalytics: enabledSuggestionOverview(),
      updatedAt: now,
    });
    const next = disableOutcomeSuggestion({
      state: original,
      dimension: "campaign",
      key: "campaign-1",
      now: later,
    });

    expect(original.outcomeAnalytics?.buckets[0]!.suggestion).toEqual(
      expect.objectContaining({ enabled: true, kind: "pause_company" }),
    );
    expect(next.outcomeAnalytics?.buckets[0]!.suggestion).toEqual({
      enabled: false,
      kind: "none",
      label: null,
      reason: null,
      disabledByUser: true,
      resetRequested: false,
      lastResetAt: null,
    });
    expect(next.outcomeAnalytics?.buckets[0]!.updatedAt).toBe(later);
    expect(next.updatedAt).toBe(later);
    expect(next).not.toBe(original);
  });

  it("resets a suggestion immutably and requests re-derivation", () => {
    const original = JobFinderIntelligenceStateSchema.parse({
      outcomeAnalytics: enabledSuggestionOverview(),
      updatedAt: now,
    });
    const next = resetOutcomeSuggestion({
      state: original,
      dimension: "campaign",
      key: "campaign-1",
      now: later,
    });

    expect(next.outcomeAnalytics?.buckets[0]!.suggestion).toEqual({
      enabled: false,
      kind: "none",
      label: null,
      reason: null,
      disabledByUser: false,
      resetRequested: true,
      lastResetAt: later,
    });
    expect(next.outcomeAnalytics?.buckets[0]!.updatedAt).toBe(later);
    expect(next.updatedAt).toBe(later);
  });

  it("is a safe no-op when analytics are absent or the bucket is missing", () => {
    const empty = state();
    expect(
      disableOutcomeSuggestion({
        state: empty,
        dimension: "campaign",
        key: "campaign-1",
        now: later,
      }),
    ).toBe(empty);

    const withOverview = JobFinderIntelligenceStateSchema.parse({
      outcomeAnalytics: enabledSuggestionOverview(),
      updatedAt: now,
    });
    expect(
      resetOutcomeSuggestion({
        state: withOverview,
        dimension: "company",
        key: "missing-company",
        now: later,
      }),
    ).toBe(withOverview);
  });

  it("keeps disable and reset idempotent and mutually consistent", () => {
    const original = JobFinderIntelligenceStateSchema.parse({
      outcomeAnalytics: enabledSuggestionOverview(),
      updatedAt: now,
    });

    const disabled = disableOutcomeSuggestion({
      state: original,
      dimension: "campaign",
      key: "campaign-1",
      now: later,
    });
    const disabledAgain = disableOutcomeSuggestion({
      state: disabled,
      dimension: "campaign",
      key: "campaign-1",
      now: later,
    });
    expect(disabledAgain).toEqual(disabled);

    const resetAfterDisable = resetOutcomeSuggestion({
      state: disabled,
      dimension: "campaign",
      key: "campaign-1",
      now: later,
    });
    expect(resetAfterDisable.outcomeAnalytics?.buckets[0]!.suggestion).toEqual(
      expect.objectContaining({
        disabledByUser: false,
        resetRequested: true,
      }),
    );

    const disabledAfterReset = disableOutcomeSuggestion({
      state: resetAfterDisable,
      dimension: "campaign",
      key: "campaign-1",
      now: later,
    });
    expect(disabledAfterReset.outcomeAnalytics?.buckets[0]!.suggestion).toEqual(
      expect.objectContaining({
        disabledByUser: true,
        resetRequested: false,
        enabled: false,
      }),
    );
  });
});
