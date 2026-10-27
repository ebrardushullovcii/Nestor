import { normalizeFormQuestionPrompt } from "./applications";
import { preserveTechnologyTokens } from "./technology-text";

type Meaning = { intent: string; subject: string; pay: boolean };
const normal = (value: string) =>
  normalizeFormQuestionPrompt(
    preserveTechnologyTokens(value.normalize("NFKD").replace(/\p{M}/gu, "")),
  );

/** Narrow meanings for saved personal answers. Unknown or compound questions stay exact-only. */
function meaning(question: string): Meaning | null {
  const text = normal(question);
  if (
    /\brepeated question on\b|\b(?:references?|referee|spouse|partner s|another person|someone else|emergency contact)\b/u.test(
      text,
    )
  )
    return null;
  const clauses = text.replace(
    /\b(?:and why|love or hate|worked(?: at)? or (?:consulted|contracted))\b/gu,
    " ",
  );
  if (/\b(?:and|or)\b/u.test(clauses)) return null;
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
    meanings.push({
      intent:
        /\b(?:hate|dislike|least favou?rite)\b/u.test(text) &&
        !/love or hate/u.test(text)
          ? "monitoring_dislike"
          : "monitoring_opinion",
      subject: "",
      pay: false,
    });
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

const currencyCodes = new Set(Intl.supportedValuesOf("currency"));
function currency(text: string): string | null {
  const value = text.toLowerCase();
  const matches = [
    [/\b(?:eur|euros?)\b/u, "EUR"],
    [/\b(?:usd|us dollars?)\b/u, "USD"],
    [/\b(?:gbp|pounds?)\b/u, "GBP"],
  ] as const;
  const found: string[] = matches
    .filter(([pattern]) => pattern.test(value))
    .map(([, code]) => code);
  for (const code of text.match(/\b[A-Z]{3}\b/gu) ?? [])
    if (currencyCodes.has(code)) found.push(code);
  const unique = [...new Set(found)];
  const symbols = [...new Set(text.match(/\p{Sc}/gu) ?? [])];
  if (unique.length > 1) return "ambiguous";
  if (unique[0]) {
    const ownSymbol = new Intl.NumberFormat("en", {
      style: "currency",
      currency: unique[0],
      currencyDisplay: "narrowSymbol",
    })
      .formatToParts(1)
      .find((part) => part.type === "currency")?.value;
    return symbols.every((symbol) => symbol === ownSymbol)
      ? unique[0]
      : "ambiguous";
  }
  if (!symbols.length) return null;
  if (symbols.length > 1) return "ambiguous";
  return (
    ({ "€": "EUR", $: "USD", "£": "GBP" } as Record<string, string>)[
      symbols[0]!
    ] ?? "ambiguous"
  );
}
function taxBasis(text: string): string | null {
  const net = /\b(?:net|after tax|take home)\b/iu.test(normal(text));
  const gross = /\b(?:gross|before tax|pre tax)\b/iu.test(normal(text));
  return net && gross ? "ambiguous" : net ? "net" : gross ? "gross" : null;
}
function period(text: string): string | null {
  const value = normal(text),
    found = [
      [/\b(?:annual|annually|years?|yearly|annum)\b/u, "year"],
      [/\b(?:months?|monthly)\b/u, "month"],
      [/\b(?:weeks?|weekly)\b/u, "week"],
      [/\b(?:hours?|hourly)\b/u, "hour"],
      [/\b(?:days?|daily)\b/u, "day"],
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
  formContext = "",
): boolean {
  const left = normal(savedQuestion),
    right = normal(formQuestion);
  if (!left || !right) return false;
  const sourceCurrency = currency(savedQuestion) ?? currency(savedAnswer),
    targetCurrency = currency(`${formQuestion} ${formContext}`);
  if (targetCurrency && sourceCurrency !== targetCurrency) return false;
  if (/\b(?:salary|pay|compensation)\b/u.test(left + " " + right)) {
    for (const read of [currency, period, taxBasis]) {
      const source = read(savedQuestion),
        answer = read(savedAnswer),
        required = read(`${formQuestion} ${formContext}`);
      if (
        [source, answer, required].includes("ambiguous") ||
        (source && answer && source !== answer) ||
        (required && required !== (source ?? answer))
      )
        return false;
    }
  }
  if (left === right) {
    const required = period(`${formQuestion} ${formContext}`),
      source = period(savedQuestion),
      answer = period(savedAnswer);
    if (
      meaning(savedQuestion)?.intent === "notice_period" &&
      required &&
      !source &&
      !answer
    )
      return false;
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
    (saved.intent !== target.intent &&
      !(
        saved.pay &&
        target.pay &&
        /\b(?:at least|minimum)\b/u.test(normal(savedAnswer))
      )) ||
    saved.subject !== target.subject
  )
    return false;
  if (saved.pay || saved.intent === "notice_period") {
    for (const read of saved.pay ? [currency, period, taxBasis] : [period]) {
      const source = read(savedQuestion),
        answer = read(savedAnswer),
        required = read(`${formQuestion} ${formContext}`);
      if (
        [source, answer, required].includes("ambiguous") ||
        (source && answer && source !== answer)
      )
        return false;
      if (required && required !== (source ?? answer)) return false;
      if (!required && source && !answer) return false;
    }
  }
  return true;
}
