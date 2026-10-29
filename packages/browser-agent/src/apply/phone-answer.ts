import { normalizeFormQuestionPrompt } from "@nestor/contracts";
import { fieldNamesAnotherPerson } from "./github-username";
import type { ApplyFormControl } from "./types";

// ITU country calling codes, not country-of-residence evidence. Shared codes
// (notably +1 and +7) deliberately establish no country or work permission.
const CALLING_CODES = new Set(
  `1 7 20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98
211 212 213 216 218 220 221 222 223 224 225 226 227 228 229 230 231 232 233 234 235 236 237 238 239 240 241 242 243 244 245 246 247 248 249 250 251 252 253 254 255 256 257 258 260 261 262 263 264 265 266 267 268 269 290 291 297 298 299
350 351 352 353 354 355 356 357 358 359 370 371 372 373 374 375 376 377 378 380 381 382 383 385 386 387 389 420 421 423 500 501 502 503 504 505 506 507 508 509 590 591 592 593 594 595 596 597 598 599 670 672 673 674 675 676 677 678 679 680 681 682 683 685 686 687 688 689 690 691 692 850 852 853 855 856 880 886 960 961 962 963 964 965 966 967 968 970 971 972 973 974 975 976 977 992 993 994 995 996 998`.split(
    /\s+/u,
  ),
);

/** Only an explicitly international saved number supplies a calling code. */
export function phoneCallingCode(number: string): string | null {
  if (!/^\+[1-9][\d\s().-]+$/u.test(number.trim())) return null;
  const digits = number.replace(/\D/gu, "");
  for (let length = 1; length <= 3; length++) {
    const code = digits.slice(0, length);
    if (CALLING_CODES.has(code) && digits.length > length) return `+${code}`;
  }
  return null;
}

export function isPhoneCodeControl(control: ApplyFormControl): boolean {
  return (
    !fieldNamesAnotherPerson(control) &&
    [
      "phone country code",
      "phone code",
      "calling code",
      "dialing code",
      "dialling code",
      "telephone country code",
    ].includes(normalizeFormQuestionPrompt(control.label))
  );
}

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
  // Some native phone widgets use a button opening a dialog, not a combobox.
  // The reader binds its current displayed code directly to this tel input.
  if (control.phoneCallingCode !== undefined)
    return (
      control.telInput === true &&
      control.visible &&
      !control.disabled &&
      !control.invalid &&
      !fieldNamesAnotherPerson(control) &&
      /^\+[1-9]\d{0,2}$/u.test(control.phoneCallingCode) &&
      `${control.phoneCallingCode.slice(1)}${actual}` === expected
    );
  const picker = phoneCountryPicker(control, controls);
  if (!picker) return false;
  const codes = [
    ...picker.selectedOptionLabel.matchAll(/\+([1-9]\d{0,2})(?!\d)/gu),
  ];
  return codes.length === 1 && `${codes[0]?.[1]}${actual}` === expected;
}

/** Only the selected calling-code companion of one number in this form/group. */
export function phoneCountryPicker(
  control: ApplyFormControl,
  controls: readonly ApplyFormControl[],
): ApplyFormControl | null {
  if (!control.scopeKey || (!control.telInput && !phoneLabel(control.label)))
    return null;
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
  if (phones.length !== 1 || phones[0]?.ref !== control.ref) return null;
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
  if (pickers.length !== 1 || !picker || picker.invalid) return null;
  const codes = [
    ...picker.selectedOptionLabel.matchAll(/\+([1-9]\d{0,2})(?!\d)/gu),
  ];
  return codes.length === 1 ? picker : null;
}
