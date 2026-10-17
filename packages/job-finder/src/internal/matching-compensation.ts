import {
  annualizeCompensationAmount,
  type CompensationPreference,
  type CompensationFitAssessment,
  type NormalizedCompensation,
} from "@nestor/contracts";

function readPeriodUnit(
  salaryText: string,
  startIndex: number,
  knownCompensationPeriods: ReadonlySet<string>,
): string | null {
  const followingText = salaryText.slice(startIndex).trimStart().toLowerCase();

  const rawPeriodUnit =
    followingText.match(/^(?:(?:\/|per\b|a\b)\s*)?([a-z]+)/)?.[1] ?? "";
  const periodUnit = compensationPeriodAliases[rawPeriodUnit] ?? rawPeriodUnit;
  return knownCompensationPeriods.has(periodUnit) ? periodUnit : null;
}

function isCompactRangeSeparator(text: string): boolean {
  return /^\s*[-–—/]\s*[$€£]?\s*$/.test(text);
}

const knownCompensationPeriods = new Set(["yr", "year", "years", "annual", "annum", "mo", "month", "months", "wk", "week", "weeks", "day", "days", "hr", "hrs", "hour", "hours"]);
const compensationPeriodAliases: Record<string, string> = {
  hourly: "hour",
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
  annually: "annual",
};
const annualCompensationMultipliers: Record<string, number> = {
  yr: 1,
  year: 1,
  years: 1,
  annual: 1,
  annum: 1,
  mo: 12,
  month: 12,
  months: 12,
  wk: 52,
  week: 52,
  weeks: 52,
  day: 260,
  days: 260,
  hr: 2080,
  hrs: 2080,
  hour: 2080,
  hours: 2080,
};
const salaryNumberPattern = /(\d[\d,]*(?:\.\d+)?)(?:\s*([km])\b)?/gi;
const secondaryCompensationBeforePattern = /\b(bonus|commission|sign[- ]?on|equity|ote)\b/i;
const secondaryCompensationAfterPattern = /^(?:[:-]\s*)?(bonus|commission|sign[- ]?on|equity|ote)\b/i;

/** Currency codes a listing may state beside its numbers. */
const STATED_CURRENCY_CODE_PATTERN =
  /\b(USD|EUR|GBP|CAD|AUD|NZD|CHF|JPY|INR|SGD|HKD|SEK|NOK|DKK|PLN|CZK|BRL|MXN|ZAR|AED|ILS)\b/iu;

/** Dollar signs that carry their own country marker. */
const PREFIXED_DOLLAR_CURRENCIES: readonly (readonly [RegExp, string])[] = [
  [/(?:\bCA|\bC)\s?\$/iu, "CAD"],
  [/(?:\bAU|\bA)\s?\$/iu, "AUD"],
  [/\bNZ\s?\$/iu, "NZD"],
  [/\bSG\s?\$/iu, "SGD"],
  [/\bHK\s?\$/iu, "HKD"],
  [/\bR\$/u, "BRL"],
];

const CURRENCY_SYMBOLS: readonly (readonly [string, string])[] = [
  ["€", "EUR"],
  ["£", "GBP"],
  ["¥", "JPY"],
  ["₹", "INR"],
  ["₪", "ILS"],
];

/**
 * The currency the listing actually stated.
 *
 * A code the listing wrote wins over a bare "$": "$170-250K CAD" is Canadian
 * dollars, and relabelling it "USD 170,000 - USD 250,000" reported a number
 * the employer never offered. Only a dollar sign with nothing else to go on
 * falls back to USD.
 */
function detectCurrencyCode(salaryText: string | null): string | null {
  if (!salaryText) {
    return null;
  }

  const statedCode = STATED_CURRENCY_CODE_PATTERN.exec(salaryText)?.[1];
  if (statedCode) {
    return statedCode.toUpperCase();
  }

  for (const [pattern, code] of PREFIXED_DOLLAR_CURRENCIES) {
    if (pattern.test(salaryText)) {
      return code;
    }
  }

  for (const [symbol, code] of CURRENCY_SYMBOLS) {
    if (salaryText.includes(symbol)) {
      return code;
    }
  }

  return salaryText.includes("$") ? "USD" : null;
}

function detectCompensationInterval(
  salaryText: string | null,
): NormalizedCompensation["interval"] {
  if (!salaryText) {
    return null;
  }

  const normalized = salaryText.toLowerCase();

  if (/\b(hour|hours|hourly|hr|hrs)\b/u.test(normalized)) {
    return "hour";
  }

  if (/\b(day|days|daily)\b/u.test(normalized)) {
    return "day";
  }

  if (/\b(week|weeks|weekly|wk)\b/u.test(normalized)) {
    return "week";
  }

  if (/\b(month|months|monthly|mo)\b/u.test(normalized)) {
    return "month";
  }

  return "year";
}

export function parseSalaryFloor(salaryText: string | null): number | null {
  if (!salaryText) {
    return null;
  }

  const matches = [...salaryText.matchAll(salaryNumberPattern)];

  if (matches.length === 0) {
    return null;
  }

  const parsed = matches
    .map((match, index) => {
      const baseValue = parseFloat((match[1] ?? "").replaceAll(",", ""));
      const rawSuffix = (match[2] ?? "").toLowerCase();
      const currentIndex = match.index ?? 0;
      const nextMatch = matches[index + 1];
      const nextIndex = nextMatch?.index ?? -1;
      const betweenText = nextMatch ? salaryText.slice(currentIndex + match[0].length, nextIndex) : "";
      const suffix = !rawSuffix && nextMatch?.[2] && isCompactRangeSeparator(betweenText)
        ? nextMatch[2].toLowerCase()
        : rawSuffix;
      const periodUnit = readPeriodUnit(salaryText, currentIndex + match[0].length, knownCompensationPeriods)
        ?? (nextMatch && isCompactRangeSeparator(betweenText)
          ? readPeriodUnit(salaryText, (nextMatch.index ?? 0) + nextMatch[0].length, knownCompensationPeriods)
          : null);
      const precedingText = salaryText.slice(Math.max(0, currentIndex - 24), currentIndex).toLowerCase();
      const followingText = salaryText.slice(currentIndex + match[0].length).trimStart().toLowerCase();

      if (!Number.isFinite(baseValue) || baseValue <= 0) {
        return null;
      }

      if (followingText.startsWith("%")) {
        return null;
      }

      const trailingContext = followingText.slice(0, 24);
      const leadingContext = precedingText.trim().split(/\s+/).at(-1) ?? "";

      if (secondaryCompensationBeforePattern.test(leadingContext) || secondaryCompensationAfterPattern.test(trailingContext)) {
        return null;
      }

      if (!suffix && !periodUnit && baseValue < 1000) {
        return null;
      }

      const scaledValue = suffix === "k"
        ? baseValue * 1000
        : suffix === "m"
          ? baseValue * 1_000_000
          : baseValue;

      return periodUnit
        ? scaledValue * (annualCompensationMultipliers[periodUnit] ?? 1)
        : scaledValue;
    })
    .filter((value): value is number => value !== null);

  if (parsed.length === 0) {
    return null;
  }

  return Math.min(...parsed);
}

export function parseNormalizedCompensation(
  salaryText: string | null,
): NormalizedCompensation {
  if (!salaryText) {
    return {
      currency: null,
      interval: null,
      minAmount: null,
      maxAmount: null,
      minAnnualUsd: null,
      maxAnnualUsd: null,
    };
  }

  const matches = [...salaryText.matchAll(salaryNumberPattern)];
  const parsedValues = matches
    .map((match, index) => {
      const baseValue = parseFloat((match[1] ?? "").replaceAll(",", ""));
      const rawSuffix = (match[2] ?? "").toLowerCase();
      const currentIndex = match.index ?? 0;
      const nextMatch = matches[index + 1];
      const nextIndex = nextMatch?.index ?? -1;
      const betweenText = nextMatch
        ? salaryText.slice(currentIndex + match[0].length, nextIndex)
        : "";
      const suffix =
        !rawSuffix && nextMatch?.[2] && isCompactRangeSeparator(betweenText)
          ? nextMatch[2].toLowerCase()
          : rawSuffix;
      const periodUnit = readPeriodUnit(salaryText, currentIndex + match[0].length, knownCompensationPeriods)
        ?? (nextMatch && isCompactRangeSeparator(betweenText)
          ? readPeriodUnit(salaryText, (nextMatch.index ?? 0) + nextMatch[0].length, knownCompensationPeriods)
          : null);
      const precedingText = salaryText
        .slice(Math.max(0, currentIndex - 24), currentIndex)
        .toLowerCase();
      const followingText = salaryText
        .slice(currentIndex + match[0].length)
        .trimStart()
        .toLowerCase();

      if (!Number.isFinite(baseValue) || baseValue <= 0 || followingText.startsWith("%")) {
        return null;
      }

      const trailingContext = followingText.slice(0, 24);
      const leadingContext = precedingText.trim().split(/\s+/).at(-1) ?? "";

      if (
        secondaryCompensationBeforePattern.test(leadingContext) ||
        secondaryCompensationAfterPattern.test(trailingContext)
      ) {
        return null;
      }

      if (!suffix && !periodUnit && baseValue < 1000) {
        return null;
      }

      return suffix === "k"
        ? baseValue * 1000
        : suffix === "m"
          ? baseValue * 1_000_000
          : baseValue;
    })
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);

  const minAmount = parsedValues[0] ?? null;
  // "$100,000 or more", "from $60k", "$45/hr+" name a floor, not a range;
  // a max equal to the min would render as a capped salary.
  const openEnded =
    parsedValues.length === 1 &&
    /(?:\bor more\b|\band (?:up|above)\b|\bat least\b|\bminimum\b|\bstarting (?:at|from)\b|\bfrom\b|\bupwards?\b|\d\s*(?:k|m)?\s*\+)/iu.test(
      salaryText,
    );
  const maxAmount = openEnded ? null : (parsedValues.at(-1) ?? minAmount);
  const interval = detectCompensationInterval(salaryText);
  const multiplier = interval ? (annualCompensationMultipliers[interval] ?? 1) : null;
  const currency = detectCurrencyCode(salaryText);
  const hasComparableUsdEvidence = currency === "USD" && multiplier !== null;

  return {
    currency,
    interval,
    minAmount,
    maxAmount,
    minAnnualUsd:
      hasComparableUsdEvidence && minAmount !== null
        ? Math.round(minAmount * multiplier)
        : null,
    maxAnnualUsd:
      hasComparableUsdEvidence && maxAmount !== null
        ? Math.round(maxAmount * multiplier)
        : null,
  };
}

export function evaluateCompensationFit(
  salaryText: string | null,
  preference: CompensationPreference | number | null,
): CompensationFitAssessment {
  const compensation =
    typeof preference === "number"
      ? {
          minimum: preference,
          maximum: null,
          interval: "year" as const,
          currency: "USD",
          currencyStatus: "inherited" as const,
        }
      : preference;
  const minimum = compensation?.minimum ?? null;

  if (minimum === null) {
    return {
      state: "not_requested",
      confidence: "unavailable",
      minimumSalaryUsd: null,
      listingMinimumAnnualUsd: null,
      listingCurrency: null,
      explanation: "No minimum salary preference is configured.",
    };
  }

  // The legacy numeric parser does not distinguish base from commission.
  // An explicit OTE choice is judged from the listing by the model instead.
  if (
    compensation &&
    "basis" in compensation &&
    compensation.basis === "total_ote"
  ) {
    return {
      state: "unknown",
      confidence: "unavailable",
      minimumSalaryUsd: null,
      listingMinimumAnnualUsd: null,
      listingCurrency: null,
      explanation:
        "Your minimum is total pay including commission (OTE). The job assessment compares the listing on that basis.",
    };
  }

  const normalized = parseNormalizedCompensation(salaryText);
  const preferenceCurrency = compensation?.currency?.toUpperCase() ?? null;
  const preferenceMinimumAnnualAmount = compensation
    ? annualizeCompensationAmount(minimum, compensation.interval)
    : null;
  const minimumSalaryUsd =
    preferenceCurrency === "USD" ? preferenceMinimumAnnualAmount : null;
  if (normalized.minAmount === null) {
    return {
      state: "unknown",
      confidence: salaryText ? "low" : "unavailable",
      minimumSalaryUsd,
      listingMinimumAnnualUsd: null,
      listingCurrency: normalized.currency,
      explanation: salaryText
        ? "The listing compensation could not be normalized safely."
        : "The listing does not provide compensation evidence.",
    };
  }

  if (
    compensation?.currencyStatus === "needs_clarification" ||
    preferenceCurrency === null
  ) {
    return {
      state: "currency_incomparable",
      confidence: "low",
      minimumSalaryUsd,
      listingMinimumAnnualUsd: null,
      listingCurrency: normalized.currency,
      explanation:
        "The saved compensation currency needs clarification before salary matching can compare this listing.",
    };
  }

  if (normalized.currency === null) {
    return {
      state: "currency_incomparable",
      confidence: "high",
      minimumSalaryUsd,
      listingMinimumAnnualUsd: null,
      listingCurrency: null,
      explanation:
        "The listing currency is unspecified, so it was not compared with the saved minimum.",
    };
  }

  if (normalized.currency !== preferenceCurrency) {
    return {
      state: "currency_incomparable",
      confidence: "high",
      minimumSalaryUsd,
      listingMinimumAnnualUsd: normalized.minAnnualUsd,
      listingCurrency: normalized.currency,
      explanation: `The listing uses ${normalized.currency} while the saved minimum uses ${preferenceCurrency}; no exchange-rate assumption was made.`,
    };
  }

  const listingMinimumAnnualAmount = normalized.interval
    ? annualizeCompensationAmount(normalized.minAmount, normalized.interval)
    : null;
  if (
    listingMinimumAnnualAmount === null ||
    preferenceMinimumAnnualAmount === null
  ) {
    return {
      state: "unknown",
      confidence: "low",
      minimumSalaryUsd,
      listingMinimumAnnualUsd: null,
      listingCurrency: normalized.currency,
      explanation: "The listing compensation interval could not be normalized safely.",
    };
  }

  const listingMinimumAnnualUsd =
    normalized.currency === "USD" ? listingMinimumAnnualAmount : null;
  if (listingMinimumAnnualAmount >= preferenceMinimumAnnualAmount) {
    return {
      state: "meets_minimum",
      confidence: "high",
      minimumSalaryUsd,
      listingMinimumAnnualUsd,
      listingCurrency: normalized.currency,
      explanation: `The listing minimum meets or exceeds the saved ${preferenceCurrency} minimum after normalizing both to annual amounts.`,
    };
  }

  return {
    state: "below_minimum",
    confidence: "high",
    minimumSalaryUsd,
    listingMinimumAnnualUsd,
    listingCurrency: normalized.currency,
    explanation: `The listing minimum is below the saved ${preferenceCurrency} minimum after normalizing both to annual amounts.`,
  };
}

/**
 * Site furniture that looks like pay.
 *
 * Some boards print one house salary band in the page chrome — a banner, a
 * filter summary, a footer — and a card-level extraction picks it up for every
 * result on the page. One run then stamped the same "$80000 - 150000" on
 * unrelated jobs, including one whose own listing body read "Pay: $22.00 per
 * hour". A per-board rule for that is exactly what ADR 0007 forbids, so the
 * test is statistical and generic: a band that repeats across most of one
 * run's results and is not written anywhere in the job's own text is the
 * page's furniture, not that job's pay, and is dropped.
 *
 * It is deliberately conservative. A small run proves nothing, and a band the
 * listing body itself states is that listing's pay however many neighbours
 * share it.
 */
const SITE_FURNITURE_SALARY_MIN_RESULTS = 4;
const SITE_FURNITURE_SALARY_SHARE = 0.6;

function comparableSalaryText(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

const BODY_SALARY_RANGE_PATTERN =
  /\b(?:salary|compensation|pay(?:\s+range)?)\b[^.!?]{0,90}?((?:(?:USD|CAD|AUD|EUR|GBP)\s*)?(?:CA\$|A\$|\$|€|£)?\s*\d[\d,.]*(?:\s*[kK])?(?:\s*(?:-|–|—|to)\s*(?:(?:USD|CAD|AUD|EUR|GBP)\s*)?(?:CA\$|A\$|\$|€|£)?\s*\d[\d,.]*(?:\s*[kK])?)?(?:\s*(?:USD|CAD|AUD|EUR|GBP))?(?:\s*(?:\/|per\s+)?(?:hourly|daily|weekly|monthly|yearly|annually|hour|hours|hr|day|week|month|year|yr))?)/iu;

const BODY_SALARY_MONEY_MARKER_PATTERN =
  /(?:(?:(?:USD|CAD|AUD|EUR|GBP)\s*|(?:CA\$|A\$|\$|€|£)\s*)\d|\d[\d,.]*\s*(?:[kK]\b|(?:USD|CAD|AUD|EUR|GBP)\b|(?:\/\s*|per\s+)(?:hour|hr|day|week|month|year)\b|annually\b))/iu;

/**
 * Returns the explicit pay range nearest a salary/compensation/pay label in
 * the listing body. It is deliberately cue-bound: arbitrary years, user
 * counts and performance percentages elsewhere in the page are not pay.
 */
export function extractSalaryRangeFromListingBody(
  description: string,
): string | null {
  const explicitAmount =
    /(?:\b(?:USD|CAD|AUD|EUR|GBP)\s*|(?:CA\$|A\$|\$|€|£)\s*)\d[\d,.]*(?:\s*[kK])?(?:\s*(?:-|–|—|to)\s*(?:(?:USD|CAD|AUD|EUR|GBP)\s*)?(?:CA\$|A\$|\$|€|£)?\s*\d[\d,.]*(?:\s*[kK])?)?\s*(?:per\s+(?:year|month|week|day|hour)|\/(?:year|yr|month|week|day|hour|hr)|annually|yearly|monthly|weekly|daily|hourly)\b/iu;
  const labelled = BODY_SALARY_RANGE_PATTERN.exec(description)?.[1]?.trim();
  if (labelled && BODY_SALARY_MONEY_MARKER_PATTERN.test(labelled))
    return labelled;
  return explicitAmount.exec(description)?.[0]?.trim() ?? null;
}

/**
 * The listing body is stronger evidence than a separate extracted cell when
 * the two disagree. This repairs malformed structured data such as a stored
 * "$200000 - 500000" beside body copy that says "$100k-$500k USD yearly",
 * without inventing or converting a currency.
 */
export function reconcileSalaryTextWithListingBody(
  salaryText: string | null | undefined,
  description: string,
): string | null {
  const stated = extractSalaryRangeFromListingBody(description);
  if (!stated) return salaryText ?? null;
  if (!salaryText) return stated;
  return isSalaryTextStatedInBody(description, salaryText)
    ? salaryText
    : stated;
}

/** Digit groups in the band, so "$80,000" is found inside "80000 - 150000". */
function salaryDigitGroups(value: string): string[] {
  return [...value.matchAll(/\d[\d,.]*/gu)]
    .map((match) => match[0].replace(/[,.]/gu, ""))
    .filter((digits) => digits.length >= 2);
}

/** Whether this job's own body contains every number in its salary band. */
export function isSalaryTextStatedInBody(
  description: string,
  salaryText: string | null | undefined,
): boolean {
  const body = description.replace(/[,.]/gu, "");
  const groups = salaryDigitGroups(salaryText ?? "");
  return groups.length > 0 && groups.every((digits) => body.includes(digits));
}

export interface SalaryFurnitureCandidate {
  description: string;
  salaryText: string | null;
}

/**
 * The salary strings in this run that are the page's furniture rather than any
 * one job's pay. Compare a job's `salaryText` against the returned set before
 * storing or printing it.
 */
export function findSiteFurnitureSalaryTexts(
  postings: readonly SalaryFurnitureCandidate[],
): ReadonlySet<string> {
  const furniture = new Set<string>();
  if (postings.length < SITE_FURNITURE_SALARY_MIN_RESULTS) {
    return furniture;
  }

  const byBand = new Map<string, { count: number; statedInBody: number }>();
  for (const posting of postings) {
    const key = comparableSalaryText(posting.salaryText);
    if (!key) {
      continue;
    }
    const entry = byBand.get(key) ?? { count: 0, statedInBody: 0 };
    entry.count += 1;
    if (isSalaryTextStatedInBody(posting.description, posting.salaryText)) {
      entry.statedInBody += 1;
    }
    byBand.set(key, entry);
  }

  const threshold = Math.max(
    SITE_FURNITURE_SALARY_MIN_RESULTS,
    Math.ceil(postings.length * SITE_FURNITURE_SALARY_SHARE),
  );
  for (const [key, entry] of byBand) {
    // A band most of the run shares AND that almost none of the listing
    // bodies actually state is the page's, not the jobs'.
    if (entry.count >= threshold && entry.statedInBody * 2 < entry.count) {
      furniture.add(key);
    }
  }
  return furniture;
}

/** Whether one job's salary string is in the furniture set for its run. */
export function isSiteFurnitureSalaryText(
  salaryText: string | null | undefined,
  furniture: ReadonlySet<string>,
): boolean {
  const key = comparableSalaryText(salaryText);
  return key.length > 0 && furniture.has(key);
}
