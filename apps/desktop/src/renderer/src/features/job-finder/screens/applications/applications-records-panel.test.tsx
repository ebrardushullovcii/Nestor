// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  type ApplicationRecord,
  type ApplyJobResult,
} from "@nestor/contracts";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationsRecordsPanel } from "./applications-records-panel";
import {
  APPLICATION_FILTERS,
  type ApplicationsViewFilter,
} from "./applications-filters";
import { matchesApplicationsFilter } from "./applications-screen-helpers";
import {
  jobFinderListRowBadgeSlotClassName,
  jobFinderListRowLinesClassName,
  jobFinderListRowTitleLineClassName,
} from "../../components/list-row";

Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});
afterEach(() => {
  cleanup();
  // The list remembers its search and stage; each test starts without them.
  window.localStorage.clear();
});

describe("ApplicationsRecordsPanel", () => {
  it("removes stale preparing guidance from a failed row", () => {
    const record = ApplicationRecordSchema.parse({
      id: "failed",
      jobId: "job_failed",
      title: "Engineer",
      company: "Example",
      status: "approved",
      lastAttemptState: "failed",
      lastActionLabel: "Profile changed",
      nextActionLabel: "Job Finder is preparing this job now.",
      lastUpdatedAt: "2026-10-02T10:00:00.000Z",
    });
    const result = ApplyJobResultSchema.parse({
      id: "result",
      runId: "run",
      jobId: record.jobId,
      applicationRecordId: record.id,
      state: "failed",
      summary: "Could not apply",
      detail: "Profile changed",
      startedAt: record.lastUpdatedAt,
      updatedAt: record.lastUpdatedAt,
    });
    render(
      <MemoryRouter>
        <ApplicationsRecordsPanel
          activeFilter="all"
          applicationRecords={[record]}
          latestApplyResultByRecordId={new Map([[record.id, result]])}
          filterCounts={{
            all: 1,
            needs_action: 1,
            in_progress: 0,
            submitted: 0,
            manual_only: 0,
          }}
          hasAnyApplications
          onFilterChange={vi.fn()}
          onSelectRecord={vi.fn()}
          selectedRecord={record}
        />
      </MemoryRouter>,
    );
    expect(
      screen.queryByText(/Job Finder is preparing this job now/),
    ).toBeNull();
    expect(screen.getByText("Next: Try again")).toBeTruthy();
  });
  it("names an empty plan and links to all saved applications", () => {
    render(
      <MemoryRouter>
        <ApplicationsRecordsPanel
          activeFilter="all"
          applicationRecords={[]}
          filterCounts={{
            all: 0,
            needs_action: 0,
            in_progress: 0,
            submitted: 0,
            manual_only: 0,
          }}
          hasAnyApplications={false}
          searchPlanName="UK design"
          hasOtherPlanApplications
          onFilterChange={vi.fn()}
          onSelectRecord={vi.fn()}
          selectedRecord={null}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("No applications in UK design")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Show all applications" })
        .getAttribute("href"),
    ).toBe("/job-finder/applications?scope=all");
  });
  it("keeps filter guidance when the current plan has applications", () => {
    render(
      <MemoryRouter>
        <ApplicationsRecordsPanel
          activeFilter="submitted"
          applicationRecords={[]}
          filterCounts={{
            all: 1,
            needs_action: 1,
            in_progress: 0,
            submitted: 0,
            manual_only: 0,
          }}
          hasAnyApplications
          searchPlanName="UK design"
          hasOtherPlanApplications
          onFilterChange={vi.fn()}
          onSelectRecord={vi.fn()}
          selectedRecord={null}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("No applications in this view")).toBeTruthy();
    expect(screen.queryByText("No applications in UK design")).toBeNull();
  });
  it.each(["filling", "submitted"] as const)(
    "announces the current %s result instead of a stale attempt",
    (state) => {
      const record = ApplicationRecordSchema.parse({
        id: "application_latest",
        jobId: "job_latest",
        title: "Product Engineer",
        company: "Acme",
        status: "ready_for_review",
        lastActionLabel: "Application created",
        nextActionLabel: null,
        lastUpdatedAt: new Date().toISOString(),
        lastAttemptState: state === "filling" ? null : "paused",
      });
      const result = ApplyJobResultSchema.parse({
        id: "result_latest",
        runId: "run_latest",
        jobId: record.jobId,
        applicationRecordId: record.id,
        state,
        summary: "Current application result",
        detail: "Current application result",
        startedAt: record.lastUpdatedAt,
        updatedAt: record.lastUpdatedAt,
      });
      render(
        <MemoryRouter>
          <ApplicationsRecordsPanel
            activeFilter="all"
            applicationRecords={[record]}
            latestApplyResultByRecordId={new Map([[record.id, result]])}
            filterCounts={{
              all: 1,
              needs_action: 0,
              in_progress: 0,
              submitted: 0,
              manual_only: 0,
            }}
            hasAnyApplications
            onFilterChange={vi.fn()}
            onSelectRecord={vi.fn()}
            selectedRecord={null}
          />
        </MemoryRouter>,
      );
      const row = screen.getByRole("button", {
        name: "View details for Product Engineer at Acme",
      });
      const description = document.getElementById(
        row.getAttribute("aria-describedby") ?? "",
      )?.textContent;
      expect(description).toContain(
        state === "filling"
          ? "Preparation attempt Preparing"
          : "Preparation attempt Applied",
      );
      expect(description).not.toMatch(
        /No apply attempt|Needs follow-up|Ready to send/,
      );
    },
  );

  it("leaves the title and count to the page header instead of repeating them", () => {
    render(
      <MemoryRouter>
        <ApplicationsRecordsPanel
          activeFilter="all"
          applicationRecords={[]}
          filterCounts={{
            all: 0,
            needs_action: 0,
            in_progress: 0,
            submitted: 0,
            manual_only: 0,
          }}
          hasAnyApplications={false}
          onFilterChange={vi.fn()}
          onSelectRecord={vi.fn()}
          selectedRecord={null}
        />
      </MemoryRouter>,
    );

    expect(
      screen.queryByRole("heading", { name: "All applications" }),
    ).toBeNull();
    expect(screen.queryByText(/^\d+ applications?$/i)).toBeNull();
    expect(screen.queryByText("Application tracker")).toBeNull();
    expect(screen.getByText("Nothing applied to yet")).toBeTruthy();
    expect(
      screen.getByText(
        /Press Apply on a shortlisted job and it shows up here/i,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("group", { name: "Application filters" }),
    ).toBeNull();
  });

  it("shows no filter row when there is nothing to filter", () => {
    const record: ApplicationRecord = {
      id: "application_1",
      jobId: "job_1",
      title: "Product Engineer",
      company: "Acme",
      status: "ready_for_review",
      lastActionLabel: "Resume approved",
      nextActionLabel: "Apply",
      lastUpdatedAt: "2026-08-09T08:00:00.000Z",
      lastAttemptState: "paused",
      questionSummary: {
        total: 0,
        required: 0,
        answered: 0,
        unansweredRequired: 0,
      },
      latestBlocker: null,
      consentSummary: { status: "none", pendingCount: 0 },
      replaySummary: {
        sourceInstructionArtifactId: null,
        lastUrl: null,
        checkpointCount: 0,
        evidenceCount: 0,
      },
      events: [],
      crm: null,
      automationMode: "prepare_only" as const,
    };

    render(
      <MemoryRouter>
        <ApplicationsRecordsPanel
          activeFilter="all"
          applicationRecords={[record]}
          filterCounts={{
            all: 1,
            needs_action: 0,
            in_progress: 1,
            submitted: 0,
            manual_only: 0,
          }}
          hasAnyApplications
          onFilterChange={vi.fn()}
          onSelectRecord={vi.fn()}
          selectedRecord={null}
        />
      </MemoryRouter>,
    );

    // One application: no search, stage or view could change the list, so
    // the panel opens on the row itself.
    expect(
      screen.queryByRole("group", { name: "Application filters" }),
    ).toBeNull();
  });

  it("gives each row one clear whole-row details action", () => {
    const onSelectRecord = vi.fn();
    const applicationRecords: ApplicationRecord[] = ["1", "2", "3"].map(
      (suffix) =>
        ({
          id: `application_${suffix}`,
          jobId: `job_${suffix}`,
          title: `Product Engineer ${suffix}`,
          company: "Acme",
          status: "ready_for_review",
          lastActionLabel: "Resume approved",
          nextActionLabel: "Apply",
          lastUpdatedAt: "2026-08-09T08:00:00.000Z",
          lastAttemptState: "paused",
          questionSummary: {
            total: 0,
            required: 0,
            answered: 0,
            unansweredRequired: 0,
          },
          latestBlocker: null,
          consentSummary: { status: "none", pendingCount: 0 },
          replaySummary: {
            sourceInstructionArtifactId: null,
            lastUrl: null,
            checkpointCount: 0,
            evidenceCount: 0,
          },
          events: [],
          crm: null,
          automationMode: "prepare_only" as const,
        }) as ApplicationRecord,
    );

    render(
      <MemoryRouter>
        <ApplicationsRecordsPanel
          activeFilter="all"
          applicationRecords={applicationRecords}
          filterCounts={{
            all: applicationRecords.length,
            needs_action: 0,
            in_progress: applicationRecords.length,
            submitted: 0,
            manual_only: 0,
          }}
          hasAnyApplications
          onFilterChange={vi.fn()}
          onSelectRecord={onSelectRecord}
          selectedRecord={null}
        />
      </MemoryRouter>,
    );

    const firstRowAction = screen.getByRole("button", {
      name: "View details for Product Engineer 1 at Acme",
    });
    // The row IS the action now (the shared SelectableRow primitive), rather
    // than an absolutely positioned overlay button on top of the content.
    expect(firstRowAction.getAttribute("data-slot")).toBe("selectable-row");
    expect(firstRowAction.className).toContain("w-full");
    expect(firstRowAction.className).not.toContain("absolute");
    fireEvent.click(firstRowAction);
    expect(onSelectRecord).toHaveBeenCalledWith("application_1");

    // Needs you already covers paused prep — do not also announce the
    // redundant "Needs follow-up" attempt badge.
    const stateDescriptionId = firstRowAction.getAttribute("aria-describedby");
    expect(stateDescriptionId).toBeTruthy();
    expect(document.getElementById(stateDescriptionId!)?.textContent).toBe(
      "Status Needs you.",
    );
    expect(screen.queryByText("Needs follow-up")).toBeNull();
    expect(firstRowAction.getAttribute("aria-keyshortcuts")).toBe(
      "ArrowUp ArrowDown Home End",
    );

    fireEvent.keyDown(firstRowAction, { key: "ArrowDown" });
    expect(onSelectRecord).toHaveBeenLastCalledWith("application_2");

    const secondRowAction = screen.getByRole("button", {
      name: "View details for Product Engineer 2 at Acme",
    });
    expect(secondRowAction.getAttribute("data-collection-item-id")).toBe(
      "application_2",
    );
    fireEvent.keyDown(secondRowAction, { key: "End" });
    expect(onSelectRecord).toHaveBeenLastCalledWith("application_3");
    fireEvent.keyDown(secondRowAction, { key: "Home" });
    expect(onSelectRecord).toHaveBeenLastCalledWith("application_1");
    expect(onSelectRecord).toHaveBeenCalledTimes(4);
  });

  it("uses a labeled responsive summary instead of a horizontally scrolling table", () => {
    const record: ApplicationRecord = {
      id: "application_1",
      jobId: "job_1",
      title: "Senior Product Engineer for Developer Experience",
      company: "Acme International Technology Group",
      status: "ready_for_review",
      lastActionLabel: "A detailed resume was approved for this application",
      nextActionLabel: "Apply",
      lastUpdatedAt: "2026-08-09T08:00:00.000Z",
      lastAttemptState: "paused",
      questionSummary: {
        total: 0,
        required: 0,
        answered: 0,
        unansweredRequired: 0,
      },
      latestBlocker: null,
      consentSummary: { status: "none", pendingCount: 0 },
      replaySummary: {
        sourceInstructionArtifactId: null,
        lastUrl: null,
        checkpointCount: 0,
        evidenceCount: 0,
      },
      events: [],
      crm: null,
      automationMode: "prepare_only" as const,
    };

    render(
      <MemoryRouter>
        <ApplicationsRecordsPanel
          activeFilter="all"
          applicationRecords={[record]}
          filterCounts={{
            all: 1,
            needs_action: 0,
            in_progress: 1,
            submitted: 0,
            manual_only: 0,
          }}
          hasAnyApplications
          onFilterChange={vi.fn()}
          onSelectRecord={vi.fn()}
          selectedRecord={record}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("table")).toBeNull();
    const applications = screen.getByRole("list", { name: "Applications" });
    expect(applications.className).toContain("overflow-x-hidden");

    const application = within(applications).getByRole("listitem");
    expect(application.textContent).toContain(record.title);
    expect(application.textContent).toContain(record.company);
    expect(application.textContent).toContain(record.nextActionLabel);
    expect(
      within(application)
        .getByRole("button", {
          name: `View details for ${record.title} at ${record.company}`,
        })
        .getAttribute("aria-current"),
    ).toBe("true");

    const rowAction = application.querySelector('[data-slot="selectable-row"]');
    // Padding is owned by the primitive so it cannot vary with selection.
    expect(rowAction?.className).toContain("px-4 py-3");
    expect(rowAction?.className).not.toContain("py-4");
    // One shared list treatment across Find jobs, Shortlisted and
    // Applications: a title line with the status badge trailing it, not this
    // list's own two-column grid. `list-row.test.tsx` pins that the three
    // panels agree; this pins what the Applications row itself renders.
    const rowLines = rowAction?.firstElementChild;
    expect(rowLines?.className).toBe(jobFinderListRowLinesClassName);
    const rowTitleLine = rowLines?.firstElementChild;
    expect(rowTitleLine?.className).toBe(jobFinderListRowTitleLineClassName);
    const rowBadgeSlot = rowTitleLine?.lastElementChild;
    expect(rowBadgeSlot?.className).toBe(jobFinderListRowBadgeSlotClassName);
    expect(rowBadgeSlot?.textContent).toContain("Needs you");
    expect(within(application).queryByText("Job")).toBeNull();
    expect(within(application).queryByText("Latest activity")).toBeNull();
    // The status is announced exactly once, through the row description.
    expect(within(application).queryByText("Status")).toBeNull();
    expect((application.textContent ?? "").split("Status").length - 1).toBe(1);
    // Needs you already covers paused prep — no second "Needs follow-up" badge.
    expect(within(application).queryByText("Apply attempt")).toBeNull();
    expect(within(application).queryByText("Needs follow-up")).toBeNull();
    // Employer plus exactly one status line: the paused next step is not
    // repeated as a latest-activity subtitle above "Next:".
    const rowText = application.textContent ?? "";
    expect(rowText.split(record.nextActionLabel ?? "").length - 1).toBe(1);
    expect(rowText).not.toContain(record.lastActionLabel);
    expect(rowText).not.toContain(" • ");
  });

  it("keeps the preparation header compact with one reachable filter row", () => {
    const onFilterChange = vi.fn();
    const record: ApplicationRecord = {
      id: "application_1",
      jobId: "job_1",
      title: "Product Engineer",
      company: "Acme",
      status: "ready_for_review",
      lastActionLabel: "Resume approved",
      nextActionLabel: "Apply",
      lastUpdatedAt: "2026-08-09T08:00:00.000Z",
      lastAttemptState: "paused",
      questionSummary: {
        total: 0,
        required: 0,
        answered: 0,
        unansweredRequired: 0,
      },
      latestBlocker: null,
      consentSummary: { status: "none", pendingCount: 0 },
      replaySummary: {
        sourceInstructionArtifactId: null,
        lastUrl: null,
        checkpointCount: 0,
        evidenceCount: 0,
      },
      events: [],
      crm: null,
      automationMode: "prepare_only" as const,
    };

    const { container } = render(
      <MemoryRouter>
        <ApplicationsRecordsPanel
          activeFilter="needs_action"
          applicationRecords={[record]}
          filterCounts={{
            all: 1,
            needs_action: 0,
            in_progress: 1,
            submitted: 0,
            manual_only: 0,
          }}
          hasAnyApplications
          onFilterChange={onFilterChange}
          onSelectRecord={vi.fn()}
          selectedRecord={null}
        />
      </MemoryRouter>,
    );

    // The toolbar is the panel's first row: no panel title above it.
    const toolbar = container.querySelector(":scope > section > div");
    expect(toolbar?.hasAttribute("data-applications-list-toolbar")).toBe(true);
    expect(toolbar?.className).toContain("min-h-12");
    expect(toolbar?.className).toContain("px-3");
    expect(container.querySelector("section h2")).toBeNull();

    const filterGroup = screen.getByRole("group", {
      name: "Application filters",
    });
    expect(filterGroup).toBe(toolbar);
    expect(filterGroup.className).toContain("flex-wrap");
    expect(filterGroup.className).toContain("w-full");

    const filterButtons = within(filterGroup).getAllByRole("button");
    expect(filterButtons.length).toBeGreaterThan(1);
    for (const filterButton of filterButtons) {
      expect(filterButton.className).toContain("shrink-0");
      // Chips are the 24px size so they share the toolbar row.
      expect(filterButton.className).toContain("h-6");
    }

    // Views that could not change the list are hidden; the active view and
    // All, the way back from it, stay reachable.
    expect(screen.queryByRole("button", { name: /submitted/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /manual only/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^All/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /waiting on you/i }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect(onFilterChange).toHaveBeenCalledWith("all");
  });

  it("names the waiting-applications filter apart from the Needs you step badge", () => {
    // One application paused on a browser step the user must finish — the row
    // the "Needs you" badge marks — plus one failed application that is also
    // waiting on the user but is not that step. The filter chip counts the
    // superset (2) and must not also be called "Needs you"; the badge keeps
    // that name for the one paused row. (The header's own unresolved-step
    // count lives in the shell and is not rendered here.)
    const baseRecord = {
      company: "Acme",
      lastActionLabel: "Resume approved",
      lastUpdatedAt: "2026-08-09T08:00:00.000Z",
      questionSummary: {
        total: 0,
        required: 0,
        answered: 0,
        unansweredRequired: 0,
      },
      latestBlocker: null,
      consentSummary: { status: "none", pendingCount: 0 },
      replaySummary: {
        sourceInstructionArtifactId: null,
        lastUrl: null,
        checkpointCount: 0,
        evidenceCount: 0,
      },
      events: [],
      crm: null,
      automationMode: "prepare_only" as const,
    } as const;
    const pausedOnBrowserStep = {
      ...baseRecord,
      id: "application_paused",
      jobId: "job_paused",
      title: "Product Engineer",
      status: "ready_for_review",
      nextActionLabel: "Finish the open application yourself",
      lastAttemptState: "paused",
    } as unknown as ApplicationRecord;
    const failedAttempt = {
      ...baseRecord,
      id: "application_failed",
      jobId: "job_failed",
      title: "Platform Engineer",
      status: "ready_for_review",
      nextActionLabel: "Retry preparation later",
      lastAttemptState: "failed",
    } as unknown as ApplicationRecord;
    const applicationRecords = [pausedOnBrowserStep, failedAttempt];
    // One shared selector owns the count, exactly as the screen derives it.
    const filterCounts = Object.fromEntries(
      APPLICATION_FILTERS.map((filter) => [
        filter,
        applicationRecords.filter((record) =>
          matchesApplicationsFilter(record, filter),
        ).length,
      ]),
    ) as Record<ApplicationsViewFilter, number>;
    expect(filterCounts.needs_action).toBe(2);

    render(
      <MemoryRouter>
        <ApplicationsRecordsPanel
          // Both applications wait on the person, so the view is offered
          // only once it is the active one.
          activeFilter="needs_action"
          applicationRecords={applicationRecords}
          filterCounts={filterCounts}
          hasAnyApplications
          onFilterChange={vi.fn()}
          onSelectRecord={vi.fn()}
          selectedRecord={null}
        />
      </MemoryRouter>,
    );

    const filterGroup = screen.getByRole("group", {
      name: "Application filters",
    });
    // The superset view names its own population and its unit, so its "2"
    // cannot be read against the header's "Needs you: 1 unresolved".
    const waitingFilter = within(filterGroup).getByRole("button", {
      name: "Waiting on you: 2 applications",
    });
    expect(waitingFilter.textContent).toContain("Waiting on you");
    expect(waitingFilter.textContent).toContain("2");
    expect(
      within(filterGroup).queryByRole("button", { name: /needs you/i }),
    ).toBeNull();
    for (const filterButton of within(filterGroup).getAllByRole("button")) {
      expect(filterButton.textContent).not.toContain("Needs you");
    }

    // Exactly one row carries the "Needs you" step badge: the paused one.
    const rows = within(
      screen.getByRole("list", { name: "Applications" }),
    ).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Needs you")).toBeTruthy();
    expect(within(rows[1]!).queryByText("Needs you")).toBeNull();
    expect(within(rows[1]!).getByText("Could not apply")).toBeTruthy();
  });

  it("filters by the newest five-state result instead of the older record stage", () => {
    const ready = {
      id: "application_ready",
      jobId: "job_ready",
      automationMode: "prepare_only",
      nextActionLabel: "Review",
      status: "ready_for_review",
      lastAttemptState: "in_progress",
    } as unknown as ApplicationRecord;
    const needsYou = {
      id: "application_question",
      jobId: "job_question",
      automationMode: "prepare_only",
      nextActionLabel: "Answer",
      status: "ready_for_review",
      lastAttemptState: "failed",
    } as unknown as ApplicationRecord;

    expect(
      matchesApplicationsFilter(ready, "in_progress", "ready_to_send"),
    ).toBe(false);
    // A form left for the person to send waits on them.
    expect(
      matchesApplicationsFilter(ready, "needs_action", "ready_to_send"),
    ).toBe(true);
    expect(
      matchesApplicationsFilter(needsYou, "needs_action", "needs_you"),
    ).toBe(true);
    expect(
      matchesApplicationsFilter(needsYou, "in_progress", "needs_you"),
    ).toBe(false);
  });

  it("keeps a large application list bounded to one page", () => {
    const applicationRecords = Array.from(
      { length: 226 },
      (_, index) =>
        ({
          id: `application_${index}`,
          jobId: `job_${index}`,
          title: `Product Engineer ${index}`,
          company: "Acme",
          status: "ready_for_review",
          lastActionLabel: "Resume approved",
          nextActionLabel: "Apply",
          lastUpdatedAt: "2026-08-09T08:00:00.000Z",
          lastAttemptState: "paused",
          questionSummary: {
            total: 0,
            required: 0,
            answered: 0,
            unansweredRequired: 0,
          },
          latestBlocker: null,
          consentSummary: { status: "none", pendingCount: 0 },
          replaySummary: {
            sourceInstructionArtifactId: null,
            lastUrl: null,
            checkpointCount: 0,
            evidenceCount: 0,
          },
          events: [],
          crm: null,
          automationMode: "prepare_only" as const,
        }) as ApplicationRecord,
    );

    render(
      <MemoryRouter>
        <ApplicationsRecordsPanel
          activeFilter="all"
          applicationRecords={applicationRecords}
          filterCounts={{
            all: 226,
            needs_action: 0,
            in_progress: 226,
            submitted: 0,
            manual_only: 0,
          }}
          hasAnyApplications
          onFilterChange={vi.fn()}
          onSelectRecord={vi.fn()}
          selectedRecord={null}
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(50);
    expect(
      screen.getByRole("navigation", { name: "applications pagination" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(50);
    expect(screen.getByText("Product Engineer 50")).toBeTruthy();
  });

  it("marks the records list as the locked pane scroll region", () => {
    const record: ApplicationRecord = {
      id: "application_scroll_region",
      jobId: "job_scroll_region",
      title: "Product Engineer",
      company: "Acme",
      status: "ready_for_review",
      lastActionLabel: "Resume approved",
      nextActionLabel: "Apply",
      lastUpdatedAt: "2026-08-09T08:00:00.000Z",
      lastAttemptState: "paused",
      questionSummary: {
        total: 0,
        required: 0,
        answered: 0,
        unansweredRequired: 0,
      },
      latestBlocker: null,
      consentSummary: { status: "none", pendingCount: 0 },
      replaySummary: {
        sourceInstructionArtifactId: null,
        lastUrl: null,
        checkpointCount: 0,
        evidenceCount: 0,
      },
      events: [],
      crm: null,
      automationMode: "prepare_only" as const,
    };

    const { container } = render(
      <MemoryRouter>
        <ApplicationsRecordsPanel
          activeFilter="all"
          applicationRecords={[record]}
          filterCounts={{
            all: 1,
            needs_action: 0,
            in_progress: 1,
            submitted: 0,
            manual_only: 0,
          }}
          hasAnyApplications
          onFilterChange={vi.fn()}
          onSelectRecord={vi.fn()}
          selectedRecord={null}
        />
      </MemoryRouter>,
    );

    expect(
      container.querySelectorAll("[data-locked-pane-scroll-region]"),
    ).toHaveLength(1);
    const region = container.querySelector<HTMLElement>(
      "[data-locked-pane-scroll-region]",
    );
    expect(region?.tagName).toBe("UL");
    expect(region?.getAttribute("aria-label")).toBe("Applications");
    expect(region?.className).toContain("overflow-y-auto");
  });

  it("announces an interrupted attempt as failed and never as in progress", () => {
    const record: ApplicationRecord = {
      id: "application_interrupted",
      jobId: "job_1",
      title: "Staff Product Designer",
      company: "Consent Labs",
      status: "approved",
      lastActionLabel: "Preparation stopped when the app closed.",
      nextActionLabel: "Retry preparation when you are ready.",
      lastUpdatedAt: "2026-08-25T23:45:00.000Z",
      lastAttemptState: "failed",
      questionSummary: {
        total: 2,
        required: 2,
        answered: 1,
        unansweredRequired: 1,
      },
      latestBlocker: null,
      consentSummary: { status: "none", pendingCount: 0 },
      replaySummary: {
        sourceInstructionArtifactId: null,
        lastUrl: null,
        checkpointCount: 0,
        evidenceCount: 0,
      },
      events: [],
      crm: null,
      automationMode: "prepare_only" as const,
    };

    render(
      <MemoryRouter>
        <ApplicationsRecordsPanel
          activeFilter="all"
          applicationRecords={[record]}
          filterCounts={{
            all: 1,
            needs_action: 1,
            in_progress: 0,
            submitted: 0,
            manual_only: 0,
          }}
          hasAnyApplications
          onFilterChange={vi.fn()}
          onSelectRecord={vi.fn()}
          selectedRecord={null}
        />
      </MemoryRouter>,
    );

    // The filter chip label legitimately says "In progress" (with a zero
    // count); the row surfaces themselves must never claim it.
    const rowRegion = document.querySelector(
      "[data-locked-pane-scroll-region]",
    );
    expect(rowRegion?.textContent ?? "").not.toMatch(/In progress/);
    expect(screen.getByText("Could not apply")).not.toBeNull();
    // "Needs recovery" already says the attempt failed; the row carries one
    // badge, and the failure detail lives in the panel.
    expect(screen.queryByText("Attempt failed")).toBeNull();

    const rowAction = screen.getByRole("button", {
      name: "View details for Staff Product Designer at Consent Labs",
    });
    const stateDescriptionId = rowAction.getAttribute("aria-describedby");
    expect(stateDescriptionId).toBeTruthy();
    expect(document.getElementById(stateDescriptionId!)?.textContent).toBe(
      "Status Could not apply. Preparation attempt Attempt failed.",
    );
  });

  it("omits Employer not stated and infers Wellfound listing origin", () => {
    const record: ApplicationRecord = {
      id: "application_wellfound",
      jobId: "job_wellfound",
      title: "AI Product Engineer",
      company: "Employer not stated",
      status: "ready_for_review",
      lastActionLabel: "Saved from Find jobs.",
      nextActionLabel: "Prepare this application.",
      lastUpdatedAt: "2026-08-26T10:00:00.000Z",
      lastAttemptState: null,
      questionSummary: {
        total: 0,
        required: 0,
        answered: 0,
        unansweredRequired: 0,
      },
      latestBlocker: null,
      consentSummary: { status: "none", pendingCount: 0 },
      replaySummary: {
        sourceInstructionArtifactId: null,
        lastUrl: null,
        checkpointCount: 0,
        evidenceCount: 0,
      },
      events: [],
      crm: null,
      automationMode: "prepare_only" as const,
    };

    const { rerender } = render(
      <MemoryRouter>
        <ApplicationsRecordsPanel
          activeFilter="all"
          applicationRecords={[record]}
          discoveryJobs={[
            {
              id: "job_wellfound",
              canonicalUrl:
                "https://wellfound.com/jobs/4634158-ai-product-engineer",
            },
          ]}
          filterCounts={{
            all: 1,
            needs_action: 1,
            in_progress: 0,
            submitted: 0,
            manual_only: 0,
          }}
          hasAnyApplications
          onFilterChange={vi.fn()}
          onSelectRecord={vi.fn()}
          selectedRecord={record}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByText("Employer not stated")).toBeNull();
    expect(screen.getByText(/Listing · wellfound.com/)).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "View details for AI Product Engineer at Listing · wellfound.com",
      }),
    ).toBeTruthy();

    rerender(
      <MemoryRouter>
        <ApplicationsRecordsPanel
          activeFilter="all"
          applicationRecords={[record]}
          discoveryJobs={[
            {
              id: "job_wellfound",
              canonicalUrl:
                "https://wellfound.com/company/signal-systems/jobs/123-role",
            },
          ]}
          filterCounts={{
            all: 1,
            needs_action: 1,
            in_progress: 0,
            submitted: 0,
            manual_only: 0,
          }}
          hasAnyApplications
          onFilterChange={vi.fn()}
          onSelectRecord={vi.fn()}
          selectedRecord={record}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByText("Employer not stated")).toBeNull();
    expect(screen.getByText(/Signal Systems/)).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "View details for AI Product Engineer at Signal Systems",
      }),
    ).toBeTruthy();
  });

  it("shows employer recovered at extraction for /jobs/{id} listings", () => {
    // End-to-end display contract: discovery stored company from an observed
    // `/company/{slug}` href even though the listing URL is `/jobs/{id}-…`.
    const record: ApplicationRecord = {
      id: "application_wellfound_extracted",
      jobId: "job_wellfound_extracted",
      title: "Software Engineer II",
      company: "Signal Systems",
      status: "ready_for_review",
      lastActionLabel: "Saved from Find jobs.",
      nextActionLabel: "Prepare this application.",
      lastUpdatedAt: "2026-08-27T10:00:00.000Z",
      lastAttemptState: null,
      questionSummary: {
        total: 0,
        required: 0,
        answered: 0,
        unansweredRequired: 0,
      },
      latestBlocker: null,
      consentSummary: { status: "none", pendingCount: 0 },
      replaySummary: {
        sourceInstructionArtifactId: null,
        lastUrl: null,
        checkpointCount: 0,
        evidenceCount: 0,
      },
      events: [],
      crm: null,
      automationMode: "prepare_only" as const,
    };

    render(
      <MemoryRouter>
        <ApplicationsRecordsPanel
          activeFilter="all"
          applicationRecords={[record]}
          discoveryJobs={[
            {
              id: "job_wellfound_extracted",
              canonicalUrl:
                "https://wellfound.com/jobs/4634158-software-engineer-ii",
            },
          ]}
          filterCounts={{
            all: 1,
            needs_action: 1,
            in_progress: 0,
            submitted: 0,
            manual_only: 0,
          }}
          hasAnyApplications
          onFilterChange={vi.fn()}
          onSelectRecord={vi.fn()}
          selectedRecord={record}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByText("Employer not stated")).toBeNull();
    expect(screen.queryByText(/Listing ·/)).toBeNull();
    expect(screen.getByText(/Signal Systems/)).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "View details for Software Engineer II at Signal Systems",
      }),
    ).toBeTruthy();
  });

  it("gives each row one status pill and one Next sentence", () => {
    const record: ApplicationRecord = {
      id: "application_failed",
      jobId: "job_failed",
      title: "Staff Platform Engineer",
      company: "Northwind",
      status: "ready_for_review",
      lastActionLabel: "Job Finder could not finish this application",
      nextActionLabel: "Try again",
      lastUpdatedAt: "2026-09-01T08:00:00.000Z",
      lastAttemptState: "failed",
      questionSummary: {
        total: 0,
        required: 0,
        answered: 0,
        unansweredRequired: 0,
      },
      latestBlocker: null,
      consentSummary: { status: "none", pendingCount: 0 },
      replaySummary: {
        sourceInstructionArtifactId: null,
        lastUrl: null,
        checkpointCount: 0,
        evidenceCount: 0,
      },
      events: [],
      crm: null,
      automationMode: "prepare_only" as const,
    };

    render(
      <MemoryRouter>
        <ApplicationsRecordsPanel
          activeFilter="all"
          applicationRecords={[record]}
          filterCounts={{
            all: 1,
            needs_action: 1,
            in_progress: 0,
            submitted: 0,
            manual_only: 0,
          }}
          hasAnyApplications
          onFilterChange={vi.fn()}
          onSelectRecord={vi.fn()}
          selectedRecord={null}
        />
      </MemoryRouter>,
    );

    const application = within(
      screen.getByRole("list", { name: "Applications" }),
    ).getByRole("listitem");
    // Title, company, exactly one status pill, one "Next:" line — never a
    // second pill restating the same state a different way.
    expect(application.querySelectorAll('[data-slot="badge"]')).toHaveLength(1);
    expect(within(application).queryByText("Attempt failed")).toBeNull();
    expect(application.textContent).toContain("Staff Platform Engineer");
    expect(application.textContent).toContain("Northwind");
    expect(application.textContent).toContain("Next: Try again");
  });

  it("never calls a job held by the person's pause Filling in", () => {
    const record = {
      id: "application_held",
      jobId: "job_held",
      title: "Frontend Engineer",
      company: "Dusk",
      status: "ready_for_review",
      lastActionLabel: "Waiting its turn in this run.",
      nextActionLabel: "Review the prepared run approval in Applications.",
      lastUpdatedAt: "2026-09-01T08:00:00.000Z",
      lastAttemptState: "in_progress",
      questionSummary: {
        total: 0,
        required: 0,
        answered: 0,
        unansweredRequired: 0,
      },
      latestBlocker: null,
      consentSummary: { status: "none", pendingCount: 0 },
      replaySummary: {
        sourceInstructionArtifactId: null,
        lastUrl: null,
        checkpointCount: 0,
        evidenceCount: 0,
      },
      events: [],
      crm: null,
      automationMode: "prepare_only" as const,
    } as ApplicationRecord;
    const result = {
      id: "result_held",
      runId: "run_1",
      jobId: "job_held",
      applicationRecordId: "application_held",
      state: "planned",
      startedAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-01T08:00:00.000Z",
      completedAt: null,
    } as unknown as ApplyJobResult;

    render(
      <MemoryRouter>
        <ApplicationsRecordsPanel
          activeFilter="all"
          applicationRecords={[record]}
          filterCounts={{
            all: 1,
            needs_action: 0,
            in_progress: 1,
            submitted: 0,
            manual_only: 0,
          }}
          hasAnyApplications
          latestApplyResultByRecordId={new Map([[record.id, result]])}
          liveRunLinesByJobId={
            new Map([
              [
                "job_held",
                "Paused before this application. It carries on when you resume.",
              ],
            ])
          }
          readApplyRunContext={() => ({
            state: "running",
            activityPaused: true,
            started: true,
          })}
          onFilterChange={vi.fn()}
          onSelectRecord={vi.fn()}
          selectedRecord={null}
        />
      </MemoryRouter>,
    );

    const application = within(
      screen.getByRole("list", { name: "Applications" }),
    ).getByRole("listitem");
    const badge = application.querySelector('[data-slot="badge"]');
    expect(badge?.textContent).toBe("Preparing");
    expect(application.textContent).not.toContain("Filling in");
  });
});

it("finds a company and an offer across 300 applications before paging", () => {
  const records = Array.from({ length: 300 }, (_, index) =>
    ApplicationRecordSchema.parse({
      id: `application_${index}`,
      jobId: `job_${index}`,
      title: index === 299 ? "Design Lead" : `Role ${index}`,
      company: index === 299 ? "Willow" : "Acorn",
      status: index === 299 ? "offer" : "submitted",
      lastActionLabel: "Tracked",
      nextActionLabel: null,
      lastUpdatedAt: "2026-10-02T10:00:00Z",
    }),
  );
  render(
    <MemoryRouter>
      <ApplicationsRecordsPanel
        activeFilter="all"
        applicationRecords={records}
        filterCounts={{
          all: 300,
          needs_action: 0,
          in_progress: 0,
          submitted: 299,
          manual_only: 0,
        }}
        hasAnyApplications
        onFilterChange={vi.fn()}
        onSelectRecord={vi.fn()}
        selectedRecord={null}
      />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText("Search applications"), {
    target: { value: "Willow" },
  });
  expect(screen.getByText("Design Lead")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search applications"), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("combobox", { name: "Hiring stage" }));
  fireEvent.click(screen.getByRole("option", { name: "Offer" }));
  expect(screen.getByText("Design Lead")).toBeTruthy();
  expect(screen.queryByText("Role 0")).toBeNull();
});

it("counts chips from unarchived search and stage matches and keeps filters in one row", () => {
  const records = ["visible", "archived", "other"].map((id) =>
    ApplicationRecordSchema.parse({
      id,
      jobId: id,
      title: "Engineer",
      company: id === "other" ? "Other" : "Acme",
      // "other" is still being filled in, so the Submitted view and the
      // stage picker each have something to choose between.
      status: id === "other" ? "drafting" : "submitted",
      lastActionLabel: "Sent",
      nextActionLabel: null,
      lastUpdatedAt: "2026-10-05T10:00:00Z",
      crm: {
        stage: id === "other" ? "preparing" : "applied",
        stageSource: "user",
        stageChangedAt: "2026-10-05T10:00:00Z",
        archivedAt: id === "archived" ? "2026-10-05T10:00:00Z" : null,
      },
    }),
  );
  render(
    <MemoryRouter>
      <ApplicationsRecordsPanel
        activeFilter="all"
        applicationRecords={records}
        filterCounts={{
          all: 3,
          needs_action: 0,
          submitted: 3,
          in_progress: 0,
          manual_only: 0,
        }}
        hasAnyApplications
        onFilterChange={vi.fn()}
        onSelectRecord={vi.fn()}
        selectedRecord={null}
      />
    </MemoryRouter>,
  );
  expect(
    screen.getByRole("button", { name: "All: 2 applications" }),
  ).toBeTruthy();
  const group = screen.getByRole("group", { name: "Application filters" });
  expect(group.contains(screen.getByLabelText("Search applications"))).toBe(
    true,
  );
  expect(
    group.contains(screen.getByRole("combobox", { name: "Hiring stage" })),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Search applications"), {
    target: { value: "Acme" },
  });
  expect(
    screen.getByRole("button", { name: "All: 1 application" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Submitted: 1 application" }),
  ).toBeTruthy();
  // The count lives on the All chip; the panel does not repeat it.
  expect(screen.queryByText("1 application")).toBeNull();
});

it("distinguishes equal titles and companies by location in rows and accessible names", () => {
  const records = ["Beirut/MENA", "Manchester"].map((location, i) =>
    ApplicationRecordSchema.parse({
      id: `app_${i}`,
      jobId: `job_${i}`,
      title: "Senior Accountant",
      company: "Spool Hushmeadow",
      status: "approved",
      lastActionLabel: "Prepared",
      nextActionLabel: "Review",
      lastUpdatedAt: "2026-10-05T10:00:00.000Z",
    }),
  );
  render(
    <MemoryRouter>
      <ApplicationsRecordsPanel
        activeFilter="all"
        applicationRecords={records}
        discoveryJobs={records.map((record, i) => ({
          id: record.jobId,
          canonicalUrl: `https://example.test/jobs/${i}`,
          location: i === 0 ? "Beirut/MENA" : "Manchester",
        }))}
        filterCounts={{
          all: 2,
          needs_action: 0,
          in_progress: 0,
          submitted: 0,
          manual_only: 0,
        }}
        hasAnyApplications
        onFilterChange={vi.fn()}
        onSelectRecord={vi.fn()}
        selectedRecord={null}
      />
    </MemoryRouter>,
  );
  for (const location of ["Beirut/MENA", "Manchester"])
    expect(
      screen.getByRole("button", {
        name: new RegExp(`View details for.*${location}`),
      }),
    ).toBeTruthy();
});
