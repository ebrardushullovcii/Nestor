// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { EmptyPane, ListPane, ListRowFrame, NO_SELECTION } from "./index";
import { rowName } from "./list-pane";

const ROWS = [1, 2].map((id) => ({ id, title: `Designer ${id}` }));

function List(props: { label: string; rows: typeof ROWS }) {
  return (
    <ListPane
      activeId={null}
      empty={<p>No approved resumes yet</p>}
      hasMore={false}
      label={props.label}
      loading={false}
      onLoadMore={() => undefined}
      onSelectionChange={() => undefined}
      renderRow={(row, state) => (
        <ListRowFrame
          {...state}
          id={row.id}
          meta="Acme"
          onActivate={() => undefined}
          onToggle={() => undefined}
          title={row.title}
        />
      )}
      rows={props.rows}
      selectedCount={0}
      selection={NO_SELECTION}
      total={props.rows.length}
      totalCapped={false}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(window, {
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("shows another list's empty state at once: the last tab's rows do not fade out over it", () => {
  const { rerender } = render(<List label="Resumes to review" rows={ROWS} />);
  rerender(<List label="Approved resumes" rows={[]} />);
  // No timer has run: nothing is left fading.
  expect(screen.getByText("No approved resumes yet")).toBeTruthy();
  expect(document.querySelector("[data-exiting]")).toBeNull();
});

it("still fades out a row that leaves the same list", () => {
  const { rerender } = render(<List label="Resumes to review" rows={ROWS} />);
  rerender(<List label="Resumes to review" rows={ROWS.slice(1)} />);
  expect(document.querySelector("[data-exiting]")).not.toBeNull();
});

it("reads each row as its parts, named from its data, not its drawn text", () => {
  render(<List label="Resumes to review" rows={ROWS} />);
  const row = screen.getByRole("button", { name: /^Designer 1/ });
  expect(row.getAttribute("aria-label")).toBe("Designer 1, Acme");
});

it("builds a row name with plain commas and no middle dots", () => {
  expect(
    rowName({
      title: "UX Engineer",
      badge: "86, Strong fit",
      meta: "Copperleaf Systems · Amsterdam",
      reason: "Matches your accessibility focus",
      trailing: "2 days ago",
    }),
  ).toBe(
    "UX Engineer, 86, Strong fit, Copperleaf Systems, Amsterdam, Matches your accessibility focus, 2 days ago",
  );
});

it("asks for nothing beside an empty or unread list", () => {
  render(
    <>
      <EmptyPane label="Resume" list="empty">
        Pick a job to see its resume.
      </EmptyPane>
      <EmptyPane id="other" label="Application details" list="failed">
        Pick an application to see where it stands.
      </EmptyPane>
    </>,
  );
  expect(screen.queryByText(/Pick a/)).toBeNull();
  expect(screen.getByText("Nothing to open here yet.")).toBeTruthy();
  expect(
    screen.getByText("Nothing to show until the list is read."),
  ).toBeTruthy();
});
