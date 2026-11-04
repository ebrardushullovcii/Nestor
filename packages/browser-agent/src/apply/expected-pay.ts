import type {
  ApplyAnswer,
  ApplyAnswerSources,
  ApplyFormControl,
} from "./types";

/** Offer the person's recorded target without disclosing it to the employer. */
export function expectedPaySuggestion(
  control: ApplyFormControl,
  sources: ApplyAnswerSources,
): ApplyAnswer | null {
  const pay = sources.preferences?.compensation;
  if (
    !pay ||
    control.asksCurrentPay ||
    pay.maximum === null ||
    pay.currencyStatus !== "explicit" ||
    !pay.currency
  )
    return null;
  const maximum = pay.maximum;
  const currency = pay.currency;
  const question = `${control.groupLabel} ${control.label} ${control.hint ?? ""}`;
  if (
    /\b(?:current|previous|past|historical|history|earnings|net|after tax|take home)\b/iu.test(
      question,
    )
  )
    return null;
  if (
    (question.match(/\b[A-Z]{3}\b/gu) ?? []).some(
      (currency) => currency !== pay.currency,
    )
  )
    return null;
  const units = [
    [/\b(?:annual|annually|yearly|year|annum)\b/iu, "year"],
    [/\b(?:monthly|month)\b/iu, "month"],
    [/\b(?:hourly|hour|hr)\b/iu, "hour"],
  ] as const;
  if (
    units.some(
      ([pattern, unit]) => pattern.test(question) && pay.interval !== unit,
    )
  )
    return null;
  const stored = `${pay.maximum} ${pay.currency} per ${pay.interval}`;
  const matches = control.options.filter((option) => {
    const currencies = option.match(/\b[A-Z]{3}\b/gu) ?? [];
    if (currencies.some((currency) => currency !== pay.currency)) return false;
    if (
      /[€£$]/u.test(option) &&
      !option.includes(
        ({ EUR: "€", GBP: "£", USD: "$" } as Record<string, string>)[
          currency
        ] ?? "\0",
      )
    )
      return false;
    if (
      units.some(
        ([pattern, unit]) => pattern.test(option) && pay.interval !== unit,
      )
    )
      return false;
    const range =
      /^\D*(\d[\d ,\u00a0]*)(?:\s*(?:EUR|GBP|USD|€|£|\$))?\s*(?:–|—|-|to)\s*(\d[\d ,\u00a0]*)\D*$/iu.exec(
        option,
      );
    const lower = range?.[1];
    const upper = range?.[2];
    if (!lower || !upper) return false;
    const low = Number(lower.replace(/[ ,\u00a0]/gu, ""));
    const high = Number(upper.replace(/[ ,\u00a0]/gu, ""));
    return low <= maximum && maximum <= high && low < high;
  });
  const value = matches.length === 1 ? (matches[0] ?? stored) : stored;
  return {
    value,
    kind: "salary_expectation",
    sourceKind: "profile",
    sourceId: "preferences.compensation.maximum",
    provenanceLabel: "your saved expected pay",
    groundedIn: [stored],
  };
}

/** Local handoff only: it never authorizes a browser write. */
export function expectedPayHandoff(
  control: ApplyFormControl,
  sources: ApplyAnswerSources,
): {
  suggestion: ApplyAnswer | null;
  reason: string;
  check: string;
} | null {
  if (control.questionKind !== "salary_expectation") return null;
  if (control.asksCurrentPay)
    return {
      suggestion: null,
      reason:
        "Your saved expected pay does not establish your current or previous earnings. Please supply that separate fact.",
      check: "current_pay_missing",
    };
  const suggestion = expectedPaySuggestion(control, sources);
  if (!suggestion) return null;
  const target = suggestion.groundedIn[0];
  if (control.options.length && !control.options.includes(suggestion.value))
    return {
      suggestion: null,
      reason: `Your saved expected pay is ${target}, but this form has no single matching option in the same currency and period. Please choose how to answer this form.`,
      check: "pay_option_missing",
    };
  return null;
}
