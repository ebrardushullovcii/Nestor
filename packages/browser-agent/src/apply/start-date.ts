import { savedAnswerForQuestion } from "./application-facts";
import { fieldNamesAnotherPerson } from "./github-username";
import type { ApplyAnswerSources, ApplyFormControl } from "./types";

export function isStartDateControl(control: ApplyFormControl): boolean {
  return (
    (control.kind === "date" || control.answerControlType === "date") &&
    control.dateInputType !== "month" &&
    !fieldNamesAnotherPerson(control) &&
    !/\b(?:employment history|work history|education|previous (?:job|role|employer))\b/iu.test(
      control.groupLabel,
    ) &&
    ((control.questionKind === "availability" &&
      /^profile\.workEligibility\.(?:availableStartDate|noticePeriodDays)$/u.test(
        control.answerTags?.sourceId ?? "",
      )) ||
      /\b(?:when (?:can|could|would) you start|available to start|earliest start|(?:available|preferred) start date)\b/iu.test(
        control.label,
      ))
  );
}

export function hasStartDateValue(control: ApplyFormControl): boolean {
  if (!isStartDateControl(control) || control.invalid) return false;
  if (canonicalStartDate(control.value)) return true;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(control.value.trim());
  const first = slash?.[1],
    second = slash?.[2],
    year = slash?.[3];
  if (!first || !second || !year) return false;
  return [
    checkedDate(year, first, second),
    checkedDate(year, second, first),
  ].some((value) => value !== null);
}

function iso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function checkedDate(
  year: string | undefined,
  month: string | undefined,
  day: string | undefined,
): string | null {
  if (!year || !month || !day) return null;
  const canonical = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`${canonical}T12:00:00`);
  return Number.isFinite(date.valueOf()) && iso(date) === canonical
    ? canonical
    : null;
}

/** No Date.parse guesses: a picker value must describe a real calendar day. */
export function canonicalStartDate(value: string): string | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.trim());
  if (parts) return checkedDate(parts[1], parts[2], parts[3]);
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(value.trim());
  const first = slash?.[1],
    second = slash?.[2],
    year = slash?.[3];
  // An ambiguous date needs its explicit format, not a guess between two days.
  if (
    !first ||
    !second ||
    !year ||
    (Number(first) <= 12 && Number(second) <= 12)
  )
    return null;
  return Number(second) > 12
    ? checkedDate(year, first, second)
    : checkedDate(year, second, first);
}

/** Relative availability is arithmetic on the person's own answer, never a model guess. */
export function relativeStartDate(value: string, now: Date): string | null {
  const text = value.trim().toLowerCase();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  if (
    /^(?:immediate(?:ly)?|available immediately|now|asap|as soon as possible)$/u.test(
      text,
    )
  )
    return iso(today);
  const notice =
    /^(?:in |after )?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) (days?|weeks?)$/u.exec(
      text,
    );
  const quantity = notice?.[1],
    unit = notice?.[2];
  if (!quantity || !unit) return null;
  const words = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
  ];
  const amount = /^\d+$/u.test(quantity)
    ? Number(quantity)
    : words.indexOf(quantity);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 3650) return null;
  today.setDate(today.getDate() + amount * (unit.startsWith("week") ? 7 : 1));
  return iso(today);
}

export function startDateAnswer(
  control: ApplyFormControl,
  sources: ApplyAnswerSources,
  controls: readonly ApplyFormControl[],
  now: Date,
) {
  if (!isStartDateControl(control)) return null;
  const saved = savedAnswerForQuestion(
    control,
    sources.reusableAnswers,
    controls,
  );
  const days = sources.profile.workEligibility.noticePeriodDays;
  const source = saved
    ? { id: `answerLibrary.${saved.id}`, value: saved.answer }
    : sources.profile.workEligibility.availableStartDate
      ? {
          id: "profile.workEligibility.availableStartDate",
          value: sources.profile.workEligibility.availableStartDate,
        }
      : days !== null
        ? {
            id: "profile.workEligibility.noticePeriodDays",
            value: `${days} days`,
          }
        : null;
  if (!source) return null;
  const value =
    canonicalStartDate(source.value) ?? relativeStartDate(source.value, now);
  return value ? { ...source, value } : null;
}
