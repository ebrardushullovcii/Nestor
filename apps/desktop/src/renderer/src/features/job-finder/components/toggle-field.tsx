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
        "surface-card-tint grid min-w-0 content-start gap-(--gap-field) h-full rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4",
        disabled && "opacity-50",
        className,
      )}
    >
      {/* A switch's label is a sentence, not a form-field caption: the
          uppercase field label made it read as a section eyebrow. */}
      <label
        className="text-(length:--text-body) font-semibold leading-5 text-foreground"
        htmlFor={switchId}
      >
        {label}
      </label>
      <div className="flex min-w-0 flex-1 items-start justify-between gap-4">
        <span
          id={descriptionId}
          className="min-w-0 text-(length:--text-small) leading-5 text-muted-foreground"
        >
          <span className="block">{description}</span>
          {hint ? (
            <span className="mt-2 block text-(length:--text-tiny) leading-5">
              {hint}
            </span>
          ) : null}
        </span>
        <Switch
          id={switchId}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
          aria-describedby={descriptionId}
        />
      </div>
    </div>
  );
}
