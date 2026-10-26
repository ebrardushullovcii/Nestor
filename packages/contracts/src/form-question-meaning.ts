import { normalizeFormQuestionPrompt } from "./applications";

type Meaning = { intent: string; subject: string; pay: boolean };
const normal = (value: string) =>
  normalizeFormQuestionPrompt(value.normalize("NFKD").replace(/\p{M}/gu, ""));

/** Narrow meanings for saved personal answers. Unknown or compound questions stay exact-only. */
function meaning(question: string): Meaning | null {
  const text = normal(question);
  if (
    /\brepeated question on\b|\b(?:referee|spouse|partner s|another person|someone else)\b/u.test(
      text,
    )
  )
    return null;
  const meanings: Meaning[] = [];
  if (/\b(?:salary|pay|compensation|earn)\b/u.test(text)) {
    if (
      /\b(?:current|currently|previous|past|last|history|historical)\b/u.test(
        text,
      )
    )
      return null;
    const minimum = /\b(?:minimum|lowest|floor)\b/u.test(text);
    if (
      minimum ||
      /\b(?:expectations?|expected|desired|target|looking for|would like|seek|seeking)\b/u.test(
        text,
      )
    )
      meanings.push({
        intent: minimum ? "minimum_pay" : "expected_pay",
        subject: "",
        pay: true,
      });
  }
  if (
    /\bnotice\b/u.test(text) &&
    /\b(?:period|days?|weeks?|months?|how much|how long|need|give|giving|required)\b/u.test(
      text,
    )
  )
    meanings.push({ intent: "notice_period", subject: "", pay: false });
  if (
    /\b(?:monitoring|observability)\b/u.test(text) &&
    /\b(?:favou?rite|prefer\w*|go to|love|hate|like|opinion)\b/u.test(text)
  ) {
    if (/\b(?:years?|since|how long|how many|experience)\b/u.test(text))
      return null;
    meanings.push({ intent: "monitoring_opinion", subject: "", pay: false });
  }
  if (
    /\b(?:worked|consulted|contracted|employed|employment)\b/u.test(text) &&
    /\b(?:previously|previous|prior|before|ever|past)\b/u.test(text)
  ) {
    const prepositions = [...text.matchAll(/\b(?:at|for|with)\s+/gu)];
    const last = prepositions.at(-1);
    const subject = last
      ? text
          .slice(last.index + last[0].length)
          .replace(
            /\s+(?:before|previously|in the past|at any time|in any capacity)$/u,
            "",
          )
      : "";
    if (
      !subject ||
      /^(?:another|any|other)(?: company| employer)?$|^(?:the|a|an|this) (?:company|employer)$/u.test(
        subject,
      )
    )
      return null;
    meanings.push({ intent: "prior_employer_work", subject, pay: false });
  }
  return meanings.length === 1 ? meanings[0]! : null;
}

function currency(text: string): string | null {
  const value = text.toLowerCase();
  const matches = [
    [/\b(?:eur|euros?)\b|€/u, "EUR"],
    [/\b(?:usd|us dollars?)\b|\$/u, "USD"],
    [/\b(?:gbp|pounds?)\b|£/u, "GBP"],
  ] as const;
  const found = matches
    .filter(([pattern]) => pattern.test(value))
    .map(([, code]) => code);
  return found.length === 1 ? found[0]! : found.length > 1 ? "ambiguous" : null;
}
function period(text: string): string | null {
  const value = normal(text),
    found = [
      [/\b(?:annual|annually|year|yearly|annum)\b/u, "year"],
      [/\b(?:month|monthly)\b/u, "month"],
      [/\b(?:hour|hourly)\b/u, "hour"],
      [/\b(?:day|daily)\b/u, "day"],
    ] as const;
  const matches = found
    .filter(([pattern]) => pattern.test(value))
    .map(([, unit]) => unit);
  return matches.length === 1
    ? matches[0]!
    : matches.length > 1
      ? "ambiguous"
      : null;
}

/** Same personal question, retaining the employer, pay intent, currency and period. */
export function savedQuestionMatches(
  savedQuestion: string,
  formQuestion: string,
  savedAnswer = "",
): boolean {
  const left = normal(savedQuestion),
    right = normal(formQuestion);
  if (!left || !right) return false;
  const sourceCurrency = currency(savedQuestion) ?? currency(savedAnswer),
    targetCurrency = currency(formQuestion);
  if (targetCurrency && sourceCurrency !== targetCurrency) return false;
  if (left === right) {
    const required = period(formQuestion),
      source = period(savedQuestion),
      answer = period(savedAnswer);
    return (
      !required ||
      (required !== "ambiguous" && (!answer || answer === (source ?? required)))
    );
  }
  const saved = meaning(savedQuestion),
    target = meaning(formQuestion);
  if (
    !saved ||
    !target ||
    saved.intent !== target.intent ||
    saved.subject !== target.subject
  )
    return false;
  if (saved.pay) {
    for (const read of [currency, period]) {
      const source = read(savedQuestion),
        answer = read(savedAnswer),
        required = read(formQuestion);
      if (
        [source, answer, required].includes("ambiguous") ||
        (source && answer && source !== answer)
      )
        return false;
      if (required && required !== (source ?? answer)) return false;
    }
  }
  return true;
}
