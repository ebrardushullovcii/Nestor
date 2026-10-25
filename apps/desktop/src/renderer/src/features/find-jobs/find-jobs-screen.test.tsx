// @vitest-environment jsdom

import type { FoundJob, JobListQueryInput } from "@nestor/contracts";
import { openJobStore, type JobStore } from "@nestor/db/job-store";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ToastProvider } from "@renderer/components/ui/toast";

import { FindJobsScreen } from "./find-jobs-screen";

let store: JobStore;
let ids: number[];

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
function hideFromChat(jobId: number) {
  store.setStage([jobId], "hidden");
}

beforeEach(() => {
  store = openJobStore(":memory:");
  ({ added: ids } = store.saveFoundJobs({
    searchId: null,
    jobs: [job(1), job(2), job(3)],
  }));
  const run = (name: string, input: JobListQueryInput & { id?: number }) => {
    if (name === "list_jobs") return Promise.resolve(store.listJobs(input));
    if (name === "stage_counts") return Promise.resolve(store.stageCounts());
    if (name === "get_job") return Promise.resolve(store.getJob(input.id!));
    if (name === "search_status")
      return Promise.resolve({ search: null, sources: [] });
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
  expect(screen.getByText("All caught up")).toBeTruthy();
  expect(screen.queryByText("No jobs yet")).toBeNull();
});
