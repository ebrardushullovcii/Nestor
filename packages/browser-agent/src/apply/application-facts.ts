import {
  normalizeFormQuestionPrompt,
  preserveTechnologyTokens,
  type CandidateReusableAnswer,
} from "@nestor/contracts";

import { normalizeSignal } from "./control-classification";
import {
  asksGithubUsername,
  formatGithubAnswer,
  githubUsername,
} from "./github-username";
import { requiresSavedNationalityAnswer } from "./person-nationality";
import type {
  ApplyAnswer,
  ApplyAnswerSources,
  ApplyFormControl,
} from "./types";

// An answer explicitly supplied for this application is separate from permission
// to infer pay from the Profile. The reader scopes reused answers to their question.
function usableSavedAnswer(
  answer: CandidateReusableAnswer,
  payDisclosed: boolean,
) {
  return (
    !answer.needsConfirmation &&
    (payDisclosed ||
      answer.kind !== "salary_expectation" ||
      !!answer.applicationScope?.applicationRecordId ||
      !!answer.applicationScope?.resultId)
  );
}

/** Empty strings and lists carry no evidence; preserve explicit unknown, No and zero. */
export function serializeApplicationData(
  value: Record<string, unknown> | readonly unknown[],
): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry === "" || (Array.isArray(entry) && entry.length === 0)
      ? undefined
      : entry,
  );
}

/**
 * The person's facts for one application, as the model reads them (ADR 0041).
 *
 * The model gets everything Job Finder knows about the person in one place and
 * answers the form from it; no rule picks an answer per field. Saved expected
 * pay describes their application preference, not their current pay or history.
 */
export function applicationFacts(
  sources: ApplyAnswerSources,
  options: { payDisclosed: boolean },
) {
  const profile = sources.profile;
  return {
    listingDiscovery: sources.listingDiscovery,
    name: {
      full: profile.fullName,
      first: profile.firstName,
      middle: profile.middleName,
      last: profile.lastName,
      preferred: profile.preferredDisplayName,
    },
    email: profile.applicationIdentity.preferredEmail ?? profile.email,
    secondaryEmail: profile.secondaryEmail,
    phone: profile.applicationIdentity.preferredPhone ?? profile.phone,
    location: {
      current: profile.currentLocation,
      city: profile.currentCity,
      region: profile.currentRegion,
      country: profile.currentCountry,
      timeZone: profile.timeZone,
    },
    links: {
      professionalProfile: profile.linkedinUrl,
      codeProfile: profile.githubUrl,
      portfolio: profile.portfolioUrl,
      website: profile.personalWebsiteUrl,
      other: profile.links,
    },
    headline: profile.headline,
    summary: profile.summary,
    professionalSummary: profile.professionalSummary,
    narrative: profile.narrative,
    targetRoles: profile.targetRoles,
    preferredLocations: profile.locations,
    preferences: sources.preferences,
    yearsExperience: profile.yearsExperience,
    workEligibility: profile.workEligibility,
    ...(profile.workEligibility.limitedWorkPermissions?.length
      ? {
          eligibilityInterpretation:
            "Limited permissions establish present authorization only within their country and stated conditions. requiresFutureSponsorship describes future work, not a blanket answer for this application. Compare the job type, hours and dates; leave unresolved authorization and sponsorship questions for the person. Reusable answers cannot override permit conditions.",
        }
      : {}),
    savedAnswers: sources.reusableAnswers
      .filter((saved) => usableSavedAnswer(saved, options.payDisclosed))
      .map((saved) => ({
        id: saved.id,
        kind: saved.kind,
        label: saved.label,
        question: saved.question,
        answer: saved.answer,
        applicationScope: saved.applicationScope,
      })),
    spokenLanguages: profile.spokenLanguages,
    skills: profile.skills,
    skillGroups: profile.skillGroups,
    proofBank: profile.proofBank,
    experiences: profile.experiences.filter((entry) => entry.isDraft !== true),
    education: profile.education.filter((entry) => entry.isDraft !== true),
    certifications: profile.certifications,
    projects: profile.projects,
  };
}

/** Plain labels for the independent answer check's person-facing notes. */
export function plainAnswerCheckFacts(
  facts: ReturnType<typeof applicationFacts>,
) {
  const eligibility = facts.workEligibility;
  const yesNo = (value: boolean | null) =>
    value === null ? "Not known" : value ? "Yes" : "No";
  return {
    ...facts,
    workEligibility: {
      "Countries where you can work": eligibility.authorizedWorkCountries,
      "Limited work permissions": (
        eligibility.limitedWorkPermissions ?? []
      ).map((permit) => ({
        Country: permit.country,
        Conditions: permit.conditions,
        "Will need sponsorship later": yesNo(permit.requiresFutureSponsorship),
      })),
      "Need visa sponsorship": yesNo(eligibility.requiresVisaSponsorship),
      "Willing to relocate": yesNo(eligibility.willingToRelocate),
      "Preferred places to relocate": eligibility.preferredRelocationRegions,
      "Willing to travel": yesNo(eligibility.willingToTravel),
      "Can work remotely": yesNo(eligibility.remoteEligible),
      "Notice period in days": eligibility.noticePeriodDays,
      "Available start date": eligibility.availableStartDate,
      "Security clearance": eligibility.securityClearance,
    },
    eligibilityInterpretation: facts.eligibilityInterpretation?.replace(
      "requiresFutureSponsorship",
      "Will need sponsorship later",
    ),
  };
}

interface StoredFact {
  value: string;
  sourceKind: ApplyAnswer["sourceKind"];
  sourceId: string;
  provenanceLabel: string;
}

const YES_NO = new Set(["yes", "no", "y", "n", "true", "false"]);

/**
 * Whether a value is distinctive enough that typing it can only mean that
 * fact: an email address, a phone number, a link, a name, a saved sentence.
 * "Yes", "No" and short numbers could answer anything, so implicit matching
 * checks them with their question. An explicit fact reference can establish
 * exact identity for these values without interpreting the question.
 */
function isDistinctive(value: string): boolean {
  const normalized = normalizeSignal(value);
  if (normalized.length < 3 || YES_NO.has(normalized)) return false;
  if (/^\d+$/u.test(normalized.replace(/\s+/gu, "")))
    return normalized.replace(/\s+/gu, "").length >= 7;
  return true;
}

export function storedFacts(
  sources: ApplyAnswerSources,
  options: { payDisclosed: boolean },
): StoredFact[] {
  const profile = sources.profile;
  const facts: StoredFact[] = [];
  const add = (
    value: string | null | undefined,
    sourceId: string,
    provenanceLabel: string,
    sourceKind: ApplyAnswer["sourceKind"] = "profile",
  ) => {
    const trimmed = value?.trim();
    if (trimmed) {
      facts.push({ value: trimmed, sourceKind, sourceId, provenanceLabel });
    }
  };
  const addRecord = (value: unknown, sourceId: string, label: string): void => {
    if (typeof value === "string" || typeof value === "number") {
      add(String(value), sourceId, label);
    } else if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        addRecord(entry, `${sourceId}.${index}`, label),
      );
    } else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        if (key !== "id") addRecord(entry, `${sourceId}.${key}`, label);
      }
    }
  };
  for (const entry of profile.experiences.filter((entry) => !entry.isDraft)) {
    addRecord(entry, `profile.experiences.${entry.id}`, "your work history");
  }
  for (const entry of profile.education.filter((entry) => !entry.isDraft)) {
    addRecord(entry, `profile.education.${entry.id}`, "your education");
  }
  addRecord(profile.skills, "profile.skills", "your skills");
  addRecord(profile.skillGroups, "profile.skillGroups", "your skills");
  addRecord(
    profile.spokenLanguages,
    "profile.spokenLanguages",
    "your languages",
  );
  addRecord(
    profile.certifications,
    "profile.certifications",
    "your qualifications",
  );
  addRecord(profile.projects, "profile.projects", "your projects");
  addRecord(
    profile.yearsExperience,
    "profile.yearsExperience",
    "your experience",
  );
  add(profile.timeZone, "profile.timeZone", "your time zone");
  add(profile.fullName, "profile.fullName", "your name");
  add(profile.firstName, "profile.firstName", "your first name");
  add(profile.middleName, "profile.middleName", "your middle name");
  add(profile.lastName, "profile.lastName", "your last name");
  add(
    profile.preferredDisplayName,
    "profile.preferredDisplayName",
    "the name you go by",
  );
  add(
    profile.applicationIdentity.preferredEmail ?? profile.email,
    "profile.email",
    "your email address",
  );
  add(profile.secondaryEmail, "profile.secondaryEmail", "your other email");
  add(
    profile.applicationIdentity.preferredPhone ?? profile.phone,
    "profile.phone",
    "your phone number",
  );
  add(profile.currentLocation, "profile.currentLocation", "where you live");
  add(profile.currentCity, "profile.currentCity", "your city");
  add(profile.currentRegion, "profile.currentRegion", "your region");
  add(
    profile.currentCountry,
    "profile.currentCountry",
    "the country you live in",
  );
  add(
    profile.linkedinUrl,
    "profile.linkedinUrl",
    "your professional profile link",
  );
  add(profile.githubUrl, "profile.githubUrl", "your code profile link");
  add(
    githubUsername(profile.githubUrl),
    "profile.githubUrl#username",
    "the username from your code profile",
  );
  add(profile.portfolioUrl, "profile.portfolioUrl", "your portfolio");
  add(profile.personalWebsiteUrl, "profile.personalWebsiteUrl", "your website");
  for (const link of profile.links) {
    add(link.url, `profile.links.${link.id}`, "a link on your profile");
    // A link may be someone else's repository; only an account link names the person.
    add(
      githubUsername(link.url, { profileOnly: true }),
      `profile.links.${link.id}#username`,
      "the username from your code profile",
    );
  }
  for (const saved of sources.reusableAnswers.filter(
    (entry) =>
      usableSavedAnswer(entry, options.payDisclosed) &&
      entry.kind !== "work_authorization" &&
      entry.kind !== "visa_sponsorship",
  )) {
    add(
      saved.answer,
      `answerLibrary.${saved.id}`,
      `your saved answer "${saved.label || saved.question}"`,
      "answer_library",
    );
  }
  return facts;
}

/**
 * The stored fact a proposed value is, word for word, when it is one. Such a
 * value goes in as that fact without a fact check; anything else is checked.
 */
export function storedFactFor(input: {
  sources: ApplyAnswerSources;
  payDisclosed: boolean;
  control: ApplyFormControl;
  value: string;
  storedFactId?: string | undefined;
}): ApplyAnswer | null {
  if (
    requiresSavedNationalityAnswer(
      `${input.control.groupLabel} ${input.control.label} ${input.control.placeholder}`,
    )
  )
    return null;
  const wantsUsername = asksGithubUsername(input.control);
  const wanted = formatGithubAnswer(input.control, input.value).trim();
  const factId =
    wantsUsername &&
    input.storedFactId &&
    (input.storedFactId === "profile.githubUrl" ||
      input.storedFactId.startsWith("profile.links.")) &&
    !input.storedFactId.endsWith("#username")
      ? `${input.storedFactId}#username`
      : input.storedFactId;
  if (!wanted || (!input.storedFactId && !isDistinctive(input.value)))
    return null;
  // Eligibility and current pay need their question and context checked.
  if (
    input.control.questionKind === "work_authorization" ||
    input.control.questionKind === "visa_sponsorship" ||
    input.control.asksCurrentPay === true ||
    input.control.asksHiringCountry === true
  ) {
    return null;
  }
  const fact = storedFacts(input.sources, {
    payDisclosed: input.payDisclosed,
  }).find(
    (candidate) =>
      (!factId || candidate.sourceId === factId) &&
      candidate.value === wanted &&
      // A bare username is no answer to a field that asks for the address.
      (wantsUsername || !candidate.sourceId.endsWith("#username")),
  );
  if (!fact) return null;
  // A short value such as Yes, No or a number answers whatever it is put
  // against: a saved answer skips the check only on its own question, saved
  // pay only on a pay question, and total years of experience never.
  if (
    !isDistinctive(input.value) &&
    !shortFactFitsControl(fact.sourceId, input.control, input.sources)
  ) {
    return null;
  }
  return {
    value: wanted,
    kind: input.control.questionKind,
    sourceKind: fact.sourceKind,
    sourceId: fact.sourceId,
    provenanceLabel: fact.provenanceLabel,
    groundedIn: [fact.provenanceLabel],
  };
}

/**
 * The answer the person saved for this exact question, when there is one.
 * A radio or checkbox group asks its question in the group label.
 */
export function savedAnswerForQuestion(
  control: ApplyFormControl,
  reusableAnswers: readonly CandidateReusableAnswer[],
  controls?: readonly ApplyFormControl[],
): CandidateReusableAnswer | null {
  const prompt = (candidate: ApplyFormControl) =>
    candidate.repeatedQuestion?.prompt ??
    ((candidate.kind === "radio" ||
      candidate.answerControlType === "multi_choice") &&
    candidate.choiceGroupKey &&
    candidate.groupLabel
      ? candidate.groupLabel
      : [candidate.groupLabel, candidate.label]
          .filter((part) => part.trim())
          .join(" — "));
  const target = normalizeFormQuestionPrompt(
    preserveTechnologyTokens(prompt(control)),
  );
  const matches = reusableAnswers.filter(
    (saved) =>
      !saved.needsConfirmation &&
      normalizeFormQuestionPrompt(preserveTechnologyTokens(saved.question)) ===
        target,
  );
  const local = matches.filter((saved) => saved.id.startsWith("application_"));
  const answers = local.length ? local : matches;
  if (new Set(answers.map((saved) => saved.answer.trim())).size !== 1)
    return null;
  if (controls) {
    const current = controls.filter(
      (candidate) =>
        candidate.visible &&
        !candidate.disabled &&
        normalizeFormQuestionPrompt(
          preserveTechnologyTokens(prompt(candidate)),
        ) === target,
    );
    const groups = new Set(
      current.map((candidate) =>
        (candidate.kind === "radio" ||
          candidate.answerControlType === "multi_choice") &&
        candidate.choiceGroupKey
          ? `radio:${candidate.choiceGroupKey}`
          : candidate.ref,
      ),
    );
    if (groups.size !== 1) return null;
  }
  return answers[0] ?? null;
}

/** An explicit answer on the retained application is the person's decision. */
export function isAnswerFromThisApplication(
  answer: CandidateReusableAnswer | null,
  application: { resultId?: string; applicationRecordId?: string },
  location: string | null,
): boolean {
  const scope = answer?.applicationScope;
  if (!scope) return false;
  if (scope.location && scope.location !== location) return false;
  return Boolean(
    (application.resultId && scope.resultId === application.resultId) ||
    (application.applicationRecordId &&
      scope.applicationRecordId === application.applicationRecordId),
  );
}

function shortFactFitsControl(
  sourceId: string,
  control: ApplyFormControl,
  sources: ApplyAnswerSources,
): boolean {
  // Total years of experience is not the years asked about a given skill.
  if (sourceId === "profile.yearsExperience") return false;
  // Saved short answers belong to their own question.
  if (sourceId.startsWith("answerLibrary.")) {
    const saved = savedAnswerForQuestion(control, sources.reusableAnswers);
    return saved !== null && sourceId === `answerLibrary.${saved.id}`;
  }
  return true;
}
