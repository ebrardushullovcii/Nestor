// @vitest-environment jsdom

import type { DesktopJobsBridge, FoundJob } from "@nestor/contracts";
import { openJobStore, type JobStore } from "@nestor/db/job-store";
import { createJobCommandRunner } from "@nestor/job-finder/job-commands";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createKeptRouteVisibility,
  KeptRouteVisibilityContext,
} from "@renderer/features/job-finder/lib/kept-route-visibility";

import { AddSites } from "./add-sites";

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

/** Every command the list ran, by name. */
let commands: string[] = [];

/** The real commands and change events over an in-memory store. */
function installBridge(): void {
  const run = createJobCommandRunner({ store });
  commands = [];
  const bridge: DesktopJobsBridge = {
    run: (name, input) => {
      commands.push(name);
      return run(name, input);
    },
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

  it("a refresh far down a long list keeps every loaded row in place", async () => {
    // Scrolling to the end of the list asks for more: capture that call.
    const atEnd: Array<() => void> = [];
    Object.assign(window, {
      IntersectionObserver: class {
        constructor(
          private readonly callback: (
            entries: Array<{ isIntersecting: boolean }>,
          ) => void,
        ) {}
        observe() {
          atEnd.push(() => this.callback([{ isIntersecting: true }]));
        }
        disconnect() {}
      },
    });
    store.saveFoundJobs({
      searchId: null,
      jobs: Array.from({ length: 260 }, (_, i) => found(i + 1)),
    });
    render(<FoundList />);
    expect(await screen.findByText("260 jobs")).toBeTruthy();
    // Scroll past 200: five pages of fifty.
    for (let loaded = 50; loaded < 250; loaded += 50) {
      atEnd.at(-1)!();
      await waitFor(() =>
        expect(screen.getAllByRole("listitem").length).toBeGreaterThan(loaded),
      );
    }
    const rows = () => screen.getAllByRole("listitem");
    expect(rows()).toHaveLength(250);
    const farDown = rows()[230]!;
    const farDownTitle = farDown.textContent;
    // A search saves one more job: the list refreshes in the background.
    store.saveFoundJobs({ searchId: null, jobs: [found(999)] });
    expect(await screen.findByText("261 jobs")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Designer 999")).toBeTruthy());
    // Nothing loaded was dropped, and the row far down is the same element,
    // updated in place rather than rebuilt from the top.
    expect(rows().length).toBeGreaterThanOrEqual(250);
    expect(farDown.isConnected).toBe(true);
    expect(farDown.textContent).toBe(farDownTitle);
    // 250 rows drawn in jsdom take seconds on a busy machine.
  }, 15_000);

  it("reads nothing while its screen is kept hidden, and once when it shows again", async () => {
    store.saveFoundJobs({ searchId: null, jobs: [found(1)] });
    const visibility = createKeptRouteVisibility(false);
    render(
      <KeptRouteVisibilityContext.Provider value={visibility}>
        <FoundList />
      </KeptRouteVisibilityContext.Provider>,
    );
    expect(await screen.findByText("1 job")).toBeTruthy();
    act(() => visibility.setHidden(true));
    const before = commands.length;
    // A search saves jobs while another screen shows.
    store.saveFoundJobs({ searchId: null, jobs: [found(2)] });
    store.saveFoundJobs({ searchId: null, jobs: [found(3)] });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(commands.length).toBe(before);
    expect(screen.queryByText("Designer 3")).toBeNull();

    act(() => visibility.setHidden(false));
    expect(await screen.findByText("Designer 3")).toBeTruthy();
    expect(commands.slice(before)).toEqual(["list_jobs"]);
  });
});

describe("adding job sites", () => {
  it("takes a long paste without spellcheck or wrapping and counts the addresses", () => {
    render(<AddSites alwaysOpen />);
    const box = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Job site URLs",
    });
    expect(box.getAttribute("spellcheck")).toBe("false");
    expect(box.getAttribute("wrap")).toBe("off");
    fireEvent.change(box, {
      target: {
        value: Array.from(
          { length: 900 },
          (_, i) => `https://careers-${i}.example.test/jobs`,
        ).join("\n"),
      },
    });
    expect(screen.getByText("900 addresses")).toBeTruthy();
    fireEvent.change(box, {
      target: { value: "https://one.example.test\n\n" },
    });
    expect(screen.getByText("1 address")).toBeTruthy();
  });

  it("inserts typed lines in one edit at the caret", () => {
    render(<AddSites alwaysOpen />);
    const box = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Job site URLs",
    });
    fireEvent.change(box, { target: { value: "https://first.example.test" } });
    box.setSelectionRange(box.value.length, box.value.length);
    const lines = Array.from(
      { length: 900 },
      (_, i) => `https://careers-${i}.example.test/jobs`,
    );
    const typed = new InputEvent("beforeinput", {
      inputType: "insertText",
      data: `\n${lines.join("\n")}`,
      cancelable: true,
    });
    act(() => {
      box.dispatchEvent(typed);
    });
    expect(typed.defaultPrevented).toBe(true);
    expect(box.value.split("\n")).toEqual([
      "https://first.example.test",
      ...lines,
    ]);
    expect(screen.getByText("901 addresses")).toBeTruthy();
    // One line typed is left to the browser.
    const key = new InputEvent("beforeinput", {
      inputType: "insertText",
      data: "x",
      cancelable: true,
    });
    box.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
  });
});
