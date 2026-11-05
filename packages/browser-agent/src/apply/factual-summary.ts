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
