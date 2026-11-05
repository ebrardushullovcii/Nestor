import { preserveTechnologyTokens } from "@nestor/contracts";
/** Source coordinates used to bind an answer-check citation. */
export interface AnswerEvidence {
  source: string;
  path: string;
  quote: string;
}

const normalize = (value: string) =>
  preserveTechnologyTokens(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
export const isScalarAnswer = (value: string) =>
  /^(?:yes|no|true|false|[-+]?\d+(?:[.,]\d+)?\+?%?)$/iu.test(value.trim());
const opinion =
  /\b(?:like[sd]?|love[sd]?|hate[sd]?|enjoy\w*|want\w*|wish\w*|proud|passion\w*|excited|interested|strengths?|strongest)\b/iu;
const preference =
  /\b(?:go[\s-]*to|best\s+(?:time|contact\s+time)|top\s+skill|prefer(?:ence|red|s)?|favou?rites?|of\s+choice)\b/iu;
const motivation =
  /\b(?:why|what)\b.*\b(?:join|apply|work|company|us|role|position|hire|attracts?|appeals?|interests?)\b|\btell us about yourself\b|\b(?:cover|application|motivation)\s+letter\b|\b(?:motivation|motivates|interested in (?:this|the) (?:role|position))\b/iu;

export const OPINION_ANSWER_REASON =
  "This question asks for your opinion or preference. Please supply your answer.";
export function requiresSavedOpinionAnswer(
  question: string,
  answer: string,
): boolean {
  return (
    preference.test(question) ||
    preference.test(answer) ||
    (!motivation.test(question) &&
      (opinion.test(question) || opinion.test(answer)))
  );
}

export function employmentMonthEvidence(
  question: string,
  answer: string,
  evidence: readonly AnswerEvidence[],
): boolean | null {
  const iso = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/u.exec(answer);
  const dayFirst = /^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(answer);
  const monthFirst = /^(\d{2})\/(\d{4})$/u.exec(answer);
  if (!iso && !dayFirst && !monthFirst) return null;
  const asked = normalize(question).replace(/ optional$/u, "");
  const label = asked.replace(
    /\s+(?:dd mm yyyy|mm yyyy|yyyy mm dd|yyyy mm)$/u,
    "",
  );
  const field = /\b(?:from|start (?:date|month))$/u.test(label)
    ? "startDate"
    : /\b(?:to|end (?:date|month))$/u.test(label)
      ? "endDate"
      : null;
  if (!field) return null;
  const format = /\b(dd mm yyyy|mm yyyy|yyyy mm dd|yyyy mm)$/u.exec(asked)?.[1];
  const actualFormat = dayFirst
    ? "dd mm yyyy"
    : monthFirst
      ? "mm yyyy"
      : iso?.[3]
        ? "yyyy mm dd"
        : "yyyy mm";
  if ((dayFirst || monthFirst || format) && format !== actualFormat)
    return false;
  const year = iso?.[1] ?? dayFirst?.[3] ?? monthFirst?.[2];
  const month = iso?.[2] ?? dayFirst?.[2] ?? monthFirst?.[1];
  const day = iso?.[3] ?? dayFirst?.[1];
  const canonical = `${year}-${month}${day ? `-${day}` : ""}`;
  const date = new Date(`${year}-${month}-${day ?? "01"}T00:00:00Z`);
  if (
    !Number.isFinite(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== `${year}-${month}-${day ?? "01"}`
  )
    return false;
  const months =
    "january february march april may june july august september october november december".split(
      " ",
    );
  return evidence.some((entry) => {
    if (
      entry.source !== "applicant" ||
      !new RegExp(`^/(?:experiences|education)/\\d+/${field}$`, "u").test(
        entry.path,
      )
    )
      return false;
    const quote = entry.quote.trim();
    if (/^\d{4}-\d{2}(?:-\d{2})?$/u.test(quote))
      return quote === canonical || (!day && quote.startsWith(canonical + "-"));
    const match = /^([a-z]+)\s+(\d{4})$/iu.exec(quote);
    if (!match) return false;
    const month = months.indexOf((match[1] ?? "").toLowerCase()) + 1;
    return (
      month > 0 && canonical === `${match[2]}-${String(month).padStart(2, "0")}`
    );
  });
}
