import { describe, expect, test } from "vitest";

import {
  CampaignRuleSchema,
  SavedJobSchema,
  type CampaignRule,
  type CampaignRuleField,
  type CampaignRuleKind,
  type CampaignRuleOperator,
  type NormalizedCompensation,
  type SavedJob,
} from "@nestor/contracts";

import {
  estimateCampaignFunnel,
  evaluateCampaignRules,
} from "./campaign-rule-evaluator";

const recordedAt = "2026-08-15T10:00:00.000Z";
const measuredAt = "2026-08-15T12:00:00.000Z";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createRule(input: {
  id: string;
  kind: CampaignRuleKind;
  field: CampaignRuleField;
  operator: CampaignRuleOperator;
  value: string;
  numericValue?: number | null;
  currency?: string | null;
  enabled?: boolean;
}): CampaignRule {
  return CampaignRuleSchema.parse({
    id: input.id,
    kind: input.kind,
    field: input.field,
    operator: input.operator,
    value: input.value,
    numericValue: input.numericValue ?? null,
    currency: input.currency ?? null,
    enabled: input.enabled ?? true,
    provenance: { source: "user", recordedAt },
  });
}

interface CreateJobInput {
  id: string;
  title?: string;
  company?: string;
  location?: string;
  workMode?: readonly string[];
  seniority?: string | null;
  employmentType?: string | null;
  salaryText?: string | null;
  normalizedCompensation?: Partial<NormalizedCompensation>;
  description?: string;
  score?: number;
  requiresSecurityClearance?: boolean | null;
  sponsorshipText?: string | null;
  keywordSignals?: SavedJob["keywordSignals"];
}

function createJob(input: CreateJobInput): SavedJob {
  return SavedJobSchema.parse({
    source: "target_site",
    sourceJobId: input.id.replace(/^job_/, ""),
    canonicalUrl: `https://example.com/jobs/${input.id}`,
    title: input.title ?? "Software Engineer",
    company: input.company ?? "Example Corp",
    location: input.location ?? "Berlin, Germany",
    workMode: input.workMode ?? ["onsite"],
    applyPath: "easy_apply",
    easyApplyEligible: true,
    discoveredAt: "2026-08-15T09:00:00.000Z",
    salaryText: input.salaryText ?? null,
    normalizedCompensation: input.normalizedCompensation ?? {},
    description: input.description ?? "Build products.",
    seniority: input.seniority ?? null,
    employmentType: input.employmentType ?? null,
    screeningHints: {
      sponsorshipText: input.sponsorshipText ?? null,
      requiresSecurityClearance: input.requiresSecurityClearance ?? null,
      relocationText: null,
      travelText: null,
      remoteGeographies: [],
      requiresConsentInterrupt: null,
      requiresConsentInterruptKind: null,
    },
    keywordSignals: input.keywordSignals ?? [],
    id: input.id,
    status: "discovered",
    matchAssessment: {
      scorerVersion: 1,
      contextFingerprint: null,
      postingFingerprint: null,
      score: input.score ?? 60,
      compensationFit: {},
      dimensions: {},
      reasons: [],
      gaps: [],
      recommendation: "review_before_applying",
      recommendationRationale: "Review the listing before applying.",
      requirements: [],
    },
    provenance: [],
    discoveryFeedback: null,
    resumeApplicationMode: null,
    latestMatchAssessmentAudit: null,
  });
}

type JobOverrides = Omit<CreateJobInput, "id">;

const frontendEngineer = (id: string, overrides: Partial<JobOverrides> = {}) =>
  createJob({ id, title: "Frontend Engineer", ...overrides });

// ---------------------------------------------------------------------------
// must_have / never / prefer semantics
// ---------------------------------------------------------------------------

describe("evaluateCampaignRules", () => {
  test("must_have removes confirmed mismatches and keeps confirmed matches", () => {
    const rule = createRule({
      id: "rule_role_frontend",
      kind: "must_have",
      field: "role",
      operator: "contains",
      value: "frontend",
    });
    const jobs = [
      frontendEngineer("job_a"),
      createJob({ id: "job_b", title: "Backend Engineer" }),
      frontendEngineer("job_c"),
    ];

    const [result] = evaluateCampaignRules({ rules: [rule], jobs, measuredAt });
    expect(result).toBeDefined();
    expect(result!.effect).toEqual({
      sampleSize: 3,
      removedCount: 1,
      downgradedCount: 0,
      unknownCount: 0,
      measuredAt,
    });
    expect(result!.keptCount).toBe(2);
    expect(result!.jobOutcomes).toEqual([
      { jobId: "job_a", outcome: "kept" },
      { jobId: "job_b", outcome: "removed" },
      { jobId: "job_c", outcome: "kept" },
    ]);
  });

  test("never removes confirmed matches and keeps confirmed non-matches", () => {
    const rule = createRule({
      id: "rule_never_company",
      kind: "never",
      field: "company",
      operator: "equals",
      value: "Acme Corp",
    });
    const jobs = [
      createJob({ id: "job_a", company: "Acme Corp" }),
      createJob({ id: "job_b", company: "Beta Inc" }),
    ];

    const [result] = evaluateCampaignRules({ rules: [rule], jobs, measuredAt });
    expect(result!.effect).toEqual({
      sampleSize: 2,
      removedCount: 1,
      downgradedCount: 0,
      unknownCount: 0,
      measuredAt,
    });
    expect(result!.jobOutcomes).toEqual([
      { jobId: "job_a", outcome: "removed" },
      { jobId: "job_b", outcome: "kept" },
    ]);
  });

  test("prefer downgrades confirmed mismatches and never removes", () => {
    const rule = createRule({
      id: "rule_prefer_work_mode",
      kind: "prefer",
      field: "work_mode",
      operator: "in_list",
      value: "remote, hybrid",
    });
    const jobs = [
      createJob({ id: "job_remote", workMode: ["remote"] }),
      createJob({ id: "job_onsite", workMode: ["onsite"] }),
    ];

    const [result] = evaluateCampaignRules({ rules: [rule], jobs, measuredAt });
    expect(result!.effect).toEqual({
      sampleSize: 2,
      removedCount: 0,
      downgradedCount: 1,
      unknownCount: 0,
      measuredAt,
    });
    expect(result!.keptCount).toBe(2);
    expect(result!.jobOutcomes).toEqual([
      { jobId: "job_remote", outcome: "kept" },
      { jobId: "job_onsite", outcome: "downgraded" },
    ]);
  });

  test("never fabricates missing evidence: unknown outcomes stay unknown", () => {
    const rule = createRule({
      id: "rule_must_seniority",
      kind: "must_have",
      field: "seniority",
      operator: "equals",
      value: "Senior",
    });
    const jobs = [
      createJob({ id: "job_senior", seniority: "Senior" }),
      createJob({ id: "job_lead", seniority: "Lead" }),
      createJob({ id: "job_unlisted", seniority: null }),
    ];

    const [result] = evaluateCampaignRules({ rules: [rule], jobs, measuredAt });
    expect(result!.effect).toEqual({
      sampleSize: 3,
      removedCount: 1,
      downgradedCount: 0,
      unknownCount: 1,
      measuredAt,
    });
    expect(result!.jobOutcomes).toEqual([
      { jobId: "job_senior", outcome: "kept" },
      { jobId: "job_lead", outcome: "removed" },
      { jobId: "job_unlisted", outcome: "unknown" },
    ]);
    // The unknown job is retained (never removed on unverified evidence).
    expect(result!.keptCount).toBe(2);
  });

  test("distinguishes hard exclusion from ranking downgrade", () => {
    const mustHave = createRule({
      id: "rule_must_role",
      kind: "must_have",
      field: "role",
      operator: "contains",
      value: "frontend",
    });
    const prefer = createRule({
      id: "rule_prefer_mode",
      kind: "prefer",
      field: "work_mode",
      operator: "equals",
      value: "remote",
    });
    const jobs = [
      frontendEngineer("job_ok"),
      createJob({ id: "job_wrong_role", title: "Backend Engineer" }),
      createJob({
        id: "job_onsite",
        title: "Frontend Engineer",
        workMode: ["onsite"],
      }),
    ];

    const [mustResult, preferResult] = evaluateCampaignRules({
      rules: [mustHave, prefer],
      jobs,
      measuredAt,
    });
    expect(mustResult!.effect).toMatchObject({
      removedCount: 1,
      downgradedCount: 0,
    });
    expect(preferResult!.effect).toMatchObject({
      removedCount: 0,
      // Every sample job defaults to onsite work mode, so the prefer rule
      // downgrades all of them instead of removing any.
      downgradedCount: 3,
    });
  });

  test("ignores disabled rules and preserves rule order for enabled ones", () => {
    const first = createRule({
      id: "rule_first",
      kind: "must_have",
      field: "role",
      operator: "contains",
      value: "frontend",
    });
    const disabled = createRule({
      id: "rule_disabled",
      kind: "never",
      field: "company",
      operator: "equals",
      value: "Acme Corp",
      enabled: false,
    });
    const last = createRule({
      id: "rule_last",
      kind: "must_have",
      field: "location",
      operator: "contains",
      value: "Berlin",
    });
    const jobs = [frontendEngineer("job_a")];

    const results = evaluateCampaignRules({
      rules: [first, disabled, last],
      jobs,
      measuredAt,
    });
    expect(results.map((result) => result.rule.id)).toEqual([
      "rule_first",
      "rule_last",
    ]);
  });

  test("preserves source-generic rules whose field has no job evidence", () => {
    const industryRule = createRule({
      id: "rule_industry",
      kind: "must_have",
      field: "industry",
      operator: "equals",
      value: "Fintech",
    });
    const jobs = [
      createJob({ id: "job_a" }),
      createJob({ id: "job_b" }),
      createJob({
        id: "job_c",
        keywordSignals: [
          { id: "sig_1", label: "Fintech", kind: "industry", weight: 3 },
        ],
      }),
    ];

    const [result] = evaluateCampaignRules({
      rules: [industryRule],
      jobs,
      measuredAt,
    });
    // The rule is preserved with its identity and reports an honest unknown
    // sample instead of guessing an industry from prose.
    expect(result!.rule.id).toBe("rule_industry");
    expect(result!.effect).toEqual({
      sampleSize: 3,
      removedCount: 0,
      downgradedCount: 0,
      unknownCount: 2,
      measuredAt,
    });
    expect(result!.jobOutcomes).toEqual([
      { jobId: "job_a", outcome: "unknown" },
      { jobId: "job_b", outcome: "unknown" },
      { jobId: "job_c", outcome: "kept" },
    ]);
  });

  test("returns a zeroed effect without measuredAt for an empty sample", () => {
    const rule = createRule({
      id: "rule_role",
      kind: "must_have",
      field: "role",
      operator: "contains",
      value: "frontend",
    });

    const [result] = evaluateCampaignRules({
      rules: [rule],
      jobs: [],
      measuredAt,
    });
    expect(result!.effect).toEqual({
      sampleSize: 0,
      removedCount: 0,
      downgradedCount: 0,
      unknownCount: 0,
      measuredAt: null,
    });
    expect(result!.keptCount).toBe(0);
    expect(result!.jobOutcomes).toEqual([]);
  });

  test("measured effect counts never exceed the sample size", () => {
    const rules = [
      createRule({
        id: "rule_must_role",
        kind: "must_have",
        field: "role",
        operator: "contains",
        value: "frontend",
      }),
      createRule({
        id: "rule_prefer_mode",
        kind: "prefer",
        field: "work_mode",
        operator: "equals",
        value: "remote",
      }),
      createRule({
        id: "rule_must_seniority",
        kind: "must_have",
        field: "seniority",
        operator: "equals",
        value: "Senior",
      }),
    ];
    const jobs = [
      frontendEngineer("job_a"),
      createJob({ id: "job_b", title: "Backend Engineer" }),
      createJob({ id: "job_c", seniority: null }),
    ];

    const results = evaluateCampaignRules({ rules, jobs, measuredAt });
    for (const result of results) {
      const { effect } = result;
      expect(
        effect.removedCount + effect.downgradedCount + effect.unknownCount,
      ).toBeLessThanOrEqual(effect.sampleSize);
    }
  });
});

// ---------------------------------------------------------------------------
// Field-specific evidence
// ---------------------------------------------------------------------------

describe("field evidence evaluation", () => {
  test("compensation greater_than_or_equal uses the real listing floor", () => {
    const rule = createRule({
      id: "rule_comp",
      kind: "prefer",
      field: "compensation",
      operator: "greater_than_or_equal",
      value: "120000",
      numericValue: 120_000,
      currency: "USD",
    });
    const jobs = [
      createJob({
        id: "job_meets",
        normalizedCompensation: {
          currency: "USD",
          interval: "year",
          minAmount: 130_000,
          maxAmount: 150_000,
        },
      }),
      createJob({
        id: "job_below",
        normalizedCompensation: {
          currency: "USD",
          interval: "year",
          minAmount: 100_000,
          maxAmount: 120_000,
        },
      }),
      createJob({ id: "job_no_evidence" }),
      createJob({
        id: "job_foreign_currency",
        normalizedCompensation: {
          currency: "EUR",
          interval: "year",
          minAmount: 130_000,
          maxAmount: 150_000,
        },
      }),
    ];

    const [result] = evaluateCampaignRules({ rules: [rule], jobs, measuredAt });
    expect(result!.effect).toEqual({
      sampleSize: 4,
      removedCount: 0,
      downgradedCount: 1,
      unknownCount: 2,
      measuredAt,
    });
    expect(result!.jobOutcomes).toEqual([
      { jobId: "job_meets", outcome: "kept" },
      { jobId: "job_below", outcome: "downgraded" },
      { jobId: "job_no_evidence", outcome: "unknown" },
      // Foreign-currency evidence is never converted by assumption.
      { jobId: "job_foreign_currency", outcome: "unknown" },
    ]);
  });

  test("compensation less_than_or_equal never fabricates a missing ceiling", () => {
    const rule = createRule({
      id: "rule_comp_cap",
      kind: "prefer",
      field: "compensation",
      operator: "less_than_or_equal",
      value: "200000",
      numericValue: 200_000,
      currency: "USD",
    });
    const jobs = [
      createJob({
        id: "job_under_cap",
        normalizedCompensation: {
          currency: "USD",
          interval: "year",
          minAmount: 150_000,
          maxAmount: 180_000,
        },
      }),
      createJob({
        id: "job_over_cap",
        normalizedCompensation: {
          currency: "USD",
          interval: "year",
          minAmount: 150_000,
          maxAmount: 250_000,
        },
      }),
      createJob({
        id: "job_floor_only",
        normalizedCompensation: {
          currency: "USD",
          interval: "year",
          minAmount: 150_000,
          maxAmount: null,
        },
      }),
    ];

    const [result] = evaluateCampaignRules({ rules: [rule], jobs, measuredAt });
    expect(result!.jobOutcomes).toEqual([
      { jobId: "job_under_cap", outcome: "kept" },
      { jobId: "job_over_cap", outcome: "downgraded" },
      { jobId: "job_floor_only", outcome: "unknown" },
    ]);
  });

  test("travel percentage rules parse real listing evidence only", () => {
    const rule = createRule({
      id: "rule_travel",
      kind: "must_have",
      field: "travel",
      operator: "greater_than_or_equal",
      value: "20",
      numericValue: 20,
    });
    const jobs = [
      createJob({
        id: "job_25pct",
        description: "This role requires 25% travel to client sites.",
      }),
      createJob({
        id: "job_10pct",
        description: "This role includes 10% travel.",
      }),
      createJob({ id: "job_no_travel", description: "Fully remote role." }),
    ];

    const [result] = evaluateCampaignRules({ rules: [rule], jobs, measuredAt });
    expect(result!.effect).toEqual({
      sampleSize: 3,
      removedCount: 1,
      downgradedCount: 0,
      unknownCount: 1,
      measuredAt,
    });
    expect(result!.jobOutcomes).toEqual([
      { jobId: "job_25pct", outcome: "kept" },
      { jobId: "job_10pct", outcome: "removed" },
      { jobId: "job_no_travel", outcome: "unknown" },
    ]);
  });

  test("clearance rules use the real screening hint", () => {
    const rule = createRule({
      id: "rule_clearance",
      kind: "must_have",
      field: "clearance",
      operator: "equals",
      value: "true",
    });
    const jobs = [
      createJob({ id: "job_cleared", requiresSecurityClearance: true }),
      createJob({ id: "job_uncleared", requiresSecurityClearance: false }),
      createJob({ id: "job_unknown", requiresSecurityClearance: null }),
    ];

    const [result] = evaluateCampaignRules({ rules: [rule], jobs, measuredAt });
    expect(result!.jobOutcomes).toEqual([
      { jobId: "job_cleared", outcome: "kept" },
      { jobId: "job_uncleared", outcome: "removed" },
      { jobId: "job_unknown", outcome: "unknown" },
    ]);
  });

  test("in_list and not_in_list match any listed evidence value", () => {
    const jobs = [
      createJob({ id: "job_remote", workMode: ["remote"] }),
      createJob({ id: "job_onsite", workMode: ["onsite"] }),
      createJob({ id: "job_no_mode", workMode: [] }),
    ];
    const inList = createRule({
      id: "rule_in_list",
      kind: "must_have",
      field: "work_mode",
      operator: "in_list",
      value: "remote, hybrid",
    });
    const notInList = createRule({
      id: "rule_not_in_list",
      kind: "must_have",
      field: "work_mode",
      operator: "not_in_list",
      value: "remote, hybrid",
    });

    const [inResult, notInResult] = evaluateCampaignRules({
      rules: [inList, notInList],
      jobs,
      measuredAt,
    });
    expect(inResult!.jobOutcomes).toEqual([
      { jobId: "job_remote", outcome: "kept" },
      { jobId: "job_onsite", outcome: "removed" },
      { jobId: "job_no_mode", outcome: "unknown" },
    ]);
    expect(notInResult!.jobOutcomes).toEqual([
      { jobId: "job_remote", outcome: "removed" },
      { jobId: "job_onsite", outcome: "kept" },
      { jobId: "job_no_mode", outcome: "unknown" },
    ]);
  });

  test("user_exclusion rules target company evidence generically", () => {
    const rule = createRule({
      id: "rule_user_exclusion",
      kind: "never",
      field: "user_exclusion",
      operator: "equals",
      value: "Acme Corp",
    });
    const jobs = [
      createJob({ id: "job_acme", company: "Acme Corp" }),
      createJob({ id: "job_beta", company: "Beta Inc" }),
    ];

    const [result] = evaluateCampaignRules({ rules: [rule], jobs, measuredAt });
    expect(result!.effect).toEqual({
      sampleSize: 2,
      removedCount: 1,
      downgradedCount: 0,
      unknownCount: 0,
      measuredAt,
    });
  });

  test("not_equals and not_contains operators invert the condition", () => {
    const notEquals = createRule({
      id: "rule_not_equals",
      kind: "must_have",
      field: "company",
      operator: "not_equals",
      value: "Acme Corp",
    });
    const notContains = createRule({
      id: "rule_not_contains",
      kind: "must_have",
      field: "role",
      operator: "not_contains",
      value: "senior",
    });
    const jobs = [
      createJob({ id: "job_acme", company: "Acme Corp" }),
      createJob({ id: "job_beta", company: "Beta Inc" }),
      createJob({ id: "job_senior", title: "Senior Frontend Engineer" }),
    ];

    const [notEqualsResult, notContainsResult] = evaluateCampaignRules({
      rules: [notEquals, notContains],
      jobs,
      measuredAt,
    });
    expect(notEqualsResult!.jobOutcomes).toEqual([
      { jobId: "job_acme", outcome: "removed" },
      { jobId: "job_beta", outcome: "kept" },
      { jobId: "job_senior", outcome: "kept" },
    ]);
    expect(notContainsResult!.jobOutcomes).toEqual([
      { jobId: "job_acme", outcome: "kept" },
      { jobId: "job_beta", outcome: "kept" },
      { jobId: "job_senior", outcome: "removed" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Funnel estimation
// ---------------------------------------------------------------------------

describe("estimateCampaignFunnel", () => {
  const funnelRules = [
    createRule({
      id: "rule_must_role",
      kind: "must_have",
      field: "role",
      operator: "contains",
      value: "frontend",
    }),
    createRule({
      id: "rule_never_company",
      kind: "never",
      field: "company",
      operator: "equals",
      value: "Acme Corp",
    }),
    createRule({
      id: "rule_prefer_mode",
      kind: "prefer",
      field: "work_mode",
      operator: "equals",
      value: "remote",
    }),
  ];

  test("derives every funnel count from the actual supplied sample", () => {
    const jobs = [
      // Removed by the never rule (confirmed Acme match).
      createJob({
        id: "job_acme",
        company: "Acme Corp",
        title: "Frontend Engineer",
        workMode: ["remote"],
      }),
      // Removed by the must_have rule (confirmed wrong role).
      createJob({
        id: "job_wrong_role",
        title: "Backend Engineer",
        workMode: ["remote"],
      }),
      // Confirmed retained with the highest score.
      frontendEngineer("job_confirmed_high", {
        workMode: ["remote"],
        score: 90,
      }),
      // Confirmed retained.
      frontendEngineer("job_confirmed", { workMode: ["remote"], score: 80 }),
      // Retained but uncertain: work mode is unlisted.
      frontendEngineer("job_uncertain", { workMode: [], score: 70 }),
      // Retained but downgraded: confirmed onsite mismatch.
      frontendEngineer("job_downgraded", { workMode: ["onsite"], score: 60 }),
    ];

    const funnel = estimateCampaignFunnel({
      rules: funnelRules,
      jobs,
      measuredAt,
    });

    expect(funnel.sampleSize).toBe(6);
    expect(funnel.hardRemovedCount).toBe(2);
    expect(funnel.retainedCount).toBe(4);
    expect(funnel.preferDowngradedCount).toBe(1);
    expect(funnel.uncertainCount).toBe(1);
    expect(funnel.confirmedRetainedCount).toBe(2);
    expect(funnel.measuredAt).toBe(measuredAt);
    // Hard-removed jobs are not part of the ranked funnel.
    expect(funnel.rankedJobIds).toEqual([
      "job_confirmed_high",
      "job_confirmed",
      "job_uncertain",
      "job_downgraded",
    ]);
  });

  test("ranks confirmed above uncertain above downgraded deterministically", () => {
    const jobs = [
      frontendEngineer("job_downgraded_first", {
        workMode: ["onsite"],
        score: 60,
      }),
      frontendEngineer("job_uncertain", { workMode: [], score: 60 }),
      frontendEngineer("job_confirmed_low", {
        workMode: ["remote"],
        score: 30,
      }),
      frontendEngineer("job_confirmed_high", {
        workMode: ["remote"],
        score: 95,
      }),
    ];

    const funnel = estimateCampaignFunnel({
      rules: funnelRules,
      jobs,
      measuredAt,
    });
    // Penalty: confirmed (0) < uncertain (1) < downgraded (2); ties break on
    // match score descending, then job id.
    expect(funnel.rankedJobIds).toEqual([
      "job_confirmed_high",
      "job_confirmed_low",
      "job_uncertain",
      "job_downgraded_first",
    ]);
  });

  test("returns an empty funnel for an empty sample", () => {
    const funnel = estimateCampaignFunnel({
      rules: funnelRules,
      jobs: [],
      measuredAt,
    });
    expect(funnel).toEqual({
      sampleSize: 0,
      hardRemovedCount: 0,
      retainedCount: 0,
      preferDowngradedCount: 0,
      uncertainCount: 0,
      confirmedRetainedCount: 0,
      rankedJobIds: [],
      measuredAt,
    });
  });
});
