import { ApplyJobResultSchema } from "@nestor/contracts";
import { deriveVerifiedApplicationFunnel } from "./outcome-analytics-presentation";
import { describe, expect, it } from "vitest";
import {
  type OutcomeAnalyticsOverview,
  type OutcomeBucketDimension,
  type OutcomeEvent,
  OutcomeEventSchema,
} from "@nestor/contracts";
import { UNNAMED_JOB_SOURCE_NAME } from "../../lib/job-source-display-name";
import {
  OUTCOME_VIEW_MINIMUM_SAMPLE_FOR_CONFIDENCE,
  OUTCOME_VIEW_MINIMUM_SAMPLE_FOR_RATES,
  bucketDisplayLabel,
  deriveCampaignScopedOutcomeAnalytics,
  formatRate,
  formatUncertainty,
  outcomeDimensionLabels,
  outcomeEventsForCampaign,
} from "./outcome-analytics-presentation";

const now = "2026-08-15T10:00:00.000Z";

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

function bucketOf(
  overview: OutcomeAnalyticsOverview,
  dimension: OutcomeBucketDimension,
  key: string,
) {
  const bucket = overview.buckets.find(
    (candidate) => candidate.dimension === dimension && candidate.key === key,
  );
  if (!bucket) throw new Error(`Missing ${dimension} bucket for key ${key}`);
  return bucket;
}

describe("deriveCampaignScopedOutcomeAnalytics", () => {
  it("can derive only the active dimension for a scoped view", () => {
    const scoped = deriveCampaignScopedOutcomeAnalytics({
      events: Array.from({ length: 12 }, (_, index) =>
        event({
          id: `active-${index}`,
          source: "source-active",
          campaignId: "campaign-active",
        }),
      ),
      dimensions: ["source"],
      generatedAt: now,
    });

    expect(scoped.buckets).toHaveLength(1);
    expect(scoped.buckets[0]).toMatchObject({
      dimension: "source",
      key: "source-active",
      sampleSize: 12,
    });
  });

  it("scopes source, title, company, and strategy buckets to one campaign", () => {
    const events = [
      ...Array.from({ length: 12 }, (_, index) =>
        event({
          id: `c1-${index}`,
          campaignId: "campaign-a",
          source: "source-x",
          jobTitle: "Engineer",
          company: "Acme",
          resumeStrategyId: "strategy-1",
        }),
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        event({
          id: `c2-${index}`,
          campaignId: "campaign-b",
          source: "source-y",
          jobTitle: "Designer",
          company: "Beta",
          resumeStrategyId: "strategy-2",
        }),
      ),
    ];
    const scoped = deriveCampaignScopedOutcomeAnalytics({
      events: outcomeEventsForCampaign(events, "campaign-a"),
      generatedAt: now,
    });

    expect(bucketOf(scoped, "campaign", "campaign-a").sampleSize).toBe(12);
    expect(
      scoped.buckets.filter((b) => b.dimension === "campaign"),
    ).toHaveLength(1);
    expect(bucketOf(scoped, "source", "source-x").sampleSize).toBe(12);
    expect(scoped.buckets.filter((b) => b.dimension === "source")).toHaveLength(
      1,
    );
    expect(bucketOf(scoped, "job_title", "Engineer").sampleSize).toBe(12);
    expect(bucketOf(scoped, "company", "Acme").sampleSize).toBe(12);
    expect(bucketOf(scoped, "resume_strategy", "strategy-1").sampleSize).toBe(
      12,
    );
  });

  it("keeps rates null below the documented minimum sample (small-sample uncertainty)", () => {
    const events = Array.from({ length: 9 }, (_, index) =>
      event({ id: `s-${index}`, campaignId: "campaign-small" }),
    );
    const bucket = bucketOf(
      deriveCampaignScopedOutcomeAnalytics({ events, generatedAt: now }),
      "campaign",
      "campaign-small",
    );

    expect(bucket.sampleSize).toBe(OUTCOME_VIEW_MINIMUM_SAMPLE_FOR_RATES - 1);
    expect(bucket.responseRate).toBeNull();
    expect(bucket.interviewRate).toBeNull();
    expect(bucket.appliedRate).toBeNull();
    expect(bucket.uncertainty.level).toBe("high");
    expect(bucket.uncertainty.confidenceInterval95HalfWidth).toBeNull();
    expect(formatRate(bucket.responseRate)).toBe("Not enough data");
  });

  it("never fabricates a denominator: sample size is the real event count", () => {
    const events = Array.from({ length: 7 }, (_, index) =>
      event({
        id: `d-${index}`,
        campaignId: "campaign-denominator",
        outcome: index % 2 === 0 ? "applied" : "rejected",
      }),
    );
    const bucket = bucketOf(
      deriveCampaignScopedOutcomeAnalytics({ events, generatedAt: now }),
      "campaign",
      "campaign-denominator",
    );

    expect(bucket.sampleSize).toBe(7);
    const counted = Object.values(bucket.outcomeCounts).reduce(
      (sum, count) => sum + count,
      0,
    );
    expect(counted).toBe(bucket.sampleSize);
    expect(bucket.rateNumerators.applied).toBe(7);
    expect(bucket.rateNumerators.response).toBe(3);
    expect(bucket.appliedRate).toBeNull();
    expect(bucket.responseRate).toBeNull();
  });

  it("ties uncertainty level and the confidence half-width to the sample size", () => {
    const deriveFor = (count: number) =>
      bucketOf(
        deriveCampaignScopedOutcomeAnalytics({
          events: Array.from({ length: count }, (_, index) =>
            event({ id: `u-${index}`, campaignId: "campaign-u" }),
          ),
          generatedAt: now,
        }),
        "campaign",
        "campaign-u",
      );

    expect(deriveFor(29).uncertainty.level).toBe("high");
    expect(deriveFor(29).uncertainty.confidenceInterval95HalfWidth).toBeNull();

    const atConfidence = deriveFor(OUTCOME_VIEW_MINIMUM_SAMPLE_FOR_CONFIDENCE);
    expect(atConfidence.uncertainty.level).toBe("medium");
    expect(
      atConfidence.uncertainty.confidenceInterval95HalfWidth,
    ).not.toBeNull();
    expect(formatUncertainty(atConfidence.uncertainty)).toMatch(/Medium/);

    expect(deriveFor(100).uncertainty.level).toBe("low");
  });

  it("never fabricates a resume-strategy bucket for events without a strategy", () => {
    const events = [
      event({ id: "e1", resumeStrategyId: null }),
      event({ id: "e2", resumeStrategyId: "strategy-1" }),
    ];
    const scoped = deriveCampaignScopedOutcomeAnalytics({
      events,
      generatedAt: now,
    });

    expect(
      scoped.buckets.filter((b) => b.dimension === "resume_strategy"),
    ).toHaveLength(1);
  });

  it("derives conservative suggestions only at the confidence sample", () => {
    const below = deriveCampaignScopedOutcomeAnalytics({
      events: Array.from({ length: 20 }, (_, index) =>
        event({
          id: `iv-${index}`,
          campaignId: "campaign-iv",
          jobId: `iv-job-${index}`,
          outcome: index < 15 ? "interview" : "rejected",
        }),
      ),
      generatedAt: now,
    });
    expect(bucketOf(below, "campaign", "campaign-iv").suggestion.enabled).toBe(
      false,
    );

    const atTarget = deriveCampaignScopedOutcomeAnalytics({
      events: Array.from({ length: 30 }, (_, index) =>
        event({
          id: `iv2-${index}`,
          campaignId: "campaign-iv",
          jobId: `iv2-job-${index}`,
          outcome: index < 10 ? "interview" : "rejected",
        }),
      ),
      generatedAt: now,
    });
    expect(
      bucketOf(atTarget, "campaign", "campaign-iv").suggestion,
    ).toMatchObject({
      enabled: true,
      kind: "increase_volume",
      disabledByUser: false,
      resetRequested: false,
    });
  });

  it("preserves a user disable from the durable overview across scoped derivation", () => {
    const events = Array.from({ length: 30 }, (_, index) =>
      event({
        id: `p-${index}`,
        campaignId: "campaign-p",
        jobId: `p-job-${index}`,
        outcome: index < 10 ? "interview" : "rejected",
      }),
    );
    const disabledOverview: OutcomeAnalyticsOverview = {
      buckets: [
        {
          dimension: "campaign",
          key: "campaign-p",
          label: "campaign-p",
          sampleSize: 30,
          outcomeCounts: { interview: 10, rejected: 20 },
          rateNumerators: {
            applied: 30,
            response: 30,
            interview: 10,
            offer: 0,
          },
          appliedRate: 1,
          responseRate: 1,
          interviewRate: 1 / 3,
          offerRate: 0,
          uncertainty: {
            level: "medium",
            minimumSampleForConfidence: 30,
            confidenceInterval95HalfWidth: 0.1,
          },
          suggestion: {
            enabled: false,
            kind: "none",
            label: null,
            reason: null,
            disabledByUser: true,
            resetRequested: false,
            lastResetAt: null,
          },
          updatedAt: now,
        },
      ],
      generatedAt: now,
    };

    const scoped = deriveCampaignScopedOutcomeAnalytics({
      events,
      generatedAt: now,
      previousOverview: disabledOverview,
    });

    expect(bucketOf(scoped, "campaign", "campaign-p").suggestion).toMatchObject(
      {
        enabled: false,
        disabledByUser: true,
      },
    );
  });

  it("returns an empty overview for an empty event set", () => {
    const scoped = deriveCampaignScopedOutcomeAnalytics({
      events: [],
      generatedAt: now,
    });

    expect(scoped.buckets).toEqual([]);
    expect(scoped.generatedAt).toBe(now);
  });

  it("maps labels through campaign and strategy names without fabricating", () => {
    const scoped = deriveCampaignScopedOutcomeAnalytics({
      events: [
        event({
          id: "l1",
          campaignId: "campaign-1",
          resumeStrategyId: "strategy-1",
        }),
      ],
      generatedAt: now,
    });
    const campaignBucket = bucketOf(scoped, "campaign", "campaign-1");
    const strategyBucket = bucketOf(scoped, "resume_strategy", "strategy-1");
    const sourceBucket = bucketOf(scoped, "source", "example");

    expect(
      bucketDisplayLabel(campaignBucket, {
        campaignName: (id) => (id === "campaign-1" ? "Fall campaign" : null),
        resumeStrategyName: () => null,
      }),
    ).toBe("Fall campaign");
    expect(
      bucketDisplayLabel(strategyBucket, {
        campaignName: () => null,
        resumeStrategyName: (id) =>
          id === "strategy-1" ? "SWE generalist" : null,
      }),
    ).toBe("SWE generalist");
    // A source bucket is keyed by the stored source value; the screen shows a
    // plain name for it and never the stored value itself.
    expect(
      bucketDisplayLabel(sourceBucket, {
        campaignName: () => null,
        resumeStrategyName: () => null,
      }),
    ).toBe(UNNAMED_JOB_SOURCE_NAME);
  });

  it("exposes stable dimension labels", () => {
    expect(outcomeDimensionLabels.campaign).toBe("Search plan");
    expect(outcomeDimensionLabels.source).toBe("Source");
    expect(outcomeDimensionLabels.job_title).toBe("Job title");
    expect(outcomeDimensionLabels.company).toBe("Company");
    expect(outcomeDimensionLabels.resume_strategy).toBe("Resume approach");
  });
});

it("counts two verified sends and one recorded response as a small-sample 50% funnel", () => {
  const results = ["a", "b"].map((jobId) =>
    ApplyJobResultSchema.parse({
      id: jobId,
      runId: "run",
      jobId,
      applicationRecordId: `application-${jobId}`,
      state: "submitted",
      summary: "Sent",
      detail: "Local receipt",
      startedAt: now,
      updatedAt: now,
      privacyReceipt: {
        generatedAt: now,
        lineage: { runId: "run", jobId, resultId: jobId },
        destination: { origin: "https://local.invalid", safePath: "/apply" },
        resume: { source: "original_upload", fileName: "synthetic.pdf" },
        finalSubmitAuthorized: true,
        finalSubmitOccurred: true,
      },
    }),
  );
  const funnel = deriveVerifiedApplicationFunnel({
    results,
    runs: [],
    events: [
      event({
        outcome: "employer_response",
        applicationRecordId: "application-a",
        jobId: "a",
      }),
    ],
  });
  expect(funnel).toEqual({
    sent: 2,
    responses: 1,
    responseRate: 0.5,
    smallSample: true,
  });
});
