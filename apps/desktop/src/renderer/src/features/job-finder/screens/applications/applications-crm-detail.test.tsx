// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  ApplicationCrmSettingsSchema,
  ApplicationRecordSchema,
} from "@nestor/contracts";
import type {
  ApplicationCrmInterview,
  ApplicationCrmMutation,
  ApplicationCrmMutationInput,
  ApplicationCrmReminder,
  ApplicationRecord,
} from "@nestor/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ApplicationsCrmDetail } from "./applications-crm-detail";

const canonicalFieldTokens = [
  "border-(--field-border)",
  "bg-(--field)",
  "outline-none",
  "focus-visible:border-(--field-focus-border)",
  "focus-visible:bg-(--field-strong)",
  "focus-visible:shadow-[var(--field-focus-shadow)]",
];

function expectCanonicalFieldClasses(control: HTMLElement) {
  for (const token of canonicalFieldTokens) {
    expect(control.className).toContain(token);
  }
  expect(control.className).not.toContain("border-input");
  expect(control.className).not.toContain("bg-background");
  expect(control.className).not.toContain("ring-[3px]");
}

let appRoot: HTMLDivElement;

beforeEach(() => {
  appRoot = document.createElement("div");
  appRoot.id = "root";
  document.body.append(appRoot);
});

afterEach(() => {
  cleanup();
  appRoot.remove();
  vi.restoreAllMocks();
});

describe("ApplicationsCrmDetail", () => {
  test("renders preparation-only approval timeline copy without a submit approval claim", () => {
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          listCandidateAssets: vi.fn(() => Promise.resolve({ assets: [] })),
        },
      },
    });
    const record = ApplicationRecordSchema.parse({
      id: "application_1",
      jobId: "job_1",
      title: "Engineer",
      company: "Example",
      status: "approved",
      lastActionLabel: "Prepared",
      nextActionLabel: "Review",
      lastUpdatedAt: "2026-08-15T10:00:00.000Z",
      crm: {
        revision: 3,
        stage: "ready_for_approval",
        stageChangedAt: "2026-08-15T10:00:00.000Z",
        events: [
          {
            id: "event_prepare_approval",
            at: "2026-08-15T10:00:00.000Z",
            kind: "application_prepare",
            title: "Application preparation approval requested",
            detail:
              "Your review permits opening and filling this application only. It never permits submission.",
            source: "application_prepare",
          },
        ],
      },
    });

    render(
      <ApplicationsCrmDetail
        onExport={vi.fn(() => Promise.resolve())}
        onMutate={vi.fn(() => Promise.resolve())}
        record={record}
        settings={ApplicationCrmSettingsSchema.parse({})}
      />,
      { container: appRoot },
    );

    expect(
      screen.getByText("Application preparation approval requested"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Your review permits opening and filling this application only. It never permits submission.",
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /automatic submit|submit approval/i,
    );
  });

  test("translates only the exact legacy submit-approval event for display", () => {
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          listCandidateAssets: vi.fn(() => Promise.resolve({ assets: [] })),
        },
      },
    });
    const legacyTitle = "Automatic submit approval requested";
    const legacyDetail =
      "A run-scoped submit approval was created for this job. The current safe implementation still stops before any final submit action.";
    const customTitle = "Note about automatic submit approval requested";
    const customDetail =
      "User note: automatic submit approval wording needs clarification.";
    const record = ApplicationRecordSchema.parse({
      id: "application_legacy",
      jobId: "job_legacy",
      title: "Engineer",
      company: "Example",
      status: "approved",
      lastActionLabel: "Prepared",
      nextActionLabel: "Review",
      lastUpdatedAt: "2026-08-15T10:00:00.000Z",
      crm: {
        revision: 3,
        stage: "ready_for_approval",
        stageChangedAt: "2026-08-15T10:00:00.000Z",
        events: [
          {
            id: "event_legacy",
            at: "2026-08-15T10:00:00.000Z",
            kind: "automation",
            title: legacyTitle,
            detail: legacyDetail,
            source: "automation",
          },
          {
            id: "event_custom",
            at: "2026-08-15T10:01:00.000Z",
            kind: "note_changed",
            title: customTitle,
            detail: customDetail,
            source: "user",
          },
          {
            id: "event_current",
            at: "2026-08-15T10:02:00.000Z",
            kind: "application_prepare",
            title: "Application preparation approval requested",
            detail:
              "Your review permits opening and filling this application only. It never permits submission.",
            source: "application_prepare",
          },
        ],
      },
    });

    render(
      <ApplicationsCrmDetail
        onExport={vi.fn(() => Promise.resolve())}
        onMutate={vi.fn(() => Promise.resolve())}
        record={record}
        settings={ApplicationCrmSettingsSchema.parse({})}
      />,
      { container: appRoot },
    );

    expect(
      screen.getByText(
        "Historical legacy event: preparation approval requested",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Legacy record: this requested approval to open and fill the application for preparation only. It granted no authority to submit.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(legacyTitle)).toBeNull();
    expect(screen.queryByText(legacyDetail)).toBeNull();
    expect(screen.getByText(customTitle)).toBeTruthy();
    expect(screen.getByText(customDetail)).toBeTruthy();
    expect(
      screen.getByText("Application preparation approval requested"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Your review permits opening and filling this application only. It never permits submission.",
      ),
    ).toBeTruthy();
    expect(record.crm?.events[0]?.title).toBe(legacyTitle);
    expect(record.crm?.events[0]?.detail).toBe(legacyDetail);
  });

  test("sends a revision-bound manual stage mutation and explains the no-submit boundary", async () => {
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          listCandidateAssets: vi.fn(() => Promise.resolve({ assets: [] })),
        },
      },
    });
    const record = ApplicationRecordSchema.parse({
      id: "application_1",
      jobId: "job_1",
      title: "Engineer",
      company: "Example",
      status: "approved",
      lastActionLabel: "Prepared",
      nextActionLabel: "Review",
      lastUpdatedAt: "2026-08-15T10:00:00.000Z",
      crm: {
        revision: 3,
        stage: "ready_for_approval",
        stageChangedAt: "2026-08-15T10:00:00.000Z",
      },
    });
    const onMutate = vi.fn(() => Promise.resolve());

    render(
      <ApplicationsCrmDetail
        onExport={vi.fn(() => Promise.resolve())}
        onMutate={onMutate}
        record={record}
        settings={ApplicationCrmSettingsSchema.parse({})}
      />,
      { container: appRoot },
    );

    expect(document.body.textContent).toContain(
      "Nothing here contacts the employer or submits an application",
    );
    expect(document.body.textContent).toContain(
      "Exports contain these tracking facts, not submission evidence",
    );
    fireEvent.change(screen.getByLabelText("Stage"), {
      target: { value: "applied" },
    });
    await waitFor(() =>
      expect(onMutate).toHaveBeenCalledWith({
        applicationRecordId: "application_1",
        expectedRevision: 3,
        mutation: {
          type: "set_stage",
          stage: "applied",
          customStageId: null,
          note: null,
        },
      }),
    );
  });

  test("saves a stage the person picks at once, with no confirmation step", async () => {
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          listCandidateAssets: vi.fn(() => Promise.resolve({ assets: [] })),
        },
      },
    });
    const onMutate = vi.fn(() => Promise.resolve());
    const record = ApplicationRecordSchema.parse({
      id: "application_1",
      jobId: "job_1",
      title: "Engineer",
      company: "Example",
      status: "submitted",
      lastActionLabel: "Applied manually",
      nextActionLabel: null,
      lastUpdatedAt: "2026-08-15T10:00:00.000Z",
      crm: {
        revision: 4,
        stage: "applied",
        stageChangedAt: "2026-08-15T10:00:00.000Z",
        appliedAt: "2026-08-15T10:00:00.000Z",
      },
    });

    render(
      <ApplicationsCrmDetail
        onExport={vi.fn(() => Promise.resolve())}
        onMutate={onMutate}
        record={record}
        settings={ApplicationCrmSettingsSchema.parse({})}
      />,
      { container: appRoot },
    );

    fireEvent.change(
      screen.getByRole<HTMLSelectElement>("combobox", { name: "Stage" }),
      { target: { value: "interview" } },
    );

    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() =>
      expect(onMutate).toHaveBeenCalledWith({
        applicationRecordId: "application_1",
        expectedRevision: 4,
        mutation: {
          type: "set_stage",
          stage: "interview",
          customStageId: null,
          note: null,
        },
      }),
    );
  });

  test("names the tracked role and company in its header", () => {
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          listCandidateAssets: vi.fn(() => Promise.resolve({ assets: [] })),
        },
      },
    });
    const record = ApplicationRecordSchema.parse({
      id: "application_1",
      jobId: "job_1",
      title: "Senior Platform Engineer",
      company: "Signal Systems",
      status: "approved",
      lastActionLabel: "Prepared",
      nextActionLabel: "Review",
      lastUpdatedAt: "2026-08-15T10:00:00.000Z",
      crm: {
        stage: "ready_for_approval",
        stageChangedAt: "2026-08-15T10:00:00.000Z",
      },
    });

    render(
      <ApplicationsCrmDetail
        onExport={vi.fn(() => Promise.resolve())}
        onMutate={vi.fn(() => Promise.resolve())}
        record={record}
        settings={ApplicationCrmSettingsSchema.parse({})}
      />,
      { container: appRoot },
    );

    expect(
      screen.getByText("Senior Platform Engineer · Signal Systems"),
    ).toBeTruthy();
  });

  test("applies the canonical field recipe to editable controls", () => {
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          listCandidateAssets: vi.fn(() => Promise.resolve({ assets: [] })),
        },
      },
    });
    const record = ApplicationRecordSchema.parse({
      id: "application_1",
      jobId: "job_1",
      title: "Engineer",
      company: "Example",
      status: "approved",
      lastActionLabel: "Prepared",
      nextActionLabel: "Review",
      lastUpdatedAt: "2026-08-15T10:00:00.000Z",
      crm: {
        stage: "ready_for_approval",
        stageChangedAt: "2026-08-15T10:00:00.000Z",
      },
    });

    render(
      <ApplicationsCrmDetail
        onExport={vi.fn(() => Promise.resolve())}
        onMutate={vi.fn(() => Promise.resolve())}
        record={record}
        settings={ApplicationCrmSettingsSchema.parse({})}
      />,
      { container: appRoot },
    );

    expectCanonicalFieldClasses(screen.getByLabelText("Stage"));
    expectCanonicalFieldClasses(screen.getByLabelText("Tags"));
    expectCanonicalFieldClasses(screen.getByLabelText("Add a note"));
  });

  function stubCandidateAssets() {
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          listCandidateAssets: vi.fn(() => Promise.resolve({ assets: [] })),
        },
      },
    });
  }

  function buildCrmRecord(input: {
    id: string;
    company?: string;
    crm?: Record<string, unknown>;
    revision?: number;
  }): ApplicationRecord {
    return ApplicationRecordSchema.parse({
      id: input.id,
      jobId: `job_${input.id}`,
      title: "Engineer",
      company: input.company ?? "Example",
      status: "submitted",
      lastActionLabel: "Applied manually",
      nextActionLabel: null,
      lastUpdatedAt: "2026-08-15T10:00:00.000Z",
      ...(input.crm
        ? {
            crm: {
              revision: input.revision ?? 1,
              stage: "applied",
              stageChangedAt: "2026-08-15T10:00:00.000Z",
              ...input.crm,
            },
          }
        : {}),
    });
  }

  function renderDetail(
    record: ApplicationRecord,
    onMutate: (command: ApplicationCrmMutationInput) => Promise<void> = vi.fn(
      () => Promise.resolve(),
    ),
  ) {
    // Mirrors the production mount, which keys the detail by record id.
    return render(
      <ApplicationsCrmDetail
        key={record.id}
        onExport={vi.fn(() => Promise.resolve())}
        onMutate={onMutate}
        record={record}
        settings={ApplicationCrmSettingsSchema.parse({})}
      />,
      { container: appRoot },
    );
  }

  function listRow(listLabel: string, rowText: string): HTMLElement {
    const row = Array.from(
      screen.getByLabelText(listLabel).querySelectorAll("li"),
    ).find((item) => item.textContent?.includes(rowText));
    if (!row) throw new Error(`Missing ${listLabel} row for ${rowText}`);
    return row;
  }

  function openSection(summaryText: string): void {
    const details = screen.getByText(summaryText).closest("details");
    if (!(details instanceof HTMLDetailsElement)) {
      throw new Error(`Missing section ${summaryText}`);
    }
    details.open = true;
  }

  const recordStamp = "2026-08-15T10:00:00.000Z";

  const followUpReminder = {
    completedAt: null,
    createdAt: recordStamp,
    dueAt: "2026-09-01T09:00:00.000Z",
    id: "reminder_follow_up",
    note: null,
    status: "pending",
    title: "Follow up",
    updatedAt: recordStamp,
  } satisfies ApplicationCrmReminder;

  const prepareQuestionsReminder = {
    completedAt: null,
    createdAt: recordStamp,
    dueAt: "2026-09-04T09:00:00.000Z",
    id: "reminder_prepare",
    note: null,
    status: "pending",
    title: "Prepare questions",
    updatedAt: recordStamp,
  } satisfies ApplicationCrmReminder;

  const thankYouReminder = {
    completedAt: "2026-08-20T10:00:00.000Z",
    createdAt: recordStamp,
    dueAt: "2026-08-20T09:00:00.000Z",
    id: "reminder_thanks",
    note: null,
    status: "completed",
    title: "Send thank-you note",
    updatedAt: "2026-08-20T10:00:00.000Z",
  } satisfies ApplicationCrmReminder;

  const panelInterview = {
    contactIds: [],
    createdAt: recordStamp,
    endsAt: null,
    id: "interview_panel",
    location: null,
    meetingUrl: null,
    notes: null,
    startsAt: "2026-09-03T13:00:00.000Z",
    status: "scheduled",
    timeZone: null,
    title: "Panel interview",
    updatedAt: recordStamp,
  } satisfies ApplicationCrmInterview;

  const screeningInterview = {
    contactIds: [],
    createdAt: recordStamp,
    endsAt: null,
    id: "interview_screening",
    location: null,
    meetingUrl: null,
    notes: null,
    startsAt: "2026-09-02T11:00:00.000Z",
    status: "scheduled",
    timeZone: null,
    title: "Screening call",
    updatedAt: recordStamp,
  } satisfies ApplicationCrmInterview;

  function sentCommands(onMutate: unknown): ApplicationCrmMutationInput[] {
    const calls = (onMutate as { mock: { calls: unknown[][] } }).mock.calls;
    return calls.map((call) => {
      const command = call[0] as ApplicationCrmMutationInput | undefined;
      if (!command) throw new Error("No CRM command was sent");
      return command;
    });
  }

  function sentCommandOfType<K extends ApplicationCrmMutation["type"]>(
    onMutate: unknown,
    index: number,
    type: K,
  ): ApplicationCrmMutationInput & {
    mutation: Extract<ApplicationCrmMutation, { type: K }>;
  } {
    const commands = sentCommands(onMutate);
    const command = commands[index];
    if (!command || command.mutation.type !== type) {
      throw new Error(`Expected a ${type} command at position ${index}`);
    }
    return command as ApplicationCrmMutationInput & {
      mutation: Extract<ApplicationCrmMutation, { type: K }>;
    };
  }

  test("keeps drafts isolated per record when the keyed detail remounts for another record", () => {
    stubCandidateAssets();
    const onMutate = vi.fn(() => Promise.resolve());
    const recordA = buildCrmRecord({ id: "application_a", revision: 2 });
    const recordB = buildCrmRecord({
      company: "Other Corp",
      id: "application_b",
    });
    const view = renderDetail(recordA, onMutate);

    fireEvent.change(screen.getByLabelText("Add a note"), {
      target: { value: "Draft kept for A" },
    });
    fireEvent.change(screen.getByLabelText("Tags"), {
      target: { value: "alpha" },
    });

    view.rerender(
      <ApplicationsCrmDetail
        key="application_b"
        onExport={vi.fn(() => Promise.resolve())}
        onMutate={onMutate}
        record={recordB}
        settings={ApplicationCrmSettingsSchema.parse({})}
      />,
    );

    expect(screen.getByText("Engineer · Other Corp")).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>("Add a note").value).toBe(
      "",
    );
    expect(screen.getByLabelText<HTMLInputElement>("Tags").value).toBe("");
    expect(screen.getByLabelText<HTMLInputElement>("Offer amount").value).toBe(
      "",
    );
    expect(onMutate).not.toHaveBeenCalled();
  });

  test("preserves same-record drafts when only the revision advances", () => {
    stubCandidateAssets();
    const onMutate = vi.fn(() => Promise.resolve());
    const record = buildCrmRecord({ id: "application_1", revision: 4 });
    const advanced = buildCrmRecord({
      crm: {
        notes: [
          {
            body: "Recruiter replied on the thread",
            createdAt: "2026-08-16T09:00:00.000Z",
            id: "note_server",
            updatedAt: "2026-08-16T09:00:00.000Z",
          },
        ],
        revision: 5,
      },
      id: "application_1",
      revision: 5,
    });
    const view = renderDetail(record, onMutate);

    fireEvent.change(screen.getByLabelText("Tags"), {
      target: { value: "priority" },
    });
    fireEvent.change(screen.getByLabelText("Add a note"), {
      target: { value: "Unsent draft" },
    });

    view.rerender(
      <ApplicationsCrmDetail
        key="application_1"
        onExport={vi.fn(() => Promise.resolve())}
        onMutate={onMutate}
        record={advanced}
        settings={ApplicationCrmSettingsSchema.parse({})}
      />,
    );

    expect(screen.getByLabelText<HTMLInputElement>("Tags").value).toBe(
      "priority",
    );
    expect(screen.getByLabelText<HTMLTextAreaElement>("Add a note").value).toBe(
      "Unsent draft",
    );
    expect(onMutate).not.toHaveBeenCalled();
  });

  test("hydrates the stored offer deadline and preserves a decided offer status on amount-only saves", () => {
    stubCandidateAssets();
    const onMutate = vi.fn(() => Promise.resolve());
    const due = new Date(2026, 8, 30, 14, 0);
    const record = buildCrmRecord({
      crm: {
        compensation: {
          offerBase: { amount: 70_000, currency: "EUR", period: "year" },
          offerDeadlineAt: due.toISOString(),
          offerStatus: "accepted",
        },
        revision: 7,
      },
      id: "application_offer",
      revision: 7,
    });
    renderDetail(record, onMutate);
    openSection("Offer and attachments");

    expect(screen.getByLabelText<HTMLInputElement>("Deadline").value).toBe(
      "2026-09-30T14:00",
    );

    fireEvent.change(screen.getByLabelText("Offer amount"), {
      target: { value: "72000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save offer" }));

    expect(onMutate).toHaveBeenCalledWith({
      applicationRecordId: "application_offer",
      expectedRevision: 7,
      mutation: {
        type: "set_compensation",
        compensation: {
          listedMinimum: null,
          listedMaximum: null,
          expectedMinimum: null,
          expectedMaximum: null,
          offerBase: { amount: 72_000, currency: "EUR", period: "year" },
          offerBonus: null,
          offerEquity: null,
          offerBenefits: [],
          offerDeadlineAt: due.toISOString(),
          offerStatus: "accepted",
          notes: null,
        },
      },
    });
  });

  test("saves an interview entered in the recruiter's zone", async () => {
    stubCandidateAssets();
    const onMutate = vi.fn<
      (command: ApplicationCrmMutationInput) => Promise<void>
    >(() => Promise.resolve());
    const record = buildCrmRecord({ id: "application_zoned" });
    renderDetail(record, onMutate);
    openSection("Interviews and contacts");
    fireEvent.change(screen.getByLabelText("Interview"), {
      target: { value: "Recruiter call" },
    });
    fireEvent.change(screen.getByLabelText(/Starts/), {
      target: { value: "2026-10-05T09:00" },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Interview time zone" }),
      { key: "ArrowDown" },
    );
    fireEvent.click(
      await screen.findByRole("option", { name: /America\/New_York/ }),
    );
    fireEvent.submit(screen.getByLabelText(/Starts/).closest("form")!);
    await waitFor(() => expect(onMutate).toHaveBeenCalled());
    const mutation = onMutate.mock.calls[0]?.[0];
    expect(mutation?.mutation).toMatchObject({
      type: "upsert_interview",
      interview: {
        startsAt: "2026-10-05T13:00:00.000Z",
        timeZone: "America/New_York",
      },
    });
  });
  test("marks a first-time offer active without inventing a deadline", () => {
    stubCandidateAssets();
    const onMutate = vi.fn(() => Promise.resolve());
    const record = buildCrmRecord({ id: "application_first_offer" });
    renderDetail(record, onMutate);
    openSection("Offer and attachments");

    fireEvent.change(screen.getByLabelText("Offer amount"), {
      target: { value: "60000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save offer" }));

    expect(onMutate).toHaveBeenCalledWith({
      applicationRecordId: "application_first_offer",
      expectedRevision: 0,
      mutation: {
        type: "set_compensation",
        compensation: {
          listedMinimum: null,
          listedMaximum: null,
          expectedMinimum: null,
          expectedMaximum: null,
          offerBase: { amount: 60_000, currency: "EUR", period: "year" },
          offerBonus: null,
          offerEquity: null,
          offerBenefits: [],
          offerDeadlineAt: null,
          offerStatus: "active",
          notes: null,
        },
      },
    });
  });

  test("sends reminder lifecycle payloads for complete, dismiss, reschedule, and remove", async () => {
    stubCandidateAssets();
    const onMutate = vi.fn(() => Promise.resolve());
    const record = buildCrmRecord({
      crm: {
        reminders: [
          followUpReminder,
          prepareQuestionsReminder,
          thankYouReminder,
        ],
        revision: 9,
      },
      id: "application_lifecycle",
      revision: 9,
    });
    renderDetail(record, onMutate);

    // Complete keeps the stored reminder identity and stamps completion.
    fireEvent.click(
      within(listRow("Application reminders", "Follow up")).getByRole(
        "button",
        { name: "Complete" },
      ),
    );
    await waitFor(() => expect(sentCommands(onMutate)).toHaveLength(1));
    const completeCommand = sentCommandOfType(onMutate, 0, "upsert_reminder");
    expect(completeCommand.applicationRecordId).toBe("application_lifecycle");
    expect(completeCommand.expectedRevision).toBe(9);
    expect(completeCommand.mutation.reminder).toEqual({
      ...followUpReminder,
      status: "completed",
      updatedAt: completeCommand.mutation.reminder.updatedAt,
      completedAt: completeCommand.mutation.reminder.completedAt,
    });
    expect(typeof completeCommand.mutation.reminder.completedAt).toBe("string");

    // Dismiss keeps the due time and never claims completion.
    const prepareRow = listRow("Application reminders", "Prepare questions");
    fireEvent.click(
      within(prepareRow).getByRole("button", { name: "Dismiss" }),
    );
    await waitFor(() => expect(sentCommands(onMutate)).toHaveLength(2));
    const dismissCommand = sentCommandOfType(onMutate, 1, "upsert_reminder");
    expect(dismissCommand.mutation.reminder).toEqual({
      ...prepareQuestionsReminder,
      status: "dismissed",
      updatedAt: dismissCommand.mutation.reminder.updatedAt,
    });

    // Reschedule changes only the due time and stays pending.
    fireEvent.change(
      within(prepareRow).getByLabelText("New due time for Prepare questions"),
      { target: { value: "2026-09-02T10:30" } },
    );
    fireEvent.click(
      within(prepareRow).getByRole("button", { name: "Reschedule" }),
    );
    await waitFor(() => expect(sentCommands(onMutate)).toHaveLength(3));
    const rescheduleCommand = sentCommandOfType(onMutate, 2, "upsert_reminder");
    expect(rescheduleCommand.mutation.reminder).toEqual({
      ...prepareQuestionsReminder,
      status: "pending",
      dueAt: new Date("2026-09-02T10:30").toISOString(),
      updatedAt: rescheduleCommand.mutation.reminder.updatedAt,
    });

    const thanksRow = listRow("Application reminders", "Send thank-you note");
    fireEvent.click(within(thanksRow).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(sentCommands(onMutate)).toHaveLength(4));
    expect(sentCommands(onMutate)[3]).toEqual({
      applicationRecordId: "application_lifecycle",
      expectedRevision: 9,
      mutation: { type: "remove_reminder", reminderId: "reminder_thanks" },
    });
  });

  test("sends interview lifecycle payloads for complete, cancel, and remove", async () => {
    stubCandidateAssets();
    const onMutate = vi.fn(() => Promise.resolve());
    const record = buildCrmRecord({
      crm: {
        interviews: [panelInterview, screeningInterview],
        revision: 11,
      },
      id: "application_interviews",
      revision: 11,
    });
    renderDetail(record, onMutate);
    openSection("Interviews and contacts");

    fireEvent.click(
      within(listRow("Application interviews", "Panel interview")).getByRole(
        "button",
        { name: "Complete" },
      ),
    );
    await waitFor(() => expect(sentCommands(onMutate)).toHaveLength(1));
    const completeCommand = sentCommandOfType(onMutate, 0, "upsert_interview");
    expect(completeCommand.mutation.interview).toEqual({
      ...panelInterview,
      status: "completed",
      updatedAt: completeCommand.mutation.interview.updatedAt,
    });

    const screeningRow = listRow("Application interviews", "Screening call");
    fireEvent.click(
      within(screeningRow).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => expect(sentCommands(onMutate)).toHaveLength(2));
    const cancelCommand = sentCommandOfType(onMutate, 1, "upsert_interview");
    expect(cancelCommand.mutation.interview).toEqual({
      ...screeningInterview,
      status: "cancelled",
      updatedAt: cancelCommand.mutation.interview.updatedAt,
    });

    fireEvent.click(
      within(screeningRow).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() => expect(sentCommands(onMutate)).toHaveLength(3));
    expect(sentCommands(onMutate)[2]).toEqual({
      applicationRecordId: "application_interviews",
      expectedRevision: 11,
      mutation: {
        type: "remove_interview",
        interviewId: "interview_screening",
      },
    });
  });

  test("removes contacts and unlinks attachments through typed mutations", async () => {
    stubCandidateAssets();
    const onMutate = vi.fn(() => Promise.resolve());
    const record = buildCrmRecord({
      crm: {
        attachments: [
          {
            addedAt: "2026-08-15T10:00:00.000Z",
            candidateAssetId: "asset_resume",
            id: "attachment_resume",
            kind: "resume",
            label: "Resume.pdf",
          },
        ],
        contacts: [
          {
            createdAt: "2026-08-15T10:00:00.000Z",
            email: "dana@example.com",
            id: "contact_dana",
            name: "Dana Recruiter",
            updatedAt: "2026-08-15T10:00:00.000Z",
          },
        ],
        revision: 12,
      },
      id: "application_people",
      revision: 12,
    });
    renderDetail(record, onMutate);
    openSection("Interviews and contacts");
    openSection("Offer and attachments");

    fireEvent.click(
      within(listRow("Application contacts", "Dana Recruiter")).getByRole(
        "button",
        { name: "Remove" },
      ),
    );
    await waitFor(() =>
      expect(onMutate).toHaveBeenCalledWith({
        applicationRecordId: "application_people",
        expectedRevision: 12,
        mutation: { type: "remove_contact", contactId: "contact_dana" },
      }),
    );

    fireEvent.click(
      within(listRow("Linked application attachments", "Resume.pdf")).getByRole(
        "button",
        { name: "Unlink" },
      ),
    );
    await waitFor(() =>
      expect(onMutate).toHaveBeenCalledWith({
        applicationRecordId: "application_people",
        expectedRevision: 12,
        mutation: {
          type: "remove_attachment",
          attachmentId: "attachment_resume",
        },
      }),
    );
  });

  test("surfaces lifecycle mutation failures as an alert and releases the pending state", async () => {
    stubCandidateAssets();
    const onMutate = vi.fn(() =>
      Promise.reject(new Error("The application changed elsewhere. Refresh.")),
    );
    const record = buildCrmRecord({
      crm: {
        reminders: [
          {
            createdAt: "2026-08-15T10:00:00.000Z",
            dueAt: "2026-09-01T09:00:00.000Z",
            id: "reminder_follow_up",
            status: "pending",
            title: "Follow up",
            updatedAt: "2026-08-15T10:00:00.000Z",
          },
        ],
        revision: 3,
      },
      id: "application_error",
      revision: 3,
    });
    renderDetail(record, onMutate);

    const completeButton = within(
      listRow("Application reminders", "Follow up"),
    ).getByRole<HTMLButtonElement>("button", { name: "Complete" });
    expect(completeButton.disabled).toBe(false);
    fireEvent.click(completeButton);
    expect(completeButton.disabled).toBe(true);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "changed elsewhere",
      ),
    );
    await waitFor(() => expect(completeButton.disabled).toBe(false));
  });

  test("keeps a note draft when saving fails so it can be retried", async () => {
    stubCandidateAssets();
    const onMutate = vi
      .fn<(...args: [ApplicationCrmMutationInput]) => Promise<void>>()
      .mockRejectedValueOnce(
        new Error("The application changed elsewhere. Refresh."),
      )
      .mockResolvedValueOnce(undefined);
    renderDetail(buildCrmRecord({ id: "application_note_retry" }), onMutate);
    const note = screen.getByLabelText<HTMLTextAreaElement>("Add a note");
    fireEvent.change(note, {
      target: { value: "Recruiter requested a portfolio." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "changed elsewhere",
      ),
    );
    expect(note.value).toBe("Recruiter requested a portfolio.");
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(note.value).toBe(""));
    expect(onMutate).toHaveBeenCalledTimes(2);
    expect(onMutate.mock.calls[1]?.[0].mutation).toMatchObject({
      type: "add_note",
      note: { body: "Recruiter requested a portfolio." },
    });
  });
  test("keeps a note typed during a tag save and refresh", async () => {
    stubCandidateAssets();
    let finish!: () => void;
    const onMutate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const initial = buildCrmRecord({
      id: "race",
      revision: 1,
      crm: { tags: ["old"] },
    });
    const view = renderDetail(initial, onMutate);
    const tags = screen.getByLabelText("Tags");
    fireEvent.change(tags, { target: { value: "new" } });
    fireEvent.blur(tags);
    const note = screen.getByLabelText<HTMLTextAreaElement>("Add a note");
    expect(note.disabled).toBe(false);
    fireEvent.change(note, { target: { value: "Exact text while tags save" } });
    finish();
    await waitFor(() => expect(onMutate).toHaveBeenCalledTimes(1));
    view.rerender(
      <ApplicationsCrmDetail
        key={initial.id}
        record={{
          ...initial,
          crm: { ...initial.crm!, revision: 2, tags: ["new"] },
        }}
        settings={ApplicationCrmSettingsSchema.parse({})}
        onMutate={onMutate}
        onExport={vi.fn()}
      />,
    );
    expect(note.value).toBe("Exact text while tags save");
  });

  test("offers a saved custom stage and records a manual receipt without claiming a verified send", async () => {
    stubCandidateAssets();
    const onMutate = vi.fn(() => Promise.resolve());
    const prepared = {
      ...buildCrmRecord({ id: "manual" }),
      status: "approved" as const,
      lastAttemptState: "ready" as const,
      crm: null,
    };
    render(
      <ApplicationsCrmDetail
        record={prepared}
        settings={ApplicationCrmSettingsSchema.parse({
          customStages: [
            {
              id: "screen",
              label: "Recruiter screen",
              baseStage: "recruiter_contact",
              color: "cyan",
              position: 0,
            },
          ],
        })}
        onMutate={onMutate}
        onExport={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("option", { name: "Recruiter screen" }),
    ).toBeTruthy();
    const receipt = screen.getByLabelText("Receipt reference (optional)");
    expect(receipt.getAttribute("data-slot")).toBe("input");
    expect(
      screen.getByLabelText("Stage").closest("div")?.contains(receipt),
    ).toBe(true);
    expect(screen.queryByRole("option", { name: "Preparing" })).toBeNull();
    expect(
      screen.queryByRole("option", { name: "Could not apply" }),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText("Receipt reference (optional)"), {
      target: { value: "LOCAL-SYNTHETIC-44" },
    });
    fireEvent.click(screen.getByRole("button", { name: "I sent it" }));
    await waitFor(() =>
      expect(onMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          mutation: {
            type: "set_stage",
            stage: "applied",
            customStageId: null,
            note: "You recorded a send. Receipt: LOCAL-SYNTHETIC-44",
          },
        }),
      ),
    );
  });

  test("uses the home zone for reminders and defaults interviews to it", () => {
    stubCandidateAssets();
    render(
      <ApplicationsCrmDetail
        record={buildCrmRecord({ id: "lisbon" })}
        homeTimeZone="Europe/Lisbon"
        settings={ApplicationCrmSettingsSchema.parse({})}
        onMutate={vi.fn()}
        onExport={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/Due.*Europe\/Lisbon/)).toBeTruthy();
    openSection("Interviews and contacts");
    expect(screen.getByLabelText(/Starts.*Europe\/Lisbon/)).toBeTruthy();
  });

  test("searches interview zones inside one combobox without hiding the page", () => {
    stubCandidateAssets();
    renderDetail(buildCrmRecord({ id: "zone-search" }), vi.fn());
    openSection("Interviews and contacts");
    const zone = screen.getByRole("combobox", { name: "Interview time zone" });
    fireEvent.focus(zone);
    fireEvent.change(zone, { target: { value: "London" } });
    const option = screen.getByRole("option", { name: /Europe\/London/ });
    expect(screen.queryByLabelText("Find interview time zone")).toBeNull();
    expect(
      screen.getByLabelText("Interview").closest('[aria-hidden="true"]'),
    ).toBeNull();
    const form = zone.closest("form")!;
    expect(form.querySelectorAll("label")).toHaveLength(3);
    fireEvent.click(option);
    expect((zone as HTMLInputElement).value).toContain("Europe/London");
    expect(screen.queryByRole("listbox", { name: "Time zones" })).toBeNull();
    fireEvent.change(zone, { target: { value: "Denver" } });
    fireEvent.keyDown(zone, { key: "ArrowDown" });
    const keyboardOption = screen.getByRole("option", {
      name: /America\/Denver/,
    });
    expect(document.activeElement).toBe(keyboardOption);
    fireEvent.keyDown(keyboardOption, { key: "Escape" });
    expect(document.activeElement).toBe(zone);
    expect(screen.queryByRole("listbox", { name: "Time zones" })).toBeNull();
  });
});

test("Tracker activity sorts by event time rather than stored position", () => {
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      jobFinder: {
        listCandidateAssets: vi.fn(() => Promise.resolve({ assets: [] })),
      },
    },
  });
  const record = ApplicationRecordSchema.parse({
    id: "synthetic",
    jobId: "job_synthetic",
    title: "Engineer",
    company: "Synthetic",
    status: "approved",
    lastActionLabel: "Prepared",
    nextActionLabel: null,
    lastUpdatedAt: "2026-10-05T12:00:00Z",
    crm: {
      stage: "applied",
      stageChangedAt: "2026-10-05T12:00:00Z",
      events: [
        {
          id: "older",
          at: "2026-10-03T10:00:00Z",
          kind: "stage_changed",
          title: "Old stage",
          source: "user",
        },
        {
          id: "newer",
          at: "2026-10-05T12:00:00Z",
          kind: "stage_changed",
          title: "You sent this application",
          source: "user",
        },
        {
          id: "middle",
          at: "2026-10-04T10:00:00Z",
          kind: "stage_changed",
          title: "Prepared earlier",
          source: "user",
        },
      ],
    },
  });
  render(
    <ApplicationsCrmDetail
      onExport={vi.fn(() => Promise.resolve())}
      onMutate={vi.fn(() => Promise.resolve())}
      record={record}
      settings={ApplicationCrmSettingsSchema.parse({})}
    />,
    { container: appRoot },
  );
  const timeline = screen.getByText("Timeline (3)").parentElement!;
  expect(
    Array.from(timeline.querySelectorAll("li strong")).map(
      (entry) => entry.textContent,
    ),
  ).toEqual(["You sent this application", "Prepared earlier", "Old stage"]);
});
