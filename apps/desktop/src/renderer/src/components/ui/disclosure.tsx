import * as React from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@renderer/lib/utils";

/**
 * The canonical expander.
 *
 * 49 `<details>` elements shipped across roughly 18 container recipes - three
 * radii, four border tokens, and summaries that ranged from a bordered control
 * to a bare `group min-w-0` span reading as body text beside real controls.
 * This keeps the native element (so it stays keyboard-operable and findable by
 * in-page search when open) and gives it one look: a quiet summary with a
 * leading chevron that turns a quarter on open, the same glyph globals.css
 * draws for any plain <summary>, and a height from the control scale.
 *
 * It supports both an uncontrolled `defaultOpen` and a fully controlled `open`
 * so a caller can mirror the state without forking the markup.
 */
export type DisclosureSize = "toolbar" | "field" | "block";

/**
 * `block` is the same expander for a titled group (a title over a line of
 * description, an "Optional" note): the summary spans the row, wraps and
 * grows with its text, and the chevron sits on the title's first line.
 */
const DISCLOSURE_SUMMARY_SIZE_CLASS = {
  toolbar: "h-8 px-2 text-(length:--text-small)",
  field: "h-10 px-2.5 text-sm",
  block:
    "flex w-full items-start whitespace-normal px-0 py-0 hover:bg-transparent [&>svg]:mt-0.5",
} as const satisfies Record<DisclosureSize, string>;

function Disclosure({
  children,
  className,
  contentClassName,
  defaultOpen = false,
  onOpenChange,
  open,
  size = "toolbar",
  summary,
  summaryClassName,
  ...props
}: Omit<React.ComponentProps<"details">, "onToggle" | "open"> & {
  contentClassName?: string;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  size?: DisclosureSize;
  summary: React.ReactNode;
  summaryClassName?: string;
}) {
  const isControlled = open !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const isOpen = isControlled ? open : uncontrolledOpen;

  return (
    <details
      className={cn("group min-w-0", className)}
      data-slot="disclosure"
      onToggle={(event) => {
        const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
        if (!isControlled) {
          setUncontrolledOpen(nextOpen);
        }

        if (nextOpen !== isOpen) {
          onOpenChange?.(nextOpen);
        }
      }}
      open={isOpen}
      {...props}
    >
      <summary
        className={cn(
          "inline-flex cursor-pointer list-none items-center gap-1.5 rounded-(--radius-button) border border-transparent bg-transparent font-medium whitespace-nowrap text-foreground-soft transition-[background-color,color] duration-(--duration-fast) outline-none select-none marker:hidden hover:bg-accent hover:text-foreground focus-ring [&::-webkit-details-marker]:hidden",
          DISCLOSURE_SUMMARY_SIZE_CLASS[size],
          summaryClassName,
        )}
        data-slot="disclosure-summary"
      >
        <ChevronRight
          aria-hidden="true"
          // Turns with its own <details> only (summary > svg of an open
          // details), never with an open card or disclosure around it.
          className="size-4 shrink-0 opacity-75 transition-transform duration-(--duration-base) ease-(--ease-standard) [details[open]>summary>&]:rotate-90"
        />
        {summary}
      </summary>
      <div
        className={cn("min-w-0 pt-2", contentClassName)}
        data-slot="disclosure-content"
      >
        {children}
      </div>
    </details>
  );
}

export { Disclosure, DISCLOSURE_SUMMARY_SIZE_CLASS };
