import * as React from "react";
import { Label as LabelPrimitive } from "radix-ui";

import { cn } from "@renderer/lib/utils";

function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        // A field label: 13px medium in sentence case, one step quieter than
        // the field's own text. Disabled moves it to the disabled text token
        // rather than an opacity wash.
        "flex items-center gap-2 font-display text-(length:--text-field-label) leading-5 font-medium text-foreground-soft select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:text-(--disabled-foreground) peer-disabled:cursor-not-allowed peer-disabled:text-(--disabled-foreground)",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
