// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileSectionTabs } from "./profile-section-tabs";

afterEach(cleanup);

const sections = [
  {
    description: "Identity and profile basics",
    id: "basics" as const,
    label: "Basics",
    progress: { filled: 3, percent: 75, total: 4 },
  },
  {
    description: "Work history",
    id: "experience" as const,
    label: "Experience",
    progress: { filled: 2, percent: 50, total: 4 },
  },
];

const fiveSections = [
  ...sections,
  {
    description: "Background and education",
    id: "background" as const,
    label: "Background",
    progress: { filled: 1, percent: 25, total: 4 },
  },
  {
    description: "Search preferences",
    id: "preferences" as const,
    label: "Preferences",
    progress: { filled: 3, percent: 75, total: 4 },
  },
  {
    description: "Job sites",
    id: "sources" as const,
    label: "Job sites",
    progress: { filled: 2, percent: 50, total: 4 },
  },
];

describe("ProfileSectionTabs", () => {
  it("renders through the shared Tabs primitive instead of a bespoke box grid", () => {
    const { container } = render(
      <ProfileSectionTabs
        activeSection="basics"
        onSectionChange={vi.fn()}
        panelId="profile-section-panel"
        sections={fiveSections}
      />,
    );

    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute("data-slot")).toBe("tabs-list");
    // The same `line` variant Resume Studio's Preview/Tools strip uses: one
    // bottom rule under the whole strip, no per-tab box.
    expect(tablist?.getAttribute("data-variant")).toBe("line");
    expect(tablist?.className).toContain("border-b");

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(5);
    for (const tab of tabs) {
      expect(tab.getAttribute("data-slot")).toBe("tabs-trigger");
      // No per-cell border/box treatment of its own.
      expect(tab.className).toContain("border-transparent");
      expect(tab.className).not.toContain("shadow-[inset");
    }
  });

  it("makes the complete visible tab surface the click target", () => {
    const onSectionChange = vi.fn();

    render(
      <ProfileSectionTabs
        activeSection="basics"
        onSectionChange={onSectionChange}
        panelId="profile-section-panel"
        sections={sections}
      />,
    );

    const experienceTab = screen.getByRole("tab", { name: /experience/i });
    // The trigger owns its own padding, so the whole painted cell is the
    // button rather than a box wrapping a smaller inner target.
    expect(experienceTab.className).toContain("px-3.5");
    expect(experienceTab.className).toContain("py-2.5");

    fireEvent.click(experienceTab);
    expect(onSectionChange).toHaveBeenCalledWith("experience");
  });

  it("carries no progress bar: the label is the whole signal", () => {
    render(
      <ProfileSectionTabs
        activeSection="basics"
        onSectionChange={vi.fn()}
        panelId="profile-section-panel"
        sections={sections}
      />,
    );

    for (const tab of screen.getAllByRole("tab")) {
      const fills = Array.from(tab.querySelectorAll("span")).filter((span) =>
        span.className.startsWith("block h-full"),
      );
      expect(fills).toHaveLength(0);
      expect(tab.className).not.toContain("progress-active-start");
    }
  });

  it("keeps completion state out of the tab: no status chips and no per-cell check", () => {
    const { container } = render(
      <ProfileSectionTabs
        activeSection="basics"
        onSectionChange={vi.fn()}
        panelId="profile-section-panel"
        sections={[
          {
            description: "Identity and profile basics",
            id: "basics",
            label: "Basics",
            progress: {
              filled: 17,
              percent: 59,
              required: { filled: 6, total: 6 },
              total: 29,
            },
          },
          {
            description: "Search preferences",
            id: "preferences",
            label: "Preferences",
            progress: {
              filled: 4,
              percent: 12,
              required: { filled: 0, total: 2 },
              total: 33,
            },
          },
          {
            // No required model, some optional fields filled: the state that
            // printed "Optional added".
            description: "Background and education",
            id: "background",
            label: "Background",
            progress: { filled: 2, percent: 100, total: 2 },
          },
          {
            // No required model, nothing filled: the "optional" state, which
            // printed "Optional".
            description: "Job sites",
            id: "sources",
            label: "Job sites",
            progress: { filled: 0, percent: 0, total: 8 },
          },
          {
            // Nothing to fill at all: the "empty" state, which printed
            // "Not started" / "Empty".
            description: "Work history",
            id: "experience",
            label: "Experience",
            progress: { filled: 0, percent: 0, total: 0 },
          },
        ]}
      />,
    );

    const tabs = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    expect(tabs).toHaveLength(5);

    // Every chip string the old grid printed inside its cells, across every
    // progress state that can produce one.
    for (const tab of tabs) {
      expect(tab.textContent).not.toContain("Required done");
      expect(tab.textContent).not.toContain("Optional added");
      expect(tab.textContent).not.toContain("Optional");
      expect(tab.textContent).not.toContain("Not started");
      expect(tab.textContent).not.toContain("Empty");
      expect(tab.textContent).not.toContain("17/29");
      expect(tab.textContent).not.toContain("59%");
      // Words only (one tab idiom across the app); no check icon either.
      expect(tab.querySelectorAll("svg")).toHaveLength(0);
      expect(
        tab.querySelector('svg[class*="check"], svg[class*="circle-check"]'),
      ).toBeNull();
    }

    // A finished section is just its name.
    expect(tabs[0]?.textContent).toBe("Basics");
    // So is every section with no required fields to report on, whatever its
    // optional fill state.
    expect(tabs[2]?.textContent).toBe("Background");
    expect(tabs[3]?.textContent).toBe("Job sites");
    expect(tabs[4]?.textContent).toBe("Experience");
    expect(tabs[3]?.getAttribute("data-profile-section-progress-state")).toBe(
      "optional",
    );
    expect(tabs[4]?.getAttribute("data-profile-section-progress-state")).toBe(
      "empty",
    );
    // Only the section with required fields left carries a count.
    expect(
      container.querySelectorAll("[data-profile-section-remaining-count]"),
    ).toHaveLength(1);

    // The one actionable fact survives as a quiet trailing count, with its
    // meaning available to assistive tech.
    const remaining = tabs[1]?.querySelector(
      "[data-profile-section-remaining-count]",
    );
    expect(remaining?.textContent).toBe("2 to fill");
    expect(remaining?.getAttribute("aria-hidden")).toBe("true");
    expect(tabs[1]?.textContent).toContain("2 to fill");
    expect(tabs[1]?.getAttribute("data-profile-section-progress-state")).toBe(
      "remaining",
    );
    expect(tabs[0]?.getAttribute("data-profile-section-progress-state")).toBe(
      "complete",
    );
  });

  it("marks the selected tab with the shared active treatment", () => {
    render(
      <ProfileSectionTabs
        activeSection="experience"
        onSectionChange={vi.fn()}
        panelId="profile-section-panel"
        sections={sections}
      />,
    );

    const active = screen.getByRole("tab", { name: /experience/i });
    const inactive = screen.getByRole("tab", { name: /basics/i });

    expect(active.getAttribute("data-state")).toBe("active");
    expect(active.getAttribute("aria-selected")).toBe("true");
    expect(inactive.getAttribute("data-state")).toBe("inactive");

    // The shared primary underline, not a per-tab border or accent bar
    // invented for this one strip.
    expect(active.className).toContain("data-[state=active]:after:bg-primary");
    expect(active.className).toContain("data-[state=active]:text-foreground");
    // Horizontal tabs paint no fill: the tint applies to vertical tabs only.
    expect(active.className).not.toMatch(
      /(^|\s)(data-\[state=active\]:)?bg-accent(\s|$)/,
    );
  });

  it("never truncates a section label at 1024, 1200 or 1440", () => {
    const { container } = render(
      <ProfileSectionTabs
        activeSection="basics"
        onSectionChange={vi.fn()}
        panelId="profile-section-panel"
        sections={fiveSections}
      />,
    );

    const tabs = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );

    // Every label is rendered whole, and nothing in the strip can ellipsize
    // it: at 1440 the old equal-width cells painted "Experi…", "Backgr…",
    // "Prefer…" and "Job so…" beside a chip that kept its full width.
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Basics",
      "Experience",
      "Background",
      "Preferences",
      "Job sites",
    ]);
    for (const tab of tabs) {
      expect(tab.className).toContain("whitespace-nowrap");
      expect(tab.className).not.toContain("truncate");
      expect(tab.querySelector(".truncate")).toBeNull();
    }
  });

  it("keeps five sections on one row from sm up", () => {
    const { container } = render(
      <ProfileSectionTabs
        activeSection="basics"
        onSectionChange={vi.fn()}
        panelId="profile-section-panel"
        sections={fiveSections}
      />,
    );

    const tablist = container.querySelector('[role="tablist"]');
    // A single flex row that scrolls sideways when it must, never a stacked
    // grid: three stacked rows below 1280px pushed the selected section's
    // content off the first viewport at every supported compact height.
    expect(tablist?.className).toContain("inline-flex");
    expect(tablist?.className).toContain("overflow-x-auto");
    expect(tablist?.className).not.toContain("grid-cols-2");
    expect(tablist?.className).not.toContain("sm:grid-cols-5");
    expect(tablist?.className).not.toContain("flex-wrap");

    for (const tab of Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    )) {
      expect(tab.className).not.toContain("col-span-2");
    }
  });

  it("keeps the tab semantics, deep-link ids and panel wiring", () => {
    render(
      <ProfileSectionTabs
        activeSection="basics"
        onSectionChange={vi.fn()}
        panelId="profile-section-panel"
        sections={fiveSections}
      />,
    );

    expect(
      screen.getByRole("tablist", { name: "Profile sections" }),
    ).toBeTruthy();

    for (const section of fiveSections) {
      const tab = document.getElementById(`${section.id}-tab`);
      expect(tab?.getAttribute("role")).toBe("tab");
      // The Profile screen owns the panel; Radix's generated content id must
      // not replace it.
      expect(tab?.getAttribute("aria-controls")).toBe("profile-section-panel");
    }

    // The shared primitive is a roving tab stop: the strip owns the Tab
    // sequence and hands focus to the selected tab on entry. A section deep
    // link still focuses its exact trigger by id.
    const tablist = screen.getByRole("tablist", { name: "Profile sections" });
    expect(tablist.getAttribute("tabindex")).toBe("0");

    const backgroundTab = document.getElementById("background-tab");
    backgroundTab?.focus();
    expect(document.activeElement).toBe(backgroundTab);
  });

  it("moves between sections with the arrow keys", () => {
    vi.useFakeTimers();

    try {
      const onSectionChange = vi.fn();

      render(
        <ProfileSectionTabs
          activeSection="basics"
          onSectionChange={onSectionChange}
          panelId="profile-section-panel"
          sections={fiveSections}
        />,
      );

      const basicsTab = screen.getByRole("tab", { name: /basics/i });
      act(() => {
        basicsTab.focus();
      });

      fireEvent.keyDown(basicsTab, { key: "ArrowRight" });
      act(() => {
        vi.runAllTimers();
      });
      expect(onSectionChange).toHaveBeenCalledWith("experience");

      onSectionChange.mockClear();
      const focused = document.activeElement as HTMLElement;
      fireEvent.keyDown(focused, { key: "End" });
      act(() => {
        vi.runAllTimers();
      });
      expect(onSectionChange).toHaveBeenCalledWith("sources");

      // Home returns to the first section. `activeSection` is still "basics"
      // here (the spy does not feed the prop back), so the assertion is where
      // focus landed rather than a redundant activation call.
      fireEvent.keyDown(document.activeElement as HTMLElement, {
        key: "Home",
      });
      act(() => {
        vi.runAllTimers();
      });
      expect(document.activeElement?.id).toBe("basics-tab");
    } finally {
      vi.useRealTimers();
    }
  });
});
