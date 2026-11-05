import { questionPrompt } from "./question-text";
import {
  inferAttestationKind,
  inferQuestionKind,
} from "./control-classification";
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
  isAnswerFromThisApplication,
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
import { isShortValueAnswer } from "./written-answer-grounding";
import { expectedPaySuggestion } from "./expected-pay";
import { asksGithubUsername, fieldNamesAnotherPerson } from "./github-username";
import { asksForSpecificStory } from "./factual-summary";
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
const contactLabels: Record<string, readonly string[]> = {
  "profile.fullName": ["name", "full name", "your full name", "your name"],
  "profile.firstName": ["first name", "given name", "legal first name"],
  "profile.middleName": ["middle name"],
  "profile.lastName": [
    "last name",
    "surname",
    "family name",
    "legal last name",
  ],
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
  const prefix = record?.[1];
  if (!record || !prefix) return true;
  const group = (control: ApplyFormControl) => {
    const group = normalizeFormQuestionPrompt(control.groupLabel);
    return group === normalizeFormQuestionPrompt(control.label) ? "" : group;
  };
  const leaves =
    record[2] === "experiences"
      ? ["companyName", "title", "startDate", "endDate"]
      : ["schoolName", "degree", "fieldOfStudy", "startDate", "endDate"];
  return (
    input.controls
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
      }) && !historyRecordInAnotherRow(prefix, input, catalog)
  );
}

const HISTORY_LEAVES = {
  experiences: ["companyName", "title", "startDate", "endDate"],
  education: ["schoolName", "degree", "fieldOfStudy", "startDate", "endDate"],
} as const;

/** The Profile records a filled history row is, by every filled field in it. */
function historyRowRecords(
  row: readonly ApplyFormControl[],
  kind: "experiences" | "education",
  catalog: readonly ClassifiedAnswerSource[],
): string[] {
  const identity = kind === "experiences" ? "companyName" : "schoolName";
  const prefixes = [
    ...new Set(
      catalog.flatMap((source) => {
        const match = new RegExp(`^(profile\\.${kind}\\.[^.]+)\\.`, "u").exec(
          source.id,
        );
        return match?.[1] ? [match[1]] : [];
      }),
    ),
  ];
  return prefixes.filter((prefix) => {
    const filled = row.filter((control) => control.value.trim());
    const leafOf = (control: ApplyFormControl) =>
      HISTORY_LEAVES[kind].find((leaf) =>
        knownLiteralField({ id: `${prefix}.${leaf}` }, control),
      );
    // A row is a record only once its employer or school says so.
    if (!filled.some((control) => leafOf(control) === identity)) return false;
    return filled.every((control) => {
      const leaf = leafOf(control);
      if (!leaf) return true;
      const expected = catalog.find(
        (source) => source.id === `${prefix}.${leaf}`,
      );
      return (
        !!expected && literalValueMatches(expected, control, control.value)
      );
    });
  });
}

/**
 * Rows are bound by what they hold, never by order (council D2): a Profile
 * record another row of the same form already holds cannot fill this row.
 */
function historyRecordInAnotherRow(
  prefix: string,
  input: { control: ApplyFormControl; controls: readonly ApplyFormControl[] },
  catalog: readonly ClassifiedAnswerSource[],
): boolean {
  const kind = prefix.includes(".experiences.") ? "experiences" : "education";
  const own = input.control.rowScopeKey;
  if (!own) return false;
  const rows = new Map<string, ApplyFormControl[]>();
  for (const control of input.controls)
    if (
      control.rowScopeKey &&
      control.rowScopeKey !== own &&
      (!control.scopeKey ||
        !input.control.scopeKey ||
        control.scopeKey === input.control.scopeKey)
    )
      rows.set(control.rowScopeKey, [
        ...(rows.get(control.rowScopeKey) ?? []),
        control,
      ]);
  return [...rows.values()].some((row) =>
    historyRowRecords(row, kind, catalog).includes(prefix),
  );
}

/**
 * Filled history rows that hold the same single Profile record as another
 * row, wherever they sit in the form (hidden earlier steps included). Sending
 * such a form would repeat one job or school as two.
 */
export function duplicatedHistoryRows(
  controls: readonly ApplyFormControl[],
  sources: ApplyAnswerSources,
): string[] {
  const catalog = answerSourceCatalog(sources);
  const rows = new Map<string, ApplyFormControl[]>();
  for (const control of controls)
    if (control.rowScopeKey)
      rows.set(`${control.scopeKey ?? ""}|${control.rowScopeKey}`, [
        ...(rows.get(`${control.scopeKey ?? ""}|${control.rowScopeKey}`) ?? []),
        control,
      ]);
  const held = new Map<string, string[]>();
  for (const row of rows.values())
    for (const kind of ["experiences", "education"] as const) {
      const records = historyRowRecords(row, kind, catalog);
      const [only] = records;
      if (records.length !== 1 || !only) continue;
      const label =
        row[0]?.sectionPath?.at(-1) ?? row[0]?.groupLabel ?? "history entry";
      held.set(only, [...(held.get(only) ?? []), label]);
    }
  return [...held.values()].filter((labels) => labels.length > 1).flat();
}

export function literalValueMatches(
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

/** Only an explicit instruction to certify the supplied answers grants this
 * routine acknowledgement. It grants no licence, eligibility or other fact. */
function taskAllowsTruthfulness(instructions: readonly string[]): boolean {
  const sentences = instructions.flatMap((instruction) =>
    instruction.split(/[.!?;\n]+/u),
  );
  const certifies = /\b(?:certify|attest|confirm)\b/iu;
  if (
    sentences.some(
      (sentence) =>
        certifies.test(sentence) &&
        /\b(?:not|never|unless|only if|provided that|cannot|can t|don t)\b/iu.test(
          sentence,
        ),
    )
  )
    return false;
  return sentences.some(
    (sentence) =>
      /^(?:\s*(?:you\s+)?(?:may|can|please)\s+)?\s*(?:certify|attest|confirm)\b/iu.test(
        sentence,
      ) &&
      /\b(?:truthful|true|accurate|accuracy)\b/iu.test(sentence) &&
      /\b(?:supplied|provided|answers?|responses?|information|facts|details)\b/iu.test(
        sentence,
      ),
  );
}

/**
 * "Authorized to work in C without sponsorship" is settled only when C is
 * the resolved job country, a listed country covers it unconditionally (no
 * limited permit there), the recorded sponsorship fact is "no", and the
 * question's only extra condition is sponsorship. Restrictions, permanence
 * or a permit type still go to the person (council D6).
 */
function withoutSponsorshipSettled(
  input: {
    control: ApplyFormControl;
    tags: ApplyAnswerTags | null | undefined;
    sources: ApplyAnswerSources;
    answer: string;
  },
  target: string | null,
  source: ClassifiedAnswerSource | undefined,
): boolean {
  const question = [
    ...(input.control.sectionPath ?? []),
    input.control.groupLabel,
    input.control.label,
    input.control.hint ?? "",
  ].join(" ");
  const eligibility = input.sources.profile.workEligibility;
  return (
    input.tags?.kind === "work_auth" &&
    input.answer === "Yes" &&
    !!target &&
    source?.purpose === "work_auth" &&
    source.country === target &&
    /\bwithout\s+(?:(?:the\s+)?need(?:ing)?\s+(?:for\s+|of\s+)?|requiring\s+(?:any\s+)?|any\s+)?(?:visa\s+|employer\s+|company\s+)?sponsor(?:ship|ing)\b/iu.test(
      question,
    ) &&
    !/\b(?:restrictions?|limitations?|limited|permanent(?:ly)?|unrestricted|indefinite(?:ly)?|permit\s+type|visa\s+type|condition(?:s|al)?)\b/iu.test(
      question,
    ) &&
    eligibility.requiresVisaSponsorship === false &&
    !eligibility.limitedWorkPermissions?.some((permission) =>
      countriesIn(permission.country).has(target),
    )
  );
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

export type ClassifiedAnswerDecision =
  | { kind: "literal"; source: ClassifiedAnswerSource }
  | {
      kind: "inference";
      source: null;
      evidencePolicy: "factual_inference" | "eligibility";
    }
  | {
      kind: "writing";
      source: ClassifiedAnswerSource | null;
      evidencePolicy?: "factual_summary" | "saved_answer" | "declaration";
    }
  | { kind: "needs_you"; reason: string; check?: string }
  /**
   * Send only: the site filled this, Nestor left it unchanged, and the
   * checker proved that from this attempt's receipts. Never a Profile fact,
   * never permission to write or reuse it.
   */
  | { kind: "site_unchanged" };
/** An affirmative allow list. Tags or a positive checker verdict alone grant nothing. */
/** Immutable applicant facts need no semantic guess, including on a later step. */
export function applicantLiteralSource(
  control: ApplyFormControl,
  controls: readonly ApplyFormControl[],
  sources: ApplyAnswerSources,
  /** The page's instructions for this question; they can change its meaning. */
  instructions: string,
): ClassifiedAnswerSource | null {
  const fieldWords = normalizeFormQuestionPrompt(control.label)
    .split(/\s+/u)
    .filter(
      (word) =>
        word.length > 2 && !["your", "the", "full", "legal"].includes(word),
    );
  const relevantInstructions = instructions
    .split(/[.!?;\n]/u)
    .filter(
      (sentence) =>
        fieldWords.some((word) =>
          normalizeFormQuestionPrompt(sentence).split(/\s+/u).includes(word),
        ) || /\bthis field\b/iu.test(sentence),
    )
    .join(". ");
  if (
    control.kind !== "text" ||
    streetAddressLine(control, controls) ||
    // "Enter your reference's full name" or a name as on a passport, said
    // only in the page text, makes a plain "Full name" someone else's or a
    // document's. The classified fallback refuses the same wording.
    fieldNamesAnotherPerson({ ...control, hint: relevantInstructions }) ||
    /\b(?:passport|identity document|national id|as (?:it )?appears on)\b/iu.test(
      instructions,
    ) ||
    control.credentialRole ||
    control.attestationKind ||
    inferAttestationKind(control) ||
    !["other", "personal_info", "portfolio", "location"].includes(
      inferQuestionKind(control),
    ) ||
    control.hint?.trim() ||
    fieldNamesAnotherPerson(control) ||
    /\b(?:work history|employment|experience|education|school|reference|supervisor|referrer|emergency contact|passport)\b/iu.test(
      [...(control.sectionPath ?? []), control.groupLabel].join(" "),
    ) ||
    (control.placeholder.trim() &&
      normalizeFormQuestionPrompt(control.placeholder) !==
        normalizeFormQuestionPrompt(control.label)) ||
    controls.filter(
      (candidate) =>
        candidate.visible &&
        !candidate.disabled &&
        candidate.kind === control.kind &&
        candidate.label === control.label &&
        candidate.groupLabel === control.groupLabel,
    ).length !== 1
  )
    return null;
  return (
    answerSourceCatalog(sources).find(
      (source) =>
        // Country is left to the classified residence rules: a bare Country can
        // mean citizenship or the hiring country.
        /^profile\.(?:fullName|firstName|middleName|lastName|email|phone|currentCity|currentRegion|portfolioUrl|linkedinUrl|githubUrl|personalWebsiteUrl|timeZone)$/u.test(
          source.id,
        ) && knownLiteralField(source, control),
    ) ?? null
  );
}

export function classifyAnswerPermission(input: {
  control: ApplyFormControl;
  controls: readonly ApplyFormControl[];
  tags: ApplyAnswerTags | null | undefined;
  sources: ApplyAnswerSources;
  answer: string;
  pageInstructions: string;
  approvedAttestations?: readonly ApplicationAttestationKind[];
  application?: ApplyAgentConfig["application"];
  payDisclosed?: boolean;
  now?: Date;
  /** Supplied only by the host after the independent answer check. */
  matchedSourceId?: string | undefined;
  /** A proposed catalog reference; it grants no semantic-match permission. */
  candidateSourceId?: string | undefined;
  /**
   * Supplied only by the send-time checker: this attempt's receipts prove
   * the site prefilled this exact value and Nestor never wrote it. `echo`:
   * the read-only repeat of a qualifying original on a later step.
   */
  siteUnchanged?: { echo: boolean } | undefined;
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
  const declarationApproved =
    !!input.control.attestationKind &&
    (input.approvedAttestations?.includes(input.control.attestationKind) ||
      (input.control.attestationKind === "truthfulness_certification" &&
        taskAllowsTruthfulness(
          input.sources.taskInstructions ??
            input.application?.instructions ??
            [],
        )));
  if (input.control.credentialRole)
    return deny("Credentials and verification codes stay with the person.");
  if (!tags) {
    const literal = applicantLiteralSource(
      input.control,
      input.controls,
      input.sources,
      input.pageInstructions,
    );
    if (literal && literal.value === input.answer)
      return { kind: "literal", source: literal };
    return deny(
      "Nestor could not read this question safely. Your saved facts are kept; try again or complete this control on the form.",
      "question_classification",
    );
  }
  const identity = (control: ApplyFormControl) =>
    normalizeFormQuestionPrompt(questionPrompt(control));
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
    ) ??
    pickerRule?.saved ??
    null;
  if (
    input.payDisclosed === false &&
    input.control.questionKind === "salary_expectation" &&
    !isAnswerFromThisApplication(
      matchingSaved,
      input.application ?? {},
      input.sources.posting.location,
    ) &&
    !(
      matchingSaved?.id.startsWith("application_") &&
      !matchingSaved.applicationScope
    )
  )
    return deny(
      "Your pay setting is Pause for me on pay. Choose what to disclose for this application.",
      "pay_permission",
    );
  if (
    input.payDisclosed === true &&
    tags.kind === "salary" &&
    input.control.questionKind === "salary_expectation"
  ) {
    const pay = expectedPaySuggestion(input.control, input.sources);
    if (
      pay &&
      pay.value === input.answer &&
      input.control.options.includes(pay.value)
    )
      return {
        kind: "literal",
        source: {
          id: pay.sourceId,
          value: pay.value,
          purpose: "profile",
          country: null,
        },
      };
  }
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
  const legalPrompt = [
    ...(input.control.sectionPath ?? []),
    input.control.groupLabel,
    input.control.label,
    input.control.hint ?? "",
  ].join(" ");
  const namedCountries = countriesIn(legalPrompt);
  const resolvedTarget = legalQuestionCountry(legalPrompt, catalog);
  // A question may explicitly contrast jurisdictions. The independent check
  // must confirm the reader's selection against the whole question.
  const target =
    resolvedTarget ??
    (legal && tags.country && namedCountries.has(tags.country)
      ? tags.country
      : null);
  const conditionalEligibility = (): ClassifiedAnswerDecision | null => {
    const permitted =
      legal &&
      typeof tags.hasAdditionalConditions === "boolean" &&
      tags.country &&
      !fieldNamesAnotherPerson(input.control) &&
      (namedCountries.size === 0 || namedCountries.has(tags.country)) &&
      input.sources.profile.workEligibility.limitedWorkPermissions?.some(
        (permit) =>
          country(permit.country) === tags.country ||
          countriesIn(permit.conditions).has(tags.country!),
      );
    return permitted
      ? { kind: "inference", source: null, evidencePolicy: "eligibility" }
      : null;
  };
  if (legal && !target)
    return (
      conditionalEligibility() ??
      deny("The work-permission country is unknown or ambiguous.")
    );
  const knownLegalQuestion = legal && !fieldNamesAnotherPerson(input.control);
  if (knownLegalQuestion && !source)
    source = catalog.find(
      (row) => row.purpose === tags.kind && row.country === target,
    );
  // The countries where the person may work are a complete list (ADR 0029):
  // a resolved job country it plainly does not cover is a No. A region in
  // the list, a limited permit there, or extra conditions leave it asked.
  if (
    knownLegalQuestion &&
    tags.kind === "work_auth" &&
    target &&
    input.answer === "No" &&
    tags.hasAdditionalConditions !== true &&
    (!source || source.purpose === "work_auth")
  ) {
    const eligibility = input.sources.profile.workEligibility;
    const listed = eligibility.authorizedWorkCountries.map((name) =>
      countriesIn(name),
    );
    const excluded =
      listed.length > 0 &&
      listed.every(
        (codes) =>
          codes.size === 1 &&
          !codes.has(target) &&
          ![...codes].some((code) => ["EU", "EEA"].includes(code)),
      ) &&
      !eligibility.limitedWorkPermissions?.some((permission) =>
        countriesIn(permission.country).has(target),
      ) &&
      !catalog.some(
        (row) => row.purpose === "work_auth" && row.country === target,
      );
    if (excluded)
      source = {
        id: "profile.workEligibility.authorizedWorkCountries",
        value: "No",
        purpose: "work_auth",
        country: target,
      };
  }
  if (matchingSaved) {
    const human = catalog.find(
      (row) => row.id === `answerLibrary.${matchingSaved.id}`,
    );
    if (human && (!legal || human.country === target)) source = human;
  }
  // A semantic source selection is only a proposal. A second model must
  // verify that the saved question has the same complete meaning and value.
  // Current-application answers can settle their own conditional eligibility;
  // reuse elsewhere still has to fit this jurisdiction and permit conditions.
  let savedSetOffered = false;
  if (matchingSaved && input.control.answerControlType === "multi_choice") {
    try {
      const selected: unknown = JSON.parse(matchingSaved.answer);
      const offered = input.control.options.length
        ? input.control.options
        : input.controls
            .filter(
              (control) =>
                control.choiceGroupKey === input.control.choiceGroupKey,
            )
            .map((control) => control.label || control.value);
      savedSetOffered =
        Array.isArray(selected) &&
        selected.every(
          (value) => typeof value === "string" && offered.includes(value),
        );
    } catch {
      /* Non-set answers cannot grant an individual selection. */
    }
  }
  if (
    (!matchingSaved ||
      (source &&
        !literalValueMatches(
          source,
          input.control,
          input.answer,
          input.controls,
          input.sources,
        ) &&
        !savedSetOffered &&
        !(
          addressLabels.includes(
            normalizeFormQuestionPrompt(input.control.label),
          ) &&
          addressAnswerMatches(
            source.value,
            input.answer,
            input.sources.profile,
          )
        ))) &&
    source?.purpose === "saved" &&
    !input.control.repeatedQuestion &&
    !fieldNamesAnotherPerson(input.control) &&
    (!(
      tags.kind === "own_words" ||
      requiresOwnWords(input.control.label) ||
      ownWordsAppliesToQuestion(
        `${input.control.groupLabel}\n${input.pageInstructions}`,
        input.control.label,
      )
    ) ||
      source.value.trim() === input.answer.trim())
  ) {
    const record = input.sources.reusableAnswers.find(
      (entry) => source?.id === `answerLibrary.${entry.id}`,
    );
    const conflicting = catalog.some(
      (entry) =>
        entry.purpose === "saved" &&
        normalizeFormQuestionPrompt(entry.question ?? "") ===
          normalizeFormQuestionPrompt(source?.question ?? "") &&
        entry.value.trim() !== source?.value.trim(),
    );
    // Differing text can be one accepted numeric/option meaning. The whole-source
    // checker resolves that once; it still refuses genuinely conflicting facts.
    if (conflicting && !legal)
      return { kind: "writing", source, evidencePolicy: "saved_answer" };
    const scope = record?.applicationScope;
    const local =
      !!input.application &&
      !!scope &&
      ((!!input.application.applicationRecordId &&
        scope.applicationRecordId === input.application.applicationRecordId) ||
        (!!input.application.resultId &&
          scope.resultId === input.application.resultId));
    if (
      !legal ||
      (target &&
        source.country === target &&
        (local ||
          (permitConditionsFit(input.sources, target) &&
            !(
              tags.kind === "sponsorship" &&
              input.answer === "No" &&
              input.sources.profile.workEligibility.limitedWorkPermissions?.some(
                (permit) =>
                  country(permit.country) === target &&
                  permit.requiresFutureSponsorship === true,
              )
            ))))
    )
      return { kind: "writing", source, evidencePolicy: "saved_answer" };
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
    !matchingSaved &&
    tags.kind === "other" &&
    input.control.attestationKind &&
    declarationApproved &&
    (tags.declarationPurpose === "consent" ||
      tags.declarationPurpose === "acknowledgement" ||
      (tags.hasAdditionalConditions !== true &&
        inferAttestationKind(input.control) === input.control.attestationKind &&
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
  if (
    tags.kind === "other" &&
    input.control.attestationKind &&
    declarationApproved &&
    (tags.declarationPurpose === "consent" ||
      tags.declarationPurpose === "acknowledgement") &&
    input.answer !== "Yes"
  )
    return {
      kind: "writing",
      source: {
        id: `authority.attestation.${input.control.attestationKind}`,
        value: input.control.attestationKind,
        purpose: "authority",
        country: null,
      },
      evidencePolicy: "declaration",
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
  // "Which skills would you bring?" is answered from the recorded skills
  // list, not an opinion (council D2/D3): every item must be a Profile skill,
  // verbatim. A top or favourite skill, own-words wording or another person
  // stays with the person.
  // An Address field next to its own City or Postal code field is the street
  // line: the recorded city or location is never its answer, whatever source
  // proposed it (workday replica, candidate 5 sent "Berlin, Germany"). A lone
  // Address field is still the person's location.
  if (streetAddressLine(input.control, input.controls)) {
    const location = catalog.filter((row) =>
      /^profile\.current(?:City|Location)$/u.test(row.id),
    );
    if (
      location.some((row) =>
        addressAnswerMatches(row.value, input.answer, input.sources.profile),
      )
    )
      return deny(
        "This is the street line of an address with its own city field; your city or location is not its answer.",
        "street_address_line",
      );
    if (source && location.some((row) => row.id === source?.id))
      source = undefined;
  }
  const skills = recordedSkillsAnswer({ ...input, tags }, catalog);
  if (skills) return { kind: "literal", source: skills };
  // A declaration whose kind the person has not allowed is theirs to tick.
  // Say that, rather than that no source answers it.
  if (!source && input.control.attestationKind && !declarationApproved)
    return deny(
      "This declaration is not one of those you let Nestor tick for you (Settings, Declarations it may tick for you), so it is yours to confirm.",
      "declaration_permission",
    );
  if (!source && input.siteUnchanged && siteUnchangedAnswerAllowed(input))
    return { kind: "site_unchanged" };
  if (!source && conditionalEligibility()) return conditionalEligibility()!;
  if (!source)
    return factualInferenceAllowed(input)
      ? { kind: "inference", source: null, evidencePolicy: "factual_inference" }
      : deny(
          "Nestor could not establish an answer to this whole question from your saved facts or permissions. Please supply the missing answer.",
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
  // A start date ("Preferred start date" included) is calculated from the
  // recorded availability, not an opinion. When the selected source is the
  // one the start-date rule uses, that rule decides before the opinion and
  // preference gates. Other "preferred …" questions stay gated.
  const start =
    (tags.kind === "other" || tags.kind === "preference") &&
    isStartDateControl(input.control)
      ? startDateAnswer(
          input.control,
          input.sources,
          input.controls,
          input.now ?? new Date(),
        )
      : null;
  if (start && start.id === source.id)
    return canonicalStartDate(input.answer) === start.value
      ? { kind: "literal", source: { ...source, value: input.answer } }
      : deny(
          "This date must be calculated from your recorded availability or notice period.",
        );
  if (
    tags.kind === "preference" &&
    source.purpose === "profile" &&
    (/^profile\.preferences\./u.test(source.id) ||
      (source.id === "profile.workEligibility.willingToRelocate" &&
        /relocat/iu.test(questionPrompt(input.control)))) &&
    !requiresOwnWords(input.control.label)
  )
    return {
      kind: "inference",
      source: null,
      evidencePolicy: "factual_inference",
    };
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
      !withoutSponsorshipSettled(input, target, source) &&
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
      return (
        conditionalEligibility() ??
        deny(
          "Authorization alone does not establish the question's additional restrictions or sponsorship conditions.",
          "permit_conditions",
        )
      );
    if (!target || tags.country !== target || source.country !== target)
      return (
        conditionalEligibility() ??
        deny(
          "The work-permission country is unknown or does not match the source. Please answer for this job's country.",
        )
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
      return (
        conditionalEligibility() ??
        deny(
          "The current permit conditions have not been shown to fit this job. Please confirm this answer.",
        )
      );
    if (
      exactSaved ||
      (knownLegalQuestion &&
        source.purpose === tags.kind &&
        source.value.trim() === input.answer.trim())
    )
      return { kind: "literal", source };
    return (
      conditionalEligibility() ??
      deny(
        "No matching country-specific work-permission source answers this question.",
      )
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
  const recordPrefix = /^(profile\.(?:experiences|education)\.[^.]+)\./u.exec(
    source.id,
  )?.[1];
  if (
    source.purpose === "profile" &&
    recordPrefix &&
    historyRecordInAnotherRow(recordPrefix, input, catalog)
  )
    return deny(
      "Another entry on this form already holds this Profile record. Fill this entry from a different record, or remove it if this run added it; leave an optional entry empty.",
      "history_record_in_use",
    );
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
    return { kind: "writing", source, evidencePolicy: "factual_summary" };
  return factualInferenceAllowed(input)
    ? { kind: "inference", source: null, evidencePolicy: "factual_inference" }
    : deny(
        "This value is not a verbatim answer from a known-safe matching source.",
      );
}

/** Permission to ask the checker, never permission to enter its proposal. */
const STREET_LINE_LABELS = [
  "address",
  "current address",
  "street address",
  "street",
  "address line 1",
  "address line",
];
const LOCALITY_PART_LABELS = [
  "city",
  "town",
  "postal code",
  "postcode",
  "post code",
  "zip",
  "zip code",
];

/** An address field that has its own city or postal code field beside it. */
function streetAddressLine(
  control: ApplyFormControl,
  controls: readonly ApplyFormControl[],
): boolean {
  if (
    control.kind !== "text" ||
    !STREET_LINE_LABELS.includes(normalizeFormQuestionPrompt(control.label))
  )
    return false;
  return controls.some(
    (other) =>
      other !== control &&
      other.ref !== control.ref &&
      (!other.scopeKey ||
        !control.scopeKey ||
        other.scopeKey === control.scopeKey) &&
      LOCALITY_PART_LABELS.includes(normalizeFormQuestionPrompt(other.label)),
  );
}

function recordedSkillsAnswer(
  input: {
    control: ApplyFormControl;
    tags: ApplyAnswerTags;
    answer: string;
    pageInstructions: string;
  },
  catalog: readonly ClassifiedAnswerSource[],
): ClassifiedAnswerSource | null {
  const { control } = input;
  const question = [control.groupLabel, control.label, control.hint ?? ""].join(
    "\n",
  );
  if (
    !["other", "factual_summary"].includes(input.tags.kind) ||
    !["text", "long_text"].includes(control.kind) ||
    !/\bskills?\b/iu.test(control.label) ||
    fieldNamesAnotherPerson(control) ||
    requiresOwnWords(question) ||
    ownWordsAppliesToQuestion(
      `${control.groupLabel}\n${input.pageInstructions}`,
      control.label,
    ) ||
    requiresSavedOpinionAnswer(question, input.answer)
  )
    return null;
  const recorded = catalog.filter((row) =>
    /^profile\.skills\.\d+$/u.test(row.id),
  );
  const key = (value: string) => value.normalize("NFKC").trim().toLowerCase();
  const items = input.answer
    .split(/\s*(?:,|;|\n|\band\b)\s*/u)
    .map((item) => item.replace(/^[-•*]\s*/u, "").trim())
    .filter(Boolean);
  if (
    !items.length ||
    !items.every((item) => recorded.some((row) => key(row.value) === key(item)))
  )
    return null;
  return {
    id: "profile.skills",
    value: input.answer,
    purpose: "profile",
    country: null,
  };
}

/**
 * A short value the site filled and Nestor left unchanged, on a plain text
 * question that is no known Profile field and none of identity, declarations,
 * pay, the hiring country, eligibility, citizenship or passport, preference,
 * own words, a story or the person's history. The proof itself (receipts,
 * values) is the checker's; this only decides whether such a field may pass.
 */
export function siteUnchangedAnswerAllowed(input: {
  control: ApplyFormControl;
  tags: ApplyAnswerTags | null | undefined;
  sources: ApplyAnswerSources;
  pageInstructions: string;
  answer: string;
  siteUnchanged?: { echo: boolean } | undefined;
}): boolean {
  const { control, tags } = input;
  if (!tags || tags.kind !== "other" || control.kind !== "text") return false;
  if (control.questionKind !== "other" || control.required) return false;
  // A repeated question passes only as the read-only echo of its original.
  if (
    control.repeatedQuestion &&
    !(input.siteUnchanged?.echo === true && control.readOnly)
  )
    return false;
  if (!isShortValueAnswer(control, input.answer)) return false;
  const question = [
    ...(control.sectionPath ?? []),
    control.groupLabel,
    control.label,
    control.hint ?? "",
  ].join("\n");
  if (
    /\b(?:citizen(?:ship)?|nationality|passport|eligib(?:le|ility)|authori[sz](?:ed|ation)|sponsor(?:ship)?|visa|salary|pay|compensation|wage|prefer(?:red|ence)?|history|employer|employment|education|school|degree|reference|supervisor|referrer)\b/iu.test(
      question,
    )
  )
    return false;
  // A wrong prefilled name, email or phone resolves to its Profile field.
  if (
    answerSourceCatalog(input.sources).some(
      (source) =>
        source.id.startsWith("profile.") && knownLiteralField(source, control),
    )
  )
    return false;
  // The echo is judged as its original question, without the repeat note.
  const original: ApplyFormControl = { ...control };
  delete original.repeatedQuestion;
  return factualInferenceAllowed({ ...input, control: original });
}

function factualInferenceAllowed(input: {
  control: ApplyFormControl;
  tags: ApplyAnswerTags | null | undefined;
  pageInstructions: string;
  answer: string;
  payDisclosed?: boolean;
}): boolean {
  const { control, tags } = input;
  const question = [
    ...(control.sectionPath ?? []),
    control.groupLabel,
    control.label,
    control.hint ?? "",
  ].join("\n");
  return (
    !!tags &&
    (["other", "residence_country"].includes(tags.kind) ||
      (tags.kind === "salary" && input.payDisclosed === true)) &&
    ["text", "select", "combobox", "radio", "checkbox"].includes(
      control.kind,
    ) &&
    (control.kind !== "text" ||
      isShortValueAnswer(
        input.payDisclosed === true &&
          control.questionKind === "salary_expectation"
          ? { ...control, questionKind: "other" }
          : control,
        input.answer,
      )) &&
    !["work_authorization", "visa_sponsorship"].includes(
      control.questionKind,
    ) &&
    (control.questionKind !== "salary_expectation" ||
      input.payDisclosed === true) &&
    !control.asksCurrentPay &&
    !control.asksHiringCountry &&
    !control.credentialRole &&
    !control.repeatedQuestion &&
    control.attestationKind === null &&
    inferAttestationKind(control) === null &&
    // These are permission boundaries, not rules choosing an answer. The
    // question reader also recognizes their meaning in other languages.
    !/\b(?:criminal|convict(?:ion|ed)?|felon(?:y)?|misdemeanou?r|arrest(?:ed)?|signature|sign here|digitally sign)\b/iu.test(
      question,
    ) &&
    !fieldNamesAnotherPerson(control) &&
    !requiresOwnWords(question) &&
    !ownWordsAppliesToQuestion(
      `${control.groupLabel}\n${input.pageInstructions}`,
      control.label,
    ) &&
    !requiresSavedNationalityAnswer(question) &&
    !requiresSavedOpinionAnswer(question, input.answer) &&
    !asksForSpecificStory(question)
  );
}
