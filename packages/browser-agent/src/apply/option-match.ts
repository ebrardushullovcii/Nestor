import { normalizeSignal } from "./control-classification";

/**
 * The exact options a multi-select answer names. A JSON list is read as is.
 * A comma-joined list (how the review card shows it) is read only when the
 * form's own labels split it exactly one way, so "Writing, editing" stays
 * one option; two possible readings mean no answer, never a guess.
 */
export function choiceAnswerValues(
  answer: string,
  options: readonly string[],
): string[] | null {
  const norm = (value: string) =>
    value
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/\s*,\s*/gu, ", ");
  const exact = (value: string) => {
    const matches = options.filter((option) => norm(option) === norm(value));
    return matches.length === 1 ? matches[0] : null;
  };
  let values: unknown;
  try {
    values = JSON.parse(answer);
  } catch {
    const pieces = answer.split(/\s*,\s*/u);
    // readings[i]: the ways pieces[i..] split into options (at most two kept).
    const readings: string[][][] = [];
    readings[pieces.length] = [[]];
    for (let start = pieces.length - 1; start >= 0; start -= 1) {
      const here: string[][] = [];
      for (let end = start + 1; end <= pieces.length; end += 1) {
        const option = exact(pieces.slice(start, end).join(", "));
        if (!option) continue;
        for (const rest of readings[end] ?? [])
          if (here.length < 2) here.push([option, ...rest]);
      }
      readings[start] = here;
    }
    const [only, other] = readings[0] ?? [];
    if (!only || other) return null;
    values = only;
  }
  if (
    !Array.isArray(values) ||
    !values.every((value) => typeof value === "string")
  )
    return null;
  const matched = values.map(exact);
  return matched.every((value): value is string => value !== null)
    ? [...new Set(matched)]
    : null;
}

/** The plain ways people write yes and no, in the words a form offers. */
const AFFIRMATIVE_SYNONYMS = new Set([
  "yes",
  "y",
  "true",
  "i do",
  "i have",
  "affirmative",
]);
const NEGATIVE_SYNONYMS = new Set([
  "no",
  "n",
  "none",
  "nope",
  "false",
  "i do not",
  "i have not",
  "negative",
  "not applicable",
  "n a",
]);

/**
 * Fit the model's chosen answer to the options a control actually offers.
 *
 * Returns the option label to choose, or null when nothing on the list says
 * the same thing. This is spelling, not judgment: the model picked the
 * answer; this finds the exact label the page uses for it.
 */
export function matchOption(
  options: readonly string[],
  desiredValue: string,
): string | null {
  const desired = normalizeSignal(desiredValue);
  if (!desired) {
    return null;
  }
  const exact = options.find((option) => normalizeSignal(option) === desired);
  if (exact) {
    return exact;
  }
  const yesish =
    AFFIRMATIVE_SYNONYMS.has(desired) || desired.startsWith("yes ");
  const noish = NEGATIVE_SYNONYMS.has(desired) || desired.startsWith("no ");
  if (yesish || noish) {
    const wanted = yesish ? "yes" : "no";
    const affirmative = options.find((option) => {
      const normalized = normalizeSignal(option);
      return normalized === wanted || normalized.startsWith(`${wanted} `);
    });
    if (affirmative) {
      return affirmative;
    }
  }
  const contained = options.filter((option) => {
    const normalized = normalizeSignal(option);
    return (
      normalized.length > 0 &&
      (normalized === desired || normalized.includes(desired))
    );
  });
  if (contained.length === 1) {
    return contained[0] ?? null;
  }
  // One choice the answer is the beginning of, and only one, is that choice:
  // "Bach" on a list offering "Bachelor's degree" and "Master's degree".
  const prefixed = options.filter((option) =>
    normalizeSignal(option).startsWith(desired),
  );
  return prefixed.length === 1 ? (prefixed[0] ?? null) : null;
}
