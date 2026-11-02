// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DetailSheetBack,
  LIST_DETAIL_REGION_ID,
  ListDetailLayout,
  ListPane,
  ListRowFrame,
  NO_SELECTION,
  countSelected,
  toggleSelection,
  useDetailSheet,
  useListKeys,
  type ListSelection,
} from "./index";

const ROWS = [1, 2, 3, 4].map((id) => ({ id, title: `Designer ${id}` }));

/**
 * The stacked layout without Tailwind: beside a docked assistant (jsdom is
 * 1024 wide, under the 1280 a docked split needs) an open sheet lies over the
 * list, a closed one is not drawn.
 */
const STACKED_CSS = `
html[data-assistant-sidebar="docked"] [data-detail-sheet="open"] > [data-detail-sheet-panel] { position: absolute; }
html[data-assistant-sidebar="docked"] [data-detail-sheet="closed"] > [data-detail-sheet-panel] { display: none; }
html:not([data-assistant-sidebar="docked"]) [data-detail-sheet-back] { display: none; }
`;

/** Ends the slow detail read of a `<Screen slow />`. */
let finishRead: () => void = () => undefined;

function Screen(props: {
  label?: string;
  startOpen?: boolean;
  /** The details are read slowly: a loading pane first, then the details. */
  slow?: "no-back" | "own-back";
}) {
  const label = props.label ?? "Found jobs";
  const [read, setRead] = useState(!props.slow);
  finishRead = () => setRead(true);
  const [activeId, setActiveId] = useState<number | null>(1);
  const [selection, setSelection] = useState<ListSelection>(NO_SELECTION);
  const sheet = useDetailSheet();
  const { setOpen } = sheet;
  useEffect(() => {
    if (props.startOpen) setOpen(true);
  }, [props.startOpen, setOpen]);
  const toggle = (id: number, shiftKey: boolean) =>
    setSelection((current) => toggleSelection(current, id, shiftKey, ROWS));
  useListKeys({
    rows: ROWS,
    activeId,
    setActiveId,
    toggle,
    selectAll: () => undefined,
    clearSelection: () => setSelection(NO_SELECTION),
  });
  return (
    <ListDetailLayout
      detail={
        !read ? (
          <section
            aria-busy="true"
            aria-label={`${label} details`}
            key="loading"
          >
            {props.slow === "own-back" ? (
              <DetailSheetBack onBack={sheet.close} />
            ) : null}
          </section>
        ) : (
          <section
            aria-label={`${label} details`}
            id={LIST_DETAIL_REGION_ID}
            key="read"
          >
            <DetailSheetBack onBack={sheet.close} />
            <h2>Designer {activeId}</h2>
            <button type="button">Open the listing</button>
          </section>
        )
      }
      list={
        <ListPane
          activeId={activeId}
          empty={<p>Nothing</p>}
          hasMore={false}
          label={label}
          loading={false}
          onLoadMore={() => undefined}
          onSelectionChange={setSelection}
          renderRow={(row, state) => (
            <ListRowFrame
              {...state}
              id={row.id}
              meta="Acme"
              onActivate={(id) => {
                setActiveId(id);
                sheet.openIfStacked();
              }}
              onToggle={toggle}
              title={row.title}
            />
          )}
          rows={ROWS}
          selectedCount={countSelected(selection, ROWS.length)}
          selection={selection}
          total={ROWS.length}
          totalCapped={false}
        />
      }
      sheet={{ open: sheet.open && activeId !== null, onClose: sheet.close }}
    />
  );
}

function rowButton(name: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${name}`) });
}

function layoutOf(element: HTMLElement): HTMLElement {
  const root = element.closest<HTMLElement>("[data-detail-sheet]");
  if (!root) throw new Error("no list and details layout");
  return root;
}

function listOf(element: HTMLElement): HTMLElement {
  const list = element.closest<HTMLElement>("[data-detail-sheet-list]");
  if (!list) throw new Error("no list wrapper");
  return list;
}

let style: HTMLStyleElement;

beforeEach(() => {
  Object.assign(window, {
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  style = document.createElement("style");
  style.textContent = STACKED_CSS;
  document.head.append(style);
  document.documentElement.setAttribute("data-assistant-sidebar", "docked");
});

afterEach(() => {
  cleanup();
  style.remove();
  document.documentElement.removeAttribute("data-assistant-sidebar");
});

describe("details sheet", () => {
  it("covers the list while stacked and focuses its way back", () => {
    render(<Screen />);
    fireEvent.click(rowButton("Designer 2"));
    const row = rowButton("Designer 2");
    expect(layoutOf(row).dataset.detailSheet).toBe("open");
    expect(listOf(row).inert).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Back to the list" }),
    );
  });

  it("ends on Back when the details arrive after the sheet opened (no Back while loading)", async () => {
    render(<Screen slow="no-back" />);
    fireEvent.click(rowButton("Designer 2"));
    act(() => finishRead());
    await act(() => Promise.resolve());
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Back to the list" }),
    );
  });

  it("keeps focus on Back when the loading pane's Back gives way to the details' own", async () => {
    render(<Screen slow="own-back" />);
    fireEvent.click(rowButton("Designer 2"));
    const loadingBack = screen.getByRole("button", {
      name: "Back to the list",
    });
    expect(document.activeElement).toBe(loadingBack);
    act(() => finishRead());
    await act(() => Promise.resolve());
    const back = screen.getByRole("button", { name: "Back to the list" });
    expect(back).not.toBe(loadingBack);
    expect(document.activeElement).toBe(back);
  });

  it("puts itself away when the layout leaves sheet mode, so the list takes clicks again", async () => {
    render(<Screen />);
    fireEvent.click(rowButton("Designer 2"));
    const listing = screen.getByRole("button", { name: "Open the listing" });
    listing.focus();
    // The assistant undocks: the details sit beside the list again.
    await act(async () => {
      document.documentElement.removeAttribute("data-assistant-sidebar");
      await Promise.resolve();
    });
    const row = rowButton("Designer 2");
    expect(layoutOf(row).dataset.detailSheet).toBe("closed");
    expect(listOf(row).inert).toBe(false);
    // The details are still shown, so focus stays in them.
    expect(document.activeElement).toBe(listing);
    // And the list is live: another row opens.
    fireEvent.click(rowButton("Designer 3"));
    expect(screen.getByRole("heading", { name: "Designer 3" })).toBeTruthy();
  });

  it("hands focus on its Back button, which goes with the sheet, to the open row", async () => {
    render(<Screen />);
    fireEvent.click(rowButton("Designer 2"));
    expect(document.activeElement?.textContent).toBe("Back to the list");
    await act(async () => {
      document.documentElement.removeAttribute("data-assistant-sidebar");
      await Promise.resolve();
    });
    expect(layoutOf(rowButton("Designer 2")).dataset.detailSheet).toBe(
      "closed",
    );
    expect(document.activeElement).toBe(rowButton("Designer 2"));
  });

  it("closes on Escape from any control inside it and returns focus to the open row", () => {
    render(<Screen />);
    fireEvent.click(rowButton("Designer 2"));
    const listing = screen.getByRole("button", { name: "Open the listing" });
    listing.focus();
    fireEvent.keyDown(listing, { key: "Escape" });
    const row = rowButton("Designer 2");
    expect(layoutOf(row).dataset.detailSheet).toBe("closed");
    expect(listOf(row).inert).toBe(false);
    expect(document.activeElement).toBe(row);
  });

  it("answers Escape in its own sheet when another screen's sheet comes first in the page", () => {
    // A kept screen, hidden behind this one, left its own sheet open.
    render(
      <>
        <div style={{ display: "none" }}>
          <Screen label="Kept jobs" startOpen />
        </div>
        <Screen label="Shortlisted" />
      </>,
    );
    const shortlisted = screen.getByRole("region", { name: "Shortlisted" });
    const row = shortlisted.querySelector<HTMLElement>(
      '[data-list-row-id="2"] [aria-controls]',
    );
    if (!row) throw new Error("no row");
    fireEvent.click(row);
    expect(layoutOf(row).dataset.detailSheet).toBe("open");
    const details = screen.getByRole("region", { name: "Shortlisted details" });
    const listing = [...details.querySelectorAll("button")].find(
      (button) => button.textContent === "Open the listing",
    );
    if (!listing) throw new Error("no listing button");
    listing.focus();
    fireEvent.keyDown(listing, { key: "Escape" });
    expect(layoutOf(row).dataset.detailSheet).toBe("closed");
    expect(document.activeElement).toBe(row);
  });

  it("leaves Escape in a field to the field first", () => {
    render(<Screen />);
    fireEvent.click(rowButton("Designer 2"));
    const field = document.createElement("input");
    screen.getByRole("region", { name: "Found jobs details" }).append(field);
    field.focus();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(layoutOf(rowButton("Designer 2")).dataset.detailSheet).toBe("open");
    field.remove();
  });
});

describe("keyboard focus follows the open row", () => {
  beforeEach(() => {
    // Side by side: no sheet in the way.
    document.documentElement.removeAttribute("data-assistant-sidebar");
  });

  it("moves with J/K, and X ticks the row that has focus", () => {
    render(<Screen />);
    fireEvent.click(rowButton("Designer 1"));
    rowButton("Designer 1").focus();
    for (const key of ["j", "j", "k"])
      fireEvent.keyDown(document.activeElement ?? document.body, { key });
    const second = rowButton("Designer 2");
    expect(second.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(second);
    expect(second.tabIndex).toBe(0);
    fireEvent.keyDown(second, { key: "x" });
    fireEvent.keyDown(second, { key: "j" });
    const third = rowButton("Designer 3");
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third, { key: "x" });
    expect(screen.getByText("2 selected")).toBeTruthy();
    const ticked = ROWS.filter(
      (row) => rowButton(row.title).dataset.checked === "true",
    ).map((row) => row.id);
    expect(ticked).toEqual([2, 3]);
    // Escape leaves select mode; Tab would go on from the open row.
    fireEvent.keyDown(third, { key: "Escape" });
    expect(document.activeElement).toBe(third);
  });

  it("leaves focus outside the list where it is", () => {
    render(<Screen />);
    const listing = screen.getByRole("button", { name: "Open the listing" });
    listing.focus();
    fireEvent.keyDown(listing, { key: "j" });
    expect(rowButton("Designer 2").getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(listing);
  });
});
