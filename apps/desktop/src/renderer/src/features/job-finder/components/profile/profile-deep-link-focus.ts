export type ProfileDeepLinkFocus =
  | "job-sources"
  | "target-roles"
  | "work-eligibility"
  | "work-modes";

export const PROFILE_SECTION_SCROLL_AREA_ID = "profile-section-scroll-area";

export const PROFILE_SM_MIN_VIEWPORT_WIDTH_PX = 640;
export const PROFILE_XL_MIN_VIEWPORT_WIDTH_PX = 1280;
// Between sm and xl the shell pins its header over the page and pads content
// by 7.25rem (`sm:fixed ... sm:pt-[7.25rem]` in job-finder-shell). Owned
// Profile targets render their scroll margins from
// PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES below, so the classes cannot drift
// from these constants.
export const PROFILE_FIXED_HEADER_HEIGHT_PX = 116;
export const PROFILE_DEEP_LINK_TOP_GAP_PX = 16;

export const PROFILE_MAX_OUTER_ALIGNMENT_ATTEMPTS = 4;

// Tailwind scale: `scroll-mt-4` = 16px gap; the sm band adds the fixed-header
// height (116px + 16px = 132px = 8.25rem).
export const PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES = {
  base: "scroll-mt-4",
  fixedHeader: "sm:scroll-mt-[8.25rem]",
  internalScroller: "xl:scroll-mt-4",
} as const;

export type ProfileScrollChromeMode =
  | "static-header"
  | "fixed-header"
  | "internal-scroller";

export function resolveProfileScrollChromeMode(
  viewportWidthPx: number,
): ProfileScrollChromeMode {
  if (viewportWidthPx >= PROFILE_XL_MIN_VIEWPORT_WIDTH_PX) {
    return "internal-scroller";
  }

  return viewportWidthPx >= PROFILE_SM_MIN_VIEWPORT_WIDTH_PX
    ? "fixed-header"
    : "static-header";
}

export function resolveProfileDeepLinkClearancePx(
  mode: ProfileScrollChromeMode,
): number {
  return mode === "fixed-header"
    ? PROFILE_FIXED_HEADER_HEIGHT_PX + PROFILE_DEEP_LINK_TOP_GAP_PX
    : PROFILE_DEEP_LINK_TOP_GAP_PX;
}

export interface ProfileDeepLinkScrollGeometry {
  anchorViewportTopPx: number;
  clearanceBelowAnchorPx: number;
  scrollerScrollTopPx: number;
  targetViewportTopPx: number;
}

export function computeProfileDeepLinkScrollTop(
  geometry: ProfileDeepLinkScrollGeometry,
): number {
  return Math.max(
    0,
    geometry.scrollerScrollTopPx +
      geometry.targetViewportTopPx -
      geometry.anchorViewportTopPx -
      geometry.clearanceBelowAnchorPx,
  );
}

const profileFocusTargets: Record<
  ProfileDeepLinkFocus,
  { headingId: string; sectionId: string }
> = {
  "work-eligibility": {
    headingId: "profile-setup-field-eligibility-authorized-work-countries",
    sectionId: "profile-work-eligibility",
  },
  "job-sources": {
    headingId: "profile-job-sources-heading",
    sectionId: "profile-job-sources",
  },
  "target-roles": {
    headingId: "profile-target-roles-heading",
    sectionId: "profile-target-roles",
  },
  "work-modes": {
    headingId: "profile-work-modes-heading",
    sectionId: "profile-work-modes",
  },
};

function resetScroll(element: HTMLElement, top: number) {
  if (typeof element.scrollTo === "function") {
    element.scrollTo({ behavior: "auto", left: 0, top });
    return;
  }

  element.scrollTop = top;
}

function isVerticalScrollport(element: HTMLElement, view: Window): boolean {
  const overflowY = view.getComputedStyle(element).overflowY;

  return (
    (overflowY === "auto" || overflowY === "scroll") &&
    element.scrollHeight > element.clientHeight
  );
}

function findNearestScrollport(
  start: Element,
  view: Window,
): HTMLElement | null {
  let node: Element | null = start.parentElement;

  while (node instanceof HTMLElement) {
    if (isVerticalScrollport(node, view)) {
      return node;
    }

    node = node.parentElement;
  }

  return null;
}

function alignPageScrollToClearance(
  target: HTMLElement,
  clearancePx: number,
  view: Window,
) {
  target.scrollIntoView({ behavior: "auto", block: "start" });

  for (
    let attempt = 0;
    attempt < PROFILE_MAX_OUTER_ALIGNMENT_ATTEMPTS;
    attempt += 1
  ) {
    const errorPx = target.getBoundingClientRect().top - clearancePx;

    if (errorPx >= 0) {
      return;
    }

    const scrollport = findNearestScrollport(target, view);

    if (!scrollport) {
      return;
    }

    const previousScrollTop = scrollport.scrollTop;
    scrollport.scrollTop = Math.max(0, previousScrollTop + errorPx);

    if (scrollport.scrollTop === previousScrollTop) {
      return;
    }
  }
}

export function resetProfileSectionScroll(
  documentRef: Document = document,
): boolean {
  const sectionScroller = documentRef.getElementById(
    PROFILE_SECTION_SCROLL_AREA_ID,
  );

  if (!(sectionScroller instanceof HTMLElement)) {
    return false;
  }

  resetScroll(sectionScroller, 0);
  const routeScroller = sectionScroller.closest<HTMLElement>(
    "[data-locked-screen-scroll-area]",
  );
  if (routeScroller) {
    resetScroll(routeScroller, 0);
  }
  return true;
}

export function focusProfileDeepLink(
  requestedFocus: ProfileDeepLinkFocus,
  documentRef: Document = document,
): boolean {
  const target = profileFocusTargets[requestedFocus];
  const heading = documentRef.getElementById(target.headingId);
  const section = documentRef.getElementById(target.sectionId);
  const sectionScroller = documentRef.getElementById(
    PROFILE_SECTION_SCROLL_AREA_ID,
  );

  if (!heading || !section || !(sectionScroller instanceof HTMLElement)) {
    return false;
  }

  const view = documentRef.defaultView;

  if (view) {
    const chromeMode = resolveProfileScrollChromeMode(view.innerWidth);

    if (chromeMode === "internal-scroller") {
      sectionScroller.scrollIntoView({ behavior: "auto", block: "start" });
      resetScroll(
        sectionScroller,
        computeProfileDeepLinkScrollTop({
          anchorViewportTopPx: sectionScroller.getBoundingClientRect().top,
          clearanceBelowAnchorPx: resolveProfileDeepLinkClearancePx(chromeMode),
          scrollerScrollTopPx: sectionScroller.scrollTop,
          targetViewportTopPx: section.getBoundingClientRect().top,
        }),
      );
    } else {
      alignPageScrollToClearance(
        section,
        resolveProfileDeepLinkClearancePx(chromeMode),
        view,
      );
    }
  }

  heading.focus({ preventScroll: true });
  return true;
}
