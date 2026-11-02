import { Sparkles } from "lucide-react";

import { cn } from "@renderer/lib/cn";
import {
  HEADER_TOOL_ACTIVE_CLASS,
  HEADER_TOOL_CLASS,
  HEADER_TOOL_ICON_CLASS,
  HEADER_TOOL_LABEL_CLASS,
} from "../components/header-tool";
import {
  formatJobFinderShortcutCombo,
  getJobFinderAriaKeyshortcuts,
  type JobFinderPlatform,
} from "../lib/job-finder-shortcuts";
import { useAssistant } from "./assistant-provider";

/**
 * The button beside the browser launcher that shows or hides the assistant.
 * A dot says the assistant is still working while the sidebar is hidden.
 */
export function AssistantToggle(props: { platform: JobFinderPlatform }) {
  const assistant = useAssistant();
  if (!assistant) return null;
  const label = assistant.open ? "Hide the assistant" : "Open the assistant";
  return (
    <button
      aria-keyshortcuts={getJobFinderAriaKeyshortcuts("mod+i", props.platform)}
      aria-label={
        assistant.working && !assistant.open ? `${label} (working)` : label
      }
      aria-pressed={assistant.open}
      className={cn(
        HEADER_TOOL_CLASS,
        assistant.open && HEADER_TOOL_ACTIVE_CLASS,
      )}
      data-assistant-toggle
      onClick={assistant.toggle}
      title={`${label} (${formatJobFinderShortcutCombo("mod+i", props.platform)})`}
      type="button"
    >
      <span className={HEADER_TOOL_ICON_CLASS}>
        <Sparkles aria-hidden="true" className="size-4 shrink-0" />
        {assistant.working && !assistant.open ? (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 size-2 rounded-full bg-primary ring-2 ring-(--shell-header-bg) motion-safe:animate-pulse-brief"
            data-assistant-working-dot
          />
        ) : null}
      </span>
      <span className={HEADER_TOOL_LABEL_CLASS}>Assistant</span>
    </button>
  );
}
