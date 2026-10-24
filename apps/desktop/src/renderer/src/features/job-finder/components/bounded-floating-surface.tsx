import { cn } from "@renderer/lib/cn";
import type { CSSProperties, ReactNode, RefObject } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import type {
  BoundedFloatingSurfaceAlignment,
  BoundedFloatingSurfacePlacement,
  BoundedFloatingSurfaceSide,
  BottomRightDockOccupant,
  BottomRightDockPlacement,
} from "../lib/bounded-floating-surface";
import {
  BOTTOM_RIGHT_DOCK_DEFAULT_INSET_PX,
  BOTTOM_RIGHT_DOCK_NO_COVER_SELECTOR,
  resolveBoundedFloatingSurfacePlacement,
  resolveBottomRightDockPlacement,
} from "../lib/bounded-floating-surface";

/**
 * Shared floating-surface layer. Every popover, menu, dropdown and floating
 * panel in Job Finder goes through this so the bound is applied once instead of
 * being re-derived per call site: collision avoidance (flip and shift), a
 * viewport-derived max height, and an internal scroll region whose edge
 * indicators sit at the edge they describe.
 *
 * Exported for other surfaces (the Studio Assistant panel, search history) so
 * they inherit the same behaviour without copying the measurement code.
 */

export interface UseBoundedFloatingSurfaceOptions {
  alignment?: BoundedFloatingSurfaceAlignment;
  /**
   * Height the surface wants when nothing constrains it. Supplying it keeps a
   * comfortably-fitting surface on its preferred side instead of flipping just
   * because the other side happens to be a few pixels roomier.
   */
  desiredHeight?: number;
  gap?: number;
  margin?: number;
  minWidth?: number;
  open: boolean;
  preferredWidth: number;
  side?: BoundedFloatingSurfaceSide;
  /** Resolves the current trigger; sidebar and compact triggers can differ. */
  triggerRef: RefObject<HTMLElement | null> | (() => HTMLElement | null);
}

function readViewport(): { height: number; width: number } {
  // `visualViewport` first (it is the only source that reports a pinch-zoom or
  // an on-screen keyboard), then the document box, which excludes the
  // scrollbar gutter. A zero-sized document box is not a viewport, so
  // `innerWidth`/`innerHeight` are the last resort rather than a silent zero.
  // The document box is read only when needed: reading it forces a layout.
  const visual = window.visualViewport;
  if (visual?.height && visual.width) {
    return { height: visual.height, width: visual.width };
  }
  const documentRect = document.documentElement.getBoundingClientRect();
  return {
    height: visual?.height || documentRect.height || window.innerHeight,
    width: visual?.width || documentRect.width || window.innerWidth,
  };
}

/**
 * Measure the trigger and keep one bounded placement in sync with the window.
 * Returns `null` until the first measurement lands so callers never paint an
 * unbounded surface for a frame.
 */
export function useBoundedFloatingSurface(
  options: UseBoundedFloatingSurfaceOptions,
): BoundedFloatingSurfacePlacement | null {
  const {
    alignment,
    desiredHeight,
    gap,
    margin,
    minWidth,
    open,
    preferredWidth,
    side,
    triggerRef,
  } = options;
  const [placement, setPlacement] =
    useState<BoundedFloatingSurfacePlacement | null>(null);

  const resolveTrigger = useCallback((): HTMLElement | null => {
    if (typeof triggerRef === "function") {
      return triggerRef();
    }
    return triggerRef.current;
  }, [triggerRef]);

  useEffect(() => {
    if (!open) {
      setPlacement(null);
      return undefined;
    }

    const update = () => {
      const trigger = resolveTrigger();
      if (!trigger) {
        return;
      }
      const anchor = trigger.getBoundingClientRect();
      const next = resolveBoundedFloatingSurfacePlacement({
        anchor,
        viewport: readViewport(),
        preferredWidth,
        ...(alignment === undefined ? {} : { alignment }),
        ...(desiredHeight === undefined ? {} : { desiredHeight }),
        ...(gap === undefined ? {} : { gap }),
        ...(margin === undefined ? {} : { margin }),
        ...(minWidth === undefined ? {} : { minWidth }),
        ...(side === undefined ? {} : { side }),
      });
      setPlacement((current) =>
        current &&
        current.left === next.left &&
        current.maxHeight === next.maxHeight &&
        current.side === next.side &&
        current.top === next.top &&
        current.width === next.width
          ? current
          : next,
      );
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [
    alignment,
    desiredHeight,
    gap,
    margin,
    minWidth,
    open,
    preferredWidth,
    resolveTrigger,
    side,
  ]);

  return placement;
}

export function boundedFloatingSurfaceStyle(
  placement: BoundedFloatingSurfacePlacement | null,
): CSSProperties | undefined {
  if (!placement) {
    return undefined;
  }
  return {
    left: placement.left,
    maxHeight: placement.maxHeight,
    top: placement.top,
    width: placement.width,
  };
}

/* -------------------------------------------------------------------------
 * The bottom-right dock registry.
 *
 * One module-level stack, one measurement pass per frame, one placement every
 * participant reads — so the startup recovery notice and the save status lane
 * cannot disagree about that corner. The no-cover set is
 * re-queried on every pass rather than resolved once into cached nodes: a
 * `ResizeObserver` fires on size, not position, so a cached row that merely
 * *moves* never re-ran the old per-surface measurement.
 * ------------------------------------------------------------------------- */

interface BottomRightDockRegistration {
  readonly inset: number | undefined;
  readonly minTopOffset: number;
  readonly occupant: BottomRightDockOccupant;
}

/**
 * Before the first measurement the dock has no boundary to report. `Infinity`
 * makes a reader's `Math.min` a no-op, so nothing is clamped to zero height
 * for a frame; the first pass replaces it with the real edge.
 */
const EMPTY_DOCK_PLACEMENT: BottomRightDockPlacement = {
  clearance: BOTTOM_RIGHT_DOCK_DEFAULT_INSET_PX,
  slots: [],
  stackTop: Number.POSITIVE_INFINITY,
};

const dockRegistrations = new Map<string, BottomRightDockRegistration>();
const dockListeners = new Set<() => void>();
let dockPlacement: BottomRightDockPlacement = EMPTY_DOCK_PLACEMENT;
let dockFrame: number | undefined;

function readBottomRightDockNoCoverRects() {
  if (typeof document === "undefined") {
    return [];
  }
  // Re-queried every pass: rows mount, unmount and move with scrolling, and a
  // node captured once cannot report any of that.
  return [
    ...document.querySelectorAll<HTMLElement>(
      BOTTOM_RIGHT_DOCK_NO_COVER_SELECTOR,
    ),
  ].map((element) => element.getBoundingClientRect());
}

function computeBottomRightDockPlacement(): BottomRightDockPlacement {
  if (typeof window === "undefined") {
    return EMPTY_DOCK_PLACEMENT;
  }

  const registrations = [...dockRegistrations.values()];
  const viewport = readViewport();
  // The narrowest requested inset wins, so every occupant lines up on one
  // edge (the launcher asks for 12px below the mobile breakpoint).
  const insets = registrations.flatMap((registration) =>
    registration.inset === undefined ? [] : [registration.inset],
  );
  const next = resolveBottomRightDockPlacement({
    ...(insets.length === 0 ? {} : { inset: Math.min(...insets) }),
    minTopOffset: registrations.reduce(
      (highest, registration) => Math.max(highest, registration.minTopOffset),
      0,
    ),
    // An empty dock covers nothing, so it measures nothing: this pass runs
    // after every commit and on every scroll, and reading those boxes forced
    // a layout each time.
    noCoverRects:
      registrations.length === 0 ? [] : readBottomRightDockNoCoverRects(),
    occupants: registrations.map((registration) => registration.occupant),
    viewport,
  });

  const current = dockPlacement;
  const unchanged =
    current.clearance === next.clearance &&
    current.stackTop === next.stackTop &&
    current.slots.length === next.slots.length &&
    current.slots.every((slot, index) => {
      const nextSlot = next.slots[index];
      return (
        nextSlot !== undefined &&
        slot.id === nextSlot.id &&
        slot.bottom === nextSlot.bottom &&
        slot.right === nextSlot.right
      );
    });

  return unchanged ? current : next;
}

function publishBottomRightDock(): void {
  const next = computeBottomRightDockPlacement();
  if (next === dockPlacement) {
    return;
  }
  dockPlacement = next;
  for (const listener of dockListeners) {
    listener();
  }
}

function scheduleBottomRightDockUpdate(): void {
  if (
    typeof window === "undefined" ||
    typeof window.requestAnimationFrame !== "function"
  ) {
    publishBottomRightDock();
    return;
  }
  if (dockFrame !== undefined) {
    return;
  }
  dockFrame = window.requestAnimationFrame(() => {
    dockFrame = undefined;
    publishBottomRightDock();
  });
}

function subscribeToBottomRightDock(listener: () => void): () => void {
  const isFirst = dockListeners.size === 0;
  dockListeners.add(listener);

  if (isFirst && typeof window !== "undefined") {
    // All three sources, always: a window resize, a scroll anywhere in the app
    // (captured, passive — it only measures), and the visual viewport, which
    // is the only one that reports a pinch-zoom or an on-screen keyboard.
    window.addEventListener("resize", scheduleBottomRightDockUpdate);
    window.addEventListener("scroll", scheduleBottomRightDockUpdate, {
      capture: true,
      passive: true,
    });
    window.visualViewport?.addEventListener(
      "resize",
      scheduleBottomRightDockUpdate,
    );
    window.visualViewport?.addEventListener(
      "scroll",
      scheduleBottomRightDockUpdate,
    );
  }

  return () => {
    dockListeners.delete(listener);
    if (dockListeners.size > 0 || typeof window === "undefined") {
      return;
    }
    // With nothing reading the dock there is nothing to update, and a frame
    // left pending would keep the scheduler's guard set — so the next surface
    // to mount would schedule nothing and never place itself.
    if (dockFrame !== undefined) {
      window.cancelAnimationFrame(dockFrame);
      dockFrame = undefined;
    }
    dockPlacement = EMPTY_DOCK_PLACEMENT;
    window.removeEventListener("resize", scheduleBottomRightDockUpdate);
    window.removeEventListener("scroll", scheduleBottomRightDockUpdate, true);
    window.visualViewport?.removeEventListener(
      "resize",
      scheduleBottomRightDockUpdate,
    );
    window.visualViewport?.removeEventListener(
      "scroll",
      scheduleBottomRightDockUpdate,
    );
  };
}

function readBottomRightDockPlacement(): BottomRightDockPlacement {
  return dockPlacement;
}

export interface UseBottomRightDockOptions {
  /** A registration only claims a slot while it is actually painted. */
  active: boolean;
  height: number;
  id: string;
  /** Requested edge inset; the dock uses the narrowest one registered. */
  inset?: number;
  /** Highest viewport y the dock may be lifted to. */
  minTopOffset: number;
  /** Lower sorts nearer the bottom edge; see `BOTTOM_RIGHT_DOCK_ORDER`. */
  order: number;
  width: number;
}

export interface BottomRightDockReading {
  /** `null` while this surface is not an occupant — readers still get the top. */
  bottom: number | null;
  right: number;
  stackTop: number;
}

/**
 * Join the bottom-right dock, or read it without claiming a slot.
 *
 * A surface with `active: false` (or a zero-sized one) registers nothing and
 * only reads `stackTop`, which is how the save status lane bounds its own
 * height against the corner without moving into it.
 */
export function useBottomRightDock(
  options: UseBottomRightDockOptions,
): BottomRightDockReading {
  const { active, height, id, inset, minTopOffset, order, width } = options;
  const placement = useSyncExternalStore(
    subscribeToBottomRightDock,
    readBottomRightDockPlacement,
    readBottomRightDockPlacement,
  );

  useLayoutEffect(() => {
    if (!active || (height <= 0 && width <= 0)) {
      if (dockRegistrations.delete(id)) {
        publishBottomRightDock();
      }
      return undefined;
    }

    dockRegistrations.set(id, {
      inset,
      minTopOffset,
      occupant: { height, id, order, width },
    });
    publishBottomRightDock();

    return () => {
      dockRegistrations.delete(id);
      publishBottomRightDock();
    };
  }, [active, height, id, inset, minTopOffset, order, width]);

  // Rows appear, move and disappear from renders this hook cannot see, so the
  // pass is also re-run after every commit that changes what the dock holds.
  useLayoutEffect(() => {
    scheduleBottomRightDockUpdate();
  });

  return useMemo(() => {
    const slot = placement.slots.find((entry) => entry.id === id) ?? null;
    return {
      bottom: slot?.bottom ?? null,
      right: slot?.right ?? BOTTOM_RIGHT_DOCK_DEFAULT_INSET_PX,
      stackTop: placement.stackTop,
    };
  }, [id, placement]);
}

export interface BoundedFloatingSurfaceScrollState {
  atEnd: boolean;
  atStart: boolean;
  hasOverflow: boolean;
}

export const NO_BOUNDED_FLOATING_SURFACE_SCROLL_STATE: BoundedFloatingSurfaceScrollState =
  { atEnd: true, atStart: true, hasOverflow: false };

/**
 * Track whether a bounded surface's scroll region actually overflows, so the
 * "more above"/"more below" hints only appear at an edge that has content past
 * it. `revision` re-measures when the surface's content changes.
 */
export function useBoundedFloatingSurfaceScrollState(
  scrollRef: RefObject<HTMLElement | null>,
  active: boolean,
  revision?: unknown,
): BoundedFloatingSurfaceScrollState {
  const [state, setState] = useState<BoundedFloatingSurfaceScrollState>(
    NO_BOUNDED_FLOATING_SURFACE_SCROLL_STATE,
  );

  useLayoutEffect(() => {
    if (!active) {
      setState(NO_BOUNDED_FLOATING_SURFACE_SCROLL_STATE);
      return undefined;
    }
    const region = scrollRef.current;
    if (!region) {
      return undefined;
    }

    const measure = () => {
      const maxScrollTop = Math.max(
        0,
        region.scrollHeight - region.clientHeight,
      );
      const hasOverflow = maxScrollTop > 1;
      const next: BoundedFloatingSurfaceScrollState = {
        atEnd: !hasOverflow || region.scrollTop >= maxScrollTop - 1,
        atStart: !hasOverflow || region.scrollTop <= 1,
        hasOverflow,
      };
      setState((current) =>
        current.atEnd === next.atEnd &&
        current.atStart === next.atStart &&
        current.hasOverflow === next.hasOverflow
          ? current
          : next,
      );
    };

    measure();
    region.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(region);
    return () => {
      region.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [active, revision, scrollRef]);

  return state;
}

export interface BoundedFloatingSurfaceScrollHintProps {
  edge: "end" | "start";
  visible: boolean;
}

/**
 * A hint printed at the edge it describes. The previous More-menu affordance
 * printed "More content above ↑" in the popover's bottom footer.
 */
export function BoundedFloatingSurfaceScrollHint({
  edge,
  visible,
}: BoundedFloatingSurfaceScrollHintProps): ReactNode {
  if (!visible) {
    return null;
  }
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 flex h-6 items-center justify-center gap-1 text-(length:--text-tiny) font-medium text-foreground-muted",
        edge === "start"
          ? "top-0 bg-gradient-to-b from-(--surface-panel-raised) to-transparent"
          : "bottom-0 bg-gradient-to-t from-(--surface-panel-raised) to-transparent",
      )}
      data-bounded-floating-surface-scroll-hint={edge}
    >
      {edge === "start" ? "↑" : "↓"}
    </div>
  );
}
