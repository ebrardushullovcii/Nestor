import { useId, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { FieldLabel } from "@renderer/components/ui/field";
import { Input } from "@renderer/components/ui/input";
import { cn } from "@renderer/lib/cn";
import {
  ProfileFieldHint,
  profileInputClassName,
} from "./profile-form-primitives";

interface ProfileListEditorProps {
  className?: string;
  /** The rule for what goes in the list, under its label. */
  description?: string;
  displayMode?: "chips" | "rows";
  draftParser?: (value: string) => readonly string[];
  emptyMessage?: string;
  inputId?: string;
  label: string;
  onChange: (values: string[]) => void;
  placeholder: string;
  values: readonly string[];
}

/**
 * A place can itself contain commas ("Chicago, IL" or "Paris, France").
 * Keep those commas inside the place; only the separators the location UI
 * promises create more than one entry.
 */
export function parseProfileLocationDraft(value: string): string[] {
  return value
    .split(/[;\r\n]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function ProfileListEditor({
  className,
  description,
  displayMode = "chips",
  draftParser,
  emptyMessage = "No items added yet.",
  inputId,
  label,
  onChange,
  placeholder,
  values,
}: ProfileListEditorProps) {
  const generatedInputId = useId();
  const resolvedInputId = inputId ?? generatedInputId;
  const [draft, setDraft] = useState("");

  const updateValues = (nextValues: readonly string[]) => {
    const normalizedCurrentValues = [
      ...new Set(values.map((value) => value.trim()).filter(Boolean)),
    ];
    const normalizedNextValues = [
      ...new Set(nextValues.map((value) => value.trim()).filter(Boolean)),
    ];
    const isUnchanged =
      normalizedCurrentValues.length === normalizedNextValues.length &&
      normalizedCurrentValues.every(
        (value, index) => value === normalizedNextValues[index],
      );

    if (!isUnchanged) {
      onChange(normalizedNextValues);
    }
  };

  const addValue = () => {
    const trimmed = draft.trim();

    if (!trimmed) {
      return;
    }

    const parsedValues = draftParser ? [...draftParser(trimmed)] : [trimmed];
    updateValues([...values, ...parsedValues]);

    setDraft("");
  };

  // Typed-but-uncommitted text used to be thrown away silently: a role typed
  // into "Add a target role" and then left by clicking "Save and continue"
  // never reached the form, so guided setup saved a plan with no roles and
  // Find jobs reported "No roles added yet". Leaving the field commits what
  // was typed, exactly as Enter and Add already do.
  const commitPendingDraft = () => {
    if (draft.trim()) {
      addValue();
    }
  };

  const isPopulated = values.length > 0;
  // Empty trays stay mounted (so adding items cannot shift the layout) but
  // collapse to roughly one control height instead of reserving full list
  // space. A populated tray grows with its content: a fixed-height tray showed
  // 6 of 52 chips and clipped the last row mid-chip, and an inner scrollbar
  // inside a page that already scrolls is worse than a taller section.
  const traySizingClassName = isPopulated
    ? displayMode === "chips"
      ? // Chips grow with their content; the old fixed 8.6rem floor left ~100px
        // of empty space under a single row of chips.
        "min-h-16"
      : "min-h-46"
    : "min-h-14";

  return (
    // No box of its own: a label, a field with its Add button, and the
    // items under it. Profile sections already frame it.
    <section className={cn("grid min-w-0 content-start gap-2", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <FieldLabel
          className="text-(length:--text-tiny) font-medium tracking-(--tracking-label) text-foreground-soft"
          htmlFor={resolvedInputId}
        >
          {label}
        </FieldLabel>
        <span className="text-(length:--text-count) tracking-(--tracking-label) text-foreground-muted">
          {values.length}
        </span>
      </div>
      {description ? (
        <div className="max-w-[70ch]">
          <ProfileFieldHint>{description}</ProfileFieldHint>
        </div>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-3">
        <Input
          className={profileInputClassName}
          id={resolvedInputId}
          onBlur={commitPendingDraft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addValue();
            }
          }}
          placeholder={placeholder}
          value={draft}
        />
        <Button
          className="w-full px-0"
          disabled={!draft.trim()}
          size="field"
          onClick={addValue}
          type="button"
          variant="secondary"
        >
          Add
        </Button>
      </div>

      {/* An empty list is one quiet line, not an empty box. */}
      <div
        className={cn(
          values.length === 0
            ? "flex items-start pt-1"
            : displayMode === "chips"
              ? "flex flex-wrap content-start items-start gap-2 pt-1"
              : "grid content-start gap-2 pt-1",
          traySizingClassName,
        )}
        data-profile-list-tray={values.length === 0 ? "empty" : "filled"}
      >
        {values.map((value) =>
          displayMode === "chips" ? (
            <div
              key={`${label}_${value}`}
              className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-(--surface-panel-border) bg-(--surface-fill-chip) py-1 pl-3 pr-1 text-(length:--text-item) text-foreground"
              title={value}
            >
              <span className="min-w-0 whitespace-normal break-words">
                {value}
              </span>
              <button
                aria-label={`Remove ${value}`}
                // A 24px mark with a 32px target around it.
                className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-full text-(length:--text-icon-small) leading-none text-muted-foreground outline-none transition-colors before:absolute before:-inset-1 before:content-[''] hover:bg-(--surface-panel) hover:text-foreground focus-ring"
                onClick={() =>
                  updateValues(values.filter((entry) => entry !== value))
                }
                type="button"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </div>
          ) : (
            <div
              key={`${label}_${value}`}
              className="grid gap-2 rounded-(--radius-field) border border-border/60 bg-(--surface-fill-soft) px-3 py-2.5 text-(length:--text-item) leading-6 text-foreground-soft"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 whitespace-pre-wrap break-words">
                  {value}
                </span>
                <button
                  aria-label={`Remove ${value}`}
                  className="-my-1.5 -mr-2 inline-flex size-8 shrink-0 items-center justify-center rounded-full text-(length:--text-icon-small) leading-none text-muted-foreground outline-none transition-colors hover:bg-(--surface-panel) hover:text-foreground focus-ring"
                  onClick={() =>
                    updateValues(values.filter((entry) => entry !== value))
                  }
                  type="button"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </div>
            </div>
          ),
        )}

        {values.length === 0 ? (
          <p className="text-(length:--text-description) leading-5 text-foreground-muted">
            {emptyMessage}
          </p>
        ) : null}
      </div>
    </section>
  );
}
