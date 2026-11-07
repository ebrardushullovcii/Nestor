// @vitest-environment jsdom

import {
  SubmissionOutcomeRecordSchema,
  type ApplicationDetails,
  type FoundJob,
} from "@nestor/contracts";
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
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
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
  openApplication = vi.fn(() =>
    Promise.resolve({ opened: true, retained: true }),
  );
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
                      // A multi-select is kept as its exact options.
                      {
                        question: "Select your skills",
                        answer: '["Writing, editing","Mentoring"]',
                        source: "your matching saved answer or profile fact",
                        written: false,
                        groundedIn: [],
                      },
                      {
                        question: "Anything else?",
                        answer: '["not", 1] is what I wrote',
                        source: "your matching saved answer or profile fact",
                        written: false,
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
        retryApplication: ({ id }: { id: number }) =>
          Promise.resolve(
            applications.retryPreparation(
              id,
              applications.getApplication(id)!.attempt,
            ),
          ),
        reportApplicationSend: vi.fn(() => Promise.resolve(true)),
        sendApplication: vi.fn(() => Promise.resolve(false)),
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
  it.each([
    {
      recorded: "submitted state",
      state: "submitted",
      timestamp: false,
      confirmedReceipt: false,
    },
    {
      recorded: "submitted timestamp",
      state: "ready",
      timestamp: true,
      confirmedReceipt: false,
    },
    {
      recorded: "confirmed receipt on a Ready row",
      state: "ready",
      timestamp: false,
      confirmedReceipt: true,
    },
    {
      recorded: "confirmed receipt on an uncertain row",
      state: "uncertain",
      timestamp: false,
      confirmedReceipt: true,
    },
  ])(
    "never offers Send or outcome reports for $recorded",
    async ({ state, timestamp, confirmedReceipt }) => {
      applyWrites(
        ids[1]!,
        `state='${state}',submitted_at=${timestamp ? "updated_at" : "NULL"}`,
      );
      const row = createApplicationStore(store).forJobs([ids[1]!])[0]!;
      if (confirmedReceipt)
        receipt = SubmissionOutcomeRecordSchema.parse({
          id: "confirmed",
          preflightId: "confirmed",
          idempotencyKey: "confirmed",
          authorityEnvelopeId: "confirmed",
          authorityRevision: 1,
          runId: `application_run_${row.id}`,
          jobId: String(row.jobId),
          resultId: `application_${row.id}_attempt_${row.attempt}`,
          applicationRecordId: `application_${row.id}`,
          outcome: "submitted",
          attemptedAt: row.updatedAt,
          verifiedAt: row.updatedAt,
          evidence: [
            {
              id: "confirmation",
              kind: "operator_confirmation",
              observedAt: row.updatedAt,
              destination: {
                origin: "https://board.example.test",
                safePath: `/jobs/${row.jobId}`,
              },
              artifactRefId: null,
              summary: "The person confirmed that this application was sent.",
            },
          ],
          retry: { eligible: false, blockReason: "submission_confirmed" },
        });
      const list = renderScreen();
      const selected = await within(list).findByRole("button", {
        name: /^Northfield 2,/,
      });
      fireEvent.click(selected);
      const detail = await screen.findByRole("region", {
        name: "Application to Northfield 2",
      });
      await within(detail).findByText(
        confirmedReceipt ? "What was sent" : "What Apply filled in",
      );
      expect(selected.getAttribute("data-selected")).toBe("true");
      expect(
        within(detail).queryByRole("button", { name: /^Send$/ }),
      ).toBeNull();
      expect(
        within(detail).queryByRole("button", {
          name: "It went through",
          hidden: true,
        }),
      ).toBeNull();
      expect(
        within(detail).queryByRole("button", {
          name: "It didn’t go through",
          hidden: true,
        }),
      ).toBeNull();
      expect(
        within(detail).queryByRole("button", { name: "Stop", hidden: true }),
      ).toBeNull();
    },
  );

  it("keeps Send on an unsent Ready record when its separate tracker stage was manually set to Applied", async () => {
    applyWrites(ids[1]!, "state='ready'");
    store
      .sql(
        "UPDATE tracker SET status='applied',applied_at=status_at WHERE job_id=?",
      )
      .run(ids[1]!);
    const list = renderScreen();
    const selected = await within(list).findByRole("button", {
      name: /^Northfield 2,/,
    });
    fireEvent.click(selected);
    const detail = await screen.findByRole("region", {
      name: "Application to Northfield 2",
    });
    await within(detail).findByRole("button", { name: /^Send$/ });
    expect(selected.getAttribute("data-selected")).toBe("true");
    expect(
      within(detail).getByRole("combobox", { name: "Status" }),
    ).toBeTruthy();
    expect(createApplicationStore(store).forJobs([ids[1]!])[0]).toMatchObject({
      state: "ready",
      submittedAt: null,
    });
    expect(receipt).toBeNull();
  });

  it.each(["confirm_before_submit", "autonomous_submit"])(
    "Ready Send in %s uses the send bridge once while busy",
    async (mode) => {
      applyWrites(ids[1]!, `state='ready', mode='${mode}'`);
      let finish!: (sent: boolean) => void;
      const send = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      );
      Object.assign(window.nestor.jobFinder, { sendApplication: send });
      const list = renderScreen();
      fireEvent.click(
        await within(list).findByRole("button", { name: /^Northfield 2,/ }),
      );
      const detail = await screen.findByRole("region", {
        name: "Application to Northfield 2",
      });
      const button = await within(detail).findByRole("button", {
        name: /^Send$/,
      });
      fireEvent.click(button);
      fireEvent.click(button);
      expect(send).toHaveBeenCalledOnce();
      expect(openApplication).not.toHaveBeenCalled();
      applyWrites(ids[1]!, "state='submitted',submitted_at=updated_at");
      finish(true);
      await screen.findByText("Application sent");
      expect(
        within(detail).queryByRole("button", { name: /^Send$/ }),
      ).toBeNull();
    },
  );

  it.each(["ready", "stopped", "failed"])(
    "a person can record %s sent or not sent without opening or sending",
    async (state) => {
      applyWrites(ids[1]!, `state='${state}'`);
      const report = vi.fn(() => Promise.resolve(true));
      const send = vi.fn();
      Object.assign(window.nestor.jobFinder, {
        reportApplicationSend: report,
        sendApplication: send,
      });
      const list = renderScreen();
      fireEvent.click(
        await within(list).findByRole("button", { name: /^Northfield 2,/ }),
      );
      const detail = await screen.findByRole("region", {
        name: "Application to Northfield 2",
      });
      fireEvent.click(await within(detail).findByText("More actions…"));
      fireEvent.click(
        within(detail).getByRole("button", { name: "It went through" }),
      );
      await screen.findByText("Moved to Applied");
      fireEvent.click(
        within(detail).getByRole("button", { name: "It didn’t go through" }),
      );
      await screen.findByText("Marked as not sent");
      expect(report.mock.calls).toEqual([
        [
          {
            id: createApplicationStore(store).forJobs([ids[1]!])[0]!.id,
            sent: true,
          },
        ],
        [
          {
            id: createApplicationStore(store).forJobs([ids[1]!])[0]!.id,
            sent: false,
          },
        ],
      ]);
      expect(send).not.toHaveBeenCalled();
      expect(openApplication).not.toHaveBeenCalled();
    },
  );

  it("keeps an unfinished note with its application when another row opens", async () => {
    const list = renderScreen();
    fireEvent.click(
      await within(list).findByRole("button", { name: /^Northfield 1,/ }),
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
      within(list).getByRole("button", { name: /^Northfield 2,/ }),
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
      within(list).getByRole("button", { name: /^Northfield 1,/ }),
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

  it("gives the board the whole width, folds empty stages and opens a card's details as a sheet", async () => {
    window.localStorage.setItem(
      "nestor.applications.view",
      JSON.stringify({ layout: "board" }),
    );
    render(
      <MemoryRouter>
        <ToastProvider>
          <ApplicationsScreen />
        </ToastProvider>
      </MemoryRouter>,
    );
    const board = await screen.findByRole("region", {
      name: "Applications by stage",
    });
    // Empty stages fold into one strip of named, horizontal drop targets.
    const emptyStages = await within(board).findByRole("region", {
      name: "Stages with no applications",
    });
    const heardBack = within(emptyStages).getByRole("listitem", {
      name: "Heard back, 0",
    });
    // A quiet line under "Empty stages": the name, no "0" placeholder.
    expect(heardBack.textContent).toBe("Heard back");
    expect(heardBack.querySelector("[data-stage-dot]")).not.toBeNull();
    expect(board.innerHTML).not.toContain("writing-mode");
    const applied = await within(board).findByRole("region", {
      name: "Applied, 1",
    });
    expect(applied.querySelector('[data-stage-dot="applied"]')).not.toBeNull();
    // No details pane beside the board until a card is clicked.
    expect(
      screen.queryByRole("dialog", { name: "Application details" }),
    ).toBeNull();
    fireEvent.click(
      await within(applied).findByRole("button", { name: /^Northfield 1/ }),
    );
    const sheet = await screen.findByRole("dialog", {
      name: "Application details",
    });
    await within(sheet).findByRole("region", {
      name: "Application to Northfield 1",
    });
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Application details" }),
      ).toBeNull(),
    );
  });

  it("moves a sent application on, and Undo takes it back", async () => {
    const list = renderScreen();
    fireEvent.click(
      await within(list).findByRole("button", { name: /^Northfield 1,/ }),
    );
    const detail = await screen.findByRole("region", {
      name: "Application to Northfield 1",
    });
    // One status menu, with a progress line through the open stages.
    expect(
      within(detail).getByRole("list", { name: "Stage 1 of 5: Applied" }),
    ).toBeTruthy();
    fireEvent.change(within(detail).getByRole("combobox", { name: "Status" }), {
      target: { value: "replied" },
    });

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
      name: /^Northfield 2,/,
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
          { name: /^Northfield 2,/ },
        ),
      ).toBeNull(),
    );
  });

  it("offers an independent Undo for a note and updates the history", async () => {
    const list = renderScreen();
    fireEvent.click(
      await within(list).findByRole("button", { name: /^Northfield 1,/ }),
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
      await within(list).findByRole("button", { name: /^Northfield 2,/ }),
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
    // The stored option list reads as the person's choices; other text,
    // even when it starts like a list, is shown exactly as written.
    expect(
      within(detail).getByText("Writing, editing, Mentoring"),
    ).toBeTruthy();
    expect(within(detail).getByText('["not", 1] is what I wrote')).toBeTruthy();
    expect(within(detail).queryByText(/\["Writing/u)).toBeNull();
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
    // Its own status: not counted or listed as Applying, never "Applying
    // since", and a stage of its own while it has any.
    const row = await within(list).findByRole("button", {
      name: /^Northfield 2,/,
    });
    await waitFor(() =>
      expect(row.getAttribute("aria-label")).toMatch(
        /, Could not apply, Tried [A-Z][a-z]{2} \d{1,2}(,|$)/,
      ),
    );
    expect(row.getAttribute("aria-label")).not.toContain("Applying since");
    expect(
      await screen.findByRole("option", { name: "Could not apply (1)" }),
    ).toBeTruthy();
    // Still one of All: counted once, under its own stage.
    expect(
      screen.getByRole("option", {
        name: `All stages (${createApplicationStore(store).forJobs(ids).length})`,
      }),
    ).toBeTruthy();
    const applying = screen.getByRole("option", { name: /^Applying \(/ });
    expect(applying.textContent).not.toContain(
      `(${createApplicationStore(store).forJobs(ids).length})`,
    );
    fireEvent.click(row);
    const detail = await screen.findByRole("region", {
      name: "Application to Northfield 2",
    });
    // The cause is not an unverified verdict about what the site received.
    const line = await within(detail).findByText(
      "The page tried to send the application on its own.",
    );
    expect(line.className).not.toContain("warning");
    // Both ways on, as its row says.
    expect(
      within(detail).getByRole("button", { name: "Apply by hand" }),
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
      await within(list).findByRole("button", { name: /^Northfield 2,/ }),
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

describe("a stopped or unconfirmed application is never a dead end", () => {
  it("one click applies again to a run stopped before sending", async () => {
    applyWrites(ids[1]!, "state = 'stopped'");
    const list = renderScreen();
    fireEvent.click(
      await within(list).findByRole("button", { name: /^Northfield 2,/ }),
    );
    const detail = await screen.findByRole("region", {
      name: "Application to Northfield 2",
    });
    fireEvent.click(
      await within(detail).findByRole("button", { name: "Apply again" }),
    );
    await screen.findByText("Applying again");
    const applications = createApplicationStore(store);
    expect(
      applications.getApplication(applications.forJobs([ids[1]!])[0]!.id)
        ?.state,
    ).toBe("queued");
  });

  it("after the person says it was not sent, Apply again is there", async () => {
    applyWrites(
      ids[1]!,
      "state = 'stopped', error = 'You checked the site: this application was not sent.'",
    );
    receipt = {
      outcome: "not_submitted",
      attemptedAt: new Date().toISOString(),
      verifiedAt: null,
      evidence: [],
    } as unknown as ApplicationDetails["receipt"];
    const list = renderScreen();
    fireEvent.click(
      await within(list).findByRole("button", { name: /^Northfield 2,/ }),
    );
    const detail = await screen.findByRole("region", {
      name: "Application to Northfield 2",
    });
    expect(
      await within(detail).findByRole("button", { name: "Apply again" }),
    ).toBeTruthy();
  });

  it("the person says what the site shows after a send the app could not confirm", async () => {
    applyWrites(ids[1]!, "state = 'uncertain'");
    const reportApplicationSend = vi.fn(() => Promise.resolve(true));
    const openApplication = vi.fn(() =>
      Promise.resolve({ opened: true, retained: true }),
    );
    Object.assign(window.nestor.jobFinder, {
      reportApplicationSend,
      openApplication,
    });
    receipt = {
      outcome: "outcome_uncertain",
      attemptedAt: new Date().toISOString(),
      verifiedAt: null,
      evidence: [],
      browserAction: { reason: "confirmation_timeout", requestsAfterClick: [] },
    } as unknown as ApplicationDetails["receipt"];
    const list = renderScreen();
    fireEvent.click(
      await within(list).findByRole("button", { name: /^Northfield 2,/ }),
    );
    const detail = await screen.findByRole("region", {
      name: "Application to Northfield 2",
    });
    expect(
      within(detail).getByText(
        "Apply could not tell whether it went through. Check the site, then say what you found.",
      ),
    ).toBeTruthy();
    expect(
      await within(detail).findByText(
        "No application request or receipt was confirmed after the press. Nestor will not send it again automatically.",
      ),
    ).toBeTruthy();
    expect(
      within(detail).queryByRole("button", { name: "the form" }),
    ).toBeNull();
    fireEvent.click(within(detail).getByRole("button", { name: "Check site" }));
    await screen.findByText("Opened the application page");
    expect(openApplication).toHaveBeenCalledOnce();
    expect(
      within(detail).queryByRole("button", { name: "Try again" }),
    ).toBeNull();
    fireEvent.click(
      await within(detail).findByRole("button", { name: "It went through" }),
    );
    await screen.findByText("Moved to Applied");
    const applications = createApplicationStore(store);
    expect(reportApplicationSend).toHaveBeenCalledExactlyOnceWith({
      id: applications.forJobs([ids[1]!])[0]!.id,
      sent: true,
    });
  });
});

describe("one main action per screen", () => {
  it("the page's Follow up is secondary while an application is open, whose own action leads", async () => {
    // A reminder that is already due on the submitted application.
    store
      .sql(
        "INSERT INTO tracker_events (job_id, kind, at, title, due_at) VALUES (?, 'reminder', ?, 'Synthetic follow-up', ?)",
      )
      .run(ids[0]!, Date.now() - 60_000, Date.now() - 60_000);
    applyWrites(ids[1]!, "state = 'failed'");
    const list = renderScreen();
    const followUp = await screen.findByRole("button", {
      name: "Follow up on 1 application",
    });
    fireEvent.click(
      await within(list).findByRole("button", { name: /^Northfield 2,/ }),
    );
    const detail = await screen.findByRole("region", {
      name: "Application to Northfield 2",
    });
    const own = await within(detail).findByRole("button", {
      name: "Try again",
    });
    expect(own.getAttribute("data-variant")).toBe("primary");
    await waitFor(() =>
      expect(followUp.getAttribute("data-variant")).toBe("outline"),
    );
  });
});

describe("an empty Applications list", () => {
  it("leads to the next real step: the approved resumes, where Apply starts one", async () => {
    store.sql("DELETE FROM tracker_events").run();
    store.sql("DELETE FROM tracker").run();
    store.sql("DELETE FROM applications").run();
    // Two approved resumes wait for Apply.
    Object.assign(window.nestor.jobs, {
      run: (name: string) =>
        Promise.resolve(
          name === "stage_counts"
            ? { found: 4, hidden: 0, shortlisted: 0, resume: 2, applied: 0 }
            : null,
        ),
    });
    function Where() {
      const location = useLocation();
      return <p>{`At ${location.pathname}${location.search}`}</p>;
    }
    render(
      <MemoryRouter initialEntries={["/job-finder/applications"]}>
        <ToastProvider>
          <Routes>
            <Route
              element={<ApplicationsScreen />}
              path="/job-finder/applications"
            />
            <Route element={<Where />} path="/job-finder/review-queue" />
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Apply to 2 approved jobs" }),
    );
    await screen.findByText("At /job-finder/review-queue?tab=approved");
  });

  it("with nothing found yet, leads to a first search, not an empty tab", async () => {
    store.sql("DELETE FROM tracker_events").run();
    store.sql("DELETE FROM tracker").run();
    store.sql("DELETE FROM applications").run();
    Object.assign(window.nestor.jobs, {
      run: () =>
        Promise.resolve({
          found: 0,
          hidden: 0,
          shortlisted: 0,
          resume: 0,
          applied: 0,
        }),
    });
    render(
      <MemoryRouter initialEntries={["/job-finder/applications"]}>
        <ToastProvider>
          <ApplicationsScreen />
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("button", { name: "Find jobs" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Go to approved resumes" }),
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

describe("an application waiting on the person", () => {
  it("leads with Answer in Needs you, opening Needs you on its question", async () => {
    applyWrites(ids[1]!, "state = 'needs_you'");
    const run = vi.fn((name: string) =>
      Promise.resolve(
        name === "application_needs" ? [{ id: 42, kind: "question" }] : [],
      ),
    );
    Object.assign(window.nestor, { needsYou: { run } });
    let path = "";
    function Where() {
      const location = useLocation();
      path = `${location.pathname}${location.search}`;
      return null;
    }
    render(
      <MemoryRouter initialEntries={["/job-finder/applications"]}>
        <ToastProvider>
          <Routes>
            <Route
              element={<ApplicationsScreen />}
              path="/job-finder/applications"
            />
            <Route element={null} path="/job-finder/actions" />
          </Routes>
          <Where />
        </ToastProvider>
      </MemoryRouter>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /^Northfield 2,/ }),
    );
    const answer = await screen.findByRole("button", {
      name: "Answer in Needs you",
    });
    // The filled action; opening the site is the secondary one beside it.
    expect(answer.getAttribute("data-variant")).toBe("primary");
    expect(
      screen
        .getByRole("button", { name: "Open application" })
        .getAttribute("data-variant"),
    ).toBe("outline");
    // Stop rides quietly on Apply's status line, not in the action row, so
    // the two forward actions keep one row.
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop.getAttribute("data-variant")).toBe("ghost");
    expect(stop.parentElement?.contains(answer)).toBe(false);
    expect(answer.parentElement?.children).toHaveLength(2);
    fireEvent.click(answer);
    await waitFor(() => expect(path).toContain("/job-finder/actions?needs="));
    const view: unknown = JSON.parse(
      new URLSearchParams(path.split("?")[1]).get("needs")!,
    );
    expect(view).toEqual({ tab: "tasks", focusId: 42 });
  });
});

describe("the ACTION NEEDED line on an application", () => {
  /** The detail's lead line, once Apply's record has loaded into it. */
  async function leadLine(detail: HTMLElement) {
    return waitFor(() => {
      const line = detail.querySelector("[data-action-needed]");
      if (!line?.textContent?.includes("Sent:")) throw new Error("No line");
      return line.textContent;
    });
  }

  it("names the site and the recorded step of a site sign-in, what was filled and that no send is recorded", async () => {
    applyWrites(ids[1]!, "state = 'needs_you'");
    const run = vi.fn((name: string) =>
      Promise.resolve(
        name === "application_needs"
          ? [
              {
                id: 43,
                kind: "sign_in",
                key: "access:https://accounts.google.com",
                scope: {
                  country: "",
                  siteOrigin: "https://accounts.google.com",
                },
                prompt: "Google needs you to finish this step.",
                input: "text",
                options: [],
                openedAt: new Date().toISOString(),
              },
            ]
          : [],
      ),
    );
    Object.assign(window.nestor, { needsYou: { run } });
    const list = renderScreen();
    fireEvent.click(
      await within(list).findByRole("button", { name: /^Northfield 2,/ }),
    );
    const detail = await screen.findByRole("region", {
      name: "Application to Northfield 2",
    });
    expect(await leadLine(detail)).toMatch(
      /^ACTION NEEDED — accounts\.google\.com: Google needs you to finish this step\. Then press “Check again” in Needs you\. Done so far: filled \d+ fields? \(.+\)\. Sent: no application send recorded\. Whether the site saved answers on its own is not verified\.$/u,
    );
    // The line leads; the actions and the record stay as they were.
    expect(
      within(detail).getByRole("button", { name: "Finish in Needs you" }),
    ).toBeTruthy();
    expect(within(detail).getByText("What Apply filled in")).toBeTruthy();
  });

  it("keeps an unconfirmed send unknown and leads with settling it on the site", async () => {
    applyWrites(ids[1]!, "state = 'uncertain'");
    receipt = {
      outcome: "outcome_uncertain",
      attemptedAt: new Date().toISOString(),
      verifiedAt: null,
      evidence: [],
      browserAction: { reason: "confirmation_timeout", requestsAfterClick: [] },
    } as unknown as ApplicationDetails["receipt"];
    const list = renderScreen();
    fireEvent.click(
      await within(list).findByRole("button", { name: /^Northfield 2,/ }),
    );
    const detail = await screen.findByRole("region", {
      name: "Application to Northfield 2",
    });
    const line = await leadLine(detail);
    expect(line).toMatch(
      /^ACTION NEEDED — Northfield 2: Check your account on the employer’s site, then press “It went through” or “It didn’t go through”\. /u,
    );
    expect(line).toMatch(
      /Sent: unknown\. Nestor pressed send \(.+\), but the site has not confirmed receipt\./u,
    );
    expect(line).not.toMatch(/Sent: (?:yes|no)|nothing was sent/iu);
    expect(
      within(detail).getByRole("button", { name: "It went through" }),
    ).toBeTruthy();
    expect(
      within(detail).getByRole("button", { name: "It didn’t go through" }),
    ).toBeTruthy();
  });
});
