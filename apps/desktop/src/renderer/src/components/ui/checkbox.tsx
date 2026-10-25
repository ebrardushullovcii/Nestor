import * as React from "react";
import { CheckIcon, MinusIcon } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";

import { cn } from "@renderer/lib/utils";

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        // The unchecked box is identified by its outline alone (the checked
        // state is a solid --primary fill), so that outline is a UI-component
        // boundary and must clear 3:1. It used --border, which measured
        // 1.85-1.98:1 in dark; --control-border is the app's published
        // control boundary and clears 3:1 on every interior surface.
        // Disabled drops the fill and moves the box onto the disabled tokens
        // rather than compositing both fill and mark at 50%: the compound
        // `disabled:data-[state=checked]:` selectors outrank the single-variant
        // checked rules, so a disabled checked box keeps its shape instead of
        // staying a washed-out --primary block.
        // A partly selected group ("indeterminate") uses the checked fill with
        // a dash, so "some" reads as a state of its own rather than "none".
        "peer group/checkbox size-4 shrink-0 rounded-none border border-(--control-border) bg-input outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-not-allowed disabled:border-(--disabled-border) disabled:bg-(--disabled-surface) disabled:text-(--disabled-foreground) data-[state=checked]:border-primary-fill data-[state=checked]:bg-primary-fill data-[state=checked]:text-primary-fill-foreground data-[state=indeterminate]:border-primary-fill data-[state=indeterminate]:bg-primary-fill data-[state=indeterminate]:text-primary-fill-foreground disabled:data-[state=checked]:border-(--disabled-border) disabled:data-[state=checked]:bg-(--disabled-surface) disabled:data-[state=checked]:text-(--disabled-foreground)",
        className,
      )}
      {...props}
    >
      {/* A plain mark the box state shows or hides. Radix's Indicator wraps
          each mark in Presence, which reads the computed style of every box
          as it mounts; a Profile tab with 25 boxes spent about 0.2 s in the
          style recalculations that forced. */}
      <span
        aria-hidden="true"
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none group-data-[state=unchecked]/checkbox:hidden"
      >
        {props.checked === "indeterminate" ? (
          <MinusIcon className="size-3" />
        ) : (
          <CheckIcon className="size-3" />
        )}
      </span>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
