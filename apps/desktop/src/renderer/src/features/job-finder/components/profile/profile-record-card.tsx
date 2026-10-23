import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
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
      <summary
        className="flex items-start justify-between gap-3 list-none cursor-pointer"
        // Mount the fields on the press itself, before the toggle event, so
        // the opened card paints with its fields in the same frame.
        onClick={() => setHasOpened(true)}
      >
        <span className="grid gap-1 min-w-0">
          <span className="text-[0.96rem] font-semibold text-(--text-headline)">
            {title}
          </span>
          {statusLabel ? <Badge variant="status">{statusLabel}</Badge> : null}
          <span className="text-(length:--text-description) leading-6 text-foreground-muted">
            {detailSummary}
          </span>
        </span>

        {/* Visual affordance only: the native <details> element already
            exposes expanded/collapsed state, and an always-flipping
            "Expand"/"Collapse" label inside <summary> would make the
            accessible name unstable for screen readers. */}
        <span
          aria-hidden="true"
          className="inline-flex items-center gap-1 rounded-full border border-(--surface-well-border) bg-(--surface-well) px-2.5 py-1 text-(length:--text-tiny) font-medium uppercase tracking-(--tracking-mono) text-foreground-muted transition-transform group-open:[&_svg]:rotate-180"
        >
          <ChevronDown className="size-3 transition-transform duration-200" />
          <span>{isOpen ? "Collapse" : "Expand"}</span>
        </span>
      </summary>

      <div className="mt-4 grid gap-4 border-t border-(--surface-panel-border) pt-4">
        {isOpen || hasOpened ? children : null}
      </div>
    </details>
  );
}
