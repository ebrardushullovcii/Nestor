// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ProfileOptionalSection } from "./profile-optional-section";

function ClearanceHarness() {
  const [clearance, setClearance] = useState("");

  return (
    <div>
      <input
        aria-label="Security clearance"
        onChange={(event) => setClearance(event.target.value)}
        value={clearance}
      />
      {/* Simulates a section whose defaultOpen expression flips as the user
          types: mount-only open state keeps it from collapsing mid-edit. */}
      <ProfileOptionalSection
        defaultOpen={Boolean(clearance)}
        description="Screening details"
        title="Extra screening details"
      >
        Section body
      </ProfileOptionalSection>
    </div>
  );
}

afterEach(cleanup);

describe("ProfileOptionalSection", () => {
  it("does not collapse while the user fills the field that drives defaultOpen", () => {
    render(<ClearanceHarness />);

    const details = screen
      .getByText("Extra screening details")
      .closest("details");
    if (!(details instanceof HTMLDetailsElement)) {
      throw new Error("Optional section card not found");
    }

    // jsdom keeps <details> children in the DOM even when closed, so assert on
    // the open attribute itself.
    expect(details.open).toBe(false);

    fireEvent.change(screen.getByLabelText("Security clearance"), {
      target: { value: "TS/SCI" },
    });

    // Mount-only defaultOpen: the section does not pop open from typing, and
    // an open section never collapses because its expression flipped.
    expect(details.open).toBe(false);
  });

  it("keeps a mounted-open section open when defaultOpen later becomes false", () => {
    function Harness() {
      const [open, setOpen] = useState(true);

      return (
        <div>
          <button onClick={() => setOpen(false)} type="button">
            Clear saved value
          </button>
          <ProfileOptionalSection
            defaultOpen={open}
            description="Screening details"
            title="Extra screening details"
          >
            Section body
          </ProfileOptionalSection>
        </div>
      );
    }

    render(<Harness />);
    const details = screen
      .getByText("Extra screening details")
      .closest("details");
    if (!(details instanceof HTMLDetailsElement)) {
      throw new Error("Optional section card not found");
    }
    expect(details.open).toBe(true);

    act(() => {
      fireEvent.click(screen.getByText("Clear saved value"));
    });

    expect(details.open).toBe(true);
  });
});

it("scopes the collapsed chevron to its own details inside an open card", () => {
  const { container } = render(
    <details open className="group">
      <ProfileOptionalSection
        title="Team, ownership and industries"
        description="Optional role scope"
      >
        Fields
      </ProfileOptionalSection>
    </details>,
  );
  const inner = screen
    .getByText("Team, ownership and industries")
    .closest("details");
  expect(inner?.hasAttribute("open")).toBe(false);
  // The chevron turns only with its own details (the shared Disclosure's
  // summary > svg rule), never with the outer card's `group`.
  const chevron = inner?.querySelector("summary svg");
  expect(chevron?.getAttribute("class")).toContain(
    "[details[open]>summary>&]:rotate-90",
  );
  expect(chevron?.getAttribute("class")).not.toMatch(/(^|\s)group-open:/);
  expect(container.querySelector("details")?.open).toBe(true);
});
