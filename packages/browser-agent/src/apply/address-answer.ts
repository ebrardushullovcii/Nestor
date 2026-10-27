import {
  normalizeFormQuestionPrompt,
  type CandidateProfile,
} from "@nestor/contracts";
import { countriesIn, countryTerms } from "./concrete-answer-claims";

export const addressLabels = [
  "address",
  "location",
  "current location",
  "current address",
];

/** Locality spelling and punctuation only; no fuzzy match or invented street. */
export function addressAnswerMatches(
  recorded: string,
  answer: string,
  profile: Pick<CandidateProfile, "currentCountry">,
  allowCountry = true,
): boolean {
  const plain = (value: string) =>
    normalizeFormQuestionPrompt(value.normalize("NFKD").replace(/\p{M}/gu, ""));
  const countries = countriesIn(profile.currentCountry ?? "");
  const code = countries.size === 1 ? [...countries][0] : undefined;
  const names = code
    ? countryTerms(code)
        .map(plain)
        .sort((a, b) => b.length - a.length)
    : [];
  const canonical = (value: string) => {
    const text = plain(value);
    const name = names.find(
      (name) => text === name || text.endsWith(` ${name}`),
    );
    const locality = name
      ? text.slice(0, text.length - name.length).trim()
      : text;
    // Public names for this one locality, never a transliteration heuristic.
    const city =
      code === "XK" && /^(?:prishtina|prishtine|pristina)$/u.test(locality)
        ? "pristina"
        : locality;
    return name ? `${city} ${code}`.trim() : city;
  };
  const expected = canonical(recorded),
    actual = canonical(answer);
  if (!expected || !actual) return false;
  return (
    expected === actual ||
    (allowCountry &&
      !!profile.currentCountry &&
      canonical(`${recorded}, ${profile.currentCountry}`) === actual)
  );
}
