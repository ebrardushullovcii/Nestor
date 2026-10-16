import type { NormalizedCompensation, JobListRow } from "@nordri/contracts";

export function formatNormalizedCompensation(
  compensation: NormalizedCompensation | null | undefined,
): string | null {
  if (!compensation) {
    return null;
  }

  const currencyPrefix = compensation.currency
    ? `${compensation.currency} `
    : "";
  const interval = compensation.interval ? ` / ${compensation.interval}` : "";
  const minAmount =
    compensation.minAmount !== null
      ? `${currencyPrefix}${compensation.minAmount.toLocaleString()}`
      : null;
  const maxAmount =
    compensation.maxAmount !== null
      ? `${currencyPrefix}${compensation.maxAmount.toLocaleString()}`
      : null;
  const directRange =
    minAmount && !maxAmount
      ? `${minAmount}+`
      : minAmount && maxAmount && minAmount === maxAmount
        ? minAmount
        : [minAmount, maxAmount].filter(Boolean).join(" – ");

  if (directRange) {
    return `${directRange}${interval}`;
  }

  const annualizedValues = [
    compensation.minAnnualUsd,
    compensation.maxAnnualUsd,
  ].filter((value): value is number => value !== null);
  const annualizedRange =
    annualizedValues.length === 1 && compensation.maxAnnualUsd === null
      ? `USD ${annualizedValues[0]!.toLocaleString()}+`
      : annualizedValues.map((value) => `USD ${value.toLocaleString()}`).join(" – ");

  return annualizedRange ? `${annualizedRange} annualized` : null;
}

/**
 * The normalized band, but only for a listing that actually stated a salary.
 *
 * A normalized band is a reading of the employer's own words. When a listing
 * publishes no salary there is nothing to read, and any band still attached to
 * the record came from somewhere else — which is how identical figures no
 * employer had published appeared on several jobs at once. Callers render the
 * absence label instead.
 */
export function formatStatedNormalizedCompensation(
  job: Pick<JobListRow, "salaryText" | "normalizedCompensation"> | null | undefined,
): string | null {
  return job?.salaryText
    ? formatNormalizedCompensation(job.normalizedCompensation)
    : null;
}
