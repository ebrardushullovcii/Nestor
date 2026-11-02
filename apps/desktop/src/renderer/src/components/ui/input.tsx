import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * `size` is the published control scale, not the native numeric `size`
 * attribute (which is why it is omitted from the base props). `default` is the
 * 44px form-field box that `Button size="field"` pairs with; `toolbar` is the
 * 32px ambient-chrome box that `Button size="toolbar"` and
 * `SelectTrigger size="toolbar"` pair with, so a toolbar row is one declared
 * height instead of an `h-9` input beside `h-8` segments.
 */
const INPUT_SIZE_CLASS = {
  default: "h-10 px-3 text-(length:--text-field)",
  toolbar: "h-8 px-2.5 text-(length:--text-small)",
} as const;

type InputSize = keyof typeof INPUT_SIZE_CLASS;

function Input({
  className,
  size = "default",
  type,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & { size?: InputSize }) {
  return (
    <input
      type={type}
      data-slot="input"
      data-size={size}
      className={cn(
        "w-full min-w-0 rounded-(--radius-field) border border-(--field-border) bg-(--field) py-0 tracking-normal text-foreground transition-[border-color,background-color,color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground hover:border-(--field-border-hover)",
        INPUT_SIZE_CLASS[size],
        // Disabled is a painted state, not a transparency: a 50% wash left the
        // field readable-but-muddy and put its border, text and placeholder on
        // three different effective contrasts depending on the surface behind
        // it. All three now bind the shared disabled tokens, so a disabled
        // field is the same inert box wherever it renders.
        "disabled:cursor-not-allowed disabled:border-(--disabled-border) disabled:bg-(--disabled-surface) disabled:text-(--disabled-foreground) disabled:opacity-100 disabled:placeholder:text-(--disabled-foreground)",
        "focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-(--field-focus-shadow) focus-visible:ring-0",
        "aria-invalid:border-destructive aria-invalid:ring-0",
        className,
      )}
      {...props}
    />
  );
}

export { Input, INPUT_SIZE_CLASS };
export type { InputSize };
