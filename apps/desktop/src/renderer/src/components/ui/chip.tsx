import * as React from "react";
import { cn } from "../../lib/utils";

/**
 * The one chip. A quiet pill in sentence case with a hairline edge; as a
 * filter it is a toggle whose pressed state is the accent tint with a 3:1
 * accent edge and a medium label, so the state never rests on colour alone.
 */
export const CHIP_CLASS =
  "inline-flex max-w-full items-center gap-1.5 rounded-full border border-(--surface-panel-border) bg-transparent px-3 text-(length:--text-small) text-foreground-soft transition-[background-color,border-color,color] duration-(--duration-fast)";
export const FILTER_CHIP_CLASS = cn(
  CHIP_CLASS,
  "h-8 whitespace-nowrap outline-none focus-ring hover:bg-accent hover:text-foreground active:bg-pressed",
);
export const FILTER_CHIP_ACTIVE_CLASS =
  "border-(--row-selected-bar) bg-accent-tint font-medium text-foreground hover:bg-accent-tint";

function Chip({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        CHIP_CLASS,
        "py-0.5 whitespace-normal break-words",
        className,
      )}
      {...props}
    />
  );
}

export { Chip };
