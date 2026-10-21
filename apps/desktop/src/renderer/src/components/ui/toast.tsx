import * as React from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";

import { cn } from "@renderer/lib/utils";

import { Button } from "./button";

/**
 * Toasts report something that just happened and needs nothing from the
 * person: a finished search, a saved change, an applied edit. They arrive
 * at the bottom left of the content, where screens keep lists and status
 * text rather than their main actions, stay six seconds (longer while the
 * pointer or focus is on them), and offer at most one action. Anything that needs the
 * person - a failure with a retry, a hold, a decision - stays inline next to
 * the control it concerns and never lives only in a toast (ADR 0042).
 */
export interface ToastInput {
  /** Replaces a visible toast with the same id instead of stacking. */
  readonly id?: string;
  readonly title: string;
  readonly description?: string;
  readonly tone?: "neutral" | "success" | "warning";
  readonly action?: { readonly label: string; readonly onClick: () => void };
  /** Milliseconds before it leaves on its own. */
  readonly duration?: number;
  /**
   * A toast is news about the screen it was raised on, so by default it
   * leaves when the person moves to another screen; "3 jobs added to
   * Shortlisted" used to follow them onto Shortlisted itself. "app" keeps it
   * across screens for news that is not about the screen.
   */
  readonly scope?: "screen" | "app";
}

interface ToastEntry extends ToastInput {
  readonly key: string;
  readonly createdAt: number;
}

interface ToastContextValue {
  showToast: (toast: ToastInput) => void;
  dismissToast: (id: string) => void;
  /** Called when the person moves to another screen. */
  dismissScreenToasts: () => void;
}

const DEFAULT_DURATION_MS = 6000;
const MAX_VISIBLE = 3;
/**
 * A toast raised by the press that also changes screen (an action that
 * navigates once it finishes) belongs to the screen it lands on.
 */
const SCREEN_CHANGE_GRACE_MS = 750;

const noop = () => undefined;
const ToastContext = React.createContext<ToastContextValue>({
  showToast: noop,
  dismissToast: noop,
  dismissScreenToasts: noop,
});

/**
 * Drops screen-scoped toasts when `screenKey` changes. The first value is the
 * screen the person arrived on, so nothing is dismissed on mount.
 */
export function useDismissToastsOnScreenChange(screenKey: string): void {
  const { dismissScreenToasts } = useToast();
  const previousKeyRef = React.useRef(screenKey);
  React.useEffect(() => {
    if (previousKeyRef.current === screenKey) return;
    previousKeyRef.current = screenKey;
    dismissScreenToasts();
  }, [dismissScreenToasts, screenKey]);
}

/** No-op outside a provider, so a screen rendered on its own still works. */
export function useToast(): ToastContextValue {
  return React.useContext(ToastContext);
}

const SCROLL_OWNERS =
  "[data-locked-pane-scroll-region], [data-locked-screen-scroll-area], [data-job-finder-shell-content] > main";
const TOAST_AVOID =
  "[data-collection-pagination], [data-job-results-pagination], [data-locked-screen-bottom-content], [data-toast-avoid]";
const EDGE_GAP = 16;
const CONTENT_GAP = 8;

interface ToastLayout {
  left: number;
  bottom: number;
  spacers: readonly { owner: HTMLElement; height: number; gap: number }[];
}

/** Reserve scroll range, never space around the page or its viewport. */
function useToastLayout(
  viewportRef: React.RefObject<HTMLElement | null>,
  active: boolean,
): ToastLayout {
  const [layout, setLayout] = React.useState<ToastLayout>({
    left: EDGE_GAP,
    bottom: EDGE_GAP,
    spacers: [],
  });

  const layoutRef = React.useRef(layout);
  layoutRef.current = layout;
  const activeRef = React.useRef(active);
  activeRef.current = active;
  const measureRef = React.useRef<(() => void) | null>(null);
  // The effect restarts only when the layer turns on or off. Restarting it
  // whenever a spacer came or went let a kept spacer and the next measurement
  // undo each other inside one commit, an endless update loop that blanked
  // the app.
  const running = active || layout.spacers.length > 0;

  React.useLayoutEffect(() => {
    if (!running) return undefined;
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    let frame: number | undefined;
    const observed = new Set<Element>();
    // Whether each scroll area already scrolled before any spacer was added.
    // An area that did not would gain a scrollbar from the spacer, and the
    // scrollbar shifts the whole page sideways; it gets no spacer. Recorded
    // once per toast so a spacer can never feed back into the decision.
    const scrolledBeforeToast = new Map<HTMLElement, boolean>();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => schedule());
    const measure = () => {
      const sidebar = document.querySelector<HTMLElement>(
        "[data-job-finder-sidebar]",
      );
      const sidebarRect = sidebar?.getBoundingClientRect();
      const left =
        sidebarRect && sidebarRect.width > 0
          ? sidebarRect.right + EDGE_GAP
          : EDGE_GAP;
      const { height, width } = viewport.getBoundingClientRect();
      let bottom = EDGE_GAP;
      const avoid = Array.from(
        document.querySelectorAll<HTMLElement>(TOAST_AVOID),
      );
      // Lowest first: a lifted stack must also clear a higher visible pager.
      const avoidRects = avoid
        .map((element) => element.getBoundingClientRect())
        .sort((a, b) => b.top - a.top);
      for (const rect of avoidRects) {
        const stackBottom = window.innerHeight - bottom;
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left < left + width &&
          rect.right > left &&
          rect.top < stackBottom &&
          rect.bottom > stackBottom - height
        ) {
          bottom = window.innerHeight - rect.top + CONTENT_GAP;
        }
      }
      const top = window.innerHeight - bottom - height;
      const owners = Array.from(
        document.querySelectorAll<HTMLElement>(SCROLL_OWNERS),
      );
      const previousSpacers = layoutRef.current.spacers;
      const candidates = activeRef.current
        ? owners.flatMap((owner) => {
            const overflowY = window.getComputedStyle(owner).overflowY;
            const rect = owner.getBoundingClientRect();
            if (
              (overflowY !== "auto" && overflowY !== "scroll") ||
              rect.width <= 0 ||
              rect.height <= 0 ||
              rect.left >= left + width ||
              rect.right <= left ||
              rect.bottom <= top
            )
              return [];
            if (!scrolledBeforeToast.has(owner))
              scrolledBeforeToast.set(
                owner,
                owner.scrollHeight -
                  (previousSpacers.find((spacer) => spacer.owner === owner)
                    ?.height ?? 0) >
                  owner.clientHeight + 1,
              );
            if (!scrolledBeforeToast.get(owner)) return [];
            const row = owner.querySelector<HTMLElement>(
              "tbody tr, li:not([data-toast-scroll-spacer-slot])",
            );
            const rowHeight =
              row?.getBoundingClientRect().height ||
              parseFloat(window.getComputedStyle(owner).lineHeight) ||
              32;
            // Even a tall stack leaves one row of scrollable content.
            const maxClearance = Math.max(0, owner.clientHeight - rowHeight);
            return [
              {
                owner,
                gap: parseFloat(window.getComputedStyle(owner).rowGap) || 0,
                height: Math.ceil(
                  Math.min(
                    maxClearance,
                    Math.min(rect.bottom, window.innerHeight) -
                      top +
                      CONTENT_GAP,
                  ),
                ),
              },
            ];
          })
        : [];
      // A pane filling the bottom of its route already owns this clearance.
      // Do not give the route a second scroll range underneath that pane.
      const spacers = candidates.filter(
        ({ owner }) =>
          !candidates.some(
            ({ owner: nested }) =>
              owner !== nested &&
              owner.contains(nested) &&
              Math.abs(
                owner.getBoundingClientRect().bottom -
                  nested.getBoundingClientRect().bottom,
              ) <= EDGE_GAP,
          ),
      );
      // Shrinking scroll range while its tail is visible clamps scrollTop.
      // Keep that range until the person scrolls above it, including when
      // just one of several toasts leaves. Disconnected routes need no space.
      for (const previous of previousSpacers) {
        if (!previous.owner.isConnected) continue;
        const index = spacers.findIndex(
          ({ owner }) => owner === previous.owner,
        );
        const nextHeight = spacers[index]?.height ?? 0;
        const naturalEnd = Math.max(
          0,
          previous.owner.scrollHeight -
            previous.owner.clientHeight -
            previous.height,
        );
        if (
          previous.height > nextHeight &&
          previous.owner.scrollTop > naturalEnd + nextHeight
        ) {
          if (index < 0) spacers.push(previous);
          else spacers[index] = previous;
        }
      }
      for (const element of [
        viewport,
        ...(sidebar ? [sidebar] : []),
        ...avoid,
        ...owners,
      ]) {
        if (!observed.has(element)) {
          observed.add(element);
          resizeObserver?.observe(element);
        }
      }
      for (const element of observed) {
        if (!element.isConnected) {
          resizeObserver?.unobserve(element);
          observed.delete(element);
        }
      }
      setLayout((current) =>
        current.left === left &&
        current.bottom === bottom &&
        current.spacers.length === spacers.length &&
        current.spacers.every(
          (spacer, index) =>
            spacer.owner === spacers[index]?.owner &&
            spacer.height === spacers[index]?.height &&
            spacer.gap === spacers[index]?.gap,
        )
          ? current
          : { left, bottom, spacers },
      );
    };
    const schedule = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        measure();
      });
    };
    measure();
    measureRef.current = measure;
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "data-sidebar-collapsed"],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      measureRef.current = null;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      mutations.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [running, viewportRef]);
  // A toast arriving or the last one leaving re-measures at once. Measuring
  // never changes `active`, so this cannot feed back into itself.
  React.useLayoutEffect(() => {
    measureRef.current?.();
  }, [active]);
  return layout;
}

let toastSequence = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const viewportRef = React.useRef<HTMLElement | null>(null);
  const [toasts, setToasts] = React.useState<readonly ToastEntry[]>([]);

  const layout = useToastLayout(viewportRef, toasts.length > 0);

  const dismissToast = React.useCallback((id: string) => {
    setToasts((current) =>
      current.filter((toast) => toast.key !== id && toast.id !== id),
    );
  }, []);

  const showToast = React.useCallback((toast: ToastInput) => {
    toastSequence += 1;
    const key = `toast-${toastSequence}`;
    const createdAt = Date.now();
    setToasts((current) =>
      [
        { ...toast, key, createdAt },
        ...current.filter((entry) => !toast.id || entry.id !== toast.id),
      ].slice(0, MAX_VISIBLE),
    );
  }, []);

  const dismissScreenToasts = React.useCallback(() => {
    const cutoff = Date.now() - SCREEN_CHANGE_GRACE_MS;
    setToasts((current) => {
      const kept = current.filter(
        (toast) => toast.scope === "app" || toast.createdAt > cutoff,
      );
      return kept.length === current.length ? current : kept;
    });
  }, []);

  const value = React.useMemo(
    () => ({ showToast, dismissToast, dismissScreenToasts }),
    [showToast, dismissToast, dismissScreenToasts],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {layout.spacers.map(({ owner, height, gap }, index) =>
        createPortal(
          React.createElement(
            owner.tagName === "UL" || owner.tagName === "OL" ? "li" : "div",
            {
              "aria-hidden": true,
              "data-toast-scroll-spacer-slot": "",
              className: "pointer-events-none col-span-full shrink-0",
              // The zero-height slot does not enlarge naturally sized panes or
              // move their siblings. Its absolute child extends only the scroll
              // range; cancel a grid/flex gap introduced by the trailing slot.
              style: {
                position: "relative",
                height: 0,
                marginTop: -gap,
                overflowAnchor: "none",
              },
            },
            <div
              data-toast-scroll-spacer
              style={{ position: "absolute", top: 0, width: 1, height }}
            />,
          ),
          owner,
          `toast-spacer-${index}`,
        ),
      )}
      {createPortal(
        <section
          aria-label="Notifications"
          className="pointer-events-none fixed z-[130] flex flex-col-reverse gap-2"
          ref={viewportRef}
          style={{
            bottom: layout.bottom,
            left: layout.left,
            width: `min(22.5rem, calc(100vw - ${layout.left}px - var(--assistant-sidebar-reserved, 0px) - 1rem))`,
          }}
          data-toast-viewport
        >
          {toasts.map((toast) => (
            <ToastCard
              key={toast.key}
              onDismiss={() => dismissToast(toast.key)}
              toast={toast}
            />
          ))}
        </section>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

function ToastCard({
  onDismiss,
  toast,
}: {
  onDismiss: () => void;
  toast: ToastEntry;
}) {
  const [held, setHeld] = React.useState(false);
  const duration =
    toast.duration ?? (toast.action ? 20_000 : DEFAULT_DURATION_MS);
  // The provider hands a fresh closure on every render; the timer must not
  // restart each time another toast arrives.
  const dismissRef = React.useRef(onDismiss);
  dismissRef.current = onDismiss;

  React.useEffect(() => {
    if (held) return undefined;
    const timer = window.setTimeout(() => dismissRef.current(), duration);
    return () => window.clearTimeout(timer);
  }, [duration, held]);

  const Icon =
    toast.tone === "success"
      ? CheckCircle2
      : toast.tone === "warning"
        ? CircleAlert
        : Info;

  return (
    <div
      aria-atomic="true"
      aria-live="polite"
      className="pointer-events-auto flex items-start gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) bg-popover py-3 pl-3.5 pr-2 text-popover-foreground shadow-(--select-shadow) animate-in fade-in-0 slide-in-from-bottom-2 motion-reduce:animate-none"
      data-toast
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setHeld(false);
        }
      }}
      onFocus={() => setHeld(true)}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      role="status"
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0",
          toast.tone === "success"
            ? "text-(--success-text)"
            : toast.tone === "warning"
              ? "text-(--warning-text)"
              : "text-muted-foreground",
        )}
      />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="text-(length:--text-small) font-medium leading-5 text-foreground">
          {toast.title}
        </p>
        {toast.description ? (
          <p className="text-(length:--text-description) leading-5 text-foreground-muted">
            {toast.description}
          </p>
        ) : null}
        {toast.action ? (
          <button
            className="mt-1 w-fit rounded-(--radius-small) text-(length:--text-small) font-medium text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring"
            onClick={() => {
              toast.action?.onClick();
              onDismiss();
            }}
            type="button"
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      <Button
        aria-label="Dismiss"
        className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
        onClick={onDismiss}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <X aria-hidden="true" className="size-4" />
      </Button>
    </div>
  );
}
