import { useState, type ReactNode } from "react";

import { Disclosure } from "@renderer/components/ui/disclosure";

interface ProfileOptionalSectionProps {
  children: ReactNode;
  // Only applied on mount so later value changes never collapse an open
  // section while the user is editing inside it.
  defaultOpen?: boolean;
  description: string;
  title: string;
}

export function ProfileOptionalSection({
  children,
  defaultOpen = false,
  description,
  title,
}: ProfileOptionalSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    // A plain disclosure under one hairline, never a box inside the
    // section's box: the shared expander, in its block size.
    <Disclosure
      className="border-t border-(--surface-panel-border) pt-3"
      contentClassName="grid gap-4 pt-4 pl-6"
      onOpenChange={setOpen}
      open={open}
      size="block"
      summary={
        <span className="grid min-w-0 gap-0.5">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="text-(length:--text-body) font-semibold text-(--text-headline)">
              {title}
            </span>
            <span className="text-(length:--text-tiny) text-foreground-muted">
              Optional
            </span>
          </span>
          <span className="max-w-[70ch] text-(length:--text-description) font-normal leading-5 text-foreground-muted">
            {description}
          </span>
        </span>
      }
    >
      {children}
    </Disclosure>
  );
}
