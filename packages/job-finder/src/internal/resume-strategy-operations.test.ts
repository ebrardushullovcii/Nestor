import { describe, expect, test } from "vitest";

import {
  JobFinderIntelligenceStateSchema,
  ResumeStrategySchema,
  type JobFinderIntelligenceState,
  type ResumeStrategy,
  type ResumeStrategySelection,
  type SaveResumeStrategyInputData,
} from "@nestor/contracts";
import {
  createResumeStrategy,
  disableResumeStrategy,
  recommendResumeStrategy,
  selectResumeStrategy,
  updateResumeStrategy,
} from "./resume-strategy-operations";

const now = "2026-08-15T10:00:00.000Z";
const later = "2026-08-15T11:00:00.000Z";

function buildStrategy(input: {
  id: string;
  name: string;
  roleFamily: string;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}): ResumeStrategy {
  return ResumeStrategySchema.parse({
    id: input.id,
    name: input.name,
    roleFamily: input.roleFamily,
    baseResumeDocumentId: `document_${input.id}`,
    templateId: "classic_ats",
    headlinePolicy: "fixed",
    skillsPolicy: "base_only",
    coveragePolicy: "base_omissions",
    tailoringStrength: "conservative",
    evidenceBoundaries: {},
    enabled: input.enabled ?? true,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  });
}

function buildState(
  strategies: ResumeStrategy[],
  selections: ResumeStrategySelection[] = [],
): JobFinderIntelligenceState {
  return JobFinderIntelligenceStateSchema.parse({
    resumeStrategies: strategies,
    resumeStrategySelections: selections,
  });
}

const emptyState = buildState([]);

function strategyInput(
  overrides: Partial<SaveResumeStrategyInputData> = {},
): SaveResumeStrategyInputData {
  return {
    name: "Backend engineer",
    roleFamily: "Backend Engineering",
    baseResumeDocumentId: "document_main",
    templateId: "classic_ats",
    headlinePolicy: "fixed",
    skillsPolicy: "base_only",
    coveragePolicy: "base_omissions",
    tailoringStrength: "conservative",
    evidenceBoundaries: {},
    enabled: true,
    ...overrides,
  };
}

describe("createResumeStrategy", () => {
  test("creates a strategy with caller id/time and parses through the immutable schema", () => {
    const result = createResumeStrategy({
      state: emptyState,
      strategyId: "strategy_backend",
      strategy: strategyInput(),
      now,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.strategy.id).toBe("strategy_backend");
    expect(result.strategy.name).toBe("Backend engineer");
    expect(result.strategy.roleFamily).toBe("Backend Engineering");
    expect(result.strategy.baseResumeDocumentId).toBe("document_main");
    expect(result.strategy.templateId).toBe("classic_ats");
    expect(result.strategy.headlinePolicy).toBe("fixed");
    expect(result.strategy.skillsPolicy).toBe("base_only");
    expect(result.strategy.coveragePolicy).toBe("base_omissions");
    expect(result.strategy.tailoringStrength).toBe("conservative");
    expect(result.strategy.enabled).toBe(true);
    expect(result.strategy.createdAt).toBe(now);
    expect(result.strategy.updatedAt).toBe(now);
    expect(result.state.resumeStrategies).toHaveLength(1);
    expect(result.state.updatedAt).toBe(now);
    expect(ResumeStrategySchema.safeParse(result.strategy).success).toBe(true);
  });

  test("never mutates the caller's input", () => {
    const input = Object.freeze(strategyInput());

    const result = createResumeStrategy({
      state: emptyState,
      strategyId: "strategy_backend",
      strategy: input,
      now,
    });

    expect(result.ok).toBe(true);
    expect(input).toEqual(strategyInput());
  });

  test("rejects a duplicate strategy id", () => {
    const result = createResumeStrategy({
      state: buildState([
        buildStrategy({ id: "s1", name: "One", roleFamily: "A" }),
      ]),
      strategyId: "s1",
      strategy: strategyInput(),
      now,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("duplicate_strategy_id");
  });

  test("rejects a duplicate display name even with different casing", () => {
    const result = createResumeStrategy({
      state: buildState([
        buildStrategy({ id: "s1", name: "Backend Engineer", roleFamily: "A" }),
      ]),
      strategyId: "s2",
      strategy: strategyInput({ name: "backend engineer" }),
      now,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("duplicate_strategy_name");
  });

  test("rejects an invalid strategy input", () => {
    const result = createResumeStrategy({
      state: emptyState,
      strategyId: "strategy_backend",
      strategy: strategyInput({ name: "" }),
      now,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_strategy_input");
  });

  test("rejects an invalid strategy id", () => {
    const result = createResumeStrategy({
      state: emptyState,
      strategyId: "   ",
      strategy: strategyInput(),
      now,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_strategy_id");
  });

  test("rejects a non-ISO timestamp", () => {
    const result = createResumeStrategy({
      state: emptyState,
      strategyId: "strategy_backend",
      strategy: strategyInput(),
      now: "not-a-timestamp",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_timestamp");
  });

  test("fails when the resume strategy collection is at capacity", () => {
    const strategies = Array.from({ length: 200 }, (_, index) =>
      buildStrategy({
        id: `s_${index}`,
        name: `Strategy ${index}`,
        roleFamily: `Family ${index}`,
      }),
    );

    const result = createResumeStrategy({
      state: buildState(strategies),
      strategyId: "s_overflow",
      strategy: strategyInput(),
      now,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("strategy_capacity_exceeded");
  });
});

describe("updateResumeStrategy", () => {
  test("replaces mutable fields while preserving id/createdAt and stamping updatedAt", () => {
    const created = createResumeStrategy({
      state: emptyState,
      strategyId: "strategy_backend",
      strategy: strategyInput(),
      now,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = updateResumeStrategy({
      state: created.state,
      strategyId: "strategy_backend",
      strategy: strategyInput({
        name: "Senior backend engineer",
        roleFamily: "Backend Engineering",
        templateId: "modern_split",
        headlinePolicy: "per_job_tailored",
      }),
      now: later,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.strategy.id).toBe("strategy_backend");
    expect(result.strategy.createdAt).toBe(now);
    expect(result.strategy.updatedAt).toBe(later);
    expect(result.strategy.name).toBe("Senior backend engineer");
    expect(result.strategy.templateId).toBe("modern_split");
    expect(result.strategy.headlinePolicy).toBe("per_job_tailored");
    expect(result.state.resumeStrategies).toHaveLength(1);
  });

  test("returns strategy_not_found for an unknown id", () => {
    const result = updateResumeStrategy({
      state: emptyState,
      strategyId: "missing",
      strategy: strategyInput(),
      now,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("strategy_not_found");
  });

  test("update with enabled: false disables the strategy", () => {
    const created = createResumeStrategy({
      state: emptyState,
      strategyId: "strategy_backend",
      strategy: strategyInput(),
      now,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = updateResumeStrategy({
      state: created.state,
      strategyId: "strategy_backend",
      strategy: strategyInput({ enabled: false }),
      now: later,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategy.enabled).toBe(false);
  });

  test("an update that omits enabled re-enables per the input default", () => {
    const created = createResumeStrategy({
      state: emptyState,
      strategyId: "strategy_backend",
      strategy: strategyInput(),
      now,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const disabled = disableResumeStrategy({
      state: created.state,
      strategyId: "strategy_backend",
      now: later,
    });
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(disabled.strategy.enabled).toBe(false);

    const input = strategyInput();
    delete input.enabled;

    const result = updateResumeStrategy({
      state: disabled.state,
      strategyId: "strategy_backend",
      strategy: input,
      now: later,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategy.enabled).toBe(true);
  });
});

describe("disableResumeStrategy", () => {
  test("disables without deleting the strategy", () => {
    const created = createResumeStrategy({
      state: emptyState,
      strategyId: "strategy_backend",
      strategy: strategyInput(),
      now,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = disableResumeStrategy({
      state: created.state,
      strategyId: "strategy_backend",
      now: later,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.state.resumeStrategies).toHaveLength(1);
    expect(result.strategy.enabled).toBe(false);
    expect(result.strategy.name).toBe("Backend engineer");
    expect(result.strategy.updatedAt).toBe(later);
  });

  test("returns strategy_not_found for an unknown id", () => {
    const result = disableResumeStrategy({
      state: emptyState,
      strategyId: "missing",
      now,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("strategy_not_found");
  });

  test("is idempotent for an already-disabled strategy", () => {
    const created = createResumeStrategy({
      state: emptyState,
      strategyId: "strategy_backend",
      strategy: strategyInput(),
      now,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = disableResumeStrategy({
      state: created.state,
      strategyId: "strategy_backend",
      now: later,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = disableResumeStrategy({
      state: first.state,
      strategyId: "strategy_backend",
      now: later,
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.strategy.enabled).toBe(false);
  });
});

describe("selectResumeStrategy", () => {
  test("records a selection with caller id/time and an explicit reason", () => {
    const created = createResumeStrategy({
      state: emptyState,
      strategyId: "strategy_backend",
      strategy: strategyInput(),
      now,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = selectResumeStrategy({
      state: created.state,
      selectionId: "selection_1",
      input: {
        jobId: "job_42",
        campaignId: "campaign_1",
        strategyId: "strategy_backend",
        source: "manual",
        reason: "User picked the backend strategy for this posting.",
      },
      now: later,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.selection.id).toBe("selection_1");
    expect(result.selection.jobId).toBe("job_42");
    expect(result.selection.campaignId).toBe("campaign_1");
    expect(result.selection.strategyId).toBe("strategy_backend");
    expect(result.selection.source).toBe("user");
    expect(result.selection.reason).toBe(
      "User picked the backend strategy for this posting.",
    );
    expect(result.selection.selectedAt).toBe(later);
    expect(result.state.resumeStrategySelections).toHaveLength(1);
    expect(result.state.updatedAt).toBe(later);
  });

  test("maps role_family input source to the rule_match selection source", () => {
    const created = createResumeStrategy({
      state: emptyState,
      strategyId: "strategy_backend",
      strategy: strategyInput(),
      now,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = selectResumeStrategy({
      state: created.state,
      selectionId: "selection_2",
      input: {
        jobId: "job_42",
        campaignId: "campaign_1",
        strategyId: "strategy_backend",
        source: "role_family",
        reason: "Exact role family match.",
      },
      now: later,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection.source).toBe("rule_match");
  });

  test("maps campaign_default input source to the campaign_default selection source", () => {
    const created = createResumeStrategy({
      state: emptyState,
      strategyId: "strategy_backend",
      strategy: strategyInput(),
      now,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = selectResumeStrategy({
      state: created.state,
      selectionId: "selection_3",
      input: {
        jobId: "job_42",
        campaignId: "campaign_1",
        strategyId: "strategy_backend",
        source: "campaign_default",
        reason: "Campaign default strategy.",
      },
      now: later,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection.source).toBe("campaign_default");
  });

  test("rejects selecting a disabled strategy", () => {
    const created = createResumeStrategy({
      state: emptyState,
      strategyId: "strategy_backend",
      strategy: strategyInput(),
      now,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const disabled = disableResumeStrategy({
      state: created.state,
      strategyId: "strategy_backend",
      now: later,
    });
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;

    const result = selectResumeStrategy({
      state: disabled.state,
      selectionId: "selection_4",
      input: {
        jobId: "job_42",
        campaignId: "campaign_1",
        strategyId: "strategy_backend",
        source: "manual",
        reason: "Should not be selectable.",
      },
      now: later,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("strategy_disabled");
  });

  test("rejects selecting an unknown strategy", () => {
    const result = selectResumeStrategy({
      state: emptyState,
      selectionId: "selection_5",
      input: {
        jobId: "job_42",
        campaignId: "campaign_1",
        strategyId: "missing",
        source: "manual",
        reason: "Unknown target.",
      },
      now,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("strategy_not_found");
  });

  test("rejects a duplicate selection id", () => {
    const created = createResumeStrategy({
      state: emptyState,
      strategyId: "strategy_backend",
      strategy: strategyInput(),
      now,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = selectResumeStrategy({
      state: created.state,
      selectionId: "selection_1",
      input: {
        jobId: "job_42",
        campaignId: "campaign_1",
        strategyId: "strategy_backend",
        source: "manual",
        reason: "First selection.",
      },
      now,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = selectResumeStrategy({
      state: first.state,
      selectionId: "selection_1",
      input: {
        jobId: "job_43",
        campaignId: "campaign_1",
        strategyId: "strategy_backend",
        source: "manual",
        reason: "Duplicate id.",
      },
      now: later,
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.failure.code).toBe("duplicate_selection_id");
  });

  test("rejects an empty reason", () => {
    const created = createResumeStrategy({
      state: emptyState,
      strategyId: "strategy_backend",
      strategy: strategyInput(),
      now,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = selectResumeStrategy({
      state: created.state,
      selectionId: "selection_6",
      input: {
        jobId: "job_42",
        campaignId: "campaign_1",
        strategyId: "strategy_backend",
        source: "manual",
        reason: "   ",
      },
      now,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_selection_input");
  });

  test("never mutates the caller's input", () => {
    const created = createResumeStrategy({
      state: emptyState,
      strategyId: "strategy_backend",
      strategy: strategyInput(),
      now,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const input = Object.freeze({
      jobId: "job_42",
      campaignId: "campaign_1",
      strategyId: "strategy_backend",
      source: "manual" as const,
      reason: "Frozen input.",
    });

    const result = selectResumeStrategy({
      state: created.state,
      selectionId: "selection_7",
      input,
      now,
    });

    expect(result.ok).toBe(true);
    expect(input).toEqual({
      jobId: "job_42",
      campaignId: "campaign_1",
      strategyId: "strategy_backend",
      source: "manual",
      reason: "Frozen input.",
    });
  });
});

describe("recommendResumeStrategy", () => {
  test("recommends the single exact enabled roleFamily match", () => {
    const result = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_backend",
          name: "Backend",
          roleFamily: "Backend Engineering",
        }),
        buildStrategy({
          id: "s_frontend",
          name: "Frontend",
          roleFamily: "Frontend Engineering",
        }),
      ]),
      roleFamily: "Backend Engineering",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategyId).toBe("s_backend");
    expect(result.source).toBe("role_family");
  });

  test("does not recommend a disabled strategy with a matching roleFamily", () => {
    const result = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_backend",
          name: "Backend",
          roleFamily: "Backend Engineering",
          enabled: false,
        }),
      ]),
      roleFamily: "Backend Engineering",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategyId).toBeNull();
    expect(result.source).toBe("none");
  });

  test("does not recommend a partial, non-exact roleFamily match", () => {
    const result = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_backend",
          name: "Backend",
          roleFamily: "Backend Engineering",
        }),
      ]),
      roleFamily: "Backend",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategyId).toBeNull();
    expect(result.source).toBe("none");
  });

  test("falls back to the campaign default id when no exact match exists", () => {
    const result = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_default",
          name: "Generalist",
          roleFamily: "General",
        }),
      ]),
      roleFamily: "Data Engineering",
      campaignDefaultResumeStrategyId: "s_default",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategyId).toBe("s_default");
    expect(result.source).toBe("campaign_default");
  });

  test("ignores a campaign default id that is disabled or unknown", () => {
    const disabledDefault = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_default",
          name: "Generalist",
          roleFamily: "General",
          enabled: false,
        }),
      ]),
      roleFamily: "Data Engineering",
      campaignDefaultResumeStrategyId: "s_default",
    });

    expect(disabledDefault.ok).toBe(true);
    if (!disabledDefault.ok) return;
    expect(disabledDefault.strategyId).toBeNull();
    expect(disabledDefault.source).toBe("none");

    const unknownDefault = recommendResumeStrategy({
      state: emptyState,
      roleFamily: "Data Engineering",
      campaignDefaultResumeStrategyId: "missing",
    });

    expect(unknownDefault.ok).toBe(true);
    if (!unknownDefault.ok) return;
    expect(unknownDefault.strategyId).toBeNull();
    expect(unknownDefault.source).toBe("none");
  });

  test("returns null when nothing matches and no usable campaign default is supplied", () => {
    const result = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_frontend",
          name: "Frontend",
          roleFamily: "Frontend Engineering",
        }),
      ]),
      roleFamily: "Data Engineering",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategyId).toBeNull();
    expect(result.source).toBe("none");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test("falls through to the campaign default when multiple enabled strategies match the same roleFamily", () => {
    const result = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_backend_a",
          name: "Backend A",
          roleFamily: "Backend Engineering",
        }),
        buildStrategy({
          id: "s_backend_b",
          name: "Backend B",
          roleFamily: "Backend Engineering",
        }),
        buildStrategy({
          id: "s_default",
          name: "Generalist",
          roleFamily: "General",
        }),
      ]),
      roleFamily: "Backend Engineering",
      campaignDefaultResumeStrategyId: "s_default",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategyId).toBe("s_default");
    expect(result.source).toBe("campaign_default");
    expect(result.reason).toBe(
      "Multiple enabled approaches match role family “Backend Engineering”; using search plan fallback “Generalist”.",
    );
  });

  test("reports a configured-but-unusable fallback truthfully when multiple matches exist", () => {
    const state = buildState([
      buildStrategy({
        id: "s_backend_a",
        name: "Backend A",
        roleFamily: "Backend Engineering",
      }),
      buildStrategy({
        id: "s_backend_b",
        name: "Backend B",
        roleFamily: "Backend Engineering",
      }),
      buildStrategy({
        id: "s_default",
        name: "Generalist",
        roleFamily: "General",
        enabled: false,
      }),
    ]);

    const disabledDefault = recommendResumeStrategy({
      state,
      roleFamily: "Backend Engineering",
      campaignDefaultResumeStrategyId: "s_default",
    });

    expect(disabledDefault.ok).toBe(true);
    if (!disabledDefault.ok) return;
    expect(disabledDefault.strategyId).toBeNull();
    expect(disabledDefault.source).toBe("none");
    expect(disabledDefault.reason).toBe(
      "Multiple enabled approaches match role family “Backend Engineering” and the configured search plan fallback “Generalist” is disabled.",
    );
    // The default is configured, so claiming it was never set would be false.
    expect(disabledDefault.reason).not.toContain(
      "no search plan fallback is set",
    );
    expect(disabledDefault.reason).not.toContain("s_default");

    const unknownDefault = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_backend_a",
          name: "Backend A",
          roleFamily: "Backend Engineering",
        }),
        buildStrategy({
          id: "s_backend_b",
          name: "Backend B",
          roleFamily: "Backend Engineering",
        }),
      ]),
      roleFamily: "Backend Engineering",
      campaignDefaultResumeStrategyId: "s_missing_default",
    });

    expect(unknownDefault.ok).toBe(true);
    if (!unknownDefault.ok) return;
    expect(unknownDefault.strategyId).toBeNull();
    expect(unknownDefault.source).toBe("none");
    expect(unknownDefault.reason).toBe(
      "Multiple enabled approaches match role family “Backend Engineering” and the configured search plan fallback is not available.",
    );
  });

  test("uses the campaign default for an empty roleFamily", () => {
    const result = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_default",
          name: "Generalist",
          roleFamily: "General",
        }),
      ]),
      roleFamily: "   ",
      campaignDefaultResumeStrategyId: "s_default",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategyId).toBe("s_default");
    expect(result.source).toBe("campaign_default");
  });

  test("says no enabled approach matched the job when approaches exist but none match and no fallback is set", () => {
    const result = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_se",
          name: "Software engineering",
          roleFamily: "Software Engineering",
        }),
      ]),
      roleFamily: "",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategyId).toBeNull();
    expect(result.source).toBe("none");
    expect(result.reason).toBe(
      "No enabled approach matched this job and no search plan fallback is set.",
    );
    // The historical false claim must never come back.
    expect(result.reason).not.toMatch(/no enabled strategy exists/i);
  });

  test("names the fallback approach instead of its raw id when the derived job family is unmatched", () => {
    const result = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_se",
          name: "Software engineering",
          roleFamily: "Software Engineering",
        }),
      ]),
      roleFamily: "",
      campaignDefaultResumeStrategyId: "s_se",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategyId).toBe("s_se");
    expect(result.source).toBe("campaign_default");
    expect(result.reason).toBe(
      "No enabled approach matched this job; using search plan fallback “Software engineering”.",
    );
    expect(result.reason).toContain("Software engineering");
    expect(result.reason).not.toContain("s_se");
    expect(result.reason).not.toMatch(/no rolefamily was provided/i);
  });

  test("names the fallback approach for an unmatched explicit family without exposing the raw id", () => {
    const result = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_default",
          name: "Generalist",
          roleFamily: "General",
        }),
      ]),
      roleFamily: "Data Engineering",
      campaignDefaultResumeStrategyId: "s_default",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategyId).toBe("s_default");
    expect(result.source).toBe("campaign_default");
    expect(result.reason).toBe(
      "No enabled approach matched role family “Data Engineering”; using search plan fallback “Generalist”.",
    );
    expect(result.reason).not.toContain("s_default");
  });

  test("reports a persisted-but-disabled fallback truthfully when no approach matches the derived family", () => {
    const result = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_se",
          name: "Software engineering",
          roleFamily: "Software Engineering",
        }),
        buildStrategy({
          id: "s_default",
          name: "Generalist",
          roleFamily: "General",
          enabled: false,
        }),
      ]),
      roleFamily: "Data Engineering",
      campaignDefaultResumeStrategyId: "s_default",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategyId).toBeNull();
    expect(result.source).toBe("none");
    expect(result.reason).toBe(
      "No enabled approach matched role family “Data Engineering” and the configured search plan fallback “Generalist” is disabled.",
    );
    // The default is configured, so claiming it was never set would be false.
    expect(result.reason).not.toContain("no search plan fallback is set");
    expect(result.reason).not.toContain("s_default");
  });

  test("keeps fallback approach names containing quotes unambiguous without exposing raw ids", () => {
    const quotedName = 'The "Closer" approach';

    const usingFallback = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_quoted",
          name: quotedName,
          roleFamily: "General",
        }),
      ]),
      roleFamily: "",
      campaignDefaultResumeStrategyId: "s_quoted",
    });

    expect(usingFallback.ok).toBe(true);
    if (!usingFallback.ok) return;
    expect(usingFallback.strategyId).toBe("s_quoted");
    expect(usingFallback.source).toBe("campaign_default");
    expect(usingFallback.reason).toBe(
      'No enabled approach matched this job; using search plan fallback “The "Closer" approach”.',
    );
    expect(usingFallback.reason).not.toContain("s_quoted");
    // Straight-quote delimiters would blur where the human name ends.
    expect(usingFallback.reason).not.toMatch(/fallback "/);

    const disabledFallback = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_se",
          name: "Software engineering",
          roleFamily: "Software Engineering",
        }),
        buildStrategy({
          id: "s_quoted",
          name: quotedName,
          roleFamily: "General",
          enabled: false,
        }),
      ]),
      roleFamily: "Data Engineering",
      campaignDefaultResumeStrategyId: "s_quoted",
    });

    expect(disabledFallback.ok).toBe(true);
    if (!disabledFallback.ok) return;
    expect(disabledFallback.strategyId).toBeNull();
    expect(disabledFallback.source).toBe("none");
    expect(disabledFallback.reason).toBe(
      'No enabled approach matched role family “Data Engineering” and the configured search plan fallback “The "Closer" approach” is disabled.',
    );
    expect(disabledFallback.reason).not.toContain("s_quoted");
  });

  test("says enabled resume approaches do not exist yet when none are enabled", () => {
    const allDisabled = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_old",
          name: "Legacy",
          roleFamily: "Legacy",
          enabled: false,
        }),
      ]),
      roleFamily: "",
    });

    expect(allDisabled.ok).toBe(true);
    if (!allDisabled.ok) return;
    expect(allDisabled.strategyId).toBeNull();
    expect(allDisabled.source).toBe("none");
    expect(allDisabled.reason).toBe(
      "No enabled resume approaches exist yet and no search plan fallback is set.",
    );

    const noneAtAll = recommendResumeStrategy({
      state: emptyState,
      roleFamily: "Backend Engineering",
    });

    expect(noneAtAll.ok).toBe(true);
    if (!noneAtAll.ok) return;
    expect(noneAtAll.strategyId).toBeNull();
    expect(noneAtAll.source).toBe("none");
    expect(noneAtAll.reason).toBe(
      "No enabled resume approaches exist yet and no search plan fallback is set.",
    );

    // A configured fallback stays configured even while every approach is
    // disabled, so the reason must name it instead of claiming none was set.
    const disabledFallback = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_old",
          name: "Legacy",
          roleFamily: "Legacy",
          enabled: false,
        }),
      ]),
      roleFamily: "",
      campaignDefaultResumeStrategyId: "s_old",
    });

    expect(disabledFallback.ok).toBe(true);
    if (!disabledFallback.ok) return;
    expect(disabledFallback.strategyId).toBeNull();
    expect(disabledFallback.source).toBe("none");
    expect(disabledFallback.reason).toBe(
      "No enabled resume approaches exist yet and the configured search plan fallback “Legacy” is disabled.",
    );
    expect(disabledFallback.reason).not.toContain(
      "no search plan fallback is set",
    );
    expect(disabledFallback.reason).not.toContain("s_old");

    const staleFallback = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_old",
          name: "Legacy",
          roleFamily: "Legacy",
          enabled: false,
        }),
      ]),
      roleFamily: "",
      campaignDefaultResumeStrategyId: "s_missing",
    });

    expect(staleFallback.ok).toBe(true);
    if (!staleFallback.ok) return;
    expect(staleFallback.strategyId).toBeNull();
    expect(staleFallback.source).toBe("none");
    expect(staleFallback.reason).toBe(
      "No enabled resume approaches exist yet and the configured search plan fallback is not available.",
    );
  });

  test("humanizes the exact-match reason label while keeping the recommendation semantics", () => {
    const result = recommendResumeStrategy({
      state: buildState([
        buildStrategy({
          id: "s_backend",
          name: "Backend",
          roleFamily: "Backend Engineering",
        }),
      ]),
      roleFamily: "Backend Engineering",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategyId).toBe("s_backend");
    expect(result.source).toBe("role_family");
    expect(result.reason).toBe(
      "Exact enabled role family match: “Backend Engineering”.",
    );
    // The reason is display text only: humanized wording, never the raw
    // camelCase field name.
    expect(result.reason).toContain("role family");
    expect(result.reason).not.toContain("roleFamily");
  });
});
