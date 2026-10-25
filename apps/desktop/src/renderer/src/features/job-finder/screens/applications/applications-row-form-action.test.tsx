// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  PREPARED_PAGE_CLOSED_SUMMARY,
  type ApplicationRecord,
  type ApplyJobResult,
} from "@nestor/contracts";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPLICATION_WORK_PAUSED_REASON } from "../../lib/application-work-paused";
import { ApplicationsRecordsPanel } from "./applications-records-panel";
import {
  READY_PAGE_OPENED_STATUS,
  resetApplicationFormOpenStates,
  type FinishInBrowserHandler,
} from "./application-form-open";

afterEach(() => {
  cleanup();
  resetApplicationFormOpenStates();
  window.localStorage.clear();
});

function fixture(state: ApplyJobResult["state"], summary = "Ready") {
  const record = ApplicationRecordSchema.parse({
    id: `record_${state}`,
    jobId: `job_${state}`,
    title: "Engineer",
    company: "Example",
    status: "approved",
    lastActionLabel: "Filled in",
    nextActionLabel: "Read it over",
    lastUpdatedAt: "2026-10-02T10:00:00.000Z",
  });
  const result = ApplyJobResultSchema.parse({
    id: `result_${state}`,
    runId: "run_1",
    jobId: record.jobId,
    applicationRecordId: record.id,
    state,
    summary,
    detail: "Filled in",
    startedAt: record.lastUpdatedAt,
    updatedAt: record.lastUpdatedAt,
  });
  return { record, result };
}

function renderPanel(
  record: ApplicationRecord,
  result: ApplyJobResult,
  props: {
    onFinishInBrowser?: FinishInBrowserHandler;
    onStartApplyCopilot?: () => void;
    isApplyPending?: boolean;
    applicationWorkPaused?: boolean;
    applyMode?: "fill_only" | "apply_for_me";
  },
) {
  return render(
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
        {...props}
      />
    </MemoryRouter>,
  );
}

describe("Open form on an Applications row", () => {
  it("opens a filled-in form through the hand-off and says so on the row", async () => {
    const { record, result } = fixture("awaiting_review");
    let finish: (value: { kind: "opened_application_page" }) => void = () => {};
    const onFinishInBrowser = vi.fn<FinishInBrowserHandler>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderPanel(record, result, { onFinishInBrowser });

    fireEvent.click(screen.getByRole("button", { name: "Open form" }));
    expect(onFinishInBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: record.jobId,
        resultId: result.id,
        runId: result.runId,
        applicationRecordId: record.id,
      }),
      expect.any(Function),
    );
    // Answered at once, before the hand-off settles.
    expect(screen.getByText("Opening the page…")).toBeTruthy();

    await act(async () => {
      finish({ kind: "opened_application_page" });
      await Promise.resolve();
    });
    expect(screen.getByText(READY_PAGE_OPENED_STATUS)).toBeTruthy();
  });

  it("shows a failed open on the row instead of nothing", async () => {
    const { record, result } = fixture("awaiting_review");
    const onFinishInBrowser = vi.fn<FinishInBrowserHandler>(() =>
      Promise.reject(new Error("The browser is closed")),
    );
    renderPanel(record, result, { onFinishInBrowser });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open form" }));
      await Promise.resolve();
    });
    const status = screen.getByText(/did not open/);
    expect(status.textContent).toContain("The browser is closed.");
    expect(status.getAttribute("data-handoff-outcome")).toBe("failed");
  });

  it("prepares a closed form again with the same run the detail panel starts", () => {
    const { record, result } = fixture("failed", PREPARED_PAGE_CLOSED_SUMMARY);
    const onStartApplyCopilot = vi.fn();
    const view = renderPanel(record, result, {
      onFinishInBrowser: vi.fn(),
      onStartApplyCopilot,
    });
    // The line beside the button does not repeat its label.
    expect(screen.queryByText("Next: Prepare again")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Prepare again" }));
    expect(onStartApplyCopilot).toHaveBeenCalledWith({
      jobId: record.jobId,
      applicationRecordId: record.id,
    });
    view.rerender(
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
          onFinishInBrowser={vi.fn()}
          onStartApplyCopilot={onStartApplyCopilot}
          isApplyPending
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Opening the page…")).toBeTruthy();
  });

  it("tries a failed application again from its row, named for the mode", () => {
    const { record, result } = fixture("failed", "The page did not load");
    const onStartApplyCopilot = vi.fn();
    const view = renderPanel(record, result, {
      onFinishInBrowser: vi.fn(),
      onStartApplyCopilot,
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onStartApplyCopilot).toHaveBeenCalledWith({
      jobId: record.jobId,
      applicationRecordId: record.id,
    });
    view.unmount();

    renderPanel(record, result, {
      onFinishInBrowser: vi.fn(),
      onStartApplyCopilot,
      applyMode: "apply_for_me",
    });
    expect(screen.getByRole("button", { name: "Apply again" })).toBeTruthy();
  });

  it("holds a row's Apply again while all work is paused and says why", () => {
    const { record, result } = fixture("failed", "The page did not load");
    const onStartApplyCopilot = vi.fn();
    renderPanel(record, result, {
      onFinishInBrowser: vi.fn(),
      onStartApplyCopilot,
      applyMode: "apply_for_me",
      applicationWorkPaused: true,
    });
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Apply again",
    });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onStartApplyCopilot).not.toHaveBeenCalled();
    expect(screen.getByText(APPLICATION_WORK_PAUSED_REASON)).toBeTruthy();
  });

  it("offers no retry on a row the person cancelled", () => {
    const { record, result } = fixture("cancelled", "Cancelled");
    renderPanel(record, result, {
      onFinishInBrowser: vi.fn(),
      onStartApplyCopilot: vi.fn(),
    });
    expect(screen.queryByTestId("applications-row-form-action")).toBeNull();
  });

  it("offers nothing on a row whose state has no form to open", () => {
    const { record, result } = fixture("submitted", "Sent");
    renderPanel(record, result, {
      onFinishInBrowser: vi.fn(),
      onStartApplyCopilot: vi.fn(),
    });
    expect(screen.queryByTestId("applications-row-form-action")).toBeNull();
  });
});
