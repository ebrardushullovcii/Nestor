// @vitest-environment jsdom

import type { ApplicationDetails, FoundJob } from "@nestor/contracts";
import { createApplicationStore } from "@nestor/db/applications";
import {
  createTrackerStore,
  approveOriginalResumesForTests,
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
let openApplication: ReturnType<typeof vi.fn>;
let receipt: ApplicationDetails["receipt"];

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
  approveOriginalResumesForTests(store, ids);
  createApplicationStore(store).applyJobs({ selection: { ids } });
  applyWrites(
    ids[0]!,
    "state = 'submitted', submitted_at = updated_at, updated_at = updated_at + 1",
  );
  const run = createTrackerCommandRunner(store);
  const applications = createApplicationStore(store);
  const onChange = (listener: Parameters<JobStore["onChange"]>[0]) =>
    store.onChange(listener);
  openApplication = vi.fn(() => Promise.resolve(true));
  receipt = null;
  Object.assign(window, {
    nestor: {
      jobs: { onChange },
      tracker: { run, exportCsv: vi.fn() },
      // Apply's bridge over the same store; the review card is what a run recorded.
      jobFinder: {
        applicationsForJobs: ({ jobIds }: { jobIds: number[] }) =>
          Promise.resolve(applications.forJobs(jobIds)),
        getApplicationDetails: ({ id }: { id: number }) => {
          const application = applications.getApplication(id);
          return Promise.resolve(
            application
              ? ({
                  application,
                  summary: null,
                  detail: null,
                  resumeFileName: "Resume - Northfield.pdf",
                  reviewCard: {
                    siteLabel: "Northfield careers",
                    pageUrl: null,
                    answers: [
                      {
                        question: "Why Northfield?",
                        answer: "I build design systems for clinics.",
                        source: "Written for this job",
                        written: true,
                        groundedIn: [],
                      },
                    ],
                    attachments: [],
                    letter: null,
                    waitingOnYou: [],
                    preparedAt: new Date().toISOString(),
                  },
                  receipt,
                } satisfies ApplicationDetails)
              : null,
          );
        },
        openApplication,
        applyJobs: (input: Parameters<typeof applications.applyJobs>[0]) =>
          Promise.resolve(applications.applyJobs(input)),
        stopApplication: ({ id }: { id: number }) =>
          Promise.resolve(applications.stop(id)),
        onApplicationsChange: onChange,
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
  window.localStorage.clear();
});

function renderScreen(route = "/job-finder/applications") {
  render(
    <MemoryRouter initialEntries={[route]}>
      <ToastProvider>
        <ApplicationsScreen />
      </ToastProvider>
    </MemoryRouter>,
  );
  return screen.getByRole("list", { name: "Applications" });
}

describe("Applications", () => {
  it("keeps an unfinished note with its application when another row opens", async () => {
    const list = renderScreen();
    fireEvent.click(
      await within(list).findByRole("button", { name: /^Northfield 1 / }),
    );
    const first = await screen.findByRole("region", {
      name: "Application to Northfield 1",
    });
    fireEvent.click(within(first).getByRole("button", { name: "Note" }));
    fireEvent.change(
      within(first).getByRole("textbox", { name: "Note title" }),
      {
        target: { value: "Ask Northfield 1 about the design team" },
      },
    );
    fireEvent.click(
      within(list).getByRole("button", { name: /^Northfield 2 / }),
    );
    const second = await screen.findByRole("region", {
      name: "Application to Northfield 2",
    });
    expect(
      within(second).getByRole<HTMLInputElement>("textbox", {
        name: /title$/,
      }).value,
    ).toBe("");
    fireEvent.click(
      within(list).getByRole("button", { name: /^Northfield 1 / }),
    );
    const restored = await screen.findByRole("region", {
      name: "Application to Northfield 1",
    });
    expect(
      within(restored).getByRole<HTMLInputElement>("textbox", {
        name: "Note title",
      }).value,
    ).toBe("Ask Northfield 1 about the design team");
  });

  it("keeps list preferences for later without advertising them as rendered board columns", async () => {
    const view = {
      layout: "board",
      density: "comfortable",
      columns: ["status", "next"],
    };
    render(
      <MemoryRouter
        initialEntries={[
          `/job-finder/applications?applications=${encodeURIComponent(JSON.stringify(view))}`,
        ]}
      >
        <ToastProvider>
          <ApplicationsScreen />
        </ToastProvider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(
        JSON.parse(
          document
            .querySelector("[data-application-list-state]")!
            .getAttribute("data-application-list-state")!,
        ),
      ).toMatchObject({ layout: "board" });
      expect(
        JSON.parse(window.localStorage.getItem("nestor.applications.view")!),
      ).toEqual(view);
    });
    expect(
      screen
        .getByRole("button", { name: "Board" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const displayed: unknown = JSON.parse(
      document
        .querySelector("[data-application-list-state]")!
        .getAttribute("data-application-list-state")!,
    );
    expect(displayed).not.toHaveProperty("density");
    expect(displayed).not.toHaveProperty("columns");
  });

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
  it("applies the Assistant's filter, selection and focused application to the real list", async () => {
    const view = {
      statuses: ["applied"],
      text: "Northfield 1",
      selectedIds: [ids[0]!],
    };
    renderScreen(
      `/job-finder/applications?jobId=${ids[0]}&applications=${encodeURIComponent(JSON.stringify(view))}`,
    );
    await waitFor(() => {
      const state: unknown = JSON.parse(
        document
          .querySelector("[data-application-list-state]")!
          .getAttribute("data-application-list-state")!,
      );
      expect(state).toMatchObject(view);
    });
    const detail = await screen.findByRole("region", {
      name: "Application to Northfield 1",
    });
    expect(detail.getAttribute("data-job-detail-id")).toBe(String(ids[0]));
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Applications" })).queryByRole(
          "button",
          { name: /^Northfield 2 / },
        ),
      ).toBeNull(),
    );
  });

  it("offers an independent Undo for a note and updates the history", async () => {
    const list = renderScreen();
    fireEvent.click(
      await within(list).findByRole("button", { name: /^Northfield 1 / }),
    );
    const detail = await screen.findByRole("region", {
      name: "Application to Northfield 1",
    });
    fireEvent.click(within(detail).getByRole("button", { name: "Note" }));
    fireEvent.change(
      within(detail).getByRole("textbox", { name: "Note title" }),
      { target: { value: "Recruiter wants samples" } },
    );
    fireEvent.click(within(detail).getByRole("button", { name: "Add note" }));
    const undo = await screen.findByRole("button", { name: "Undo" });
    expect(
      await within(detail).findByText("Recruiter wants samples", {
        exact: false,
      }),
    ).toBeTruthy();
    fireEvent.click(undo);
    await waitFor(() =>
      expect(
        createTrackerStore(store)
          .events(ids[0]!)
          .filter((event) => event.kind === "note"),
      ).toEqual([]),
    );
    expect(createTrackerStore(store).getRow(ids[0]!)?.status).toBe("applied");
  });

  it("opens or stops an application Apply has filled in, and shows what it wrote", async () => {
    applyWrites(ids[1]!, "state = 'ready'");
    const list = renderScreen();
    fireEvent.click(
      await within(list).findByRole("button", { name: /^Northfield 2 / }),
    );
    const detail = await screen.findByRole("region", {
      name: "Application to Northfield 2",
    });

    expect(
      await within(detail).findByText("What Apply filled in"),
    ).toBeTruthy();
    expect(
      within(detail).getByText("I build design systems for clinics."),
    ).toBeTruthy();
    expect(within(detail).getByText("Resume - Northfield.pdf")).toBeTruthy();

    fireEvent.click(
      within(detail).getByRole("button", { name: "Open application" }),
    );
    await waitFor(() => expect(openApplication).toHaveBeenCalledTimes(1));

    fireEvent.click(within(detail).getByRole("button", { name: "Stop" }));
    await screen.findByText("Stopped. Apply won't send it.");
    await waitFor(() =>
      expect(within(detail).queryByRole("button", { name: "Stop" })).toBeNull(),
    );
    expect(
      within(detail).queryByRole("button", { name: "Open application" }),
    ).toBeNull();
  });
});

describe("a failed application is never a dead end", () => {
  it("one click tries a run that failed before sending again", async () => {
    applyWrites(
      ids[1]!,
      "state = 'failed', error = 'The page tried to send the application on its own.'",
    );
    const list = renderScreen();
    fireEvent.click(
      await within(list).findByRole("button", { name: /^Northfield 2 / }),
    );
    const detail = await screen.findByRole("region", {
      name: "Application to Northfield 2",
    });
    expect(
      await within(detail).findByText(
        "Apply couldn’t finish this application. Nothing was sent.",
      ),
    ).toBeTruthy();
    fireEvent.click(
      await within(detail).findByRole("button", { name: "Try again" }),
    );
    await screen.findByText("Trying again");
    expect(
      createApplicationStore(store).getApplication(
        createApplicationStore(store).forJobs([ids[1]!])[0]!.id,
      )?.state,
    ).toBe("queued");
  });

  it("a run the guarded send already tried offers nothing that could send twice", async () => {
    applyWrites(ids[1]!, "state = 'failed'");
    receipt = {
      outcome: "not_submitted",
      attemptedAt: new Date().toISOString(),
      verifiedAt: null,
      evidence: [],
    } as unknown as ApplicationDetails["receipt"];
    const list = renderScreen();
    fireEvent.click(
      await within(list).findByRole("button", { name: /^Northfield 2 / }),
    );
    const detail = await screen.findByRole("region", {
      name: "Application to Northfield 2",
    });
    expect(await within(detail).findByText("Not sent")).toBeTruthy();
    expect(
      within(detail).queryByRole("button", { name: "Try again" }),
    ).toBeNull();
    expect(
      within(detail).queryByRole("button", { name: "Open application" }),
    ).toBeNull();
  });
});

describe("saved application views", () => {
  it("opens a single saved view directly instead of a one-option dropdown", async () => {
    renderScreen();
    const filter = screen.getByRole<HTMLInputElement>("searchbox", {
      name: "Find an application",
    });
    fireEvent.change(filter, { target: { value: "Northfield 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name this view" }), {
      target: { value: "My first view" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved the view My first view");
    const open = await screen.findByRole("button", {
      name: "Open view My first view",
    });
    expect(screen.queryByRole("combobox", { name: "Saved views" })).toBeNull();
    fireEvent.change(filter, { target: { value: "" } });
    fireEvent.click(open);
    expect(filter.value).toBe("Northfield 1");
  });

  it("can visibly cancel naming a saved view without saving it", async () => {
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name this view" }), {
      target: { value: "A cancelled view" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("textbox", { name: "Name this view" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Save view" })).toBeTruthy();
    expect(await window.nestor.tracker.run("list_views", {})).toEqual({
      views: [],
    });
  });
});
