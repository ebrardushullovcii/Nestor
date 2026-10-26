import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ListChecks, X } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { isImeComposingEvent } from "../../lib/job-finder-shortcuts";
import { useJobFinderOverlayOwnership } from "../../lib/job-finder-overlay-ownership";
import {
  refreshActivityFeed,
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
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  // The panel is React-controlled so the overlay ownership stack always knows
  // whether the Task Center is open, regardless of how the last toggle
  // happened (summary click, Escape, outside press, or task navigation).
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const feed = useActivityFeed();
  const running = feed?.running ?? 0;
  const [openError, setOpenError] = useState<string | null>(null);

  const closePanel = useCallback((restoreFocus: boolean) => {
    setIsPanelOpen(false);
    if (restoreFocus) {
      summaryRef.current?.focus();
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
        !detailsRef.current?.contains(event.target)
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
    <details
      className="group relative z-40 shrink-0"
      open={isPanelOpen}
      ref={detailsRef}
    >
      <summary
        aria-label={countLabel ? `Activity: ${countLabel}` : "Activity"}
        className="inline-flex h-10 min-h-10 min-w-10 cursor-pointer list-none items-center justify-center gap-2 rounded-(--radius-button) border border-(--control-border) bg-(--surface-panel) px-2.5 py-2 text-(length:--text-small) font-medium text-muted-foreground outline-none transition-colors hover:border-primary/50 hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 xl:px-4 xl:text-(length:--text-small) [&::-webkit-details-marker]:hidden"
        onClick={(event) => {
          // The panel state owns openness so overlay ownership and shell
          // shortcut blocking stay truthful; cancel the native summary toggle.
          event.preventDefault();
          refreshActivityFeed();
          setIsPanelOpen((open) => !open);
        }}
        ref={summaryRef}
        title={countLabel ? `Activity: ${countLabel}` : "Activity"}
      >
        <ListChecks aria-hidden="true" className="size-4 shrink-0" />
        {/* One name at every width. "Tasks" read as a to-do list for the
            person, which is what Needs you is; this panel is what Job Finder
            itself is doing, so it is named for that. */}
        <span className="hidden whitespace-nowrap min-[900px]:inline max-[1099px]:!hidden xl:max-[1440px]:!hidden">
          Activity
        </span>
        {/* One zero rule for every count in the shell: a badge never renders
            at 0. This chip used to render a permanent grey "Tasks 0" in every
            screenshot of every round — and the one count that rendered zero
            was the one that means "nothing is happening". The accessible name
            on the summary still states the active count at any value. */}
        {running > 0 ? (
          <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-(--input) px-1.5 text-(length:--text-tiny) text-foreground tabular-nums">
            {running}
          </span>
        ) : null}
      </summary>

      {/* Anchored under its own trigger at every width. As a `fixed` sheet it
          resolved against the header — the header paints a backdrop filter,
          which makes it the containing block — so at the minimum window size
          the panel opened upward over the title bar, clipped its own heading
          off the top of the window, and swallowed clicks on the toolbar. */}
      <section
        aria-label="Activity"
        className="surface-popover-solid absolute right-0 top-12 grid max-h-[min(38rem,calc(100vh-8rem))] w-[min(34rem,calc(100vw-2rem))] gap-3 overflow-x-hidden overflow-y-auto rounded-(--radius-panel) border border-(--surface-panel-border) p-4 shadow-(--modal-shadow) motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-150"
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
            <ActivityPanel feed={feed} onOpen={(href) => void openWork(href)} />
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
    </details>
  );
}
