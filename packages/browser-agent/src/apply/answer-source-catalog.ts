import { inferAttestationKind } from "./control-classification";
import { addressAnswerMatches, addressLabels } from "./address-answer";
import {
  asksListingDiscoveryControl,
  listingDiscoveryAnswer,
} from "./listing-discovery-answer";
import type {
  ApplyAnswerTags,
  ApplicationAttestationKind,
} from "@nestor/contracts";
import { normalizeFormQuestionPrompt } from "@nestor/contracts";
import {
  storedFacts,
  savedAnswerForQuestion,
  applicantContactGroup,
  RESIDENCE_COUNTRY_LABELS,
  PROFILE_TEXT_FIELD_LABELS,
} from "./application-facts";
import { savedPickerRule, strictOptionMatch } from "./option-fallback";
import { priorCompanyHistory } from "./prior-company";
import { currentTimezoneAnswer } from "./current-timezone";
import {
  canonicalStartDate,
  hasStartDateValue,
  isStartDateControl,
  startDateAnswer,
} from "./start-date";
import {
  phoneAnswerMatches,
  phoneCountryPicker,
  phoneLabels,
  isPhoneCodeControl,
} from "./phone-answer";
import {
  fullProfileUrl,
  isProfileUrlSource,
  wantsProfileUrl,
} from "./profile-url";
import {
  countriesIn,
  countryTerms,
  isPlainMotivationIntent,
} from "./concrete-answer-claims";
import { requiresOwnWords, ownWordsAppliesToQuestion } from "./own-words";
import { employmentMonthEvidence, isScalarAnswer } from "./answer-evidence";
import { requiresSavedNationalityAnswer } from "./person-nationality";
import { requiresSavedOpinionAnswer } from "./answer-evidence";
import { asksGithubUsername, fieldNamesAnotherPerson } from "./github-username";
import {
  asksForSpecificStory,
  factualSummaryIsSourced,
} from "./factual-summary";
import type {
  ApplyAgentConfig,
  ApplyAnswerSources,
  ApplyFormControl,
} from "./types";

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

/** An explicit residence-relative legal question names a different jurisdiction
 * from a remote/regional posting. Residence selects the country, never the answer. */
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
      : sources.find((row) => row.id === "posting.location")?.value || "",
  );
}
export function answerSourceCatalog(
  sources: ApplyAnswerSources,
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
    else if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value))
        if (key !== "id") addWritingFact(child, `${id}.${key}`);
  };
  addWritingFact(sources.profile.summary, "profile.summary");
  addWritingFact(
    sources.profile.professionalSummary,
    "profile.professionalSummary",
  );
  addWritingFact(sources.profile.narrative, "profile.narrative");
  addWritingFact(sources.profile.proofBank, "profile.proofBank");
  rows.push({
    id: "posting.location",
    value: sources.posting.location,
    purpose: "context",
    country: country(sources.posting.location),
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
  "profile.phone": phoneLabels,
  ...PROFILE_TEXT_FIELD_LABELS,
  "profile.currentCity": [
    ...addressLabels,
    "city",
    "current city",
    "city of residence",
    "location city",
    "your city",
  ],
  "profile.currentLocation": addressLabels,
  "profile.currentCountry": RESIDENCE_COUNTRY_LABELS,
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
export function knownLiteralField(
  source: Pick<ClassifiedAnswerSource, "id">,
  control: ApplyFormControl,
): boolean {
  if (fieldNamesAnotherPerson(control)) return false;
  if (source.id === "profile.phone#callingCode")
    return isPhoneCodeControl(control);
  const questionLabel = normalizeFormQuestionPrompt(
    control.kind === "radio" || control.answerControlType === "multi_choice"
      ? (control.sectionPath?.at(-1) ??
          control.groupLabel.split(" — ").at(-1) ??
          control.label)
      : control.label,
  );
  if (/^profile\.(?:githubUrl|links\.[^.]+)#username$/u.test(source.id))
    return applicantContactGroup(control) && asksGithubUsername(control);
  if (
    /^profile\.skills\.\d+$/u.test(source.id) &&
    control.answerControlType === "multi_choice"
  )
    return ["skills", "select your skills"].includes(questionLabel);
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
    return (
      historyLabels[historyLeaf[2] ?? ""]?.includes(
        questionLabel.replace(
          /\s+(?:dd mm yyyy|mm yyyy|yyyy mm dd|yyyy mm)$/u,
          "",
        ),
      ) ?? false
    );
  }
  const profileLink = /^profile\.([a-zA-Z]+)Url$/u.exec(source.id);
  if (profileLink) {
    if (source.id === "profile.githubUrl" && asksGithubUsername(control))
      return false;
    const field = normalizeFormQuestionPrompt(profileLink[1] ?? "");
    // Strip only a leading request; the remainder must still name this exact
    // profile field. Mentions in a group, prose or another person's field grant nothing.
    const label = normalizeFormQuestionPrompt(control.label).replace(
      /^(?:please\s+)?(?:share|provide|enter|paste|add|include)\s+(?:your\s+)?/u,
      "",
    );
    if (
      [
        field,
        `${field} url`,
        `${field} profile`,
        `${field} profile url`,
      ].includes(label)
    )
      return true;
  }
  const aliases = contactLabels[source.id];
  if (!aliases) return false;
  return (
    (applicantContactGroup(control) ||
      (source.id === "profile.phone" &&
        phoneLabels.some(
          (label) => label === normalizeFormQuestionPrompt(control.groupLabel),
        ))) &&
    aliases.includes(questionLabel)
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
  const group = (control: ApplyFormControl) => {
    const group = normalizeFormQuestionPrompt(control.groupLabel);
    return group === normalizeFormQuestionPrompt(control.label) ? "" : group;
  };
  const leaves =
    record[2] === "experiences"
      ? ["companyName", "title", "startDate", "endDate"]
      : ["schoolName", "degree", "fieldOfStudy", "startDate", "endDate"];
  return input.controls
    .filter(
      (control) =>
        control.ref !== input.control.ref &&
        control.visible &&
        (control.rowScopeKey && input.control.rowScopeKey
          ? control.rowScopeKey === input.control.rowScopeKey
          : group(control) === group(input.control)) &&
        (!control.scopeKey ||
          !input.control.scopeKey ||
          control.scopeKey === input.control.scopeKey) &&
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
  controls: readonly ApplyFormControl[] = [],
  sources?: ApplyAnswerSources,
): boolean {
  if (sources && /^profile\.current(?:City|Location)$/u.test(source.id))
    return addressAnswerMatches(
      source.value,
      answer,
      sources.profile,
      addressLabels.includes(normalizeFormQuestionPrompt(control.label)),
    );
  if (source.id === "profile.phone")
    return phoneAnswerMatches(source.value, answer, control, controls);
  if (
    source.id === "profile.yearsExperience" &&
    knownLiteralField(source, control)
  ) {
    const years = Number(source.value);
    if (!Number.isFinite(years) || years < 0) return false;
    if (answer.trim() === source.value.trim()) return true;
    // A total-experience picker may ask for a bracket rather than a number.
    // Only the actual offered bracket is a formatting of the recorded total;
    // it never establishes years with a particular skill or responsibility.
    if (!control.options.includes(answer)) return false;
    const range =
      /^(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)(?:\s+years?)?$/iu.exec(
        answer.trim(),
      );
    if (range) return years >= Number(range[1]) && years <= Number(range[2]);
    const minimum =
      /^(\d+(?:\.\d+)?)(?:\s*\+(?:\s+years?)?|\s+or more years?)$/iu.exec(
        answer.trim(),
      );
    return !!minimum && years >= Number(minimum[1]);
  }
  if (isProfileUrlSource(source.id) && wantsProfileUrl(control)) {
    const expected = fullProfileUrl(source.value);
    return expected !== null && answer.trim() === expected;
  }
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
  const date =
    /^profile\.(experiences|education)\.[^.]+\.(startDate|endDate)$/u.exec(
      source.id,
    );
  if (date) {
    const checked = employmentMonthEvidence(control.label, answer, [
      {
        source: "applicant",
        path: `/${date[1]}/0/${date[2]}`,
        quote: source.value,
      },
    ]);
    if (checked !== null) return checked;
  }
  return source.value.trim() === answer.trim();
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
  | {
      kind: "writing";
      source: ClassifiedAnswerSource | null;
      evidencePolicy?: "factual_summary";
    }
  | { kind: "needs_you"; reason: string; check?: string };
/** An affirmative allow list. Tags or a positive checker verdict alone grant nothing. */
export function classifyAnswerPermission(input: {
  control: ApplyFormControl;
  controls: readonly ApplyFormControl[];
  tags: ApplyAnswerTags | null | undefined;
  sources: ApplyAnswerSources;
  answer: string;
  pageInstructions: string;
  approvedAttestations?: readonly ApplicationAttestationKind[];
  application?: ApplyAgentConfig["application"];
  now?: Date;
  /** Supplied only by the host after the independent answer check. */
  matchedSourceId?: string | undefined;
  /** A proposed catalog reference; it grants no semantic-match permission. */
  candidateSourceId?: string | undefined;
}): ClassifiedAnswerDecision {
  const deny = (
    reason: string,
    check = "answer_permission",
  ): ClassifiedAnswerDecision => ({
    kind: "needs_you",
    reason,
    check,
  });
  const tags = input.tags;
  if (input.control.credentialRole)
    return deny("Credentials and verification codes stay with the person.");
  if (!tags)
    return deny(
      "This question has not been classified safely. Please supply your answer.",
      "question_classification",
    );
  const identity = (control: ApplyFormControl) =>
    normalizeFormQuestionPrompt(
      [control.groupLabel, control.label].filter(Boolean).join(" — "),
    );
  const phonePicker = phoneCountryPicker(input.control, input.controls);
  const same = input.controls.filter(
    (control) =>
      control !== phonePicker &&
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
  const pickerRule = savedPickerRule(
    { ...input.control, answerTags: tags },
    [input.control.groupLabel, input.control.label].filter(Boolean).join(" — "),
    {
      sources: input.sources,
      application: input.application ?? {
        jobId: "",
        applicationId: "",
        startingUrl: "",
      },
    },
    { forEvidence: true },
  );
  const matchingSaved =
    savedAnswerForQuestion(
      input.control,
      input.sources.reusableAnswers,
      input.controls,
    ) ?? pickerRule?.saved;
  const priorCompany =
    tags.kind === "other"
      ? priorCompanyHistory(input.control, input.sources)
      : null;
  let source = catalog.find(
    (row) =>
      row.id ===
      (input.matchedSourceId ?? input.candidateSourceId ?? tags.sourceId),
  );
  // Plain applicant identity has an exact field-to-Profile binding. A model
  // omitting its source must not turn a known name or email into a handover.
  // Extra instructions, another person, ambiguity and gated kinds still need
  // their classified source; this never grants permission to invent a value.
  if (
    !source &&
    tags.kind === "other" &&
    input.control.kind === "text" &&
    !input.controls.some((control) => control.credentialRole === "password") &&
    !input.control.repeatedQuestion &&
    !input.control.hint?.trim() &&
    !fieldNamesAnotherPerson({
      ...input.control,
      hint: input.pageInstructions,
    }) &&
    (!input.control.placeholder.trim() ||
      normalizeFormQuestionPrompt(input.control.placeholder) ===
        normalizeFormQuestionPrompt(input.control.label))
  )
    source = catalog.find(
      (row) =>
        /^profile\.(?:fullName|firstName|middleName|lastName|email)$/u.test(
          row.id,
        ) && knownLiteralField(row, input.control),
    );
  // A known legal question can be answered directly from an explicit,
  // unconditional profile fact. Neither a model suggestion nor residence
  // supplies this fact. This also survives old prompt-only saved keys.
  const legal = tags.kind === "work_auth" || tags.kind === "sponsorship";
  // The person's answer to this application's question is the fact. Country
  // and permit checks below govern reuse elsewhere, not their own decision.
  // Keep the exact question/value and lineage binding at Fill and Send alike.
  const localScope = matchingSaved?.applicationScope;
  if (
    legal &&
    matchingSaved?.id.startsWith("application_") &&
    matchingSaved.answer === input.answer &&
    input.application &&
    ((input.application.applicationRecordId &&
      localScope?.applicationRecordId ===
        input.application.applicationRecordId) ||
      (input.application.resultId &&
        localScope?.resultId === input.application.resultId))
  ) {
    const human = catalog.find(
      (row) => row.id === `answerLibrary.${matchingSaved.id}`,
    );
    if (human) return { kind: "literal", source: human };
  }
  const target = legalQuestionCountry(
    input.control.groupLabel + " " + input.control.label,
    catalog,
  );
  if (legal && !target)
    return deny("The work-permission country is unknown or ambiguous.");
  const knownLegalQuestion = legal && !fieldNamesAnotherPerson(input.control);
  if (knownLegalQuestion && !source)
    source = catalog.find(
      (row) => row.purpose === tags.kind && row.country === target,
    );
  if (matchingSaved) {
    const human = catalog.find(
      (row) => row.id === `answerLibrary.${matchingSaved.id}`,
    );
    if (human && (!legal || human.country === target)) source = human;
  }
  // A saved "Phone" answer may omit the repeated Phone group in its key.
  // Bind it to the Profile only when that is independently the same number
  // and exactly one applicant phone field can use it. Unrelated sources stay out.
  const profilePhone = catalog.find((row) => row.id === "profile.phone");
  if (
    tags.kind === "other" &&
    source?.purpose === "saved" &&
    profilePhone &&
    normalizeFormQuestionPrompt(source.question ?? "") ===
      normalizeFormQuestionPrompt(input.control.label) &&
    knownLiteralField(profilePhone, input.control) &&
    input.controls.filter(
      (control) =>
        control.visible &&
        !control.disabled &&
        control !== phonePicker &&
        knownLiteralField(profilePhone, control),
    ).length === 1 &&
    phoneAnswerMatches(
      profilePhone.value,
      source.value,
      input.control,
      input.controls,
    ) &&
    phoneAnswerMatches(
      profilePhone.value,
      input.answer,
      input.control,
      input.controls,
    )
  )
    source = profilePhone;
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
  if (priorCompany?.answer)
    source = {
      id: priorCompany.answer.sourceId,
      value: priorCompany.answer.value,
      purpose: "profile",
      country: null,
    };
  if (
    !source &&
    tags.kind === "other" &&
    asksListingDiscoveryControl(input.control)
  )
    source = {
      id: "listingDiscovery",
      value: "",
      purpose: "listing",
      country: null,
    };
  if (
    !source &&
    tags.kind === "motivation" &&
    isPlainMotivationIntent(input.answer) &&
    !asksForSpecificStory(
      `${input.control.groupLabel} ${input.control.label}`,
    ) &&
    !requiresOwnWords(input.control.label) &&
    !ownWordsAppliesToQuestion(
      `${input.control.groupLabel}\n${input.pageInstructions}`,
      input.control.label,
    ) &&
    !requiresSavedNationalityAnswer(input.control.label) &&
    !requiresSavedOpinionAnswer(input.control.label, input.answer)
  )
    return { kind: "writing", source: null };
  if (!source)
    return deny(
      "There is no matching verbatim source for this question. Please supply your answer.",
      "source_lookup",
    );
  const saved =
    savedAnswerForQuestion(
      input.control,
      input.sources.reusableAnswers,
      input.controls,
    ) ?? pickerRule?.saved;
  let savedValueMatches = source.value === input.answer;
  if (
    saved &&
    !fieldNamesAnotherPerson(input.control) &&
    addressLabels.includes(normalizeFormQuestionPrompt(input.control.label)) &&
    addressAnswerMatches(source.value, input.answer, input.sources.profile)
  )
    savedValueMatches = true;
  if (
    saved &&
    tags.kind === "other" &&
    knownLiteralField({ ...source, id: "profile.phone" }, input.control) &&
    phoneAnswerMatches(
      source.value,
      input.answer,
      input.control,
      input.controls,
    )
  )
    savedValueMatches = true;
  if (saved && pickerRule?.saved.id === saved.id) {
    const primary = strictOptionMatch(
      input.control.options,
      pickerRule.rule.primary,
    );
    const fallback = strictOptionMatch(
      input.control.options,
      pickerRule.rule.fallback,
    );
    if (
      (primary.kind === "match" && input.answer === primary.value) ||
      (primary.kind === "none" &&
        fallback.kind === "match" &&
        input.answer === fallback.value)
    )
      savedValueMatches = true;
  }
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
    (["motivation", "factual_summary"].includes(tags.kind) &&
      ownWordsAppliesToQuestion(
        `${input.control.groupLabel}\n${input.pageInstructions}`,
        input.control.label,
      )) ||
    requiresSavedNationalityAnswer(input.control.label) ||
    (["motivation", "factual_summary"].includes(tags.kind) &&
      asksForSpecificStory(
        `${input.control.groupLabel} ${input.control.label}`,
      )) ||
    requiresSavedOpinionAnswer(input.control.label, input.answer);
  if (gated)
    return exactSaved
      ? { kind: "literal", source }
      : deny("This question needs your own unchanged answer.");
  const timezone =
    tags.kind === "other"
      ? currentTimezoneAnswer(input.control, input.sources)
      : null;
  if (timezone) {
    if (exactSaved) return { kind: "literal", source };
    const evidence = timezone.evidence;
    return evidence &&
      timezone.value === input.answer &&
      source.purpose === "profile" &&
      [evidence.sourceId, evidence.sourceId.split("#")[0]].includes(source.id)
      ? {
          kind: "literal",
          source: {
            ...source,
            id: evidence.sourceId,
            value: timezone.value,
            country: evidence.country,
          },
        }
      : deny(
          "Your current country does not establish an unambiguous answer to this timezone question. Please choose your answer.",
        );
  }
  if (priorCompany)
    return priorCompany.answer?.value === input.answer && source
      ? { kind: "literal", source }
      : deny(
          "This prior-company answer must match your recorded employment history.",
        );
  if (tags.kind === "other" && asksListingDiscoveryControl(input.control)) {
    const recorded = listingDiscoveryAnswer(
      input.control,
      input.sources,
      input.controls,
    );
    if (
      recorded?.value === input.answer &&
      (!["radio", "checkbox"].includes(input.control.kind) ||
        [input.control.label, input.control.value].includes(input.answer))
    )
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
    if (
      !exactSaved &&
      (tags.hasAdditionalConditions === true ||
        (tags.kind === "work_auth" &&
          /\b(?:restrictions?|limitations?|sponsor(?:ship|ing|ed)?|without)\b/iu.test(
            [
              ...(input.control.sectionPath ?? []),
              input.control.groupLabel,
              input.control.label,
              input.control.hint ?? "",
            ].join(" "),
          )))
    )
      return deny(
        "Authorization alone does not establish the question's additional restrictions or sponsorship conditions.",
        "permit_conditions",
      );
    if (!target || tags.country !== target || source.country !== target)
      return deny(
        "The work-permission country is unknown or does not match the source. Please answer for this job's country.",
      );
    if (
      (!(
        exactSaved &&
        tags.kind === "work_auth" &&
        knownLegalQuestion &&
        tags.hasAdditionalConditions !== true &&
        !/\b(?:restrictions?|limitations?|sponsor(?:ship)?|without)\b/iu.test(
          input.control.kind === "radio"
            ? (input.control.sectionPath?.at(-1) ?? input.control.groupLabel)
            : input.control.label,
        ) &&
        /^(?:no|false)$/iu.test(input.answer)
      ) &&
        !permitConditionsFit(input.sources, target)) ||
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
  if (
    exactSaved &&
    (!isStartDateControl(input.control) ||
      hasStartDateValue({
        ...input.control,
        value: input.answer,
        invalid: false,
      }))
  )
    return { kind: "literal", source };
  if (tags.kind === "other" && isStartDateControl(input.control)) {
    const start = startDateAnswer(
      input.control,
      input.sources,
      input.controls,
      input.now ?? new Date(),
    );
    return start &&
      start.id === source.id &&
      canonicalStartDate(input.answer) === start.value
      ? { kind: "literal", source: { ...source, value: input.answer } }
      : deny(
          "This date must be calculated from your recorded availability or notice period.",
        );
  }
  if (exactSaved) return { kind: "literal", source };
  if (tags.kind === "residence_country")
    return source.id === "profile.currentCountry" &&
      source.purpose === "profile" &&
      !fieldNamesAnotherPerson(input.control) &&
      !input.control.asksHiringCountry &&
      literalValueMatches(source, input.control, input.answer)
      ? { kind: "literal", source }
      : deny(
          "This residence-country answer must use your recorded current country.",
        );
  const literalQuestion =
    tags.kind === "other" || tags.kind === "factual_summary";
  if (
    literalQuestion &&
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
    literalQuestion &&
    source.purpose === "profile" &&
    literalValueMatches(
      source,
      input.control,
      input.answer,
      input.controls,
      input.sources,
    ) &&
    knownLiteralField(source, input.control)
  )
    return { kind: "literal", source };
  // A semantic match may overcome an unfamiliar label after independent
  // grounding. Gated kinds, permit conditions, references and same-row
  // history checks above still apply; the value stays verbatim.
  if (
    tags.kind === "other" &&
    input.matchedSourceId === source.id &&
    ["profile", "saved"].includes(source.purpose) &&
    !input.control.repeatedQuestion &&
    !fieldNamesAnotherPerson(input.control) &&
    literalValueMatches(
      source,
      input.control,
      input.answer,
      input.controls,
      input.sources,
    )
  )
    return { kind: "literal", source };
  // Only an affirmative writing classification reaches the claim checker.
  if (tags.kind === "motivation" && source.purpose === "writing")
    return { kind: "writing", source };
  if (
    tags.kind === "factual_summary" &&
    input.control.kind === "long_text" &&
    ["other", "experience"].includes(input.control.questionKind) &&
    !isScalarAnswer(input.answer) &&
    input.answer.trim().split(/\s+/u).length >= 3 &&
    !fieldNamesAnotherPerson(input.control) &&
    (source.id === "resume.text" ||
      (source.purpose === "profile" &&
        /^profile\.(?:summary$|professionalSummary\.|narrative\.|experiences\.|education\.|projects\.|proofBank\.|skills\.|skillGroups\.|certifications\.|spokenLanguages\.)/u.test(
          source.id,
        )))
  )
    return factualSummaryIsSourced(
      input.answer,
      catalog
        .filter((row) => row.purpose === "profile" || row.id === "resume.text")
        .map((row) => row.value),
    )
      ? { kind: "writing", source, evidencePolicy: "factual_summary" }
      : deny(
          "This summary must use complete statements from your resume or Profile, without joining separate facts into a new claim.",
        );
  return deny(
    "This value is not a verbatim answer from a known-safe matching source.",
  );
}
