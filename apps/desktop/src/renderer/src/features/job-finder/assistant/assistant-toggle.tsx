import { Sparkles } from "lucide-react";

import { cn } from "@renderer/lib/cn";
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
        "relative inline-flex h-10 min-h-10 min-w-10 items-center justify-center gap-2 rounded-(--radius-button) border border-(--control-border) bg-(--surface-panel) px-2.5 text-(length:--text-small) font-medium text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 max-[899px]:min-w-9 max-[899px]:px-1.5",
        assistant.open &&
          "border-(--nav-active-bar) bg-(--nav-active-surface) text-(--nav-active-foreground)",
      )}
      data-assistant-toggle
      onClick={assistant.toggle}
      title={`${label} (${formatJobFinderShortcutCombo("mod+i", props.platform)})`}
      type="button"
    >
      <Sparkles aria-hidden="true" className="size-4 shrink-0" />
      <span className="hidden whitespace-nowrap min-[900px]:inline max-[1099px]:!hidden xl:max-[1440px]:!hidden">
        Assistant
      </span>
      {assistant.working && !assistant.open ? (
        <span
          aria-hidden="true"
          className="absolute right-1 top-1 size-2 rounded-full bg-primary motion-safe:animate-pulse-brief"
          data-assistant-working-dot
        />
      ) : null}
    </button>
  );
}
