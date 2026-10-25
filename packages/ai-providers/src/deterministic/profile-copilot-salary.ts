import {
  type CompensationCurrencyStatus,
  type CompensationInterval,
  type ProfileCompensationPreferencePatchFields,
  type ProfileCopilotPatchGroup,
} from "@nestor/contracts";

import type { ReviseCandidateProfileInput } from "../shared";
import { createUniqueId, normalizeFactText } from "./profile-copilot-helpers";
import { fieldDescriptors } from "./profile-copilot-field-updates";
import { segmentCommandClauses } from "./profile-copilot-field-updates-shared";

/**
 * Amounts below this floor carry no reliable pay period on their own ("2k"
 * could be monthly or yearly), so the copilot asks for the period instead of
 * staging a misleading yearly value. Amounts at or above the floor are treated
 * as plausible annual figures when no period is stated.
 */
export const SALARY_PERIOD_AMBIGUITY_FLOOR = 10_000;

const intervalAdjectiveByInterval: Record<CompensationInterval, string> = {
  hour: "hourly",
  day: "daily",
  week: "weekly",
  month: "monthly",
  year: "yearly",
};

export interface ParsedSalaryAmounts {
  intent: "minimum" | "maximum" | "range";
  minimum: number | null;
  maximum: number | null;
}

export type SalaryCommand =
  | { kind: "not_salary" }
  | { kind: "answer_bank_text" }
  | { kind: "clear"; target: "minimum" | "maximum" }
  | { kind: "ambiguous"; question: string }
  | { kind: "conflict"; question: string }
  | ({
      kind: "parsed";
      currency: string | null;
      currencyStatus: CompensationCurrencyStatus;
      interval: CompensationInterval | null;
    } & ParsedSalaryAmounts);

interface SalaryToken {
  amount: number;
  start: number;
  end: number;
}

function parseAmountToken(
  rawValue: string,
  scaleSuffix: string | undefined,
): number | null {
  const parsed = Number.parseFloat(rawValue.replaceAll(",", ""));

  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  const scaled =
    parsed *
    (scaleSuffix === "k" ? 1_000 : scaleSuffix === "m" ? 1_000_000 : 1);

  return Number.isInteger(scaled) ? scaled : Math.round(scaled);
}

function extractSalaryTokens(text: string): SalaryToken[] {
  return [...text.matchAll(/(?:US\$|[$€£])?\s*(\d[\d,.]*)\s*(k|m)?\b/gi)]
    .map((match) => {
      const amount = parseAmountToken(
        match[1] ?? "",
        match[2]?.toLowerCase(),
      );

      return amount === null
        ? null
        : {
            amount,
            start: match.index ?? 0,
            end: (match.index ?? 0) + match[0].length,
          };
    })
    .filter((token): token is SalaryToken => token !== null);
}

/**
 * Shared pay-period detector for salary commands. Only an explicitly stated
 * pay period counts; callers must never assume one. Duration phrases such as
 * "3-month contract" or "6-month notice" are never pay periods.
 */
export function detectSalaryInterval(
  request: string,
): CompensationInterval | null {
  // A month mention right after a number ("3-month", "6 month") describes a
  // duration, not a pay period; "per month", "a month" and "monthly" do.
  if (
    /(?<![\d-])(?<!\d\s)\b(?:per\s+|a\s+|each\s+)?(?:month|monthly)\b/i.test(
      request,
    )
  ) {
    return "month";
  }
  if (
    /\b(?:per\s+|a\s+|\/\s*)?(?:year|yearly|annual(?:ly)?|annum|\/?yrs?)\b/i.test(
      request,
    )
  ) {
    return "year";
  }
  if (/\b(?:per\s+|a\s+|\/\s*)?(?:week|weekly)\b/i.test(request)) {
    return "week";
  }
  if (/\b(?:per\s+|a\s+|\/\s*)?(?:day|daily)\b/i.test(request)) {
    return "day";
  }
  if (
    /\b(?:per\s+|an\s+|\/\s*)?(?:hour|hourly|\/?hrs?)\b/i.test(request)
  ) {
    return "hour";
  }

  return null;
}

/**
 * Shared currency detector for salary commands. Symbols map to their common
 * ISO codes, and only currencies explicitly stated in the text are returned.
 */
export function detectSalaryCurrency(request: string): string | null {
  const isoCode = request.match(/\b(USD|EUR|GBP|CAD|AUD|NZD|CHF)\b/i)?.[1];

  if (isoCode) {
    return isoCode.toUpperCase();
  }

  if (/US\$|\$/.test(request)) return "USD";
  if (request.includes("€")) return "EUR";
  if (request.includes("£")) return "GBP";
  if (/\beuros?\b/i.test(request)) return "EUR";
  if (/\b(?:us\s+)?dollars?\b/i.test(request)) return "USD";
  if (/\b(?:british\s+)?pounds?\b/i.test(request)) return "GBP";
  if (/\bswiss\s+francs?\b/i.test(request)) return "CHF";

  return null;
}

/**
 * Answer-bank phrasing ("salary expectations answer") edits stored application
 * answer text, not the structured compensation preference. Routing it here lets
 * every downstream salary path defer to the answer-bank field handler.
 */
export function requestMentionsSalaryAnswerBank(
  normalizedRequest: string,
): boolean {
  return (
    /\bsalary (?:expectations?|expectation)\s+answer\b/.test(
      normalizedRequest,
    ) ||
    /\banswer (?:for|to)(?: my)? salary expectations?\b/.test(normalizedRequest)
  );
}

function formatAmount(amount: number): string {
  return amount.toLocaleString("en-US");
}

function formatPeriod(interval: CompensationInterval): string {
  return intervalAdjectiveByInterval[interval];
}

function buildAmbiguityQuestion(
  amounts: number[],
  currencyKnown: boolean,
): string {
  const formatted = [...new Set(amounts)]
    .map((amount) => formatAmount(amount))
    .join(" and ");
  const currencyNote = currencyKnown
    ? ""
    : " Also tell me the three-letter currency code, such as USD or EUR, because no explicit currency is saved yet.";

  return `I understood ${formatted}, but not the pay period. Tell me the period (hourly, daily, weekly, monthly, or yearly) and I will save it exactly.${currencyNote} I have not changed your compensation preferences.`;
}

function extractMinimumIntent(
  normalizedRequest: string,
): { amount: number; start: number; end: number } | null {
  // The tight anchor keeps unrelated numbers ("7 years of experience") out of
  // compensation parsing.
  const match = normalizedRequest.match(
    /\b(?:minimum|min|floor)\b(?:\s+(?:salary|compensation|pay|expectation))?(?:\s+(?:is|should\s+be|to(?:\s+be)?|of|at|be))?\s*(?:US\$|[$€£])?\s*([\d,.]+)\s*(k|m)?\b/,
  );

  if (!match || match.index === undefined) {
    return null;
  }

  const amount = parseAmountToken(match[1] ?? "", match[2]?.toLowerCase());

  if (amount === null) {
    return null;
  }

  return { amount, start: match.index, end: match.index + match[0].length };
}

function parseSalaryAmounts(normalizedRequest: string): ParsedSalaryAmounts | null {
  const conversationalRange = normalizedRequest.match(
    /\b(?:might\s+)?consider\s+(?:US\$|[$€£])?\s*([\d,.]+)\s*(k|m)?(?:\s+(?:per|a|each)\s+(?:hour|day|week|month|year))?\s*,?\s*(?:but\s+)?(?:really\s+)?(?:i\s+)?(?:want|target|expect)\s+(?:US\$|[$€£])?\s*([\d,.]+)\s*(k|m)?\b/,
  );
  if (conversationalRange) {
    const sharedScale =
      conversationalRange[2]?.toLowerCase() ??
      conversationalRange[4]?.toLowerCase();
    const acceptable = parseAmountToken(
      conversationalRange[1] ?? "",
      sharedScale,
    );
    const target = parseAmountToken(
      conversationalRange[3] ?? "",
      conversationalRange[4]?.toLowerCase() ?? sharedScale,
    );
    if (acceptable !== null && target !== null) {
      return {
        intent: "range",
        minimum: acceptable,
        maximum: target,
      };
    }
  }

  if (
    !/\b(salary|compensation|pay|wage|expect(?:ed|ing|ations?)?|minimum|min|maximum|max|target|range|floor)\b/.test(
      normalizedRequest,
    )
  ) {
    return null;
  }

  const minimumIntent = extractMinimumIntent(normalizedRequest);

  // Target intent slices from the last expectation-style marker so numbers
  // earlier in a combined request stay out of compensation parsing.
  const targetMarkers = [
    ...normalizedRequest.matchAll(
      /\b(?:expected|expecting|expectations?|target|maximum|max|top|cap|salary|compensation|pay)\b/g,
    ),
  ];
  const lastTargetMarker = targetMarkers.at(-1);
  const targetSlice =
    lastTargetMarker && lastTargetMarker.index !== undefined
      ? normalizedRequest.slice(lastTargetMarker.index)
      : "";
  const targetSliceOffset =
    lastTargetMarker && lastTargetMarker.index !== undefined
      ? lastTargetMarker.index
      : 0;

  const rangeMatch = targetSlice.match(
    /(?:US\$|[$€£])?\s*([\d,.]+)\s*(k|m)?\s*(?:-|–|—|to)\s*(?:US\$|[$€£])?\s*([\d,.]+)\s*(k|m)?/,
  );

  if (rangeMatch) {
    const sharedScale =
      rangeMatch[2]?.toLowerCase() ?? rangeMatch[4]?.toLowerCase();
    const first = parseAmountToken(rangeMatch[1] ?? "", sharedScale);
    const second = parseAmountToken(
      rangeMatch[3] ?? "",
      rangeMatch[4]?.toLowerCase() ?? rangeMatch[2]?.toLowerCase(),
    );

    if (first !== null && second !== null) {
      return {
        intent: "range",
        minimum: Math.min(first, second),
        maximum: Math.max(first, second),
      };
    }
  }

  const targetIntent = extractSalaryTokens(targetSlice)
    .map((token) => ({
      ...token,
      start: token.start + targetSliceOffset,
      end: token.end + targetSliceOffset,
    }))
    .filter(
      (token) =>
        token.amount !== minimumIntent?.amount ||
        token.end <= minimumIntent.start ||
        token.start >= minimumIntent.end,
    );
  const maximumIntent = targetIntent.at(-1)?.amount ?? null;

  if (minimumIntent && maximumIntent === null) {
    return { intent: "minimum", minimum: minimumIntent.amount, maximum: null };
  }

  if (minimumIntent && maximumIntent !== null) {
    if (minimumIntent.amount === maximumIntent) {
      return {
        intent: "minimum",
        minimum: minimumIntent.amount,
        maximum: null,
      };
    }

    return {
      intent: "range",
      minimum: Math.min(minimumIntent.amount, maximumIntent),
      maximum: Math.max(minimumIntent.amount, maximumIntent),
    };
  }

  if (maximumIntent !== null) {
    return { intent: "maximum", minimum: null, maximum: maximumIntent };
  }

  return null;
}

function parseClearTarget(
  normalizedRequest: string,
): "minimum" | "maximum" | null {
  if (!/\b(clear|remove|delete|reset|erase|drop)\b/.test(normalizedRequest)) {
    return null;
  }

  if (extractSalaryTokens(normalizedRequest).length > 0) {
    return null;
  }

  if (/\b(minimum|min|floor)\b/.test(normalizedRequest)) {
    return "minimum";
  }

  if (
    /\b(expected|expecting|expectations?|target|maximum|max|top|cap|salary|compensation)\b/.test(
      normalizedRequest,
    )
  ) {
    return "maximum";
  }

  return null;
}

export function parseSalaryCommand(request: string): SalaryCommand {
  const normalizedRequest = normalizeFactText(request);

  if (!normalizedRequest) {
    return { kind: "not_salary" };
  }

  if (requestMentionsSalaryAnswerBank(normalizedRequest)) {
    return { kind: "answer_bank_text" };
  }

  const clearTarget = parseClearTarget(normalizedRequest);

  if (clearTarget) {
    return { kind: "clear", target: clearTarget };
  }

  const amounts = parseSalaryAmounts(normalizedRequest);

  if (!amounts) {
    return { kind: "not_salary" };
  }

  const statedAmounts = [amounts.minimum, amounts.maximum].filter(
    (amount): amount is number => amount !== null,
  );
  const currency = detectSalaryCurrency(request);
  const interval = detectSalaryInterval(request);

  if (
    interval === null &&
    Math.max(...statedAmounts) < SALARY_PERIOD_AMBIGUITY_FLOOR
  ) {
    return {
      kind: "ambiguous",
      question: buildAmbiguityQuestion(statedAmounts, currency !== null),
    };
  }

  return {
    kind: "parsed",
    ...amounts,
    currency,
    currencyStatus: currency ? "explicit" : "needs_clarification",
    interval,
  };
}

function resolveCurrencyFields(
  input: ReviseCandidateProfileInput,
  command: Extract<SalaryCommand, { kind: "parsed" }>,
): Pick<
  ProfileCompensationPreferencePatchFields,
  "currency" | "currencyStatus"
> {
  const savedCompensation = input.searchPreferences.compensation;
  const savedCurrencyIsInheritable =
    savedCompensation.currencyStatus === "explicit" &&
    savedCompensation.currency !== null;

  // The user stated a currency: record it as explicit even when it matches the
  // saved one, because this request re-confirms it.
  if (command.currency) {
    return { currency: command.currency, currencyStatus: "explicit" };
  }

  // Nothing stated and an explicit saved currency exists: inherit silently by
  // leaving the currency fields untouched in the staged patch.
  if (savedCurrencyIsInheritable) {
    return {};
  }

  // Nothing stated and nothing trustworthy saved: stage the honest unset pair
  // so review shows that currency still needs clarification.
  if (
    savedCompensation.currency === null &&
    savedCompensation.currencyStatus === "needs_clarification"
  ) {
    return {};
  }

  return { currency: null, currencyStatus: "needs_clarification" };
}

function summarizeSalaryIntent(
  intent: ParsedSalaryAmounts["intent"],
): string {
  if (intent === "range") {
    return "Update minimum and expected salary";
  }

  return intent === "minimum"
    ? "Update minimum salary"
    : "Update expected salary";
}

/**
 * Salary-command results feed the shared patch pipeline: a typed patch group,
 * a standalone clarification question (never a mutation), or nothing.
 */
export type SalaryCommandOutcome =
  | { kind: "none" }
  | { kind: "group"; group: ProfileCopilotPatchGroup }
  | { kind: "clarification"; question: string };

function clarification(question: string): SalaryCommandOutcome {
  return { kind: "clarification", question };
}

/**
 * The salary command clause is the segment that contains the salary-family
 * keyword, so later command clauses ("and my email to ...", "and my current
 * location to ...") are never absorbed into amounts or period/currency
 * detection. A request with no salary clause still falls back to the whole
 * request for parse-compatibility with non-segmented phrasing.
 */
function extractSalaryClause(request: string): string {
  const clause = segmentCommandClauses(request, fieldDescriptors).find(
    (candidate) =>
      candidate.family === "salary" && candidate.isAcceptedCommand,
  );

  return clause?.text ?? request;
}

export function buildSalaryCommandOutcome(
  input: ReviseCandidateProfileInput,
): SalaryCommandOutcome {
  const command = parseSalaryCommand(extractSalaryClause(input.request));

  if (command.kind === "not_salary" || command.kind === "answer_bank_text") {
    return { kind: "none" };
  }

  if (command.kind === "ambiguous") {
    return clarification(command.question);
  }

  if (command.kind === "conflict") {
    return clarification(command.question);
  }

  const savedCompensation = input.searchPreferences.compensation;

  if (command.kind === "clear") {
    const savedBound =
      command.target === "minimum"
        ? savedCompensation.minimum
        : savedCompensation.maximum;

    // A bound that is already unset needs no patch: claiming a mutation on a
    // no-op clear would mislead the user and the apply pipeline.
    if (savedBound === null) {
      return { kind: "none" };
    }

    // The contracts require at least one non-null field on a compensation
    // patch, and the kept interval is truthful context for a bound clear.
    return {
      kind: "group",
      group: {
        id: createUniqueId("profile_patch_group"),
        summary:
          command.target === "minimum"
            ? "Clear minimum salary"
            : "Clear expected salary",
        applyMode: "applied",
        operations: [
          {
            operation: "replace_compensation_preferences_fields",
            value:
              command.target === "minimum"
                ? { minimum: null, interval: savedCompensation.interval }
                : { maximum: null, interval: savedCompensation.interval },
          },
        ],
        createdAt: new Date().toISOString(),
      },
    };
  }

  const requestedInterval = command.interval;
  const intervalSwitches =
    requestedInterval !== null &&
    requestedInterval !== savedCompensation.interval;

  // A stated period that differs from the saved one would silently reinterpret
  // whichever bound the user did not restate. Ask instead of mutating.
  if (
    requestedInterval !== null &&
    intervalSwitches &&
    ((command.minimum === null && savedCompensation.minimum !== null) ||
      (command.maximum === null && savedCompensation.maximum !== null))
  ) {
    const keptBound =
      command.minimum === null
        ? savedCompensation.minimum
        : savedCompensation.maximum;

    return clarification(
      `You currently save a bound of ${formatAmount(keptBound ?? 0)} per ${formatPeriod(savedCompensation.interval)}. Switching to ${formatPeriod(requestedInterval)} pay periods would mix periods, so I have not changed anything. Restate both the minimum and the maximum in ${formatPeriod(requestedInterval)} terms.`,
    );
  }

  // Contradictory bounds inside one request are refused outright.
  if (
    command.minimum !== null &&
    command.maximum !== null &&
    command.minimum > command.maximum
  ) {
    return clarification(
      `${formatAmount(command.minimum)} and ${formatAmount(command.maximum)} contradict each other as a minimum and maximum, so I have not changed anything. Tell me which one is the minimum and which one is the maximum.`,
    );
  }

  // Never destroy an existing opposite bound silently: refuse min>max combos
  // against saved state and ask the user to resolve them explicitly.
  if (
    command.maximum !== null &&
    savedCompensation.minimum !== null &&
    !intervalSwitches &&
    command.maximum < savedCompensation.minimum
  ) {
    return clarification(
      `Your saved minimum is ${formatAmount(savedCompensation.minimum)} per ${formatPeriod(savedCompensation.interval)}. ${formatAmount(command.maximum)} is below it, so I have not changed anything. Raise your expected salary above ${formatAmount(savedCompensation.minimum)}, or ask me to change or clear the minimum first.`,
    );
  }

  if (
    command.minimum !== null &&
    savedCompensation.maximum !== null &&
    !intervalSwitches &&
    command.minimum > savedCompensation.maximum
  ) {
    return clarification(
      `Your saved expected salary is ${formatAmount(savedCompensation.maximum)} per ${formatPeriod(savedCompensation.interval)}. ${formatAmount(command.minimum)} is above it, so I have not changed anything. Lower your minimum to ${formatAmount(savedCompensation.maximum)} or less, or raise the expected salary first.`,
    );
  }

  const value: ProfileCompensationPreferencePatchFields = {};

  if (
    command.minimum !== null &&
    command.minimum !== savedCompensation.minimum
  ) {
    value.minimum = command.minimum;
  }

  if (
    command.maximum !== null &&
    command.maximum !== savedCompensation.maximum
  ) {
    value.maximum = command.maximum;
  }

  if (requestedInterval !== null && intervalSwitches) {
    value.interval = requestedInterval;
  }

  Object.assign(value, resolveCurrencyFields(input, command));

  if (Object.keys(value).length === 0) {
    return { kind: "none" };
  }

  const needsCurrencyClarification =
    value.currencyStatus === "needs_clarification";

  return {
    kind: "group",
    group: {
      id: createUniqueId("profile_patch_group"),
      summary: summarizeSalaryIntent(command.intent),
      applyMode: needsCurrencyClarification ? "needs_review" : "applied",
      operations: [
        {
          operation: "replace_compensation_preferences_fields",
          value,
        },
      ],
      createdAt: new Date().toISOString(),
    },
  };
}
