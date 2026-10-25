// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  ToastProvider,
  useDismissToastsOnScreenChange,
  useToast,
} from "./toast";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function Trigger() {
  const { showToast } = useToast();
  return (
    <button
      onClick={() =>
        showToast({
          title: "Jobs hidden",
          action: { label: "Undo", onClick: vi.fn() },
        })
      }
    >
      Hide jobs
    </button>
  );
}
it("keeps bulk Undo available for twenty seconds and holds it on hover", async () => {
  vi.useFakeTimers();
  render(
    <ToastProvider>
      <Trigger />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByText("Hide jobs"));
  await act(() => vi.advanceTimersByTime(6000));
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  fireEvent.mouseEnter(screen.getByRole("status"));
  await act(() => vi.advanceTimersByTime(20000));
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  fireEvent.mouseLeave(screen.getByRole("status"));
  await act(() => vi.advanceTimersByTime(20000));
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

function ScreenToasts({ screenKey }: { screenKey: string }) {
  const { showToast } = useToast();
  useDismissToastsOnScreenChange(screenKey);
  return (
    <>
      <button
        onClick={() =>
          showToast({
            title: "3 jobs added to Shortlisted.",
            action: { label: "Open Shortlisted", onClick: vi.fn() },
          })
        }
      >
        Screen news
      </button>
      <button
        onClick={() => showToast({ title: "Search finished", scope: "app" })}
      >
        App news
      </button>
    </>
  );
}

it("drops a screen's toast when the person moves to another screen", async () => {
  vi.useFakeTimers();
  const view = render(
    <ToastProvider>
      <ScreenToasts screenKey="/job-finder/discovery" />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByText("Screen news"));
  fireEvent.click(screen.getByText("App news"));
  await act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByText("3 jobs added to Shortlisted.")).toBeTruthy();

  view.rerender(
    <ToastProvider>
      <ScreenToasts screenKey="/job-finder/review-queue" />
    </ToastProvider>,
  );

  // The shortlist news stayed on Find jobs; app-wide news stays.
  expect(screen.queryByText("3 jobs added to Shortlisted.")).toBeNull();
  expect(screen.getByText("Search finished")).toBeTruthy();
});

it("keeps a toast raised by the press that changed screen", () => {
  const view = render(
    <ToastProvider>
      <ScreenToasts screenKey="/job-finder/discovery" />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByText("Screen news"));
  view.rerender(
    <ToastProvider>
      <ScreenToasts screenKey="/job-finder/review-queue" />
    </ToastProvider>,
  );
  expect(screen.getByText("3 jobs added to Shortlisted.")).toBeTruthy();
});

function mockLayout({
  stackHeight = 112,
  pagerTop,
  sidebarRight = 272,
}: { stackHeight?: number; pagerTop?: number; sidebarRight?: number } = {}) {
  vi.stubGlobal("innerHeight", 900);
  const rect = (left: number, top: number, width: number, height: number) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  });
  let railRight = sidebarRight;
  let measuredStackHeight = stackHeight;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.hasAttribute("data-toast-viewport"))
        return rect(
          parseFloat(this.style.left) || 16,
          0,
          360,
          measuredStackHeight,
        );
      if (this.hasAttribute("data-job-finder-sidebar"))
        return rect(0, 56, railRight, 844);
      if (this.hasAttribute("data-toast-avoid")) return rect(288, 780, 600, 44);
      if (this.hasAttribute("data-collection-pagination"))
        return rect(288, pagerTop ?? 856, 600, 44);
      if (this.hasAttribute("data-job-results-pagination"))
        return rect(288, pagerTop ?? 856, 600, 44);
      if (this.hasAttribute("data-locked-pane-scroll-region"))
        return rect(
          this.dataset.rightPane ? 900 : 288,
          200,
          600,
          // A list that ends above its pager stops 60px short of the route.
          this.hasAttribute("data-ends-above-pager") ? 640 : 700,
        );
      if (this.hasAttribute("data-locked-screen-scroll-area"))
        return rect(288, 130, 1100, 770);
      return rect(0, 0, 0, 0);
    },
  );
  // jsdom has no layout: scroll areas overflow unless marked data-fits, so
  // only areas that already scroll before a toast get its spacer.
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-fits") ? 0 : 2000;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-fits") ? 0 : 700;
    },
  );
  return {
    setSidebarRight: (right: number) => {
      railRight = right;
    },
    setStackHeight: (height: number) => {
      measuredStackHeight = height;
    },
  };
}

function ScrollFixture({
  pager = false,
  compact = false,
  outerFits = false,
}: {
  pager?: boolean;
  compact?: boolean;
  outerFits?: boolean;
}) {
  const paneEnd = outerFits ? { "data-ends-above-pager": "" } : {};
  return (
    <ToastProvider>
      <aside data-job-finder-sidebar />
      <main style={{ height: 770 }}>
        <Trigger />
        <div
          data-locked-screen-scroll-area
          {...(outerFits ? { "data-fits": "" } : {})}
          style={{ height: 770, overflowY: "auto" }}
        >
          <div
            data-locked-pane-scroll-region
            {...paneEnd}
            style={{
              height: 700,
              overflowY: compact ? "visible" : "auto",
              rowGap: 12,
            }}
          >
            <ul>
              <li>First job</li>
              <li>Last job</li>
            </ul>
          </div>
          <ul
            aria-label="Applications"
            data-locked-pane-scroll-region
            {...paneEnd}
            style={{ height: 700, overflowY: compact ? "visible" : "auto" }}
          >
            <li>Only application</li>
          </ul>
          <div
            data-locked-pane-scroll-region
            data-right-pane
            {...paneEnd}
            style={{ height: 700, overflowY: compact ? "visible" : "auto" }}
          >
            Right pane
          </div>
          <div data-locked-pane-scroll-region style={{ overflowY: "visible" }}>
            Natural height list
          </div>
          {pager ? <nav data-collection-pagination>251–300 of 353</nav> : null}
        </div>
      </main>
    </ToastProvider>
  );
}

it("adds trailing scroll space for the measured stack without changing page or pane height or scroll position", () => {
  mockLayout();
  const view = render(<ScrollFixture />);
  const page = view.container.querySelector("main")!;
  const owner = view.container.querySelector<HTMLElement>(
    "[data-locked-pane-scroll-region]",
  )!;
  owner.scrollTop = 50;
  const originalPageHeight = page.style.height;
  const originalPaneHeight = owner.style.height;
  fireEvent.click(screen.getByText("Hide jobs"));
  const slot = owner.lastElementChild as HTMLElement;
  expect(slot.hasAttribute("data-toast-scroll-spacer-slot")).toBe(true);
  expect(slot.style.height).toBe("0px");
  expect(slot.style.marginTop).toBe("-12px");
  const spacer = slot.querySelector<HTMLElement>("[data-toast-scroll-spacer]")!;
  expect(spacer.style.position).toBe("absolute");
  expect(spacer.style.height).toBe("136px");
  expect(owner.scrollTop).toBe(50);
  expect(page.style.height).toBe(originalPageHeight);
  expect(owner.style.height).toBe(originalPaneHeight);
  expect(
    document.documentElement.style.getPropertyValue("--toast-reserved-height"),
  ).toBe("");
  // A list uses a hidden list item, not invalid div markup; other columns and
  // natural-height content receive no spacer.
  const list = screen.getByRole("list", { name: "Applications" });
  expect(list.lastElementChild?.tagName).toBe("LI");
  expect(list.lastElementChild?.getAttribute("aria-hidden")).toBe("true");
  expect(
    view.container.querySelector(
      "[data-right-pane] [data-toast-scroll-spacer]",
    ),
  ).toBeNull();
  expect(
    screen
      .getByText("Natural height list")
      .querySelector("[data-toast-scroll-spacer]"),
  ).toBeNull();
  expect(
    view.container
      .querySelector("[data-locked-screen-scroll-area]")
      ?.lastElementChild?.hasAttribute("data-toast-scroll-spacer-slot"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(document.querySelector("[data-toast-scroll-spacer]")).toBeNull();
  expect(page.style.height).toBe(originalPageHeight);
});

it.each([112, 260])(
  "clears a Tracker pager above the window bottom with a %ipx toast stack",
  (stackHeight) => {
    mockLayout({ stackHeight, pagerTop: 780 });
    const view = render(<ScrollFixture pager />);
    fireEvent.click(screen.getByText("Hide jobs"));
    const viewport = document.querySelector<HTMLElement>(
      "[data-toast-viewport]",
    )!;
    const bottom = 128;
    expect(viewport.style.bottom).toBe(`${bottom}px`);
    const spacer = view.container.querySelector<HTMLElement>(
      "[data-toast-scroll-spacer]",
    )!;
    expect(parseFloat(spacer.style.height)).toBe(stackHeight + bottom + 8);
  },
);

it("follows the current sidebar width when the assistant collapses it", async () => {
  vi.useFakeTimers();
  const layout = mockLayout();
  render(<ScrollFixture />);
  fireEvent.click(screen.getByText("Hide jobs"));
  const viewport = document.querySelector<HTMLElement>(
    "[data-toast-viewport]",
  )!;
  expect(viewport.style.left).toBe("288px");
  layout.setSidebarRight(64);
  fireEvent(window, new Event("resize"));
  await act(() => vi.advanceTimersByTime(20));
  expect(viewport.style.left).toBe("80px");
  expect(viewport.style.width).toContain("80px");
  layout.setSidebarRight(0);
  fireEvent(window, new Event("resize"));
  await act(() => vi.advanceTimersByTime(20));
  expect(viewport.style.left).toBe("16px");
});

it("remeasures scroll clearance when the toast stack grows or text wraps", async () => {
  vi.useFakeTimers();
  const layout = mockLayout();
  const view = render(<ScrollFixture />);
  fireEvent.click(screen.getByText("Hide jobs"));
  layout.setStackHeight(300);
  fireEvent(window, new Event("resize"));
  await act(() => vi.advanceTimersByTime(20));
  expect(
    view.container.querySelector<HTMLElement>("[data-toast-scroll-spacer]")
      ?.style.height,
  ).toBe("324px");
});

it("removes old spacers safely when navigating while a toast stays visible", async () => {
  vi.useFakeTimers();
  mockLayout();
  const route = (show: boolean) => (
    <ToastProvider>
      <Trigger />
      {show ? (
        <ul
          data-locked-pane-scroll-region
          style={{ height: 700, overflowY: "auto" }}
        >
          <li>Old route</li>
        </ul>
      ) : (
        <p>New route</p>
      )}
    </ToastProvider>
  );
  const view = render(route(true));
  fireEvent.click(screen.getByText("Hide jobs"));
  expect(document.querySelector("[data-toast-scroll-spacer]")).toBeTruthy();
  view.rerender(route(false));
  await act(async () => {
    await Promise.resolve();
    vi.advanceTimersByTime(20);
  });
  expect(document.querySelector("[data-toast-scroll-spacer]")).toBeNull();
  expect(screen.getByRole("status")).toBeTruthy();
});

it("gives the outer route scroll clearance when compact lists use natural height", () => {
  mockLayout();
  const view = render(<ScrollFixture compact />);
  fireEvent.click(screen.getByText("Hide jobs"));
  const owner = view.container.querySelector(
    "[data-locked-screen-scroll-area]",
  )!;
  expect(
    owner.lastElementChild?.hasAttribute("data-toast-scroll-spacer-slot"),
  ).toBe(true);
  expect(owner.querySelectorAll("[data-toast-scroll-spacer]")).toHaveLength(1);
});

it("gives no spacer to a route area that did not scroll before the toast, so the page never shifts sideways", () => {
  mockLayout();
  render(<ScrollFixture outerFits />);
  fireEvent.click(screen.getByText("Hide jobs"));
  const outer = document.querySelector<HTMLElement>(
    "[data-locked-screen-scroll-area]",
  )!;
  // A spacer here would give the outer area a scrollbar and move the page.
  expect(
    Array.from(outer.children).some((child) =>
      child.hasAttribute("data-toast-scroll-spacer-slot"),
    ),
  ).toBe(false);
  // The list panes that scroll on their own still get room at their end.
  expect(
    document.querySelectorAll(
      "[data-locked-pane-scroll-region] > [data-toast-scroll-spacer-slot]",
    ).length,
  ).toBeGreaterThan(0);
});

it.each(["dismiss", "expire"])(
  "keeps clearance at the list end after %s until the person scrolls above it",
  async (leave) => {
    vi.useFakeTimers();
    mockLayout();
    render(<ScrollFixture />);
    fireEvent.click(screen.getByText("Hide jobs"));
    const owner = document.querySelector<HTMLElement>(
      "[data-locked-pane-scroll-region]",
    )!;
    // Natural end = 2000 - 700 - 136; the person is in the added tail.
    owner.scrollTop = 1300;
    if (leave === "dismiss")
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    else await act(() => vi.advanceTimersByTime(20000));
    expect(screen.queryByRole("status")).toBeNull();
    expect(owner.querySelector("[data-toast-scroll-spacer]")).toBeTruthy();
    expect(owner.scrollTop).toBe(1300);
    owner.scrollTop = 1164;
    fireEvent.scroll(owner);
    await act(() => vi.advanceTimersByTime(20));
    expect(owner.querySelector("[data-toast-scroll-spacer]")).toBeNull();
    expect(owner.scrollTop).toBe(1164);
  },
);

it("keeps the old range when part of the stack leaves at the list end", async () => {
  vi.useFakeTimers();
  const layout = mockLayout({ stackHeight: 300 });
  render(<ScrollFixture />);
  fireEvent.click(screen.getByText("Hide jobs"));
  fireEvent.click(screen.getByText("Hide jobs"));
  const owner = document.querySelector<HTMLElement>(
    "[data-locked-pane-scroll-region]",
  )!;
  owner.scrollTop = 1300;
  layout.setStackHeight(112);
  fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]!);
  fireEvent(window, new Event("resize"));
  await act(() => vi.advanceTimersByTime(20));
  expect(
    owner.querySelector<HTMLElement>("[data-toast-scroll-spacer]")?.style
      .height,
  ).toBe("324px");
  owner.scrollTop = 900;
  fireEvent.scroll(owner);
  await act(() => vi.advanceTimersByTime(20));
  expect(
    owner.querySelector<HTMLElement>("[data-toast-scroll-spacer]")?.style
      .height,
  ).toBe("136px");
});

it("caps a tall stack's clearance at the pane height minus one measured row", () => {
  mockLayout({ stackHeight: 800, pagerTop: 780 });
  const view = render(<ScrollFixture pager />);
  const owner = view.container.querySelector<HTMLElement>(
    "[data-locked-pane-scroll-region]",
  )!;
  Object.defineProperty(owner, "clientHeight", { value: 180 });
  const row = screen.getByText("First job");
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
    height: 48,
  } as DOMRect);
  fireEvent.click(screen.getByText("Hide jobs"));
  expect(
    owner.querySelector<HTMLElement>("[data-toast-scroll-spacer]")?.style
      .height,
  ).toBe("132px");
  expect(owner.style.height).toBe("700px");
});

it("uses a warning icon for an unsent outcome", () => {
  function Unsent() {
    const { showToast } = useToast();
    return (
      <button onClick={() => showToast({ title: "Not sent", tone: "warning" })}>
        Send
      </button>
    );
  }
  render(
    <ToastProvider>
      <Unsent />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByText("Send"));
  const toast = screen.getByRole("status");
  expect(toast.querySelector(".lucide-circle-alert")).not.toBeNull();
  expect(toast.querySelector(".lucide-circle-check-big")).toBeNull();
  expect(toast.querySelector("svg")?.getAttribute("class")).toContain(
    "warning-text",
  );
});

it("never loops when a spacer and the next measurement disagree", () => {
  mockLayout();
  // A spacer and the measurement it changes used to undo each other inside
  // one commit ("Maximum update depth exceeded"), blanking the whole app.
  // Here the scroll areas are visible on every other measuring pass only.
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getBoundingClientRect",
  )?.value as (this: HTMLElement) => DOMRect;
  let pass = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.hasAttribute("data-job-finder-sidebar")) pass += 1;
      const rect = original.call(this);
      return (this.hasAttribute("data-locked-pane-scroll-region") ||
        this.hasAttribute("data-locked-screen-scroll-area")) &&
        pass % 2 === 0
        ? { ...rect, height: 0, bottom: rect.top }
        : rect;
    },
  );
  render(<ScrollFixture />);
  expect(() => fireEvent.click(screen.getByText("Hide jobs"))).not.toThrow();
  expect(screen.getByRole("region", { name: "Notifications" })).toBeTruthy();
});

it("moves stacked toasts above plan actions without adding page padding", () => {
  mockLayout({ stackHeight: 260 });
  render(
    <>
      <div data-toast-avoid>
        <button>Run now</button>
        <button>Rules</button>
        <button>Delete plan</button>
      </div>
      <ScrollFixture />
    </>,
  );
  fireEvent.click(screen.getByText("Hide jobs"));
  expect(
    document.querySelector<HTMLElement>("[data-toast-viewport]")!.style.bottom,
  ).toBe("128px");
  expect(
    document.querySelector<HTMLElement>("[data-toast-avoid]")!.style
      .paddingBottom,
  ).toBe("");
});
