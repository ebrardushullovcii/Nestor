// @vitest-environment jsdom

import {
  ResumeDraftSchema,
  type FoundJob,
  type JobListQueryInput,
  type ResumeCommandInput,
  type ResumeCommandName,
  type ResumeCommandOutputs,
  type StoredResume,
} from "@nestor/contracts";
import {
  approveOriginalResumesForTests,
  createResumeStore,
  openJobStore,
  type JobStore,
} from "@nestor/db/job-store";
import { createApplicationStore } from "@nestor/db/applications";
import { createResumeCommandReads } from "@nestor/job-finder/resumes";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
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
  store.close();
  vi.unstubAllGlobals();
});

const detailTitle = () =>
  screen.getByRole("heading", { level: 2, name: /Instructional Designer/ });

it("keeps a finished level change when its older queued command reply arrives last", async () => {
  const id = ids.at(-1)!;
  const resumes = createResumeStore(store);
  resumes.setLevel(id, "original");
  resumes.startWriting(id, "original");
  resumes.finishWriting(id, null);
  const read = window.nestor.resumes.run.bind(window.nestor.resumes);
  let finish!: () => void;
  const delayed = <K extends ResumeCommandName>(
    name: K,
    input: ResumeCommandInput<K>,
  ): Promise<ResumeCommandOutputs[K]> => {
    if (name !== "set_resume_level") return read(name, input);
    const change = input as ResumeCommandInput<"set_resume_level">;
    const queued = resumes.setLevel(change.jobId, change.level);
    return new Promise<StoredResume>((resolve) => {
      finish = () => resolve(queued);
    }) as Promise<ResumeCommandOutputs[K]>;
  };
  vi.spyOn(window.nestor.resumes, "run").mockImplementation(delayed);
  render(
    <MemoryRouter>
      <ToastProvider>
        <ShortlistedScreen />
      </ToastProvider>
    </MemoryRouter>,
  );
  const detail = await screen.findByRole("region", {
    name: `Resume for ${store.getJob(id)!.title}`,
  });
  fireEvent.click(within(detail).getByRole("button", { name: "Light" }));
  await waitFor(() => expect(finish).toBeDefined());
  act(() => {
    resumes.startWriting(id, "light");
    resumes.finishWriting(
      id,
      ResumeDraftSchema.parse({
        id: "completed-draft",
        jobId: String(id),
        status: "draft",
        templateId: "classic_ats",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  });
  await within(detail).findByText("To review", { exact: true });
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(
      within(detail).getByRole<HTMLButtonElement>("button", { name: "Approve" })
        .disabled,
    ).toBe(false),
  );
  expect(within(detail).queryByText("Waiting", { exact: true })).toBeNull();
});

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

it("applies the jobs on this page of Approved, next to all and the ticked ones", async () => {
  // A page holds fifty: with fifty-five approved, this page is fewer than all.
  ({ added: ids } = store.saveFoundJobs({
    searchId: null,
    jobs: Array.from({ length: 52 }, (_, index) => job(index + 4)),
  }));
  const every = store
    .sql("SELECT id FROM jobs ORDER BY id")
    .all()
    .map((row) => (row as { id: number }).id);
  store.setStage(every, "shortlisted");
  approveOriginalResumesForTests(store, every);
  const applications = createApplicationStore(store);
  const applyJobs = vi.fn(
    (input: Parameters<typeof applications.applyJobs>[0]) =>
      Promise.resolve(applications.applyJobs(input)),
  );
  Object.assign(window.nestor, { jobFinder: { applyJobs } });
  render(
    <MemoryRouter>
      <ToastProvider>
        <ShortlistedScreen />
      </ToastProvider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Approved 55" }));
  expect(
    await screen.findByRole("button", { name: "Apply to all 55 jobs" }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Apply to the 50 jobs on this page" }),
  );
  await screen.findByText("Applying to 50 jobs");
  const sent = applyJobs.mock.calls[0]![0];
  expect(sent).toMatchObject({ bulk: true });
  expect("ids" in sent.selection && sent.selection.ids).toHaveLength(50);
});

it("opens on Approved when nothing waits for review, and an empty tab offers the next step", async () => {
  approveOriginalResumesForTests(store, ids);
  render(
    <MemoryRouter>
      <ToastProvider>
        <ShortlistedScreen />
      </ToastProvider>
    </MemoryRouter>,
  );
  // Every resume is approved: the screen opens where the jobs are.
  await screen.findByRole("button", { name: "Apply to all 3 jobs" });
  fireEvent.click(screen.getByRole("button", { name: "To review 0" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "See 3 approved jobs" }),
  );
  await screen.findByRole("button", { name: "Apply to all 3 jobs" });
  for (const id of ids) send(id);
  // Both tabs are empty now: the way on is Find jobs.
  expect(await screen.findByRole("button", { name: "Find jobs" })).toBeTruthy();
});

it("stays on To review when its last resume is approved during the visit", async () => {
  render(
    <MemoryRouter>
      <ToastProvider>
        <ShortlistedScreen />
      </ToastProvider>
    </MemoryRouter>,
  );
  await screen.findByRole("button", { name: "To review 3" });
  approveOriginalResumesForTests(store, ids);
  expect(
    await screen.findByRole("button", { name: "See 3 approved jobs" }),
  ).toBeTruthy();
});
