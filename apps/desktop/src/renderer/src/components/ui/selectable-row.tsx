import * as React from "react";

import { cn } from "@renderer/lib/utils";

/**
 * The shared selectable list row.
 *
 * Selecting a row used to change the row's own size: the selected row became a
 * bordered, padded, raised card while its unselected neighbours stayed flat,
 * and the badge line ("NEEDS APPROVAL") plus the status line ("Tailored draft
 * ready for your review") were rendered *only* when selected. Moving the
 * selection from row 1 to row 2 therefore moved every row below it by tens of
 * pixels, in all three lists that share the pattern (Find jobs results,
 * Shortlisted, Applications).
 *
 * The contract this primitive enforces:
 *
 *  - identical box metrics in both states - same padding, same margin, same
 *    border-width - so selection can never reflow the list;
 *  - selection is a background tint plus an accent bar drawn *inside* the
 *    existing box with an inset box-shadow, which consumes no layout space;
 *  - `aria-current` carries the state for assistive technology;
 *  - content lines reserve their slot via `SelectableRowLine` and are never
 *    conditionally rendered.
 *
 * Adopters must not pass a `selected`-dependent padding, margin, border-width,
 * gap or size class. In development the row detects that and reports it.
 */
const selectableRowClassName = [
  "group/selectable-row relative block w-full min-w-0 text-left",
  // Box metrics. Every one of these is unconditional and identical in both
  // states; nothing below may vary with `selected`.
  "rounded-(--radius-panel) border border-(--border-subtle) px-4 py-3",
  "transition-[background-color,box-shadow] outline-none",
  "focus-ring",
  // Resting and hover fills.
  "bg-transparent hover:bg-(--surface-overlay-list)",
  // Selected: tint + inset accent bar. `inset` keeps the bar inside the
  // border box, so it adds no width and shifts no content.
  //
  // The bar is the row's only >=3:1 selection channel - the tint is 1.28:1
  // against an unselected row in light - so it uses --row-selected-bar rather
  // than --nav-active-bar. The nav token is drawn on the dark
  // --nav-active-surface fill and, reused here on --surface-strong, rendered
  // the light selected row at 1.39:1 against its own fill.
  "data-[selected=true]:bg-(--surface-strong)",
  "data-[selected=true]:selected-bar",
].join(" ");

/** Class tokens that would change the row's box if they varied with selection. */
const BOX_METRIC_PATTERN =
  /^-?(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|border|border-[xytrbles])(?:-|$)|^(?:w|h|min-w|min-h|max-w|max-h|size|text|leading|tracking)-/;

function boxMetricSignature(className: string | undefined): string {
  if (!className) {
    return "";
  }

  return className
    .split(/\s+/)
    .filter((token) => token.length > 0 && BOX_METRIC_PATTERN.test(token))
    .sort()
    .join(" ");
}

function useStableBoxMetrics(selected: boolean, className: string | undefined) {
  const previous = React.useRef<{
    selected: boolean;
    signature: string;
  } | null>(null);
  const signature = boxMetricSignature(className);

  React.useEffect(() => {
    if (process.env.NODE_ENV === "production") {
      return;
    }

    const last = previous.current;

    previous.current = { selected, signature };

    if (!last || last.selected === selected) {
      return;
    }

    if (last.signature !== signature) {
      console.error(
        "SelectableRow: box metrics changed with selection " +
          `("${last.signature}" -> "${signature}"). Selecting a row must not ` +
          "change its padding, margin, border-width, gap or size, because " +
          "that reflows every row below it. Express selection through the " +
          "primitive's tint and accent bar instead.",
      );
    }
  }, [selected, signature]);
}

type SelectableRowElement = "button" | "div" | "li";

type SelectableRowProps<Element extends SelectableRowElement> = {
  as?: Element;
  selected: boolean;
  /** Ticked in select mode: the row carries the checked tint. */
  checked?: boolean;
} & Omit<React.ComponentPropsWithoutRef<Element>, "aria-current">;

function SelectableRow<Element extends SelectableRowElement = "button">({
  as,
  className,
  selected,
  checked,
  ...props
}: SelectableRowProps<Element>) {
  useStableBoxMetrics(selected, className);

  const Component: SelectableRowElement = as ?? "button";
  const elementProps = props as Record<string, unknown>;

  return React.createElement(Component, {
    ...elementProps,
    ...(Component === "button" && elementProps.type === undefined
      ? { type: "button" }
      : {}),
    "aria-current": selected ? ("true" as const) : undefined,
    className: cn(selectableRowClassName, className),
    "data-selected": selected ? "true" : "false",
    ...(checked ? { "data-checked": "true" } : {}),
    "data-slot": "selectable-row",
  });
}

/**
 * One content line inside a selectable row.
 *
 * The line always occupies its slot. When a row has nothing to show for this
 * line it still reserves the height, so the row's total height is a property
 * of the list, not of which row happens to be selected. Pass `reserve={false}`
 * only for a line that every row in the list always fills.
 */
function SelectableRowLine({
  children,
  className,
  reserve = true,
  ...props
}: React.ComponentProps<"div"> & { reserve?: boolean }) {
  // `""` is the shape an absent label actually arrives in: a formatter that
  // returns an empty string produced a line React rendered as nothing while
  // the row still reported `data-empty="false"`, so the zero-width space that
  // holds the slot open was never painted and the row lost its reserved
  // height - the exact reflow this primitive exists to prevent.
  const empty =
    children === null ||
    children === undefined ||
    children === false ||
    (typeof children === "string" && children.trim().length === 0);

  return (
    <div
      // The reserved height is one line of THIS line's own type (`1lh`), not a
      // flat 1rem: a line that carries a larger or smaller font than the
      // 16px `min-h-4` assumed reserved the wrong slot, so an empty line and
      // a filled line at that size were different heights.
      className={cn("min-w-0", reserve && "min-h-[1lh]", className)}
      data-empty={empty ? "true" : "false"}
      data-slot="selectable-row-line"
      {...props}
    >
      {empty ? <span aria-hidden="true">&#8203;</span> : children}
    </div>
  );
}

export {
  SelectableRow,
  SelectableRowLine,
  selectableRowClassName,
  boxMetricSignature,
};
