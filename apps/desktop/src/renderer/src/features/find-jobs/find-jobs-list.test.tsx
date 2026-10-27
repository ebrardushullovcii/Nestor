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
    />
  );
}

beforeEach(() => {
  renders.count = 0;
  Element.prototype.scrollIntoView = () => undefined;
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
  vi.unstubAllGlobals();
});

it("re-renders only the row a J press leaves and the one it opens, with 300 rows loaded", () => {
  const rows = Array.from({ length: 300 }, (_, i) => row(i + 1));
  render(<FoundJobs rows={rows} />);
  expect(renders.count).toBeGreaterThanOrEqual(1);

  renders.count = 0;
  act(() => {
    fireEvent.keyDown(window, { key: "j" });
  });
  expect(renders.count).toBeLessThanOrEqual(2);
  expect(
    screen
      .getByRole("checkbox", { name: "Select Designer 2" })
      .closest("li")
      ?.querySelector("[aria-controls]")
      ?.getAttribute("tabindex"),
  ).toBe("0");

  // Ticking one row re-renders that row alone.
  renders.count = 0;
  act(() => {
    fireEvent.keyDown(window, { key: "x" });
  });
  expect(renders.count).toBe(1);
});
