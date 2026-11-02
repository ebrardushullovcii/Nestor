import { useEffect, useRef, useState } from "react";

import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";
import { cn } from "@renderer/lib/cn";

export const profileInputClassName =
  "h-10 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3 py-0 text-(length:--text-field) leading-none tracking-normal text-foreground placeholder:text-muted-foreground focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-(--field-focus-shadow)";

export const profileTextareaClassName =
  "rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3 py-2.5 text-(length:--text-field) leading-normal tracking-normal text-foreground placeholder:text-muted-foreground focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-(--field-focus-shadow)";

export const profileTextareaCompactClassName = `${profileTextareaClassName} min-h-(--textarea-compact) max-h-(--textarea-compact)`;

export const profileTextareaDefaultClassName = `${profileTextareaClassName} min-h-(--textarea-default) max-h-(--textarea-default)`;

export const profileTextareaTallClassName = `${profileTextareaClassName} min-h-(--textarea-tall) max-h-(--textarea-tall)`;

/**
 * Starts at the control's own `rows` and grows with its content instead of
 * reserving a fixed block. Long optional prose fields otherwise render as a
 * wall of identical empty boxes before the user has typed anything.
 */
export const profileTextareaAutoGrowClassName = `${profileTextareaClassName} [field-sizing:content]`;

export const profileSelectTriggerClassName =
  "h-10! rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3 py-0 text-(length:--text-field) normal-case leading-none tracking-normal text-foreground data-[placeholder]:text-muted-foreground focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-(--field-focus-shadow)";

export function ProfileInput(props: React.ComponentProps<typeof Input>) {
  const { className, ...rest } = props;
  return <Input className={cn(profileInputClassName, className)} {...rest} />;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

const monthName = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * The common ways a month is typed, as the stored `YYYY-MM` (or `YYYY` for a
 * year alone): "2024-03", "2024-3", "03/2024", "3/2024", "Mar 2024",
 * "March 2024", "2024". Empty stays empty; anything else is `null` and is
 * left exactly as typed.
 */
export function parseMonthText(text: string): string | null {
  const value = text.trim();
  if (!value) return "";
  // An end date of "Present" is a value of its own, kept as written.
  if (/^(present|current|now|today)$/iu.test(value)) return value;
  const pad = (month: number) => String(month).padStart(2, "0");
  const valid = (year: number, month: number) =>
    year >= 1900 && year <= 2100 && month >= 1 && month <= 12;
  let match = /^(\d{4})$/u.exec(value);
  if (match) return match[1] ?? null;
  match = /^(\d{4})[-/.](\d{1,2})$/u.exec(value);
  if (match) {
    const [year, month] = [Number(match[1]), Number(match[2])];
    return valid(year, month) ? `${year}-${pad(month)}` : null;
  }
  match = /^(\d{1,2})[-/.](\d{4})$/u.exec(value);
  if (match) {
    const [month, year] = [Number(match[1]), Number(match[2])];
    return valid(year, month) ? `${year}-${pad(month)}` : null;
  }
  match = /^([a-z]{3,9})\.?,?\s+(\d{4})$/iu.exec(value);
  if (match) {
    const word = (match[1] ?? "").toLowerCase();
    const index = MONTHS.findIndex(
      (name) => name === word || name.slice(0, 3) === word.slice(0, 3),
    );
    const year = Number(match[2]);
    return index >= 0 && valid(year, index + 1)
      ? `${year}-${pad(index + 1)}`
      : null;
  }
  return null;
}

/** "2024-03" as "March 2024"; a year alone as itself. */
export function describeMonthText(stored: string): string {
  if (/^[a-z]+$/iu.test(stored)) return `“${stored}”`;
  const match = /^(\d{4})-(\d{2})$/u.exec(stored);
  if (!match) return stored;
  return monthName.format(
    new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)),
  );
}

/**
 * A month field for dates stored as `YYYY-MM`. Common forms ("Mar 2024",
 * "03/2024") are read on leaving the field and stored as `YYYY-MM`; the line
 * under the field then says how it was read ("March 2024"), so a typo cannot
 * pass silently. Text it cannot read is kept as typed (a year-only date from
 * an import still shows) and the line says so.
 */
export function ProfileMonthInput(
  props: React.ComponentProps<typeof Input> & { id: string },
) {
  const { className, onBlur, onChange, ref, ...rest } = props;
  const hintId = `${props.id}-format`;
  const [text, setText] = useState<string | null>(null);
  const local = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // Values arrive from the form after mount; read what the field shows.
    if (text === null && local.current) setText(local.current.value);
  }, [text]);
  const parsed = text ? parseMonthText(text) : "";
  const hint =
    parsed === null
      ? "Not read as a date. Use a year and month, like 2024-03, or a year alone."
      : parsed
        ? `Read as ${describeMonthText(parsed)}.`
        : "Year and month, like 2024-03 or Mar 2024. A year alone is fine.";
  return (
    <>
      <Input
        aria-describedby={hintId}
        aria-invalid={parsed === null ? true : undefined}
        className={cn(profileInputClassName, className)}
        onBlur={(event) => {
          const next = parseMonthText(event.target.value);
          if (next !== null && next !== event.target.value) {
            event.target.value = next;
            onChange?.(event as unknown as React.ChangeEvent<HTMLInputElement>);
          }
          setText(event.target.value);
          onBlur?.(event);
        }}
        onChange={(event) => {
          setText(event.target.value);
          onChange?.(event);
        }}
        placeholder="2024-03"
        ref={(node: HTMLInputElement | null) => {
          local.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        {...rest}
      />
      <span
        className={cn(
          "text-(length:--text-tiny) leading-4",
          parsed === null ? "text-(--warning-text)" : "text-foreground-muted",
        )}
        id={hintId}
      >
        {hint}
      </span>
    </>
  );
}

export function ProfileTextarea(props: React.ComponentProps<typeof Textarea>) {
  const { className, ...rest } = props;
  return (
    <Textarea
      className={cn(profileTextareaDefaultClassName, className)}
      {...rest}
    />
  );
}

export function ProfileAutoGrowTextarea(
  props: React.ComponentProps<typeof Textarea>,
) {
  const { className, ...rest } = props;
  return (
    <Textarea
      className={cn(profileTextareaAutoGrowClassName, className)}
      {...rest}
    />
  );
}

/**
 * One-line explanation under a field. Used where several fields could be
 * confused for each other, so each one says where its value is actually used.
 */
export function ProfileFieldHint(props: {
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <p
      className="text-(length:--text-description) leading-5 text-foreground-muted"
      {...(props.id ? { id: props.id } : {})}
    >
      {props.children}
    </p>
  );
}
