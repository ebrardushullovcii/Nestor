import {
  PerformanceBudgetEvaluationSchema,
  type DiscoveryRunRecord,
  type PerformanceBudgetEvaluation,
} from "@nestor/contracts";

type PerformanceBudgetUnit = PerformanceBudgetEvaluation["unit"];

type PerformanceBudgetBase = {
  id: string;
  label: string;
  unit: PerformanceBudgetUnit;
  observed: number;
};

export type PerformanceBudgetInput =
  | (PerformanceBudgetBase & {
      kind: "deterministic_regression";
      baseline: number;
      maxRegressionPercent?: number;
    })
  | (PerformanceBudgetBase & {
      kind: "live_slo";
      limit: number;
      sampleCount: number;
      minimumSamples: number;
    });

function formatValue(value: number, unit: PerformanceBudgetUnit) {
  switch (unit) {
    case "milliseconds":
      return `${Math.round(value)} ms`;
    case "bytes":
      return `${Math.round(value)} bytes`;
    case "percent":
      return `${value.toFixed(1)}%`;
    case "count":
      return `${Math.round(value)}`;
  }
}

export function evaluatePerformanceBudget(
  input: PerformanceBudgetInput,
): PerformanceBudgetEvaluation {
  if (input.kind === "deterministic_regression") {
    const maxRegressionPercent = input.maxRegressionPercent ?? 10;
    const limit = input.baseline * (1 + maxRegressionPercent / 100);
    const regressionPercent =
      input.baseline === 0
        ? null
        : ((input.observed - input.baseline) / input.baseline) * 100;
    const status = input.observed <= limit ? "pass" : "fail";

    return PerformanceBudgetEvaluationSchema.parse({
      id: input.id,
      label: input.label,
      kind: input.kind,
      unit: input.unit,
      status,
      observed: input.observed,
      limit,
      sampleCount: 1,
      minimumSamples: 1,
      regressionPercent,
      detail:
        status === "pass"
          ? `${formatValue(input.observed, input.unit)} is within the ${maxRegressionPercent}% deterministic regression allowance.`
          : `${formatValue(input.observed, input.unit)} exceeds the deterministic limit of ${formatValue(limit, input.unit)}.`,
    });
  }

  const missed = input.observed > input.limit;
  const hasEnoughSamples = input.sampleCount >= input.minimumSamples;
  const status = !missed ? "pass" : hasEnoughSamples ? "fail" : "warning";

  return PerformanceBudgetEvaluationSchema.parse({
    id: input.id,
    label: input.label,
    kind: input.kind,
    unit: input.unit,
    status,
    observed: input.observed,
    limit: input.limit,
    sampleCount: input.sampleCount,
    minimumSamples: input.minimumSamples,
    regressionPercent: null,
    detail:
      status === "pass"
        ? `${formatValue(input.observed, input.unit)} is within the live SLO of ${formatValue(input.limit, input.unit)}.`
        : status === "warning"
          ? `Live SLO missed at ${formatValue(input.observed, input.unit)}, but only ${input.sampleCount} of ${input.minimumSamples} required samples are available.`
          : `${formatValue(input.observed, input.unit)} exceeds the live SLO of ${formatValue(input.limit, input.unit)} across ${input.sampleCount} samples.`,
  });
}

function percentile95(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

export function buildDiscoveryPerformanceBudgetEvaluations(
  runs: readonly DiscoveryRunRecord[],
): PerformanceBudgetEvaluation[] {
  const completedRuns = [
    ...new Map(
      runs
        .filter((run) => run.state === "completed" && run.completedAt !== null)
        .map((run) => [run.id, run] as const),
    ).values(),
  ];

  if (completedRuns.length === 0) {
    return [];
  }

  const timedTargets = completedRuns.flatMap((run) =>
    run.targetExecutions.filter(
      (target) => target.state === "completed" && target.timing !== null,
    ),
  );
  const firstDistinctUsefulJobSamples = completedRuns.flatMap((run) =>
    run.summary.timing?.firstDistinctUsefulJobMs === null ||
    run.summary.timing?.firstDistinctUsefulJobMs === undefined
      ? []
      : [run.summary.timing.firstDistinctUsefulJobMs],
  );
  const apiDurationSamples = timedTargets.flatMap((target) =>
    target.collectionMethod === "api" && target.timing
      ? [target.timing.totalDurationMs]
      : [],
  );
  const browserGapSamples = timedTargets.flatMap((target) =>
    target.collectionMethod !== null &&
    target.collectionMethod !== "api" &&
    target.timing
      ? [target.timing.longestGapMs]
      : [],
  );

  return [
    firstDistinctUsefulJobSamples.length > 0
      ? evaluatePerformanceBudget({
          id: "discovery-first-distinct-useful-job-p95",
          label: "Discovery first distinct useful job p95",
          kind: "live_slo",
          unit: "milliseconds",
          limit: 3_000,
          observed: percentile95(firstDistinctUsefulJobSamples),
          sampleCount: firstDistinctUsefulJobSamples.length,
          minimumSamples: 5,
        })
      : null,
    apiDurationSamples.length > 0
      ? evaluatePerformanceBudget({
          id: "discovery-api-duration-p95",
          label: "API source duration p95",
          kind: "live_slo",
          unit: "milliseconds",
          limit: 5_000,
          observed: percentile95(apiDurationSamples),
          sampleCount: apiDurationSamples.length,
          minimumSamples: 5,
        })
      : null,
    browserGapSamples.length > 0
      ? evaluatePerformanceBudget({
          id: "discovery-browser-gap-p95",
          label: "Browser source longest gap p95",
          kind: "live_slo",
          unit: "milliseconds",
          limit: 30_000,
          observed: percentile95(browserGapSamples),
          sampleCount: browserGapSamples.length,
          minimumSamples: 5,
        })
      : null,
  ].filter((entry): entry is PerformanceBudgetEvaluation => entry !== null);
}
