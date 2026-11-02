import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@renderer/lib/utils";

// A badge is inert: it labels, it never carries component state, so its edge
// belongs on the inert-chrome token rather than --border, which stays
// Separator's divider token and measured 1.60-1.80:1 against fills only
// 1.10-1.18:1 from the card - i.e. no visible chip at all. The tinted tones
// keep their own hue at /75: /65 was measured for the warning family and
// inherited untested, and fell to 2.86:1 (light --primary) against its own
// tint. The alpha is a theme token (--badge-border-alpha: 75% light, 40%
// dark; see status-badge.tsx). Both are pinned by styles/globals.test.ts.
// Sentence case at the small text size: uppercase tracked labels stacked
// down every row read as shouting and took twice the width.
const badgeVariants = cva(
  "inline-flex w-fit max-w-full min-w-0 shrink truncate items-center justify-center gap-1 overflow-hidden border px-1.5 py-0.5 text-xs font-medium leading-4 whitespace-nowrap rounded-(--radius-badge) transition-[color,box-shadow] motion-reduce:transition-none outline-none focus-ring [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-accent-tint text-primary",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-accent",
        destructive:
          "border-transparent bg-(--danger-surface) text-destructive [a&]:hover:opacity-90",
        outline:
          "border-(--surface-panel-border) bg-transparent text-foreground-soft [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost:
          "border-transparent [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "border-transparent text-(--link) underline decoration-from-font underline-offset-4",
        section: "border-transparent bg-secondary text-muted-foreground",
        status: "border-transparent bg-secondary text-foreground-soft",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
