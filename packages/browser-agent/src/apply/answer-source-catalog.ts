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
import { requiresOwnWords, ownWordsAppliesToQuestion } from "./own-words";
import { employmentMonthEvidence } from "./answer-evidence";
import { requiresSavedNationalityAnswer } from "./person-nationality";
import { requiresSavedOpinionAnswer } from "./answer-evidence";
import { asksGithubUsername } from "./github-username";
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
  const eligibilityFacts = sources.profile.workEligibility;
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
  "profile.currentCity": [
    "city",
    "current city",
    "city of residence",
    "your city",
  ],
  "profile.currentCountry": [
    "country",
    "country of residence",
    "residence country",
    "current country",
  ],
  "profile.yearsExperience": [
    "years of experience",
    "total experience",
    "total years of experience",
    "years of professional experience",
    "overall years of experience",
  ],
  "profile.workEligibility.noticePeriodDays": [
    "notice period",
    "notice period days",
    "notice period in days",
    "what is your notice period",
  ],
  "profile.workEligibility.willingToRelocate": [
    "relocation",
    "willing to relocate",
    "are you willing to relocate",
  ],
  "profile.linkedinUrl": ["professional profile", "professional profile url"],
  "profile.githubUrl": ["code profile", "code profile url"],
  "profile.portfolioUrl": ["portfolio", "portfolio url"],
  "profile.personalWebsiteUrl": ["website", "personal website", "website url"],
};
function knownLiteralField(
  source: ClassifiedAnswerSource,
  control: ApplyFormControl,
): boolean {
  if (/^profile\.(?:githubUrl|links\.[^.]+)#username$/u.test(source.id))
    return applicantContactGroup(control) && asksGithubUsername(control);
  if (
    /^profile\.skills\.\d+$/u.test(source.id) &&
    control.answerControlType === "multi_choice"
  )
    return ["skills", "select your skills"].includes(
      normalizeFormQuestionPrompt(control.groupLabel),
    );
  const historyLeaf =
    /^profile\.(experiences|education)\.[^.]+\.(companyName|title|startDate|endDate|schoolName|degree|fieldOfStudy)$/u.exec(
      source.id,
    );
  const historyLabels: Record<string, readonly string[]> = {
    companyName: ["company", "employer", "company name"],
    title: ["job title", "position title"],
    startDate: ["from", "start date", "start month"],
    endDate: ["to optional", "end date", "end month"],
    schoolName: ["institution", "school", "university", "school name"],
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
    if (source.id === "profile.githubUrl" && asksGithubUsername(control))
      return false;
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
  return (
    applicantContactGroup(control) &&
    aliases.includes(normalizeFormQuestionPrompt(control.label))
  );
}
function applicantContactGroup(control: ApplyFormControl): boolean {
  const group = normalizeFormQuestionPrompt(control.groupLabel);
  return (
    !group ||
    [
      "personal information",
      "contact information",
      "contact details",
      "my information",
      "your details",
      "personal details",
      "application questions",
      "work eligibility",
      "eligibility",
    ].includes(group)
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
      : ["schoolName", "degree", "fieldOfStudy", "startDate", "endDate"];
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
      return (
        !!expected && literalValueMatches(expected, control, control.value)
      );
    });
}

function literalValueMatches(
  source: ClassifiedAnswerSource,
  control: ApplyFormControl,
  answer: string,
): boolean {
  if (source.id === "profile.workEligibility.noticePeriodDays") {
    const units = [
      ...`${control.label} ${control.placeholder} ${control.options.join(" ")}`.matchAll(
        /\b(days?|weeks?|months?|years?|hours?)\b/giu,
      ),
    ].map((match) => match[1]?.toLowerCase().replace(/s$/u, ""));
    return (
      units.length > 0 &&
      units.every((unit) => unit === "day") &&
      (answer.trim() === source.value ||
        answer.trim() === `${source.value} days` ||
        answer.trim() === `${source.value} day`)
    );
  }
  if (source.value.trim() === answer.trim()) return true;
  const date =
    /^profile\.(experiences|education)\.[^.]+\.(startDate|endDate)$/u.exec(
      source.id,
    );
  return (
    !!date &&
    employmentMonthEvidence(control.label, answer, [
      {
        source: "applicant",
        path: `/${date[1]}/0/${date[2]}`,
        quote: source.value,
      },
    ]) === true
  );
}

// Permission to acknowledge a form is not evidence of a new personal fact.
const routineDeclarations: Partial<
  Record<ApplicationAttestationKind, readonly string[]>
> = {
  truthfulness_certification: [
    "I certify that the information is true",
    "I certify my answers are true",
    "I certify that my answers are true and complete",
    "I certify that the information provided is true and complete",
  ],
  background_check_consent: [
    "I consent to a background check",
    "I agree to a background check",
    "I authorize a background check",
  ],
  terms_acceptance: [
    "I accept the terms",
    "I agree to the terms",
    "I agree to the terms and conditions",
  ],
  privacy_notice_acknowledgement: [
    "I acknowledge the privacy notice",
    "I have read the privacy notice",
    "I agree to the privacy policy",
  ],
  marketing_contact_consent: [
    "I consent to marketing contact",
    "I agree to receive marketing communications",
  ],
};

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
    "are you legally eligible to work in ",
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
          "will you require sponsorship for employment visa status",
          "do you require sponsorship for employment visa status",
          "will you now or in the future require sponsorship for employment visa status",
          "do you now or in the future require sponsorship for employment visa status",
        ].includes(question));
  if (matchingSaved) {
    const human = catalog.find(
      (row) => row.id === `answerLibrary.${matchingSaved.id}`,
    );
    if (human && (!legal || human.country === target)) source = human;
  }
  // Formatting an explicitly selected profile URL may use only that same
  // account's derived username. A null or unrelated source grants nothing.
  if (
    source?.purpose === "profile" &&
    /^profile\.(?:githubUrl|links\.[^.]+)$/u.test(source.id) &&
    tags.kind === "other" &&
    asksGithubUsername(input.control)
  ) {
    const sourceId = source.id;
    const username = catalog.find((row) => row.id === `${sourceId}#username`);
    if (username?.value === input.answer) source = username;
  }
  if (
    source &&
    tags.kind === "other" &&
    /^profile\.skills\.\d+$/u.test(source.id) &&
    input.control.answerControlType === "multi_choice" &&
    knownLiteralField(source, input.control)
  )
    source =
      catalog.find(
        (row) =>
          /^profile\.skills\.\d+$/u.test(row.id) && row.value === input.answer,
      ) ?? source;
  if (
    !source &&
    tags.kind === "other" &&
    input.control.attestationKind &&
    input.approvedAttestations?.includes(input.control.attestationKind) &&
    tags.declarationPurpose !== "personal_fact" &&
    (tags.declarationPurpose === "consent" ||
      tags.declarationPurpose === "acknowledgement" ||
      (inferAttestationKind(input.control) === input.control.attestationKind &&
        routineDeclarations[input.control.attestationKind]?.some(
          (statement) =>
            normalizeFormQuestionPrompt(statement) ===
            normalizeFormQuestionPrompt(input.control.label),
        ))) &&
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
    requiresOwnWords(input.control.label) ||
    (tags.kind === "motivation" &&
      ownWordsAppliesToQuestion(
        `${input.control.groupLabel}\n${input.pageInstructions}`,
        input.control.label,
      )) ||
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
      !permitConditionsFit(input.sources, target) ||
      (tags.kind === "sponsorship" &&
        input.answer === "No" &&
        input.sources.profile.workEligibility.limitedWorkPermissions?.some(
          (permission) =>
            country(permission.country) === target &&
            permission.requiresFutureSponsorship === true,
        ))
    )
      return deny(
        "The current permit conditions have not been shown to fit this job. Please confirm this answer.",
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
    tags.kind === "other" &&
    source.purpose === "profile" &&
    !historyRecordMatches(source, input, catalog)
  ) {
    const leaf = /^(profile\.(?:experiences|education))\.[^.]+\.([^.]+)$/u.exec(
      source.id,
    );
    const alternatives = leaf
      ? catalog.filter(
          (row) =>
            row.id.startsWith(`${leaf[1]}.`) &&
            row.id.endsWith(`.${leaf[2]}`) &&
            knownLiteralField(row, input.control) &&
            literalValueMatches(row, input.control, input.answer) &&
            historyRecordMatches(row, input, catalog),
        )
      : [];
    if (alternatives.length === 1 && alternatives[0]) source = alternatives[0];
  }
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
    literalValueMatches(source, input.control, input.answer) &&
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
