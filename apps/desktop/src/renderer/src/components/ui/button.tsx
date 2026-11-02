import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@renderer/lib/utils";

// `aria-disabled:` mirrors the `disabled:` treatment so pending controls (and
// asChild children that cannot take a native disabled attribute) keep the same
// inert, non-interactive look without leaving the accessibility tree.
//
// Disabled loses the fill entirely. It used to keep the enabled `secondary`
// fill and differ only by a label colour step to `--muted-foreground` - the
// app's ordinary secondary text colour - so a disabled `Add note` was pixel
// identical to an enabled `Save` beside it, and `Save appearance` (the primary
// commit on Settings) was unreadable as a state. Removing the fill makes the
// state legible without relying on a body-text colour.
//
// Disabled is a flat, edgeless chip: no outline (every enabled outline,
// secondary or primary button has an edge or a fill) and a quiet secondary
// surface. A disabled outline button used to keep a grey outline, so it
// differed from an enabled one only by its label's grey. Ghost and link
// controls stay without a surface when disabled.
const buttonVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-2 rounded-(--radius-button) whitespace-nowrap transition-[background-color,border-color,color,box-shadow] duration-(--duration-fast) ease-(--ease-standard) outline-none focus-ring disabled:cursor-not-allowed disabled:border-(--disabled-border-button) disabled:bg-(--disabled-surface-button) disabled:text-(--disabled-foreground) disabled:shadow-none aria-disabled:cursor-not-allowed aria-disabled:border-(--disabled-border-button) aria-disabled:bg-(--disabled-surface-button) aria-disabled:text-(--disabled-foreground) aria-disabled:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // The one filled control: pine fill, white label. Hover darkens one
        // step and pressed one more, so every press answers immediately.
        primary:
          "border border-primary-fill bg-primary-fill text-primary-fill-foreground hover:border-(--primary-fill-hover) hover:bg-(--primary-fill-hover) active:border-(--primary-fill-pressed) active:bg-(--primary-fill-pressed)",
        destructive:
          "border border-destructive bg-destructive text-destructive-foreground hover:opacity-90 active:opacity-80",
        // Outline and secondary have no fill difference from the surface they
        // sit on, so the border is their entire boundary and clears the 3:1
        // non-text floor (`--control-border`). Hover adds a neutral wash;
        // pressed a deeper one.
        outline:
          "border border-(--control-border) bg-transparent text-foreground hover:border-(--control-border-hover) hover:bg-accent active:bg-pressed",
        secondary:
          "border border-(--control-border) bg-secondary text-secondary-foreground hover:border-(--control-border-hover) hover:bg-accent active:bg-pressed",
        // Ghost is quiet chrome: no border at rest, a neutral wash on hover.
        ghost:
          "border border-transparent bg-transparent text-foreground-soft hover:bg-accent hover:text-foreground active:bg-pressed disabled:bg-transparent aria-disabled:bg-transparent",
        // One link treatment app-wide: hue is never the sole carrier, so the
        // underline is always painted rather than appearing on hover.
        link: "text-(--link) underline decoration-from-font underline-offset-4 hover:text-(--link-hover) disabled:bg-transparent aria-disabled:bg-transparent",
      },
      size: {
        default: "h-9 px-4 text-sm font-medium has-[>svg]:px-3",
        // `field` is the named pairing with `Input`/`SelectTrigger`'s 40px box.
        field: "h-10 px-4 text-sm font-medium has-[>svg]:px-3",
        // `toolbar` is the named 32px toolbar box (h-8 / button radius /
        // 13px / medium). `compact` is the same box for in-content actions.
        toolbar:
          "h-8 gap-1.5 px-3 text-(length:--text-small) font-medium has-[>svg]:px-2.5",
        compact:
          "h-8 px-3 text-(length:--text-small) font-medium has-[>svg]:px-2.5",
        xs: "h-6 gap-1 rounded-(--radius-small) px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-3 text-(length:--text-small) font-medium has-[>svg]:px-2.5",
        lg: "h-10 px-5 text-sm font-medium has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs":
          "size-6 rounded-(--radius-small) [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

function Button({
  children,
  className,
  variant = "primary",
  size = "default",
  asChild = false,
  disabled,
  pending = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    pending?: boolean;
  }) {
  const resolvedVariant = variant ?? "primary";
  const resolvedSize = size ?? "default";
  // Pending controls must stay focusable: flipping a focused button to native
  // `disabled` would blur it and drop keyboard users back to <body>. Pending
  // therefore exposes aria-busy + aria-disabled and blocks activation through
  // guarded handlers instead, while truly disabled buttons keep native
  // disabled semantics (and stay out of the tab order that way).
  const isDisabled = Boolean(disabled) || pending;
  const isTrulyDisabled = Boolean(disabled) && !pending;
  const { onClick, onKeyDown, tabIndex, ...restProps } = props;
  const sharedClassName = cn(
    buttonVariants({ variant: resolvedVariant, size: resolvedSize }),
    pending && "overflow-hidden",
    className,
  );
  const handlePendingClick = React.useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (!isDisabled) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    },
    [isDisabled],
  );
  const handlePendingKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (!isDisabled) {
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [isDisabled],
  );
  const pendingRail = pending ? (
    <span
      key="pending-rail"
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-(--button-pending-rail-track)"
    >
      <span className="button-pending-rail absolute inset-y-0 left-[-35%] w-[35%] rounded-full bg-[linear-gradient(90deg,transparent,var(--button-pending-rail),transparent)]" />
    </span>
  ) : null;

  if (asChild && React.isValidElement(children)) {
    const child = children as React.ReactElement<
      React.HTMLAttributes<HTMLElement> & {
        children?: React.ReactNode;
        className?: string;
        [key: `data-${string}`]: string | undefined;
      }
    >;
    const childProps = child.props;
    const resolvedOnClick = isDisabled
      ? handlePendingClick
      : (childProps.onClick ?? onClick);
    const resolvedOnKeyDown = isDisabled
      ? handlePendingKeyDown
      : (childProps.onKeyDown ?? onKeyDown);
    const clonedChildProps = {
      // Forward the remaining button props (aria-describedby, ids, …) so both
      // render paths expose the same accessibility wiring.
      ...restProps,
      // Pending keeps the same exposed state on both paths: busy + disabled,
      // still tabbable so focus survives the transition. Truly disabled
      // children keep this component's aria-disabled convention and drop out
      // of the tab order explicitly.
      ...(pending
        ? { "aria-busy": true as const, "data-pending": "true" }
        : {}),
      ...(isDisabled ? { "aria-disabled": true as const } : {}),
      ...(isTrulyDisabled
        ? { tabIndex: -1 as const }
        : tabIndex !== undefined
          ? { tabIndex }
          : {}),
      "data-slot": "button",
      "data-variant": resolvedVariant,
      "data-size": resolvedSize,
      className: cn(sharedClassName, childProps.className),
      ...(resolvedOnClick ? { onClick: resolvedOnClick } : {}),
      ...(resolvedOnKeyDown ? { onKeyDown: resolvedOnKeyDown } : {}),
    };

    return React.cloneElement(child, {
      ...clonedChildProps,
      children: [childProps.children, pendingRail],
    });
  }

  return (
    <button
      {...(pending
        ? {
            // Busy, not natively disabled: the control keeps its place in the
            // tab order and any existing focus, while the guarded handlers
            // swallow click and Enter/Space activation.
            "aria-busy": true,
            "aria-disabled": true,
            "data-pending": "true" as const,
            onClick: handlePendingClick,
            onKeyDown: handlePendingKeyDown,
          }
        : {
            "aria-busy": undefined,
            "data-pending": undefined,
            disabled: disabled || undefined,
            onClick,
            onKeyDown,
          })}
      data-slot="button"
      data-variant={resolvedVariant}
      data-size={resolvedSize}
      className={sharedClassName}
      tabIndex={tabIndex}
      {...restProps}
    >
      {/* The label never shifts on the pending transition. A half-pixel lift
          used to be applied while pending, so entering the busy state nudged
          the label off the shared control baseline for the duration of the
          save - visible as a jitter beside any static sibling in the same
          row. The activity rail alone carries the state. */}
      <span className="relative z-10 inline-flex items-center justify-center gap-2">
        {children}
      </span>
      {pendingRail}
    </button>
  );
}

export { Button, buttonVariants };
