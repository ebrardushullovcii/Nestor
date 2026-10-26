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

/** Use the recorded source, or an explicit Other option, without inventing a referral. */
export function listingDiscoveryAnswer(
  control: ApplyFormControl,
  sources: ApplyAnswerSources,
): ApplyAnswer | null {
  const source = sources.listingDiscovery;
  if (!source?.label.trim()) return null;
  let value = source.label.trim();
  if (control.options.length) {
    let host = "";
    try {
      host = new URL(source.url).hostname.replace(/^www\./u, "");
    } catch {
      /* Old rows can lack a usable URL. */
    }
    value =
      control.options.find((option) =>
        [source.label, host].some(
          (name) => !!name && normalizeSignal(name) === normalizeSignal(option),
        ),
      ) ??
      control.options.find((option) =>
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
