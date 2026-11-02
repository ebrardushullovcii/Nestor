// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Fit } from "./fit";
import { describeFit } from "./job-format";

afterEach(cleanup);

describe("describeFit", () => {
  it("gives every band one label form and its step on the meter", () => {
    expect(describeFit(92)).toEqual({ label: "Strong fit", level: 4 });
    expect(describeFit(70)).toEqual({ label: "Good fit", level: 3 });
    expect(describeFit(50)).toEqual({ label: "Stretch fit", level: 2 });
    expect(describeFit(12)).toEqual({ label: "Weak fit", level: 1 });
    expect(describeFit(null)).toEqual({ label: "Not scored yet", level: 0 });
    expect(describeFit(null, "applied").label).toBe("Not scored");
  });
});

describe("Fit", () => {
  const filled = (container: HTMLElement) =>
    [...container.querySelectorAll("[data-fit-meter] > span")].map((mark) =>
      mark.className.includes("bg-(--fit-meter)"),
    );

  it.each([
    [92, "Strong fit", [true, true, true, true]],
    [70, "Good fit", [true, true, true, false]],
    [50, "Stretch fit", [true, true, false, false]],
    [12, "Weak fit", [true, false, false, false]],
  ])("draws %i as its score, %s and the meter", (score, label, marks) => {
    const { container } = render(<Fit score={score} />);
    // Heard as "92, Strong fit": the comma is screen-reader text.
    expect(container.textContent).toBe(`${score}, ${label}`);
    expect(filled(container)).toEqual(marks);
    // Empty marks are rings: told apart by shape, not hue.
    for (const mark of container.querySelectorAll("[data-fit-meter] > span"))
      if (!mark.className.includes("bg-(--fit-meter)"))
        expect(mark.className).toContain("ring-(--fit-meter-empty)");
  });

  it("borrows no status colour at any step", () => {
    for (const score of [92, 70, 50, 12]) {
      const { container } = render(<Fit score={score} size="detail" />);
      expect(container.innerHTML).not.toMatch(
        /--(info|success|warning|danger)-|bg-secondary/,
      );
      cleanup();
    }
  });

  it("says plainly when a job has no score yet, with no meter", () => {
    const { container } = render(<Fit score={null} />);
    expect(container.textContent).toBe("Not scored yet");
    expect(container.querySelector("[data-fit-meter]")).toBeNull();
  });

  it("keeps the label for assistive tech when a narrow row hides it", () => {
    const { getByText } = render(
      <Fit labelClassName="sr-only @md/row:not-sr-only" score={70} />,
    );
    expect(getByText("Good fit").className).toContain("sr-only");
  });
});
