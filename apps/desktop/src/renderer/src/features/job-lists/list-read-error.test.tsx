// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ListPane } from "./list-pane";
import { readErrorText } from "./list-read-error";
import { NO_SELECTION } from "./list-selection";

afterEach(cleanup);

function pane(props: {
  rows: { id: number; title: string }[];
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <ListPane<{ id: number; title: string }>
      activeId={null}
      empty={<p>No jobs yet</p>}
      error={props.error}
      hasMore={false}
      label="Found jobs"
      loading={false}
      onLoadMore={() => undefined}
      onRetry={props.onRetry}
      onSelectionChange={() => undefined}
      renderRow={(row) => <li key={row.id}>{row.title}</li>}
      rows={props.rows}
      selectedCount={0}
      selection={NO_SELECTION}
      total={props.rows.length}
      totalCapped={false}
    />
  );
}

describe("a list that could not be read", () => {
  it("says what failed in place of the empty message, with Try again", () => {
    const onRetry = vi.fn();
    render(
      pane({
        rows: [],
        error:
          "Error invoking remote method 'jobs:run': Error: The job store is locked.",
        onRetry,
      }),
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Couldn’t read found jobs");
    // Electron's channel prefix is not the person's business.
    expect(alert.textContent).toContain("The job store is locked.");
    expect(alert.textContent).not.toContain("remote method");
    expect(screen.queryByText("No jobs yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps rows already shown, with one line above them", () => {
    render(
      pane({
        rows: [{ id: 1, title: "Designer 1" }],
        error: "Could not load the list.",
        onRetry: () => undefined,
      }),
    );
    expect(screen.getByText("Designer 1")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "The rows below may be out of date.",
    );
  });

  it("strips only Electron's prefix from an IPC error", () => {
    expect(
      readErrorText("Error invoking remote method 'x:y': Error: Disk full"),
    ).toBe("Disk full");
    expect(readErrorText("Disk full")).toBe("Disk full");
  });
});
