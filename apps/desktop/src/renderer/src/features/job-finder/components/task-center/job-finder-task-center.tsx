import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ListChecks, X } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";
import {
  HEADER_TOOL_ACTIVE_CLASS,
  HEADER_TOOL_CLASS,
  HEADER_TOOL_COUNTED_LABEL_CLASS,
  HEADER_TOOL_ICON_CLASS,
} from "../header-tool";
import { HeaderToolCount } from "../header-tool-count";
import { isImeComposingEvent } from "../../lib/job-finder-shortcuts";
import { useJobFinderOverlayOwnership } from "../../lib/job-finder-overlay-ownership";
import {
  readActivityFeedNow,
  useActivityFeed,
} from "../../lib/use-activity-feed";

const ActivityPanel = lazy(async () => ({
  default: (await import("./activity-panel")).ActivityPanel,
}));

interface JobFinderTaskCenterProps {
  onNavigate?: ((path: string) => void | Promise<void>) | undefined;
}

/**
 * The header's Activity button and panel: what Job Finder is doing and what
 * it just finished, from the job store. It only reports; anything for the
 * person to do is in Needs you.
 */
export function JobFinderTaskCenter(props: JobFinderTaskCenterProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  // The panel is React-controlled so the overlay ownership stack always knows
  // whether the Task Center is open, regardless of how the last toggle
  // happened (trigger click, Escape, outside press, or task navigation).
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const { feed, failed } = useActivityFeed();
  const running = feed?.running ?? 0;
  const [openError, setOpenError] = useState<string | null>(null);

  const closePanel = useCallback((restoreFocus: boolean) => {
    setIsPanelOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  const { isTopmost: isPanelTopmost } = useJobFinderOverlayOwnership({
    active: isPanelOpen,
    close: () => closePanel(true),
  });

  useEffect(() => {
    if (!isPanelOpen) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // Inner controls and higher overlays keep first claim on Escape.
      if (event.defaultPrevented || isImeComposingEvent(event)) {
        return;
      }
      if (event.key !== "Escape" || !isPanelTopmost()) {
        return;
      }
      event.preventDefault();
      closePanel(true);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        closePanel(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [closePanel, isPanelOpen, isPanelTopmost]);

  async function openWork(href: string) {
    setOpenError(null);
    try {
      if (!props.onNavigate) throw new Error("Navigation is unavailable");
      await props.onNavigate(href);
      setIsPanelOpen(false);
    } catch {
      setOpenError("That page could not open. Try again.");
    }
  }

  const countLabel = running > 0 ? `${running} running` : null;

  return (
    // A named button that says whether its panel is open (was a native
    // <details>, whose summary read as a disclosure of page content).
    <div className="group relative z-40 shrink-0" ref={rootRef}>
      <button
        aria-controls={panelId}
        aria-expanded={isPanelOpen}
        aria-label={countLabel ? `Activity: ${countLabel}` : "Activity"}
        className={cn(
          HEADER_TOOL_CLASS,
          "cursor-pointer",
          isPanelOpen && HEADER_TOOL_ACTIVE_CLASS,
        )}
        onClick={() => {
          readActivityFeedNow();
          setIsPanelOpen((open) => !open);
        }}
        ref={triggerRef}
        title={countLabel ? `Activity: ${countLabel}` : "Activity"}
        type="button"
      >
        {/* The count sits on the icon's corner, inside the button, so it
            keeps 10px from the window's top edge. */}
        <span className={HEADER_TOOL_ICON_CLASS}>
          <ListChecks aria-hidden="true" className="size-4 shrink-0" />
          <HeaderToolCount count={running} tone="neutral" />
        </span>
        {/* One name at every width. "Tasks" read as a to-do list for the
            person, which is what Needs you is; this panel is what Job Finder
            itself is doing, so it is named for that. */}
        <span className={HEADER_TOOL_COUNTED_LABEL_CLASS}>Activity</span>
      </button>

      {/* Anchored under its own trigger at every width. As a `fixed` sheet it
          resolved against the header — the header paints a backdrop filter,
          which makes it the containing block — so at the minimum window size
          the panel opened upward over the title bar, clipped its own heading
          off the top of the window, and swallowed clicks on the toolbar. */}
      {isPanelOpen ? (
        <section
          aria-label="Activity"
          // Toasts wait while it is open over their place (toast.tsx).
          data-overlay-panel
          id={panelId}
          className="surface-popover-solid absolute right-0 top-10 grid max-h-[min(38rem,calc(100vh-8rem))] w-[min(34rem,calc(100vw-2rem))] gap-3 overflow-x-hidden overflow-y-auto rounded-(--radius-panel) border border-(--surface-panel-border) p-4 shadow-(--modal-shadow) motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-150"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="grid gap-1">
              <h2 className="font-display text-(--text-headline)">Activity</h2>
              <p className="text-(length:--text-small) leading-5 text-foreground-soft">
                What Job Finder is doing now and what it just finished.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                aria-label="Close Activity"
                className="shrink-0"
                onClick={() => closePanel(true)}
                size="icon"
                type="button"
                variant="ghost"
              >
                <X aria-hidden="true" className="size-4" />
              </Button>
            </div>
          </div>

          <Suspense
            fallback={
              <p className="px-1 text-(length:--text-small) text-foreground-soft">
                Loading activity…
              </p>
            }
          >
            {isPanelOpen ? (
              <ActivityPanel
                failed={failed}
                feed={feed}
                onOpen={(href) => void openWork(href)}
              />
            ) : null}
          </Suspense>
          {openError ? (
            <p
              className="rounded-md border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-(length:--text-small) leading-5 text-foreground-soft"
              role="status"
            >
              {openError}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
