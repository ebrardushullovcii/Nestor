import * as React from "react";

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
export type CountVariant = "inline" | "pill" | "rail-marker";

const COUNT_VARIANT_CLASS = {
  inline:
    "inline-flex h-5 min-w-7 items-center justify-end bg-transparent px-0 text-(length:--text-tiny) tabular-nums text-foreground-muted",
  // A quiet pill for navigation rows: the figure sits in its own soft shape
  // so it reads as belonging to the row instead of floating at the far edge.
  pill: "inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-(--input) px-1.5 text-(length:--text-tiny) font-medium tabular-nums text-foreground",
  "rail-marker":
    "inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-(--surface-panel-border) bg-(--input) px-0.5 text-[0.625rem] leading-none tabular-nums text-foreground",
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
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  const rounded = Math.floor(value);
  // The rail marker sits on an icon's corner; "678" covered most of the
  // glyph on the collapsed sidebar. It caps at 99+ and keeps the full number
  // for assistive technology.
  const capped = variant === "rail-marker" && rounded > 99;

  return (
    <span
      className={cn(COUNT_VARIANT_CLASS[variant], className)}
      data-slot="count"
      data-variant={variant}
      {...(capped ? { title: String(rounded) } : {})}
      {...props}
    >
      <span aria-hidden={label || capped ? "true" : undefined}>
        {capped ? "99+" : rounded}
      </span>
      {label || capped ? (
        <span className="sr-only">
          {label ? `${rounded} ${label}` : String(rounded)}
        </span>
      ) : null}
    </span>
  );
}

export { Count, COUNT_VARIANT_CLASS };
