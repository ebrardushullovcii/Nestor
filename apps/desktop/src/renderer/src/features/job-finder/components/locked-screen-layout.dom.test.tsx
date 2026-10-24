// @vitest-environment jsdom

import { cleanup, fireEvent, render, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LockedScreenLayout } from "./locked-screen-layout";

/**
 * jsdom leaves every element at `scrollHeight === clientHeight === 0`, so a
 * test that does not say otherwise is asserting against an outer owner with no
 * scroll range at all. Say it explicitly: the header can only absorb delta when
 * the route scroller can really move.
 */
function stubOuterScrollRange(element: HTMLElement | null, range: number) {
  if (!element) {
    return;
  }
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, value: 600 + Math.max(0, range) },
  });
}

describe("LockedScreenLayout pointer-owned scrolling", () => {
  beforeEach(() => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
      unobserve() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("caps the layout at the route viewport only when a route locks its panes", () => {
    const { container, rerender } = render(
      <LockedScreenLayout topContent={<div>Find jobs</div>}>
        <div>Two panes</div>
      </LockedScreenLayout>,
    );
    const grid = () =>
      container.querySelector<HTMLElement>(
        "[data-locked-screen-scroll-area] > div",
      );

    // Default: the grid only has a floor, so a long route scrolls as a page.
    expect(grid()?.className).toContain("min-h-full");
    expect(grid()?.className).not.toContain("xl:h-full");
    expect(grid()?.dataset.lockedScreenContentHeight).toBeUndefined();

    rerender(
      <LockedScreenLayout lockContentHeight topContent={<div>Find jobs</div>}>
        <div>Two panes</div>
      </LockedScreenLayout>,
    );

    // Locked: without a definite height the content row resolves to
    // max-content, every pane grows past the fold, and a pane's own
    // overflow-y-auto never activates.
    expect(grid()?.className).toContain("xl:h-full");
    expect(grid()?.dataset.lockedScreenContentHeight).toBe("locked");
  });

  test("mounts without writing a scroll position, so it forces no layout", () => {
    vi.stubGlobal("innerWidth", 1440);
    const writes: number[] = [];
    const originalScrollTopDescriptor = Object.getOwnPropertyDescriptor(
      HTMLDivElement.prototype,
      "scrollTop",
    );
    const measured = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");

    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: (value: number) => {
        writes.push(value);
      },
    });

    try {
      const { container } = render(
        <LockedScreenLayout topContent={<div>Resume workspace</div>}>
          <div>Resume editor</div>
        </LockedScreenLayout>,
      );
      const outerScroller = container.querySelector<HTMLElement>(
        "[data-locked-screen-scroll-area]",
      );

      // A new scroll owner already starts at the top; anchoring is still off.
      expect(writes).toEqual([]);
      expect(measured).not.toHaveBeenCalled();
      expect(outerScroller?.style.overflowAnchor).toBe("none");
    } finally {
      if (originalScrollTopDescriptor) {
        Object.defineProperty(
          HTMLDivElement.prototype,
          "scrollTop",
          originalScrollTopDescriptor,
        );
      } else {
        delete (HTMLDivElement.prototype as { scrollTop?: number }).scrollTop;
      }
    }
  });

  test("resets route and nested top scroll owners when the view identity changes", () => {
    const { container, rerender } = render(
      <LockedScreenLayout
        scrollResetKey="essentials"
        topClassName="max-h-8 overflow-y-auto"
        topContent={<div>Profile setup summary</div>}
      >
        <div>Profile setup editor</div>
      </LockedScreenLayout>,
    );
    const outerScroller = container.querySelector<HTMLElement>(
      "[data-locked-screen-scroll-area]",
    );
    const topScroller = container.querySelector<HTMLElement>(
      "[data-locked-screen-top-content]",
    );

    expect(outerScroller).not.toBeNull();
    expect(topScroller).not.toBeNull();
    if (!outerScroller || !topScroller) {
      return;
    }

    outerScroller.scrollTop = 72;
    topScroller.scrollTop = 24;

    rerender(
      <LockedScreenLayout
        scrollResetKey="background"
        topClassName="max-h-8 overflow-y-auto"
        topContent={<div>Profile setup summary</div>}
      >
        <div>Profile setup editor</div>
      </LockedScreenLayout>,
    );

    expect(outerScroller.scrollTop).toBe(0);
    expect(topScroller.scrollTop).toBe(0);
    expect(outerScroller.style.overflowAnchor).toBe("none");
    expect(topScroller.style.overflowAnchor).toBe("none");
  });

  test("snaps a half-scrolled page header fully out once scrolling settles", () => {
    vi.useFakeTimers();
    vi.stubGlobal("innerWidth", 1440);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 177,
      height: 177,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    try {
      const { container } = render(
        <LockedScreenLayout topContent={<h1>Shortlisted</h1>}>
          <div>Queue</div>
        </LockedScreenLayout>,
      );
      const outerScroller = container.querySelector<HTMLElement>(
        "[data-locked-screen-scroll-area]",
      );

      expect(outerScroller).not.toBeNull();
      if (!outerScroller) {
        return;
      }

      Object.defineProperties(outerScroller, {
        clientHeight: { configurable: true, value: 800 },
        scrollHeight: { configurable: true, value: 2400 },
      });
      const scrollTo = vi.fn((options: ScrollToOptions) => {
        outerScroller.scrollTop = options.top ?? 0;
      });
      outerScroller.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];

      // A partial header scroll from any source (trackpad fling, scrollbar
      // drag, focus scroll) would otherwise leave the H1 clipped mid-glyph.
      outerScroller.scrollTop = 34;
      fireEvent.scroll(outerScroller);
      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({ top: 177 }),
      );
      expect(outerScroller.scrollTop).toBe(177);
    } finally {
      vi.useRealTimers();
    }
  });

  test("leaves a fully collapsed or fully visible header untouched on settle", () => {
    vi.useFakeTimers();
    vi.stubGlobal("innerWidth", 1440);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 177,
      height: 177,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    try {
      const { container } = render(
        <LockedScreenLayout topContent={<h1>Shortlisted</h1>}>
          <div>Queue</div>
        </LockedScreenLayout>,
      );
      const outerScroller = container.querySelector<HTMLElement>(
        "[data-locked-screen-scroll-area]",
      );

      if (!outerScroller) {
        expect(outerScroller).not.toBeNull();
        return;
      }

      Object.defineProperties(outerScroller, {
        clientHeight: { configurable: true, value: 800 },
        scrollHeight: { configurable: true, value: 2400 },
      });
      const scrollTo = vi.fn();
      outerScroller.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];

      outerScroller.scrollTop = 900;
      fireEvent.scroll(outerScroller);
      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(scrollTo).not.toHaveBeenCalled();
      expect(outerScroller.scrollTop).toBe(900);
    } finally {
      vi.useRealTimers();
    }
  });

  // F91: while the pane under the pointer still has range in the wheel's
  // direction, the browser owns the scroll. The layout must not preventDefault
  // and must not write a scrollTop: manual forwarding both destroyed the
  // compositor fast path and silently ate `topHeight` px of every delta,
  // because the header was "consumed" into an outer owner with no range.
  test("leaves a nested pane with remaining range to native scrolling", () => {
    vi.stubGlobal("innerWidth", 1440);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 200,
      height: 200,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const { container, getByTestId } = render(
      <LockedScreenLayout topContent={<div>Find jobs</div>}>
        <div data-locked-pane-scroll-region data-testid="left-pane">
          <span data-testid="left-pane-content">Search filters</span>
        </div>
      </LockedScreenLayout>,
    );
    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const pane = getByTestId("left-pane");

    expect(outerScroller).toBeTruthy();
    stubOuterScrollRange(outerScroller, 200);
    Object.defineProperties(pane, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });
    pane.scrollTop = 40;

    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 80,
    });
    getByTestId("left-pane-content").dispatchEvent(wheelEvent);

    expect(wheelEvent.defaultPrevented).toBe(false);
    expect(outerScroller?.scrollTop).toBe(0);
    expect(pane.scrollTop).toBe(40);
  });

  test("never taxes a wheel delta with header collapse while the pane has range", () => {
    vi.stubGlobal("innerWidth", 1440);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 177.484,
      height: 177.484,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const { container, getByTestId } = render(
      <LockedScreenLayout topContent={<div>Find jobs</div>}>
        <div data-locked-pane-scroll-region data-testid="results-pane">
          <span data-testid="result-card">Software engineer</span>
        </div>
      </LockedScreenLayout>,
    );
    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const pane = getByTestId("results-pane");
    stubOuterScrollRange(outerScroller, 178);
    Object.defineProperties(pane, {
      clientHeight: { configurable: true, value: 688 },
      scrollHeight: { configurable: true, value: 8553 },
    });
    pane.scrollTop = 0;

    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 600,
    });
    getByTestId("result-card").dispatchEvent(wheelEvent);

    expect(wheelEvent.defaultPrevented).toBe(false);
    expect(outerScroller?.scrollTop).toBe(0);
    expect(pane.scrollTop).toBe(0);
  });

  test("normalizes line-mode wheel input once before handing it to the header", () => {
    vi.stubGlobal("innerWidth", 1440);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 200,
      height: 200,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const { container, getByTestId } = render(
      <LockedScreenLayout topContent={<div>Find jobs</div>}>
        <div data-locked-pane-scroll-region data-testid="left-pane">
          <span data-testid="left-pane-content">Search filters</span>
        </div>
      </LockedScreenLayout>,
    );
    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const pane = getByTestId("left-pane");
    stubOuterScrollRange(outerScroller, 200);
    Object.defineProperties(pane, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });
    // Pane already at its end: this is a true boundary, so the header may take
    // the delta — and only here is line-mode normalization the layout's job.
    pane.scrollTop = 400;

    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      deltaY: 3,
    });
    getByTestId("left-pane-content").dispatchEvent(wheelEvent);

    expect(wheelEvent.defaultPrevented).toBe(true);
    expect(outerScroller?.scrollTop).toBe(48);
    expect(pane.scrollTop).toBe(400);
  });

  test("does not move the header when the outer owner has no scroll range", () => {
    vi.stubGlobal("innerWidth", 1440);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 200,
      height: 200,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const { container, getByTestId } = render(
      <LockedScreenLayout topContent={<div>Find jobs</div>}>
        <div data-locked-pane-scroll-region data-testid="left-pane">
          <span data-testid="left-pane-content">Search filters</span>
        </div>
      </LockedScreenLayout>,
    );
    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const pane = getByTestId("left-pane");
    // Locked routes cap the content at the viewport, so the outer owner really
    // does have zero range. Treating that as "unknown" made the header absorb
    // `topHeight` px of every delta into a scroller the browser clamped back.
    stubOuterScrollRange(outerScroller, 0);
    Object.defineProperties(pane, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });
    pane.scrollTop = 400;

    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 80,
    });
    getByTestId("left-pane-content").dispatchEvent(wheelEvent);

    expect(wheelEvent.defaultPrevented).toBe(false);
    expect(outerScroller?.scrollTop).toBe(0);
    expect(pane.scrollTop).toBe(400);
  });

  test("restores the wide page header when an upward wheel reaches the pane top", () => {
    vi.stubGlobal("innerWidth", 1440);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 200,
      height: 200,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const { container, getByTestId } = render(
      <LockedScreenLayout topContent={<div>Find jobs</div>}>
        <div data-locked-pane-scroll-region data-testid="left-pane">
          <span data-testid="left-pane-content">Search filters</span>
        </div>
      </LockedScreenLayout>,
    );
    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const pane = getByTestId("left-pane");
    stubOuterScrollRange(outerScroller, 200);
    Object.defineProperties(pane, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });
    if (outerScroller) {
      outerScroller.scrollTop = 200;
    }
    pane.scrollTop = 0;

    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -80,
    });
    getByTestId("left-pane-content").dispatchEvent(wheelEvent);

    expect(wheelEvent.defaultPrevented).toBe(true);
    expect(outerScroller?.scrollTop).toBe(120);
    expect(pane.scrollTop).toBe(0);
  });

  test("chains the pane start back to the header and releases the pane end", () => {
    vi.stubGlobal("innerWidth", 1440);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 200,
      height: 200,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const { container, getByTestId } = render(
      <LockedScreenLayout topContent={<div>Find jobs</div>}>
        <div data-locked-pane-scroll-region data-testid="left-pane">
          <span data-testid="left-pane-content">Search filters</span>
        </div>
      </LockedScreenLayout>,
    );
    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const pane = getByTestId("left-pane");
    stubOuterScrollRange(outerScroller, 200);
    Object.defineProperties(pane, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });
    if (outerScroller) {
      outerScroller.scrollTop = 120;
    }
    pane.scrollTop = 0;

    const startEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -80,
    });
    getByTestId("left-pane-content").dispatchEvent(startEvent);

    expect(startEvent.defaultPrevented).toBe(true);
    expect(outerScroller?.scrollTop).toBe(40);
    expect(pane.scrollTop).toBe(0);

    if (outerScroller) {
      outerScroller.scrollTop = 200;
    }
    pane.scrollTop = 400;
    const endEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 80,
    });
    getByTestId("left-pane-content").dispatchEvent(endEvent);

    expect(endEvent.defaultPrevented).toBe(false);
    expect(outerScroller?.scrollTop).toBe(200);
    expect(pane.scrollTop).toBe(400);
  });

  test("leaves downward input unblocked at the pane and page bottom", () => {
    vi.stubGlobal("innerWidth", 1440);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 200,
      height: 200,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const { container, getByTestId } = render(
      <LockedScreenLayout topContent={<div>Find jobs</div>}>
        <div data-locked-pane-scroll-region data-testid="left-pane">
          <span data-testid="left-pane-content">Search filters</span>
        </div>
      </LockedScreenLayout>,
    );
    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const pane = getByTestId("left-pane");
    Object.defineProperties(pane, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });
    if (outerScroller) {
      outerScroller.scrollTop = 200;
    }
    pane.scrollTop = 400;

    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 80,
    });
    getByTestId("left-pane-content").dispatchEvent(wheelEvent);

    expect(wheelEvent.defaultPrevented).toBe(false);
    expect(outerScroller?.scrollTop).toBe(200);
    expect(pane.scrollTop).toBe(400);
  });

  test.each([
    ["control", { ctrlKey: true }],
    ["command", { metaKey: true }],
  ])("does not block %s-wheel browser zoom", (_label, modifier) => {
    vi.stubGlobal("innerWidth", 1440);
    const { container, getByTestId } = render(
      <LockedScreenLayout topContent={<div>Find jobs</div>}>
        <div data-locked-pane-scroll-region data-testid="left-pane">
          <span data-testid="left-pane-content">Search filters</span>
        </div>
      </LockedScreenLayout>,
    );
    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const pane = getByTestId("left-pane");
    Object.defineProperties(pane, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });
    pane.scrollTop = 40;

    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 80,
      ...modifier,
    });
    getByTestId("left-pane-content").dispatchEvent(wheelEvent);

    expect(wheelEvent.defaultPrevented).toBe(false);
    expect(outerScroller?.scrollTop).toBe(0);
    expect(pane.scrollTop).toBe(40);
  });

  test("leaves narrow layouts to normal browser scrolling", () => {
    vi.stubGlobal("innerWidth", 1024);
    const { getByTestId } = render(
      <LockedScreenLayout topContent={<div>Find jobs</div>}>
        <div data-locked-pane-scroll-region data-testid="left-pane">
          <span data-testid="left-pane-content">Search filters</span>
        </div>
      </LockedScreenLayout>,
    );
    const pane = getByTestId("left-pane");
    Object.defineProperties(pane, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });
    pane.scrollTop = 40;
    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 80,
    });

    getByTestId("left-pane-content").dispatchEvent(wheelEvent);

    expect(wheelEvent.defaultPrevented).toBe(false);
    expect(pane.scrollTop).toBe(40);
  });

  test("leaves Space activation with interactive descendants", () => {
    vi.stubGlobal("innerWidth", 1440);
    const onClick = vi.fn();
    const { getByTestId } = render(
      <LockedScreenLayout topContent={<div>Find jobs</div>}>
        <button data-testid="action" onClick={onClick} type="button">
          <span>Open details</span>
        </button>
      </LockedScreenLayout>,
    );
    const action = getByTestId("action");
    action.focus();

    expect(fireEvent.keyDown(action, { key: " " })).toBe(true);
    fireEvent.click(action);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("chains PageDown from a pane bottom to the collapsed outer owner", () => {
    vi.stubGlobal("innerWidth", 1440);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 200,
      height: 200,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const { container, getByTestId } = render(
      <LockedScreenLayout topContent={<div>Find jobs</div>}>
        <div
          data-locked-pane-scroll-region
          data-testid="left-pane"
          tabIndex={0}
        >
          <span data-testid="left-pane-content">Search filters</span>
        </div>
      </LockedScreenLayout>,
    );
    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const pane = getByTestId("left-pane");
    Object.defineProperties(outerScroller as HTMLElement, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    Object.defineProperties(pane, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });
    if (outerScroller) {
      outerScroller.scrollTop = 200;
    }
    pane.scrollTop = 400;

    pane.focus();
    const keyEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "PageDown",
    });
    pane.dispatchEvent(keyEvent);

    expect(keyEvent.defaultPrevented).toBe(true);
    expect(outerScroller?.scrollTop).toBe(300);
    expect(pane.scrollTop).toBe(400);
  });

  test("chains ArrowUp from a pane top back through the collapsed header", () => {
    vi.stubGlobal("innerWidth", 1440);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 200,
      height: 200,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const { container, getByTestId } = render(
      <LockedScreenLayout topContent={<div>Find jobs</div>}>
        <div
          data-locked-pane-scroll-region
          data-testid="left-pane"
          tabIndex={0}
        >
          <span data-testid="left-pane-content">Search filters</span>
        </div>
      </LockedScreenLayout>,
    );
    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const pane = getByTestId("left-pane");
    Object.defineProperties(pane, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });
    stubOuterScrollRange(outerScroller, 240);
    if (outerScroller) {
      outerScroller.scrollTop = 240;
    }
    pane.scrollTop = 0;

    pane.focus();
    const keyEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowUp",
    });
    pane.dispatchEvent(keyEvent);

    expect(keyEvent.defaultPrevented).toBe(true);
    expect(outerScroller?.scrollTop).toBe(200);
    expect(pane.scrollTop).toBe(0);
  });

  test("leaves result-list arrow navigation with a focused pane descendant", () => {
    vi.stubGlobal("innerWidth", 1440);
    const onKeyDown = vi.fn();
    const { getByTestId } = render(
      <LockedScreenLayout topContent={<div>Find jobs</div>}>
        <div
          data-locked-pane-scroll-region
          data-testid="results-pane"
          tabIndex={0}
        >
          <button data-testid="result" onKeyDown={onKeyDown} type="button">
            Software engineer
          </button>
        </div>
      </LockedScreenLayout>,
    );
    const pane = getByTestId("results-pane");
    const result = getByTestId("result");
    Object.defineProperties(pane, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });
    pane.scrollTop = 40;
    result.focus();

    const keyEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowDown",
    });
    result.dispatchEvent(keyEvent);

    expect(keyEvent.defaultPrevented).toBe(false);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(pane.scrollTop).toBe(40);
  });

  test.each([
    ["Home", 160, 0],
    ["End", 160, 400],
  ])(
    "handles %s from the focused pane",
    (key, initialPaneTop, expectedPaneTop) => {
      vi.stubGlobal("innerWidth", 1440);
      const { getByTestId } = render(
        <LockedScreenLayout topContent={<div>Find jobs</div>}>
          <div
            data-locked-pane-scroll-region
            data-testid="left-pane"
            tabIndex={0}
          >
            Search filters
          </div>
        </LockedScreenLayout>,
      );
      const pane = getByTestId("left-pane");
      Object.defineProperties(pane, {
        clientHeight: { configurable: true, value: 100 },
        scrollHeight: { configurable: true, value: 500 },
      });
      pane.scrollTop = initialPaneTop;
      pane.focus();

      const keyEvent = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
      });
      pane.dispatchEvent(keyEvent);

      expect(keyEvent.defaultPrevented).toBe(true);
      expect(pane.scrollTop).toBe(expectedPaneTop);
    },
  );

  test("leaves focused-pane keyboard scrolling native in compact layouts", () => {
    vi.stubGlobal("innerWidth", 1024);
    const { getByTestId } = render(
      <LockedScreenLayout topContent={<div>Find jobs</div>}>
        <div
          data-locked-pane-scroll-region
          data-testid="left-pane"
          tabIndex={0}
        >
          Search filters
        </div>
      </LockedScreenLayout>,
    );
    const pane = getByTestId("left-pane");
    Object.defineProperties(pane, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });
    pane.scrollTop = 40;
    pane.focus();

    const keyEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "PageDown",
    });
    pane.dispatchEvent(keyEvent);

    expect(keyEvent.defaultPrevented).toBe(false);
    expect(pane.scrollTop).toBe(40);
  });
});

describe("LockedScreenLayout inner scroller ownership", () => {
  beforeEach(() => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
      unobserve() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubHeaderGeometry(height: number) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: height,
      height,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  }

  function stubScrollMetrics(
    element: Element,
    metrics: { clientHeight: number; scrollHeight: number },
  ) {
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: metrics.clientHeight },
      scrollHeight: { configurable: true, value: metrics.scrollHeight },
    });
  }

  function dispatchWheel(target: Element, init?: WheelEventInit) {
    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(wheelEvent);
    return wheelEvent;
  }

  function renderKanbanBoard() {
    return render(
      <LockedScreenLayout topContent={<div>Find jobs</div>}>
        <div data-locked-pane-scroll-region data-testid="board-pane">
          <div data-testid="column-list" style={{ overflowY: "auto" }}>
            <span data-testid="kanban-card">Phone screen</span>
          </div>
        </div>
      </LockedScreenLayout>,
    );
  }

  function renderNestedBoard() {
    return render(
      <LockedScreenLayout topContent={<div>Find jobs</div>}>
        <div data-locked-pane-scroll-region data-testid="board-pane">
          <div data-testid="column-list" style={{ overflowY: "auto" }}>
            <div data-testid="result-card">
              <div data-testid="card-details" style={{ overflowY: "auto" }}>
                <span data-testid="detail-line">Led migration</span>
              </div>
            </div>
          </div>
        </div>
      </LockedScreenLayout>,
    );
  }

  // F91 contract: the browser owns the wheel while ANY scroller under the
  // pointer still has range in that direction. Native chaining walks the same
  // deepest-first order this layout used to walk by hand, on the compositor,
  // with real momentum — so the layout stays out of the way entirely.
  test("leaves an inner scroller with range to the browser", () => {
    vi.stubGlobal("innerWidth", 1440);
    stubHeaderGeometry(200);
    const { container, getByTestId } = renderKanbanBoard();

    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const boardPane = getByTestId("board-pane");
    const columnList = getByTestId("column-list");
    stubOuterScrollRange(outerScroller, 200);
    if (outerScroller) {
      outerScroller.scrollTop = 200;
    }
    stubScrollMetrics(boardPane, {
      clientHeight: 400,
      scrollHeight: 1_200,
    });
    stubScrollMetrics(columnList, {
      clientHeight: 300,
      scrollHeight: 900,
    });
    boardPane.scrollTop = 30;
    columnList.scrollTop = 50;

    const wheelEvent = dispatchWheel(getByTestId("kanban-card"), {
      deltaY: 80,
    });

    expect(wheelEvent.defaultPrevented).toBe(false);
    expect(columnList.scrollTop).toBe(50);
    expect(boardPane.scrollTop).toBe(30);
    expect(outerScroller?.scrollTop).toBe(200);
  });

  test("leaves an exhausted inner scroller to native chaining while its pane has range", () => {
    vi.stubGlobal("innerWidth", 1440);
    stubHeaderGeometry(200);
    const { container, getByTestId } = render(
      <LockedScreenLayout topContent={<div>Find jobs</div>}>
        <div data-locked-pane-scroll-region data-testid="cv-pane">
          <pre data-testid="cv-preview" style={{ overflowY: "auto" }}>
            Senior frontend engineer with ten years of experience.
          </pre>
        </div>
      </LockedScreenLayout>,
    );

    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const cvPane = getByTestId("cv-pane");
    const cvPreview = getByTestId("cv-preview");
    stubOuterScrollRange(outerScroller, 200);
    if (outerScroller) {
      outerScroller.scrollTop = 200;
    }
    stubScrollMetrics(cvPane, { clientHeight: 600, scrollHeight: 3_000 });
    stubScrollMetrics(cvPreview, { clientHeight: 500, scrollHeight: 2_500 });

    // Preview is at its end, but its marked pane is not: still native.
    cvPane.scrollTop = 100;
    cvPreview.scrollTop = 2_000;

    const bottomEvent = dispatchWheel(cvPreview, { deltaY: 90 });

    expect(bottomEvent.defaultPrevented).toBe(false);
    expect(cvPreview.scrollTop).toBe(2_000);
    expect(cvPane.scrollTop).toBe(100);
    expect(outerScroller?.scrollTop).toBe(200);

    // Preview at its top with an upward delta, pane still above zero: native.
    cvPane.scrollTop = 100;
    cvPreview.scrollTop = 0;

    const topEvent = dispatchWheel(cvPreview, { deltaY: -90 });

    expect(topEvent.defaultPrevented).toBe(false);
    expect(cvPreview.scrollTop).toBe(0);
    expect(cvPane.scrollTop).toBe(100);
    expect(outerScroller?.scrollTop).toBe(200);
  });

  test("leaves a maxed deepest scroller to native chaining while an ancestor has range", () => {
    vi.stubGlobal("innerWidth", 1440);
    stubHeaderGeometry(200);
    const { container, getByTestId } = renderNestedBoard();

    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const boardPane = getByTestId("board-pane");
    const columnList = getByTestId("column-list");
    const cardDetails = getByTestId("card-details");
    stubOuterScrollRange(outerScroller, 200);
    if (outerScroller) {
      outerScroller.scrollTop = 200;
    }
    stubScrollMetrics(boardPane, { clientHeight: 400, scrollHeight: 1_600 });
    stubScrollMetrics(columnList, { clientHeight: 300, scrollHeight: 900 });
    stubScrollMetrics(cardDetails, { clientHeight: 200, scrollHeight: 800 });
    boardPane.scrollTop = 50;
    columnList.scrollTop = 100;
    cardDetails.scrollTop = 600;

    const detailEvent = dispatchWheel(getByTestId("detail-line"), {
      deltaY: 80,
    });

    expect(detailEvent.defaultPrevented).toBe(false);
    expect(cardDetails.scrollTop).toBe(600);
    expect(columnList.scrollTop).toBe(100);
    expect(boardPane.scrollTop).toBe(50);
    expect(outerScroller?.scrollTop).toBe(200);

    // Two of three exhausted; the marked pane still has range, still native.
    columnList.scrollTop = 600;
    const columnEvent = dispatchWheel(getByTestId("detail-line"), {
      deltaY: 80,
    });

    expect(columnEvent.defaultPrevented).toBe(false);
    expect(boardPane.scrollTop).toBe(50);
    expect(outerScroller?.scrollTop).toBe(200);
  });

  test("hands the wheel to the page header only when the whole chain is exhausted", () => {
    vi.stubGlobal("innerWidth", 1440);
    stubHeaderGeometry(200);
    const { container, getByTestId } = renderNestedBoard();

    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const boardPane = getByTestId("board-pane");
    const columnList = getByTestId("column-list");
    const cardDetails = getByTestId("card-details");
    stubOuterScrollRange(outerScroller, 200);
    stubScrollMetrics(boardPane, { clientHeight: 400, scrollHeight: 1_600 });
    stubScrollMetrics(columnList, { clientHeight: 300, scrollHeight: 900 });
    stubScrollMetrics(cardDetails, { clientHeight: 200, scrollHeight: 800 });

    boardPane.scrollTop = 0;
    columnList.scrollTop = 0;
    cardDetails.scrollTop = 0;
    if (outerScroller) {
      outerScroller.scrollTop = 200;
    }

    const headerEvent = dispatchWheel(getByTestId("detail-line"), {
      deltaY: -80,
    });

    expect(headerEvent.defaultPrevented).toBe(true);
    expect(cardDetails.scrollTop).toBe(0);
    expect(columnList.scrollTop).toBe(0);
    expect(boardPane.scrollTop).toBe(0);
    expect(outerScroller?.scrollTop).toBe(120);
  });

  test("leaves a fractional momentum burst entirely to the browser", () => {
    vi.stubGlobal("innerWidth", 1440);
    stubHeaderGeometry(200);
    const { container, getByTestId } = renderKanbanBoard();

    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const boardPane = getByTestId("board-pane");
    const columnList = getByTestId("column-list");
    stubOuterScrollRange(outerScroller, 200);
    if (outerScroller) {
      outerScroller.scrollTop = 200;
    }
    stubScrollMetrics(boardPane, { clientHeight: 400, scrollHeight: 1_200 });
    stubScrollMetrics(columnList, { clientHeight: 300, scrollHeight: 900 });
    boardPane.scrollTop = 20;
    columnList.scrollTop = 480;

    for (const deltaY of [55.5, 42.25, 48.75, -12.5]) {
      const burst = dispatchWheel(getByTestId("kanban-card"), { deltaY });
      expect(burst.defaultPrevented).toBe(false);
    }

    expect(columnList.scrollTop).toBe(480);
    expect(boardPane.scrollTop).toBe(20);
    expect(outerScroller?.scrollTop).toBe(200);
  });

  test.each([
    ["line", WheelEvent.DOM_DELTA_LINE, 2, 32],
    ["page", WheelEvent.DOM_DELTA_PAGE, 1, 300],
  ])(
    "normalizes %s-mode deltas at a true chain boundary",
    (_mode, deltaMode, deltaY, expectedOuterTop) => {
      vi.stubGlobal("innerWidth", 1440);
      stubHeaderGeometry(400);
      const { container, getByTestId } = renderKanbanBoard();

      const outerScroller = container.querySelector<HTMLElement>(
        ".screen-scroll-area",
      );
      const boardPane = getByTestId("board-pane");
      const columnList = getByTestId("column-list");
      stubOuterScrollRange(outerScroller, 400);
      stubScrollMetrics(boardPane, { clientHeight: 400, scrollHeight: 1_200 });
      stubScrollMetrics(columnList, { clientHeight: 300, scrollHeight: 900 });
      // Whole chain at its end, so the header is the only remaining owner and
      // deltaMode normalization is the layout's job again.
      boardPane.scrollTop = 800;
      columnList.scrollTop = 600;

      const wheelEvent = dispatchWheel(getByTestId("kanban-card"), {
        deltaMode,
        deltaY,
      });

      expect(wheelEvent.defaultPrevented).toBe(true);
      expect(outerScroller?.scrollTop).toBe(expectedOuterTop);
      expect(columnList.scrollTop).toBe(600);
      expect(boardPane.scrollTop).toBe(800);
    },
  );

  test.each([
    ["control", { ctrlKey: true }],
    ["command", { metaKey: true }],
  ])(
    "does not intercept %s-wheel zoom over an inner scroller",
    (_label, modifier) => {
      vi.stubGlobal("innerWidth", 1440);
      stubHeaderGeometry(200);
      const { container, getByTestId } = renderKanbanBoard();

      const outerScroller = container.querySelector<HTMLElement>(
        ".screen-scroll-area",
      );
      const boardPane = getByTestId("board-pane");
      const columnList = getByTestId("column-list");
      stubScrollMetrics(boardPane, {
        clientHeight: 400,
        scrollHeight: 1_200,
      });
      stubScrollMetrics(columnList, {
        clientHeight: 300,
        scrollHeight: 900,
      });
      boardPane.scrollTop = 30;
      columnList.scrollTop = 50;

      const wheelEvent = dispatchWheel(getByTestId("kanban-card"), {
        deltaY: 80,
        ...modifier,
      });

      expect(wheelEvent.defaultPrevented).toBe(false);
      expect(columnList.scrollTop).toBe(50);
      expect(boardPane.scrollTop).toBe(30);
      expect(outerScroller?.scrollTop).toBe(0);
    },
  );

  test("leaves inner scrollers to native scrolling below the breakpoint", () => {
    vi.stubGlobal("innerWidth", 1024);
    const { getByTestId } = renderKanbanBoard();

    const boardPane = getByTestId("board-pane");
    const columnList = getByTestId("column-list");
    stubScrollMetrics(boardPane, {
      clientHeight: 400,
      scrollHeight: 1_200,
    });
    stubScrollMetrics(columnList, {
      clientHeight: 300,
      scrollHeight: 900,
    });
    boardPane.scrollTop = 30;
    columnList.scrollTop = 50;

    const wheelEvent = dispatchWheel(getByTestId("kanban-card"), {
      deltaY: 80,
    });

    expect(wheelEvent.defaultPrevented).toBe(false);
    expect(columnList.scrollTop).toBe(50);
    expect(boardPane.scrollTop).toBe(30);
  });

  test.each([
    ["textarea", "cover-note"],
    ["select", "locale-picker"],
  ])(
    "leaves %s wheel input with the browser inside a marked pane",
    (_label, controlTestId) => {
      vi.stubGlobal("innerWidth", 1440);
      stubHeaderGeometry(200);
      const { container, getByTestId } = render(
        <LockedScreenLayout topContent={<div>Find jobs</div>}>
          <div data-locked-pane-scroll-region data-testid="notes-pane">
            {controlTestId === "cover-note" ? (
              <textarea data-testid="cover-note" readOnly />
            ) : (
              <select data-testid="locale-picker" />
            )}
          </div>
        </LockedScreenLayout>,
      );

      const outerScroller = container.querySelector<HTMLElement>(
        ".screen-scroll-area",
      );
      const notesPane = getByTestId("notes-pane");
      stubScrollMetrics(notesPane, {
        clientHeight: 300,
        scrollHeight: 1_500,
      });
      notesPane.scrollTop = 60;

      const controlEvent = dispatchWheel(getByTestId(controlTestId), {
        deltaY: 80,
      });

      expect(controlEvent.defaultPrevented).toBe(false);
      expect(notesPane.scrollTop).toBe(60);
      expect(outerScroller?.scrollTop).toBe(0);
    },
  );
});

describe("LockedScreenLayout sticky bottom chrome", () => {
  beforeEach(() => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
      unobserve() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("pins bottom content outside the scroll area", () => {
    const { container, getByRole } = render(
      <LockedScreenLayout
        bottomContent={<button type="button">Save and continue</button>}
        topContent={<div>Guided setup</div>}
      >
        <p>Long step fields</p>
      </LockedScreenLayout>,
    );

    const outerScroller = container.querySelector<HTMLElement>(
      ".screen-scroll-area",
    );
    const bottom = container.querySelector(
      "[data-locked-screen-bottom-content]",
    );
    const continueButton = getByRole("button", { name: "Save and continue" });

    expect(bottom).toBeTruthy();
    expect(outerScroller?.contains(continueButton)).toBe(false);
    expect(bottom?.contains(continueButton)).toBe(true);
  });

  test("keeps short routes free of a synthetic blank scroll range", () => {
    let observerCallback: ResizeObserverCallback | null = null;
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        observerCallback = callback;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);

    let measuredHeight = 120.1;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          bottom: measuredHeight,
          height: measuredHeight,
          left: 0,
          right: 100,
          top: 0,
          width: 100,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );

    const { container } = render(
      <LockedScreenLayout
        bottomContent={<button type="button">Save and continue</button>}
        topContent={<div>Guided setup</div>}
      >
        <p>Long step fields</p>
      </LockedScreenLayout>,
    );

    const layoutGrid = () =>
      container.querySelector<HTMLElement>(".screen-scroll-area > .grid");
    expect(layoutGrid()?.style.height).toBe("");

    measuredHeight = 120.4;
    act(() => {
      observerCallback?.([], {} as ResizeObserver);
    });
    // Header measurement must not add a second scroll range, regardless of
    // sub-pixel ResizeObserver chatter.
    expect(layoutGrid()?.style.height).toBe("");

    measuredHeight = 140;
    act(() => {
      observerCallback?.([], {} as ResizeObserver);
    });
    expect(layoutGrid()?.style.height).toBe("");
  });

  test("leaves End at the natural outer boundary on a short route", () => {
    vi.stubGlobal("innerWidth", 1440);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 120,
      height: 120,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const { container, getByTestId } = render(
      <LockedScreenLayout
        bottomContent={<button type="button">Save and continue</button>}
        topContent={<div>Guided setup</div>}
      >
        <div data-testid="short-route-body" tabIndex={0}>
          Short setup step
        </div>
      </LockedScreenLayout>,
    );
    const outerScroller = container.querySelector<HTMLElement>(
      "[data-locked-screen-scroll-area]",
    );
    if (!outerScroller) {
      throw new Error("Expected the locked route scroll owner.");
    }
    Object.defineProperties(outerScroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 100 },
    });

    const endEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "End",
    });
    getByTestId("short-route-body").dispatchEvent(endEvent);

    expect(endEvent.defaultPrevented).toBe(false);
    expect(outerScroller.scrollTop).toBe(0);
  });
});
