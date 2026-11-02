// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES,
  PROFILE_DEEP_LINK_TOP_GAP_PX,
  PROFILE_FIXED_HEADER_HEIGHT_PX,
  PROFILE_MAX_OUTER_ALIGNMENT_ATTEMPTS,
  PROFILE_SECTION_SCROLL_AREA_ID,
  PROFILE_SM_MIN_VIEWPORT_WIDTH_PX,
  PROFILE_XL_MIN_VIEWPORT_WIDTH_PX,
  computeProfileDeepLinkScrollTop,
  focusProfileDeepLink,
  resetProfileSectionScroll,
  resolveProfileDeepLinkClearancePx,
  resolveProfileScrollChromeMode,
} from "./profile-deep-link-focus";

function stubViewportWidth(widthPx: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: widthPx,
  });
}

function setupPageScrollFixture() {
  document.body.innerHTML = `
    <div class="page-scroll">
      <div id="${PROFILE_SECTION_SCROLL_AREA_ID}">
        <article id="profile-job-sources">
          <h3 id="profile-job-sources-heading" tabindex="-1">Job sites</h3>
        </article>
      </div>
    </div>
  `;
  const pageScroller = document.querySelector<HTMLElement>(".page-scroll");
  const section = document.getElementById("profile-job-sources");
  const heading = document.getElementById("profile-job-sources-heading");

  if (!pageScroller || !section || !heading) {
    throw new Error("Expected the Profile page-scroll fixture to render");
  }

  Object.defineProperty(pageScroller, "scrollHeight", {
    configurable: true,
    value: 2400,
  });
  Object.defineProperty(pageScroller, "clientHeight", {
    configurable: true,
    value: 800,
  });
  vi.spyOn(window, "getComputedStyle").mockImplementation((node) =>
    node === pageScroller
      ? ({ overflowY: "auto" } as CSSStyleDeclaration)
      : ({ overflowY: "visible" } as CSSStyleDeclaration),
  );

  return { heading, pageScroller, section };
}

function trackScrollTopWrites(pageScroller: HTMLElement, initialValue: number) {
  const tracked = { value: initialValue, writes: 0 };
  Object.defineProperty(pageScroller, "scrollTop", {
    configurable: true,
    get: () => tracked.value,
    set: (next: number) => {
      tracked.writes += 1;
      tracked.value = Math.max(0, next);
    },
  });
  return tracked;
}

describe("resolveProfileScrollChromeMode", () => {
  it.each([
    [PROFILE_SM_MIN_VIEWPORT_WIDTH_PX - 1, "static-header"],
    [PROFILE_SM_MIN_VIEWPORT_WIDTH_PX, "fixed-header"],
    [720, "fixed-header"],
    [PROFILE_XL_MIN_VIEWPORT_WIDTH_PX - 1, "fixed-header"],
    [PROFILE_XL_MIN_VIEWPORT_WIDTH_PX, "internal-scroller"],
  ] as const)(
    "classifies a %i CSS px viewport as %s",
    (viewportWidthPx, expectedMode) => {
      expect(resolveProfileScrollChromeMode(viewportWidthPx)).toBe(
        expectedMode,
      );
    },
  );
});

describe("resolveProfileDeepLinkClearancePx", () => {
  it("keeps the plain breathing gap for static-header and internal-scroller modes", () => {
    expect(resolveProfileDeepLinkClearancePx("static-header")).toBe(
      PROFILE_DEEP_LINK_TOP_GAP_PX,
    );
    expect(resolveProfileDeepLinkClearancePx("internal-scroller")).toBe(
      PROFILE_DEEP_LINK_TOP_GAP_PX,
    );
  });

  it("stacks the fixed shell header height plus the breathing gap between sm and xl", () => {
    const clearancePx = resolveProfileDeepLinkClearancePx("fixed-header");

    expect(clearancePx).toBe(
      PROFILE_FIXED_HEADER_HEIGHT_PX + PROFILE_DEEP_LINK_TOP_GAP_PX,
    );
    expect(clearancePx).toBeGreaterThan(PROFILE_FIXED_HEADER_HEIGHT_PX);
  });
});

describe("PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES", () => {
  it("derives every owned scroll-margin class from the fixed-header and gap constants", () => {
    // Tailwind defaults: spacing step 4 = 4px per step, root font size 16px.
    const fixedClearancePx = resolveProfileDeepLinkClearancePx("fixed-header");

    expect(PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES.base).toBe(
      `scroll-mt-${PROFILE_DEEP_LINK_TOP_GAP_PX / 4}`,
    );
    expect(PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES.fixedHeader).toBe(
      `sm:scroll-mt-[${fixedClearancePx / 16}rem]`,
    );
    expect(PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES.internalScroller).toBe(
      `xl:scroll-mt-${PROFILE_DEEP_LINK_TOP_GAP_PX / 4}`,
    );
    expect(fixedClearancePx / 16).toBe(4);
  });
});

describe("computeProfileDeepLinkScrollTop", () => {
  it("lands the target below the fixed shell header when the page scrolls between sm and xl", () => {
    const anchorViewportTopPx = 0;
    const clearanceBelowAnchorPx =
      resolveProfileDeepLinkClearancePx("fixed-header");
    const scrollerScrollTopPx = 400;
    const targetViewportTopPx = 416;

    const scrollTop = computeProfileDeepLinkScrollTop({
      anchorViewportTopPx,
      clearanceBelowAnchorPx,
      scrollerScrollTopPx,
      targetViewportTopPx,
    });

    expect(scrollTop).toBe(752);
    const targetViewportTopAfterScroll =
      scrollerScrollTopPx +
      targetViewportTopPx -
      anchorViewportTopPx -
      scrollTop;
    expect(targetViewportTopAfterScroll).toBe(clearanceBelowAnchorPx);
    expect(targetViewportTopAfterScroll).toBeGreaterThan(
      PROFILE_FIXED_HEADER_HEIGHT_PX,
    );
  });

  it("adds no invented chrome offset below the sm static header", () => {
    const anchorViewportTopPx = 0;
    const clearanceBelowAnchorPx =
      resolveProfileDeepLinkClearancePx("static-header");
    const scrollerScrollTopPx = 200;
    const targetViewportTopPx = 216;

    const scrollTop = computeProfileDeepLinkScrollTop({
      anchorViewportTopPx,
      clearanceBelowAnchorPx,
      scrollerScrollTopPx,
      targetViewportTopPx,
    });

    expect(scrollTop).toBe(400);
    expect(
      scrollerScrollTopPx +
        targetViewportTopPx -
        anchorViewportTopPx -
        scrollTop,
    ).toBe(PROFILE_DEEP_LINK_TOP_GAP_PX);
  });

  it("preserves the xl internal panel alignment relative to its own scrollport", () => {
    const anchorViewportTopPx = 200;
    const clearanceBelowAnchorPx =
      resolveProfileDeepLinkClearancePx("internal-scroller");
    const scrollerScrollTopPx = 120;
    const targetViewportTopPx = 680;

    const scrollTop = computeProfileDeepLinkScrollTop({
      anchorViewportTopPx,
      clearanceBelowAnchorPx,
      scrollerScrollTopPx,
      targetViewportTopPx,
    });

    expect(scrollTop).toBe(584);
    expect(
      scrollerScrollTopPx +
        targetViewportTopPx -
        anchorViewportTopPx -
        scrollTop,
    ).toBe(clearanceBelowAnchorPx);
  });

  it("clamps at the top of the scroller instead of overshooting", () => {
    expect(
      computeProfileDeepLinkScrollTop({
        anchorViewportTopPx: 0,
        clearanceBelowAnchorPx: PROFILE_DEEP_LINK_TOP_GAP_PX,
        scrollerScrollTopPx: 0,
        targetViewportTopPx: 10,
      }),
    ).toBe(0);
  });
});

describe("focusProfileDeepLink", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("resets the page and reveals the exact Job Sources destination inside the xl panel scroller", () => {
    stubViewportWidth(PROFILE_XL_MIN_VIEWPORT_WIDTH_PX);
    document.body.innerHTML = `
      <div class="screen-scroll-area">
        <div id="${PROFILE_SECTION_SCROLL_AREA_ID}">
          <article id="profile-job-sources">
            <h3 id="profile-job-sources-heading" tabindex="-1">Job sites</h3>
          </article>
        </div>
      </div>
    `;
    const sectionScroller = document.getElementById(
      PROFILE_SECTION_SCROLL_AREA_ID,
    );
    const section = document.getElementById("profile-job-sources");
    const heading = document.getElementById("profile-job-sources-heading");

    if (!sectionScroller || !section || !heading) {
      throw new Error("Expected the Profile deep-link test fixture to render");
    }

    const sectionScrollTo = vi.fn();
    const sectionScrollIntoView = vi.fn();
    sectionScroller.scrollTo = sectionScrollTo;
    sectionScroller.scrollIntoView = sectionScrollIntoView;
    sectionScroller.scrollTop = 120;
    vi.spyOn(sectionScroller, "getBoundingClientRect").mockReturnValue({
      top: 200,
    } as DOMRect);
    vi.spyOn(section, "getBoundingClientRect").mockReturnValue({
      top: 680,
    } as DOMRect);

    expect(focusProfileDeepLink("job-sources")).toBe(true);
    expect(sectionScrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "start",
    });
    expect(sectionScrollTo).toHaveBeenCalledWith({
      behavior: "auto",
      left: 0,
      top: 584,
    });
    expect(document.activeElement).toBe(heading);
  });

  it("reveals the Work modes destination inside Preferences", () => {
    stubViewportWidth(PROFILE_XL_MIN_VIEWPORT_WIDTH_PX);
    document.body.innerHTML = `
      <div class="screen-scroll-area">
        <div id="${PROFILE_SECTION_SCROLL_AREA_ID}">
          <article id="profile-work-modes">
            <h3 id="profile-work-modes-heading" tabindex="-1">Work mode and compensation</h3>
          </article>
        </div>
      </div>
    `;
    const sectionScroller = document.getElementById(
      PROFILE_SECTION_SCROLL_AREA_ID,
    );
    const section = document.getElementById("profile-work-modes");
    const heading = document.getElementById("profile-work-modes-heading");

    if (!sectionScroller || !section || !heading) {
      throw new Error("Expected the Work modes deep-link fixture to render");
    }

    const sectionScrollTo = vi.fn();
    sectionScroller.scrollTo = sectionScrollTo;
    sectionScroller.scrollIntoView = vi.fn();
    sectionScroller.scrollTop = 0;
    vi.spyOn(sectionScroller, "getBoundingClientRect").mockReturnValue({
      top: 200,
    } as DOMRect);
    vi.spyOn(section, "getBoundingClientRect").mockReturnValue({
      top: 480,
    } as DOMRect);

    expect(focusProfileDeepLink("work-modes")).toBe(true);
    expect(sectionScrollTo).toHaveBeenCalledWith({
      behavior: "auto",
      left: 0,
      top: 264,
    });
    expect(document.activeElement).toBe(heading);
  });

  it("clears the fixed shell header when the page scrolls at zoom2 widths between sm and xl", () => {
    stubViewportWidth(720);
    const { pageScroller, section, heading } = setupPageScrollFixture();
    pageScroller.scrollTop = 500;
    const sectionScrollIntoView = vi.fn();
    section.scrollIntoView = sectionScrollIntoView;
    const sectionTopAtInitialScroll = 16;
    vi.spyOn(section, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          top: sectionTopAtInitialScroll - (pageScroller.scrollTop - 500),
        }) as DOMRect,
    );

    expect(focusProfileDeepLink("job-sources")).toBe(true);

    expect(sectionScrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "start",
    });
    expect(pageScroller.scrollTop).toBe(452);
    const alignedSectionViewportTop =
      sectionTopAtInitialScroll - (pageScroller.scrollTop - 500);
    expect(alignedSectionViewportTop).toBeGreaterThan(
      PROFILE_FIXED_HEADER_HEIGHT_PX,
    );
    expect(alignedSectionViewportTop).toBe(
      resolveProfileDeepLinkClearancePx("fixed-header"),
    );
    expect(document.activeElement).toBe(heading);
  });

  it("applies only the breathing gap when the narrow static header scrolls away", () => {
    stubViewportWidth(PROFILE_SM_MIN_VIEWPORT_WIDTH_PX - 1);
    const { pageScroller, section, heading } = setupPageScrollFixture();
    pageScroller.scrollTop = 300;
    section.scrollIntoView = vi.fn();
    const sectionTopAtInitialScroll = 0;
    vi.spyOn(section, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          top: sectionTopAtInitialScroll - (pageScroller.scrollTop - 300),
        }) as DOMRect,
    );

    expect(focusProfileDeepLink("job-sources")).toBe(true);

    expect(pageScroller.scrollTop).toBe(284);
    const alignedSectionViewportTop =
      sectionTopAtInitialScroll - (pageScroller.scrollTop - 300);
    expect(alignedSectionViewportTop).toBe(PROFILE_DEEP_LINK_TOP_GAP_PX);
    expect(document.activeElement).toBe(heading);
  });

  it("stops after one clamped write when the scrollport has no upward headroom", () => {
    stubViewportWidth(720);
    const { pageScroller, section, heading } = setupPageScrollFixture();
    const tracked = trackScrollTopWrites(pageScroller, 0);
    section.scrollIntoView = vi.fn();
    vi.spyOn(section, "getBoundingClientRect").mockReturnValue({
      top: 40,
    } as DOMRect);

    expect(focusProfileDeepLink("job-sources")).toBe(true);

    expect(tracked.writes).toBe(1);
    expect(tracked.value).toBe(0);
    expect(document.activeElement).toBe(heading);
  });

  it("bails without writing scroll positions when no qualifying scrollport exists", () => {
    stubViewportWidth(720);
    const { pageScroller, section, heading } = setupPageScrollFixture();
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      overflowY: "visible",
    } as CSSStyleDeclaration);
    pageScroller.scrollTop = 120;
    const sectionScrollIntoView = vi.fn();
    section.scrollIntoView = sectionScrollIntoView;
    vi.spyOn(section, "getBoundingClientRect").mockReturnValue({
      top: 10,
    } as DOMRect);

    expect(focusProfileDeepLink("job-sources")).toBe(true);

    expect(sectionScrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "start",
    });
    expect(pageScroller.scrollTop).toBe(120);
    expect(document.activeElement).toBe(heading);
  });

  it("converges over multiple bounded writes when each write steps the scroll position", () => {
    stubViewportWidth(720);
    const { pageScroller, section, heading } = setupPageScrollFixture();
    const maxStepPx = 50;
    let scrollTopValue = 500;
    Object.defineProperty(pageScroller, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (next: number) => {
        const delta = next - scrollTopValue;
        scrollTopValue +=
          Math.sign(delta) * Math.min(Math.abs(delta), maxStepPx);
      },
    });
    section.scrollIntoView = vi.fn();
    vi.spyOn(section, "getBoundingClientRect").mockImplementation(
      () => ({ top: 16 + (500 - scrollTopValue) }) as DOMRect,
    );

    expect(focusProfileDeepLink("job-sources")).toBe(true);

    expect(scrollTopValue).toBe(452);
    expect(16 + (500 - scrollTopValue)).toBe(
      resolveProfileDeepLinkClearancePx("fixed-header"),
    );
    expect(document.activeElement).toBe(heading);
  });

  it("bounds the correction loop when measured alignment never improves", () => {
    stubViewportWidth(720);
    const { pageScroller, section, heading } = setupPageScrollFixture();
    const tracked = trackScrollTopWrites(pageScroller, 500);
    section.scrollIntoView = vi.fn();
    vi.spyOn(section, "getBoundingClientRect").mockReturnValue({
      top: 16,
    } as DOMRect);

    expect(focusProfileDeepLink("job-sources")).toBe(true);

    expect(tracked.writes).toBe(PROFILE_MAX_OUTER_ALIGNMENT_ATTEMPTS);
    expect(document.activeElement).toBe(heading);
  });

  it("waits when the requested Preferences content has not rendered yet", () => {
    expect(focusProfileDeepLink("target-roles")).toBe(false);
  });
  it("returns a newly selected profile tab to the top of both scroll owners", () => {
    document.body.innerHTML = `<div data-locked-screen-scroll-area><div id="${PROFILE_SECTION_SCROLL_AREA_ID}"></div></div>`;
    const routeScroller = document.querySelector<HTMLElement>(
      "[data-locked-screen-scroll-area]",
    )!;
    const routeScrollTo = vi.fn();
    routeScroller.scrollTo = routeScrollTo;
    routeScroller.scrollTop = 800;
    const sectionScroller = document.getElementById(
      PROFILE_SECTION_SCROLL_AREA_ID,
    );
    if (!sectionScroller) {
      throw new Error("Expected the Profile section scroller to render");
    }
    const scrollTo = vi.fn();
    sectionScroller.scrollTo = scrollTo;
    sectionScroller.scrollTop = 540;
    expect(resetProfileSectionScroll()).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({
      behavior: "auto",
      left: 0,
      top: 0,
    });
    expect(routeScrollTo).toHaveBeenCalledWith({
      behavior: "auto",
      left: 0,
      top: 0,
    });
  });
});
