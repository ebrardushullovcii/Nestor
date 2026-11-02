import { useId } from "react";
import { Switch } from "@renderer/components/ui/switch";
import { cn } from "@renderer/lib/utils";

interface ToggleFieldProps {
  checked: boolean;
  className?: string;
  description: string;
  disabled?: boolean;
  hint?: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}

/**
 * One settings row: the label and its help on the left at a reading measure,
 * the switch on the right. Rows are plain and separated by one hairline, so a
 * section is never a card of cards; a list of rows draws the rule between
 * them (`border-t` on every row after the first).
 */
export function ToggleField({
  checked,
  className,
  description,
  disabled,
  hint,
  label,
  onCheckedChange,
}: ToggleFieldProps) {
  const switchId = useId();
  const descriptionId = useId();

  return (
    <div
      className={cn(
        // The switch sits at the end of the text's reading measure, not
        // across a wide empty middle at the pane's far edge.
        "grid min-w-0 grid-cols-[minmax(0,70ch)_auto] items-start justify-start gap-x-6 gap-y-1 border-t border-(--surface-panel-border) py-3 first:border-t-0 first:pt-0 last:pb-0",
        disabled && "opacity-50",
        className,
      )}
      data-settings-row
    >
      <div className="grid min-w-0 max-w-[70ch] gap-0.5">
        <label
          className="text-(length:--text-body) font-medium leading-5 text-foreground"
          htmlFor={switchId}
        >
          {label}
        </label>
        <span
          className="text-(length:--text-small) leading-5 text-foreground-soft"
          id={descriptionId}
        >
          <span className="block">{description}</span>
          {hint ? (
            <span className="mt-1 block text-(length:--text-tiny) leading-4 text-foreground-muted">
              {hint}
            </span>
          ) : null}
        </span>
      </div>
      <Switch
        aria-describedby={descriptionId}
        checked={checked}
        className="mt-0.5"
        disabled={disabled}
        id={switchId}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}
