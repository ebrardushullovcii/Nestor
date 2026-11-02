import { cn } from "@renderer/lib/cn";

import { countText } from "./count-text";

/** The last figure each slot showed this session, in characters. */
const slotWidths = new Map<string, number>();

/**
 * A tab's or chip's count that never moves its neighbours when it lands.
 * "–" (not read yet) is narrower than the number that replaces it, so a
 * route entry nudged every tab after it 3–10 px. The figure sits in a slot at
 * least two digits wide (tabular figures, so 0–99 all fit), and the
 * placeholder of a slot that last showed a longer number keeps that width,
 * so a revisit with "1,234" waiting moves nothing either.
 */
export function CountFigure(props: {
  /** Names the slot across mounts, e.g. "find-jobs:found". */
  slot: string;
  count: number;
  known: boolean;
  className?: string;
}) {
  const text = countText(props.count, props.known);
  if (props.known) slotWidths.set(props.slot, text.length);
  const reserve = Math.max(
    2,
    props.known ? text.length : (slotWidths.get(props.slot) ?? 2),
  );
  return (
    <span
      className={cn("inline-block text-center tabular-nums", props.className)}
      data-count-figure
      style={{ minWidth: `${reserve}ch` }}
    >
      {text}
    </span>
  );
}
