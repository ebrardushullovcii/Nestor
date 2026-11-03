import { cn } from "@renderer/lib/cn";

import {
  HEADER_TOOL_COUNT_ATTENTION_CLASS,
  HEADER_TOOL_COUNT_CLASS,
  HEADER_TOOL_COUNT_NEUTRAL_CLASS,
  HEADER_TOOL_COUNT_SLOT_CLASS,
  HEADER_TOOL_INLINE_COUNT_CLASS,
  formatHeaderToolCount,
} from "./header-tool";

/**
 * A header tool's count. On the corner (the default), it is pinned to the
 * tool's top-right corner (the tool is `relative`), so the button keeps one
 * width at every count. Inline, it is a pill in the button's own row after
 * the label, so it never covers the icon. The figure is announced through
 * the button's own name, never twice.
 */
export function HeaderToolCount(props: {
  count: number;
  tone: "neutral" | "attention";
  placement?: "corner" | "inline";
}) {
  if (props.count <= 0) return null;
  const toneClass =
    props.tone === "attention"
      ? HEADER_TOOL_COUNT_ATTENTION_CLASS
      : HEADER_TOOL_COUNT_NEUTRAL_CLASS;
  if (props.placement === "inline") {
    return (
      <span
        aria-hidden="true"
        className={cn(HEADER_TOOL_INLINE_COUNT_CLASS, toneClass)}
        data-header-tool-count={props.tone}
      >
        {formatHeaderToolCount(props.count)}
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={HEADER_TOOL_COUNT_SLOT_CLASS}>
      <span
        className={cn(HEADER_TOOL_COUNT_CLASS, toneClass)}
        data-header-tool-count={props.tone}
      >
        {formatHeaderToolCount(props.count)}
      </span>
    </span>
  );
}
