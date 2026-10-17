// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NestorMark } from "./nestor-mark";
import { NestorWordmark } from "./nestor-wordmark";

afterEach(cleanup);

describe.each([
  ["wordmark", NestorWordmark, "0 0 2194 416", ["currentColor"]],
  [
    "mark",
    NestorMark,
    "0 0 1024 1024",
    ["currentColor", "var(--brand-stone-blue)", "var(--brand-stone-sage)"],
  ],
] as const)("Nestor %s", (_name, Component, viewBox, fills) => {
  it("has an accessible name and uses the theme palette", () => {
    const { getByRole } = render(<Component className="h-5 w-auto" />);
    const image = getByRole("img", { name: "Nestor" });

    expect(image.querySelector("title")?.textContent).toBe("Nestor");
    expect(image.getAttribute("viewBox")).toBe(viewBox);
    expect(image.getAttribute("focusable")).toBe("false");
    expect(image.getAttribute("class")).toBe("h-5 w-auto");
    expect(image.hasAttribute("width")).toBe(false);
    expect(image.hasAttribute("height")).toBe(false);
    expect(
      new Set(
        Array.from(image.querySelectorAll("path"), (path) =>
          path.getAttribute("fill"),
        ),
      ),
    ).toEqual(new Set(fills));
  });

  it("uses a supplied title for both accessible labels", () => {
    const { getByRole } = render(<Component title="Nestor home" />);
    expect(
      getByRole("img", { name: "Nestor home" }).querySelector("title")
        ?.textContent,
    ).toBe("Nestor home");
  });
});

it("keeps the wordmark aligned to the start of its container", () => {
  const { getByRole } = render(<NestorWordmark />);
  expect(
    getByRole("img", { name: "Nestor" }).getAttribute("preserveAspectRatio"),
  ).toBe("xMinYMid meet");
});

it("draws the wordmark as six separate letters", () => {
  const { getByRole } = render(<NestorWordmark />);
  expect(
    getByRole("img", { name: "Nestor" }).querySelectorAll("path"),
  ).toHaveLength(6);
});
