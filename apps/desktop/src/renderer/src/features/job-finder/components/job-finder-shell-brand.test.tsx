// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JobFinderShellBrand } from "./job-finder-shell-brand";

afterEach(cleanup);

/**
 * The brand lockup: the Nestor wordmark, a hairline and the module name on
 * one line. In the interactive shell the whole lockup is the module switch,
 * so it reads as one control with one hover state and a chevron.
 */
describe("JobFinderShellBrand lockup", () => {
  it("renders the wordmark and the module name on one line, in sentence case", () => {
    const { container, getByRole } = render(<JobFinderShellBrand />);

    const wordmark = container.querySelector("[data-desktop-brand-wordmark]");
    const subtitle = container.querySelector("[data-desktop-brand-subtitle]");

    expect(wordmark).not.toBeNull();
    expect(subtitle).not.toBeNull();
    expect(wordmark?.contains(getByRole("img", { name: "Nestor" }))).toBe(true);
    expect(
      getByRole("img", { name: "Nestor" }).getAttribute("class"),
    ).toContain("text-(--headline-primary)");
    expect(subtitle?.textContent).toBe("NestorJob Finder");
    expect(subtitle?.className).toContain("text-(length:--text-small)");
    expect(subtitle?.className).not.toContain("uppercase");
  });

  it("makes the whole lockup the module switch when one is supplied", () => {
    const { container } = render(
      <JobFinderShellBrand moduleSwitch={{ onSelectModule: () => {} }} />,
    );

    const trigger = container.querySelector("[data-module-switch-trigger]");
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("aria-label")).toBe(
      "Job Finder, switch module",
    );
    // Wordmark, module name and chevron all sit inside the one button.
    expect(
      trigger?.querySelector("[data-desktop-brand-wordmark]"),
    ).not.toBeNull();
    expect(trigger?.textContent).toContain("Job Finder");
    expect(trigger?.querySelector(".lucide-chevron-down")).not.toBeNull();
    expect(trigger?.className).toContain("hover:bg-accent");
  });

  it("ships no var()-wrapped custom-property class on any brand node", () => {
    const { container } = render(<JobFinderShellBrand />);

    const lockup = container.querySelector("[data-desktop-brand-lockup]");
    expect(lockup).not.toBeNull();

    for (const node of [lockup, ...Array.from(lockup?.children ?? [])]) {
      expect(node?.className ?? "").not.toMatch(
        /-\((?:length:|color:)?var\(--/,
      );
    }
  });
});
