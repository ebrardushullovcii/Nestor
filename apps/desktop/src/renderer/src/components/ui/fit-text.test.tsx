// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { FitText, reasonLines, shorterWords } from "./fit-text";

// jsdom lays nothing out: each character is 7 px, the box is `room` wide.
let room = 0;
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return room;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return (this.getAttribute("data-text") ?? "").length * 7;
    },
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
});

const LINES = [
  "Last search today: 14 new jobs, 1 duplicate merged.",
  "Last search today: 14 new jobs.",
  "Searched today.",
];

it("shows the longest line that fits whole", () => {
  room = 400;
  render(<FitText candidates={LINES} />);
  expect(screen.getByText(LINES[0]!)).toBeTruthy();
});

it("falls back to shorter words, never a line cut mid-word", () => {
  room = 250;
  render(<FitText candidates={LINES} />);
  const line = screen.getByText(LINES[1]!);
  // The full words stay its tooltip.
  expect(line.getAttribute("title")).toBe(LINES[0]);
});

it("drops the line when nothing fits, keeping the words for a screen reader", () => {
  room = 50;
  render(<FitText candidates={LINES} />);
  const kept = screen.getByText(LINES[0]!);
  expect(kept.className).toContain("sr-only");
});

it("shortens a reason to its first clause, then a whole shorter phrase", () => {
  expect(
    shorterWords("Good overlap on product UI; asks for design systems."),
  ).toEqual([
    "Good overlap on product UI; asks for design systems.",
    "Good overlap on product UI",
    "Good overlap",
  ]);
  expect(shorterWords("Fewer frontend duties than you want")).toEqual([
    "Fewer frontend duties than you want",
    "Fewer frontend duties",
    "Fewer frontend…",
  ]);
});

it("cuts a word at a time, never ending on a word that says nothing", () => {
  expect(shorterWords("Strong React and TypeScript match")).toEqual([
    "Strong React and TypeScript match",
    "Strong React and TypeScript…",
    "Strong React…",
  ]);
});

describe("a room measured elsewhere", () => {
  // The bar's free region: its width is set by the bar, never by the label.
  let regionWidth = 0;
  const callbacks: (() => void)[] = [];
  beforeEach(() => {
    callbacks.length = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          callbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute("data-room") ? regionWidth : room;
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const SELECT = ["Select all 14 matching", "Select all 14"];
  const roomOf = (box: HTMLElement) =>
    box.closest<HTMLElement>("[data-room]")?.clientWidth ?? 0;
  const watch = (box: HTMLElement) => [box.closest("[data-room]")];
  const renderInRegion = () =>
    render(
      <div data-room="">
        <button type="button">
          <FitText
            boxClassName="min-w-0"
            candidates={SELECT}
            room={roomOf}
            watch={watch}
          />
        </button>
      </div>,
    );

  it("keeps one form across resize callbacks (the label never measures itself)", () => {
    regionWidth = 120;
    // The label's own box is as wide as the line it shows.
    room = 91;
    renderInRegion();
    const shown = () => document.querySelector("button")!.textContent;
    expect(shown()).toBe("Select all 14");
    for (let i = 0; i < 5; i += 1) act(() => callbacks.forEach((c) => c()));
    expect(shown()).toBe("Select all 14");
    regionWidth = 200;
    act(() => callbacks.forEach((c) => c()));
    expect(shown()).toBe("Select all 14 matching");
  });

  it("keeps its choice while the room measures nothing (a hidden screen)", () => {
    regionWidth = 120;
    renderInRegion();
    regionWidth = 0;
    act(() => callbacks.forEach((c) => c()));
    expect(document.querySelector("button")!.textContent).toBe("Select all 14");
  });

  it("marks the box when no form fits, so its button can step aside", () => {
    regionWidth = 40;
    renderInRegion();
    expect(document.querySelector("[data-fit-none]")).not.toBeNull();
  });
});

it("gives a fit reason its short form, then cuts with an ellipsis, never dropping a clause as if whole", () => {
  const reason =
    "Fewer frontend duties than you want; mostly backend services.";
  expect(reasonLines(reason, "Less frontend than you want")).toEqual([
    reason,
    "Less frontend than you want",
    "Less frontend…",
  ]);
  // An older row with no short form: the whole reason, cut and marked.
  const older = reasonLines(reason, null);
  expect(older[0]).toBe(reason);
  expect(older.slice(1).every((line) => line.endsWith("…"))).toBe(true);
  expect(older).not.toContain("Fewer frontend duties");
  expect(older).toContain("Fewer frontend duties than you want…");
});
