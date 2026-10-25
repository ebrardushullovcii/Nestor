import { describe, expect, test } from "vitest";

import {
  CampaignDigestCountsSchema,
  CampaignDigestFailedSourceSchema,
  CampaignDigestSchema,
  CampaignNotificationCollectionSchema,
  CampaignNotificationSchema,
  CampaignPauseWindowSchema,
  CampaignRuleFunnelEstimateSchema,
  CampaignRuleFunnelProjectionSchema,
  CampaignRuleSchema,
  CampaignRunFactsSchema,
  CampaignScheduleStateSchema,
  CreateCampaignNotificationInputSchema,
  DeleteCampaignRuleInputSchema,
  DeleteJobSearchCampaignInputSchema,
  MarkAllCampaignNotificationsReadInputSchema,
  MarkCampaignNotificationReadInputSchema,
  ProjectCampaignRuleFunnelInputSchema,
  RunCampaignNowInputSchema,
  SaveCampaignRuleInputSchema,
  SaveCampaignRuleRouteInputSchema,
  ToggleCampaignRuleInputSchema,
  campaignRuleOperatorsByField,
} from "./campaign-operations";

const now = "2026-08-15T10:00:00.000Z";
const later = "2026-08-15T11:00:00.000Z";

const userProvenance = {
  source: "user" as const,
  recordedAt: now,
};

describe("campaign rules", () => {
  test("parses a full must_have rule with provenance and measured effect", () => {
    const rule = CampaignRuleSchema.parse({
      id: "rule_role_frontend",
      kind: "must_have",
      field: "role",
      operator: "contains",
      value: "frontend",
      enabled: true,
      provenance: userProvenance,
      effect: {
        sampleSize: 20,
        removedCount: 12,
        downgradedCount: 5,
        unknownCount: 3,
        measuredAt: later,
      },
    });

    expect(rule.kind).toBe("must_have");
    expect(rule.field).toBe("role");
    expect(rule.operator).toBe("contains");
    expect(rule.effect.removedCount).toBe(12);
    expect(rule.effect.sampleSize).toBe(20);
    expect(rule.effect.measuredAt).toBe(later);
  });

  test("parses a compensation rule with numeric and currency value", () => {
    const rule = CampaignRuleSchema.parse({
      id: "rule_comp_min",
      kind: "prefer",
      field: "compensation",
      operator: "greater_than_or_equal",
      value: "120000",
      numericValue: 120_000,
      currency: "USD",
      provenance: userProvenance,
    });

    expect(rule.numericValue).toBe(120_000);
    expect(rule.currency).toBe("USD");
  });

  test("defaults enabled, provenance confidence, effect, and optional values", () => {
    const rule = SaveCampaignRuleInputSchema.parse({
      id: null,
      kind: "never",
      field: "user_exclusion",
      operator: "equals",
      value: "Acme Corp",
      provenance: { source: "learning_suggestion", recordedAt: now },
    });

    expect(rule.id).toBeNull();
    expect(rule.enabled).toBe(true);
    expect(rule.provenance.confidence).toBe(1);
    expect(rule.numericValue).toBeNull();
    expect(rule.currency).toBeNull();
    expect(rule.effect).toEqual({
      sampleSize: 0,
      removedCount: 0,
      downgradedCount: 0,
      unknownCount: 0,
      measuredAt: null,
    });
  });

  test("rejects an operator that is not allowed for the field", () => {
    expect(() =>
      CampaignRuleSchema.parse({
        id: "rule_bad_operator",
        kind: "must_have",
        field: "work_mode",
        operator: "contains",
        value: "remote",
        provenance: userProvenance,
      }),
    ).toThrow();

    expect(campaignRuleOperatorsByField.work_mode).not.toContain("contains");
  });

  test("rejects compensation rules without numeric or currency value", () => {
    expect(() =>
      CampaignRuleSchema.parse({
        id: "rule_comp_missing_number",
        kind: "prefer",
        field: "compensation",
        operator: "greater_than",
        value: "120000",
        provenance: userProvenance,
      }),
    ).toThrow();

    expect(() =>
      CampaignRuleSchema.parse({
        id: "rule_comp_missing_currency",
        kind: "prefer",
        field: "compensation",
        operator: "greater_than",
        value: "120000",
        numericValue: 120_000,
        provenance: userProvenance,
      }),
    ).toThrow();
  });

  test("rejects blank values, bad currency codes, and out-of-range confidence", () => {
    expect(() =>
      CampaignRuleSchema.parse({
        id: "rule_blank_value",
        kind: "must_have",
        field: "role",
        operator: "contains",
        value: "   ",
        provenance: userProvenance,
      }),
    ).toThrow();

    expect(() =>
      CampaignRuleSchema.parse({
        id: "rule_bad_currency",
        kind: "prefer",
        field: "compensation",
        operator: "equals",
        value: "120000",
        numericValue: 120_000,
        currency: "usd",
        provenance: userProvenance,
      }),
    ).toThrow();

    expect(() =>
      CampaignRuleSchema.parse({
        id: "rule_bad_confidence",
        kind: "must_have",
        field: "role",
        operator: "equals",
        value: "Engineer",
        provenance: { source: "user", confidence: 1.5, recordedAt: now },
      }),
    ).toThrow();
  });

  test("rejects unknown rule kinds and fields", () => {
    expect(() =>
      CampaignRuleSchema.parse({
        id: "rule_bad_kind",
        kind: "maybe",
        field: "role",
        operator: "equals",
        value: "Engineer",
        provenance: userProvenance,
      }),
    ).toThrow();

    expect(() =>
      CampaignRuleSchema.parse({
        id: "rule_bad_field",
        kind: "must_have",
        field: "benefits",
        operator: "equals",
        value: "Stock",
        provenance: userProvenance,
      }),
    ).toThrow();
  });

  test("rejects oversized rule values", () => {
    expect(() =>
      CampaignRuleSchema.parse({
        id: "rule_long_value",
        kind: "must_have",
        field: "role",
        operator: "equals",
        value: "a".repeat(501),
        provenance: userProvenance,
      }),
    ).toThrow();
  });

  test("rejects invalid effect counts and measured samples", () => {
    expect(() =>
      CampaignRuleSchema.parse({
        id: "rule_negative_match",
        kind: "must_have",
        field: "role",
        operator: "equals",
        value: "Engineer",
        provenance: userProvenance,
        effect: { removedCount: -1 },
      }),
    ).toThrow();

    expect(() =>
      CampaignRuleSchema.parse({
        id: "rule_zero_sample",
        kind: "must_have",
        field: "role",
        operator: "equals",
        value: "Engineer",
        provenance: userProvenance,
        effect: { sampleSize: -1 },
      }),
    ).toThrow();

    expect(() =>
      CampaignRuleSchema.parse({
        id: "rule_unmeasured",
        kind: "must_have",
        field: "role",
        operator: "equals",
        value: "Engineer",
        provenance: userProvenance,
        effect: { sampleSize: 0, measuredAt: later },
      }),
    ).toThrow();
  });
});


describe("schedule pause windows and run facts", () => {
  test("parses an enabled pause window", () => {
    const window = CampaignPauseWindowSchema.parse({
      id: "pause_holidays",
      startsAt: now,
      endsAt: later,
      reason: "Holiday break",
    });

    expect(window.enabled).toBe(true);
    expect(window.reason).toBe("Holiday break");
  });

  test("rejects a pause window that does not end after it starts", () => {
    expect(() =>
      CampaignPauseWindowSchema.parse({
        id: "pause_invalid",
        startsAt: later,
        endsAt: now,
      }),
    ).toThrow();

    expect(() =>
      CampaignPauseWindowSchema.parse({
        id: "pause_zero_length",
        startsAt: now,
        endsAt: now,
      }),
    ).toThrow();
  });

  test("defaults all persisted next/last run facts", () => {
    const facts = CampaignRunFactsSchema.parse({});

    expect(facts.nextRunAt).toBeNull();
    expect(facts.lastRunAt).toBeNull();
    expect(facts.lastRunOutcome).toBeNull();
    expect(facts.lastRunSummary).toBeNull();
    expect(facts.consecutiveFailures).toBe(0);
  });

  test("rejects negative run facts and invalid timestamps", () => {
    expect(() =>
      CampaignRunFactsSchema.parse({ consecutiveFailures: -1 }),
    ).toThrow();

    expect(() =>
      CampaignRunFactsSchema.parse({ nextRunAt: "not-a-date" }),
    ).toThrow();
  });

  test("parses populated run facts and defaults schedule state", () => {
    const state = CampaignScheduleStateSchema.parse({
      pauseWindows: [
        {
          id: "pause_1",
          startsAt: now,
          endsAt: later,
        },
      ],
      runFacts: {
        nextRunAt: later,
        lastRunAt: now,
        lastRunOutcome: "failed",
        lastRunSummary: "Login blocked",
        consecutiveFailures: 2,
      },
    });

    expect(state.enabled).toBe(false);
    expect(state.updatedAt).toBeNull();
    expect(state.runFacts.lastRunOutcome).toBe("failed");
    expect(state.runFacts.consecutiveFailures).toBe(2);

    const empty = CampaignScheduleStateSchema.parse({});
    expect(empty.pauseWindows).toEqual([]);
    expect(empty.runFacts.consecutiveFailures).toBe(0);
  });
});

describe("campaign digest", () => {
  test("parses a digest with exact counts and typed failed sources", () => {
    const digest = CampaignDigestSchema.parse({
      id: "digest_1",
      campaignId: "campaign_1",
      generatedAt: now,
      counts: {
        new: 3,
        changed: 2,
        reactivated: 1,
        inactive: 0,
        known: 8,
        skipped: 4,
      },
      failedSources: [
        {
          sourceTargetId: "target_linkedin",
          reason: "Login required",
          failedAt: now,
          retryable: true,
        },
        {
          sourceTargetId: "target_workday",
          reason: "Unsupported layout",
          failedAt: later,
        },
      ],
      jobIds: ["job_1", "job_2", "job_3"],
    });

    expect(digest.counts).toEqual({
      new: 3,
      changed: 2,
      reactivated: 1,
      inactive: 0,
      known: 8,
      skipped: 4,
    });
    expect(digest.failedSources).toHaveLength(2);
    expect(digest.failedSources[0]?.retryable).toBe(true);
    expect(digest.failedSources[1]?.retryable).toBe(false);
    expect(digest.jobIds).toEqual(["job_1", "job_2", "job_3"]);
  });

  test("defaults every digest count to zero", () => {
    const counts = CampaignDigestCountsSchema.parse({});

    expect(counts).toEqual({
      new: 0,
      changed: 0,
      reactivated: 0,
      inactive: 0,
      known: 0,
      skipped: 0,
    });

    const digest = CampaignDigestSchema.parse({
      id: "digest_2",
      campaignId: "campaign_1",
      generatedAt: now,
    });

    expect(digest.counts.new).toBe(0);
    expect(digest.failedSources).toEqual([]);
    expect(digest.jobIds).toEqual([]);
  });

  test("rejects negative counts and blank failed-source reasons", () => {
    expect(() => CampaignDigestCountsSchema.parse({ new: -1 })).toThrow();

    expect(() =>
      CampaignDigestSchema.parse({
        id: "digest_bad",
        campaignId: "campaign_1",
        generatedAt: now,
        counts: { skipped: -2 },
      }),
    ).toThrow();

    expect(() =>
      CampaignDigestFailedSourceSchema.parse({
        sourceTargetId: "target_x",
        reason: "   ",
        failedAt: now,
      }),
    ).toThrow();
  });
});

describe("campaign notifications", () => {
  test("parses an unread notification with job and source references", () => {
    const notification = CampaignNotificationSchema.parse({
      id: "notification_1",
      campaignId: "campaign_1",
      kind: "strong_match",
      title: "New shortlist",
      body: "3 jobs were shortlisted.",
      createdAt: now,
      jobId: "job_42",
      sourceTargetId: "target_linkedin",
    });

    expect(notification.unread).toBe(true);
    expect(notification.readAt).toBeNull();
    expect(notification.jobId).toBe("job_42");
    expect(notification.sourceTargetId).toBe("target_linkedin");
  });

  test("parses a read notification with a readAt timestamp", () => {
    const notification = CampaignNotificationSchema.parse({
      id: "notification_2",
      campaignId: "campaign_1",
      kind: "digest_ready",
      title: "Digest ready",
      createdAt: now,
      readAt: later,
      unread: false,
    });

    expect(notification.readAt).toBe(later);
    expect(notification.unread).toBe(false);
  });

  test("rejects inconsistent unread/readAt states", () => {
    expect(() =>
      CampaignNotificationSchema.parse({
        id: "notification_bad_read",
        campaignId: "campaign_1",
        kind: "blocked_work",
        title: "Needs review",
        createdAt: now,
        readAt: later,
      }),
    ).toThrow();

    expect(() =>
      CampaignNotificationSchema.parse({
        id: "notification_bad_unread",
        campaignId: "campaign_1",
        kind: "schedule_paused",
        title: "Run failed",
        createdAt: now,
        unread: false,
      }),
    ).toThrow();
  });

  test("create and mark-read inputs carry the expected defaults", () => {
    const input = CreateCampaignNotificationInputSchema.parse({
      campaignId: "campaign_1",
      kind: "rule_effect_update",
      title: "Effect updated",
      createdAt: now,
    });

    expect(input.body).toBeNull();
    expect(input.jobId).toBeNull();
    expect(input.sourceTargetId).toBeNull();

    const markRead = MarkCampaignNotificationReadInputSchema.parse({
      notificationId: "notification_1",
      readAt: later,
    });

    expect(markRead.notificationId).toBe("notification_1");
    expect(markRead.readAt).toBe(later);

    const markAllRead = MarkAllCampaignNotificationsReadInputSchema.parse({
      readAt: later,
    });
    expect(markAllRead.readAt).toBe(later);
    expect(() =>
      MarkAllCampaignNotificationsReadInputSchema.parse({}),
    ).toThrow();
    expect(() =>
      MarkAllCampaignNotificationsReadInputSchema.parse({
        readAt: later,
        notificationId: "notification_1",
      }),
    ).toThrow();
    expect(() =>
      MarkAllCampaignNotificationsReadInputSchema.parse({
        readAt: "not-a-timestamp",
      }),
    ).toThrow();
  });

  test("run-campaign-now input accepts an optional nullable campaign id", () => {
    expect(RunCampaignNowInputSchema.parse({})).toEqual({});
    expect(
      RunCampaignNowInputSchema.parse({ campaignId: "campaign_1" }),
    ).toEqual({ campaignId: "campaign_1" });
    expect(RunCampaignNowInputSchema.parse({ campaignId: null })).toEqual({
      campaignId: null,
    });
    expect(() => RunCampaignNowInputSchema.parse({ campaignId: "" })).toThrow();
    expect(() => RunCampaignNowInputSchema.parse({ campaignId: 42 })).toThrow();
    expect(() =>
      RunCampaignNowInputSchema.parse({ campaignId: "c", extra: true }),
    ).toThrow();
  });

  test("rejects unknown notification kinds", () => {
    expect(() =>
      CampaignNotificationSchema.parse({
        id: "notification_bad_kind",
        campaignId: "campaign_1",
        kind: "bogus",
        title: "Bad",
        createdAt: now,
      }),
    ).toThrow();
  });

  test("rejects a negative unread count in a collection", () => {
    expect(() =>
      CampaignNotificationCollectionSchema.parse({ unreadCount: -1 }),
    ).toThrow();
  });

  test("collection enforces an exact unread count", () => {
    const collection = CampaignNotificationCollectionSchema.parse({
      notifications: [
        {
          id: "notification_1",
          campaignId: "campaign_1",
          kind: "strong_match",
          title: "Shortlist",
          createdAt: now,
        },
        {
          id: "notification_2",
          campaignId: "campaign_1",
          kind: "digest_ready",
          title: "Digest",
          createdAt: now,
          readAt: later,
          unread: false,
        },
      ],
      unreadCount: 1,
    });

    expect(collection.unreadCount).toBe(1);

    expect(() =>
      CampaignNotificationCollectionSchema.parse({
        notifications: [
          {
            id: "notification_1",
            campaignId: "campaign_1",
            kind: "strong_match",
            title: "Shortlist",
            createdAt: now,
          },
        ],
        unreadCount: 2,
      }),
    ).toThrow();
  });
});

describe("campaign rule mutations and funnel projection", () => {
  const ruleInput = {
    kind: "must_have" as const,
    field: "role" as const,
    operator: "contains" as const,
    value: "frontend",
    provenance: userProvenance,
  };

  test("save route input parses a new rule with an unmeasured effect", () => {
    const input = SaveCampaignRuleRouteInputSchema.parse({
      campaignId: "campaign_1",
      rule: { id: null, ...ruleInput },
    });

    expect(input.campaignId).toBe("campaign_1");
    expect(input.rule.id).toBeNull();
    expect(input.rule.enabled).toBe(true);
    expect(input.rule.effect).toEqual({
      sampleSize: 0,
      removedCount: 0,
      downgradedCount: 0,
      unknownCount: 0,
      measuredAt: null,
    });
  });

  test("save route input round-trips an existing rule id and effect", () => {
    const input = SaveCampaignRuleRouteInputSchema.parse({
      campaignId: "campaign_1",
      rule: {
        ...ruleInput,
        id: "rule_role_frontend",
        effect: {
          sampleSize: 20,
          removedCount: 12,
          downgradedCount: 5,
          unknownCount: 3,
          measuredAt: later,
        },
      },
    });

    expect(input.rule.id).toBe("rule_role_frontend");
    expect(input.rule.effect.removedCount).toBe(12);
  });

  test("delete and toggle inputs require campaign and rule ids", () => {
    expect(
      DeleteCampaignRuleInputSchema.parse({
        campaignId: "campaign_1",
        ruleId: "rule_role_frontend",
      }),
    ).toEqual({ campaignId: "campaign_1", ruleId: "rule_role_frontend" });
    expect(() =>
      DeleteCampaignRuleInputSchema.parse({ campaignId: "campaign_1" }),
    ).toThrow();
    expect(() =>
      DeleteCampaignRuleInputSchema.parse({ ruleId: "rule_role_frontend" }),
    ).toThrow();

    const toggled = ToggleCampaignRuleInputSchema.parse({
      campaignId: "campaign_1",
      ruleId: "rule_role_frontend",
      enabled: false,
    });
    expect(toggled.enabled).toBe(false);
    expect(() =>
      ToggleCampaignRuleInputSchema.parse({
        campaignId: "campaign_1",
        ruleId: "rule_role_frontend",
        enabled: "yes",
      }),
    ).toThrow();
  });

  test("funnel projection input requires a campaign id", () => {
    expect(
      ProjectCampaignRuleFunnelInputSchema.parse({ campaignId: "campaign_1" }),
    ).toEqual({ campaignId: "campaign_1" });
    expect(() => ProjectCampaignRuleFunnelInputSchema.parse({})).toThrow();
  });

  test("delete campaign input requires a non-empty campaign id", () => {
    expect(
      DeleteJobSearchCampaignInputSchema.parse({ campaignId: "campaign_1" }),
    ).toEqual({ campaignId: "campaign_1" });
    expect(() => DeleteJobSearchCampaignInputSchema.parse({})).toThrow();
    expect(() =>
      DeleteJobSearchCampaignInputSchema.parse({ campaignId: "" }),
    ).toThrow();
    expect(() =>
      DeleteJobSearchCampaignInputSchema.parse({
        campaignId: "campaign_1",
        ruleId: "rule_unexpected",
      }),
    ).toThrow();
  });

  test("legacy/default funnel projection defaults every rule surface", () => {
    const projection = CampaignRuleFunnelProjectionSchema.parse({
      campaignId: "campaign_1",
      generatedAt: now,
      rules: [],
      disabledRuleIds: [],
      funnel: {
        sampleSize: 0,
        hardRemovedCount: 0,
        retainedCount: 0,
        preferDowngradedCount: 0,
        uncertainCount: 0,
        confirmedRetainedCount: 0,
        rankedJobIds: [],
        measuredAt: now,
      },
    });

    expect(projection.rules).toEqual([]);
    expect(projection.disabledRuleIds).toEqual([]);
    expect(projection.funnel).toMatchObject({
      sampleSize: 0,
      retainedCount: 0,
      hardRemovedCount: 0,
      preferDowngradedCount: 0,
      uncertainCount: 0,
      confirmedRetainedCount: 0,
      rankedJobIds: [],
    });
  });

  test("funnel estimate accepts measured counts and enforces sample invariants", () => {
    const estimate = CampaignRuleFunnelEstimateSchema.parse({
      sampleSize: 6,
      hardRemovedCount: 4,
      retainedCount: 2,
      preferDowngradedCount: 3,
      uncertainCount: 2,
      confirmedRetainedCount: 11,
      rankedJobIds: ["job_1", "job_2"],
      measuredAt: later,
    });
    expect(estimate.retainedCount).toBe(2);

    expect(() =>
      CampaignRuleFunnelEstimateSchema.parse({
        sampleSize: 20,
        hardRemovedCount: 4,
        retainedCount: 5,
        preferDowngradedCount: 0,
        uncertainCount: 0,
        confirmedRetainedCount: 0,
        rankedJobIds: [],
        measuredAt: later,
      }),
    ).toThrow();
  });

  test("funnel projection rejects a ranked list that does not match retained count", () => {
    expect(() =>
      CampaignRuleFunnelProjectionSchema.parse({
        campaignId: "campaign_1",
        generatedAt: now,
        rules: [],
        disabledRuleIds: [],
        funnel: {
          sampleSize: 2,
          hardRemovedCount: 0,
          retainedCount: 2,
          preferDowngradedCount: 0,
          uncertainCount: 0,
          confirmedRetainedCount: 2,
          rankedJobIds: ["job_1"],
          measuredAt: now,
        },
      }),
    ).toThrow();
  });
});
