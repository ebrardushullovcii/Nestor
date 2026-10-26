// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AnswerField } from "./answer-field";
import replay from "../../../../../test-fixtures/job-finder/apply-replays/handover-options.json";
afterEach(cleanup);
test("a long form list can be searched and selected without a full-page dropdown", () => {
  const options = Array.from(
      { length: replay.longListSize },
      (_, index) => `Option ${String(index + 1).padStart(3, "0")}`,
    ),
    onChange = vi.fn();
  const view = render(
    <AnswerField
      question={{ prompt: "Choose a region", input: "choice", options }}
      value=""
      onChange={onChange}
    />,
  );
  expect(screen.getByRole("radiogroup").className).toContain("max-h-64");
  expect(
    screen.getAllByRole("radio").map((option) => option.getAttribute("value")),
  ).toEqual(options);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search options" }), {
    target: { value: "250" },
  });
  expect(screen.getAllByRole("radio")).toHaveLength(1);
  fireEvent.click(screen.getByRole("radio", { name: "Option 250" }));
  expect(onChange).toHaveBeenCalledWith("Option 250");
  view.rerender(
    <AnswerField
      question={{ prompt: "Choose another region", input: "choice", options }}
      value=""
      onChange={onChange}
    />,
  );
  expect(screen.getByRole("searchbox").getAttribute("value")).toBe("");
});
test("short Yes/No lists keep their direct buttons", () => {
  render(
    <AnswerField
      question={{ prompt: "Restrictions?", input: "boolean", options: [] }}
      value=""
      onChange={vi.fn()}
    />,
  );
  expect(screen.queryByRole("searchbox")).toBeNull();
  expect(
    screen.getAllByRole("button").map((button) => button.textContent),
  ).toEqual(["Yes", "No"]);
});
