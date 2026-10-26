import type {
  ApplyAnswer,
  ApplyAnswerSources,
  ApplyFormControl,
} from "./types";
import { normalizeSignal } from "./control-classification";

export function asksListingDiscovery(question: string): boolean {
  return (
    /\b(?:how|where)\b.*\b(?:hear|heard|learn|learned|find|found|discover)\b.*\b(?:job|role|position|opportunity|opening|us)\b/iu.test(
      question,
    ) || /\b(?:job|listing|application) source\b/iu.test(question)
  );
}

function isChoiceGroupControl(control: ApplyFormControl): boolean {
  return (
    !!control.choiceGroupKey &&
    (control.kind === "radio" ||
      (control.kind === "checkbox" &&
        control.answerControlType === "multi_choice"))
  );
}

/** A section title never turns its ordinary child fields into source questions. */
export function asksListingDiscoveryControl(
  control: ApplyFormControl,
): boolean {
  return (
    asksListingDiscovery(control.label) ||
    (isChoiceGroupControl(control) && asksListingDiscovery(control.groupLabel))
  );
}

function sourceCategory(label: string): "board" | "company" | null {
  // Read the source's recorded description, never an employer/provider allow-list.
  if (/\bjob[ -]?boards?\b/iu.test(label)) return "board";
  if (
    /\b(?:company|employer)(?:'s)? (?:website|careers?(?: (?:page|site|website))?)\b/iu.test(
      label,
    )
  )
    return "company";
  return null;
}

/** Map recorded provenance onto this form's categories without inventing a referral. */
export function listingDiscoveryAnswer(
  control: ApplyFormControl,
  sources: ApplyAnswerSources,
  siblings: readonly ApplyFormControl[] = [],
): ApplyAnswer | null {
  const source = sources.listingDiscovery;
  if (!source?.label.trim()) return null;
  let value = source.label.trim();
  const options = isChoiceGroupControl(control)
    ? siblings
        .filter(
          (candidate) =>
            candidate.kind === control.kind &&
            candidate.choiceGroupKey === control.choiceGroupKey &&
            candidate.visible &&
            !candidate.disabled,
        )
        .map((candidate) => candidate.label || candidate.value)
    : control.options;
  if (options.length) {
    const category = sourceCategory(source.label);
    let host = "";
    try {
      host = new URL(source.url).hostname.replace(/^www\./u, "");
    } catch {
      /* Old rows can lack a usable URL. */
    }
    value =
      options.find((option) =>
        [source.label, host].some(
          (name) => !!name && normalizeSignal(name) === normalizeSignal(option),
        ),
      ) ??
      options.find((option) =>
        category === "board"
          ? /^(?:an? |online )?job[ -]?board(?: website)?$/iu.test(
              option.trim(),
            )
          : category === "company" &&
            /^(?:(?:the |your )?company website|(?:company )?careers? (?:page|site|website))$/iu.test(
              option.trim(),
            ),
      ) ??
      options.find((option) =>
        /^(?:other|other source)$/iu.test(option.trim()),
      ) ??
      "";
    if (!value) return null;
  } else if (["select", "combobox", "radio"].includes(control.kind))
    return null;
  return {
    value,
    kind: control.questionKind,
    sourceKind: "posting",
    sourceId: "listingDiscovery",
    provenanceLabel: "where Nestor found this listing",
    groundedIn: [source.label, source.url],
  };
}
