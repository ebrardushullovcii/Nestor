import * as React from "react";

import { formatCompactCount } from "@renderer/lib/compact-count";
import { useEnterMotion } from "@renderer/lib/motion";
import { cn } from "@renderer/lib/utils";

/**
 * The one count treatment.
 *
 * Five shapes carried the same number before this - a transparent
 * right-aligned figure in the expanded sidebar, a filled pill in the compact
 * nav, a corner dot on the collapsed rail, a primary-filled pill on the More
 * trigger, and a mono bordered pill in Applications - so the same count
 * changed shape one breakpoint apart. `inline` is the plain right-aligned
 * tabular figure with no fill; `rail-marker` is the collapsed-rail marker,
 * the only variant that paints, because an icon-only rail has no room for a
 * figure beside a label.
 *
 * It never renders at zero. Three zero rules used to coexist and the one that
 * rendered a permanent grey "0" was the one that meant "nothing is happening".
 * The caller decides whether a count exists at all; this primitive will not
 * silently paint a zero pill on its behalf.
 */
/** A changed figure rises into place; the badge itself does not move. */
const COUNT_CHANGE_FROM: Keyframe = {
  opacity: 0.2,
  transform: "translateY(4px)",
};

export type CountVariant = "inline" | "pill" | "rail-marker";

const COUNT_VARIANT_CLASS = {
  inline:
    "inline-flex h-5 min-w-8 items-center justify-end bg-transparent px-0 text-xs tabular-nums text-foreground-muted",
  // A quiet pill for navigation rows: the figure sits in its own soft shape
  // so it reads as belonging to the row instead of floating at the far edge.
  pill: "inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-secondary px-1.5 text-xs font-medium tabular-nums text-foreground-soft",
  // Off the glyph: a small figure on its own line under the rail icon,
  // centred in the 44px item, so up to "9,999" (then "12.3k") fits without
  // touching the glyph or being cut by the rail's edge.
  "rail-marker":
    "inline-flex h-4 max-w-full items-center justify-center rounded-full px-1 text-xs leading-4 font-medium tabular-nums text-current",
} as const satisfies Record<CountVariant, string>;

function Count({
  className,
  label,
  value,
  variant = "inline",
  ...props
}: Omit<React.ComponentProps<"span">, "children"> & {
  /** Announced after the figure, e.g. "unread" -> "3 unread". */
  label?: string;
  value: number;
  variant?: CountVariant;
}) {
  const figureRef = React.useRef<HTMLSpanElement | null>(null);
  const rounded = Math.floor(value);
  useEnterMotion(figureRef, rounded, { from: COUNT_CHANGE_FROM });

  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  // Thousands separated, as every other count in the app: "1,245".
  const figure = rounded.toLocaleString();
  // The rail marker has the rail item's width and no more: exact to 9,999,
  // then the same number abbreviated ("12.3k"), with the exact figure in its
  // tooltip and for assistive technology.
  const short =
    variant === "rail-marker" ? formatCompactCount(rounded) : figure;
  const capped = short !== figure;

  return (
    <span
      className={cn(COUNT_VARIANT_CLASS[variant], className)}
      data-slot="count"
      data-variant={variant}
      {...(capped ? { title: figure } : {})}
      {...props}
    >
      <span
        aria-hidden={label || capped ? "true" : undefined}
        className="inline-block"
        ref={figureRef}
      >
        {short}
      </span>
      {label || capped ? (
        <span className="sr-only">{label ? `${figure} ${label}` : figure}</span>
      ) : null}
    </span>
  );
}

export { Count, COUNT_VARIANT_CLASS };
