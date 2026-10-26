// @vitest-environment jsdom

import type { ActivityFeed } from "@nestor/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const feed: ActivityFeed = {
  searches: [
    {
      id: "search_1",
      state: "running",
      startedAt: "2026-10-26T10:00:00.000Z",
      finishedAt: null,
      sourcesDone: 3,
      sourcesTotal: 12,
      added: 5,
      error: null,
    },
  ],
  resumes: [
    {
      jobId: 7,
      stage: "applied",
      title: "Supply Chain Analyst",
      company: "Spool",
      state: "ready",
      at: "2026-10-26T09:00:00.000Z",
      error: null,
    },
  ],
  applications: [
    {
      id: 3,
      jobId: 9,
      title: "Data Analyst",
      company: "Ledger",
      state: "submitted",
      at: "2026-10-26T08:00:00.000Z",
      error: null,
    },
  ],
  moves: [
    {
      id: 11,
      at: "2026-10-26T11:00:00.000Z",
      to: "hidden",
      from: ["found"],
      count: 1,
      title: "Platform Engineer",
      company: "Acme",
      stillThere: 1,
    },
    {
      id: 10,
      at: "2026-10-26T10:30:00.000Z",
      to: "shortlisted",
      from: ["found"],
      count: 3,
      title: "Product Analyst",
      company: "Globex",
      stillThere: 0,
    },
  ],
  running: 4,
};

let readFeed: ReturnType<typeof vi.fn>;
let runJobs: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  readFeed = vi.fn(() => Promise.resolve(feed));
  runJobs = vi.fn(() => Promise.resolve({ moveId: 11, moved: 1, counts: {} }));
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      activity: { feed: readFeed },
      jobs: {
        run: runJobs,
        onChange: vi.fn(() => vi.fn()),
        onSearchStatus: vi.fn(() => vi.fn()),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

async function renderTaskCenter(onNavigate = vi.fn()) {
  const { JobFinderTaskCenter } = await import("./job-finder-task-center");
  render(<JobFinderTaskCenter onNavigate={onNavigate} />);
  return onNavigate;
}

const summary = () =>
  screen.getByText("Activity", { selector: "span" }).closest("summary")!;

describe("JobFinderTaskCenter", () => {
  test("counts everything running from the store, and lists it with what just finished", async () => {
    await renderTaskCenter();
    await waitFor(() =>
      expect(summary().getAttribute("aria-label")).toBe("Activity: 4 running"),
    );

    fireEvent.click(summary());
    // The panel is its own chunk; the first load takes a moment.
    const running = await screen.findByRole(
      "region",
      { name: "Running now" },
      { timeout: 5000 },
    );
    expect(running.textContent).toContain("Job search");
    expect(running.textContent).toContain("3 of 12 sites read · 5 new jobs");
    const finished = screen.getByRole("region", {
      name: "Finished in the last day",
    });
    expect(finished.textContent).toContain("Spool · Resume written");
    expect(finished.textContent).toContain("Ledger · Sent");
  });

  test("opens the screen that shows a piece of work and closes", async () => {
    const onNavigate = await renderTaskCenter();
    fireEvent.click(summary());
    fireEvent.click(
      await screen.findByRole("button", { name: /Data Analyst/ }),
    );
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith(
        "/job-finder/applications?jobId=9",
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Running now" })).toBeNull(),
    );
  });

  test("clears finished work and keeps it cleared after reopening", async () => {
    await renderTaskCenter();
    fireEvent.click(summary());
    fireEvent.click(
      await screen.findByRole("button", { name: "Clear finished" }),
    );
    expect(
      screen.queryByRole("region", { name: "Finished in the last day" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close Activity" }));
    fireEvent.click(summary());
    await screen.findByRole("region", { name: "Running now" });
    expect(
      screen.queryByRole("region", { name: "Finished in the last day" }),
    ).toBeNull();
  });

  test("opens a written resume's job where it is now", async () => {
    const onNavigate = await renderTaskCenter();
    fireEvent.click(summary());
    fireEvent.click(
      await screen.findByRole("button", { name: /Supply Chain Analyst/ }),
    );
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith(
        "/job-finder/applications?jobId=7",
      ),
    );
  });

  test("says Activity could not be read, and reads it again", async () => {
    // The read at launch and the one opening Activity both fail.
    readFeed
      .mockRejectedValueOnce(new Error("database is locked"))
      .mockRejectedValueOnce(new Error("database is locked"));
    await renderTaskCenter();
    fireEvent.click(summary());
    expect(
      await screen.findByText("Activity could not be read.", undefined, {
        timeout: 3000,
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Loading activity…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("region", { name: "Running now" }),
    ).toBeTruthy();
  });

  test("undoes one of the person's recent moves", async () => {
    await renderTaskCenter();
    fireEvent.click(summary());
    const moves = await screen.findByRole("region", {
      name: "Your recent moves",
    });
    expect(moves.textContent).toContain("Hid Platform Engineer");
    expect(moves.textContent).toContain("Shortlisted 3 jobs");
    expect(moves.textContent).toContain("Product Analyst and 2 others");
    expect(moves.textContent).toContain("Moved on since");
    const calls = readFeed.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    await waitFor(() =>
      expect(runJobs).toHaveBeenCalledWith("undo_move", { moveId: 11 }),
    );
    await waitFor(() =>
      expect(readFeed.mock.calls.length).toBeGreaterThan(calls),
    );
  });

  test("says how many jobs came back and how many had moved on since", async () => {
    readFeed.mockResolvedValue({
      ...feed,
      moves: [{ ...feed.moves[1]!, id: 12, stillThere: 2 }],
    });
    runJobs.mockResolvedValue({ moveId: 12, moved: 1, counts: {} });
    const { JobFinderTaskCenter } = await import("./job-finder-task-center");
    const { ToastProvider } = await import("@renderer/components/ui/toast");
    render(
      <ToastProvider>
        <JobFinderTaskCenter onNavigate={vi.fn()} />
      </ToastProvider>,
    );
    fireEvent.click(summary());
    const moves = await screen.findByRole("region", {
      name: "Your recent moves",
    });
    expect(moves.textContent).toContain("1 job moved on since");

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(await screen.findByText("Put back 1 job")).toBeTruthy();
    expect(
      screen.getByText(
        "2 jobs had moved on since. They stayed where they are.",
      ),
    ).toBeTruthy();
  });
});
