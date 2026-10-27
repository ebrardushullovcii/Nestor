import {
  normalizeFormQuestionPrompt,
  preserveTechnologyTokens,
  type CandidateReusableAnswer,
  type SavedOptionFallback,
} from "@nestor/contracts";

import {
  isAnswerFromThisApplication,
  isExplicitResidenceCountryControl,
} from "./application-facts";
import { normalizeSignal } from "./control-classification";
import type { ApplyAgentConfig, ApplyFormControl } from "./types";

// "Name (Local name)" and "Name [XK]": a name followed by bracketed words.
const qualifier = /\s*[([]([^)\]]*)[)\]]\s*/gu;

const spelling = (value: string) =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// Languages whose names for a place count as the same choice, by script and
// region, so "Albania (Shqipëri)" and "Japan (日本)" are Albania and Japan.
const VARIANT_LANGUAGES = [
  "sq",
  "de",
  "fr",
  "es",
  "it",
  "pt",
  "nl",
  "pl",
  "sv",
  "nb",
  "da",
  "fi",
  "cs",
  "sk",
  "sl",
  "hr",
  "sr",
  "bs",
  "mk",
  "bg",
  "ro",
  "hu",
  "el",
  "tr",
  "ru",
  "uk",
  "be",
  "lt",
  "lv",
  "et",
  "ga",
  "cy",
  "is",
  "mt",
  "ar",
  "he",
  "fa",
  "hi",
  "bn",
  "ur",
  "zh",
  "ja",
  "ko",
  "th",
  "vi",
  "id",
  "ms",
  "fil",
  "sw",
  "am",
  "ka",
  "hy",
  "az",
  "kk",
  "uz",
  "mn",
  "ne",
  "si",
  "ta",
  "km",
  "lo",
  "my",
  "ca",
  "eu",
  "gl",
  "lb",
];

let regionNames: Map<string, Set<string>> | null = null;

/**
 * Every spelling of a place the run accepts as the same choice: its name in
 * the languages above and its own region code. Built once from the
 * platform's region names.
 */
function placeSpellings(name: string): Set<string> | null {
  if (!regionNames) {
    regionNames = new Map();
    const english = new Intl.DisplayNames(["en"], { type: "region" });
    const local = VARIANT_LANGUAGES.map(
      (language) => new Intl.DisplayNames([language], { type: "region" }),
    );
    for (let first = 65; first <= 90; first++)
      for (let second = 65; second <= 90; second++) {
        const code = String.fromCharCode(first, second);
        let label: string | undefined;
        try {
          label = english.of(code);
        } catch {
          continue;
        }
        if (!label || label === code || /unknown/iu.test(label)) continue;
        const spellings = new Set([spelling(code)]);
        for (const names of local) {
          const named = names.of(code);
          if (named && named !== code) spellings.add(spelling(named));
        }
        regionNames.set(spelling(label), spellings);
      }
  }
  return regionNames.get(spelling(name)) ?? null;
}

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
  const normalized = (value: string) =>
    normalizeSignal(preserveTechnologyTokens(value));
  const wanted = normalized(desired);
  if (!wanted) return { kind: "none" };
  // The same list read twice is one list.
  options = [
    ...new Map(options.map((option) => [normalized(option), option])).values(),
  ];
  const exact = options.find((option) => normalized(option) === wanted);
  if (exact) return { kind: "match", value: exact };
  // A qualifier counts only when it is the same name in another language or
  // script, or the place's own code; "China (Hong Kong SAR)" is a different
  // choice from "China", and is handed over.
  const variants = placeSpellings(desired);
  const qualified = options.filter((option) => {
    if (normalized(option.replace(qualifier, " ")) !== wanted) return false;
    const qualifiers = [...option.matchAll(qualifier)].map((match) =>
      spelling(match[1] ?? ""),
    );
    return (
      qualifiers.length > 0 &&
      variants !== null &&
      qualifiers.every((entry) => variants.has(entry))
    );
  });
  const [only] = qualified;
  if (qualified.length === 1 && only) return { kind: "match", value: only };
  const near = options.filter((option) => {
    const text = normalized(option);
    return (
      text.length > 0 &&
      (` ${text} `.includes(` ${wanted} `) ||
        ` ${wanted} `.includes(` ${text} `))
    );
  });
  return near.length > 0
    ? { kind: "ambiguous", candidates: near }
    : { kind: "none" };
}

/**
 * The person's saved fallback rule for this exact picker, when it applies.
 *
 * Match the saved question, or an explicit alias of the person's residence
 * country. Only required, unanswered pickers run the rule; evidence checks can
 * also read it after filling. Application-scoped rules stay with that application.
 */
export function savedPickerRule(
  control: ApplyFormControl,
  prompt: string,
  config: Pick<ApplyAgentConfig, "application" | "sources">,
  options: { forEvidence?: boolean } = {},
): { saved: CandidateReusableAnswer; rule: SavedOptionFallback } | null {
  if (
    (control.kind !== "select" && control.kind !== "combobox") ||
    // The page's own required flag: the model's reading never turns an
    // optional picker into one whose rule can skip the application.
    !(control.requiredOnPage ?? control.required) ||
    (!options.forEvidence && control.answered) ||
    control.disabled ||
    !control.visible
  )
    return null;
  const questionKey = (value: string) =>
    normalizeFormQuestionPrompt(preserveTechnologyTokens(value));
  const asked = questionKey(prompt);
  const rules = config.sources.reusableAnswers.filter(
    (saved) =>
      saved.optionFallback &&
      !saved.needsConfirmation &&
      (questionKey(saved.question) === asked ||
        (isExplicitResidenceCountryControl(control) &&
          normalizeSignal(saved.optionFallback.primary) ===
            normalizeSignal(config.sources.profile.currentCountry ?? "") &&
          (() => {
            const parts = saved.question.split(/\s+[—–]\s+/u);
            return isExplicitResidenceCountryControl({
              ...control,
              label: parts.at(-1) ?? "",
              groupLabel: parts.slice(0, -1).join(" — "),
            });
          })())) &&
      (!control.repeatedQuestion || !!saved.applicationScope) &&
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
