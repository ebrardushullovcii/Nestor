import type { ReactNode } from "react";

interface ProfileSectionHeaderProps {
  action?: ReactNode;
  description?: string;
  eyebrow?: string;
  headingId?: string;
  title: string;
}

export function ProfileSectionHeader({
  action,
  description,
  eyebrow,
  headingId,
  title,
}: ProfileSectionHeaderProps) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="grid gap-1.5">
        {/* The eyebrow is kept for assistive tech only: on screen it repeated
            the active tab's name above every section title, which stacked
            three headings before the first field. */}
        {eyebrow ? <span className="sr-only">{eyebrow}. </span> : null}
        <div className="grid gap-1.5">
          <h2
            className="text-(length:--text-section-title) font-semibold tracking-(--tracking-page-title) text-(--text-headline) outline-none"
            id={headingId}
            tabIndex={headingId ? -1 : undefined}
          >
            {title}
          </h2>
          {description ? (
            <p className="max-w-[62ch] text-(length:--text-description) leading-6 text-foreground-muted">
              {description}
            </p>
          ) : null}
        </div>
      </div>

      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}
