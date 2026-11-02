import type { ReactNode } from "react";
import { cn } from "@renderer/lib/utils";

interface EmptyStateProps {
  children?: ReactNode;
  className?: string;
  description: string;
  title: string;
}

export function EmptyState({
  children,
  className,
  description,
  title,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "grid min-h-(--empty-state-min-height) w-full place-items-center overflow-hidden rounded-(--radius-panel) border border-dashed border-(--surface-panel-border) bg-(--surface-fill-subtle) px-6 py-8 text-center",
        className,
      )}
    >
      <div className="grid max-w-136 gap-3">
        <h2 className="font-display text-(length:--text-section-title) font-semibold tracking-(--tracking-page-title-compact) text-(--text-headline) break-words [overflow-wrap:anywhere]">
          {title}
        </h2>
        <p className="text-(length:--text-description) leading-5 text-foreground-soft break-words [overflow-wrap:anywhere]">
          {description}
        </p>
        {children}
      </div>
    </div>
  );
}
