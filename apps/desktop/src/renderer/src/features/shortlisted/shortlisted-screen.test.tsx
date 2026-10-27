// @vitest-environment jsdom

import type { FoundJob, JobListQueryInput } from "@nestor/contracts";
import {
  approveOriginalResumesForTests,
  openJobStore,
  type JobStore,
} from "@nestor/db/job-store";
import { createResumeCommandReads } from "@nestor/job-finder/resumes";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ToastProvider } from "@renderer/components/ui/toast";

import { ShortlistedScreen } from "./shortlisted-screen";

let store: JobStore;
let ids: number[];

function job(n: number): FoundJob {
  return {
    title: `Instructional Designer ${n}`,
    company: `Acorn ${n}`,
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

/** A job leaves its tab the way Apply sends it: a stage change and its event. */
function send(jobId: number) {
  store.setStage([jobId], "applied");
}

beforeEach(() => {
  store = openJobStore(":memory:");
  ({ added: ids } = store.saveFoundJobs({
    searchId: null,
    jobs: [job(1), job(2), job(3)],
  }));
  store.setStage(ids, "shortlisted");
  const reads = createResumeCommandReads(store, () => []);
  const onChange = (listener: Parameters<JobStore["onChange"]>[0]) =>
    store.onChange(listener);
  Object.assign(window, {
    nestor: {
      jobs: {
        onChange,
        run: (name: string) =>
          Promise.resolve(name === "stage_counts" ? store.stageCounts() : null),
      },
      resumes: {
        run: (name: string, input: { jobId?: number } & JobListQueryInput) =>
          Promise.resolve(
            name === "list_shortlisted"
              ? reads.list(input)
              : reads.get(input.jobId!),
          ),
        preview: vi.fn(() => new Promise(() => undefined)),
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

const detailTitle = () =>
  screen.getByRole("heading", { level: 2, name: /Instructional Designer/ });

it("names the filtered Approved jobs Apply will take and offers no empty batch", async () => {
  approveOriginalResumesForTests(store, ids.slice(0, 2));
  render(
    <MemoryRouter>
      <ToastProvider>
        <ShortlistedScreen />
      </ToastProvider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Approved 2" }));
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Find a shortlisted job" }),
    { target: { value: "Designer 1" } },
  );
  await screen.findByRole("checkbox", { name: "Select all 1 jobs" });
  expect(
    screen.getByRole("button", { name: "Apply to all 1 job" }),
  ).toBeTruthy();
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Find a shortlisted job" }),
    { target: { value: "No such title" } },
  );
  await screen.findByText("No shortlisted job matches.");
  expect(screen.queryByRole("button", { name: /^Apply to all / })).toBeNull();
});

it("opens the next job when the open one leaves the tab, and nothing when the tab empties", async () => {
  render(
    <MemoryRouter>
      <ToastProvider>
        <ShortlistedScreen />
      </ToastProvider>
    </MemoryRouter>,
  );
  const [first, second, third] = [...ids].reverse() as [number, number, number];
  await waitFor(() =>
    expect(detailTitle().textContent).toBe(store.getJob(first)!.title),
  );

  send(first);
  await waitFor(() =>
    expect(detailTitle().textContent).toBe(store.getJob(second)!.title),
  );

  send(second);
  send(third);
  await waitFor(() =>
    expect(
      screen.queryByRole("heading", {
        level: 2,
        name: /Instructional Designer/,
      }),
    ).toBeNull(),
  );
});
