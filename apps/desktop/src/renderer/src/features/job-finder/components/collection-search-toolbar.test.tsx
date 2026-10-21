import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CollectionNoMatches,
  CollectionColumnPicker,
  CollectionSavedViews,
  CollectionSearchToolbar,
  matchesCollectionSearch,
} from "./collection-search-toolbar";

afterEach(cleanup);

describe("CollectionSavedViews dialog semantics", () => {
  const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  const cancelAnimationFrameMock = vi.fn();

  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      requestAnimationFrameMock,
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      cancelAnimationFrameMock,
    );
    // jsdom reports zero geometry; positioning math still runs.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 32,
      left: 200,
      right: 280,
      toJSON: () => ({}),
      top: 68,
      width: 80,
      x: 200,
      y: 68,
    } as DOMRect);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderSavedViews() {
    return render(
      <>
        <button type="button">Before saved views</button>
        <CollectionSavedViews
          onApply={vi.fn()}
          onDelete={vi.fn()}
          onSave={vi.fn()}
          views={[
            {
              density: "compact",
              id: "remote",
              name: "Remote",
              query: "remote",
            },
          ]}
        />
        <button type="button">After saved views</button>
      </>,
    );
  }

  function openMenu() {
    fireEvent.click(screen.getByRole("button", { name: /^Saved views/ }));
  }

  it("announces a dialog and receives focus in its naming field when opened", () => {
    renderSavedViews();

    const trigger = screen.getByRole("button", { name: /^Saved views/ });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    openMenu();

    const dialog = screen.getByRole("dialog", { name: "Saved views" });
    expect(dialog.getAttribute("data-saved-views-menu")).toBe("true");
    const nameField = screen.getByLabelText("Saved view name");
    expect(document.activeElement).toBe(nameField);
  });

  it("closes through Escape and restores focus to the trigger", () => {
    renderSavedViews();

    const trigger = screen.getByRole("button", { name: /^Saved views/ });
    openMenu();
    expect(screen.getByRole("dialog", { name: "Saved views" }));

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Saved views" })).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps the menu open while focus moves inside it", () => {
    renderSavedViews();

    openMenu();
    const nameField = screen.getByLabelText("Saved view name");
    const applyButton = screen.getByRole("button", { name: "Remote" });

    fireEvent.blur(nameField, { relatedTarget: applyButton });
    expect(screen.getByRole("dialog", { name: "Saved views" }));
  });

  it("closes on ordinary Tab-out without dragging focus back", async () => {
    renderSavedViews();

    openMenu();
    const deleteButton = screen.getByRole("button", {
      name: "Delete saved view Remote",
    });
    const afterButton = screen.getByRole("button", {
      name: "After saved views",
    });
    deleteButton.focus();

    // Native Tab traversal lands outside; no preventDefault, no focus steal.
    fireEvent.blur(deleteButton, { relatedTarget: afterButton });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Saved views" })).toBeNull(),
    );
    // Closing on focusout must not yank focus back to the trigger.
    expect(document.activeElement).not.toBe(
      screen.getByRole("button", { name: /^Saved views/ }),
    );
  });

  it("ignores Escape that another handler already consumed", () => {
    renderSavedViews();

    openMenu();
    const blocked = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    blocked.preventDefault();
    document.dispatchEvent(blocked);

    expect(screen.getByRole("dialog", { name: "Saved views" }));
  });
});

describe("CollectionSearchToolbar", () => {
  it("reports filtered counts and keeps clear and density actions accessible", () => {
    const onQueryChange = vi.fn();
    const onDensityChange = vi.fn();
    render(
      <CollectionSearchToolbar
        density="comfortable"
        label="Find a job"
        onDensityChange={onDensityChange}
        onQueryChange={onQueryChange}
        placeholder="Search jobs"
        query="platform"
        totalCount={1000}
        visibleCount={12}
      />,
    );

    expect(screen.getByText("12 of 1000 results")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(onDensityChange).toHaveBeenCalledWith("compact");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onQueryChange).toHaveBeenCalledWith("");
  });

  it("lets the search field shrink below the desktop minimum on narrow screens", () => {
    render(
      <CollectionSearchToolbar
        label="Find a document"
        onQueryChange={vi.fn()}
        placeholder="Search documents"
        query=""
        totalCount={1}
        visibleCount={1}
      />,
    );

    const input = screen.getByRole("searchbox");
    const searchField = input.parentElement;
    const toolbar = searchField?.parentElement?.parentElement;

    expect(searchField?.className).toContain("min-w-0");
    expect(searchField?.className).toContain("sm:min-w-56");
    expect(toolbar?.className).toContain("min-w-0");
  });

  it("ellipsizes overflowing placeholder hints without weakening the accessible label", () => {
    const onQueryChange = vi.fn();
    render(
      <CollectionSearchToolbar
        label="Find a shortlisted job"
        onQueryChange={onQueryChange}
        placeholder="Search jobs, companies, contacts, stages, or tags"
        query=""
        totalCount={4}
        visibleCount={4}
      />,
    );

    const expandedInput = screen.getByRole("searchbox");
    // The hint stays truthful in the DOM; narrow fields fade its rendering
    // with an ellipsis instead of slicing glyphs mid-character.
    expect(expandedInput.getAttribute("placeholder")).toBe(
      "Search jobs, companies, contacts, stages, or tags",
    );
    // Chromium ignores text-overflow on ::placeholder itself, so the
    // ellipsis must ride on the input element via the shared field class.
    expect(expandedInput.className).toContain("text-ellipsis");
    expect(expandedInput.className).toContain("overflow-hidden");
    expect(expandedInput.className).toContain("whitespace-nowrap");
    expect(expandedInput.className).not.toContain("[&::placeholder]");
    expect(screen.getByLabelText("Find a shortlisted job")).toBe(expandedInput);
    fireEvent.change(expandedInput, {
      target: { value: "senior platform engineer" },
    });
    expect(onQueryChange).toHaveBeenCalledWith("senior platform engineer");

    cleanup();
    render(
      <CollectionSearchToolbar
        compact
        label="Find a shortlisted job"
        onQueryChange={vi.fn()}
        placeholder="Search jobs, companies, contacts, stages, or tags"
        query=""
        totalCount={4}
        visibleCount={4}
      />,
    );

    const compactInput = screen.getByRole("searchbox");
    expect(compactInput.getAttribute("placeholder")).toBe(
      "Search jobs, companies, contacts, stages, or tags",
    );
    expect(compactInput.className).toContain("text-ellipsis");
    expect(compactInput.className).toContain("overflow-hidden");
    expect(compactInput.className).toContain("whitespace-nowrap");
    expect(compactInput.className).not.toContain("[&::placeholder]");
    // The compact row is the 48px list toolbar: a 32px field with a width
    // floor that still shrinks, next to the shared ellipsis classes.
    expect(compactInput.className).toContain("h-8");
    expect(compactInput.className).toContain("min-w-24");
    expect(compactInput.className).toContain("flex-1");
    expect(screen.getByLabelText("Find a shortlisted job")).toBe(compactInput);
  });

  it("packs compact collection controls into one owned toolbar row", () => {
    render(
      <CollectionSearchToolbar
        compact
        density="comfortable"
        hideCompactCount
        label="Find a job"
        onDensityChange={vi.fn()}
        onQueryChange={vi.fn()}
        placeholder="Search jobs"
        query=""
        totalCount={510}
        viewActions={
          <CollectionSavedViews
            onApply={vi.fn()}
            onDelete={vi.fn()}
            onSave={vi.fn()}
            views={[]}
          />
        }
        visibleCount={510}
      />,
    );

    expect(screen.getByRole("searchbox").className).toContain("h-8");
    const row = document.querySelector("[data-collection-toolbar-compact]");
    expect(row?.className).toContain("min-h-12");
    expect(row?.className).toContain("px-3");
    // No visible label: the field is named for assistive technology only.
    expect(document.querySelector("label")?.className).toContain("sr-only");
    expect(
      screen.getByRole("button", { name: "Comfortable" }).textContent,
    ).toBe("Comfortable");
    expect(screen.queryByText("510 results")).toBeNull();
    expect(
      document.querySelector("[data-collection-toolbar-compact]"),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Saved views"));
    const menu = document.querySelector("[data-saved-views-menu]");
    expect(menu?.className).toContain("fixed");
    // Previously `z-100`, this popover's own bespoke layer. It renders through
    // the shared `Popover` now, which owns the one popover layer app-wide and
    // deliberately sits below the modal scrim so a window-owning dialog is
    // still the only actionable surface.
    expect(menu?.className).toContain("z-[70]");
  });

  it("keeps both seams by default so un-migrated callers keep their chrome", () => {
    render(
      <CollectionSearchToolbar
        label="Find a job"
        onQueryChange={vi.fn()}
        placeholder="Search jobs"
        query=""
        totalCount={3}
        visibleCount={3}
      />,
    );

    const searchField = screen.getByRole("searchbox").parentElement;
    const toolbar = searchField?.parentElement?.parentElement;
    expect(toolbar?.className).toContain("border-y");
    expect(toolbar?.className).toContain("px-5");

    cleanup();
    const compactView = render(
      <CollectionSearchToolbar
        compact
        label="Find a job"
        onQueryChange={vi.fn()}
        placeholder="Search jobs"
        query=""
        totalCount={3}
        visibleCount={3}
      />,
    );
    const compactToolbar = compactView.container.querySelector(
      "[data-collection-toolbar-compact]",
    );
    expect(compactToolbar?.className).toContain("border-b");
    expect(compactToolbar?.className).toContain("border-t");
  });

  it("renders the page placement with no borders or horizontal padding", () => {
    render(
      <CollectionSearchToolbar
        label="Find an action"
        onQueryChange={vi.fn()}
        placement="page"
        placeholder="Search actions"
        query=""
        totalCount={3}
        visibleCount={3}
      />,
    );

    const searchField = screen.getByRole("searchbox").parentElement;
    const toolbar = searchField?.parentElement?.parentElement;
    expect(toolbar?.className).not.toContain("border-y");
    expect(toolbar?.className).not.toContain("border-t");
    expect(toolbar?.className).not.toContain("px-5");
    expect(toolbar?.className).toContain("py-3");
  });

  it("puts filters on the compact row right after the count", () => {
    render(
      <CollectionSearchToolbar
        compact
        filters={<button type="button">Show all</button>}
        label="Search applications"
        onQueryChange={vi.fn()}
        placement="panel"
        placeholder="Search applications"
        query="acme"
        totalCount={12}
        viewActions={<button type="button">Columns</button>}
        visibleCount={3}
      />,
    );

    const row = document.querySelector("[data-collection-toolbar-compact]");
    const count = screen.getByText("3 of 12 results");
    const filter = screen.getByRole("button", { name: "Show all" });
    expect(row?.contains(filter)).toBe(true);
    expect(
      count.compareDocumentPosition(filter) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      filter.compareDocumentPosition(
        screen.getByRole("button", { name: "Columns" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
  });

  it("lets a panel header own the top seam for compact toolbars", () => {
    render(
      <CollectionSearchToolbar
        compact
        label="Find a job"
        onQueryChange={vi.fn()}
        placement="panel"
        placeholder="Search roles or companies"
        query=""
        totalCount={3}
        visibleCount={3}
      />,
    );

    const toolbar = document.querySelector("[data-collection-toolbar-compact]");
    expect(toolbar?.className).toContain("border-b");
    expect(toolbar?.className).not.toContain("border-t");
  });

  it("matches normalized text across multiple fields", () => {
    expect(
      matchesCollectionSearch(" typescript ", ["Engineer", "TypeScript"]),
    ).toBe(true);
    expect(matchesCollectionSearch("sales", ["Engineer", "TypeScript"])).toBe(
      false,
    );
  });

  it("explains a no-match state without implying filters changed", () => {
    const onClear = vi.fn();
    render(<CollectionNoMatches noun="jobs" onClear={onClear} query="sales" />);
    expect(
      screen.getByText(/other filters and selections have not changed/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("supports reusable saved views and explicit column choices", () => {
    const onApply = vi.fn();
    const onDelete = vi.fn();
    const onSave = vi.fn();
    const onColumnChange = vi.fn();
    render(
      <>
        <CollectionSavedViews
          onApply={onApply}
          onDelete={onDelete}
          onSave={onSave}
          views={[
            {
              density: "compact",
              id: "remote",
              name: "Remote",
              query: "remote",
            },
          ]}
        />
        <CollectionColumnPicker
          columns={[
            { id: "role", label: "Role", required: true, visible: true },
            { id: "salary", label: "Salary", visible: false },
          ]}
          onChange={onColumnChange}
        />
      </>,
    );

    fireEvent.click(screen.getByText("Saved views (1)"));
    fireEvent.click(screen.getByRole("button", { name: "Remote" }));
    expect(onApply).toHaveBeenCalledWith("remote");
    fireEvent.change(screen.getByLabelText("Saved view name"), {
      target: { value: "Strong fits" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // Metadata-less consumers keep the historical single-argument contract:
    // no implicit trailing undefined may leak into their callbacks.
    expect(onSave).toHaveBeenCalledWith("Strong fits");
    expect(onSave.mock.calls[0]).toHaveLength(1);

    fireEvent.click(screen.getByText("Columns"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Salary" }));
    expect(onColumnChange).toHaveBeenCalledWith("salary", true);
    expect(screen.getByRole("checkbox", { name: "Role" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Delete saved view Remote" }),
    );
    expect(onDelete).toHaveBeenCalledWith("remote");
  });

  it("forwards optional saved-view metadata to onSave only when provided", () => {
    const onSave = vi.fn();
    const metadata = {
      recommendation: ["strong_fit"],
      workMode: ["remote"],
    } as const;
    render(
      <CollectionSavedViews
        onApply={vi.fn()}
        onDelete={vi.fn()}
        onSave={onSave}
        savedViewMetadata={metadata}
        views={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Saved views$/u }));
    fireEvent.change(screen.getByLabelText("Saved view name"), {
      target: { value: "Facet focus" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith("Facet focus", metadata);
    expect(onSave.mock.calls[0]).toHaveLength(2);
  });
  it("renders the density switcher as one shared segmented control", () => {
    // COMP-02: this same control was written three ways inside one file — a
    // bordered `overflow-hidden` track with an inset ring, a trackless
    // `flex gap-1` row, and a third copy with `px-2 text-xs`.
    render(
      <CollectionSearchToolbar
        density="comfortable"
        label="Find a job"
        onDensityChange={vi.fn()}
        onQueryChange={vi.fn()}
        placeholder="Search jobs"
        query=""
        totalCount={3}
        visibleCount={3}
      />,
    );

    const tracks = document.querySelectorAll("[data-slot='segmented-control']");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.getAttribute("aria-label")).toBe("List density");
    // `aria-pressed` buttons, deliberately not `role="radio"` — automation
    // could not click the radiogroup form of this control.
    expect(
      tracks[0]?.querySelectorAll("[data-slot='segmented-control-segment']"),
    ).toHaveLength(3);
    expect(
      document.querySelector("[data-slot='segmented-control'] [role='radio']"),
    ).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Comfortable" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("gives both toolbar triggers one control class and the delete a link", () => {
    // COMP-18: Saved views was a raw bordered button on the inert
    // `--border-strong` token, Columns was a borderless `<summary>` reading as
    // a caption beside it, and delete was a hand-rolled underlined span.
    render(
      <>
        <CollectionSavedViews
          onApply={vi.fn()}
          onDelete={vi.fn()}
          onSave={vi.fn()}
          views={[
            { density: "compact", id: "remote", name: "Remote", query: "r" },
          ]}
        />
        <CollectionColumnPicker
          columns={[{ id: "role", label: "Role", visible: true }]}
          onChange={vi.fn()}
        />
      </>,
    );

    for (const name of ["Saved views (1)", "Columns"]) {
      const trigger = screen.getByRole("button", { name });
      expect(trigger.getAttribute("data-variant")).toBe("outline");
      expect(trigger.getAttribute("data-size")).toBe("toolbar");
    }

    fireEvent.click(screen.getByText("Saved views (1)"));
    expect(
      screen
        .getByRole("button", { name: "Delete saved view Remote" })
        .getAttribute("data-variant"),
    ).toBe("link");
  });

  it("portals the column picker instead of hanging it inside its host", () => {
    // REACH-06: it was `<details>` + `absolute right-0 top-full`, consumed
    // inside a section declared `overflow-hidden`, so its host clipped it —
    // and with many columns it had no internal scroll either.
    const { container } = render(
      <CollectionColumnPicker
        columns={[{ id: "role", label: "Role", visible: true }]}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Columns" }));

    expect(container.querySelector("details")).toBeNull();
    const surface = document.querySelector<HTMLElement>(
      "[data-collection-column-picker]",
    );
    expect(surface).not.toBeNull();
    expect(container.contains(surface)).toBe(false);
    expect(surface?.className).toContain("fixed");
    expect(surface?.className).toContain("overflow-y-auto");
    // A solved height, never an unbounded surface.
    expect(surface?.style.maxHeight).not.toBe("");
  });

  it("uses the shared empty state for a no-match result", () => {
    // COMP-23: this was a borderless `grid min-h-48` block on all eleven
    // toolbar routes, unlike every other empty state in the app.
    const { container } = render(
      <CollectionNoMatches noun="jobs" onClear={vi.fn()} query=" remote " />,
    );

    const heading = screen.getByRole("heading", { name: /No jobs match/u });
    expect(heading.tagName).toBe("H2");
    expect(container.firstElementChild?.className).toContain("border-dashed");
    expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();
  });
});
// @vitest-environment jsdom
