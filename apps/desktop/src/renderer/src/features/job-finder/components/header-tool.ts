import { formatCompactCount } from "@renderer/lib/compact-count";

/**
 * The window header's tools (Search, Activity, Assistant, Browser, Needs you)
 * share one quiet ghost button: no border at rest, a neutral wash on hover, a
 * deeper one when pressed or open. Each has a fixed width at every window
 * size - icon only below 75rem of header (1200px at the default text size),
 * icon plus label from there. The breakpoint is a container query on the
 * header in rem, not a viewport media query in px: larger text (a bigger root
 * font) folds the labels to icons the way a narrow window does, instead of
 * running "Job Finder" into "Search"; the app's own zoom, which scales the
 * root font and the window alike, keeps the 1200px behaviour. A count is a
 * small pill pinned to the tool's top-right corner, out of the flow: no tool
 * reserves room for one, so every tool is its own natural width and the gaps
 * between them are equal, and a count arriving never resizes the button or
 * moves its neighbours.
 */
export const HEADER_TOOL_CLASS =
  "relative inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-(--radius-button) border border-transparent px-2 text-(length:--text-small) font-medium whitespace-nowrap text-foreground-soft outline-none transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground active:bg-pressed focus-ring";

/** Pressed / open state of a header tool (Assistant open, Needs you page). */
export const HEADER_TOOL_ACTIVE_CLASS =
  "bg-accent-tint text-foreground hover:bg-accent-tint";

/**
 * The label beside a header tool's icon: shown from 75rem of header (the
 * header is the `shell-header` query container, job-finder-shell.tsx).
 */
export const HEADER_TOOL_LABEL_CLASS =
  "hidden @min-[75rem]/shell-header:inline";

/**
 * The label of a tool whose icon carries a count: 6px further from the
 * icon, so the pill on the icon's corner clears the first letter. Always,
 * count or not, so a count arriving moves nothing.
 */
export const HEADER_TOOL_COUNTED_LABEL_CLASS =
  "hidden @min-[75rem]/shell-header:inline ml-1.5";

/** The icon box the corner badge anchors to. */
export const HEADER_TOOL_ICON_CLASS = "relative inline-flex size-4 shrink-0";

/** Where a count sits: the tool's top-right corner, over its edge. */
export const HEADER_TOOL_COUNT_SLOT_CLASS =
  "pointer-events-none absolute -top-1.5 -right-1.5 z-10 flex";

/**
 * The count itself: a small pill, ringed in the header's own colour so it
 * reads as lying on the button's corner. Attention counts (Needs you) are the
 * warning colour; activity counts are an outlined neutral pill that reads on
 * the header (3:1 edge, body-text figure).
 */
export const HEADER_TOOL_COUNT_CLASS =
  "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-xs leading-none font-medium tabular-nums ring-2 ring-(--shell-header-bg)";
export const HEADER_TOOL_COUNT_NEUTRAL_CLASS =
  "border border-(--border-strong) bg-(--shell-header-bg) text-foreground";
export const HEADER_TOOL_COUNT_ATTENTION_CLASS =
  "border border-transparent bg-(--warning-text) text-(--background)";

/** A count as the header shows it. */
export function formatHeaderToolCount(count: number): string {
  return formatCompactCount(count);
}
