import * as React from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";

import { cn } from "@renderer/lib/utils";

import { Button } from "./button";
import { FitText, shorterWords } from "./fit-text";

/**
 * Toasts report something that just happened and needs nothing from the
 * person: a finished search, a saved change, an applied edit. They arrive
 * in the app header's empty middle, a slot reserved for them, so they never
 * cover the document, form or list being worked on (where the header has no
 * room for them, at the bottom right of the content). One shows at a time:
 * a newer one takes the place of the older ones, which wait (their time
 * held) and show again once it leaves. They stay six seconds (longer while the
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
/** Root text above this (px) counts as enlarged text. */
const LARGE_TEXT_PX = 16.5;

/**
 * With enlarged text a toast over the content would hide the page's next
 * steps (its buttons and rows) while it shows. Instead the content gives up a
 * band at its bottom the toast's own height, and the toast sits in that band:
 * nothing is under it. The shell reads `--toast-band` as its bottom padding.
 */
function setToastBand(px: number): void {
  const root = document.documentElement;
  const next = px > 0 ? `${px}px` : "";
  if (root.style.getPropertyValue("--toast-band") === next) return;
  if (next) root.style.setProperty("--toast-band", next);
  else root.style.removeProperty("--toast-band");
}

interface ToastLayout {
  /** In the header's middle, or over the bottom of the content. */
  mode: "header" | "content";
  /** In the header: its top and the slot's width. */
  top: number;
  width: number;
  left: number;
  /** Where the content starts (right of the sidebar). */
  contentLeft: number;
  bottom: number;
  spacers: readonly { owner: HTMLElement; height: number; gap: number }[];
}

/** Reserve scroll range, never space around the page or its viewport. */
function useToastLayout(
  viewportRef: React.RefObject<HTMLElement | null>,
  active: boolean,
): ToastLayout {
  const [layout, setLayout] = React.useState<ToastLayout>({
    mode: "content",
    top: 0,
    width: 0,
    left: EDGE_GAP,
    contentLeft: EDGE_GAP,
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
      const slot = headerSlot();
      if (slot) {
        setToastBand(0);
        setLayout((current) =>
          current.mode === "header" &&
          current.left === slot.left &&
          current.top === slot.top &&
          current.width === slot.width &&
          current.spacers.length === 0
            ? current
            : {
                mode: "header",
                left: slot.left,
                top: slot.top,
                width: slot.width,
                contentLeft: slot.left,
                bottom: 0,
                spacers: [],
              },
        );
        return;
      }
      const sidebar = document.querySelector<HTMLElement>(
        "[data-job-finder-sidebar]",
      );
      const sidebarRect = sidebar?.getBoundingClientRect();
      const contentLeft =
        sidebarRect && sidebarRect.width > 0
          ? sidebarRect.right + EDGE_GAP
          : EDGE_GAP;
      const { height, width } = viewport.getBoundingClientRect();
      // Bottom right of the content, beside a docked assistant: lists sit on
      // the left of every list screen, so the rows just acted on stay clear.
      const reserved =
        parseFloat(
          window
            .getComputedStyle(document.documentElement)
            .getPropertyValue("--assistant-sidebar-reserved"),
        ) || 0;
      const left = Math.max(
        contentLeft,
        Math.round(window.innerWidth - reserved - EDGE_GAP - width),
      );
      // Enlarged text: the content makes room below itself (see setToastBand),
      // so there is nothing to lift over and no scroll range to add.
      const banded =
        activeRef.current &&
        parseFloat(window.getComputedStyle(document.documentElement).fontSize) >
          LARGE_TEXT_PX;
      setToastBand(banded ? Math.ceil(height + EDGE_GAP * 2) : 0);
      let bottom = EDGE_GAP;
      const avoid = Array.from(
        document.querySelectorAll<HTMLElement>(TOAST_AVOID),
      );
      // Lowest first: a lifted stack must also clear a higher visible pager.
      const avoidRects = banded
        ? []
        : avoid
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
      const candidates =
        activeRef.current && !banded
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
        current.mode === "content" &&
        current.left === left &&
        current.contentLeft === contentLeft &&
        current.bottom === bottom &&
        current.spacers.length === spacers.length &&
        current.spacers.every(
          (spacer, index) =>
            spacer.owner === spacers[index]?.owner &&
            spacer.height === spacers[index]?.height &&
            spacer.gap === spacers[index]?.gap,
        )
          ? current
          : {
              mode: "content",
              top: 0,
              width: 0,
              left,
              contentLeft,
              bottom,
              spacers,
            },
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
    // The text size lives on the root element, outside the body.
    mutations.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      measureRef.current = null;
      setToastBand(0);
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
    if (!active) setToastBand(0);
    measureRef.current?.();
  }, [active]);
  return layout;
}

/**
 * The narrowest header middle a toast is placed in, and its widest, in root
 * rem (300 and 480 px at default text). With larger text the same words
 * need more room: where the header's middle cannot hold a toast at the
 * person's text size, it shows over the bottom of the content instead of
 * stacking word by word and hanging over the page title.
 */
const HEADER_SLOT_MIN_REM = 18.75;
const HEADER_SLOT_MAX_REM = 30;

function rootFontPx(): number {
  return (
    parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16
  );
}

/**
 * The free middle of the app header, between the brand and the header
 * tools: the toasts' own place, clear of every screen's content.
 */
function headerSlot(): { left: number; top: number; width: number } | null {
  const header = document.querySelector<HTMLElement>(
    "[data-job-finder-shell-header]",
  );
  const brand = header?.querySelector<HTMLElement>(
    "[data-desktop-brand-region]",
  );
  const tools = header?.querySelector<HTMLElement>("[data-header-tools]");
  if (!header || !brand || !tools) return null;
  const box = header.getBoundingClientRect();
  if (box.height <= 0) return null;
  const start = brand.getBoundingClientRect().right + EDGE_GAP;
  // The tools sit at the end of their row; their first child is where they start.
  const first = tools.firstElementChild?.getBoundingClientRect();
  const end = (first?.left ?? tools.getBoundingClientRect().left) - EDGE_GAP;
  const room = end - start;
  const rem = rootFontPx();
  if (room < HEADER_SLOT_MIN_REM * rem) return null;
  const width = Math.min(HEADER_SLOT_MAX_REM * rem, room);
  return {
    // Centred in the free middle.
    left: Math.round(start + (room - width) / 2),
    top: Math.round(box.top + 6),
    width: Math.round(width),
  };
}

/**
 * Whether a dialog, sheet or popover (a role="dialog", or a panel marked
 * `data-overlay-panel`, as the header's Activity) is open where the toasts
 * would show:
 * a modal anywhere (it owns the screen), or any other dialog whose box
 * meets the toasts' own. Toasts then wait, hidden and with their time
 * held, and come back when it closes: a toast never covers one.
 */
function dialogUnderToasts(viewport: HTMLElement | null): boolean {
  const stack = viewport?.getBoundingClientRect();
  for (const dialog of document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="alertdialog"], [data-overlay-panel]',
  )) {
    if (viewport?.contains(dialog)) continue;
    const rects = dialog.getClientRects();
    if (rects.length === 0) continue;
    if (
      dialog.getAttribute("aria-modal") === "true" ||
      dialog.closest("[data-slot='dialog']") !== null ||
      dialog.getAttribute("role") === "alertdialog"
    )
      return true;
    if (!stack || stack.width === 0) continue;
    const box = dialog.getBoundingClientRect();
    if (
      box.left < stack.right + CONTENT_GAP &&
      box.right > stack.left - CONTENT_GAP &&
      box.top < stack.bottom + CONTENT_GAP &&
      box.bottom > stack.top - CONTENT_GAP
    )
      return true;
  }
  return false;
}

/** While toasts show: whether an open dialog keeps them waiting. */
function useToastsWaiting(
  viewportRef: React.RefObject<HTMLElement | null>,
  active: boolean,
): boolean {
  const [waiting, setWaiting] = React.useState(false);
  React.useEffect(() => {
    if (!active) {
      setWaiting(false);
      return undefined;
    }
    let frame: number | undefined;
    const check = () => {
      frame = undefined;
      setWaiting(dialogUnderToasts(viewportRef.current));
    };
    const schedule = () => {
      frame ??= window.requestAnimationFrame(check);
    };
    check();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: [
        "role",
        "aria-modal",
        "data-state",
        "hidden",
        "open",
        "data-overlay-panel",
      ],
      childList: true,
      subtree: true,
    });
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [active, viewportRef]);
  return waiting;
}

let toastSequence = 0;

function sameMessage(a: ToastInput, b: ToastInput): boolean {
  return (
    a.title === b.title &&
    (a.description ?? "") === (b.description ?? "") &&
    (a.tone ?? "neutral") === (b.tone ?? "neutral") &&
    !a.action &&
    !b.action
  );
}

/**
 * A toast lands over the bottom of the content. When the row just acted on
 * (the open row of a list) sits under the stack, its list scrolls it clear,
 * using the scroll room the stack's spacer adds.
 */
function keepActiveRowClear(viewport: HTMLElement | null): void {
  if (!viewport) return;
  const stack = viewport.getBoundingClientRect();
  if (stack.height <= 0) return;
  for (const row of document.querySelectorAll<HTMLElement>(
    '[data-slot="selectable-row"][aria-current="true"]',
  )) {
    const rect = row.getBoundingClientRect();
    if (
      rect.height <= 0 ||
      rect.right <= stack.left ||
      rect.left >= stack.right ||
      rect.bottom <= stack.top - CONTENT_GAP ||
      rect.top >= stack.bottom
    )
      continue;
    const owner = row.closest<HTMLElement>(SCROLL_OWNERS);
    owner?.scrollBy({ top: rect.bottom - stack.top + CONTENT_GAP });
  }
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const viewportRef = React.useRef<HTMLElement | null>(null);
  const [toasts, setToasts] = React.useState<readonly ToastEntry[]>([]);
  // The older toasts, shown under the newest on request.

  const layout = useToastLayout(viewportRef, toasts.length > 0);
  const waiting = useToastsWaiting(viewportRef, toasts.length > 0);

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
        // One toast per id, and one per message: two identical "Saved."
        // toasts collapse into the newest.
        ...current.filter(
          (entry) =>
            !(toast.id && entry.id === toast.id) && !sameMessage(entry, toast),
        ),
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

  // A new toast never covers the row just acted on.
  const newest = toasts[0]?.key;
  React.useEffect(() => {
    if (!newest) return undefined;
    const frame = window.requestAnimationFrame(() =>
      keepActiveRowClear(viewportRef.current),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [newest]);

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
          className={cn(
            "pointer-events-none fixed z-[130] flex gap-2",
            // In the header each card is as wide as its words, centred in
            // the slot: no empty stretch between "Undo" and its ×.
            layout.mode === "header"
              ? "flex-col items-center"
              : "flex-col-reverse",
            // A dialog is open where they would show: they wait.
            waiting && "invisible",
          )}
          data-toasts-waiting={waiting ? "" : undefined}
          ref={viewportRef}
          style={
            layout.mode === "header"
              ? ({
                  top: layout.top,
                  left: layout.left,
                  width: layout.width,
                  // The header is the window's drag region; a toast in it
                  // must still take clicks.
                  WebkitAppRegion: "no-drag",
                } as React.CSSProperties)
              : {
                  bottom: layout.bottom,
                  left: layout.left,
                  width: `min(22.5rem, calc(100vw - ${layout.contentLeft}px - var(--assistant-sidebar-reserved, 0px) - 1rem))`,
                }
          }
          data-toast-placement={layout.mode}
          data-toast-viewport
        >
          {toasts.map((toast, index) => (
            <ToastCard
              compact={layout.mode === "header"}
              // One at a time: an older toast waits under the newest with
              // its time held, and shows when the newest leaves. No "1
              // more" control: a count of hidden notes told nobody anything.
              hidden={index > 0}
              key={toast.key}
              onDismiss={() => dismissToast(toast.key)}
              paused={waiting || index > 0}
              toast={toast}
            />
          ))}
        </section>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

/**
 * The card's own parts beside a description: icon, gaps, dismiss, padding
 * (88 px at default text; they grow with the text).
 */
const TOAST_CARD_CHROME_REM = 5.5;
function toastDescriptionRoom(box: HTMLElement): number {
  const slot = box.closest<HTMLElement>("[data-toast-viewport]");
  return slot ? slot.clientWidth - TOAST_CARD_CHROME_REM * rootFontPx() : 0;
}
function watchToastSlot(box: HTMLElement) {
  return [box.closest("[data-toast-viewport]")];
}

function ToastCard({
  compact,
  hidden,
  onDismiss,
  paused,
  toast,
}: {
  /** Hidden behind an open dialog: its time is held until it shows again. */
  paused?: boolean;
  /** In the header slot: one tight card, the action beside the title. */
  compact?: boolean;
  /** An older toast under the newest, until the newest leaves. */
  hidden?: boolean;
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
    if (held || paused) return undefined;
    const timer = window.setTimeout(() => dismissRef.current(), duration);
    return () => window.clearTimeout(timer);
  }, [duration, held, paused]);

  const Icon =
    toast.tone === "success"
      ? CheckCircle2
      : toast.tone === "warning"
        ? CircleAlert
        : Info;
  const action = toast.action ? (
    <button
      className="inline-flex min-h-6 w-fit items-center rounded-(--radius-small) align-baseline text-(length:--text-small) font-medium text-primary underline-offset-2 outline-none hover:underline focus-ring"
      data-toast-action
      onClick={() => {
        toast.action?.onClick();
        onDismiss();
      }}
      type="button"
    >
      {toast.action.label}
    </button>
  ) : null;

  return (
    <div
      aria-atomic="true"
      aria-live="polite"
      className={cn(
        "pointer-events-auto flex items-start gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) bg-popover pl-3.5 pr-2 text-popover-foreground shadow-(--select-shadow) animate-in fade-in-0 motion-reduce:animate-none",
        compact
          ? "max-w-full py-1.5 slide-in-from-top-1"
          : "py-3 slide-in-from-bottom-2",
        hidden && "hidden",
      )}
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
      <div className="grid min-w-0 flex-1 gap-0.5" data-toast-body>
        <p
          className="text-(length:--text-small) font-medium leading-5 text-foreground"
          data-toast-title
        >
          {toast.title}
          {compact && action ? (
            // In the header the action follows the title's last word, and
            // moves to a line of its own when that line has no room for it.
            // One column: the title takes the card's whole width, with or
            // without an action (an empty action column used to hold the
            // title to half the card).
            <>
              {" "}
              <span className="ml-2 inline-block whitespace-nowrap">
                {action}
              </span>
            </>
          ) : null}
        </p>
        {toast.description && compact ? (
          // In the header: one line, whole or in shorter words (its first
          // clause), never cut mid-sentence; the whole sentence on hover.
          <span className="flex">
            <FitText
              boxClassName="min-w-0 max-w-full"
              candidates={shorterWords(toast.description)}
              className="text-(length:--text-description) leading-5 text-foreground-muted"
              // The slot's width less the card's icon, dismiss and padding:
              // never the card's own, which is as wide as these words.
              room={toastDescriptionRoom}
              watch={watchToastSlot}
            />
          </span>
        ) : toast.description ? (
          <p className="text-(length:--text-description) leading-5 text-foreground-muted">
            {toast.description}
          </p>
        ) : null}
        {!compact && action ? <div className="mt-1 flex">{action}</div> : null}
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
