import { preserveTechnologyTokens } from "@nestor/contracts";

const normalized = (text: string) =>
  preserveTechnologyTokens(text)
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
/** The same statement boundaries for raw text and for its normalized form. */
const STATEMENT_BREAK = /[;\n]+|[.!?](?:\s+|$)/u;
const statement = (text: string) =>
  // A resume bullet commonly omits its first-person subject. Adding "I"
  // changes neither the claim nor its negation, qualification or conditions.
  normalized(text).replace(/^i\s+/u, "");
const statements = (text: string) =>
  text.split(STATEMENT_BREAK).map(statement).filter(Boolean);

/** Words a source label may carry without being material: articles, owners. */
const LABEL_STOPWORDS = new Set(["the", "a", "an", "my", "your", "of"]);
/**
 * Negation, condition and time words. A label carrying one of them changes
 * what the line says, so it is never treated as decoration.
 */
const LABEL_VETO = new Set([
  // English
  "only",
  "no",
  "not",
  "never",
  "without",
  "if",
  "when",
  "while",
  "unless",
  "except",
  "before",
  "after",
  "until",
  "since",
  "currently",
  "previously",
  "formerly",
  "under",
  // German
  "nur",
  "nicht",
  "kein",
  "keine",
  "nie",
  "niemals",
  "ohne",
  "wenn",
  "falls",
  "während",
  "außer",
  "vor",
  "nach",
  "bis",
  "seit",
  "derzeit",
  "früher",
  "ehemals",
  "unter",
  // French
  "seulement",
  "ne",
  "pas",
  "non",
  "jamais",
  "sans",
  "si",
  "quand",
  "lorsque",
  "pendant",
  "sauf",
  "avant",
  "après",
  "jusqu",
  "depuis",
  "actuellement",
  "auparavant",
  "anciennement",
  "sous",
  // Spanish
  "solo",
  "sólo",
  "nunca",
  "sin",
  "cuando",
  "mientras",
  "salvo",
  "excepto",
  "antes",
  "después",
  "hasta",
  "desde",
  "actualmente",
  "anteriormente",
  "bajo",
  // Portuguese
  "apenas",
  "só",
  "não",
  "sem",
  "se",
  "enquanto",
  "exceto",
  "depois",
  "até",
  "atualmente",
  "sob",
]);
const LABELLED = /^\s*([^:\n]{1,80}):\s*(\S[\s\S]*)$/u;

/**
 * The remainder of one `Label: statement` source line when the label only
 * restates the question ("Reporting routine:" for "Describe your reporting
 * routine"): 1-4 words, at least one that is not an article, no digit, no
 * negation, condition or time word, every such word in the question, and a
 * remainder that is not itself labelled. Otherwise null.
 */
function decorativeRemainder(segment: string, question: string): string | null {
  const match = LABELLED.exec(segment);
  if (!match) return null;
  const [, prefix = "", remainder = ""] = match;
  if (/\p{N}/u.test(prefix) || LABELLED.test(remainder)) return null;
  const words = normalized(prefix).split(" ").filter(Boolean);
  if (words.length < 1 || words.length > 4) return null;
  const material = words.filter((word) => !LABEL_STOPWORDS.has(word));
  if (!material.length || words.some((word) => LABEL_VETO.has(word)))
    return null;
  const asked = new Set(normalized(question).split(" ").filter(Boolean));
  return material.every((word) => asked.has(word)) ? remainder.trim() : null;
}

/** Source statements, plus decorative-label remainders the question restates. */
function recordedStatements(
  sources: readonly string[],
  question: string | undefined,
): Set<string> {
  const recorded = new Set(sources.flatMap(statements));
  if (question)
    for (const source of sources)
      for (const segment of source.split(STATEMENT_BREAK)) {
        const remainder = decorativeRemainder(segment, question);
        const value = remainder ? statement(remainder) : "";
        if (value) recorded.add(value);
      }
  return recorded;
}

/**
 * Keep complete source statements, including their negations and conditions.
 * With the question, a source line whose label only restates that question
 * also counts by its remainder; the answer still has to match whole
 * statements, with nothing joined.
 */
export function factualSummaryIsSourced(
  answer: string,
  sources: readonly string[],
  question?: string,
): boolean {
  const claims = statements(answer);
  const recorded = recordedStatements(sources, question);
  return claims.length > 0 && claims.every((claim) => recorded.has(claim));
}

/**
 * The one source statement, in its own words, whose label restates this
 * question. Null when there is none or several different ones.
 */
export function labelledStatementFor(
  question: string,
  sources: readonly string[],
): string | null {
  const found = new Map<string, string>();
  for (const source of sources)
    for (const segment of source.split(STATEMENT_BREAK)) {
      const remainder = decorativeRemainder(segment, question);
      const value = remainder ? statement(remainder) : "";
      if (value && !found.has(value)) found.set(value, remainder!.trim());
    }
  return found.size === 1 ? ([...found.values()][0] ?? null) : null;
}

export function asksForSpecificStory(question: string): boolean {
  return /\b(?:tell (?:us|me) about a time|describe a situation)\b/iu.test(
    question,
  );
}

/** Model-accepted source binding may cross synonymous question labels.
 * A complete statement after a short heading keeps all its own conditions.
 * Labels carrying jurisdiction, dates, negation or qualifications stay material.
 */
export function factualSummaryCitationIsSourced(
  answer: string,
  sources: readonly string[],
  question: string,
): boolean {
  if (factualSummaryIsSourced(answer, sources, question)) return true;
  const safe = sources.map((source) =>
    source
      .split(STATEMENT_BREAK)
      .map((segment) => {
        const match = LABELLED.exec(segment);
        if (!match) return segment;
        const [, prefix = "", remainder = ""] = match;
        const words = normalized(prefix).split(" ").filter(Boolean);
        if (
          words.length > 4 ||
          /\p{N}/u.test(prefix) ||
          words.some((word) => LABEL_VETO.has(word)) ||
          LABELLED.test(remainder)
        )
          return segment;
        // A heading cannot discard a named employer/place or an explicit scope.
        const names = prefix
          .trim()
          .split(/\s+/u)
          .slice(1)
          .some((word) => /^\p{Lu}/u.test(word));
        if (names || /\b(?:for|at|in|during|from|to|by|as|on)\b/iu.test(prefix))
          return segment;
        const stem = (word: string) => word.replace(/(?:ing|s)$/u, "");
        const subject = words.find((word) => !LABEL_STOPWORDS.has(word));
        const context = new Set(
          normalized(`${question} ${answer}`).split(" ").map(stem),
        );
        if (!subject || !context.has(stem(subject))) return segment;
        return remainder;
      })
      .join("\n"),
  );
  return factualSummaryIsSourced(answer, safe, question);
}

/** Clear changes to polarity, explicit bounds and time direction never become paraphrases. */
export function factualSummaryQualificationsMatch(
  answer: string,
  evidence: readonly { quote: string; scalar: unknown }[],
): boolean {
  const text = normalized(answer);
  const categories = [
    /\b(?:no|not|never|without|nicht|kein|keine|jamais|nunca|nao)\b/u,
    /\b(?:only|solely|exclusively|nur|seulement|apenas)\b/u,
    /\b(?:after|nach|apres|depois)\b/u,
    /\b(?:before|vor|avant|antes)\b/u,
    /\b(?:until|bis|jusqu|ate)\b/u,
    /\b(?:unless|except|außer|sauf|salvo|exceto)\b/u,
    /\b(?:if|when|while|wenn|falls|lorsque|cuando|enquanto)\b/u,
  ];
  const values = evidence.flatMap(({ quote, scalar }) => {
    if (typeof scalar !== "string") return [];
    const cited = normalized(quote);
    return scalar.split(STATEMENT_BREAK).filter((segment) => {
      const value = normalized(segment);
      return value && (value.includes(cited) || cited.includes(value));
    });
  });
  const relevant = values.length
    ? values.map(normalized)
    : evidence.map((item) => normalized(item.quote));
  if (
    categories.some(
      (category) =>
        relevant.some((value) => category.test(value)) !== category.test(text),
    )
  )
    return false;
  // Exact numeric premises remain exact; this lane does not calculate new facts.
  const digits = (value: string) =>
    [...value.matchAll(/\b\d+(?:[.,]\d+)*\b/gu)].map((match) => match[0]);
  const offered = new Set(evidence.flatMap((item) => digits(item.quote)));
  if (digits(answer).some((value) => !offered.has(value))) return false;
  const technologies = (value: string) =>
    [...value.matchAll(/\b(?:csharp|cplusplus|fsharp|dotnet)\b/gu)].map(
      (match) => match[0],
    );
  const known = new Set(relevant.flatMap(technologies));
  return technologies(text).every((value) => known.has(value));
}
