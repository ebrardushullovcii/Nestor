import { useId, type ComponentProps, type ReactNode } from "react";

import { cn } from "@renderer/lib/cn";

import { PageStatusLine, type PageStatusItem } from "./page-status-line";

interface PageHeaderProps {
  /**
   * Page-level actions on the right of the title row: `size="sm"` buttons,
   * at most two.
   */
  actions?: ReactNode;
  /**
   * One sentence of 90 characters or fewer about what the page is for. Beside
   * the title it shows whole or not at all; under it, it wraps. The full text
   * is its tooltip and the heading's accessible description. Instructions
   * belong where they apply.
   */
  description: string;
  title: string;
}

/**
 * One row: the title, a one-line description beside it, and the page actions
 * on the right. In a window under 64rem of text (1024px at the default size,
 * or larger text) the description drops under the title and wraps there,
 * never cut with "…".
 */
export function PageHeader({ actions, description, title }: PageHeaderProps) {
  const descriptionId = useId();

  return (
    <header
      className="flex min-h-8 min-w-0 items-center justify-between gap-4"
      data-page-header
      tabIndex={-1}
    >
      {/* Beside the title (from 1024px) the description shows whole or not
          at all: when it does not fit it wraps to a second line that this
          row clips, instead of ending mid-word ("Read, edit if you lik…").
          Its words stay the heading's description and its tooltip. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1 window-wide:max-h-8 window-wide:flex-row window-wide:flex-wrap window-wide:items-baseline window-wide:gap-x-3 window-wide:gap-y-4 window-wide:overflow-hidden">
        <h1
          aria-describedby={descriptionId}
          className="shrink-0 font-display text-(length:--text-page-title-compact) font-semibold leading-none tracking-(--tracking-page-title-compact) text-(--headline-primary)"
        >
          {title}
        </h1>
        <p
          className="min-w-0 text-(length:--text-page-description-compact) leading-5 text-foreground-soft window-wide:shrink-0 window-wide:whitespace-nowrap"
          id={descriptionId}
          title={description}
        >
          {description}
        </p>
      </div>
      {actions ? (
        <div
          className="flex shrink-0 items-center gap-2"
          data-page-header-actions
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}

export function PageHeaderStack(
  props: PageHeaderProps & {
    /**
     * Toned items for the status line under the title (ADR 0044). The line
     * is not rendered when the list is empty.
     */
    statusItems?: readonly PageStatusItem[];
    subnav?: ReactNode;
  },
) {
  const { statusItems, subnav, ...headerProps } = props;

  return (
    // min-w-0: in a grid page the description beside the title (one line)
    // must not size the column to its whole text (with larger text it ran
    // the page ~160px past the window).
    <div className="mb-(--gap-page-header-body) min-w-0" data-page-header-stack>
      <PageHeader {...headerProps} />
      {statusItems && statusItems.length > 0 ? (
        <PageStatusLine items={statusItems} />
      ) : null}
      {subnav ? (
        <div className="mt-(--gap-page-header-aux)" data-page-header-subnav>
          {subnav}
        </div>
      ) : null}
      <div
        aria-hidden="true"
        className="mt-(--gap-page-header-aux) border-b border-(--surface-panel-border)"
        data-page-header-divider
      />
    </div>
  );
}

export function PageSubnav({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}
      data-page-subnav
      {...props}
    />
  );
}

export type { PageStatusAction, PageStatusItem } from "./page-status-line";
