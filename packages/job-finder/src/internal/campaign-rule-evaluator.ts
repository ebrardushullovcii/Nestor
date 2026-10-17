import {
  CampaignRuleEffectSchema,
  annualizeCompensationAmount,
  type CampaignRule,
  type CampaignRuleEffect,
  type CampaignRuleField,
  type CampaignRuleKind,
  type CampaignRuleOperator,
  type SavedJob,
} from "@nestor/contracts";

import { normalizeText } from "./shared";

// ---------------------------------------------------------------------------
// Pure campaign-rule evaluation against real discovery-job evidence.
//
// Contract invariants
// -------------------
// - Only `enabled` rules are evaluated. Results preserve the input rule order
//   and rule identity, so a caller can write measured effects back onto the
//   same rule objects without dropping or reordering anything.
// - Hard exclusion is reserved for CONFIRMED violations only:
//     * must_have: a confirmed mismatch removes the job.
//     * never:     a confirmed match removes the job.
// - Ranking downgrade is reserved for CONFIRMED prefer mismatches; a prefer
//   rule never removes a job.
// - Missing or non-comparable evidence is NEVER fabricated. Jobs whose rule
//   field carries no usable evidence land in `unknownCount`; they are kept and
//   only ranked below confirmed matches inside the funnel.
// - Rules are source-generic: evaluation reads only discovery evidence fields
//   every source can produce (JobPosting/SavedJob fields). A rule whose field
//   has no evidence in the sample reports `unknownCount === sampleSize` and is
//   still preserved in the output.
// ---------------------------------------------------------------------------

export type RuleConditionOutcome = "match" | "mismatch" | "unknown";

/** Final per-job disposition for one rule. */
export type RuleDisposition = "removed" | "downgraded" | "kept" | "unknown";

export interface CampaignRuleJobOutcome {
  jobId: string;
  outcome: RuleDisposition;
}

export interface EvaluatedCampaignRule {
  rule: CampaignRule;
  effect: CampaignRuleEffect;
  /** Jobs that survived the rule (sampleSize - removedCount). */
  keptCount: number;
  jobOutcomes: readonly CampaignRuleJobOutcome[];
}

export interface EvaluateCampaignRulesInput {
  rules: readonly CampaignRule[];
  jobs: readonly SavedJob[];
  measuredAt: string;
}

export function evaluateCampaignRules(
  input: EvaluateCampaignRulesInput,
): EvaluatedCampaignRule[] {
  return input.rules
    .filter((rule) => rule.enabled)
    .map((rule) => evaluateRuleAgainstJobs(rule, input.jobs, input.measuredAt));
}

// ---------------------------------------------------------------------------
// Per-rule aggregation
// ---------------------------------------------------------------------------

function evaluateRuleAgainstJobs(
  rule: CampaignRule,
  jobs: readonly SavedJob[],
  measuredAt: string,
): EvaluatedCampaignRule {
  const jobOutcomes: CampaignRuleJobOutcome[] = [];
  let removedCount = 0;
  let downgradedCount = 0;
  let unknownCount = 0;

  for (const job of jobs) {
    const condition = evaluateRuleCondition(rule, job);
    const disposition = dispositionFor(rule.kind, condition);
    jobOutcomes.push({ jobId: job.id, outcome: disposition });

    if (disposition === "removed") {
      removedCount += 1;
    } else if (disposition === "downgraded") {
      downgradedCount += 1;
    } else if (disposition === "unknown") {
      unknownCount += 1;
    }
  }

  const sampleSize = jobs.length;
  // A zero-sample measurement carries no measurement time (CampaignRuleEffect
  // schema requires measuredAt to be null when sampleSize is 0).
  const effect = CampaignRuleEffectSchema.parse({
    sampleSize,
    removedCount,
    downgradedCount,
    unknownCount,
    measuredAt: sampleSize === 0 ? null : measuredAt,
  });

  return {
    rule,
    effect,
    keptCount: sampleSize - removedCount,
    jobOutcomes,
  };
}

function dispositionFor(
  kind: CampaignRuleKind,
  condition: RuleConditionOutcome,
): RuleDisposition {
  if (condition === "unknown") {
    return "unknown";
  }

  if (kind === "must_have") {
    return condition === "mismatch" ? "removed" : "kept";
  }

  if (kind === "never") {
    return condition === "match" ? "removed" : "kept";
  }

  // prefer: confirmed mismatches are downgraded, never removed.
  return condition === "mismatch" ? "downgraded" : "kept";
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

interface FieldEvidence {
  /** Non-empty string evidence extracted verbatim from the job. */
  values: readonly string[];
  /** Conservative floor for numeric comparisons (annualized, comparable). */
  minNumericValue: number | null;
  /** Conservative ceiling for numeric comparisons (annualized, comparable). */
  maxNumericValue: number | null;
  /** Evidence currency when the listing states one (compensation only). */
  currency: string | null;
}

const numericComparableFields: ReadonlySet<CampaignRuleField> = new Set([
  "compensation",
  "travel",
]);

const numericOperators: ReadonlySet<CampaignRuleOperator> = new Set([
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
]);

function evaluateRuleCondition(
  rule: CampaignRule,
  job: SavedJob,
): RuleConditionOutcome {
  const evidence = extractFieldEvidence(job, rule.field);
  if (evidence === null) {
    return "unknown";
  }
  return applyOperator(rule, evidence);
}

function applyOperator(
  rule: CampaignRule,
  evidence: FieldEvidence,
): RuleConditionOutcome {
  if (
    numericComparableFields.has(rule.field) ||
    numericOperators.has(rule.operator)
  ) {
    return evaluateNumericOperator(rule, evidence);
  }
  return evaluateStringOperator(rule, evidence);
}

// --- Field evidence extraction (real job data only, never synthesized) -------

function extractFieldEvidence(
  job: SavedJob,
  field: CampaignRuleField,
): FieldEvidence | null {
  let evidence: FieldEvidence;

  switch (field) {
    case "role":
      evidence = stringEvidence(job.title);
      break;
    case "location":
      evidence = stringEvidence(job.location);
      break;
    case "work_mode":
      evidence = listEvidence(job.workMode);
      break;
    case "company":
      evidence = stringEvidence(job.company);
      break;
    case "industry":
      // Real industry evidence arrives only as explicit job keyword signals of
      // kind "industry"; absence is unknown, never inferred from prose.
      evidence = listEvidence(
        job.keywordSignals
          .filter((signal) => signal.kind === "industry")
          .map((signal) => signal.label),
      );
      break;
    case "seniority":
      evidence = nullableStringEvidence(job.seniority) ?? emptyEvidence();
      break;
    case "employment_type":
      evidence = nullableStringEvidence(job.employmentType) ?? emptyEvidence();
      break;
    case "clearance":
      evidence =
        job.screeningHints.requiresSecurityClearance === null
          ? emptyEvidence()
          : stringEvidence(
              job.screeningHints.requiresSecurityClearance ? "true" : "false",
            );
      break;
    case "sponsorship":
      // sponsorshipText is set only when the listing text explicitly mentions
      // sponsorship or work authorization. Absence is not proof of either
      // direction, so it stays unknown.
      evidence =
        job.screeningHints.sponsorshipText === null
          ? emptyEvidence()
          : stringEvidence(job.screeningHints.sponsorshipText);
      break;
    case "travel": {
      const percent = extractTravelPercent(job);
      evidence =
        percent === null
          ? emptyEvidence()
          : {
              values: [`${percent}%`],
              minNumericValue: percent,
              maxNumericValue: percent,
              currency: null,
            };
      break;
    }
    case "compensation": {
      const compensation = job.normalizedCompensation;
      if (compensation.minAmount === null && compensation.maxAmount === null) {
        evidence = emptyEvidence();
        break;
      }
      if (compensation.interval === null) {
        // Amounts exist but the interval is unknown, so nothing can be
        // annualized or compared without inventing an assumption.
        evidence = emptyEvidence();
        break;
      }
      const annualize = (amount: number) =>
        annualizeCompensationAmount(amount, compensation.interval!);
      evidence = {
        values: [],
        minNumericValue:
          compensation.minAmount === null
            ? null
            : annualize(compensation.minAmount),
        maxNumericValue:
          compensation.maxAmount === null
            ? null
            : annualize(compensation.maxAmount),
        currency: compensation.currency,
      };
      break;
    }
    case "user_exclusion":
      // Source-generic user exclusions target the job's company evidence.
      evidence = stringEvidence(job.company);
      break;
    default:
      evidence = emptyEvidence();
      break;
  }

  if (
    evidence.values.length === 0 &&
    evidence.minNumericValue === null &&
    evidence.maxNumericValue === null
  ) {
    return null;
  }
  return evidence;
}

function emptyEvidence(): FieldEvidence {
  return {
    values: [],
    minNumericValue: null,
    maxNumericValue: null,
    currency: null,
  };
}

function stringEvidence(value: string): FieldEvidence {
  const trimmed = value.trim();
  return {
    values: trimmed ? [trimmed] : [],
    minNumericValue: null,
    maxNumericValue: null,
    currency: null,
  };
}

function nullableStringEvidence(value: string | null): FieldEvidence | null {
  return value && value.trim() ? stringEvidence(value) : null;
}

function listEvidence(values: readonly string[]): FieldEvidence {
  return {
    values: values
      .map((value) => value.trim())
      .filter((value): value is string => value.length > 0),
    minNumericValue: null,
    maxNumericValue: null,
    currency: null,
  };
}

const travelPercentPattern =
  /\b(\d{1,3})\s*%\s*(?:travel|overnight travel|travel time|travelling|traveling)\b/iu;

function extractTravelPercent(job: SavedJob): number | null {
  const evidence = [
    job.description,
    job.summary,
    ...job.minimumQualifications,
    ...job.preferredQualifications,
  ].filter((value): value is string => typeof value === "string");

  for (const value of evidence) {
    const match = travelPercentPattern.exec(value);
    if (!match?.[1]) {
      continue;
    }
    const percent = Number.parseInt(match[1], 10);
    if (Number.isFinite(percent)) {
      return Math.min(100, percent);
    }
  }

  return null;
}

// --- Operator evaluation ----------------------------------------------------

function evaluateNumericOperator(
  rule: CampaignRule,
  evidence: FieldEvidence,
): RuleConditionOutcome {
  const required = rule.numericValue;
  if (required === null) {
    return "unknown";
  }

  if (rule.field === "compensation" && rule.currency !== evidence.currency) {
    // No exchange-rate or unspecified-currency assumptions are ever made.
    return "unknown";
  }

  switch (rule.operator) {
    case "greater_than":
    case "greater_than_or_equal": {
      if (evidence.minNumericValue === null) {
        // The listing's floor is unknown; a ceiling alone cannot prove it.
        return "unknown";
      }
      const matches =
        rule.operator === "greater_than"
          ? evidence.minNumericValue > required
          : evidence.minNumericValue >= required;
      return matches ? "match" : "mismatch";
    }
    case "less_than":
    case "less_than_or_equal": {
      if (evidence.maxNumericValue === null) {
        // The listing's ceiling is unknown; a floor alone cannot prove it.
        return "unknown";
      }
      const matches =
        rule.operator === "less_than"
          ? evidence.maxNumericValue < required
          : evidence.maxNumericValue <= required;
      return matches ? "match" : "mismatch";
    }
    case "equals": {
      const minimum = evidence.minNumericValue;
      const maximum = evidence.maxNumericValue;
      if (minimum === null && maximum === null) {
        return "unknown";
      }
      if (minimum !== null && maximum !== null) {
        return minimum === required && maximum === required
          ? "match"
          : "mismatch";
      }
      return (minimum ?? maximum) === required ? "match" : "mismatch";
    }
    default:
      return "unknown";
  }
}

function evaluateStringOperator(
  rule: CampaignRule,
  evidence: FieldEvidence,
): RuleConditionOutcome {
  if (evidence.values.length === 0) {
    return "unknown";
  }

  const listItems = splitListValue(rule.value);
  const anyValueEqualsRule = evidence.values.some(
    (value) => normalizeText(value) === normalizeText(rule.value),
  );
  const anyValueContainsRule = evidence.values.some((value) =>
    containsNormalizedPhrase(value, rule.value),
  );
  const anyValueInList = evidence.values.some((value) =>
    listItems.some((item) => normalizeText(item) === normalizeText(value)),
  );

  switch (rule.operator) {
    case "equals":
      return anyValueEqualsRule ? "match" : "mismatch";
    case "not_equals":
      return anyValueEqualsRule ? "mismatch" : "match";
    case "contains":
      return anyValueContainsRule ? "match" : "mismatch";
    case "not_contains":
      return anyValueContainsRule ? "mismatch" : "match";
    case "in_list":
      return anyValueInList ? "match" : "mismatch";
    case "not_in_list":
      return anyValueInList ? "mismatch" : "match";
    default:
      return "unknown";
  }
}

function splitListValue(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is string => part.length > 0);
}

function containsNormalizedPhrase(value: string, phrase: string): boolean {
  const normalizedValue = ` ${normalizeText(value)} `;
  const normalizedPhrase = normalizeText(phrase);
  return (
    normalizedPhrase.length > 0 &&
    normalizedValue.includes(` ${normalizedPhrase} `)
  );
}

// ---------------------------------------------------------------------------
// Funnel estimate (derived only from the actual supplied job sample)
// ---------------------------------------------------------------------------

export interface EstimateCampaignFunnelInput {
  rules: readonly CampaignRule[];
  jobs: readonly SavedJob[];
  measuredAt: string;
}

export interface CampaignFunnelEstimate {
  sampleSize: number;
  /** Jobs removed by confirmed must_have / never violations. */
  hardRemovedCount: number;
  /** Jobs that survived hard rules (sampleSize - hardRemovedCount). */
  retainedCount: number;
  /** Retained jobs downgraded by at least one confirmed prefer mismatch. */
  preferDowngradedCount: number;
  /** Retained jobs with at least one rule whose evidence was unknown. */
  uncertainCount: number;
  /** Retained jobs with every rule confirmed (no downgrade, no unknown). */
  confirmedRetainedCount: number;
  /** Actual ordering of the retained sample: penalty, then score, then id. */
  rankedJobIds: readonly string[];
  /** Timestamp at which this estimate was produced. */
  measuredAt: string;
}

export function estimateCampaignFunnel(
  input: EstimateCampaignFunnelInput,
): CampaignFunnelEstimate {
  const enabledRules = input.rules.filter((rule) => rule.enabled);
  const ranked: Array<{ jobId: string; penalty: number; score: number }> = [];
  let hardRemovedCount = 0;
  let preferDowngradedCount = 0;
  let uncertainCount = 0;

  for (const job of input.jobs) {
    let hardRemoved = false;
    let hardUnknownCount = 0;
    let preferDowngradeCount = 0;
    let preferUnknownCount = 0;

    for (const rule of enabledRules) {
      const condition = evaluateRuleCondition(rule, job);
      if (rule.kind === "must_have") {
        if (condition === "mismatch") {
          hardRemoved = true;
        } else if (condition === "unknown") {
          hardUnknownCount += 1;
        }
      } else if (rule.kind === "never") {
        if (condition === "match") {
          hardRemoved = true;
        } else if (condition === "unknown") {
          hardUnknownCount += 1;
        }
      } else {
        if (condition === "mismatch") {
          preferDowngradeCount += 1;
        } else if (condition === "unknown") {
          preferUnknownCount += 1;
        }
      }
    }

    if (hardRemoved) {
      hardRemovedCount += 1;
      continue;
    }

    // Conservative ordering: an unverifiable hard rule is the biggest risk,
    // then confirmed prefer mismatches, then unverifiable prefer rules.
    const penalty =
      preferDowngradeCount * 2 + hardUnknownCount * 3 + preferUnknownCount * 1;
    if (preferDowngradeCount > 0) {
      preferDowngradedCount += 1;
    }
    if (hardUnknownCount + preferUnknownCount > 0) {
      uncertainCount += 1;
    }
    ranked.push({
      jobId: job.id,
      penalty,
      score: job.matchAssessment.score,
    });
  }

  ranked.sort(
    (left, right) =>
      left.penalty - right.penalty ||
      right.score - left.score ||
      left.jobId.localeCompare(right.jobId),
  );

  const sampleSize = input.jobs.length;
  const retainedCount = sampleSize - hardRemovedCount;
  const confirmedRetainedCount = ranked.filter(
    (entry) => entry.penalty === 0,
  ).length;

  return {
    sampleSize,
    hardRemovedCount,
    retainedCount,
    preferDowngradedCount,
    uncertainCount,
    confirmedRetainedCount,
    rankedJobIds: ranked.map((entry) => entry.jobId),
    measuredAt: input.measuredAt,
  };
}
