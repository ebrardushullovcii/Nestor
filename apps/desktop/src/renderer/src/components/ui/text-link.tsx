import * as React from "react";
import { Slot } from "radix-ui";

import { cn } from "@renderer/lib/utils";

/**
 * The single link treatment for the whole app.
 *
 * Text-only controls used to be links by hue alone - no underline, no
 * chevron, no box - at 1.94:1 (light) and 1.32:1 (dark) against the body text
 * beside them, while `Export CSV` / `Export JSON` were literally the same
 * colour as the paragraph above them. Meanwhile Home underlined its links and
 * Shortlisted used chevrons, so neither idiom reliably meant "clickable".
 *
 * Hue can never be the sole carrier at these ratios, so the underline is
 * always painted. Use this for text-only navigation; a control that performs
 * an action gets a real `Button`.
 */
const textLinkClassName =
  "inline items-baseline rounded-(--radius-small) text-(--link) underline decoration-from-font underline-offset-4 outline-none transition-colors hover:text-(--link-hover) focus-ring disabled:cursor-not-allowed disabled:text-(--disabled-foreground) disabled:no-underline aria-disabled:cursor-not-allowed aria-disabled:text-(--disabled-foreground) aria-disabled:no-underline";

function TextLink({
  className,
  asChild = false,
  type,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  if (asChild) {
    return (
      <Slot.Root
        data-slot="text-link"
        className={cn(textLinkClassName, className)}
        {...props}
      />
    );
  }

  return (
    <button
      data-slot="text-link"
      type={type ?? "button"}
      className={cn(textLinkClassName, className)}
      {...props}
    />
  );
}

export { TextLink, textLinkClassName };
