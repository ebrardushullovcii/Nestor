export interface JobFinderRevealView {
  innerWidth: number;
  getComputedStyle: (element: Element) => CSSStyleDeclaration;
  matchMedia?: (query: string) => Pick<MediaQueryList, "matches">;
}

// Shell header geometry mirrors `job-finder-shell`: below the sm breakpoint
// the page header scrolls in flow; from sm up it is fixed over the page
// (`sm:fixed sm:inset-x-0 sm:top-0`) with content padded by 7.25rem (116px),
// and from 1280px, where the navigation fits on the brand row, the fixed band
// is one row: h-14 (`xl:pt-14`, 56px). The persistent sidebar lands at 1440px.
export const JOB_FINDER_SM_MIN_VIEWPORT_WIDTH_PX = 640;
export const JOB_FINDER_WIDE_SHELL_MIN_VIEWPORT_WIDTH_PX = 1280;
export const JOB_FINDER_FIXED_HEADER_HEIGHT_PX = 116;
export const JOB_FINDER_WIDE_HEADER_HEIGHT_PX = 56;
// Shared breathing gap between a revealed target and whatever sits above it.
export const JOB_FINDER_REVEAL_TOP_GAP_PX = 16;
// A route header is allowed to be at either rest position only: fully shown
// at the top of the page or fully above the fixed shell. A fractional scroll
// position between those boundaries leaves the h1 painted underneath chrome.
export const JOB_FINDER_ROUTE_HEADER_SCROLL_TOLERANCE_PX = 1;

// Tailwind scale: `scroll-mt-4` = 16px gap; the sm band adds the fixed-header
// height (116px + 16px = 132px = 8.25rem); the wide band adds the short fixed
// header (56px + 16px = 72px = 4.5rem). Consumers must render these exact
// tokens so native `scrollIntoView` reveals cannot drift from this geometry.
// The wide token is the named `xl` breakpoint (1280px), which Tailwind emits
// after `sm`, so it wins without `!`. An arbitrary `min-[…]` variant would be
// emitted before `sm` and lose to it (see `tailwind-variant-order.test.ts`).
export const JOB_FINDER_REVEAL_SCROLL_MARGIN_CLASSES = {
  base: "scroll-mt-4",
  fixedHeader: "sm:scroll-mt-[8.25rem]",
  wideFixedHeader: "xl:scroll-mt-[4.5rem]",
} as const;

export type JobFinderRevealChromeMode =
  | "static-header"
  | "fixed-header"
  | "wide-fixed-header";

export function resolveJobFinderRevealChromeMode(
  viewportWidthPx: number,
): JobFinderRevealChromeMode {
  if (viewportWidthPx < JOB_FINDER_SM_MIN_VIEWPORT_WIDTH_PX) {
    return "static-header";
  }

  return viewportWidthPx >= JOB_FINDER_WIDE_SHELL_MIN_VIEWPORT_WIDTH_PX
    ? "wide-fixed-header"
    : "fixed-header";
}

export function resolveJobFinderRevealClearancePx(
  mode: JobFinderRevealChromeMode,
): number {
  switch (mode) {
    case "fixed-header":
      return JOB_FINDER_FIXED_HEADER_HEIGHT_PX + JOB_FINDER_REVEAL_TOP_GAP_PX;
    case "wide-fixed-header":
      return JOB_FINDER_WIDE_HEADER_HEIGHT_PX + JOB_FINDER_REVEAL_TOP_GAP_PX;
    default:
      return JOB_FINDER_REVEAL_TOP_GAP_PX;
  }
}

/**
 * Resolves the nearest stable page position for a locked route header. During
 * a first-results layout change, native scrolling can leave the outer page
 * between the header's two resting positions. Choosing the nearest boundary
 * preserves the user's scroll direction while guaranteeing the header is not
 * partially occluded by the fixed shell.
 */
export function resolveJobFinderRouteHeaderScrollTop(
  scrollTop: number,
  headerHeightPx: number,
): number {
  const currentTop = Math.max(0, scrollTop);
  const boundary = Math.max(0, headerHeightPx);

  if (boundary === 0 || currentTop <= 0 || currentTop >= boundary) {
    return currentTop;
  }

  return currentTop < boundary / 2 ? 0 : boundary;
}

/**
 * Settles one outer page scrollport at a whole-header boundary. Returns true
 * only when the scroll position changed, which keeps callers' layout effects
 * cheap and makes the geometry contract directly testable.
 */
export function settleJobFinderRouteHeaderScroll(
  scrollArea: HTMLElement,
  headerHeightPx: number,
): boolean {
  const currentTop = Math.max(0, scrollArea.scrollTop);
  const nextTop = resolveJobFinderRouteHeaderScrollTop(
    currentTop,
    headerHeightPx,
  );

  if (
    Math.abs(nextTop - currentTop) <=
    JOB_FINDER_ROUTE_HEADER_SCROLL_TOLERANCE_PX
  ) {
    return false;
  }

  scrollArea.scrollTop = nextTop;
  return scrollArea.scrollTop !== currentTop;
}

function isVerticalScrollport(
  element: Element,
  view: JobFinderRevealView,
): element is HTMLElement {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const overflowY = view.getComputedStyle(element).overflowY;

  return (
    (overflowY === "auto" || overflowY === "scroll") &&
    element.scrollHeight > element.clientHeight
  );
}

/**
 * Nearest ancestor (excluding `start`) that actually scrolls vertically.
 * Starts searching at `from` so a pinned scrollport can be skipped by passing
 * its parent on the next attempt.
 */
export function findNearestVerticalScrollportFrom(
  start: Element | null,
  view: JobFinderRevealView,
): HTMLElement | null {
  let node: Element | null = start?.parentElement ?? null;

  while (node) {
    if (isVerticalScrollport(node, view)) {
      return node;
    }

    node = node.parentElement;
  }

  return null;
}

/**
 * Contained reveal: aligns `target` so its viewport top clears the shell
 * header plus the shared breathing gap, using only explicit scroller
 * adjustments. Never animates, never delegates scrolling to the browser, and
 * never scrolls an inner scroller that is pinned at its boundary — pinned
 * levels hand the remaining correction to the next outer scroller instead,
 * which is what lets a stacked page-level reveal clear the fixed header.
 */
export function revealBelowShellHeader(
  target: HTMLElement,
  view: JobFinderRevealView,
  maxAttempts = 6,
): void {
  const clearancePx = resolveJobFinderRevealClearancePx(
    resolveJobFinderRevealChromeMode(view.innerWidth),
  );
  let searchFrom: Element | null = target;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const errorPx = target.getBoundingClientRect().top - clearancePx;

    if (errorPx >= 0) {
      return;
    }

    const scrollport = findNearestVerticalScrollportFrom(searchFrom, view);

    if (!scrollport) {
      return;
    }

    const previousScrollTop = scrollport.scrollTop;
    scrollport.scrollTop = Math.max(0, previousScrollTop + errorPx);

    if (scrollport.scrollTop === previousScrollTop) {
      searchFrom = scrollport;
      continue;
    }
  }
}

/**
 * Scoped collection lookup shared by cross-page row navigation. `null` scope
 * falls back to the whole document for callers without a region ref yet.
 */
export function findCollectionItemWithinRegion(
  region: ParentNode | null | undefined,
  itemId: string,
): HTMLElement | null {
  const scope: ParentNode = region ?? document;

  return (
    Array.from(
      scope.querySelectorAll<HTMLElement>("[data-collection-item-id]"),
    ).find((item) => item.dataset.collectionItemId === itemId) ?? null
  );
}
