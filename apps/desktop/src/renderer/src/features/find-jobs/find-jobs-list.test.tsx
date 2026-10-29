// @vitest-environment jsdom

import type { JobRow } from "@nestor/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  ListPane,
  NO_SELECTION,
  toggleSelection,
  useListKeys,
  type ListSelection,
} from "@renderer/features/job-lists";

import type * as JobFormat from "@renderer/features/job-lists/job-format";

import { FindJobsRow } from "./find-jobs-list";

// Every FindJobsRow render describes its fit once: count them.
const renders = vi.hoisted(() => ({ count: 0 }));
vi.mock("@renderer/features/job-lists/job-format", async (importOriginal) => {
  const actual = await importOriginal<typeof JobFormat>();
  return {
    ...actual,
    describeFit: (...args: Parameters<typeof actual.describeFit>) => {
      renders.count += 1;
      return actual.describeFit(...args);
    },
  };
});

function row(id: number): JobRow {
  return {
    id,
    stage: "found",
    stageChangedAt: "2026-10-27T00:00:00.000Z",
    stageNote: null,
    title: `Designer ${id}`,
    company: "Acme",
    location: "Remote",
    workModes: ["remote"],
    salaryText: null,
    fitScore: 70,
    fitSummary: "Close to the brief",
    postedAt: null,
    foundAt: "2026-10-27T00:00:00.000Z",
    searchId: null,
    sourceLabel: "Board",
    sourceCount: 1,
  };
}

/** The Find jobs list as the screen wires it: stable handlers, J/K keys. */
function FoundJobs(props: { rows: readonly JobRow[] }) {
  const [activeId, setActiveId] = useState<number | null>(
    props.rows[0]?.id ?? null,
  );
  const [selection, setSelection] = useState<ListSelection>(NO_SELECTION);
  const activate = useCallback((id: number) => setActiveId(id), []);
  const toggle = useCallback(
    (id: number, shiftKey: boolean) =>
      setSelection((current) =>
        toggleSelection(current, id, shiftKey, props.rows),
      ),
    [props.rows],
  );
  useListKeys({
    rows: props.rows,
    activeId,
    setActiveId,
    toggle,
    selectAll: () => undefined,
    clearSelection: () => setSelection(NO_SELECTION),
  });
  return (
    <ListPane
      activeId={activeId}
      empty={null}
      hasMore={false}
      label="Found jobs"
      loading={false}
      onClearSelection={() => setSelection(NO_SELECTION)}
      onLoadMore={() => undefined}
      onSelectAll={() => undefined}
      renderRow={(job, state) => (
        <FindJobsRow
          {...state}
          onActivate={activate}
          onToggle={toggle}
          row={job}
        />
      )}
      rows={props.rows}
      selectedCount={selection.ids.size}
      selection={selection}
      total={props.rows.length}
      totalCapped={false}
      windowed
    />
  );
}

/** The list's scroll box is this tall; jsdom lays nothing out. */
const VIEW_HEIGHT = 640;

beforeEach(() => {
  renders.count = 0;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-locked-pane-scroll-region")
        ? VIEW_HEIGHT
        : 0;
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const items = () => document.querySelectorAll("li");
const rowNamed = (title: string) =>
  screen.getByRole("checkbox", { name: `Select ${title}` }).closest("li")!;

it("draws only the rows in view of 2,000, and a J press re-renders at most two", () => {
  const rows = Array.from({ length: 2000 }, (_, i) => row(i + 1));
  render(<FoundJobs rows={rows} />);
  expect(items().length).toBeGreaterThan(0);
  expect(items().length).toBeLessThan(40);
  const list = screen.getByRole("list", { name: "Found jobs" });
  // The list keeps its full height, so the scrollbar is the whole list's.
  expect(list.style.height).toBe(`${2000 * 92}px`);
  expect(rowNamed("Designer 1").getAttribute("aria-setsize")).toBe("2000");
  expect(rowNamed("Designer 1").getAttribute("aria-posinset")).toBe("1");

  renders.count = 0;
  act(() => {
    fireEvent.keyDown(window, { key: "j" });
  });
  expect(renders.count).toBeLessThanOrEqual(2);
  expect(items().length).toBeLessThan(40);
  expect(
    rowNamed("Designer 2")
      .querySelector("[aria-controls]")
      ?.getAttribute("tabindex"),
  ).toBe("0");

  // Ticking one row re-renders that row alone.
  renders.count = 0;
  act(() => {
    fireEvent.keyDown(window, { key: "x" });
  });
  expect(renders.count).toBe(1);
});

it("keeps the open row drawn when the person scrolls far from it", () => {
  const rows = Array.from({ length: 2000 }, (_, i) => row(i + 1));
  render(<FoundJobs rows={rows} />);
  const scroller = document.querySelector<HTMLElement>(
    "[data-locked-pane-scroll-region]",
  )!;
  act(() => {
    scroller.scrollTop = 1500 * 92;
    fireEvent.scroll(scroller);
  });
  expect(screen.getByText("Designer 1500")).toBeTruthy();
  expect(rowNamed("Designer 1").getAttribute("aria-posinset")).toBe("1");
  expect(items().length).toBeLessThan(40);
});

it("lays mixed-height rows out at the tallest, so none overlaps the next", () => {
  // A row with an empty line was shorter. The height used to come from the
  // first drawn row, here the short open row, so every taller row spilled
  // into the next one. While scrolling it also flipped between heights and
  // moved the window each time, until React stopped (error #185).
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      const id = Number(this.getAttribute("data-list-row-id"));
      return id > 0 ? (id % 2 ? 98 : 100) : 0;
    },
  );
  const rows = Array.from({ length: 2000 }, (_, i) => row(i + 1));
  render(<FoundJobs rows={rows} />);
  const scroller = document.querySelector<HTMLElement>(
    "[data-locked-pane-scroll-region]",
  )!;
  for (const top of [5000, 5098, 12000, 12345, 30000]) {
    act(() => {
      scroller.scrollTop = top;
      fireEvent.scroll(scroller);
    });
  }
  const list = screen.getByRole("list", { name: "Found jobs" });
  expect(list.style.height).toBe(`${2000 * 100}px`);
  expect(items().length).toBeLessThan(40);
});
