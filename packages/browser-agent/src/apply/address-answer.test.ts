import { expect, test } from "vitest";
import { addressAnswerMatches } from "./address-answer";

test("generic diacritics, punctuation and a recorded country never guess a locality alias", () => {
  const profile = { currentCountry: "Germany" };
  expect(addressAnswerMatches("München", "Munchen, Germany", profile)).toBe(
    true,
  );
  expect(
    addressAnswerMatches("München, Germany", "Munchen Germany", profile),
  ).toBe(true);
  expect(addressAnswerMatches("München", "Munich, Germany", profile)).toBe(
    false,
  );
  expect(addressAnswerMatches("München", "Munchen, Austria", profile)).toBe(
    false,
  );
  expect(
    addressAnswerMatches("10 Example Street", "11 Example Street", profile),
  ).toBe(false);
  expect(
    addressAnswerMatches("München", "Munchen, Germany", profile, false),
  ).toBe(false);
});
