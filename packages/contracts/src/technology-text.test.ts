import { expect, test } from "vitest";
import { preserveTechnologyTokens } from "./technology-text";
import { normalizeFormQuestionPrompt } from "./applications";
test.each([
  ["C#", "C++"],
  ["F#", "F++"],
  [".NET", "NET"],
  ["Node.js", "Node js"],
  ["C++", "C"],
])("technology identity distinguishes %s and %s", (one, two) => {
  const identity = (value: string) =>
    normalizeFormQuestionPrompt(preserveTechnologyTokens(value));
  expect(identity(`Years of ${one}?`)).not.toBe(identity(`Years of ${two}?`));
  expect(identity(`Years of ${one}?`)).toBe(
    identity(`years of ${one.toLowerCase()} *`),
  );
});
