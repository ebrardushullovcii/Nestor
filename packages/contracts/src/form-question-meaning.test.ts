import { expect, test } from "vitest";
import replay from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/saved-question-meanings.json";
import {
  formQuestionText,
  savedQuestionMatches,
} from "./form-question-meaning";

test.each([
  [
    "Are you over the age of 21? Please choose Yes or No — required.",
    "Are you over the age of 21?",
    "Yes",
    true,
  ],
  [
    "Are you over the age of 21?",
    "Please confirm: Are you over the age of 21? (Yes/No) — required.",
    "No",
    true,
  ],
  [
    "Please provide your answer for: Describe your relevant project. — required.",
    "Describe your relevant project.",
    "The person's recorded project description.",
    true,
  ],
  [
    "Are you over the age of 21? Please choose Yes or No — required.",
    "Are you over the age of 18?",
    "Yes",
    false,
  ],
  [
    "Are you over the age of 21? Please choose Yes or No and accept marketing.",
    "Are you over the age of 21?",
    "Yes",
    false,
  ],
  [
    "Please provide your answer for: Describe C# work. — required.",
    "Describe C++ work.",
    "The person's recorded answer.",
    false,
  ],
] as const)(
  "question presentation keeps answer meaning: %s -> %s",
  (saved, asked, answer, matches) => {
    expect(savedQuestionMatches(saved, asked, answer)).toBe(matches);
  },
);
test("a Yes/No instruction does not change a text question's format", () => {
  expect(
    formQuestionText("Please answer: Describe your project. (Yes/No)"),
  ).toBe("Describe your project. (Yes/No)");
});
test.each(replay.cases)("saved-question replay: $saved -> $asked", (entry) => {
  expect(savedQuestionMatches(entry.saved, entry.asked, entry.answer)).toBe(
    entry.matches,
  );
});

test.each([
  [
    "Expected salary",
    "Monthly net compensation expectations (EUR)",
    "At least 4700 EUR net per month",
    true,
  ],
  [
    "Minimum acceptable salary",
    "Monthly net pay expectations (EUR)",
    "At least 4700 EUR net per month",
    true,
  ],
  [
    "Expected salary",
    "Monthly gross pay expectations (EUR)",
    "4700 EUR net per month",
    false,
  ],
  [
    "Expected salary",
    "Annual net pay expectations (EUR)",
    "4700 EUR net per month",
    false,
  ],
  [
    "Expected salary",
    "Monthly net pay expectations (CHF)",
    "4700 EUR net per month",
    false,
  ],
  [
    "Expected salary",
    "Monthly net pay expectations (CAD)",
    "CAD $4700 net per month",
    true,
  ],
  [
    "Notice period",
    "How much notice do you need to give?",
    "Immediately",
    true,
  ],
  ["Notice period", "Notice period in months", "30 days", false],
  ["Notice period in days", "Required notice period", "30", false],
  ["Expected annual salary (EUR)", "Desired compensation", "65000", false],
  [
    "Favourite monitoring product",
    "Monitoring product you hate",
    "My own words",
    false,
  ],
  ["Experience with C#", "Experience with C++", "8 years", false],
  [
    "Notice period",
    "Your professional reference's notice period",
    "30 days",
    false,
  ],
  ["Notice period", "Notice period and citizenship", "30 days", false],
] as const)(
  "remembered answer keeps its meaning and units: %s / %s",
  (saved, asked, answer, matches) => {
    expect(savedQuestionMatches(saved, asked, answer)).toBe(matches);
  },
);

test("notice units in the control's placeholder still constrain an exact question", () => {
  expect(
    savedQuestionMatches("Notice period", "Notice period", "30 days", "Months"),
  ).toBe(false);
});
