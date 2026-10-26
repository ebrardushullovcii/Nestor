import {
  normalizeFormQuestionPrompt,
  type CandidateReusableAnswer,
  type SavedOptionFallback,
} from "@nestor/contracts";

import { isAnswerFromThisApplication } from "./application-facts";
import { normalizeSignal } from "./control-classification";
import type { ApplyAgentConfig, ApplyFormControl } from "./types";

// "Name (Local name)" and "Name [XK]" are the same choice as "Name".
const qualifier = /\s*[([][^)\]]*[)\]]\s*/gu;

/**
 * Where a saved choice sits in a list, spelling only. A choice that matches
 * only part of a longer one ("United States" in "United States Minor Outlying
 * Islands") is no match: the list may or may not mean it, so nothing is chosen
 * and nothing is skipped on that reading.
 */
export function strictOptionMatch(
  options: readonly string[],
  desired: string,
):
  | { kind: "match"; value: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" } {
  const wanted = normalizeSignal(desired);
  if (!wanted) return { kind: "none" };
  // The same list read twice is one list.
  options = [
    ...new Map(
      options.map((option) => [normalizeSignal(option), option]),
    ).values(),
  ];
  const exact = options.find((option) => normalizeSignal(option) === wanted);
  if (exact) return { kind: "match", value: exact };
  const qualified = options.filter(
    (option) => normalizeSignal(option.replace(qualifier, " ")) === wanted,
  );
  const [only] = qualified;
  if (qualified.length === 1 && only) return { kind: "match", value: only };
  const near = options.filter((option) => {
    const normalized = normalizeSignal(option);
    return (
      normalized.length > 0 &&
      (` ${normalized} `.includes(` ${wanted} `) ||
        ` ${wanted} `.includes(` ${normalized} `))
    );
  });
  return near.length > 0
    ? { kind: "ambiguous", candidates: near }
    : { kind: "none" };
}

/**
 * The person's saved fallback rule for this exact picker, when it applies.
 *
 * Only the question the rule was saved for, word for word, and only while that
 * picker is required and still unanswered: a rule never decides another
 * question, an optional field or a choice already made. An answer saved for
 * another application stays with that application.
 */
export function savedPickerRule(
  control: ApplyFormControl,
  prompt: string,
  config: Pick<ApplyAgentConfig, "application" | "sources">,
): { saved: CandidateReusableAnswer; rule: SavedOptionFallback } | null {
  if (
    (control.kind !== "select" && control.kind !== "combobox") ||
    !control.required ||
    control.answered ||
    control.disabled ||
    !control.visible
  )
    return null;
  const asked = normalizeFormQuestionPrompt(prompt);
  const rules = config.sources.reusableAnswers.filter(
    (saved) =>
      saved.optionFallback &&
      !saved.needsConfirmation &&
      normalizeFormQuestionPrompt(saved.question) === asked &&
      (!saved.applicationScope ||
        isAnswerFromThisApplication(
          saved,
          config.application,
          config.sources.posting.location,
        )),
  );
  const [first] = rules;
  // Two different rules for one question decide nothing.
  if (
    !first?.optionFallback ||
    rules.some(
      (saved) =>
        JSON.stringify(saved.optionFallback) !==
        JSON.stringify(first.optionFallback),
    )
  )
    return null;
  return { saved: first, rule: first.optionFallback };
}
