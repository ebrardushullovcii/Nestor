import { Check } from "lucide-react";
import { useCallback, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@renderer/lib/cn";

export interface ChoiceCardOption<Id extends string> {
  id: Id;
  label: string;
  /** One short line under the label; what picking this card means. */
  detail: string;
  disabled?: boolean;
  /** Small trailing note, e.g. why the option is unavailable. */
  note?: ReactNode;
}

/**
 * One radiogroup of equal-height cards with a real selected marker: the
 * picker the four resume levels use, shared so choosing an apply mode or any
 * AI behavior looks and works the same. Arrow keys move and choose, Tab
 * enters and leaves the group once.
 */
export function ChoiceCards<Id extends string>(props: {
  "aria-label": string;
  options: readonly ChoiceCardOption<Id>[];
  value: Id;
  onChange: (id: Id) => void;
  disabled?: boolean;
  /** `compact` fits a toolbar row; `regular` is the panel size. */
  size?: "compact" | "regular";
  /** Column count at the `sm` breakpoint; defaults to the option count. */
  columns?: 2 | 3 | 4;
  className?: string;
  "data-testid"?: string;
}) {
  const groupRef = useRef<HTMLDivElement | null>(null);
  const size = props.size ?? "regular";
  const columns = props.columns ?? Math.min(4, Math.max(2, props.options.length));

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
      if (!forward && !backward) {
        return;
      }
      const buttons = [
        ...(groupRef.current?.querySelectorAll<HTMLButtonElement>(
          "button[role='radio']:not([disabled])",
        ) ?? []),
      ];
      const activeIndex = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      if (buttons.length < 2 || activeIndex === -1) {
        return;
      }
      event.preventDefault();
      const next =
        buttons[
          (activeIndex + (forward ? 1 : -1) + buttons.length) % buttons.length
        ];
      next?.focus();
      next?.click();
    },
    [],
  );

  return (
    <div
      aria-label={props["aria-label"]}
      className={cn(
        "grid gap-2 sm:auto-rows-fr",
        columns === 2 && "sm:grid-cols-2",
        columns === 3 && "sm:grid-cols-3",
        columns === 4 && "sm:grid-cols-4",
        props.className,
      )}
      data-testid={props["data-testid"]}
      onKeyDown={handleKeyDown}
      ref={groupRef}
      role="radiogroup"
    >
      {props.options.map((option) => {
        const selected = option.id === props.value;
        const disabled = Boolean(props.disabled || option.disabled);
        return (
          <button
            aria-checked={selected}
            className={cn(
              "flex h-full flex-col justify-center gap-0.5 rounded-(--radius-small) border text-left font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              size === "compact"
                ? "min-h-9 px-2.5 py-1 text-(length:--text-small)"
                : "min-h-11 px-3 py-2 text-(length:--text-small)",
              selected
                ? "border-primary bg-primary/10 text-(--text-headline) shadow-[inset_2px_0_0_var(--primary)]"
                : "border-(--surface-panel-border) bg-background/30 text-foreground-soft hover:border-primary/35",
              disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
            )}
            data-choice-id={option.id}
            disabled={disabled}
            key={option.id}
            onClick={() => props.onChange(option.id)}
            role="radio"
            tabIndex={0}
            type="button"
          >
            <span className="flex items-center gap-2">
              {selected ? (
                <Check
                  aria-hidden="true"
                  className="size-4 shrink-0 text-primary"
                />
              ) : null}
              {option.label}
              {option.note ? (
                <span className="ml-auto text-xs font-normal text-foreground-muted">
                  {option.note}
                </span>
              ) : null}
            </span>
            <span
              className={cn(
                "font-normal text-foreground-soft",
                size === "compact"
                  ? "text-xs leading-4"
                  : "text-(length:--text-small) leading-5",
              )}
            >
              {option.detail}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export const APPLY_MODE_OPTIONS: readonly ChoiceCardOption<
  "prepare_only" | "confirm_before_submit" | "autonomous_submit"
>[] = [
  {
    id: "prepare_only",
    label: "Prepare for me",
    detail: "Fills the form and attaches the resume; you press Send.",
  },
  {
    id: "confirm_before_submit",
    label: "Ask before sending",
    detail: "Prepares everything, then waits for your go-ahead.",
  },
  {
    id: "autonomous_submit",
    label: "Send for me",
    detail: "Prepares and sends; pauses only when it needs you.",
  },
];
