// @vitest-environment jsdom

import {
  JobSearchSettingsSchema,
  MoveJobsInputSchema,
  type JobSearchStatus,
  type FoundJob,
  type JobListQueryInput,
} from "@nestor/contracts";
import {
  createSearchSourcesStore,
  openJobStore,
  type JobStore,
} from "@nestor/db/job-store";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ToastProvider } from "@renderer/components/ui/toast";

import { FindJobsScreen } from "./find-jobs-screen";

let store: JobStore;
let ids: number[];
let searchStatus: JobSearchStatus;
/** Holds `count_jobs` until a test lets it answer. */
let countGate: Promise<void>;

function job(n: number): FoundJob {
  return {
    title: `Supply Chain Analyst ${n}`,
    company: `Spool ${n}`,
    location: "Remote",
    workModes: ["remote"],
    url: `https://board.example.test/jobs/${n}`,
    applyUrl: null,
    sourceId: "board",
    sourceLabel: "Example Board",
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

/** The side chat moves a job the way `move_jobs` does: a stage change and its event. */
/** A finished search, so the list's fit floor follows its pickiness. */
function pastSearch() {
  const search = store.searches.start(JobSearchSettingsSchema.parse({}), 1);
  searchStatus = {
    ...searchStatus,
    search: store.searches.finish(search.id, "done"),
  };
}

function hideFromChat(jobId: number) {
  store.setStage([jobId], "hidden");
}

beforeEach(() => {
  store = openJobStore(":memory:");
  searchStatus = {
    search: null,
    sources: [],
    progress: null,
    sourceRevision: 0,
  };
  ({ added: ids } = store.saveFoundJobs({
    searchId: null,
    jobs: [job(1), job(2), job(3)],
  }));
  countGate = Promise.resolve();
  store.setFit(
    ids.map((id) => ({
      id,
      score: 80,
      summary: "Assessed fit",
      reasons: [],
      gaps: [],
    })),
  );
  const run = (name: string, input: JobListQueryInput & { id?: number }) => {
    if (name === "list_jobs") return Promise.resolve(store.listJobs(input));
    if (name === "count_jobs")
      return countGate.then(() => ({ total: store.countJobs(input) }));
    if (name === "move_jobs")
      return Promise.resolve(store.moveJobs(MoveJobsInputSchema.parse(input)));
    if (name === "stage_counts") return Promise.resolve(store.stageCounts());
    if (name === "get_job") return Promise.resolve(store.getJob(input.id!));
    if (name === "search_status") return Promise.resolve(searchStatus);
    if (name === "list_search_sources")
      return Promise.resolve(createSearchSourcesStore(store).list(input));
    // The site picker is not part of this test.
    return Promise.reject(new Error(`${name} is not stubbed`));
  };
  Object.assign(window, {
    nestor: {
      jobs: {
        run,
        onChange: (listener: Parameters<JobStore["onChange"]>[0]) =>
          store.onChange(listener),
        onSearchStatus: () => () => undefined,
      },
    },
  });
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
  window.localStorage.clear();
  store.close();
  vi.unstubAllGlobals();
});

const openTitle = () =>
  screen.queryByRole("heading", { level: 2, name: /Supply Chain Analyst/ })
    ?.textContent ?? null;

it("opens the next found job when the chat moves the open one, and says all caught up when Found empties", async () => {
  render(
    <MemoryRouter>
      <ToastProvider>
        <FindJobsScreen />
      </ToastProvider>
    </MemoryRouter>,
  );
  const shown = await waitFor(() => {
    const title = openTitle();
    expect(title).not.toBeNull();
    return title;
  });
  const order = store
    .listJobs({ stage: "found", sort: "best_fit", limit: 50 })
    .rows.map((row) => row.id);
  const first = order.find((id) => store.getJob(id)!.title === shown)!;
  const second = order[order.indexOf(first) + 1]!;

  hideFromChat(first);
  await waitFor(() => expect(openTitle()).toBe(store.getJob(second)!.title));

  hideFromChat(ids[0]!);
  hideFromChat(ids[1]!);
  hideFromChat(ids[2]!);
  await waitFor(() => expect(openTitle()).toBeNull());
  // The last rows fade out first; then the list says why it is empty.
  expect(await screen.findByText("All caught up")).toBeTruthy();
  expect(screen.queryByText("No jobs yet")).toBeNull();
});

it("names the open job's moves by their words, with the key as a shortcut", async () => {
  render(
    <MemoryRouter>
      <ToastProvider>
        <FindJobsScreen />
      </ToastProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(openTitle()).not.toBeNull());
  // "Shortlist", not "ShortlistS": the keycap is decoration.
  const shortlist = await screen.findByRole("button", {
    name: "Shortlist",
  });
  expect(shortlist.getAttribute("aria-keyshortcuts")).toBe("S");
  expect(shortlist.querySelector("kbd")?.getAttribute("aria-hidden")).toBe(
    "true",
  );
  expect(
    screen
      .getByRole("button", { name: "Hide" })
      .getAttribute("aria-keyshortcuts"),
  ).toBe("H");
});

it("shows failed sites and recovery advice instead of a successful empty search", async () => {
  store.sql("DELETE FROM jobs").run();
  const search = store.searches.start(JobSearchSettingsSchema.parse({}), 4);
  const sources = createSearchSourcesStore(store);
  for (let id = 1; id <= 4; id++)
    sources.put(search.id, {
      sourceId: String(id),
      label: `Unreadable site ${id}`,
      url: `https://site-${id}.example/vacancy`,
      state: "failed",
      lane: "http",
      phase: null,
      cards: 1,
      related: 1,
      unrelated: 0,
      seen: 0,
      failedReads: 1,
      found: 0,
      added: 0,
      hidden: 0,
      message: "The listing's title or hiring employer could not be read.",
    });
  searchStatus = {
    search: store.searches.finish(
      search.id,
      "failed",
      "4 sites could not be read",
    ),
    ...sources.compact(search.id),
    sourceRevision: 1,
  };
  render(
    <MemoryRouter>
      <ToastProvider>
        <FindJobsScreen />
      </ToastProvider>
    </MemoryRouter>,
  );
  await screen.findByText("Some sites could not be read");
  expect(screen.getByText(/4 of 4 sites could not be read/)).toBeTruthy();
  // The site report opens over the list, on the failed sites.
  fireEvent.click(screen.getByRole("button", { name: "What each site found" }));
  await screen.findByText("Unreadable site 4");
  expect(screen.queryByText(/nothing new/i)).toBeNull();
  expect(screen.queryByText("No jobs yet")).toBeNull();
  expect(screen.getAllByRole("button", { name: "Continue site" })).toHaveLength(
    4,
  );
  expect(
    screen.getAllByText(
      "The vacancy title or hiring employer could not be identified on this page.",
    ),
  ).toHaveLength(4);
  expect(screen.getAllByText("Technical details")).toHaveLength(4);
  expect(
    document.querySelector<HTMLDetailsElement>(
      "[data-site-result] details details",
    )?.open,
  ).toBe(false);
  expect(
    document.querySelector<HTMLDetailsElement>("[data-site-result] details")
      ?.open,
  ).toBe(true);
});

it("sends an all-sign-in-blocked search to Needs you rather than failed-site URL advice", async () => {
  store.sql("DELETE FROM jobs").run();
  const search = store.searches.start(JobSearchSettingsSchema.parse({}), 1);
  const sources = createSearchSourcesStore(store);
  sources.put(search.id, {
    sourceId: "1",
    label: "Sign-in board",
    url: "https://signin.example/",
    state: "needs_you",
    lane: "browser",
    phase: null,
    cards: 0,
    related: 0,
    unrelated: 0,
    seen: 0,
    failedReads: 0,
    found: 0,
    added: 0,
    hidden: 0,
    message: "Sign in to read this site.",
  });
  searchStatus = {
    search: store.searches.finish(search.id, "failed", "1 site needs sign-in"),
    ...sources.compact(search.id),
    sourceRevision: 1,
  };
  render(
    <MemoryRouter>
      <ToastProvider>
        <FindJobsScreen />
      </ToastProvider>
    </MemoryRouter>,
  );
  await screen.findByText("Some sites need you");
  expect(screen.getByText(/1 site needs you/)).toBeTruthy();
  expect(screen.queryByText("Some sites could not be read")).toBeNull();
  expect(screen.queryByText(/nothing new/i)).toBeNull();
});

function renderScreen() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <FindJobsScreen />
      </ToastProvider>
    </MemoryRouter>,
  );
}

it("counts every match before select all acts on a list counted past 1,000", async () => {
  const { added } = store.saveFoundJobs({
    searchId: null,
    jobs: Array.from({ length: 1005 }, (_, i) => job(i + 10)),
  });
  store.setFit(
    added.map((id) => ({
      id,
      score: 80,
      summary: "Assessed fit",
      reasons: [],
      gaps: [],
    })),
  );
  let answer = () => undefined as void;
  countGate = new Promise<void>((resolve) => {
    answer = resolve;
  });
  pastSearch();
  renderScreen();
  // The search's fit floor filters the list, so its count stops at 1,000.
  const list = await screen.findByRole("region", { name: "Found jobs" });
  fireEvent.click(await within(list).findByRole("button", { name: "Select" }));
  // The box takes the 50 rows shown; the bar offers every match, then counts.
  fireEvent.click(
    within(list).getByRole("checkbox", { name: "Select all 50 shown jobs" }),
  );
  expect(within(list).getByText("50 selected")).toBeTruthy();
  fireEvent.click(
    within(list).getByRole("button", { name: "Select all matching" }),
  );
  expect(await within(list).findByText("Counting…")).toBeTruthy();
  expect(
    within(list).getByRole<HTMLButtonElement>("button", { name: /^Hide/ })
      .disabled,
  ).toBe(true);
  answer();
  expect(await within(list).findByText("1,008 selected")).toBeTruthy();
  // The bulk button names its exact scope for assistive tech.
  fireEvent.click(
    within(list).getByRole("button", { name: "Hide 1,008 jobs" }),
  );
  await waitFor(() => expect(store.stageCounts().hidden).toBe(1008));
});

it("keeps the fit floor choice across a restart and counts below it with the text filter", async () => {
  store.setFit(
    ids.map((id, i) => ({
      id,
      score: [90, 20, 30][i]!,
      summary: "",
      reasons: [],
      gaps: [],
    })),
  );
  pastSearch();
  const first = renderScreen();
  // One fit control on the screen: the list's "Show fit", on Good+.
  const showFit = await screen.findByRole("group", { name: "Show fit" });
  const goodPlus = within(showFit).getByRole("button", { name: "Good+" });
  expect(goodPlus.getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("group", { name: "How picky" })).toBeNull();
  const scope = () =>
    document.querySelector("[data-list-scope]")?.textContent ?? "";
  // The list says its scope plainly: how many show, of how many, and why.
  await waitFor(() =>
    expect(scope()).toBe("1 of 3 jobs · 2 below good fit · Show all"),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Filter jobs" }), {
    target: { value: "Analyst 2" },
  });
  // Only the matching job counts: the floor hides one of them.
  await waitFor(() =>
    expect(scope()).toBe("0 jobs · 1 below good fit · Show all"),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Filter jobs" }), {
    target: { value: "Analyst 1" },
  });
  // Nothing under the floor: no count at all.
  await waitFor(() => expect(scope()).toBe("1 job"));
  expect(goodPlus.isConnected).toBe(true);
  const anyFit = within(showFit).getByRole("button", { name: "Any fit" });
  fireEvent.click(anyFit);
  await waitFor(() => expect(anyFit.getAttribute("aria-pressed")).toBe("true"));
  fireEvent.change(screen.getByRole("textbox", { name: "Filter jobs" }), {
    target: { value: "" },
  });
  first.unmount();

  renderScreen();
  const restored = await screen.findByRole("group", { name: "Show fit" });
  expect(
    within(restored)
      .getByRole("button", { name: "Any fit" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(await screen.findByText("Supply Chain Analyst 2")).toBeTruthy();
});

it("offers Retry fit for retained unfinished jobs and Stop fit only while running", async () => {
  const { SearchStatus } = await import("./search-panel");
  const run = vi
    .spyOn(window.nestor.jobs, "run")
    .mockResolvedValue(searchStatus);
  const status = {
    ...searchStatus,
    fitChecking: 2,
    fitRunning: false,
    fitError: "Model output was incomplete",
  };
  const view = render(
    <MemoryRouter>
      <SearchStatus status={status} error={null} noSites={false} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry fit" }));
  await waitFor(() => expect(run).toHaveBeenCalledWith("retry_fit", {}));
  expect(run).not.toHaveBeenCalledWith("start_search", expect.anything());
  view.rerender(
    <MemoryRouter>
      <SearchStatus
        status={{ ...status, fitRunning: true }}
        error={null}
        noSites={false}
      />
    </MemoryRouter>,
  );
  expect(screen.queryByRole("button", { name: "Retry fit" })).toBeNull();
  expect(screen.getByText("Checking fit for 2 saved jobs…")).toBeTruthy();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Stop fit" }).getAttribute("disabled"),
    ).toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Stop fit" }));
  await waitFor(() => expect(run).toHaveBeenCalledWith("stop_search", {}));
});
