// @vitest-environment jsdom

import { describe, expect, it, type MockInstance, vi } from "vitest";
import {
  findCollectionItemWithinRegion,
  findNearestVerticalScrollportFrom,
  JOB_FINDER_FIXED_HEADER_HEIGHT_PX,
  JOB_FINDER_REVEAL_SCROLL_MARGIN_CLASSES,
  JOB_FINDER_REVEAL_TOP_GAP_PX,
  JOB_FINDER_ROUTE_HEADER_SCROLL_TOLERANCE_PX,
  JOB_FINDER_WIDE_HEADER_HEIGHT_PX,
  resolveJobFinderRevealChromeMode,
  resolveJobFinderRevealClearancePx,
  resolveJobFinderRouteHeaderScrollTop,
  revealBelowShellHeader,
  settleJobFinderRouteHeaderScroll,
  type JobFinderRevealView,
} from "./job-finder-scroll-reveal";

function createView(
  overrides: Partial<JobFinderRevealView> = {},
): JobFinderRevealView {
  return {
    innerWidth: 800,
    getComputedStyle: (element) => window.getComputedStyle(element),
    ...overrides,
  };
}

interface Scrollport {
  element: HTMLElement;
}

/**
 * Real DOM chain `outer -> [inner ->] target`. Every wrapper is configured as
 * a vertical scrollport; the reveal target reports each queued viewport top
 * once per alignment attempt so tests pin exact converge/pin/walk-out
 * behavior without guessing jsdom layout.
 */
function createScrollChain(levels: 1 | 2): {
  target: HTMLElement;
  targetRects: MockInstance;
  inner: Scrollport | null;
  outer: Scrollport;
  cleanup(): void;
} {
  const makeLevel = (): Scrollport => {
    const element = document.createElement("div");
    element.style.overflowY = "auto";
    Object.defineProperty(element, "scrollHeight", { value: 5000 });
    Object.defineProperty(element, "clientHeight", { value: 400 });
    return { element };
  };

  const outer = makeLevel();
  const inner = levels === 2 ? makeLevel() : null;
  const target = document.createElement("button");

  if (inner) {
    inner.element.appendChild(target);
    outer.element.appendChild(inner.element);
  } else {
    outer.element.appendChild(target);
  }

  document.body.appendChild(outer.element);

  const targetRects = vi
    .spyOn(target, "getBoundingClientRect")
    .mockReturnValue({
      top: 0,
    } as DOMRect);

  return {
    target,
    targetRects,
    inner,
    outer,
    cleanup() {
      targetRects.mockRestore();
      outer.element.remove();
    },
  };
}

describe("resolveJobFinderRevealChromeMode", () => {
  it("tracks the shell header bands at their exact breakpoints", () => {
    expect(resolveJobFinderRevealChromeMode(639)).toBe("static-header");
    expect(resolveJobFinderRevealChromeMode(640)).toBe("fixed-header");
    expect(resolveJobFinderRevealChromeMode(1279)).toBe("fixed-header");
    // From 1280px the shell header is one 56px row.
    expect(resolveJobFinderRevealChromeMode(1280)).toBe("wide-fixed-header");
    expect(resolveJobFinderRevealChromeMode(1439)).toBe("wide-fixed-header");
    expect(resolveJobFinderRevealChromeMode(1440)).toBe("wide-fixed-header");
  });
});

describe("resolveJobFinderRevealClearancePx", () => {
  it("clears each header band plus the shared breathing gap", () => {
    expect(resolveJobFinderRevealClearancePx("static-header")).toBe(
      JOB_FINDER_REVEAL_TOP_GAP_PX,
    );
    expect(resolveJobFinderRevealClearancePx("fixed-header")).toBe(
      JOB_FINDER_FIXED_HEADER_HEIGHT_PX + JOB_FINDER_REVEAL_TOP_GAP_PX,
    );
    expect(resolveJobFinderRevealClearancePx("wide-fixed-header")).toBe(
      JOB_FINDER_WIDE_HEADER_HEIGHT_PX + JOB_FINDER_REVEAL_TOP_GAP_PX,
    );
  });

  it("keeps the shared scroll-margin class tokens bound to the same geometry", () => {
    // Tailwind scale: rem tokens are px/16, gap uses the 4px scale step.
    expect(JOB_FINDER_REVEAL_SCROLL_MARGIN_CLASSES.base).toBe(
      `scroll-mt-${JOB_FINDER_REVEAL_TOP_GAP_PX / 4}`,
    );
    expect(JOB_FINDER_REVEAL_SCROLL_MARGIN_CLASSES.fixedHeader).toBe(
      `sm:scroll-mt-[${
        (JOB_FINDER_FIXED_HEADER_HEIGHT_PX + JOB_FINDER_REVEAL_TOP_GAP_PX) / 16
      }rem]`,
    );
    // The wide token is the named `xl` breakpoint, emitted after `sm:`, so it
    // beats the still-matching `sm:` token without `!`.
    expect(JOB_FINDER_REVEAL_SCROLL_MARGIN_CLASSES.wideFixedHeader).toBe(
      `xl:scroll-mt-[${
        (JOB_FINDER_WIDE_HEADER_HEIGHT_PX + JOB_FINDER_REVEAL_TOP_GAP_PX) / 16
      }rem]`,
    );
  });
});

describe("route header scroll settling", () => {
  it("chooses a whole-header boundary for a partially occluded route title", () => {
    expect(resolveJobFinderRouteHeaderScrollTop(0, 120)).toBe(0);
    expect(resolveJobFinderRouteHeaderScrollTop(40, 120)).toBe(0);
    expect(resolveJobFinderRouteHeaderScrollTop(80, 120)).toBe(120);
    expect(resolveJobFinderRouteHeaderScrollTop(120, 120)).toBe(120);
    expect(resolveJobFinderRouteHeaderScrollTop(-10, 120)).toBe(0);
  });

  it("writes only when the page scrollport is between its resting positions", () => {
    const scrollArea = document.createElement("div");
    document.body.appendChild(scrollArea);

    scrollArea.scrollTop = 72;
    expect(settleJobFinderRouteHeaderScroll(scrollArea, 120)).toBe(true);
    expect(scrollArea.scrollTop).toBe(120);

    expect(
      Math.abs(120 - 120) <= JOB_FINDER_ROUTE_HEADER_SCROLL_TOLERANCE_PX,
    ).toBe(true);
    expect(settleJobFinderRouteHeaderScroll(scrollArea, 120)).toBe(false);

    scrollArea.remove();
  });
});

describe("findNearestVerticalScrollportFrom", () => {
  it("skips the start node itself and requires a real vertical scrollport", () => {
    const outer = createScrollChain(1).outer;
    const child = document.createElement("div");

    outer.element.appendChild(child);
    document.body.appendChild(outer.element);

    // `child` has default overflow, so the search from it must skip it and
    // land on the configured ancestor.
    expect(findNearestVerticalScrollportFrom(child, createView())).toBe(
      outer.element,
    );
    // Starting inside the scrollport itself must not return it.
    expect(
      findNearestVerticalScrollportFrom(outer.element, createView()),
    ).toBeNull();

    outer.element.remove();
  });
});

describe("revealBelowShellHeader", () => {
  it("aligns the target below the band clearance through explicit scroller writes", () => {
    const chain = createScrollChain(1);
    try {
      // Fixed-header band (800px viewport): clearance 132px. First measure
      // puts the row at -40px; the clamped correction consumes the distance
      // and the re-measure stops the loop at exactly the clearance.
      chain.targetRects
        .mockReturnValueOnce({ top: -40 } as DOMRect)
        .mockReturnValueOnce({ top: 132 } as DOMRect);
      chain.outer.element.scrollTop = 10;

      revealBelowShellHeader(chain.target, createView());

      // errorPx = -40 - 132 = -172, clamped to the scroller top.
      expect(chain.outer.element.scrollTop).toBe(0);
      expect(chain.targetRects).toHaveBeenCalledTimes(2);
    } finally {
      chain.cleanup();
    }
  });

  it("walks past a pinned inner scroller so the page-level reveal still clears the header", () => {
    const chain = createScrollChain(2);
    try {
      // Inner scroller sits at its top boundary, so every correction aimed at
      // it is a no-op and must hand the remaining distance to the outer page
      // scroller instead of stalling.
      chain.inner!.element.scrollTop = 0;
      chain.outer.element.scrollTop = 50;
      chain.targetRects.mockReturnValue({ top: -200 } as DOMRect);
      chain.targetRects.mockReturnValueOnce({ top: -200 } as DOMRect);
      chain.targetRects.mockReturnValueOnce({ top: -200 } as DOMRect);
      chain.targetRects.mockReturnValueOnce({ top: 132 } as DOMRect);

      revealBelowShellHeader(chain.target, createView());

      expect(chain.inner!.element.scrollTop).toBe(0);
      expect(chain.outer.element.scrollTop).toBe(0);
      expect(chain.targetRects).toHaveBeenCalledTimes(3);
    } finally {
      chain.cleanup();
    }
  });

  it("uses instant scroller adjustments only and never delegates to native scrolling", () => {
    const chain = createScrollChain(1);
    const scrollIntoViewMock = vi.fn();
    chain.target.scrollIntoView = scrollIntoViewMock;
    try {
      chain.targetRects.mockReturnValue({ top: 132 } as DOMRect);

      revealBelowShellHeader(chain.target, createView());

      expect(scrollIntoViewMock).not.toHaveBeenCalled();
    } finally {
      chain.cleanup();
    }
  });
});

describe("findCollectionItemWithinRegion", () => {
  it("scopes the lookup to its collection region when duplicate ids exist across surfaces", () => {
    const regionA = document.createElement("section");
    const regionB = document.createElement("section");

    for (const region of [regionA, regionB]) {
      const row = document.createElement("button");
      row.dataset.collectionItemId = "shared_id";
      region.appendChild(row);
      document.body.appendChild(region);
    }

    const [rowA] = regionA.querySelectorAll<HTMLElement>(
      "[data-collection-item-id]",
    );

    expect(findCollectionItemWithinRegion(regionA, "shared_id")).toBe(rowA);
    expect(findCollectionItemWithinRegion(regionB, "shared_id")).not.toBe(rowA);
  });

  it("returns null for a missing row and falls back to document scope without a region", () => {
    const orphan = document.createElement("button");
    orphan.dataset.collectionItemId = "orphan_id";
    document.body.appendChild(orphan);

    expect(findCollectionItemWithinRegion(null, "missing_id")).toBeNull();
    expect(findCollectionItemWithinRegion(undefined, "orphan_id")).toBe(orphan);
    expect(
      findCollectionItemWithinRegion(document.body, "other_id"),
    ).toBeNull();
  });
});
