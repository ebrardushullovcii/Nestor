import { normalizeFormQuestionPrompt } from "@nestor/contracts";
import { fieldNamesAnotherPerson } from "./github-username";
import type { ApplyFormControl } from "./types";

export const phoneLabels = [
  "phone",
  "phone number",
  "telephone",
  "telephone number",
] as const;
const phoneLabel = (label: string) =>
  phoneLabels.some((value) => value === normalizeFormQuestionPrompt(label));
const digits = (value: string): string | null =>
  /^\+?[\d\s().-]+$/u.test(value.trim()) && /\d/u.test(value)
    ? value.replace(/\D/gu, "")
    : null;

/** Formatting can change; the recorded number's digits cannot. */
export function phoneAnswerMatches(
  recorded: string,
  answer: string,
  control: ApplyFormControl,
  controls: readonly ApplyFormControl[],
): boolean {
  if (recorded.trim() === answer.trim()) return true;
  const expected = digits(recorded),
    actual = digits(answer);
  if (!expected || !actual) return false;
  if (expected === actual) return true;
  // An explicit international answer cannot be interpreted as national digits.
  if (answer.trim().startsWith("+") || !control.scopeKey) return false;
  const peers = controls.filter(
    (candidate) =>
      candidate.visible &&
      !candidate.disabled &&
      candidate.scopeKey === control.scopeKey &&
      normalizeFormQuestionPrompt(candidate.groupLabel) ===
        normalizeFormQuestionPrompt(control.groupLabel),
  );
  const phones = peers.filter(
    (candidate) =>
      candidate.telInput ||
      (candidate.kind === "text" && phoneLabel(candidate.label)),
  );
  if (phones.length !== 1 || phones[0]?.ref !== control.ref) return false;
  const pickers = peers.filter(
    (candidate) =>
      (candidate.kind === "combobox" || candidate.kind === "select") &&
      !fieldNamesAnotherPerson(candidate) &&
      /\+[1-9]\d{0,2}(?!\d)/u.test(candidate.selectedOptionLabel) &&
      (phoneLabel(candidate.label) ||
        [
          "country",
          "country code",
          "phone country",
          "phone country code",
          "calling code",
          "dialing code",
          "dialling code",
        ].includes(normalizeFormQuestionPrompt(candidate.label))),
  );
  const picker = pickers[0];
  if (pickers.length !== 1 || !picker || picker.invalid) return false;
  const codes = [
    ...picker.selectedOptionLabel.matchAll(/\+([1-9]\d{0,2})(?!\d)/gu),
  ];
  return codes.length === 1 && `${codes[0]?.[1]}${actual}` === expected;
}
