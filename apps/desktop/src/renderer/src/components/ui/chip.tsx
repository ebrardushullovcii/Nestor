import * as React from "react";
import { cn } from "../../lib/utils";

function Chip({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center border border-border bg-surface-strong px-2 py-1 font-mono text-(length:--text-tiny) uppercase tracking-(--tracking-chip) text-foreground-soft transition-[background-color,border-color] duration-150 whitespace-normal break-words",
        className,
      )}
      {...props}
    />
  );
}

export { Chip };
