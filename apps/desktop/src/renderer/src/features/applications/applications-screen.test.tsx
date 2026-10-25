// @vitest-environment jsdom

import type { FoundJob } from "@nestor/contracts";
import { createApplicationStore } from "@nestor/db/applications";
import {
  createTrackerStore,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@renderer/components/ui/toast";

import { createTrackerCommandRunner } from "../../../../main/services/tracker-commands";
import { ApplicationsScreen } from "./applications-screen";

let store: JobStore;
let ids: number[];

function job(n: number): FoundJob {
  return {
    title: `Product Designer ${n}`,
    company: `Northfield ${n}`,
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

/** Apply's side of the seam: it writes the row's state and says so. */
function applyWrites(jobId: number, sql: string) {
  store.sql(`UPDATE applications SET ${sql} WHERE job_id = ?`).run(jobId);
  store.notify({
    cause: "application",
    stages: ["resume", "applied"],
    ids: [jobId],
    searchId: null,
  });
}

beforeEach(() => {
  store = openJobStore(":memory:");
  ({ added: ids } = store.saveFoundJobs({
    searchId: null,
    jobs: [job(1), job(2)],
  }));
  store.setStage(ids, "resume");
  createApplicationStore(store).applyJobs({ selection: { ids } });
  applyWrites(
    ids[0]!,
    "state = 'submitted', submitted_at = updated_at, updated_at = updated_at + 1",
  );
  const run = createTrackerCommandRunner(store);
  Object.assign(window, {
    nestor: {
      jobs: {
        onChange: (listener: Parameters<JobStore["onChange"]>[0]) =>
          store.onChange(listener),
      },
      tracker: { run, exportCsv: vi.fn() },
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
  window.localStorage.clear();
});

function renderScreen() {
  render(
    <MemoryRouter>
      <ToastProvider>
        <ApplicationsScreen />
      </ToastProvider>
    </MemoryRouter>,
  );
  return screen.getByRole("list", { name: "Applications" });
}

describe("Applications", () => {
  it("moves a sent application on, and Undo takes it back", async () => {
    const list = renderScreen();
    fireEvent.click(
      await within(list).findByRole("button", { name: /^Northfield 1 / }),
    );
    const detail = await screen.findByRole("region", {
      name: "Application to Northfield 1",
    });
    fireEvent.click(
      within(
        within(detail).getByRole("group", {
          name: "Where this application stands",
        }),
      ).getByRole("button", { name: "Heard back" }),
    );

    const undo = await screen.findByRole("button", { name: "Undo" });
    const tracker = createTrackerStore(store);
    expect(tracker.getRow(ids[0]!)?.status).toBe("replied");
    expect(await within(detail).findByText("Moved to Heard back")).toBeTruthy();
    fireEvent.click(undo);
    await waitFor(() =>
      expect(tracker.getRow(ids[0]!)?.status).toBe("applied"),
    );
  });

  it("follows Apply's work while an application is in flight", async () => {
    const list = renderScreen();
    const row = await within(list).findByRole("button", {
      name: /^Northfield 2 /,
    });
    expect(row.textContent).toContain("Waiting to apply");

    applyWrites(ids[1]!, "state = 'needs_you'");
    await waitFor(() => expect(row.textContent).toContain("Needs you"));

    applyWrites(
      ids[1]!,
      "state = 'submitted', submitted_at = updated_at, updated_at = updated_at + 1",
    );
    await waitFor(() => expect(row.textContent).toContain("Applied"));
    expect(screen.getByRole("button", { name: "Applying 0" })).toBeTruthy();
  });
});
