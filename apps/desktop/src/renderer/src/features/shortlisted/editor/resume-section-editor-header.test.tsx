// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResumeDraftSection } from "@nestor/contracts";
import { ResumeSectionHeaderActions } from "./resume-section-editor-header";

function buildSection(
  overrides: Partial<ResumeDraftSection> = {},
): ResumeDraftSection {
  return {
    id: "section_experience",
    kind: "experience",
    label: "Experience",
    text: null,
    bullets: [],
    entries: [
      {
        id: "entry_1",
        entryType: "experience",
        title: "Senior Engineer",
        subtitle: "Example Co",
        location: null,
        dateRange: "2022 - Present",
        startDate: null,
        endDate: null,
        isCurrent: true,
        summary: null,
        bullets: [],
        origin: "imported",
        locked: false,
        included: true,
        sortOrder: 0,
        profileRecordId: null,
        sourceRefs: [],
        updatedAt: "2026-04-26T12:00:00.000Z",
      },
    ],
    origin: "imported",
    locked: false,
    included: true,
    sortOrder: 1,
    entryOrderMode: "chronology",
    profileRecordId: null,
    sourceRefs: [],
    updatedAt: "2026-04-26T12:00:00.000Z",
    ...overrides,
  };
}

function renderHeader(section: ResumeDraftSection, isExpanded = true) {
  const onPatch = vi.fn();
  const onToggleExpanded = vi.fn();

  render(
    <ResumeSectionHeaderActions
      bodyId="section-body"
      disabled={false}
      isExpanded={isExpanded}
      onPatch={onPatch}
      onToggleExpanded={onToggleExpanded}
      section={section}
    />,
  );

  return { onPatch, onToggleExpanded };
}

describe("ResumeSectionHeaderActions", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows no status chip while the section is in its default state", () => {
    renderHeader(buildSection());

    for (const defaultLabel of ["Shown", "Editable", "Chronology"]) {
      expect(screen.queryByText(defaultLabel)).toBeNull();
    }
    expect(screen.getByText("Experience")).toBeTruthy();
  });

  it("announces only the non-default states", () => {
    renderHeader(
      buildSection({
        included: false,
        locked: true,
        entryOrderMode: "manual",
      }),
    );

    expect(screen.getByText("Hidden")).toBeTruthy();
    expect(screen.getByText("Locked")).toBeTruthy();
    expect(screen.getByText("Manual order")).toBeTruthy();
  });

  it("requires unlocking before hiding a section", () => {
    const { onPatch } = renderHeader(buildSection({ locked: true }));
    const hide = screen.getByRole("button", { name: "Hide section" });
    expect(hide.hasAttribute("disabled")).toBe(true);
    expect(hide.getAttribute("title")).toBe(
      "Unlock this section before hiding it",
    );
    fireEvent.click(hide);
    expect(onPatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unlock section" }));
    expect(onPatch).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "set_lock", newLocked: false }),
      "Unlocked section",
    );
  });

  it("keeps every once-per-section action visibly labelled with a tooltip", () => {
    renderHeader(buildSection({ entryOrderMode: "manual" }));

    for (const [actionName, visibleLabel] of [
      ["Hide section", "Hide"],
      ["Lock section", "Lock"],
      ["Reset to chronology", "Reset order"],
    ] as const) {
      const action = screen.getByRole("button", { name: actionName });
      expect(action.getAttribute("title")).toBe(actionName);
      // A section toolbar renders once, so it carries readable text instead of
      // a row of bare glyphs; per-bullet rows stay icon-only for density.
      expect(action.textContent).toContain(visibleLabel);
    }
  });

  it("no longer offers a per-section AI rewrite", () => {
    renderHeader(buildSection({ entryOrderMode: "manual" }));

    expect(
      screen.queryByRole("button", { name: "Rewrite section" }),
    ).toBeNull();
    expect(screen.queryByText("Rewrite")).toBeNull();
  });

  it("makes the section title the disclosure control", () => {
    const { onToggleExpanded } = renderHeader(buildSection(), false);

    const toggle = screen.getByRole("button", { name: "Experience" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("section-body");

    fireEvent.click(toggle);
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it("still sends the exact typed patches from the icon toolbar", () => {
    const { onPatch } = renderHeader(
      buildSection({ entryOrderMode: "manual" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Hide section" }));
    fireEvent.click(screen.getByRole("button", { name: "Lock section" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Reset to chronology" }),
    );

    expect(onPatch).toHaveBeenCalledTimes(3);
    expect(onPatch.mock.calls[0]?.[0]).toMatchObject({
      operation: "toggle_include",
      targetSectionId: "section_experience",
    });
    expect(onPatch.mock.calls[1]?.[0]).toMatchObject({
      operation: "set_lock",
      targetSectionId: "section_experience",
    });
    expect(onPatch.mock.calls[2]?.[0]).toMatchObject({
      operation: "reset_entry_order",
      targetSectionId: "section_experience",
    });
  });

  it("offers reset-to-chronology only once the order was changed by hand", () => {
    renderHeader(buildSection());

    expect(
      screen.queryByRole("button", { name: "Reset to chronology" }),
    ).toBeNull();
  });
});
