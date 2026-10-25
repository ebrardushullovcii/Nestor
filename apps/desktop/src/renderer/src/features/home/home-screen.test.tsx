// @vitest-environment jsdom

import type { FoundJob, HomeSummaryInput } from "@nestor/contracts";
import { createApplicationStore } from "@nestor/db/applications";
import {
  createHomeStore,
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
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HomeScreen } from "./home-screen";

const DAY = 86_400_000;
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

/** Two sent, one approved and not yet handed to Apply, one still found. */
beforeEach(() => {
  store = openJobStore(":memory:");
  ({ added: ids } = store.saveFoundJobs({
    searchId: null,
    jobs: [1, 2, 3, 4].map(job),
  }));
  store.setStage(ids.slice(0, 3), "resume");
  createApplicationStore(store).applyJobs({
    selection: { ids: ids.slice(0, 2) },
  });
  store
    .sql(
      `UPDATE applications SET state = 'submitted', submitted_at = ?, updated_at = ?`,
    )
    .run(Date.now() - DAY, Date.now() - DAY);
  const home = createHomeStore(store);
  Object.assign(window, {
    nestor: {
      jobs: {
        onChange: (listener: Parameters<JobStore["onChange"]>[0]) =>
          store.onChange(listener),
      },
      home: {
        summary: (input: HomeSummaryInput) =>
          Promise.resolve(home.summary(input)),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  store.close();
});

function NeedsYouProbe() {
  return <p>Needs you opened at {useLocation().search}</p>;
}

function renderHome() {
  render(
    <MemoryRouter initialEntries={["/job-finder/home"]}>
      <Routes>
        <Route element={<HomeScreen />} path="/job-finder/home" />
        <Route
          element={<p>Applications opened</p>}
          path="/job-finder/applications"
        />
        <Route element={<NeedsYouProbe />} path="/job-finder/actions" />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Home", () => {
  it("puts what is waiting first and follows the store as it changes", async () => {
    const tracker = createTrackerStore(store);
    const reminder = tracker.addEvent({
      jobId: ids[0]!,
      kind: "reminder",
      title: "Chase the recruiter",
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });
    renderHome();

    expect(await screen.findByText("Follow up on 1 application")).toBeTruthy();
    expect(screen.getByText("Apply to 1 approved job")).toBeTruthy();
    expect(screen.getByText("Sort 1 found job")).toBeTruthy();
    expect(screen.getByText("Chase the recruiter")).toBeTruthy();

    tracker.updateEvent({ id: reminder.id, done: true });
    store.notify({
      cause: "tracker",
      stages: ["applied"],
      ids: [ids[0]!],
      searchId: null,
    });
    await waitFor(() =>
      expect(screen.queryByText("Follow up on 1 application")).toBeNull(),
    );
    expect(
      screen.getByText("No interviews or reminders in the next 7 days."),
    ).toBeTruthy();
  });

  it("opens the place a next step points at", async () => {
    createTrackerStore(store).addEvent({
      jobId: ids[1]!,
      kind: "reminder",
      title: "Send references",
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });
    renderHome();

    fireEvent.click(await screen.findByRole("button", { name: /Follow up/ }));
    expect(await screen.findByText("Applications opened")).toBeTruthy();
  });

  it("names site sign-ins as sign-ins and opens Needs you on them", async () => {
    store
      .sql(
        `INSERT INTO needs_you (kind, answer_key, country, site_origin, prompt, input, options_json, opened_at)
         VALUES ('sign_in', 'account', '', ?, 'Sign in', 'text', '[]', ?)`,
      )
      .run("https://jobs.example.test", Date.now());
    renderHome();

    expect(await screen.findByText("Sign in to 1 job site")).toBeTruthy();
    expect(screen.queryByText(/questions? for your applications/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Sign in/ }));
    expect(
      await screen.findByText("Needs you opened at ?kind=sign_in"),
    ).toBeTruthy();
  });
});
