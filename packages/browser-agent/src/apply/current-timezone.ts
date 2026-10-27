import type { CandidateProfile } from "@nestor/contracts";
import { normalizeFormQuestionPrompt } from "@nestor/contracts";
import { countriesIn } from "./concrete-answer-claims";
import { fieldNamesAnotherPerson } from "./github-username";
import type { ApplyAnswerSources, ApplyFormControl } from "./types";

type CurrentTimezone = { country: string; zone: string; sourceId: string };
const zonesByCountry = new Map<string, readonly string[]>();

/** Country metadata, never a choice of where the person would agree to work. */
export function currentCountryTimezone(
  profile: Pick<CandidateProfile, "currentCountry" | "currentLocation">,
): CurrentTimezone | null {
  const recorded = countriesIn(profile.currentCountry ?? "");
  const location = countriesIn(profile.currentLocation ?? "");
  if (recorded.size > 1 || location.size > 1) return null;
  const country = [...recorded][0] ?? [...location][0];
  if (!country || (recorded.size && location.size && !location.has(country)))
    return null;
  let zones = zonesByCountry.get(country);
  if (!zones) {
    const locale = new Intl.Locale(`und-${country}`) as Intl.Locale & {
      timeZones?: readonly string[];
      getTimeZones?: () => readonly string[];
    };
    // XK is a user-assigned country code missing from ICU's region timezone
    // table. Kosovo uses the Belgrade CET/CEST timezone rules.
    zones =
      country === "XK"
        ? ["Europe/Belgrade"]
        : (locale.getTimeZones?.() ?? locale.timeZones ?? []);
    zonesByCountry.set(country, zones);
  }
  if (zones.length !== 1 || !zones[0]) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zones[0] });
  } catch {
    return null;
  }
  return {
    country,
    zone: zones[0],
    sourceId: recorded.size
      ? "profile.currentCountry#timezone"
      : "profile.currentLocation#timezone",
  };
}

/** Full plain questions only: an extra condition is not established by location. */
export function currentTimezoneAnswer(
  control: ApplyFormControl,
  sources: ApplyAnswerSources,
): {
  evidence: CurrentTimezone | null;
  value: string | null;
} | null {
  if (fieldNamesAnotherPerson(control)) return null;
  const question = normalizeFormQuestionPrompt(
    control.kind === "radio" || control.choiceGroupKey
      ? control.groupLabel
      : control.label,
  );
  const presence =
    /^(?:are you (?:currently )?(?:(?:based|located|living|residing) )?in|do you (?:currently )?(?:live|reside) in) (?:an? |the )?(?:eu|european)(?: (?:or )?(?:an? )?equivalent)? time ?zones?$/u.test(
      question,
    );
  const literal =
    /^(?:(?:what|which) is your current |(?:your )?current )time ?zone$/u.test(
      question,
    );
  if (!presence && !literal) return null;
  // Additional help may qualify the question. Only a complete plain question
  // establishes this derivation; a matching human answer can still be reused.
  if (control.hint?.trim()) return { evidence: null, value: null };
  const evidence = currentCountryTimezone(sources.profile);
  if (!evidence) return { evidence: null, value: null };
  if (literal) return { evidence, value: evidence.zone };
  const name =
    new Intl.DateTimeFormat("en", {
      timeZone: evidence.zone,
      timeZoneName: "longGeneric",
    })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value ?? "";
  const european =
    evidence.zone.startsWith("Europe/") || /\bEuropean\b/u.test(name);
  // A form gives no working-hour range for an otherwise undefined equivalent.
  // Only a known European timezone proves Yes; ask about other equivalents.
  return {
    evidence,
    value: european ? "Yes" : question.includes("equivalent") ? null : "No",
  };
}
