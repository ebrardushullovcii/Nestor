import { inferAttestationKind } from "./control-classification";
import {
  asksListingDiscovery,
  listingDiscoveryAnswer,
} from "./listing-discovery-answer";
import type {
  ApplyAnswerTags,
  ApplicationAttestationKind,
} from "@nestor/contracts";
import { normalizeFormQuestionPrompt } from "@nestor/contracts";
import { storedFacts, savedAnswerForQuestion } from "./application-facts";
import { countriesIn, countryTerms } from "./concrete-answer-claims";
import { requiresOwnWords } from "./own-words";
import { requiresSavedNationalityAnswer } from "./person-nationality";
import { requiresSavedOpinionAnswer } from "./answer-evidence";
import type { ApplyAnswerSources, ApplyFormControl } from "./types";

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
export function answerSourceCatalog(
  sources: ApplyAnswerSources,
): ClassifiedAnswerSource[] {
  const rows: ClassifiedAnswerSource[] = storedFacts(sources, {
    payDisclosed: true,
  }).map((fact) => ({
    id: fact.sourceId,
    value: fact.value,
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
  rows.push({
    id: "posting.location",
    value: sources.posting.location,
    purpose: "context",
    country: country(sources.posting.location),
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
  for (const [index, name] of eligibility.authorizedWorkCountries.entries()) {
    const code = country(name);
    if (
      !code ||
      !countryTerms(code).some(
        (term) =>
          normalizeFormQuestionPrompt(term) ===
          normalizeFormQuestionPrompt(name),
      ) ||
      eligibility.limitedWorkPermissions?.some(
        (permission) => country(permission.country) === code,
      )
    )
      continue;
    rows.push({
      id: `profile.workEligibility.authorizedWorkCountries.${index}`,
      value: "Yes",
      purpose: "work_auth",
      country: code,
    });
    if (
      eligibility.requiresVisaSponsorship !== null &&
      !eligibility.limitedWorkPermissions?.some(
        (permission) => country(permission.country) === code,
      )
    )
      rows.push({
        id: `profile.workEligibility.requiresVisaSponsorship.${code}`,
        value: eligibility.requiresVisaSponsorship ? "Yes" : "No",
        purpose: "sponsorship",
        country: code,
      });
  }
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
  return rows;
}
const contactLabels: Record<string, readonly string[]> = {
  "profile.fullName": ["name", "full name", "your full name", "your name"],
  "profile.firstName": ["first name", "given name"],
  "profile.middleName": ["middle name"],
  "profile.lastName": ["last name", "surname", "family name"],
  "profile.email": ["email", "email address", "your email"],
  "profile.phone": ["phone", "phone number", "telephone", "telephone number"],
  "profile.linkedinUrl": ["professional profile", "professional profile url"],
  "profile.githubUrl": ["code profile", "code profile url"],
  "profile.portfolioUrl": ["portfolio", "portfolio url"],
  "profile.personalWebsiteUrl": ["website", "personal website", "website url"],
};
function knownLiteralField(
  source: ClassifiedAnswerSource,
  control: ApplyFormControl,
): boolean {
  if (
    /^profile\.skills\.\d+$/u.test(source.id) &&
    control.answerControlType === "multi_choice"
  )
    return ["skills", "select your skills"].includes(
      normalizeFormQuestionPrompt(control.groupLabel),
    );
  const historyLeaf =
    /^profile\.(experiences|education)\.[^.]+\.(companyName|title|startDate|endDate|institution|degree|fieldOfStudy)$/u.exec(
      source.id,
    );
  const historyLabels: Record<string, readonly string[]> = {
    companyName: ["company", "employer", "company name"],
    title: ["job title", "position title"],
    startDate: ["from", "start date", "start month"],
    endDate: ["to optional", "end date", "end month"],
    institution: ["institution", "school", "university"],
    degree: ["degree"],
    fieldOfStudy: ["field of study"],
  };
  if (historyLeaf) {
    const group = normalizeFormQuestionPrompt(control.groupLabel);
    const groups =
      historyLeaf[1] === "experiences"
        ? [
            "",
            "employment",
            "employment history",
            "work history",
            "work experience",
          ]
        : ["", "education", "education history"];
    return (
      groups.includes(group) &&
      (historyLabels[historyLeaf[2] ?? ""]?.includes(
        normalizeFormQuestionPrompt(control.label),
      ) ??
        false)
    );
  }
  const profileLink = /^profile\.([a-zA-Z]+)Url$/u.exec(source.id);
  if (profileLink) {
    const field = normalizeFormQuestionPrompt(profileLink[1] ?? "");
    if (
      [
        field,
        `${field} url`,
        `${field} profile`,
        `${field} profile url`,
      ].includes(normalizeFormQuestionPrompt(control.label))
    )
      return true;
  }
  const aliases = contactLabels[source.id];
  if (!aliases) return false;
  const group = normalizeFormQuestionPrompt(control.groupLabel);
  const personal =
    !group ||
    [
      "personal information",
      "contact information",
      "contact details",
      "my information",
      "your details",
      "personal details",
    ].includes(group);
  return (
    personal && aliases.includes(normalizeFormQuestionPrompt(control.label))
  );
}
function historyRecordMatches(
  source: ClassifiedAnswerSource,
  input: { control: ApplyFormControl; controls: readonly ApplyFormControl[] },
  catalog: readonly ClassifiedAnswerSource[],
): boolean {
  const record = /^(profile\.(experiences|education)\.[^.]+)\.[^.]+$/u.exec(
    source.id,
  );
  if (!record) return true;
  const prefix = record[1];
  const leaves =
    record[2] === "experiences"
      ? ["companyName", "title", "startDate", "endDate"]
      : ["institution", "degree", "fieldOfStudy", "startDate", "endDate"];
  return input.controls
    .filter(
      (control) =>
        control.ref !== input.control.ref &&
        control.visible &&
        normalizeFormQuestionPrompt(control.groupLabel) ===
          normalizeFormQuestionPrompt(input.control.groupLabel) &&
        control.value.trim(),
    )
    .every((control) => {
      const leaf = leaves.find((leaf) =>
        knownLiteralField({ ...source, id: `${prefix}.${leaf}` }, control),
      );
      if (!leaf) return true;
      const expected = catalog.find((row) => row.id === `${prefix}.${leaf}`);
      return !!expected && expected.value.trim() === control.value.trim();
    });
}

export type ClassifiedAnswerDecision =
  | { kind: "literal"; source: ClassifiedAnswerSource }
  | { kind: "writing"; source: ClassifiedAnswerSource }
  | { kind: "needs_you"; reason: string };
/** An affirmative allow list. Tags or a positive checker verdict alone grant nothing. */
export function classifyAnswerPermission(input: {
  control: ApplyFormControl;
  controls: readonly ApplyFormControl[];
  tags: ApplyAnswerTags | null | undefined;
  sources: ApplyAnswerSources;
  answer: string;
  pageInstructions: string;
  approvedAttestations?: readonly ApplicationAttestationKind[];
}): ClassifiedAnswerDecision {
  const deny = (reason: string): ClassifiedAnswerDecision => ({
    kind: "needs_you",
    reason,
  });
  const tags = input.tags;
  if (!tags)
    return deny(
      "This question has not been classified safely. Please supply your answer.",
    );
  const identity = (control: ApplyFormControl) =>
    normalizeFormQuestionPrompt(
      [control.groupLabel, control.label].filter(Boolean).join(" — "),
    );
  const same = input.controls.filter(
    (control) =>
      control.visible &&
      !control.disabled &&
      identity(control) === identity(input.control),
  );
  if (
    new Set(same.map((control) => control.choiceGroupKey || control.ref))
      .size !== 1
  )
    return deny(
      "This question has more than one possible target. Please answer this entry yourself.",
    );
  const catalog = answerSourceCatalog(input.sources);
  const matchingSaved = savedAnswerForQuestion(
    input.control,
    input.sources.reusableAnswers,
    input.controls,
  );
  let source = catalog.find((row) => row.id === tags.sourceId);
  // A known legal question can be answered directly from an explicit,
  // unconditional profile fact. Neither a model suggestion nor residence
  // supplies this fact. This also survives old prompt-only saved keys.
  const legal = tags.kind === "work_auth" || tags.kind === "sponsorship";
  const namedCountries = countriesIn(
    input.control.groupLabel + " " + input.control.label,
  );
  const target =
    namedCountries.size === 1
      ? (namedCountries.values().next().value ?? null)
      : namedCountries.size === 0
        ? country(input.sources.posting.location ?? "")
        : null;
  if (legal && !target)
    return deny("The work-permission country is unknown or ambiguous.");
  const question = normalizeFormQuestionPrompt(
    input.control.kind === "radio"
      ? input.control.groupLabel
      : input.control.label,
  );
  const legalGroupIsPlain =
    input.control.kind === "radio" ||
    [
      "",
      "application questions",
      "eligibility",
      "work eligibility",
      "work authorization",
    ].includes(normalizeFormQuestionPrompt(input.control.groupLabel));
  const authorizationPrefixes = [
    "are you legally authorized to work in ",
    "are you legally authorised to work in ",
    "are you authorized to work in ",
    "are you authorised to work in ",
    "do you have the right to work in ",
    "do you have the legal right to work in ",
  ];
  const jurisdictions = target
    ? [
        "this country",
        ...countryTerms(target).flatMap((term) => {
          const name = normalizeFormQuestionPrompt(term);
          return [name, `the ${name}`];
        }),
      ]
    : [];
  const knownLegalQuestion =
    legalGroupIsPlain &&
    (tags.kind === "work_auth"
      ? authorizationPrefixes.some((prefix) =>
          jurisdictions.some((name) => question === prefix + name),
        )
      : [
          "will you require sponsorship",
          "will you require visa sponsorship",
          "do you require sponsorship",
          "do you require visa sponsorship",
          "will you now or in the future require sponsorship",
          "will you now or in the future require visa sponsorship",
          "do you now or in the future require sponsorship",
          "do you now or in the future require visa sponsorship",
        ].includes(question));
  if (legal && knownLegalQuestion && target && tags.country === target) {
    source =
      catalog.find(
        (row) =>
          row.purpose === tags.kind &&
          row.country === target &&
          row.value === input.answer.trim(),
      ) ?? source;
  }
  if (tags.kind === "other")
    source =
      catalog.find(
        (row) =>
          row.purpose === "profile" &&
          row.value.trim() === input.answer.trim() &&
          knownLiteralField(row, input.control),
      ) ?? source;
  if (matchingSaved) {
    const human = catalog.find(
      (row) => row.id === `answerLibrary.${matchingSaved.id}`,
    );
    if (human && (!legal || human.country === target)) source = human;
  }
  if (
    !source &&
    tags.kind === "other" &&
    input.control.attestationKind &&
    input.approvedAttestations?.includes(input.control.attestationKind) &&
    inferAttestationKind(input.control) === input.control.attestationKind &&
    input.answer === "Yes"
  )
    source = {
      id: `authority.attestation.${input.control.attestationKind}`,
      value: "Yes",
      purpose: "authority",
      country: null,
    };
  // A listing source has its own deterministic evidence, after all gated kinds.
  if (
    !source &&
    tags.kind === "other" &&
    asksListingDiscovery(input.control.label)
  )
    source = {
      id: "listingDiscovery",
      value: "",
      purpose: "listing",
      country: null,
    };
  if (!source)
    return deny(
      "There is no matching verbatim source for this question. Please supply your answer.",
    );
  const saved = savedAnswerForQuestion(
    input.control,
    input.sources.reusableAnswers,
    input.controls,
  );
  let savedValueMatches = source.value === input.answer;
  if (input.control.answerControlType === "multi_choice" && saved) {
    try {
      const choices: unknown = JSON.parse(saved.answer);
      savedValueMatches =
        Array.isArray(choices) &&
        choices.every((value) => typeof value === "string") &&
        choices.includes(input.answer) &&
        input.controls.some(
          (control) =>
            control.choiceGroupKey === input.control.choiceGroupKey &&
            (control.label || control.value) === input.answer,
        );
    } catch {
      /* A malformed saved selection grants nothing. */
    }
  }
  const exactSaved =
    !!saved && source.id === `answerLibrary.${saved.id}` && savedValueMatches;
  const gated =
    [
      "citizenship",
      "nationality",
      "passport",
      "preference",
      "own_words",
    ].includes(tags.kind) ||
    requiresOwnWords(`${input.control.groupLabel}\n${input.control.label}`) ||
    (requiresOwnWords(input.pageInstructions) && tags.kind === "motivation") ||
    requiresSavedNationalityAnswer(input.control.label) ||
    requiresSavedOpinionAnswer(input.control.label, input.answer);
  if (gated)
    return exactSaved
      ? { kind: "literal", source }
      : deny("This question needs your own unchanged answer.");
  if (tags.kind === "other" && asksListingDiscovery(input.control.label)) {
    const recorded = listingDiscoveryAnswer(input.control, input.sources);
    if (recorded?.value === input.answer)
      return {
        kind: "literal",
        source: {
          id: "listingDiscovery",
          value: recorded.value,
          purpose: "listing",
          country: null,
        },
      };
    return deny(
      "The answer does not match the recorded listing source and this form's options.",
    );
  }
  if (source.purpose === "authority" && tags.kind === "other")
    return { kind: "literal", source };
  if (tags.kind === "work_auth" || tags.kind === "sponsorship") {
    if (!target || tags.country !== target || source.country !== target)
      return deny(
        "The work-permission country is unknown or does not match the source. Please answer for this job's country.",
      );
    if (
      exactSaved ||
      (knownLegalQuestion &&
        source.purpose === tags.kind &&
        source.value.trim() === input.answer.trim())
    )
      return { kind: "literal", source };
    return deny(
      "No matching country-specific work-permission source answers this question.",
    );
  }
  if (exactSaved) return { kind: "literal", source };
  if (
    source.purpose === "profile" &&
    !historyRecordMatches(source, input, catalog)
  )
    return deny(
      "The employer, title and dates must come from the same profile record. Please answer this entry.",
    );
  if (
    tags.kind === "other" &&
    source.purpose === "profile" &&
    source.value.trim() === input.answer.trim() &&
    knownLiteralField(source, input.control)
  )
    return { kind: "literal", source };
  // Only an affirmative motivation classification authorizes generated writing.
  if (tags.kind === "motivation" && source.purpose === "writing")
    return { kind: "writing", source };
  return deny(
    "This value is not a verbatim answer from a known-safe matching source.",
  );
}
