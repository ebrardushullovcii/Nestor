// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  fitWidthScale,
  forgetResumeZoom,
  ResumePaper,
  ResumePaperSkeleton,
  stepZoom,
} from "./resume-preview";

// jsdom has no layout; the desk reports this content box.
let deskWidth = 900;

beforeAll(() => {
  globalThis.ResizeObserver = class {
    constructor(
      private readonly callback: (
        entries: { contentRect: { width: number } }[],
      ) => void,
    ) {}
    observe() {
      this.callback([{ contentRect: { width: deskWidth } }]);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  deskWidth = 900;
  forgetResumeZoom();
});

const zoom = () =>
  document
    .querySelector("[data-resume-zoom]")
    ?.getAttribute("data-resume-zoom");

describe("resume zoom", () => {
  it("steps through the zoom ladder and stops at either end", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(0.69, 1)).toBe(0.75);
    expect(stepZoom(2, 1)).toBe(2);
    expect(stepZoom(0.5, -1)).toBe(0.5);
  });

  it("fits the page to the desk's width inside its 24 px padding", () => {
    expect(fitWidthScale(816 + 48)).toBe(1);
    expect(fitWidthScale(456)).toBeCloseTo(0.5);
    expect(fitWidthScale(100)).toBe(0.5);
  });

  it("opens at fit width with the page count, and zooms by button and key", () => {
    render(
      <ResumePaper html="<p>Jamie</p>" label="Tailored resume" pageCount={2} />,
    );

    // A long resume says where the reader is.
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
    expect(zoom()).toBe("fit");
    expect(
      screen
        .getByRole("button", { name: "Fit width" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    // A 900 px content box (inside the 24 px padding) over an 816 px page.
    expect(screen.getByText("110%")).toBeTruthy();

    // One current figure: the presets are words, the number is the zoom.
    expect(screen.queryByRole("button", { name: "100%" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Actual size" }));
    expect(zoom()).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(zoom()).toBe("1.1");

    // The page is in the tab order and takes the zoom keys.
    const desk = screen.getByRole("region", {
      name: /^Tailored resume, 2 pages/,
    });
    expect(desk.tabIndex).toBe(0);
    fireEvent.keyDown(desk, { key: "-" });
    expect(zoom()).toBe("1");
    fireEvent.keyDown(desk, { key: "0" });
    expect(zoom()).toBe("fit");
    fireEvent.keyDown(desk, { key: "1" });
    expect(zoom()).toBe("1");
  });

  it("opens a narrow desk at a readable 75%, not a fit width too small to read", () => {
    // 560 px of desk: fit width would be 69%, too small to read.
    deskWidth = 560;
    render(<ResumePaper html="<p>Jamie</p>" pageCount={1} />);
    expect(zoom()).toBe("0.75");
    expect(screen.getByText("75%")).toBeTruthy();
    // Fit width is still one press away, and stays chosen once pressed.
    fireEvent.click(screen.getByRole("button", { name: "Fit width" }));
    expect(zoom()).toBe("fit");
    expect(screen.getByText("69%")).toBeTruthy();
  });

  it("opens the next page at the person's own zoom, skeleton included", () => {
    const first = render(<ResumePaper html="<p>Jamie</p>" pageCount={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Actual size" }));
    first.unmount();
    // The next resume is written: its skeleton paper is the page's size.
    const writing = render(
      <ResumePaperSkeleton label="Writing the Tailored resume…" />,
    );
    const paper = document.querySelector<HTMLElement>(
      "[data-resume-paper-skeleton]",
    );
    expect(paper?.style.width).toBe("816px");
    writing.unmount();
    render(<ResumePaper html="<p>Jamie</p>" pageCount={1} />);
    expect(zoom()).toBe("1");
  });

  it("never opens the next page cropped by a zoom chosen on a wider desk", () => {
    // 150% chosen on a wide desk (fit 135%, one step in).
    deskWidth = 1100;
    const wide = render(<ResumePaper html="<p>Jamie</p>" pageCount={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(zoom()).toBe("1.5");
    wide.unmount();
    // A narrower desk (fit 110%): whole lines, at fit width.
    deskWidth = 900;
    const narrow = render(<ResumePaper html="<p>Jamie</p>" pageCount={1} />);
    expect(zoom()).toBe("fit");
    expect(screen.getByText("110%")).toBeTruthy();
    narrow.unmount();
    // The choice is still remembered where it fits.
    deskWidth = 1300;
    render(<ResumePaper html="<p>Jamie</p>" pageCount={1} />);
    expect(zoom()).toBe("1.5");
  });

  it("says which page is in the middle of the desk as it scrolls", () => {
    render(<ResumePaper html="<p>Jamie</p>" pageCount={2} />);
    const desk = document.querySelector<HTMLElement>("[data-resume-desk]")!;
    Object.defineProperty(desk, "clientHeight", {
      configurable: true,
      value: 400,
    });
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
    // Fit width 110%: page 2 starts at 1056 × 1.1 = 1162 px.
    desk.scrollTop = 1100;
    fireEvent.scroll(desk);
    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
    desk.scrollTop = 0;
    fireEvent.scroll(desk);
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
  });

  it("draws the skeleton paper where the loaded page lands, at its scale", () => {
    deskWidth = 612;
    render(<ResumePaperSkeleton label="Writing the Tailored resume…" />);
    const desk = document.querySelector<HTMLElement>("[data-resume-desk]");
    const paper = document.querySelector<HTMLElement>(
      "[data-resume-paper-skeleton]",
    );
    // The loaded page's desk padding, and fit width (612 / 816 = 75%).
    expect(desk?.style.padding).toBe("24px");
    expect(paper?.style.width).toBe("612px");
  });

  it("keeps reading keys on the page, away from the list's keys", () => {
    const heard: string[] = [];
    const listen = (event: KeyboardEvent) => heard.push(event.key);
    window.addEventListener("keydown", listen);
    render(<ResumePaper html="<p>Jamie</p>" pageCount={3} />);
    const desk = screen.getByRole("region", { name: /^Resume, 3 pages/ });
    for (const key of ["ArrowDown", "ArrowUp", "PageDown", " ", "End"])
      fireEvent.keyDown(desk, { key });
    fireEvent.keyDown(desk, { key: "j" });
    window.removeEventListener("keydown", listen);
    // J still moves the list; arrows, Page and Space scroll the page.
    expect(heard).toEqual(["j"]);
  });

  it("puts the paper on the desk without the document's own canvas", () => {
    render(
      <ResumePaper
        html="<html><head></head><body class='preview-body'></body></html>"
        pageCount={1}
      />,
    );
    const frame = document.querySelector("iframe");
    expect(frame?.getAttribute("srcdoc")).toContain(
      "html,body.preview-body{background:transparent!important}",
    );
    expect(screen.getByText("1 page")).toBeTruthy();
  });
});
