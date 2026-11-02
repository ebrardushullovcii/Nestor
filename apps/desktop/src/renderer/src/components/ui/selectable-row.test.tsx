// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  SelectableRow,
  SelectableRowLine,
  boxMetricSignature,
} from "./selectable-row";

/**
 * F89: selecting a row must never change the row's own box or move any other
 * row. The regression this pins is that the selected row grew into a bordered,
 * padded, raised card while its neighbours stayed flat, and the badge and
 * status lines were rendered only when selected - so moving the selection down
 * one row shifted everything below it by tens of pixels.
 */
describe("SelectableRow", () => {
  const globalScope = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const originalActEnvironment = globalScope.IS_REACT_ACT_ENVIRONMENT;
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeAll(() => {
    globalScope.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    if (originalActEnvironment === undefined) {
      delete globalScope.IS_REACT_ACT_ENVIRONMENT;
      return;
    }

    globalScope.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }

    root = null;
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  function render(ui: ReactElement) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(ui);
    });
  }

  function rerender(ui: ReactElement) {
    act(() => {
      root?.render(ui);
    });
  }

  function row(): HTMLElement {
    const element = container?.querySelector<HTMLElement>(
      '[data-slot="selectable-row"]',
    );

    if (!element) {
      throw new Error("selectable row not rendered");
    }

    return element;
  }

  /** Every class that could change the rendered box. */
  const BOX_METRICS =
    /^-?(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|border|border-[xytrbl]|w|h|min-w|min-h|max-w|max-h|size|text|leading|tracking)(?:-|$)/;

  function boxClasses(element: HTMLElement): string[] {
    return [...element.classList]
      .filter((token) => BOX_METRICS.test(token))
      .sort();
  }

  it("renders identical box metrics selected and unselected", () => {
    render(<SelectableRow selected={false}>Row</SelectableRow>);
    const unselected = boxClasses(row());

    rerender(<SelectableRow selected>Row</SelectableRow>);
    const selected = boxClasses(row());

    expect(selected).toEqual(unselected);
  });

  it("declares no conditional padding, margin or border-width class", () => {
    render(<SelectableRow selected={false}>Row</SelectableRow>);
    const unselected = row().className;

    rerender(<SelectableRow selected>Row</SelectableRow>);
    const selected = row().className;

    // The only permitted difference between the two states is a class that
    // paints - never one that measures.
    const difference = [
      ...new Set([
        ...selected.split(/\s+/).filter((token) => !unselected.includes(token)),
        ...unselected.split(/\s+/).filter((token) => !selected.includes(token)),
      ]),
    ].filter((token) => token.length > 0);

    expect(difference.filter((token) => BOX_METRICS.test(token))).toEqual([]);
  });

  it("signals selection with a tint and an inset bar, never an outset one", () => {
    render(<SelectableRow selected>Row</SelectableRow>);

    const className = row().className;

    expect(className).toContain("data-[selected=true]:bg-(--surface-strong)");
    // `inset` keeps the accent bar inside the border box so it adds no width.
    expect(className).toContain("data-[selected=true]:selected-bar");
    expect(className).not.toMatch(/data-\[selected=true\]:(p|m|border|gap)-/);
  });

  it("exposes selection to assistive technology", () => {
    render(<SelectableRow selected>Row</SelectableRow>);

    expect(row().getAttribute("aria-current")).toBe("true");
    expect(row().getAttribute("data-selected")).toBe("true");

    rerender(<SelectableRow selected={false}>Row</SelectableRow>);

    expect(row().getAttribute("aria-current")).toBeNull();
    expect(row().getAttribute("data-selected")).toBe("false");
  });

  it("defaults to a non-submitting button and forwards list identity", () => {
    render(
      <SelectableRow selected={false} data-collection-item-id="job-1">
        Row
      </SelectableRow>,
    );

    expect(row().tagName).toBe("BUTTON");
    expect(row().getAttribute("type")).toBe("button");
    expect(row().getAttribute("data-collection-item-id")).toBe("job-1");
  });

  it("reserves a content line's slot when it has nothing to show", () => {
    render(
      <SelectableRow selected={false}>
        <SelectableRowLine>{null}</SelectableRowLine>
      </SelectableRow>,
    );

    const line = container?.querySelector<HTMLElement>(
      '[data-slot="selectable-row-line"]',
    );

    expect(line?.getAttribute("data-empty")).toBe("true");
    // A reserved line keeps its height class and a zero-width space, so an
    // absent badge cannot shorten the row. The reserved height is one line of
    // the line's OWN type rather than a flat 1rem, so a line rendering larger
    // or smaller text reserves the slot it will actually occupy.
    expect(line?.className).toContain("min-h-[1lh]");
    expect(line?.textContent).toBe("​");
  });

  it.each([
    ["an empty string", ""],
    ["a whitespace-only string", "   "],
  ])("treats %s as an empty content line", (_label, value) => {
    // A formatter that returns "" renders as nothing, so without this the row
    // reported data-empty="false", skipped the zero-width space and lost the
    // reserved height - reflowing every row below it on selection.
    render(
      <SelectableRow selected={false}>
        <SelectableRowLine>{value}</SelectableRowLine>
      </SelectableRow>,
    );

    const line = container?.querySelector<HTMLElement>(
      '[data-slot="selectable-row-line"]',
    );

    expect(line?.getAttribute("data-empty")).toBe("true");
    expect(line?.textContent).toBe("​");
  });

  it("reports an adopter that changes box metrics with selection", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <SelectableRow className="py-3" selected={false}>
        Row
      </SelectableRow>,
    );
    rerender(
      <SelectableRow className="py-6 border-2" selected>
        Row
      </SelectableRow>,
    );

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("box metrics changed with selection"),
    );
  });

  it("stays quiet when only paint classes change with selection", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <SelectableRow className="opacity-80" selected={false}>
        Row
      </SelectableRow>,
    );
    rerender(
      <SelectableRow className="opacity-100" selected>
        Row
      </SelectableRow>,
    );

    expect(error).not.toHaveBeenCalled();
  });

  it("classifies box-metric tokens and ignores paint tokens", () => {
    expect(boxMetricSignature("py-3 bg-red-500 border w-full")).toBe(
      "border py-3 w-full",
    );
    expect(boxMetricSignature("opacity-50 shadow-lg")).toBe("");
    expect(boxMetricSignature(undefined)).toBe("");
  });
});
