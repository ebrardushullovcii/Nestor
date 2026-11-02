import { cn } from "@renderer/lib/cn";

import {
  HEADER_TOOL_COUNT_ATTENTION_CLASS,
  HEADER_TOOL_COUNT_CLASS,
  HEADER_TOOL_COUNT_NEUTRAL_CLASS,
  HEADER_TOOL_COUNT_SLOT_CLASS,
  formatHeaderToolCount,
} from "./header-tool";

/**
 * A header tool's count, pinned to the tool's top-right corner (the tool is
 * `relative`), so the button keeps one width at every count. The figure is
 * announced through the button's own name, never twice.
 */
export function HeaderToolCount(props: {
  count: number;
  tone: "neutral" | "attention";
}) {
  if (props.count <= 0) return null;
  return (
    <span aria-hidden="true" className={HEADER_TOOL_COUNT_SLOT_CLASS}>
      <span
        className={cn(
          HEADER_TOOL_COUNT_CLASS,
          props.tone === "attention"
            ? HEADER_TOOL_COUNT_ATTENTION_CLASS
            : HEADER_TOOL_COUNT_NEUTRAL_CLASS,
        )}
        data-header-tool-count={props.tone}
      >
        {formatHeaderToolCount(props.count)}
      </span>
    </span>
  );
}
