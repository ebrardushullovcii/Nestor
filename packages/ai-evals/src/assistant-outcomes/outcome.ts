import { isDeepStrictEqual } from "node:util";
import type { ActionInventoryEntry } from "./inventory";

export type Outcome =
  | "completed"
  | "correctly_blocked"
  | "unsupported"
  | "failed";
export type EvidenceKind =
  | "data"
  | "visible_state"
  | "file"
  | "guard"
  | "unchanged";
export interface OutcomeAssertion {
  label: string;
  kind: EvidenceKind;
  /** The actual read: a visible locator, stored row, exported file or host guard. */
  source: string;
  actual: unknown;
  expected: unknown;
  passed: boolean;
}
export function equalOutcome(
  kind: EvidenceKind,
  label: string,
  source: string,
  actual: unknown,
  expected: unknown,
): OutcomeAssertion {
  return {
    kind,
    label,
    source,
    actual,
    expected,
    passed: isDeepStrictEqual(actual, expected),
  };
}
export interface ObservedAction {
  id: string;
  actionId: string;
  request: string;
  expected: "completed" | "correctly_blocked";
  /** A new person message was observed in the built app after composer submission. */
  throughChat?: boolean;
  assertions: readonly OutcomeAssertion[];
  blockedReason?: string;
  unsupportedReason?: string;
  error?: string;
}
export interface ActionOutcome extends ObservedAction {
  outcome: Outcome;
  passed: boolean;
  failures: string[];
}

/** A tool call, a question or refusal wording is never an outcome assertion. */
export function judgeAction(observation: ObservedAction): ActionOutcome {
  observation = {
    ...observation,
    assertions: observation.assertions.map((assertion) => ({
      ...assertion,
      passed:
        Boolean(assertion.source.trim()) &&
        isDeepStrictEqual(assertion.actual, assertion.expected),
    })),
  };
  const failures: string[] = [];
  if (observation.unsupportedReason)
    return {
      ...observation,
      outcome: "unsupported",
      passed: false,
      failures: [observation.unsupportedReason],
    };
  if (observation.error) failures.push(observation.error);
  if (observation.throughChat !== true)
    failures.push("No request was observed through the built-app chat.");
  if (!observation.assertions.length)
    failures.push("No resulting data, file or visible state was asserted.");
  for (const assertion of observation.assertions) {
    if (!assertion.source.trim())
      failures.push(`${assertion.label}: no evidence source.`);
    // Recompute rather than trusting a supplied pass flag in an evidence artifact.
    if (!isDeepStrictEqual(assertion.actual, assertion.expected))
      failures.push(
        `${assertion.label}: the observed result differs from the expected result.`,
      );
  }
  if (observation.expected === "completed") {
    if (
      !observation.assertions.some((assertion) =>
        ["data", "file", "visible_state"].includes(assertion.kind),
      )
    )
      failures.push(
        "Completion needs a resulting data, file or visible-state assertion.",
      );
  } else {
    if (!observation.blockedReason?.trim())
      failures.push(
        "A correctly blocked case needs its specific precondition and reason.",
      );
    if (!observation.assertions.some((assertion) => assertion.kind === "guard"))
      failures.push("The expected guard was not asserted.");
    if (
      !observation.assertions.some(
        (assertion) => assertion.kind === "unchanged",
      )
    )
      failures.push("The protected state was not checked for changes.");
  }
  return {
    ...observation,
    outcome: failures.length ? "failed" : observation.expected,
    passed: failures.length === 0,
    failures,
  };
}

export interface OutcomeReport {
  inventoryTotal: number;
  exercisedActions: number;
  actions: {
    id: string;
    screen: string;
    action: string;
    outcome: Outcome;
    passed: boolean;
    cases: ActionOutcome[];
  }[];
  excluded: { id: string; action: string; reason: string }[];
  counts: Record<Outcome, number>;
  passed: boolean;
}

/** An unexercised action is a failing eval case, never evidence of an app limitation. */
export function buildOutcomeReport(
  inventory: readonly ActionInventoryEntry[],
  observations: readonly ObservedAction[],
): OutcomeReport {
  const ids = new Set(inventory.map((entry) => entry.id));
  if (ids.size !== inventory.length)
    throw new Error("Duplicate action id in the coverage map.");
  const caseIds = new Set<string>();
  for (const observation of observations) {
    if (!ids.has(observation.actionId))
      throw new Error(
        `Outcome case names an unmapped action: ${observation.actionId}`,
      );
    if (
      inventory.find((entry) => entry.id === observation.actionId)?.coverage
        .kind === "excluded"
    )
      throw new Error(
        `An outcome case cannot silently be excluded: ${observation.actionId}`,
      );
    if (caseIds.has(observation.id))
      throw new Error(`Duplicate outcome case: ${observation.id}`);
    caseIds.add(observation.id);
  }
  const excluded: OutcomeReport["excluded"] = [];
  const actions: OutcomeReport["actions"] = [];
  const counts: OutcomeReport["counts"] = {
    completed: 0,
    correctly_blocked: 0,
    unsupported: 0,
    failed: 0,
  };
  for (const entry of inventory) {
    if (entry.coverage.kind === "excluded") {
      if (!entry.coverage.reason.trim())
        throw new Error(`Excluded action has no reason: ${entry.id}`);
      excluded.push({
        id: entry.id,
        action: entry.action,
        reason: entry.coverage.reason,
      });
      continue;
    }
    const matching = observations.filter(
      (observation) => observation.actionId === entry.id,
    );
    const cases = matching.length
      ? matching.map(judgeAction)
      : [
          judgeAction({
            id: `uncovered.${entry.id}`,
            actionId: entry.id,
            request: entry.action,
            expected: "completed",
            assertions: [],
            error:
              "Not exercised: no outcome case ran for this mapped user action.",
          }),
        ];
    const outcome: Outcome = cases.some((result) => result.outcome === "failed")
      ? "failed"
      : cases.some((result) => result.outcome === "unsupported")
        ? "unsupported"
        : cases.some((result) => result.outcome === "completed")
          ? "completed"
          : "correctly_blocked";
    counts[outcome]++;
    actions.push({
      id: entry.id,
      screen: entry.screen,
      action: entry.action,
      outcome,
      passed: cases.every((result) => result.passed),
      cases,
    });
  }
  return {
    inventoryTotal: inventory.length,
    exercisedActions: new Set(
      observations
        .filter((observation) => observation.throughChat === true)
        .map((observation) => observation.actionId),
    ).size,
    actions,
    excluded,
    counts,
    passed: actions.length > 0 && actions.every((action) => action.passed),
  };
}
