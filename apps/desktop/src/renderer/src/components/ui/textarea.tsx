import * as React from "react";

import { cn } from "../../lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-24 w-full resize-none overflow-y-auto rounded-(--radius-field) border border-(--field-border) bg-(--field) px-3.5 py-2.5 text-(length:--text-field) leading-[1.45] tracking-normal text-foreground transition-[border-color,background-color,color,box-shadow] outline-none placeholder:text-muted-foreground hover:border-(--field-border-hover) focus-visible:border-(--field-focus-border) focus-visible:bg-(--field-strong) focus-visible:shadow-(--field-focus-shadow) focus-visible:ring-0 disabled:cursor-not-allowed disabled:border-(--disabled-border) disabled:bg-(--disabled-surface) disabled:text-(--disabled-foreground) disabled:placeholder:text-(--disabled-foreground) aria-invalid:border-destructive aria-invalid:ring-0",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
