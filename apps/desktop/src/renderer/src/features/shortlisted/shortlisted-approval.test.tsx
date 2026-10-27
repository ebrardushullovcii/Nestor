// @vitest-environment jsdom

import type {
  FoundJob,
  JobListQueryInput,
  ResumeChangeResult,
} from "@nestor/contracts";
import {
  createResumeStore,
  approveOriginalResumesForTests,
  openJobStore,
  type JobStore,
} from "@nestor/db/job-store";
import { createApplicationStore } from "@nestor/db/applications";
import { createResumeCommandReads } from "@nestor/job-finder/resumes";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Link, MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";

import { ToastProvider } from "@renderer/components/ui/toast";
import {
  createKeptRouteVisibility,
  KeptRouteVisibilityContext,
} from "@renderer/features/job-finder/lib/kept-route-visibility";
import { ShortlistedScreen } from "./shortlisted-screen";

let store: JobStore;
let ids: number[];
let approve: Mock<(id: number) => Promise<ResumeChangeResult>>;

beforeEach(() => {
  store = openJobStore(":memory:");
  const jobs: FoundJob[] = Array.from({ length: 120 }, (_, n) => ({
    title: `Designer ${n + 1}`,
    company: "Synthetic Co",
    location: "Remote",
    workModes: ["remote"],
    url: `https://board.example.test/${n}`,
    applyUrl: null,
    sourceId: "board",
    sourceLabel: "Synthetic board",
    sourceJobId: String(n),
    postedAt: null,
    salaryText: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    seniority: null,
    employmentType: null,
    summary: null,
    description: "Synthetic listing",
  }));
  ids = store.saveFoundJobs({ searchId: null, jobs }).ids;
  store.setStage(ids, "shortlisted");
  const resumes = createResumeStore(store);
  for (const id of ids) {
    resumes.startWriting(id, "original");
    resumes.finishWriting(id, null);
  }
  const reads = createResumeCommandReads(store, () => []);
  approve = vi.fn((id: number) => Promise.resolve(resumes.approve(id, null)));
  Object.assign(window, {
    nestor: {
      jobs: {
        onChange: (listener: Parameters<JobStore["onChange"]>[0]) =>
          store.onChange(listener),
        run: (name: string) =>
          Promise.resolve(name === "stage_counts" ? store.stageCounts() : null),
      },
      resumes: {
        run: (name: string, input: JobListQueryInput & { jobId: number }) => {
          if (name === "list_shortlisted")
            return Promise.resolve(reads.list(input));
          if (name === "approve_resume") return approve(input.jobId);
          return Promise.resolve(reads.get(input.jobId));
        },
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

function show() {
  const visibility = createKeptRouteVisibility(false);
  render(
    <MemoryRouter>
      <Link to="?tab=approved">Open approved from Home</Link>
      <KeptRouteVisibilityContext.Provider value={visibility}>
        <ToastProvider>
          <ShortlistedScreen />
        </ToastProvider>
      </KeptRouteVisibilityContext.Provider>
    </MemoryRouter>,
  );
  return visibility;
}

it("approves every selected resume across pages, with an excluded job kept", async () => {
  show();
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Select all 120 jobs" }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select Designer 120" }),
  );
  fireEvent.click(
    within(screen.getByRole("region", { name: "Resumes to review" })).getByRole(
      "button",
      { name: "Approve 119" },
    ),
  );
  await waitFor(() => expect(store.stageCounts().resume).toBe(119));
  expect(store.getJob(ids.at(-1)!)?.stage).toBe("shortlisted");
});

it("honors Home's Approved link after Shortlisted is already mounted, including repeated visits", async () => {
  approveOriginalResumesForTests(store, ids.slice(0, 2));
  show();
  await screen.findByRole("region", { name: "Resumes to review" });
  fireEvent.click(
    screen.getByRole("link", { name: "Open approved from Home" }),
  );
  await screen.findByRole("region", { name: "Approved resumes" });
  fireEvent.click(screen.getByRole("button", { name: "To review 118" }));
  await screen.findByRole("region", { name: "Resumes to review" });
  fireEvent.click(
    screen.getByRole("link", { name: "Open approved from Home" }),
  );
  await screen.findByRole("region", { name: "Approved resumes" });
});

it("does not approve a hidden kept screen's resume on Ctrl+Enter", async () => {
  const visibility = show();
  await screen.findByRole("heading", { name: "Designer 120" });
  visibility.setHidden(true);
  fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
  // Let an async approval finish if the hidden screen incorrectly started one.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(approve).not.toHaveBeenCalled();
  expect(store.stageCounts().resume).toBe(0);
});

it("does not approve when another control has handled Ctrl+Enter", async () => {
  show();
  await screen.findByRole("heading", { name: "Designer 120" });
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    ctrlKey: true,
    cancelable: true,
  });
  event.preventDefault();
  window.dispatchEvent(event);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(approve).not.toHaveBeenCalled();
});

it("shows an approved job's running application instead of offering Apply again", async () => {
  approveOriginalResumesForTests(store, ids.slice(0, 2));
  const applications = createApplicationStore(store);
  applications.applyJobs({ selection: { ids: [ids[0]!] } });
  const running = applications.claimNext()!;
  show();
  fireEvent.click(
    screen.getByRole("link", { name: "Open approved from Home" }),
  );
  const list = await screen.findByRole("region", { name: "Approved resumes" });
  const row = await within(list).findByRole("button", { name: /Designer 1\b/ });
  expect(row.textContent).toContain("Applying…");
  fireEvent.click(row);
  await screen.findByRole("heading", { name: "Designer 1" });
  expect(
    screen.getByRole("button", { name: "Applying · Open in Applications" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  act(() => {
    applications.finishPreparation({
      id: running.id,
      attempt: running.attempt,
      state: "ready",
    });
  });
  await waitFor(() => expect(row.textContent).toContain("Ready to send"));
  expect(
    await screen.findByRole("button", { name: "Review and send" }),
  ).toBeTruthy();
});
