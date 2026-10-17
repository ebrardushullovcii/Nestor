import {
  IsoDateTimeSchema,
  JobFinderIntelligenceStateSchema,
  NonEmptyStringSchema,
  ResumeStrategySchema,
  ResumeStrategySelectionSchema,
  SaveResumeStrategyInputSchema,
  SelectResumeStrategyInputSchema,
  type JobFinderIntelligenceState,
  type ResumeStrategy,
  type ResumeStrategySelection,
  type SaveResumeStrategyInput,
  type SaveResumeStrategyInputData,
  type SelectResumeStrategyInput,
} from "@nestor/contracts";

/**
 * Pure, immutable operations over the named resume strategies and resume
 * strategy selections held by `JobFinderIntelligenceState`.
 *
 * Every mutating operation returns a fresh state parsed through
 * `JobFinderIntelligenceStateSchema` and never mutates its inputs. Callers
 * always supply ids and timestamps; the operations never mint ids or clocks.
 * Strategies are created/updated through `ResumeStrategySchema`, whose strict
 * shape deliberately carries no approval or application-readiness flag, so
 * these operations can never set artifact approval/readiness and never read or
 * write resume artifact state (document ids such as `baseResumeDocumentId` are
 * treated as opaque references only).
 */

export type ResumeStrategyOperationFailure =
  | { code: "invalid_state"; message: string }
  | { code: "invalid_timestamp"; message: string }
  | { code: "invalid_strategy_id"; message: string }
  | { code: "invalid_strategy_input"; message: string }
  | { code: "duplicate_strategy_id"; message: string }
  | { code: "duplicate_strategy_name"; message: string }
  | { code: "strategy_not_found"; message: string }
  | { code: "strategy_capacity_exceeded"; message: string }
  | { code: "invalid_selection_id"; message: string }
  | { code: "invalid_selection_input"; message: string }
  | { code: "duplicate_selection_id"; message: string }
  | { code: "selection_capacity_exceeded"; message: string }
  | { code: "strategy_disabled"; message: string };

export type CreateResumeStrategyResult =
  | {
      ok: true;
      state: JobFinderIntelligenceState;
      strategy: ResumeStrategy;
    }
  | { ok: false; failure: ResumeStrategyOperationFailure };

export type UpdateResumeStrategyResult = CreateResumeStrategyResult;
export type DisableResumeStrategyResult = CreateResumeStrategyResult;

export type SelectResumeStrategyResult =
  | {
      ok: true;
      state: JobFinderIntelligenceState;
      selection: ResumeStrategySelection;
    }
  | { ok: false; failure: ResumeStrategyOperationFailure };

export type RecommendResumeStrategyResult =
  | {
      ok: true;
      strategyId: string | null;
      source: "role_family" | "campaign_default" | "none";
      reason: string;
    }
  | { ok: false; failure: ResumeStrategyOperationFailure };

interface ZodIssueLike {
  message?: string;
}

interface ZodErrorLike {
  issues: readonly ZodIssueLike[];
}

function firstIssueMessage(error: ZodErrorLike): string {
  return error.issues[0]?.message ?? "Invalid value.";
}

type ParseResult<T> = { ok: true; data: T } | { ok: false; message: string };

function parseState(
  state: JobFinderIntelligenceState,
): ParseResult<JobFinderIntelligenceState> {
  const parsed = JobFinderIntelligenceStateSchema.safeParse(state);

  if (!parsed.success) {
    return { ok: false, message: firstIssueMessage(parsed.error) };
  }

  return { ok: true, data: parsed.data };
}

function parseId(id: string, label: string): ParseResult<string> {
  const parsed = NonEmptyStringSchema.safeParse(id);

  if (!parsed.success) {
    return { ok: false, message: `${label} must be a non-empty string.` };
  }

  return { ok: true, data: parsed.data };
}

function parseNow(now: string): ParseResult<string> {
  const parsed = IsoDateTimeSchema.safeParse(now);

  if (!parsed.success) {
    return {
      ok: false,
      message: "now must be an ISO 8601 datetime string.",
    };
  }

  return { ok: true, data: parsed.data };
}

function parseStrategyInput(
  input: SaveResumeStrategyInputData,
): ParseResult<SaveResumeStrategyInput> {
  const parsed = SaveResumeStrategyInputSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, message: firstIssueMessage(parsed.error) };
  }

  return { ok: true, data: parsed.data };
}

/**
 * Creates a strategy with the caller-provided `strategyId` and `now`.
 * The input is parsed through `SaveResumeStrategyInputSchema` and the result
 * is re-parsed through the immutable `ResumeStrategySchema`, so the persisted
 * record can never carry extra keys such as approval or readiness flags. Any
 * id carried inside the input is overridden by the explicit caller id.
 */
export function createResumeStrategy(input: {
  state: JobFinderIntelligenceState;
  strategyId: string;
  strategy: SaveResumeStrategyInputData;
  now: string;
}): CreateResumeStrategyResult {
  const stateResult = parseState(input.state);
  if (!stateResult.ok) {
    return {
      ok: false,
      failure: { code: "invalid_state", message: stateResult.message },
    };
  }
  const state = stateResult.data;

  const idResult = parseId(input.strategyId, "Strategy id");
  if (!idResult.ok) {
    return {
      ok: false,
      failure: { code: "invalid_strategy_id", message: idResult.message },
    };
  }

  const inputResult = parseStrategyInput(input.strategy);
  if (!inputResult.ok) {
    return {
      ok: false,
      failure: {
        code: "invalid_strategy_input",
        message: inputResult.message,
      },
    };
  }

  const nowResult = parseNow(input.now);
  if (!nowResult.ok) {
    return {
      ok: false,
      failure: { code: "invalid_timestamp", message: nowResult.message },
    };
  }

  if (
    state.resumeStrategies.some((strategy) => strategy.id === idResult.data)
  ) {
    return {
      ok: false,
      failure: {
        code: "duplicate_strategy_id",
        message: `Strategy id "${idResult.data}" already exists.`,
      },
    };
  }
  if (
    state.resumeStrategies.some(
      (strategy) =>
        strategy.name.trim().toLocaleLowerCase() ===
        inputResult.data.name.trim().toLocaleLowerCase(),
    )
  ) {
    return {
      ok: false,
      failure: {
        code: "duplicate_strategy_name",
        message: `A resume strategy named "${inputResult.data.name}" already exists.`,
      },
    };
  }

  const candidateResult = ResumeStrategySchema.safeParse({
    ...inputResult.data,
    id: idResult.data,
    createdAt: nowResult.data,
    updatedAt: nowResult.data,
  });

  if (!candidateResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_strategy_input",
        message: firstIssueMessage(candidateResult.error),
      },
    };
  }

  const nextStateResult = JobFinderIntelligenceStateSchema.safeParse({
    ...state,
    resumeStrategies: [...state.resumeStrategies, candidateResult.data],
    updatedAt: nowResult.data,
  });

  if (!nextStateResult.success) {
    return {
      ok: false,
      failure: {
        code: "strategy_capacity_exceeded",
        message:
          "Cannot create the strategy: the resume strategy collection is at capacity.",
      },
    };
  }

  const strategy = nextStateResult.data.resumeStrategies.at(-1)!;

  return { ok: true, state: nextStateResult.data, strategy };
}

/**
 * Replaces the mutable fields of an existing strategy with the parsed input.
 * The strategy id and `createdAt` are immutable; `updatedAt` is advanced to
 * the caller-provided `now`. Because `SaveResumeStrategyInput` defaults
 * `enabled` to true, an update that omits `enabled` re-enables the strategy;
 * callers that must keep a strategy disabled should pass `enabled: false`.
 */
export function updateResumeStrategy(input: {
  state: JobFinderIntelligenceState;
  strategyId: string;
  strategy: SaveResumeStrategyInputData;
  now: string;
}): UpdateResumeStrategyResult {
  const stateResult = parseState(input.state);
  if (!stateResult.ok) {
    return {
      ok: false,
      failure: { code: "invalid_state", message: stateResult.message },
    };
  }
  const state = stateResult.data;

  const idResult = parseId(input.strategyId, "Strategy id");
  if (!idResult.ok) {
    return {
      ok: false,
      failure: { code: "invalid_strategy_id", message: idResult.message },
    };
  }

  const inputResult = parseStrategyInput(input.strategy);
  if (!inputResult.ok) {
    return {
      ok: false,
      failure: {
        code: "invalid_strategy_input",
        message: inputResult.message,
      },
    };
  }

  const nowResult = parseNow(input.now);
  if (!nowResult.ok) {
    return {
      ok: false,
      failure: { code: "invalid_timestamp", message: nowResult.message },
    };
  }

  const index = state.resumeStrategies.findIndex(
    (strategy) => strategy.id === idResult.data,
  );

  if (index < 0) {
    return {
      ok: false,
      failure: {
        code: "strategy_not_found",
        message: `No resume strategy exists with id "${idResult.data}".`,
      },
    };
  }

  const existing = state.resumeStrategies[index]!;
  if (
    state.resumeStrategies.some(
      (strategy) =>
        strategy.id !== existing.id &&
        strategy.name.trim().toLocaleLowerCase() ===
          inputResult.data.name.trim().toLocaleLowerCase(),
    )
  ) {
    return {
      ok: false,
      failure: {
        code: "duplicate_strategy_name",
        message: `A resume strategy named "${inputResult.data.name}" already exists.`,
      },
    };
  }

  const candidateResult = ResumeStrategySchema.safeParse({
    ...inputResult.data,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: nowResult.data,
  });

  if (!candidateResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_strategy_input",
        message: firstIssueMessage(candidateResult.error),
      },
    };
  }

  const nextStateResult = JobFinderIntelligenceStateSchema.safeParse({
    ...state,
    resumeStrategies: state.resumeStrategies.map((strategy, strategyIndex) =>
      strategyIndex === index ? candidateResult.data : strategy,
    ),
    updatedAt: nowResult.data,
  });

  if (!nextStateResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_state",
        message: firstIssueMessage(nextStateResult.error),
      },
    };
  }

  const strategy = nextStateResult.data.resumeStrategies[index]!;

  return { ok: true, state: nextStateResult.data, strategy };
}

/**
 * Disables a strategy by flipping `enabled` to false without deleting it.
 * Idempotent: disabling an already-disabled strategy succeeds and only
 * advances `updatedAt` to the caller-provided `now`.
 */
export function disableResumeStrategy(input: {
  state: JobFinderIntelligenceState;
  strategyId: string;
  now: string;
}): DisableResumeStrategyResult {
  const stateResult = parseState(input.state);
  if (!stateResult.ok) {
    return {
      ok: false,
      failure: { code: "invalid_state", message: stateResult.message },
    };
  }
  const state = stateResult.data;

  const idResult = parseId(input.strategyId, "Strategy id");
  if (!idResult.ok) {
    return {
      ok: false,
      failure: { code: "invalid_strategy_id", message: idResult.message },
    };
  }

  const nowResult = parseNow(input.now);
  if (!nowResult.ok) {
    return {
      ok: false,
      failure: { code: "invalid_timestamp", message: nowResult.message },
    };
  }

  const index = state.resumeStrategies.findIndex(
    (strategy) => strategy.id === idResult.data,
  );

  if (index < 0) {
    return {
      ok: false,
      failure: {
        code: "strategy_not_found",
        message: `No resume strategy exists with id "${idResult.data}".`,
      },
    };
  }

  const existing = state.resumeStrategies[index]!;

  const candidateResult = ResumeStrategySchema.safeParse({
    ...existing,
    enabled: false,
    updatedAt: nowResult.data,
  });

  if (!candidateResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_state",
        message: firstIssueMessage(candidateResult.error),
      },
    };
  }

  const nextStateResult = JobFinderIntelligenceStateSchema.safeParse({
    ...state,
    resumeStrategies: state.resumeStrategies.map((strategy, strategyIndex) =>
      strategyIndex === index ? candidateResult.data : strategy,
    ),
    updatedAt: nowResult.data,
  });

  if (!nextStateResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_state",
        message: firstIssueMessage(nextStateResult.error),
      },
    };
  }

  const strategy = nextStateResult.data.resumeStrategies[index]!;

  return { ok: true, state: nextStateResult.data, strategy };
}

// The selection input expresses the requester's source vocabulary
// (campaign_default | role_family | manual) while the persisted selection uses
// the canonical selection vocabulary (user | campaign_default | rule_match).
const selectionSourceFromInput = {
  campaign_default: "campaign_default",
  role_family: "rule_match",
  manual: "user",
} as const;

/**
 * Records a selection of an enabled strategy for a campaign/job using the
 * caller-provided `selectionId` and `now` plus the explicit, inspectable
 * `reason` carried by the input. The referenced strategy must exist and be
 * enabled; the selection is parsed through `ResumeStrategySelectionSchema`
 * before it is appended to the state.
 */
export function selectResumeStrategy(input: {
  state: JobFinderIntelligenceState;
  selectionId: string;
  input: SelectResumeStrategyInput;
  now: string;
}): SelectResumeStrategyResult {
  const stateResult = parseState(input.state);
  if (!stateResult.ok) {
    return {
      ok: false,
      failure: { code: "invalid_state", message: stateResult.message },
    };
  }
  const state = stateResult.data;

  const idResult = parseId(input.selectionId, "Selection id");
  if (!idResult.ok) {
    return {
      ok: false,
      failure: { code: "invalid_selection_id", message: idResult.message },
    };
  }

  const inputResult = SelectResumeStrategyInputSchema.safeParse(input.input);
  if (!inputResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_selection_input",
        message: firstIssueMessage(inputResult.error),
      },
    };
  }

  const nowResult = parseNow(input.now);
  if (!nowResult.ok) {
    return {
      ok: false,
      failure: { code: "invalid_timestamp", message: nowResult.message },
    };
  }

  const strategy = state.resumeStrategies.find(
    (candidate) => candidate.id === inputResult.data.strategyId,
  );

  if (!strategy) {
    return {
      ok: false,
      failure: {
        code: "strategy_not_found",
        message: `No resume strategy exists with id "${inputResult.data.strategyId}".`,
      },
    };
  }

  if (!strategy.enabled) {
    return {
      ok: false,
      failure: {
        code: "strategy_disabled",
        message: `Resume strategy "${strategy.id}" is disabled and cannot be selected.`,
      },
    };
  }

  if (
    state.resumeStrategySelections.some(
      (selection) => selection.id === idResult.data,
    )
  ) {
    return {
      ok: false,
      failure: {
        code: "duplicate_selection_id",
        message: `Selection id "${idResult.data}" already exists.`,
      },
    };
  }

  const selectionResult = ResumeStrategySelectionSchema.safeParse({
    id: idResult.data,
    campaignId: inputResult.data.campaignId,
    jobId: inputResult.data.jobId,
    strategyId: inputResult.data.strategyId,
    source: selectionSourceFromInput[inputResult.data.source],
    reason: inputResult.data.reason,
    selectedAt: nowResult.data,
  });

  if (!selectionResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_selection_input",
        message: firstIssueMessage(selectionResult.error),
      },
    };
  }

  const nextStateResult = JobFinderIntelligenceStateSchema.safeParse({
    ...state,
    resumeStrategySelections: [
      ...state.resumeStrategySelections,
      selectionResult.data,
    ],
    updatedAt: nowResult.data,
  });

  if (!nextStateResult.success) {
    return {
      ok: false,
      failure: {
        code: "selection_capacity_exceeded",
        message:
          "Cannot record the selection: the resume strategy selection collection is at capacity.",
      },
    };
  }

  const selection = nextStateResult.data.resumeStrategySelections.at(-1)!;

  return { ok: true, state: nextStateResult.data, selection };
}

/**
 * Wraps a user-facing label (an approach name or role family) in typographic
 * quotes. Unlike straight quotes, the directional pair stays unambiguous when
 * the label itself contains quote characters. Labels are human names, never
 * internal ids.
 */
function quoteDisplayLabel(value: string): string {
  return `“${value}”`;
}

/**
 * Builds the fallback clause for recommendation reasons that could not use
 * the campaign/search-plan default. Every clause must be truthful about the
 * observed state instead of claiming the fallback was never set:
 *
 * - no default id was supplied -> none was ever set;
 * - the id references a saved but disabled approach -> names that approach;
 * - the id references nothing saved -> the configured fallback is unusable;
 * - a referenced enabled approach would be a usable fallback and never
 *   reaches this clause, so the residual wording claims nothing.
 */
function searchPlanFallbackClause(
  state: JobFinderIntelligenceState,
  campaignDefaultId: string | null,
): string {
  if (campaignDefaultId === null) {
    return "no search plan fallback is set";
  }

  const configured = state.resumeStrategies.find(
    (candidate) => candidate.id === campaignDefaultId,
  );

  if (!configured) {
    return "the configured search plan fallback is not available";
  }

  if (!configured.enabled) {
    return `the configured search plan fallback ${quoteDisplayLabel(configured.name)} is disabled`;
  }

  // An enabled referenced strategy is always usable, so this clause is not
  // reachable on any current path; prefer wording that claims nothing.
  return "no search plan fallback applies";
}

/**
 * Recommends a strategy id for a job's `roleFamily`. A strategy is recommended
 * only when exactly one enabled strategy has an exact `roleFamily` match.
 * Otherwise the supplied campaign default id is used when it references an
 * enabled strategy; otherwise the recommendation is null. Multiple enabled
 * matches for the same roleFamily are treated as ambiguous and fall through to
 * the campaign default, then null.
 *
 * Reasons are user-facing display text and must stay truthful about which
 * state produced them: they name approaches by their human name (never an
 * internal id), say "matched this job" when the job family is unmatched or
 * undetermined, never claim that no enabled strategies exist while enabled
 * ones do, and distinguish an absent search plan fallback from one that is
 * configured but disabled or otherwise unusable.
 */
export function recommendResumeStrategy(input: {
  state: JobFinderIntelligenceState;
  roleFamily: string;
  campaignDefaultResumeStrategyId?: string | null;
}): RecommendResumeStrategyResult {
  const stateResult = parseState(input.state);
  if (!stateResult.ok) {
    return {
      ok: false,
      failure: { code: "invalid_state", message: stateResult.message },
    };
  }
  const state = stateResult.data;

  const roleFamily = input.roleFamily.trim();
  const campaignDefaultId =
    input.campaignDefaultResumeStrategyId?.trim() || null;

  // A usable fallback references an enabled strategy, so whenever any enabled
  // approach exists at all this state is unreachable; keeping it separate lets
  // every later reason truthfully speak about matching instead of existence.
  if (!state.resumeStrategies.some((strategy) => strategy.enabled)) {
    return {
      ok: true,
      strategyId: null,
      source: "none",
      reason: `No enabled resume approaches exist yet and ${searchPlanFallbackClause(state, campaignDefaultId)}.`,
    };
  }

  if (roleFamily !== "") {
    const matches = state.resumeStrategies.filter(
      (strategy) => strategy.enabled && strategy.roleFamily === roleFamily,
    );

    if (matches.length === 1) {
      const strategy = matches[0]!;

      return {
        ok: true,
        strategyId: strategy.id,
        source: "role_family",
        reason: `Exact enabled role family match: ${quoteDisplayLabel(roleFamily)}.`,
      };
    }

    if (matches.length > 1) {
      const defaultStrategy = findEnabledStrategy(state, campaignDefaultId);

      if (defaultStrategy !== null) {
        return {
          ok: true,
          strategyId: defaultStrategy.id,
          source: "campaign_default",
          reason: `Multiple enabled approaches match role family ${quoteDisplayLabel(roleFamily)}; using search plan fallback ${quoteDisplayLabel(defaultStrategy.name)}.`,
        };
      }

      return {
        ok: true,
        strategyId: null,
        source: "none",
        reason: `Multiple enabled approaches match role family ${quoteDisplayLabel(roleFamily)} and ${searchPlanFallbackClause(state, campaignDefaultId)}.`,
      };
    }
  }

  const defaultStrategy = findEnabledStrategy(state, campaignDefaultId);

  if (defaultStrategy !== null) {
    return {
      ok: true,
      strategyId: defaultStrategy.id,
      source: "campaign_default",
      reason:
        roleFamily === ""
          ? `No enabled approach matched this job; using search plan fallback ${quoteDisplayLabel(defaultStrategy.name)}.`
          : `No enabled approach matched role family ${quoteDisplayLabel(roleFamily)}; using search plan fallback ${quoteDisplayLabel(defaultStrategy.name)}.`,
    };
  }

  return {
    ok: true,
    strategyId: null,
    source: "none",
    reason:
      roleFamily === ""
        ? `No enabled approach matched this job and ${searchPlanFallbackClause(state, campaignDefaultId)}.`
        : `No enabled approach matched role family ${quoteDisplayLabel(roleFamily)} and ${searchPlanFallbackClause(state, campaignDefaultId)}.`,
  };
}

function findEnabledStrategy(
  state: JobFinderIntelligenceState,
  strategyId: string | null,
): ResumeStrategy | null {
  if (strategyId === null) {
    return null;
  }

  const strategy = state.resumeStrategies.find(
    (candidate) => candidate.id === strategyId && candidate.enabled,
  );

  return strategy ?? null;
}
