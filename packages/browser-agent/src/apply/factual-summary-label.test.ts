import { expect, test } from "vitest";
import { labelledStatementFor } from "./factual-summary";

// Council D4: a source line "Label: statement" counts by its statement only
// when the label is decoration the question already restates.
const QUESTION = "Describe your reporting routine";
const ANSWER = "I submit weekly reports";

test("recovery finds one statement in its own words, never two", () => {
  expect(
    labelledStatementFor(QUESTION, [
      "Jamie Example\nReporting routine: I submit weekly reports\n",
    ]),
  ).toBe(ANSWER);
  expect(
    labelledStatementFor(QUESTION, [
      "Reporting routine: I submit weekly reports",
      "Reporting routine: I submit weekly reports.",
    ]),
  ).toBe(ANSWER);
  expect(
    labelledStatementFor(QUESTION, [
      "Reporting routine: I submit weekly reports\nReporting routine: I submit monthly reports",
    ]),
  ).toBeNull();
  expect(
    labelledStatementFor(QUESTION, ["Acme reporting: I submit weekly reports"]),
  ).toBeNull();
});
