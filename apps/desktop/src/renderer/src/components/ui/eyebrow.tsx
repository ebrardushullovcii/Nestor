import * as React from "react";

import { cn } from "@renderer/lib/utils";

/**
 * The small label that sits above a heading: 12px medium, muted, sentence
 * case. The app has exactly one eyebrow style and no tracked capitals.
 *
 * 48 sites hand-rolled this span across seven recipes - three weights, three
 * tracking tokens and four foreground tokens - and an eighth using the field
 * label pair. This is the one recipe.
 *
 * It is deliberately a `span`, never a heading element and never
 * `role="heading"`. An eyebrow labels the block it introduces; promoting it to
 * a heading inserts a second entry into the document outline for the same
 * section and lets a card's real title read as its subtitle.
 */
export const EYEBROW_CLASS =
  "font-display text-(length:--text-eyebrow) leading-4 font-medium text-foreground-muted";

function Eyebrow({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(EYEBROW_CLASS, className)}
      data-slot="eyebrow"
      {...props}
    />
  );
}

export { Eyebrow };
