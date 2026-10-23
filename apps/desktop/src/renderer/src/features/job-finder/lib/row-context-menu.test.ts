// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listingRowMenuEntries,
  openRowContextMenu,
  tidyRowMenu,
  type RowMenuEntry,
} from "./row-context-menu";

type BridgeHolder = { nestor?: unknown };

afterEach(() => {
  Reflect.deleteProperty(window, "nestor");
});

describe("row context menu", () => {
  it("adds Open listing and Copy link only when the row has an address", () => {
    expect(listingRowMenuEntries(null)).toEqual([]);
    expect(listingRowMenuEntries("  ")).toEqual([]);
    const entries = listingRowMenuEntries("https://jobs.example.test/1");
    expect(
      entries.map((entry) => (entry === "separator" ? "-" : entry.label)),
    ).toEqual(["-", "Open listing", "Copy link"]);
  });

  it("drops separators at the ends and doubled ones", () => {
    const run = () => undefined;
    const menu: RowMenuEntry[] = [
      "separator",
      { id: "a", label: "A", run },
      "separator",
      "separator",
      { id: "b", label: "B", run },
      "separator",
    ];
    expect(tidyRowMenu(menu)).toEqual([
      { id: "a", label: "A", run },
      "separator",
      { id: "b", label: "B", run },
    ]);
  });

  it("shows the system menu and runs the chosen action", async () => {
    const showContextMenu = vi.fn(() => Promise.resolve({ id: "hide" }));
    (window as unknown as BridgeHolder).nestor = {
      window: { showContextMenu },
    };
    const shortlist = vi.fn();
    const hide = vi.fn();
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };

    openRowContextMenu(event, [
      { id: "shortlist", label: "Shortlist", enabled: false, run: shortlist },
      { id: "hide", label: "Hide", run: hide },
    ]);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(showContextMenu).toHaveBeenCalledWith({
      items: [
        { id: "shortlist", label: "Shortlist", enabled: false },
        { id: "hide", label: "Hide" },
      ],
    });
    await vi.waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
    expect(shortlist).not.toHaveBeenCalled();
  });

  it("leaves the browser's own menu without the desktop bridge", () => {
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    openRowContextMenu(event, [{ id: "a", label: "A", run: vi.fn() }]);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
