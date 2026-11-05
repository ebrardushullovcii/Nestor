import { describe, expect, it } from "vitest";

import { applyFailureCause, applyFailureLine } from "./apply-failure";

describe("Apply's failure line", () => {
  it("says the page did not open in the buttons' words, once, without engine words or a second recovery", () => {
    const line = applyFailureLine(
      "The dedicated browser could not load this employer page, so preparation stopped before the page opened. Nothing was filled, attached, or submitted. Retry preparation, or open the page yourself to confirm the link works.",
    );
    expect(line).toBe("Apply couldn’t open this job’s page.");
    expect(line).not.toMatch(/dedicated|preparation|Retry|filled/u);
  });

  it("keeps a Nestor reading failure distinct from a personal question or a send verdict", () => {
    const line = applyFailureLine(
      "Nestor could not read this form after three tries. The page and your answers are kept. Try again.",
    );
    expect(line).toBe("Nestor could not read this form after three tries.");
    expect(line).not.toMatch(/Nothing was sent|answer this question/u);
  });

  it("keeps a plain first sentence and drops engine text", () => {
    expect(applyFailureCause("The listing was taken down. Try later.")).toBe(
      "The listing was taken down.",
    );
    expect(
      applyFailureCause("Playwright selector #apply timed out after 30000ms"),
    ).toBe("The job’s page took too long, so Apply stopped.");
    expect(applyFailureCause("Runtime crashed in preparation")).toBe(
      "Apply couldn’t finish this application.",
    );
    expect(applyFailureCause(null)).toBe(
      "Apply couldn’t finish this application.",
    );
  });
});
