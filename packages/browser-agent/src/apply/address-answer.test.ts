import { expect, test } from "vitest";
import { addressAnswerMatches } from "./address-answer";

test("public local spellings keep the same city and recorded country, without fuzzy addresses", () => {
  const profile = { currentCountry: "Kosovo" };
  expect(addressAnswerMatches("Prishtinë", "Pristina, Kosovo", profile)).toBe(
    true,
  );
  expect(
    addressAnswerMatches("Prishtina, Kosovo", "Pristina Kosovo", profile),
  ).toBe(true);
  expect(addressAnswerMatches("Prishtina", "Prizren, Kosovo", profile)).toBe(
    false,
  );
  expect(addressAnswerMatches("Prishtina", "Pristina, Albania", profile)).toBe(
    false,
  );
  expect(
    addressAnswerMatches("10 Example Street", "11 Example Street", profile),
  ).toBe(false);
  expect(
    addressAnswerMatches("Prishtina", "Pristina, Kosovo", profile, false),
  ).toBe(false);
});
