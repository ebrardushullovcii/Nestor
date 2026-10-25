import {
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "@renderer/lib/cn";
import { getJobFinderScrollBehavior } from "../lib/job-finder-scroll-behavior";

const LOCKED_PANE_BREAKPOINT = 1280;
// Long enough to cover one continuous wheel or trackpad gesture, short enough
// that the header never rests half-visible while the user reads the page.
const HEADER_SETTLE_DELAY_MS = 140;
const SCROLL_BOUNDARY_TOLERANCE = 1;
const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;
const INTERACTIVE_KEYBOARD_TARGET_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "summary",
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="link"]',
  '[role="listbox"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="searchbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="textbox"]',
  '[role="treeitem"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function normalizeWheelDeltaY(
  deltaY: number,
  deltaMode: number,
  pageSize: number,
): number {
  if (deltaMode === WHEEL_DELTA_LINE) {
    return deltaY * 16;
  }
  if (deltaMode === WHEEL_DELTA_PAGE) {
    return deltaY * pageSize;
  }
  return deltaY;
}

/**
 * The real scroll range of an owner. Never `undefined`: an owner that cannot
 * scroll has a range of exactly `0`, and callers must say so. Reporting
 * "unknown" for a non-scrollable owner let the header helpers fall back to
 * `topHeight`, so a route whose outer owner had no range still had
 * `topHeight` pixels subtracted from every wheel delta and written into a
 * scroller the browser immediately clamped back — the delta was destroyed.
 */
function getScrollRange(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

export function getLockedHeaderWheelTarget(input: {
  deltaY: number;
  maxScrollTop?: number | undefined;
  scrollTop: number;
  topHeight: number;
  viewportWidth: number;
}): number | null {
  const headerBoundary = Math.min(
    input.topHeight,
    Math.max(0, input.maxScrollTop ?? input.topHeight),
  );

  if (
    input.viewportWidth < LOCKED_PANE_BREAKPOINT ||
    input.deltaY === 0 ||
    headerBoundary <= 0 ||
    (input.deltaY > 0 &&
      input.scrollTop >= headerBoundary - SCROLL_BOUNDARY_TOLERANCE) ||
    (input.deltaY < 0 && input.scrollTop <= SCROLL_BOUNDARY_TOLERANCE)
  ) {
    return null;
  }

  return Math.max(0, Math.min(headerBoundary, input.scrollTop + input.deltaY));
}

/**
 * Where the route scroll owner must come to rest so the page header is never
 * left half-scrolled under the fixed shell — a resting position inside the
 * header band clips the H1 mid-glyph. Returns `null` when the current position
 * is already fully in (top) or fully out (past the header), or when there is no
 * header band to resolve.
 *
 * This only normalizes the resting position after a gesture settles: per-event
 * wheel ownership and residual hand-off are unchanged, so a pane still receives
 * exactly the delta the header did not consume.
 */
export function getLockedHeaderSettleScrollTop(input: {
  direction?: "up" | "down" | null;
  maxScrollTop?: number | undefined;
  scrollTop: number;
  topHeight: number;
}): number | null {
  const headerBoundary = Math.min(
    input.topHeight,
    Math.max(0, input.maxScrollTop ?? input.topHeight),
  );

  if (headerBoundary <= SCROLL_BOUNDARY_TOLERANCE) {
    return null;
  }

  if (
    input.scrollTop <= SCROLL_BOUNDARY_TOLERANCE ||
    input.scrollTop >= headerBoundary - SCROLL_BOUNDARY_TOLERANCE
  ) {
    return null;
  }

  if (input.direction === "down") {
    return headerBoundary;
  }

  if (input.direction === "up") {
    return 0;
  }

  return input.scrollTop * 2 >= headerBoundary ? headerBoundary : 0;
}

export function canNestedPaneConsumeWheel(input: {
  clientHeight: number;
  deltaY: number;
  scrollHeight: number;
  scrollTop: number;
}): boolean {
  if (input.deltaY > 0) {
    return input.scrollTop + input.clientHeight < input.scrollHeight - 1;
  }
  if (input.deltaY < 0) {
    return input.scrollTop > 1;
  }
  return false;
}

export function getNestedPaneWheelTarget(input: {
  clientHeight: number;
  deltaMode: number;
  deltaY: number;
  scrollHeight: number;
  scrollTop: number;
}): number | null {
  if (!canNestedPaneConsumeWheel(input)) {
    return null;
  }

  const pixelDelta = normalizeWheelDeltaY(
    input.deltaY,
    input.deltaMode,
    input.clientHeight,
  );
  const maxScrollTop = Math.max(0, input.scrollHeight - input.clientHeight);

  return Math.max(0, Math.min(maxScrollTop, input.scrollTop + pixelDelta));
}

function isNativeWheelOwnerElement(element: HTMLElement): boolean {
  return (
    element.isContentEditable ||
    element.hasAttribute("contenteditable") ||
    element.tagName === "INPUT" ||
    element.tagName === "SELECT" ||
    element.tagName === "TEXTAREA"
  );
}

export function isVerticallyScrollableElement(element: HTMLElement): boolean {
  const overflowY = window.getComputedStyle(element).overflowY;

  if (overflowY !== "auto" && overflowY !== "scroll") {
    return false;
  }

  return (
    element.scrollHeight > element.clientHeight + SCROLL_BOUNDARY_TOLERANCE
  );
}

/**
 * Walks ancestors from the wheel target up to the layout content root and
 * collects the vertical scroll owners under the pointer, deepest first. The
 * nearest marked pane ends the chain; everything above it stays owned by the
 * header and outer page. Returns null when the pointer is over a text control
 * so the browser keeps native ownership of the event, including chaining.
 */
export function collectLockedWheelScrollChain(input: {
  contentRoot: Element;
  target: Element;
}): HTMLElement[] | null {
  const chain: HTMLElement[] = [];
  let node: Element | null = input.target;

  while (node && node !== input.contentRoot) {
    if (node instanceof HTMLElement) {
      if (isNativeWheelOwnerElement(node)) {
        return null;
      }
      if (node.dataset.lockedPaneScrollRegion !== undefined) {
        chain.push(node);
        return chain;
      }
      if (isVerticallyScrollableElement(node)) {
        chain.push(node);
      }
    }
    node = node.parentElement;
  }

  return chain;
}

interface LockedScreenLayoutProps {
  /** Always-visible chrome pinned below the scroll area (primary CTAs). */
  bottomContent?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
  /**
   * Caps the whole layout at the route viewport from the locked-pane
   * breakpoint up, so a two-pane route's panes own their own scrolling.
   * Without it the grid is only `min-h-full`, its `1fr` content row resolves
   * to max-content, and every pane grows past the fold: the page scrolls as
   * one and a pane's own `overflow-y-auto` never activates.
   */
  lockContentHeight?: boolean;
  lockTopContent?: boolean;
  reserveRightRail?: boolean;
  /** Reset the route-owned scroll containers when the locked view changes. */
  scrollResetKey?: number | string;
  topClassName?: string;
  topContent: ReactNode;
}

export function LockedScreenLayout({
  bottomContent,
  children,
  contentClassName,
  lockContentHeight = false,
  lockTopContent = true,
  reserveRightRail = false,
  scrollResetKey,
  topClassName = "pb-2",
  topContent,
}: LockedScreenLayoutProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const topRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollResetKeyRef = useRef(scrollResetKey);
  // The header height is read when a wheel, key or scroll needs it, when
  // layout is already up to date. Measuring it on mount forced a full layout
  // of the new screen before its first paint and rendered the layout twice.
  const readTopHeight = () =>
    Math.round(topRef.current?.getBoundingClientRect().height ?? 0);

  // `main` is intentionally overflow-hidden for locked routes, so this
  // nested element is the route's scroll owner. Reset it before paint when
  // the caller changes the route/view identity; otherwise route reuse can
  // leave the route header underneath the fixed shell. A freshly mounted
  // owner already starts at the top, and writing its scroll position forced
  // a layout of the whole new screen, so mount only turns anchoring off.
  // Disable CSS scroll anchoring on this owner: status rows and first-result
  // hydration may change the header height after entry, but must not invent
  // a partial scroll position. Explicit wheel/keyboard/first-result writes
  // still own later scrolling.
  useLayoutEffect(() => {
    const scrollArea = scrollRef.current;
    const topContentNode = topRef.current;
    if (!scrollArea || !lockTopContent) {
      return undefined;
    }

    scrollArea.style.overflowAnchor = "none";
    if (topContentNode) {
      topContentNode.style.overflowAnchor = "none";
    }
    if (scrollResetKeyRef.current === scrollResetKey) {
      return undefined;
    }
    scrollResetKeyRef.current = scrollResetKey;

    scrollArea.scrollLeft = 0;
    scrollArea.scrollTop = 0;
    if (topContentNode) {
      topContentNode.scrollLeft = 0;
      topContentNode.scrollTop = 0;
    }

    return undefined;
  }, [lockTopContent, scrollResetKey]);

  // Snap the route header fully in or fully out once scrolling settles. Any
  // input source can otherwise leave the header band half-scrolled under the
  // fixed shell, which paints a title clipped through the middle of its
  // glyphs. Per-event wheel/keyboard ownership is untouched: this only
  // normalizes where the outer owner comes to rest.
  useEffect(() => {
    const scrollArea = scrollRef.current;

    if (!scrollArea || !lockTopContent) {
      return undefined;
    }

    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastScrollTop = scrollArea.scrollTop;

    const settleHeaderBoundary = (direction: "up" | "down" | null) => {
      const settleTarget = getLockedHeaderSettleScrollTop({
        direction,
        maxScrollTop: getScrollRange(scrollArea),
        scrollTop: scrollArea.scrollTop,
        topHeight: readTopHeight(),
      });

      if (settleTarget === null) {
        return;
      }

      lastScrollTop = settleTarget;
      scrollArea.scrollTo({
        behavior: getJobFinderScrollBehavior(),
        top: settleTarget,
      });
    };

    const handleScroll = () => {
      const currentScrollTop = scrollArea.scrollTop;
      const direction =
        currentScrollTop === lastScrollTop
          ? null
          : currentScrollTop > lastScrollTop
            ? "down"
            : "up";
      lastScrollTop = currentScrollTop;

      if (settleTimer !== null) {
        clearTimeout(settleTimer);
      }

      settleTimer = setTimeout(() => {
        settleTimer = null;
        settleHeaderBoundary(direction);
      }, HEADER_SETTLE_DELAY_MS);
    };

    scrollArea.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
      }
      scrollArea.removeEventListener("scroll", handleScroll);
    };
  }, [lockTopContent]);

  useEffect(() => {
    const content = contentRef.current;
    const scrollArea = scrollRef.current;

    if (!content || !scrollArea) {
      return undefined;
    }

    const handleContentWheel = (event: WheelEvent) => {
      if (
        !lockTopContent ||
        window.innerWidth < LOCKED_PANE_BREAKPOINT ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }

      const eventTarget = event.target instanceof Element ? event.target : null;
      if (!eventTarget || !content.contains(eventTarget)) {
        return;
      }

      const scrollChain = collectLockedWheelScrollChain({
        contentRoot: content,
        target: eventTarget,
      });
      if (!scrollChain) {
        return;
      }

      const pageSize =
        (scrollChain[0]?.clientHeight ?? scrollArea.clientHeight) ||
        window.innerHeight * 0.85;
      let remainingDeltaY = normalizeWheelDeltaY(
        event.deltaY,
        event.deltaMode,
        pageSize,
      );
      if (remainingDeltaY === 0) {
        return;
      }

      // Native ownership first. While any scroller under the pointer still has
      // range in this direction, the browser scrolls it on the compositor with
      // real momentum and we do not intervene at all — no `preventDefault`, no
      // manual `scrollTop` write, no per-event arbitration. Custom hand-off is
      // permitted only at a true boundary, where the pointed-at chain is
      // exhausted in the wheel's direction and the outer route owner has to
      // take over. Forwarding deltas by hand made every wheel event a
      // main-thread, blocking event and silently ate `topHeight` pixels of it.
      if (
        scrollChain.some((scrollable) =>
          canNestedPaneConsumeWheel({
            clientHeight: scrollable.clientHeight,
            deltaY: remainingDeltaY,
            scrollHeight: scrollable.scrollHeight,
            scrollTop: scrollable.scrollTop,
          }),
        )
      ) {
        return;
      }

      const initialOuterScrollTop = scrollArea.scrollTop;
      let nextOuterScrollTop = initialOuterScrollTop;
      const maxOuterScrollTop = getScrollRange(scrollArea);
      const paneTargets = new Map<HTMLElement, number>();
      let didManualConsumption = false;

      const topHeight = readTopHeight();
      const consumeLockedHeader = () => {
        const headerTarget = getLockedHeaderWheelTarget({
          deltaY: remainingDeltaY,
          maxScrollTop: maxOuterScrollTop,
          scrollTop: nextOuterScrollTop,
          topHeight,
          viewportWidth: window.innerWidth,
        });
        if (headerTarget === null) {
          return;
        }

        const consumedDeltaY = headerTarget - nextOuterScrollTop;
        nextOuterScrollTop = headerTarget;
        remainingDeltaY -= consumedDeltaY;
        didManualConsumption ||= consumedDeltaY !== 0;
      };

      // The chain is ordered deepest first: an unmarked inner well consumes
      // before its marked pane, and the marked pane consumes before the
      // outer page.
      const consumeChainScroller = (scrollable: HTMLElement) => {
        const paneStart = scrollable.scrollTop;
        const paneTarget = getNestedPaneWheelTarget({
          clientHeight: scrollable.clientHeight,
          deltaMode: 0,
          deltaY: remainingDeltaY,
          scrollHeight: scrollable.scrollHeight,
          scrollTop: paneStart,
        });
        if (paneTarget === null) {
          return;
        }

        paneTargets.set(scrollable, paneTarget);
        remainingDeltaY -= paneTarget - paneStart;
        didManualConsumption ||= paneTarget !== paneStart;
      };

      if (remainingDeltaY > 0) {
        consumeLockedHeader();
        scrollChain.forEach(consumeChainScroller);
      } else {
        scrollChain.forEach(consumeChainScroller);
        if (remainingDeltaY < 0) {
          consumeLockedHeader();
        }
      }

      // If a scroller or the header reached its boundary during this event, let
      // any remaining delta continue through the outer scroll owner. Setting
      // scrollTop keeps the handoff deterministic while the browser still
      // clamps to the outer element's real scroll range.
      if (didManualConsumption && remainingDeltaY !== 0) {
        nextOuterScrollTop = Math.min(
          maxOuterScrollTop,
          Math.max(0, nextOuterScrollTop + remainingDeltaY),
        );
      }

      const outerMoved = nextOuterScrollTop !== initialOuterScrollTop;
      const movedPaneTargets: Array<[HTMLElement, number]> = [];
      for (const [scrollable, paneTarget] of paneTargets) {
        if (scrollable.scrollTop !== paneTarget) {
          movedPaneTargets.push([scrollable, paneTarget]);
        }
      }
      if (!outerMoved && movedPaneTargets.length === 0) {
        return;
      }

      event.preventDefault();
      if (outerMoved) {
        scrollArea.scrollTop = nextOuterScrollTop;
      }
      for (const [scrollable, paneTarget] of movedPaneTargets) {
        scrollable.scrollTop = paneTarget;
      }
    };

    const handleContentKeyDown = (event: KeyboardEvent) => {
      if (
        !lockTopContent ||
        window.innerWidth < LOCKED_PANE_BREAKPOINT ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        target &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }

      const eventTarget = target instanceof Element ? target : null;
      if (!eventTarget || !content.contains(eventTarget)) {
        return;
      }

      const nestedScrollPane = eventTarget.closest<HTMLElement>(
        "[data-locked-pane-scroll-region]",
      );

      // A focusable nested pane owns scrolling only while the pane itself has
      // focus. Descendant controls retain their native keyboard behavior.
      if (nestedScrollPane && eventTarget !== nestedScrollPane) {
        return;
      }

      // Leave keyboard ownership with controls and other interactive
      // descendants. In particular, Space must still activate buttons,
      // links, summaries, and custom role=button elements.
      if (
        eventTarget !== nestedScrollPane &&
        eventTarget.closest<HTMLElement>(INTERACTIVE_KEYBOARD_TARGET_SELECTOR)
      ) {
        return;
      }

      const key = event.key;
      const isArrowDown = key === "ArrowDown";
      const isArrowUp = key === "ArrowUp";
      const isPageDown = key === "PageDown";
      const isPageUp = key === "PageUp";
      const isHome = key === "Home";
      const isEnd = key === "End";
      const isSpace = key === " " || key === "Spacebar" || key === "Space";

      if (
        !isArrowDown &&
        !isArrowUp &&
        !isPageDown &&
        !isPageUp &&
        !isHome &&
        !isEnd &&
        !isSpace
      ) {
        return;
      }

      if (isHome || isEnd) {
        if (nestedScrollPane && content.contains(nestedScrollPane)) {
          const maxPaneTop = Math.max(
            0,
            nestedScrollPane.scrollHeight - nestedScrollPane.clientHeight,
          );
          if (
            isHome &&
            nestedScrollPane.scrollTop > SCROLL_BOUNDARY_TOLERANCE
          ) {
            event.preventDefault();
            nestedScrollPane.scrollTop = 0;
            return;
          }
          if (
            isEnd &&
            nestedScrollPane.scrollTop < maxPaneTop - SCROLL_BOUNDARY_TOLERANCE
          ) {
            event.preventDefault();
            nestedScrollPane.scrollTop = maxPaneTop;
            return;
          }
        }

        if (isHome && scrollArea.scrollTop > SCROLL_BOUNDARY_TOLERANCE) {
          event.preventDefault();
          scrollArea.scrollTop = 0;
          return;
        }

        if (isEnd) {
          const maxOuter = Math.max(
            0,
            scrollArea.scrollHeight - scrollArea.clientHeight,
          );
          const targetTop = maxOuter;
          if (scrollArea.scrollTop < targetTop - SCROLL_BOUNDARY_TOLERANCE) {
            event.preventDefault();
            scrollArea.scrollTop = targetTop;
          }
        }
        return;
      }

      let deltaY: number | null = null;
      if (isArrowDown) deltaY = 40;
      else if (isArrowUp) deltaY = -40;
      else if (isPageDown)
        deltaY =
          (nestedScrollPane?.clientHeight ?? scrollArea.clientHeight) ||
          window.innerHeight * 0.85;
      else if (isPageUp)
        deltaY = -(
          (nestedScrollPane?.clientHeight ?? scrollArea.clientHeight) ||
          window.innerHeight * 0.85
        );
      else if (isSpace) {
        const pageSize =
          (nestedScrollPane?.clientHeight ?? scrollArea.clientHeight) ||
          window.innerHeight * 0.85;
        deltaY = event.shiftKey ? -pageSize : pageSize;
      }

      if (deltaY === null) {
        return;
      }

      let remainingDeltaY = deltaY;
      const initialOuterScrollTop = scrollArea.scrollTop;
      let nextOuterScrollTop = initialOuterScrollTop;
      let nextNestedScrollTop: number | null = null;

      const topHeight = readTopHeight();
      const consumeLockedHeader = () => {
        const headerTarget = getLockedHeaderWheelTarget({
          deltaY: remainingDeltaY,
          maxScrollTop: getScrollRange(scrollArea),
          scrollTop: nextOuterScrollTop,
          topHeight,
          viewportWidth: window.innerWidth,
        });
        if (headerTarget === null) {
          return;
        }

        const consumedDeltaY = headerTarget - nextOuterScrollTop;
        nextOuterScrollTop = headerTarget;
        remainingDeltaY -= consumedDeltaY;
      };

      const consumeNestedPane = () => {
        if (!nestedScrollPane || !content.contains(nestedScrollPane)) {
          return;
        }

        const paneStart = nestedScrollPane.scrollTop;
        const paneTarget = getNestedPaneWheelTarget({
          clientHeight: nestedScrollPane.clientHeight,
          deltaMode: 0,
          deltaY: remainingDeltaY,
          scrollHeight: nestedScrollPane.scrollHeight,
          scrollTop: paneStart,
        });
        if (paneTarget === null) {
          return;
        }

        nextNestedScrollTop = paneTarget;
        remainingDeltaY -= paneTarget - paneStart;
      };

      if (remainingDeltaY > 0) {
        consumeLockedHeader();
        consumeNestedPane();
      } else {
        consumeNestedPane();
        if (remainingDeltaY < 0) {
          consumeLockedHeader();
        }
      }

      if (remainingDeltaY !== 0) {
        const maxOuterScrollTop = Math.max(
          0,
          scrollArea.scrollHeight - scrollArea.clientHeight,
        );
        const candidateOuterScrollTop = Math.max(
          0,
          nextOuterScrollTop + remainingDeltaY,
        );
        nextOuterScrollTop = Math.min(
          maxOuterScrollTop,
          candidateOuterScrollTop,
        );
      }

      const outerMoved = nextOuterScrollTop !== initialOuterScrollTop;
      const paneMoved =
        nextNestedScrollTop !== null &&
        nextNestedScrollTop !== nestedScrollPane?.scrollTop;
      if (!outerMoved && !paneMoved) {
        return;
      }

      event.preventDefault();
      if (outerMoved) {
        scrollArea.scrollTop = nextOuterScrollTop;
      }
      const nestedTarget = nextNestedScrollTop;
      if (paneMoved && nestedScrollPane && nestedTarget !== null) {
        nestedScrollPane.scrollTop = nestedTarget;
      }
    };

    content.addEventListener("wheel", handleContentWheel, {
      capture: true,
      passive: false,
    });
    content.addEventListener("keydown", handleContentKeyDown, {
      capture: true,
    });

    return () => {
      content.removeEventListener("wheel", handleContentWheel, {
        capture: true,
      });
      content.removeEventListener("keydown", handleContentKeyDown, {
        capture: true,
      });
    };
  }, [lockTopContent]);

  const layoutStyle: CSSProperties = {
    ...(reserveRightRail
      ? { paddingRight: "min(31rem, calc(100vw - 32rem))" }
      : {}),
  };

  return (
    <section
      className={cn("h-full min-h-0", bottomContent ? "flex flex-col" : null)}
    >
      <div
        className={cn(
          // Leave enough room between route chrome and the native window edge
          // that controls do not read as clipped by the overlaid scrollbar or
          // the window shadow at non-fullscreen sizes.
          "screen-scroll-area overflow-y-auto overflow-x-hidden pr-3",
          bottomContent ? "min-h-0 flex-1" : "h-full",
        )}
        data-locked-screen-scroll-area
        ref={scrollRef}
      >
        <div
          className={cn(
            "grid min-h-full min-w-0 grid-rows-[auto_minmax(0,1fr)] transition-[padding-right] duration-200",
            lockContentHeight ? "xl:h-full" : null,
          )}
          data-locked-screen-content-height={
            lockContentHeight ? "locked" : undefined
          }
          ref={contentRef}
          style={layoutStyle}
        >
          <div
            data-locked-screen-top-content
            ref={topRef}
            // F73: one route-title offset everywhere. The shell supplies
            // 12px above scrolling routes (`pt-3` on `main`) and `pt-0` on
            // locked routes, where this layout owns the top edge — so it
            // supplies the same 12px here. Routes must not add their own top
            // padding above the header, or the offset drifts per route again.
            className={cn("min-w-0 pt-3", topClassName)}
          >
            {topContent}
          </div>
          <div className={cn("min-h-0 min-w-0", contentClassName)}>
            {children}
          </div>
        </div>
      </div>
      {bottomContent ? (
        <div
          className="z-20 shrink-0 border-t border-(--surface-panel-border) bg-(--surface-fill-soft)/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-10px_28px_rgba(0,0,0,0.18)] backdrop-blur-sm"
          data-locked-screen-bottom-content
        >
          {bottomContent}
        </div>
      ) : null}
    </section>
  );
}
