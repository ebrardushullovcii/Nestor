import type { ReactNode } from "react";
import { Send } from "lucide-react";
import { Badge } from "@renderer/components/ui/badge";
import { cn } from "@renderer/lib/utils";
import type { BadgeTone } from "../lib/job-finder-types";

const READY_TO_SEND = "Ready to send";

interface StatusBadgeProps {
  children: ReactNode;
  className?: string;
  tone: BadgeTone;
  /** A short hint for a term the badge cannot explain itself. */
  title?: string | undefined;
}

export function StatusBadge({
  children,
  className,
  title,
  tone,
}: StatusBadgeProps) {
  // One meaning per family: positive = sent, approved, offer; warning =
  // needs you; active = in progress (info); critical = failed or rejected;
  // muted and neutral = waiting or closed. Each is a solid tint from the
  // palette with its own text colour (>= 4.5:1 on that tint, pinned by
  // styles/globals.test.ts), never a hue-alpha mix of the accent.
  const toneClassName = {
    active: "bg-(--info-surface) text-(--info-text)",
    critical: "bg-(--danger-surface) text-destructive",
    muted: "bg-secondary text-muted-foreground",
    neutral: "bg-secondary text-foreground-soft",
    positive: "bg-(--success-surface) text-(--success-text)",
    warning: "bg-(--warning-surface) text-(--warning-text)",
  }[tone];

  // "Ready to send" and "Needs you" share the amber of "waiting on you"
  // (decision e); the send glyph tells the one that only needs a press
  // from the one that needs an answer, without leaning on the words alone.
  const readyToSend =
    typeof children === "string" && children.startsWith(READY_TO_SEND);

  return (
    <Badge
      className={cn(
        "inline-block w-auto min-w-0 max-w-full shrink whitespace-normal break-words text-center leading-4 [overflow-wrap:anywhere]",
        readyToSend && "inline-flex items-center gap-1",
        toneClassName,
        className,
      )}
      title={title}
      variant="status"
    >
      {readyToSend ? (
        <Send aria-hidden="true" className="size-3 shrink-0" />
      ) : null}
      {children}
    </Badge>
  );
}
