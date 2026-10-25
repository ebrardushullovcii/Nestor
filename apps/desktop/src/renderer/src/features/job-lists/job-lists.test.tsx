// @vitest-environment jsdom

import type { DesktopJobsBridge, FoundJob } from "@nestor/contracts";
import { openJobStore, type JobStore } from "@nestor/db/job-store";
import { createJobCommandRunner } from "@nestor/job-finder/job-commands";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ListPane,
  ListRowFrame,
  NO_SELECTION,
  countSelected,
  selectAll,
  toSelectionInput,
  toggleSelection,
  useJobList,
  type ListSelection,
} from "./index";

let store: JobStore;

function found(n: number): FoundJob {
  return {
    title: `Designer ${n}`,
    company: "Acme",
    location: "Remote",
    workModes: ["remote"],
    url: `https://jobs.example.test/${n}`,
    applyUrl: null,
    sourceId: "board",
    sourceLabel: "Board",
    sourceJobId: String(n),
    postedAt: null,
    salaryText: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    seniority: null,
    employmentType: null,
    summary: null,
    description: `Listing ${n}`,
  };
}

/** The real commands and change events over an in-memory store. */
function installBridge(): void {
  const run = createJobCommandRunner({ store });
  const bridge: DesktopJobsBridge = {
    run: (name, input) => run(name, input),
    onChange: (listener) => store.onChange(listener),
    onSearchStatus: () => () => undefined,
  };
  Object.assign(window, { nestor: { jobs: bridge } });
}

function FoundList() {
  const list = useJobList({ stage: "found", sort: "newest" });
  const [selection, setSelection] = useState<ListSelection>(NO_SELECTION);
  return (
    <>
      <button
        onClick={() => {
          const input = toSelectionInput(selection, { stage: "found" });
          if (input)
            void window.nestor.jobs.run("move_jobs", {
              selection: input,
              to: "hidden",
            });
          setSelection(NO_SELECTION);
        }}
        type="button"
      >
        Hide selected
      </button>
      <ListPane
        activeId={null}
        empty={<p>Nothing found</p>}
        hasMore={list.nextCursor !== null}
        label="Found jobs"
        loading={list.loading}
        onClearSelection={() => setSelection(NO_SELECTION)}
        onLoadMore={() => void list.loadMore()}
        onSelectAll={() => setSelection(selectAll())}
        renderRow={(row, state) => (
          <ListRowFrame
            {...state}
            id={row.id}
            meta={row.company}
            onActivate={() => undefined}
            onToggle={(id, shift) =>
              setSelection((s) => toggleSelection(s, id, shift, list.rows))
            }
            title={row.title}
          />
        )}
        rows={list.rows}
        selectedCount={countSelected(selection, list.total)}
        selection={selection}
        total={list.total}
        totalCapped={list.totalCapped}
      />
    </>
  );
}

beforeEach(() => {
  // jsdom has no IntersectionObserver; scrolling to the end is not tested here.
  Object.assign(window, {
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  store = openJobStore(":memory:");
  installBridge();
});

afterEach(() => {
  cleanup();
  store.close();
});

describe("shared list pieces", () => {
  it("shows a stage's jobs, adds new ones as they are saved, and drops ones moved away", async () => {
    store.saveFoundJobs({ searchId: null, jobs: [found(1), found(2)] });
    render(<FoundList />);
    expect(await screen.findByText("2 jobs")).toBeTruthy();

    // A search saving more jobs refreshes the list through jobs:changed.
    store.saveFoundJobs({ searchId: null, jobs: [found(3)] });
    expect(await screen.findByText("Designer 3")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Designer 1" }),
    );
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide selected" }));
    await waitFor(() => expect(screen.queryByText("Designer 1")).toBeNull());
    expect(store.stageCounts()).toMatchObject({ found: 2, hidden: 1 });
  });

  it("selects every job in the list, not just the loaded page", async () => {
    store.saveFoundJobs({
      searchId: null,
      jobs: Array.from({ length: 60 }, (_, i) => found(i + 1)),
    });
    render(<FoundList />);
    expect(await screen.findByText("60 jobs")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(50);

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all 60 jobs" }),
    );
    expect(screen.getByText("60 selected")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Designer 60" }),
    );
    expect(screen.getByText("59 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide selected" }));
    await waitFor(() =>
      expect(store.stageCounts()).toMatchObject({ found: 1, hidden: 59 }),
    );
    expect(await screen.findByText("1 job")).toBeTruthy();
  });
});
