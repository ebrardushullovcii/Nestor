import type { ApplicationAttestationKind } from "@nestor/contracts";

import { normalizeFormQuestionPrompt } from "@nestor/contracts";

import { storedFacts } from "./application-facts";

import { fullProfileUrl, isProfileUrlSource } from "./profile-url";

import { countriesIn, countryTerms } from "./concrete-answer-claims";

import type { ApplyAnswerSources } from "./types";

export interface ClassifiedAnswerSource {
  id: string;
  value: string;
  purpose:
    | "profile"
    | "saved"
    | "work_auth"
    | "sponsorship"
    | "writing"
    | "listing"
    | "context"
    | "authority";
  country: string | null;
  question?: string;
}

const country = (text: string) => {
  const codes = countriesIn(text);
  return codes.size === 1 ? (codes.values().next().value ?? null) : null;
};

export function legalQuestionCountry(
  question: string,
  sources: readonly Pick<ClassifiedAnswerSource, "id" | "value">[],
): string | null {
  const named = countriesIn(question);
  if (named.size) return named.size === 1 ? ([...named][0] ?? null) : null;
  const residence =
    /\bcountry (?:of (?:your )?residence|(?:where|in which) you (?:currently )?(?:live|reside))\b/iu.test(
      question,
    );
  const residenceCountry = sources.find(
    (row) => row.id === "profile.currentCountry",
  )?.value;
  return country(
    residence
      ? residenceCountry ||
          sources.find((row) => row.id === "profile.currentLocation")?.value ||
          ""
      : sources.find((row) => row.id === "posting.country")?.value ||
          sources.find((row) => row.id === "posting.location")?.value ||
          "",
  );
}

export function answerSourceCatalog(
  sources: ApplyAnswerSources,
  approvedAttestations: readonly ApplicationAttestationKind[] = [],
): ClassifiedAnswerSource[] {
  const rows: ClassifiedAnswerSource[] = storedFacts(sources, {
    payDisclosed: true,
  }).map((fact) => ({
    id: fact.sourceId,
    // The question reader and writer must see the same permitted URL format.
    value: isProfileUrlSource(fact.sourceId)
      ? (fullProfileUrl(fact.value) ?? fact.value)
      : fact.value,
    purpose: fact.sourceKind === "answer_library" ? "saved" : "profile",
    country: null,
    ...(fact.sourceKind === "answer_library"
      ? {
          question:
            sources.reusableAnswers.find(
              (answer) => `answerLibrary.${answer.id}` === fact.sourceId,
            )?.question ?? "",
        }
      : {}),
  }));
  const addWritingFact = (value: unknown, id: string): void => {
    if (
      typeof value === "string" &&
      value.trim() &&
      !rows.some((row) => row.id === id)
    )
      rows.push({ id, value, purpose: "profile", country: null });
    else if (
      (typeof value === "number" && Number.isFinite(value)) ||
      typeof value === "boolean"
    ) {
      if (!rows.some((row) => row.id === id))
        rows.push({
          id,
          value:
            typeof value === "boolean" ? (value ? "Yes" : "No") : String(value),
          purpose: "profile",
          country: null,
        });
    } else if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value))
        if (key !== "id") addWritingFact(child, `${id}.${key}`);
  };
  addWritingFact(sources.profile.summary, "profile.summary");
  addWritingFact(
    sources.profile.professionalSummary,
    "profile.professionalSummary",
  );
  addWritingFact(sources.profile.narrative, "profile.narrative");
  addWritingFact(sources.preferences, "profile.preferences");
  addWritingFact(sources.profile.proofBank, "profile.proofBank");
  for (const key of [
    "willingToTravel",
    "remoteEligible",
    "willingToRelocate",
    "noticePeriodDays",
    "availableStartDate",
  ] as const)
    addWritingFact(
      sources.profile.workEligibility[key],
      `profile.workEligibility.${key}`,
    );
  rows.push({
    id: "posting.location",
    value: sources.posting.location,
    purpose: "context",
    country: country(
      sources.posting.resolvedCountry ?? sources.posting.location,
    ),
  });
  if (sources.posting.resolvedCountry)
    rows.push({
      id: "posting.country",
      value: sources.posting.resolvedCountry,
      purpose: "listing",
      country: country(sources.posting.resolvedCountry),
    });
  const eligibilityFacts = sources.profile.workEligibility;
  if (eligibilityFacts.availableStartDate)
    rows.push({
      id: "profile.workEligibility.availableStartDate",
      value: eligibilityFacts.availableStartDate,
      purpose: "profile",
      country: null,
    });
  if (eligibilityFacts.noticePeriodDays !== null)
    rows.push({
      id: "profile.workEligibility.noticePeriodDays",
      value: String(eligibilityFacts.noticePeriodDays),
      purpose: "profile",
      country: null,
    });
  if (eligibilityFacts.willingToRelocate !== null)
    rows.push({
      id: "profile.workEligibility.willingToRelocate",
      value: eligibilityFacts.willingToRelocate ? "Yes" : "No",
      purpose: "profile",
      country: null,
    });
  if (sources.listingDiscovery?.label.trim())
    rows.push({
      id: "listingDiscovery",
      value: sources.listingDiscovery.label,
      purpose: "listing",
      country: null,
    });
  // Explicit authorization, never residence, supplies the jurisdiction.
  const eligibility = sources.profile.workEligibility;
  if (
    eligibility.requiresVisaSponsorship !== null &&
    !eligibility.limitedWorkPermissions?.length
  )
    rows.push({
      id: "profile.workEligibility.requiresVisaSponsorship",
      value: eligibility.requiresVisaSponsorship ? "Yes" : "No",
      purpose: "sponsorship",
      country: null,
    });
  for (const [index, name] of eligibility.authorizedWorkCountries.entries()) {
    const code = country(name);
    if (
      !code ||
      !countryTerms(code).some(
        (term) =>
          normalizeFormQuestionPrompt(term) ===
          normalizeFormQuestionPrompt(name),
      ) ||
      (eligibility.limitedWorkPermissions?.some(
        (permission) => country(permission.country) === code,
      ) &&
        !permitConditionsFit(sources, code))
    )
      continue;
    rows.push({
      id: `profile.workEligibility.authorizedWorkCountries.${index}`,
      value: "Yes",
      purpose: "work_auth",
      country: code,
    });
    const permits =
      eligibility.limitedWorkPermissions?.filter(
        (permission) => country(permission.country) === code,
      ) ?? [];
    const futureSponsorship = permits.some(
      (permission) => permission.requiresFutureSponsorship === true,
    );
    if (
      (eligibility.requiresVisaSponsorship !== null || futureSponsorship) &&
      permits.every(
        (permission) => permission.requiresFutureSponsorship !== null,
      )
    )
      rows.push({
        id: `profile.workEligibility.requiresVisaSponsorship.${code}`,
        value:
          eligibility.requiresVisaSponsorship || futureSponsorship
            ? "Yes"
            : "No",
        purpose: "sponsorship",
        country: code,
      });
  }
  for (const [index, permit] of (
    eligibility.limitedWorkPermissions ?? []
  ).entries())
    rows.push({
      id: `profile.workEligibility.limitedWorkPermissions.${index}`,
      value: JSON.stringify(permit),
      purpose: "work_auth",
      country: country(permit.country),
    });
  for (const saved of sources.reusableAnswers.filter(
    (answer) => !answer.needsConfirmation,
  ))
    if (!rows.some((row) => row.id === `answerLibrary.${saved.id}`))
      rows.push({
        id: `answerLibrary.${saved.id}`,
        value: saved.answer,
        purpose: "saved",
        question: saved.question,
        country:
          country(saved.question) ??
          country(saved.applicationScope?.location ?? ""),
      });
  for (const row of rows)
    if (row.purpose === "saved") {
      const saved = sources.reusableAnswers.find(
        (answer) => `answerLibrary.${answer.id}` === row.id,
      );
      row.country =
        country(row.question ?? "") ??
        country(saved?.applicationScope?.location ?? "");
    }
  const resume =
    sources.resumeText ?? sources.profile.baseResume.textContent ?? "";
  if (resume.trim())
    rows.push({
      id: "resume.text",
      value: resume,
      purpose: "writing",
      country: null,
    });
  if (sources.posting.description?.trim())
    rows.push({
      id: "posting.description",
      value: sources.posting.description,
      purpose: "writing",
      country: null,
    });
  for (const kind of approvedAttestations)
    rows.push({
      id: `authority.attestation.${kind}`,
      value: `The person permits Nestor to accept ${kind} declarations.`,
      purpose: "authority",
      country: null,
    });
  return rows;
}

function permitConditionsFit(
  sources: ApplyAnswerSources,
  target: string,
): boolean {
  const permits =
    sources.profile.workEligibility.limitedWorkPermissions?.filter(
      (permission) => country(permission.country) === target,
    ) ?? [];
  return permits.every((permission) => {
    // Only a complete, unqualified weekly-hours restriction can be compared
    // locally. Dates, term-time rules and other conditions need the person.
    const limit =
      /^(?:up to |maximum |max |no more than )?(\d+(?:\.\d+)?) hours?(?: per week| weekly)$/iu.exec(
        permission.conditions.trim(),
      );
    // Count broadly before parsing. A second or unfamiliar hours statement
    // must not disappear merely because the strict parser cannot read it.
    const mentions =
      (sources.posting.description ?? "").match(
        /(?<!\p{L})(?:hours?|hrs?)\b|\bfull[\s\p{Pd}]*time\b/giu,
      ) ?? [];
    const weeklyMentions =
      (sources.posting.description ?? "").match(
        /weekly|per[\s\p{Pd}]*week|a\s+week|\/\s*(?:week|wk)\b/giu,
      ) ?? [];
    if (mentions.length !== 1 || weeklyMentions.length !== 1) return false;
    const hours = (sources.posting.description ?? "")
      .split(/\n|;|(?<=[.!?])\s+/u)
      .flatMap((sentence) => {
        const match =
          /^(?:(?:this|the) (?:role|job|position) requires |(?:working |weekly )?hours:\s*)?(\d+(?:\.\d+)?)\s+hours?\s*(?:per\s+week|\/\s*week|weekly)[.!]?$/iu.exec(
            sentence.trim(),
          );
        return match ? [match] : [];
      });
    return (
      !!limit && hours.length === 1 && Number(hours[0]?.[1]) <= Number(limit[1])
    );
  });
}
