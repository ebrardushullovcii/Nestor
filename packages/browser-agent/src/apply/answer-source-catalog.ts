import {
  asksListingDiscovery,
  listingDiscoveryAnswer,
} from "./listing-discovery-answer";
import type { ApplyAnswerTags } from "@nestor/contracts";
import { normalizeFormQuestionPrompt } from "@nestor/contracts";
import { storedFacts, savedAnswerForQuestion } from "./application-facts";
import { countriesIn } from "./concrete-answer-claims";
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
    | "listing";
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
        country: country(saved.applicationScope?.location ?? saved.question),
      });
  for (const row of rows)
    if (row.purpose === "saved") {
      const saved = sources.reusableAnswers.find(
        (answer) => `answerLibrary.${answer.id}` === row.id,
      );
      row.country = country(
        saved?.applicationScope?.location ?? row.question ?? "",
      );
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
  let source = catalog.find((row) => row.id === tags.sourceId);
  // A known legal question can be answered directly from an explicit,
  // unconditional profile fact. Neither a model suggestion nor residence
  // supplies this fact. This also survives old prompt-only saved keys.
  const legal = tags.kind === "work_auth" || tags.kind === "sponsorship";
  const namedCountries = countriesIn(
    input.control.groupLabel + " " + input.control.label,
  );
  const target =
    namedCountries.size === 0
      ? country(input.sources.posting.location ?? "")
      : namedCountries.size === 1
        ? [...namedCountries][0]
        : null;
  const question = normalizeFormQuestionPrompt(
    (input.control.kind === "radio"
      ? input.control.groupLabel
      : input.control.label
    )
      .split(/\s+—\s+/u)
      .at(-1)!,
  );
  const authorizationPrefixes = [
    "are you legally authorized to work in ",
    "are you legally authorised to work in ",
    "are you authorized to work in ",
    "are you authorised to work in ",
    "do you have the right to work in ",
    "do you have the legal right to work in ",
  ];
  const knownLegalQuestion =
    tags.kind === "work_auth"
      ? authorizationPrefixes.some(
          (prefix) =>
            question.startsWith(prefix) &&
            (question.slice(prefix.length) === "this country" ||
              country(question.slice(prefix.length)) === target),
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
        ].includes(question);
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
    requiresOwnWords(
      `${input.pageInstructions}\n${input.control.groupLabel}\n${input.control.label}`,
    ) ||
    requiresSavedNationalityAnswer(input.control.label) ||
    requiresSavedOpinionAnswer(input.control.label, input.answer);
  if (gated)
    return exactSaved
      ? { kind: "literal", source }
      : deny("This question needs your own unchanged answer.");
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
    tags.kind === "other" &&
    source.purpose === "profile" &&
    source.value.trim() === input.answer.trim() &&
    knownLiteralField(source, input.control)
  )
    return { kind: "literal", source };
  // Only writing requested by this role can use a writing context; its concrete claims still require the fact check.
  if (
    tags.kind === "other" &&
    source.purpose === "writing" &&
    /\b(?:why|motivation|cover letter|tell us about yourself)\b/iu.test(
      input.control.label,
    )
  )
    return { kind: "writing", source };
  return deny(
    "This value is not a verbatim answer from a known-safe matching source.",
  );
}
