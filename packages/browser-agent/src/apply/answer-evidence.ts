import { requiresSavedNationalityAnswer } from "./person-nationality";
/** Deterministic relevance checks. A positive model verdict cannot override these. */
export interface AnswerEvidence {
  source: string;
  path: string;
  quote: string;
}

const normalize = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\bjs\b/gu, "javascript")
    .replace(/\bts\b/gu, "typescript")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const scalar = (value: string) =>
  /^(?:yes|no|true|false|[-+]?\d+(?:[.,]\d+)?\+?%?)$/iu.test(value.trim());
const opinion =
  /\b(?:like[sd]?|love[sd]?|hate[sd]?|enjoy\w*|want\w*|wish\w*|proud|passion\w*|excited|interested|strengths?|strongest)\b/iu;
const preference =
  /\b(?:go[\s-]*to|best\s+(?:time|contact\s+time)|top\s+skill|prefer(?:ence|red|s)?|favou?rites?)\b/iu;
const motivation =
  /\b(?:why|what)\b.*\b(?:join|apply|work|company|us|role|position|attracts?|appeals?|interests?)\b|\b(?:cover|application|motivation)\s+letter\b|\b(?:motivation|motivates|interested in (?:this|the) (?:role|position))\b/iu;

function savedEvidence(
  entry: AnswerEvidence,
  applicant: unknown,
): { question: string; answer: string } | null {
  const match = /^\/savedAnswers\/(\d+)\/answer$/u.exec(entry.path);
  if (
    entry.source !== "applicant" ||
    !match ||
    !applicant ||
    typeof applicant !== "object"
  )
    return null;
  const saved = (applicant as Record<string, unknown>).savedAnswers;
  const item: unknown = Array.isArray(saved) ? saved[Number(match[1])] : null;
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  return typeof record.question === "string" &&
    typeof record.answer === "string"
    ? { question: record.question, answer: record.answer }
    : null;
}

function labelMatches(
  question: string,
  entry: AnswerEvidence,
  applicant: unknown,
): boolean {
  const saved = savedEvidence(entry, applicant);
  if (saved) return normalize(saved.question) === normalize(question);
  if (entry.source !== "applicant" || !entry.path) return false;
  const label =
    entry.path.split("/").at(-1)?.replace(/~1/gu, "/").replace(/~0/gu, "~") ??
    "";
  const asked = normalize(question);
  // Structured Profile fields have a fixed meaning. A repeated value such as
  // No in an unrelated field is never evidence about prior employer history.
  if (entry.path.startsWith("/workEligibility/")) {
    if (/\b(?:previous|prior|before|worked|consulted)\b/iu.test(question))
      return false;
    const keys: Record<string, RegExp> = {
      "Need visa sponsorship": /\bsponsor(?:ship)?\b/iu,
      "Willing to relocate": /\brelocat\w*/iu,
      "Willing to travel": /\btravel\w*/iu,
      "Can work remotely": /\bremote\w*/iu,
      "Notice period in days": /\bnotice\b/iu,
      "Available start date": /\b(?:start date|available)\b/iu,
      "Security clearance": /\bsecurity clearance\b/iu,
    };
    return keys[label]?.test(question) ?? false;
  }
  if (entry.path === "/yearsExperience")
    return /\byears?\b/iu.test(question) && !skillYearClaim(question, "1");
  const words = normalize(label.replace(/([a-z])([A-Z])/gu, "$1 $2"));
  return words.length > 2 && asked === words;
}

function employmentMonthEvidence(
  question: string,
  answer: string,
  evidence: readonly AnswerEvidence[],
): boolean | null {
  if (!/^\d{4}-\d{2}(?:-\d{2})?$/u.test(answer)) return null;
  const asked = normalize(question).replace(/ optional$/u, "");
  const field = /\b(?:from|start date)$/u.test(asked)
    ? "startDate"
    : /\b(?:to|end date)$/u.test(asked)
      ? "endDate"
      : null;
  if (!field) return null;
  const months =
    "january february march april may june july august september october november december".split(
      " ",
    );
  return evidence.some((entry) => {
    if (
      entry.source !== "applicant" ||
      !new RegExp(`^/experiences/\\d+/${field}$`, "u").test(entry.path)
    )
      return false;
    const quote = entry.quote.trim();
    if (/^\d{4}-\d{2}(?:-\d{2})?$/u.test(quote))
      return (
        quote === answer ||
        (answer.length === 7 && quote.startsWith(answer + "-"))
      );
    const match = /^([a-z]+)\s+(\d{4})$/iu.exec(quote);
    if (!match) return false;
    const month = months.indexOf(match[1].toLowerCase()) + 1;
    return (
      month > 0 && answer === `${match[2]}-${String(month).padStart(2, "0")}`
    );
  });
}

function skillYearClaim(
  question: string,
  answer: string,
): { years: string; topics: string[] } | null {
  const count =
    /\b(\d+(?:\.\d+)?)\+?\s*(?:years?|yrs?)\b/iu.exec(answer)?.[1] ??
    (/\byears?\b/iu.test(question) && /^\d+(?:\.\d+)?\+?$/u.test(answer.trim())
      ? answer.replace(/\+$/u, "").trim()
      : null);
  if (!count) return null;
  const text = normalize(/\byears?\b/iu.test(question) ? question : answer);
  // Keep the subject words, rather than allowing a listed skill plus total
  // career years to stand in for the duration of using that skill.
  const ignored = new Set(
    "a an the of in with using used use and or how many long years year yrs experience experienced professional professionally overall total career work working have has do you your i me my ve specifically hands on for describe tell us about application questions relevant development software engineering engineer".split(
      " ",
    ),
  );
  const topics = text
    .split(" ")
    .filter((word) => !ignored.has(word) && !/^\d+$/u.test(word));
  return topics.length ? { years: count, topics: [...new Set(topics)] } : null;
}

function quoteStatesSkillYears(
  quote: string,
  claim: { years: string; topics: string[] },
): boolean {
  return quote.split(/[;\n]|[.!?](?:\s|$)/u).some((clause) => {
    if (/\b(?:overall|total|career)\b/iu.test(clause)) return false;
    const text = normalize(clause);
    const duration = new RegExp(
      `(?:^| )${normalize(claim.years)} (?:years?|yrs?)(?: |$)`,
      "u",
    ).exec(text);
    if (!duration) return false;
    const after = text
      .slice(duration.index + duration[0].length)
      .trim()
      .split(" ");
    const connectors = new Set([
      "of",
      "professional",
      "experience",
      "working",
      "with",
      "in",
      "using",
      "hands",
      "on",
    ]);
    const firstSubject = after.findIndex((word) => !connectors.has(word));
    const subject = after[firstSubject];
    if (
      firstSubject >= 0 &&
      firstSubject <= 4 &&
      subject !== undefined &&
      claim.topics.includes(subject) &&
      claim.topics.every((topic) =>
        after.slice(firstSubject, firstSubject + 8).includes(topic),
      )
    )
      return true;
    const before = text.slice(0, duration.index).trim().split(" ").slice(-8);
    return (
      claim.topics.every((topic) => before.includes(topic)) &&
      before.every(
        (word) =>
          claim.topics.includes(word) ||
          ["and", "or", "with", "using", "for"].includes(word),
      )
    );
  });
}

export function evidenceFitsQuestion(input: {
  question: string;
  answer: string;
  evidence: readonly AnswerEvidence[];
  applicant: unknown;
}): boolean {
  const { question, answer, evidence, applicant } = input;
  const exactSaved = evidence.some((entry) => {
    const saved = savedEvidence(entry, applicant);
    return (
      saved &&
      normalize(saved.question) === normalize(question) &&
      normalize(saved.answer) === normalize(answer)
    );
  });
  if (requiresSavedNationalityAnswer(question)) return exactSaved;
  if (
    preference.test(question) ||
    preference.test(answer) ||
    (!motivation.test(question) &&
      (opinion.test(question) || opinion.test(answer)))
  )
    return exactSaved;
  if (exactSaved) return true;
  const month = employmentMonthEvidence(question, answer, evidence);
  if (month !== null) return month;
  if (
    !concreteClaimsSupported(answer, evidence) ||
    !authorizationCountryMatches(question, answer, evidence)
  )
    return false;
  const years = motivation.test(question)
    ? null
    : skillYearClaim(question, answer);
  const namedDuration =
    years &&
    evidence.some(
      (entry) =>
        entry.source !== "posting" && quoteStatesSkillYears(entry.quote, years),
    );
  const affirmativeAuthorization =
    /^(?:yes|true)$/iu.test(answer.trim()) &&
    !/\b(?:previous|prior|before|ever|worked|consulted)\b/iu.test(question) &&
    /\b(?:authori[sz]ed|authorization|eligible)\b.*\bwork\b|\bwork\b.*\b(?:authori[sz]ation|eligibility)\b/iu.test(
      question,
    ) &&
    evidence.some(
      (entry) =>
        entry.source === "applicant" &&
        /^\/workEligibility\/Countries where you can work\/\d+$/u.test(
          entry.path,
        ),
    );
  if (
    scalar(answer) &&
    !namedDuration &&
    !affirmativeAuthorization &&
    !evidence.some(
      (entry) =>
        labelMatches(question, entry, applicant) &&
        normalize(entry.quote) === normalize(answer),
    )
  )
    return false;
  if (years && !exactSaved && !namedDuration) return false;
  return true;
}
import {
  authorizationCountryMatches,
  concreteClaimsSupported,
} from "./concrete-answer-claims";
