import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Badge } from "@renderer/components/ui/badge";
import { cn } from "@renderer/lib/cn";

interface ProfileRecordCardProps {
  children: ReactNode;
  className?: string;
  id?: string;
  // Only applied on mount. Later changes never collapse an open card; pass
  // forceOpenSignal to open an existing card explicitly (for example right
  // after appending it).
  defaultOpen?: boolean;
  forceOpenSignal?: string | null;
  summary?: string;
  title: string;
  statusLabel?: string | undefined;
}

export function ProfileRecordCard({
  children,
  className,
  id,
  defaultOpen = false,
  forceOpenSignal = null,
  summary,
  title,
  statusLabel,
}: ProfileRecordCardProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  // A closed card's fields are mounted the first time it opens, not before:
  // Work history and Background drew every role's full editor up front
  // (about 1,500 nodes) behind collapsed cards nobody had opened. Values live
  // in the form, so an unopened card loses nothing.
  const [hasOpened, setHasOpened] = useState(defaultOpen);
  const detailSummary = summary?.trim() || "Review and edit this entry.";

  useEffect(() => {
    if (forceOpenSignal) {
      setIsOpen(true);
      setHasOpened(true);
    }
  }, [forceOpenSignal]);

  return (
    <details
      id={id}
      className={cn(
        "surface-card-tint group rounded-(--radius-panel) border border-(--surface-panel-border) p-4 [&_summary::-webkit-details-marker]:hidden",
        className,
      )}
      onToggle={(event) => {
        const open = event.currentTarget.open;
        setIsOpen(open);
        if (open) setHasOpened(true);
      }}
      open={isOpen}
    >
      {/* The shared disclosure's summary: a leading chevron on the title's
          first line that turns a quarter on open, the same focus ring and
          hover, the whole row the target. */}
      <summary
        className="-m-1 flex cursor-pointer list-none items-start gap-1.5 rounded-(--radius-button) p-1 outline-none select-none focus-ring"
        data-slot="disclosure-summary"
        // Mount the fields on the press itself, before the toggle event, so
        // the opened card paints with its fields in the same frame.
        onClick={() => setHasOpened(true)}
      >
        <ChevronRight
          aria-hidden="true"
          className="mt-1 size-4 shrink-0 text-foreground-soft opacity-75 transition-transform duration-(--duration-base) ease-(--ease-standard) [details[open]>summary>&]:rotate-90"
        />
        <span className="grid min-w-0 gap-1">
          <span className="text-base font-semibold text-(--text-headline)">
            {title}
          </span>
          {statusLabel ? <Badge variant="status">{statusLabel}</Badge> : null}
          <span className="text-(length:--text-description) leading-5 text-foreground-muted">
            {detailSummary}
          </span>
        </span>
      </summary>

      <div className="mt-4 grid gap-4 border-t border-(--surface-panel-border) pt-4">
        {isOpen || hasOpened ? children : null}
      </div>
    </details>
  );
}
