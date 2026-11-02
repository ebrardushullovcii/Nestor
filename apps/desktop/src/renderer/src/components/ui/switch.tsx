"use client";

import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "@renderer/lib/utils";

/**
 * A pill switch: a rounded track and a round knob, so it can never be read
 * as a checkbox.
 *
 * Off: an outlined track (the 3:1 control boundary) with a neutral knob in
 * the boundary colour. On: the pine fill with a white knob that travels to
 * the trailing end. The knob, not the track alone, changes with state, and
 * it clears 3:1 against both track states in both themes.
 */
const SWITCH_SIZE = {
  sm: {
    track: "h-4 w-7",
    knob: "size-2.5",
    travel: "data-[state=checked]:translate-x-3",
  },
  default: {
    // 24px tall: the press target is the track itself (WCAG 2.2 target
    // size). 40px inside the edge, an 18px knob 2px from each end.
    track: "h-6 w-11",
    knob: "size-4.5",
    travel: "data-[state=checked]:translate-x-5",
  },
} as const;

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default";
}) {
  const dimensions = SWITCH_SIZE[size];
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-(--control-border) bg-(--field) p-px outline-none transition-[background-color,border-color] duration-(--duration-fast) ease-(--ease-standard) focus-ring hover:border-(--control-border-hover)",
        dimensions.track,
        "data-[state=checked]:border-primary-fill data-[state=checked]:bg-primary-fill data-[state=checked]:hover:border-(--primary-fill-hover) data-[state=checked]:hover:bg-(--primary-fill-hover)",
        "disabled:cursor-not-allowed disabled:border-(--disabled-border) disabled:bg-(--disabled-surface) disabled:text-(--disabled-foreground) disabled:data-[state=checked]:bg-(--disabled-border)",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-(--control-border) ring-0 transition-transform duration-(--duration-base) ease-(--ease-standard)",
          dimensions.knob,
          "translate-x-0.5",
          dimensions.travel,
          "data-[state=checked]:bg-primary-fill-foreground",
          "group-disabled/switch:bg-(--disabled-border) group-disabled/switch:data-[state=checked]:bg-(--field)",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
