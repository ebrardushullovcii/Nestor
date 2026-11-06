import { savedAnswerForQuestion } from "./application-facts";
import { fieldNamesAnotherPerson } from "./github-username";
import { currentCountryTimezone } from "./current-timezone";
import type { CandidateProfile } from "@nestor/contracts";
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

export function hasStartDateValue(
  control: ApplyFormControl,
  now = new Date(),
  profile?: CandidateProfile,
): boolean {
  if (!isStartDateControl(control) || control.invalid) return false;
  const today = localToday(now, profileTimezone(profile));
  const canonical = canonicalStartDate(control.value, control);
  if (canonical) return canonical >= today;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(control.value.trim());
  const first = slash?.[1],
    second = slash?.[2],
    year = slash?.[3];
  if (!first || !second || !year) return false;
  return [
    checkedDate(year, first, second),
    checkedDate(year, second, first),
  ].some((value) => value !== null && value >= today);
}

function profileTimezone(profile?: CandidateProfile): string | undefined {
  return (
    profile?.timeZone ?? (profile && currentCountryTimezone(profile)?.zone)
  );
}

function localToday(now: Date, timeZone?: string | null): string {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(now);
      const part = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find((entry) => entry.type === type)!.value;
      return `${part("year")}-${part("month")}-${part("day")}`;
    } catch {
      // An invalid stored zone cannot supply a different calendar day.
    }
  }
  return iso(now);
}

function dateFormat(
  control?: ApplyFormControl,
): "day_first" | "month_first" | null {
  const hint = `${control?.placeholder ?? ""} ${control?.hint ?? ""}`;
  if (/\bdd[\s/.-]*mm[\s/.-]*yyyy\b/iu.test(hint)) return "day_first";
  if (/\bmm[\s/.-]*dd[\s/.-]*yyyy\b/iu.test(hint)) return "month_first";
  return null;
}

function formatStartDate(value: string, control: ApplyFormControl): string {
  if (control.dateInputType === "date") return value;
  const [year, month, day] = value.split("-");
  const separator =
    /\b(?:dd|mm)([/.-])(?:dd|mm)\1yyyy\b/iu.exec(
      `${control.placeholder} ${control.hint ?? ""}`,
    )?.[1] ?? "/";
  const format = dateFormat(control);
  return format === "day_first"
    ? [day, month, year].join(separator)
    : format === "month_first"
      ? [month, day, year].join(separator)
      : value;
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
export function canonicalStartDate(
  value: string,
  control?: ApplyFormControl,
): string | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.trim());
  if (parts) return checkedDate(parts[1], parts[2], parts[3]);
  const slash = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/u.exec(value.trim());
  const first = slash?.[1],
    second = slash?.[2],
    year = slash?.[3];
  const format = dateFormat(control);
  if (format === "day_first") return checkedDate(year, second, first);
  if (format === "month_first") return checkedDate(year, first, second);
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
export function relativeStartDate(
  value: string,
  now: Date,
  timeZone?: string | null,
): string | null {
  const text = value.trim().toLowerCase();
  const today = new Date(`${localToday(now, timeZone)}T12:00:00Z`);
  if (
    /^(?:immediate(?:ly)?|available (?:immediately|now)|now|asap|as soon as possible)$/u.test(
      text,
    )
  )
    return today.toISOString().slice(0, 10);
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
  today.setUTCDate(
    today.getUTCDate() + amount * (unit.startsWith("week") ? 7 : 1),
  );
  return today.toISOString().slice(0, 10);
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
  const timeZone = profileTimezone(sources.profile);
  const today = localToday(now, timeZone);
  const candidates = [
    ...(saved
      ? [{ id: `answerLibrary.${saved.id}`, value: saved.answer }]
      : []),
    ...(sources.profile.workEligibility.availableStartDate
      ? [
          {
            id: "profile.workEligibility.availableStartDate",
            value: sources.profile.workEligibility.availableStartDate,
          },
        ]
      : []),
    ...(days !== null && Number.isSafeInteger(days) && days >= 0
      ? [
          {
            id: "profile.workEligibility.noticePeriodDays",
            value: `${days} days`,
          },
        ]
      : []),
  ];
  const currentDates = candidates.flatMap((source) => {
    const value = canonicalStartDate(source.value);
    return value && value >= today ? [{ ...source, value }] : [];
  });
  for (const source of [...currentDates, ...candidates]) {
    const value =
      canonicalStartDate(source.value) ??
      relativeStartDate(source.value, now, timeZone);
    if (value && value >= today)
      return { ...source, value: formatStartDate(value, control) };
  }
  return null;
}
