import { ToastProvider } from "@renderer/components/ui/toast";
// @vitest-environment jsdom
import type { ApplicationCrmBulkStageMutationInput } from "@nestor/contracts";

import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ApplicationRecordSchema } from "@nestor/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ApplicationsCrmViews } from "./applications-crm-views";

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

async function chooseShow(label: string) {
  const trigger = screen.getByRole("combobox", { name: "Show" });
  fireEvent.click(screen.getByRole("combobox", { name: "Show" }));
  fireEvent.click(screen.getByRole("option", { name: label }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
}

function record(
  id: string,
  title: string,
  company: string,
  overrides: Record<string, unknown> = {},
) {
  return ApplicationRecordSchema.parse({
    id,
    jobId: `job_${id}`,
    title,
    company,
    status: "approved",
    lastActionLabel: "Prepared",
    nextActionLabel: "Review",
    lastUpdatedAt: "2026-08-15T10:00:00.000Z",
    crm: {
      stage: "ready_for_approval",
      stageChangedAt: "2026-08-15T10:00:00.000Z",
      tags: company === "Acme" ? ["priority"] : [],
    },
    ...overrides,
  });
}

Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("ApplicationsCrmViews", () => {
  test("confirms all 61 selected rows across pages and offers exact-stage Undo", async () => {
    const onBulkChange = vi.fn<
      (command: ApplicationCrmBulkStageMutationInput) => Promise<void>
    >(() => Promise.resolve());
    const records = Array.from({ length: 61 }, (_, index) =>
      record(`row_${index}`, `Role ${index}`, "Acme", {
        crm: {
          stage: index % 2 ? "rejected" : "interview",
          stageSource: "user",
          stageChangedAt: "2026-08-01T00:00:00Z",
          revision: index,
        },
      }),
    );
    render(
      <ToastProvider>
        <ApplicationsCrmViews
          onBulkChange={onBulkChange}
          onSelectRecord={vi.fn()}
          onViewChange={vi.fn()}
          records={records}
          selectedRecordId={null}
          view="table"
        />
      </ToastProvider>,
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select all matching applications",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Move to Reviewing" }));
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "61 applications to Reviewing",
    );
    expect(
      screen.getByRole("alertdialog").closest("[data-bulk-selection-bar]"),
    ).not.toBeNull();
    expect(onBulkChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    await waitFor(() => expect(onBulkChange).toHaveBeenCalledTimes(1));
    expect(onBulkChange.mock.calls[0]?.[0].items).toHaveLength(61);
    expect(screen.queryByText("Bulk stages changed.")).toBeNull();
    expect(screen.queryByText("Application tracker updated.")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(onBulkChange).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Previous stages restored")).toBeTruthy();
    expect(
      screen.queryByText(
        "Closed steps stay closed. Prepare again to reopen the form.",
      ),
    ).toBeNull();
    expect(onBulkChange.mock.calls[1]?.[0]).toMatchObject({
      action: "undo",
      items: [
        {
          applicationRecordId: "row_0",
          expectedRevision: 1,
          previousStage: { stage: "interview" },
        },
        ...records.slice(1).map((entry, index) => ({
          applicationRecordId: entry.id,
          expectedRevision: index + 2,
          previousStage: { stage: index % 2 ? "interview" : "rejected" },
        })),
      ],
    });
  });

  test("includes interview-stage records without events and separates scheduled interviews", async () => {
    render(
      <ApplicationsCrmViews
        onSelectRecord={vi.fn()}
        onViewChange={vi.fn()}
        records={Array.from({ length: 24 }, (_, index) =>
          record(`interview_${index}`, `Role ${index}`, "Acme", {
            crm: {
              stage: "interview",
              stageSource: "user",
              stageChangedAt: "2026-08-01T00:00:00Z",
            },
          }),
        )}
        selectedRecordId={null}
        view="table"
      />,
    );
    await chooseShow("Interview stage");
    expect(screen.getByText("24 results")).toBeTruthy();
    await chooseShow("Scheduled interviews");
    expect(screen.getByText("0 of 24 results")).toBeTruthy();
  });

  test.each([
    ["2026-10-25T10:00:00+01:00", "2026-10-25T23:30:00+01:00", "Today"],
    ["2026-10-24T10:00:00+02:00", "2026-10-25T23:30:00+01:00", "Tomorrow"],
    ["2026-03-29T10:00:00+02:00", "2026-03-30T00:30:00+02:00", "Tomorrow"],
  ])("groups %s / %s by local calendar day", (now, dueAt, label) => {
    const previousTZ = process.env.TZ;
    process.env.TZ = "Europe/Belgrade";
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(now));
    try {
      expect(new Date("2026-10-25T23:30:00+01:00").getHours()).toBe(23);
      render(
        <ApplicationsCrmViews
          onSelectRecord={vi.fn()}
          onViewChange={vi.fn()}
          records={[
            record("dst", "Engineer", "Cedar", {
              crm: {
                stage: "reviewing",
                stageChangedAt: "2026-08-15T10:00:00.000Z",
                reminders: [
                  {
                    id: "reminder_dst",
                    title: "DST reminder",
                    dueAt: new Date(dueAt).toISOString(),
                    createdAt: "2026-08-15T10:00:00.000Z",
                    updatedAt: "2026-08-15T10:00:00.000Z",
                  },
                ],
              },
            }),
          ]}
          selectedRecordId={null}
          view="calendar"
        />,
      );
      expect(screen.getByRole("heading", { name: label })).toBeTruthy();
      expect(screen.getByText(/DST reminder/)).toBeTruthy();
    } finally {
      if (previousTZ === undefined) delete process.env.TZ;
      else process.env.TZ = previousTZ;
      vi.restoreAllMocks();
    }
  });

  test("marks a reminder done from the calendar", async () => {
    const onCompleteReminder = vi.fn().mockResolvedValue(undefined);
    render(
      <ApplicationsCrmViews
        onCompleteReminder={onCompleteReminder}
        onSelectRecord={vi.fn()}
        onViewChange={vi.fn()}
        records={[
          record("application_1", "Engineer", "Cedar", {
            crm: {
              stage: "applied",
              stageChangedAt: "2026-08-15T10:00:00.000Z",
              reminders: [
                {
                  id: "follow_up",
                  title: "Follow up",
                  dueAt: "2026-08-16T10:00:00.000Z",
                  createdAt: "2026-08-15T10:00:00.000Z",
                  updatedAt: "2026-08-15T10:00:00.000Z",
                },
              ],
              interviews: [
                {
                  id: "screen",
                  title: "Phone screen",
                  startsAt: "2026-08-17T10:00:00.000Z",
                  createdAt: "2026-08-15T10:00:00.000Z",
                  updatedAt: "2026-08-15T10:00:00.000Z",
                },
              ],
            },
          }),
        ]}
        selectedRecordId={null}
        view="calendar"
      />,
    );
    // Only reminders get the button; an interview is not "done" from here.
    expect(screen.getAllByRole("button", { name: /done/u })).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: /Mark "Follow up · .*" done/u }),
    );
    await waitFor(() =>
      expect(onCompleteReminder).toHaveBeenCalledWith(
        "application_1",
        "follow_up",
      ),
    );
  });

  test("searches locally without resetting the selected application", () => {
    const onSelectRecord = vi.fn();
    render(
      <ApplicationsCrmViews
        onSelectRecord={onSelectRecord}
        onViewChange={vi.fn()}
        records={[
          record("application_1", "Frontend Engineer", "Acme"),
          record("application_2", "Backend Engineer", "Beta"),
        ]}
        selectedRecordId="application_2"
        view="table"
      />,
    );

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search applications" }),
      {
        target: { value: "priority" },
      },
    );
    expect(screen.getByText("Frontend Engineer")).toBeTruthy();
    expect(screen.queryByText("Backend Engineer")).toBeNull();
    expect(onSelectRecord).not.toHaveBeenCalled();
  });

  test("does not offer three ways to view a single row", () => {
    render(
      <ApplicationsCrmViews
        onSelectRecord={vi.fn()}
        onViewChange={vi.fn()}
        records={[record("application_1", "Frontend Engineer", "Acme")]}
        selectedRecordId={null}
        view="table"
      />,
    );

    expect(screen.queryByTestId("applications-crm-view-switcher")).toBeNull();
    expect(screen.queryByRole("button", { name: "List" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Board" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Calendar" })).toBeNull();
    // The record itself is still fully present and editable.
    expect(screen.getByText("Frontend Engineer")).toBeTruthy();
  });

  test("offers table, Kanban, calendar, columns, saved views, and a sticky bulk action", async () => {
    const onBulkStageChange = vi.fn(() => Promise.resolve());
    render(
      <ApplicationsCrmViews
        onBulkStageChange={onBulkStageChange}
        onSelectRecord={vi.fn()}
        onViewChange={vi.fn()}
        records={[
          record("application_1", "Frontend Engineer", "Acme"),
          record("application_2", "Backend Engineer", "Globex"),
        ]}
        selectedRecordId={null}
        view="table"
      />,
    );

    expect(screen.getByRole("button", { name: "List" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Board" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Calendar" })).toBeTruthy();
    expect(screen.getByText("Columns")).toBeTruthy();
    expect(screen.getByText("Saved views")).toBeTruthy();
    expect(
      screen.getByText(/one you recorded or one Job Finder worked out/i),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select Frontend Engineer at Acme",
      }),
    );
    expect(screen.getByText("1 matching application selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move to Reviewing" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    await waitFor(() =>
      expect(onBulkStageChange).toHaveBeenCalledWith(
        ["application_1"],
        "reviewing",
      ),
    );
  });

  test("shows explicit and inferred Applied stages with distinct local provenance", () => {
    render(
      <ApplicationsCrmViews
        onSelectRecord={vi.fn()}
        onViewChange={vi.fn()}
        records={[
          record("legacy", "Legacy Engineer", "Archive Co", {
            status: "submitted",
            crm: null,
          }),
          record("explicit", "Current Engineer", "Tracked Co", {
            status: "submitted",
            crm: {
              stage: "applied",
              stageChangedAt: "2026-08-15T10:00:00.000Z",
            },
          }),
        ]}
        selectedRecordId={null}
        view="table"
      />,
    );

    // Both rows say "Applied"; provenance is the badge, not a suffix on the
    // stage name.
    expect(
      screen.getAllByText("Applied", { selector: "td span" }),
    ).toHaveLength(2);
    expect(screen.queryByText(/historical inference/i)).toBeNull();
    expect(screen.queryByText(/user recorded/i)).toBeNull();
    expect(
      screen.queryByText(/receipt|submission proof|externally verified/i),
    ).toBeNull();
  });

  test("bounds the table DOM and names matching select-all semantics", () => {
    const records = Array.from({ length: 226 }, (_, index) =>
      record(`application_${index}`, `Frontend Engineer ${index}`, "Acme"),
    );

    render(
      <ApplicationsCrmViews
        onBulkStageChange={vi.fn(() => Promise.resolve())}
        onSelectRecord={vi.fn()}
        onViewChange={vi.fn()}
        records={records}
        selectedRecordId={null}
        view="table"
      />,
    );

    expect(
      screen.getByRole("table", { name: "Application tracker" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(51);
    expect(
      screen.getByRole("navigation", { name: "applications pagination" }),
    ).toBeTruthy();
    expect(screen.getByText("1–50 of 226")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getAllByRole("row")).toHaveLength(51);
    expect(screen.getByText("Frontend Engineer 50")).toBeTruthy();
    expect(screen.queryByText("Frontend Engineer 0")).toBeNull();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select all matching applications",
      }),
    );
    expect(screen.getByText("226 matching applications selected")).toBeTruthy();
  });

  test("reports the full filtered record-id set, including records on later pages", async () => {
    const onVisibleRecordIdsChange =
      vi.fn<(recordIds: readonly string[]) => void>();
    const records = Array.from({ length: 120 }, (_, index) =>
      record(
        `application_${index}`,
        index % 2 === 0 ? "Frontend Engineer" : "Backend Engineer",
        "Acme",
      ),
    );

    render(
      <ApplicationsCrmViews
        onSelectRecord={vi.fn()}
        onViewChange={vi.fn()}
        onVisibleRecordIdsChange={onVisibleRecordIdsChange}
        records={records}
        selectedRecordId="application_119"
        view="table"
      />,
    );

    await waitFor(() => expect(onVisibleRecordIdsChange).toHaveBeenCalled());
    const initialReport = onVisibleRecordIdsChange.mock.calls.at(-1)?.[0] ?? [];
    expect(initialReport).toHaveLength(120);
    expect(initialReport).toContain("application_119");
    expect(screen.getByText("101–120 of 120")).toBeTruthy();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search applications" }),
      { target: { value: "Backend" } },
    );
    await waitFor(() =>
      expect(onVisibleRecordIdsChange.mock.calls.at(-1)?.[0]).toHaveLength(60),
    );
    const narrowedReport =
      onVisibleRecordIdsChange.mock.calls.at(-1)?.[0] ?? [];
    expect(narrowedReport).toContain("application_119");
    expect(narrowedReport).not.toContain("application_0");

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search applications" }),
      { target: { value: "no-such-application-exists" } },
    );
    await waitFor(() =>
      expect(onVisibleRecordIdsChange.mock.calls.at(-1)?.[0]).toEqual([]),
    );
  });

  test("re-reports visible ids when the tracker remounts with identical records", async () => {
    const onVisibleRecordIdsChange =
      vi.fn<(recordIds: readonly string[]) => void>();
    const records = [record("application_1", "Frontend Engineer", "Acme")];
    const renderTracker = () =>
      render(
        <ApplicationsCrmViews
          onSelectRecord={vi.fn()}
          onViewChange={vi.fn()}
          onVisibleRecordIdsChange={onVisibleRecordIdsChange}
          records={records}
          selectedRecordId="application_1"
          view="table"
        />,
      );

    const firstMount = renderTracker();
    await waitFor(() =>
      expect(onVisibleRecordIdsChange).toHaveBeenCalledTimes(1),
    );
    firstMount.unmount();

    renderTracker();
    await waitFor(() =>
      expect(onVisibleRecordIdsChange).toHaveBeenCalledTimes(2),
    );
    expect(onVisibleRecordIdsChange.mock.calls[1]?.[0]).toEqual([
      "application_1",
    ]);
  });

  test("keeps a single report while the parent re-renders with fresh callback identities", async () => {
    const reports: Array<readonly string[]> = [];

    function ChurnHarness() {
      const [, setTick] = useState(0);
      return (
        <div>
          <button onClick={() => setTick((tick) => tick + 1)} type="button">
            Rerender tracker host
          </button>
          <ApplicationsCrmViews
            onSelectRecord={vi.fn()}
            onViewChange={vi.fn()}
            onVisibleRecordIdsChange={(recordIds) => {
              reports.push([...recordIds]);
            }}
            records={[record("application_1", "Frontend Engineer", "Acme")]}
            selectedRecordId="application_1"
            view="table"
          />
        </div>
      );
    }

    render(<ChurnHarness />);
    await waitFor(() => expect(reports).toHaveLength(1));
    fireEvent.click(
      screen.getByRole("button", { name: "Rerender tracker host" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Rerender tracker host" }),
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual(["application_1"]);
  });

  test("round-trips collision-prone record ids losslessly in order", async () => {
    const onVisibleRecordIdsChange =
      vi.fn<(recordIds: readonly string[]) => void>();
    const exoticIds = [
      "plain",
      '["application_1","application_2"]',
      "joined\u0000ids",
      "comma,separated",
    ];
    const records = exoticIds.map((id) =>
      record(id, "Frontend Engineer", "Acme"),
    );

    render(
      <ApplicationsCrmViews
        onSelectRecord={vi.fn()}
        onViewChange={vi.fn()}
        onVisibleRecordIdsChange={onVisibleRecordIdsChange}
        records={records}
        selectedRecordId="plain"
        view="table"
      />,
    );

    await waitFor(() => expect(onVisibleRecordIdsChange).toHaveBeenCalled());
    expect(onVisibleRecordIdsChange.mock.calls.at(-1)?.[0]).toEqual(exoticIds);
  });

  test("names each tracker subview in its own empty state", () => {
    const renderView = (view: "table" | "kanban" | "calendar") => {
      cleanup();
      render(
        <ApplicationsCrmViews
          onSelectRecord={vi.fn()}
          onViewChange={vi.fn()}
          records={[]}
          selectedRecordId={null}
          view={view}
        />,
      );
    };

    renderView("table");
    expect(screen.getByText("No applications yet")).toBeTruthy();
    expect(screen.getByText(/tracker table/)).toBeTruthy();

    renderView("kanban");
    expect(screen.getByText("No applications on your board yet")).toBeTruthy();
    expect(screen.getByText(/grouped by hiring stage/)).toBeTruthy();

    renderView("calendar");
    expect(screen.getByText("Nothing scheduled yet")).toBeTruthy();
    expect(screen.getByText(/application calendar/)).toBeTruthy();
  });

  test("keeps a failed bulk update selected for an explicit retry", async () => {
    let resolveRetry: (() => void) | undefined;
    const onBulkStageChange = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("internal revision mismatch"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveRetry = resolve;
          }),
      );
    render(
      <ApplicationsCrmViews
        onBulkStageChange={onBulkStageChange}
        onSelectRecord={vi.fn()}
        onViewChange={vi.fn()}
        records={[record("application_1", "Frontend Engineer", "Acme")]}
        selectedRecordId={null}
        view="table"
      />,
    );

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select Frontend Engineer at Acme",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Move to Reviewing" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The selected applications could not be updated. Keep them selected and try again.",
    );
    expect(screen.queryByText(/internal revision mismatch/i)).toBeNull();
    expect(screen.getByText("1 matching application selected")).toBeTruthy();
    expect(onBulkStageChange).toHaveBeenCalledTimes(1);

    const retryButton = screen.getByRole("button", { name: "Confirm change" });
    fireEvent.click(retryButton);
    expect((retryButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(retryButton);
    expect(onBulkStageChange).toHaveBeenCalledTimes(2);
    expect(onBulkStageChange).toHaveBeenNthCalledWith(
      2,
      ["application_1"],
      "reviewing",
    );

    resolveRetry?.();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByText(/matching application selected/)).toBeNull();
    expect(onBulkStageChange).toHaveBeenCalledTimes(2);
  });

  test("clears a bulk failure when the relevant selection resets", async () => {
    render(
      <ApplicationsCrmViews
        onBulkStageChange={vi.fn(() => Promise.reject(new Error("stale")))}
        onSelectRecord={vi.fn()}
        onViewChange={vi.fn()}
        records={[record("application_1", "Frontend Engineer", "Acme")]}
        selectedRecordId={null}
        view="table"
      />,
    );

    const checkbox = screen.getByRole("checkbox", {
      name: "Select Frontend Engineer at Acme",
    });
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Move to Reviewing" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    expect(await screen.findByRole("alert")).toBeTruthy();

    fireEvent.click(checkbox);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  test("styles the lifecycle view select with the canonical field recipe", () => {
    render(
      <ApplicationsCrmViews
        onSelectRecord={vi.fn()}
        onViewChange={vi.fn()}
        records={[record("application_1", "Frontend Engineer", "Acme")]}
        selectedRecordId={null}
        view="table"
      />,
    );

    const lifecycleSelect = screen.getByLabelText("Show");
    expect(lifecycleSelect.getAttribute("data-size")).toBe("toolbar");
    expectCanonicalFieldClasses(lifecycleSelect);
  });
});

describe("ApplicationsCrmViews locked pane scroll regions", () => {
  function expectSingleLeafScrollRegion(scope: ParentNode): HTMLElement {
    const regions = Array.from(
      scope.querySelectorAll<HTMLElement>("[data-locked-pane-scroll-region]"),
    );
    expect(regions).toHaveLength(1);
    const region = regions[0]!;
    // A marked pane owns scrolling without nesting another marker.
    expect(
      region.querySelectorAll("[data-locked-pane-scroll-region]"),
    ).toHaveLength(0);
    return region;
  }

  test("marks only the bounded table scroller in the table view", () => {
    const { container } = render(
      <ApplicationsCrmViews
        onSelectRecord={vi.fn()}
        onViewChange={vi.fn()}
        records={[
          record("application_1", "Frontend Engineer", "Acme"),
          record("application_2", "Backend Engineer", "Beta"),
        ]}
        selectedRecordId="application_1"
        view="table"
      />,
    );

    const region = expectSingleLeafScrollRegion(container);
    expect(region.className).toContain("flex-1 overflow-auto");
    expect(
      region.querySelector(
        'table[aria-labelledby="application-tracker-heading"]',
      ),
    ).toBeTruthy();
    // The tracker shell clips layout but never scrolls, so it stays unmarked.
    expect(
      document
        .getElementById("application-tracker-heading")
        ?.closest("section")
        ?.hasAttribute("data-locked-pane-scroll-region"),
    ).toBe(false);
  });

  test("marks only the bounded board scroller in the Kanban view", () => {
    const { container } = render(
      <ApplicationsCrmViews
        onSelectRecord={vi.fn()}
        onViewChange={vi.fn()}
        records={[record("application_1", "Frontend Engineer", "Acme")]}
        selectedRecordId="application_1"
        view="kanban"
      />,
    );

    const region = expectSingleLeafScrollRegion(container);
    expect(region.className).toContain("overflow-x-hidden");
    expect(region.className).toContain("overflow-y-auto");
    expect(screen.getByText("Frontend Engineer")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Discovered" })).toBeNull();
    expect(
      screen.getByRole("button", { name: /Show empty stages/ }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Show empty stages/ }));
    expect(screen.getByRole("list", { name: "Empty stages" })).toBeTruthy();
    expect(screen.getByText("Discovered")).toBeTruthy();
    const stageColumn = screen
      .getByText("Frontend Engineer")
      .closest("section");
    expect(stageColumn).toBeTruthy();
    expect(stageColumn?.className).not.toContain("overflow-y-auto");
    expect(stageColumn?.hasAttribute("data-locked-pane-scroll-region")).toBe(
      false,
    );
  });

  test("marks only the bounded calendar scroller in the calendar view", () => {
    const { container } = render(
      <ApplicationsCrmViews
        onSelectRecord={vi.fn()}
        onViewChange={vi.fn()}
        records={[record("application_1", "Frontend Engineer", "Acme")]}
        selectedRecordId="application_1"
        view="calendar"
      />,
    );

    const region = expectSingleLeafScrollRegion(container);
    // The pane also clips sideways now: Windows draws both scrollbar tracks,
    // so a wide row put a horizontal bar inside an already vertical scroller.
    expect(region.className).toContain(
      "min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto",
    );
    expect(screen.getByText(/Nothing scheduled/)).toBeTruthy();
  });

  test("leaves every tracker empty state unmarked", () => {
    for (const view of ["table", "kanban", "calendar"] as const) {
      const { container } = render(
        <ApplicationsCrmViews
          onSelectRecord={vi.fn()}
          onViewChange={vi.fn()}
          records={[]}
          selectedRecordId={null}
          view={view}
        />,
      );

      expect(
        container.querySelectorAll("[data-locked-pane-scroll-region]"),
      ).toHaveLength(0);
      cleanup();
    }
  });
});

test("shows every populated board stage and pages stages independently", () => {
  const entries = Array.from({ length: 61 }, (_, index) =>
    record(`reject_${index}`, `Rejected role ${index}`, "Acorn", {
      crm: {
        stage: "rejected",
        stageSource: "user",
        stageChangedAt: "2026-08-01T10:00:00Z",
      },
    }),
  );
  entries.push(
    record("offer", "Offer role", "Willow", {
      crm: {
        stage: "offer",
        stageSource: "user",
        stageChangedAt: "2026-08-01T10:00:00Z",
      },
    }),
  );
  render(
    <ApplicationsCrmViews
      records={entries}
      onSelectRecord={vi.fn()}
      onViewChange={vi.fn()}
      selectedRecordId={null}
      view="kanban"
    />,
  );
  expect(screen.getByText("Offer role")).toBeTruthy();
  const column = screen.getByRole("region", { name: "Rejected applications" });
  expect(within(column).getByText("61")).toBeTruthy();
  fireEvent.click(within(column).getByRole("button", { name: /Next/ }));
  expect(within(column).getByText("Rejected role 10")).toBeTruthy();
  expect(screen.getByText("Offer role")).toBeTruthy();
});

test("restores a named Show filter after remounting", async () => {
  const entries = [
    record("offer", "Offer role", "Willow", {
      crm: {
        stage: "offer",
        stageSource: "user",
        stageChangedAt: "2026-08-01T10:00:00Z",
      },
    }),
    record("other", "Other role", "Acorn"),
  ];
  const view = render(
    <ApplicationsCrmViews
      records={entries}
      onSelectRecord={vi.fn()}
      onViewChange={vi.fn()}
      selectedRecordId={null}
      view="table"
    />,
  );
  await chooseShow("Offers");
  fireEvent.click(screen.getByRole("button", { name: /Saved views/ }));
  fireEvent.change(await screen.findByLabelText("Saved view name"), {
    target: { value: "Offers only" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await chooseShow("All applications");
  view.unmount();
  render(
    <ApplicationsCrmViews
      records={entries}
      onSelectRecord={vi.fn()}
      onViewChange={vi.fn()}
      selectedRecordId={null}
      view="table"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /Saved views/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Offers only" }));
  expect(screen.getByLabelText("Show").textContent).toBe("Offers");
  expect(screen.queryByText("Other role")).toBeNull();
});

test("keeps Sort beside Show, uses compact dates and adds Applied to older column choices", () => {
  window.localStorage.setItem(
    "nestor.job-finder.applications-crm.columns.v1",
    JSON.stringify(["job", "updated"]),
  );
  const view = render(
    <ApplicationsCrmViews
      records={[record("one", "Role", "Acme")]}
      homeTimeZone="America/Denver"
      selectedRecordId={null}
      view="table"
      onViewChange={vi.fn()}
      onSelectRecord={vi.fn()}
    />,
  );
  const sort = screen.getByRole("combobox", { name: "Sort applications" });
  expect(sort.closest("[data-tracker-filter-row]")).toBe(
    screen.getByLabelText("Show").closest("[data-tracker-filter-row]"),
  );
  expect(screen.getByRole("table").closest("section")?.className).toContain(
    "max-h-[calc(100dvh-15rem)]",
  );
  expect(screen.getByRole("columnheader", { name: "Applied" })).toBeTruthy();
  expect(
    screen.getByRole("columnheader", { name: "Updated" }).getAttribute("title"),
  ).toBe("America/Denver");
  const date = view.container.querySelector("tbody td:last-child");
  expect(date?.className).toContain("whitespace-nowrap");
  expect(date?.textContent).not.toContain("America/Denver");
  view.rerender(
    <ApplicationsCrmViews
      records={[record("one", "Role", "Acme")]}
      selectedRecordId={null}
      view="calendar"
      onViewChange={vi.fn()}
      onSelectRecord={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole("combobox", { name: "Sort applications" }),
  ).toBeNull();
});

test("sort and Show changes return to page one without following the old selection", async () => {
  const records = Array.from({ length: 120 }, (_, index) =>
    record(`row${index}`, `Role ${String(index).padStart(3, "0")}`, "Acme", {
      crm: {
        stage: "offer",
        stageSource: "user",
        stageChangedAt: "2026-08-15T10:00:00Z",
        appliedAt: new Date(
          Date.parse("2026-01-01T00:00:00Z") + index * 86400000,
        ).toISOString(),
      },
    }),
  );
  render(
    <ApplicationsCrmViews
      records={records}
      selectedRecordId="row119"
      view="table"
      onViewChange={vi.fn()}
      onSelectRecord={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Sort applications" }));
  fireEvent.click(
    screen.getByRole("option", { name: "Applied date: oldest first" }),
  );
  expect(screen.getByText("1–50 of 120")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  await chooseShow("Offers");
  expect(screen.getByText("1–50 of 120")).toBeTruthy();
});

test("a requested record opens despite persisted search and Show filters", () => {
  window.localStorage.setItem(
    "nestor.job-finder.collection.applications-crm.v1",
    JSON.stringify({ density: "comfortable", query: "hidden", savedViews: [] }),
  );
  window.localStorage.setItem(
    "nestor.job-finder.applications-crm.saved-view.v1",
    "offers",
  );
  render(
    <ApplicationsCrmViews
      records={[
        ...Array.from({ length: 110 }, (_, index) =>
          record(`before-${index}`, "Other role", "Acme"),
        ),
        record("one", "Target role", "Acme"),
      ]}
      requestedRecordId="one"
      selectedRecordId="one"
      view="table"
      onViewChange={vi.fn()}
      onSelectRecord={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "Target role" })).toBeTruthy();
  expect(screen.getByLabelText("Show").textContent).toBe("All applications");
});

test("older saved views explain that Show was not recorded", async () => {
  window.localStorage.setItem(
    "nestor.job-finder.collection.applications-crm.v1",
    JSON.stringify({
      density: "comfortable",
      query: "",
      savedViews: [
        { id: "older", name: "Offers only", query: "", density: "comfortable" },
      ],
    }),
  );
  render(
    <ToastProvider>
      <ApplicationsCrmViews
        records={[record("one", "Role", "Acme")]}
        selectedRecordId={null}
        view="table"
        onViewChange={vi.fn()}
        onSelectRecord={vi.fn()}
      />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Saved views/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Offers only" }));
  expect(screen.getByText(/This older view did not save Show/)).toBeTruthy();
});

test("bulk controls use shared fields and offer only manually recorded stages", () => {
  render(
    <ApplicationsCrmViews
      records={[record("one", "Role", "Acme")]}
      selectedRecordId={null}
      view="table"
      onBulkChange={vi.fn()}
      onViewChange={vi.fn()}
      onSelectRecord={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select all matching applications" }),
  );
  expect(screen.getByLabelText("Bulk tags").getAttribute("data-slot")).toBe(
    "input",
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Bulk stage" }));
  expect(screen.queryByRole("option", { name: "Preparing" })).toBeNull();
  expect(screen.queryByRole("option", { name: "Needs you" })).toBeNull();
  expect(screen.queryByRole("option", { name: "Could not apply" })).toBeNull();
  expect(screen.getByRole("option", { name: "Interview" })).toBeTruthy();
});

test("reserves one-line stage and narrow dates while truncating role and employer", () => {
  render(
    <ApplicationsCrmViews
      records={[
        record("one", "Senior Learning Coordinator", "Clientnest Cobalt"),
      ]}
      selectedRecordId={null}
      view="table"
      onSelectRecord={vi.fn()}
      onViewChange={vi.fn()}
    />,
  );
  expect(screen.getByRole("columnheader", { name: "Job" }).className).toContain(
    "w-[12rem]",
  );
  expect(
    screen.getByRole("columnheader", { name: "Company" }).className,
  ).toContain("w-[10rem]");
  expect(
    screen.getByRole("columnheader", { name: "Stage" }).className,
  ).toContain("w-[8.5rem]");
  const table = screen.getByRole("table");
  expect(table.className).toContain("table-fixed");
  expect(table.style.minWidth).toBe("68rem");
  expect(table.parentElement?.className).toContain(
    "min-h-0 min-w-0 flex-1 overflow-auto",
  );
  expect(
    screen.getByRole("columnheader", { name: "Updated" }).className,
  ).toContain("w-[7.5rem]");
  const job = screen.getByRole("button", {
    name: "Senior Learning Coordinator",
  });
  expect(job.className).toContain("truncate");
  expect(job.title).toBe("Senior Learning Coordinator");
  expect(screen.getByText("Clientnest Cobalt").className).toContain("truncate");
  expect(screen.getByText("Clientnest Cobalt").title).toBe("Clientnest Cobalt");
  expect(screen.getAllByRole("row")[1]?.children[3]?.className).toContain(
    "whitespace-nowrap",
  );
});

test("keeps the tracker controls on one toolbar row under the page title", () => {
  const records = Array.from({ length: 4 }, (_, index) =>
    record(`application_${index}`, `Role ${index}`, "Acme"),
  );
  const { container } = render(
    <ApplicationsCrmViews
      onSelectRecord={vi.fn()}
      onViewChange={vi.fn()}
      records={records}
      selectedRecordId={null}
      view="table"
    />,
  );

  // No visible panel title or subtitle repeats the page header.
  const heading = screen.getByRole("heading", { name: "Application tracker" });
  expect(heading.className).toContain("sr-only");
  expect(screen.queryByText(/in this view · a stage is either/)).toBeNull();

  const row = container.querySelector("[data-collection-toolbar-compact]");
  expect(row?.className).toContain("min-h-12");
  for (const control of [
    screen.getByLabelText("Search applications"),
    screen.getByRole("combobox", { name: "Show" }),
    screen.getByRole("combobox", { name: "Sort applications" }),
    screen.getByRole("group", { name: "Application view" }),
  ]) {
    expect(row?.contains(control)).toBe(true);
  }
  expect(screen.getByText("4 results")).toBeTruthy();
  // The stage explanation is a description of the Stage column.
  const stage = screen.getByRole("columnheader", { name: "Stage" });
  expect(stage.getAttribute("aria-describedby")).toBe(
    "application-tracker-stage-help",
  );
  expect(
    document.getElementById("application-tracker-stage-help")?.textContent,
  ).toMatch(/one you recorded or one Job Finder worked out/);
});

test("uses singular wording when tagging one application", async () => {
  const onBulkChange = vi.fn().mockResolvedValue(undefined);
  render(
    <ToastProvider>
      <ApplicationsCrmViews
        records={[record("one", "Analyst", "Synthetic")]}
        selectedRecordId={null}
        onSelectRecord={vi.fn()}
        onViewChange={vi.fn()}
        onBulkChange={onBulkChange}
        view="table"
      />
    </ToastProvider>,
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select all matching applications" }),
  );
  fireEvent.change(screen.getByPlaceholderText("Tags, separated by commas"), {
    target: { value: "follow up" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add tags" }));
  expect(screen.getByRole("alertdialog").textContent).toContain(
    "Add tags to 1 application?",
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
  await waitFor(() =>
    expect(screen.getByText("1 application updated")).toBeTruthy(),
  );
});

test("confirms one selected application without claiming other pages will change", () => {
  render(
    <ApplicationsCrmViews
      records={[record("one", "Role", "Acme")]}
      selectedRecordId={null}
      view="table"
      onSelectRecord={vi.fn()}
      onViewChange={vi.fn()}
      onBulkChange={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select all matching applications" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Move to Reviewing" }));
  const confirmation = screen.getByRole("alertdialog", {
    name: "Confirm bulk change",
  });
  expect(
    within(confirmation).getByText("This application will change."),
  ).toBeTruthy();
  expect(within(confirmation).queryByText(/other pages/)).toBeNull();
});

test("Tracker distinguishes the same role and employer in two places", () => {
  const records = [
    record("london", "Senior Accountant", "Synthetic Workshop"),
    record("denver", "Senior Accountant", "Synthetic Workshop"),
  ];
  render(
    <ApplicationsCrmViews
      records={records}
      discoveryJobs={records.map((entry, index) => ({
        id: entry.jobId,
        canonicalUrl: "https://example.test/jobs/" + index,
        location: index ? "Denver" : "London",
      }))}
      onSelectRecord={vi.fn()}
      onViewChange={vi.fn()}
      selectedRecordId={null}
      view="table"
    />,
  );
  expect(screen.getByText("London · Synthetic Workshop")).toBeTruthy();
  expect(screen.getByText("Denver · Synthetic Workshop")).toBeTruthy();
});

test("Undo explains closed steps only when this stage change actually closed one", async () => {
  function Harness() {
    const [records, setRecords] = useState([
      record("application_test", "Engineer", "Synthetic"),
    ]);
    return (
      <ToastProvider>
        <ApplicationsCrmViews
          records={records}
          onSelectRecord={vi.fn()}
          onViewChange={vi.fn()}
          selectedRecordId={null}
          view="table"
          onBulkChange={(command) => {
            if (command.action !== "undo")
              setRecords((current) =>
                current.map((entry) => ({
                  ...entry,
                  events: [
                    ...entry.events,
                    {
                      id: "closed_step",
                      at: "2026-10-05T12:00:00Z",
                      title: "Application step closed: you withdrew it",
                      detail: "Your step was closed.",
                      emphasis: "neutral" as const,
                    },
                  ],
                })),
              );
            return Promise.resolve();
          }}
        />
      </ToastProvider>
    );
  }
  render(<Harness />);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select all matching applications" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Move to Reviewing" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(
    await screen.findByText(
      "Closed steps stay closed. Prepare again to reopen the form.",
    ),
  ).toBeTruthy();
});

test("keeps the header and three readable rows when the available table height is short at large text", () => {
  const geometry = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const height =
        this.tagName === "THEAD"
          ? 45
          : this.tagName === "TR"
            ? 100
            : this.tagName === "DIV"
              ? 30
              : 0;
      return {
        height,
        width: 1200,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1200,
        bottom: height,
        toJSON: () => ({}),
      };
    });
  try {
    render(
      <ApplicationsCrmViews
        records={[record("one", "Role", "Acme")]}
        selectedRecordId={null}
        view="table"
        onViewChange={vi.fn()}
        onSelectRecord={vi.fn()}
      />,
    );
    const table = screen.getByRole("table");
    expect(table.parentElement?.style.minHeight).toBe("345px");
    expect(
      Number.parseFloat(table.closest("section")!.style.minHeight),
    ).toBeGreaterThan(345);
    expect(table.parentElement?.className).toContain("overflow-auto");
  } finally {
    geometry.mockRestore();
  }
});
