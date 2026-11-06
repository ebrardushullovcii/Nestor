import {
  normalizeFormQuestionPrompt,
  preserveTechnologyTokens,
  savedQuestionMatches,
  type CandidateReusableAnswer,
} from "@nestor/contracts";
import { questionLabel, questionPrompt } from "./question-text";

import { currentCountryTimezone } from "./current-timezone";
import { fieldNamesAnotherPerson, githubUsername } from "./github-username";
import { requiresSavedNationalityAnswer } from "./person-nationality";
import { phoneCallingCode, phoneCountryPicker } from "./phone-answer";
import type {
  ApplyAnswer,
  ApplyAnswerSources,
  ApplyFormControl,
} from "./types";

export const RESIDENCE_COUNTRY_LABELS: readonly string[] = [
  "country",
  "country of residence",
  "residence country",
  "current country",
  "what country are you based in",
  "what is your current country of residence",
];
export const PROFILE_TEXT_FIELD_LABELS: Record<string, readonly string[]> = {
  "profile.summary": ["summary", "professional summary"],
  "profile.headline": ["headline", "professional headline"],
};
export function applicantContactGroup(control: ApplyFormControl): boolean {
  // Section names describe layout, not the person a leaf question refers to.
  // Reference/supervisor exclusions inspect the whole ancestry and still win.
  return (
    !fieldNamesAnotherPerson(control) &&
    !/\b(?:former|previous|maiden|birth)\b/iu.test(
      `${control.sectionPath?.join(" ") ?? ""} ${control.groupLabel} ${control.hint ?? ""} ${control.placeholder}`,
    )
  );
}
/** A typed applicant-country reading or an explicit residence label. */
export function isExplicitResidenceCountryControl(
  control: ApplyFormControl,
): boolean {
  const label = normalizeFormQuestionPrompt(control.label);
  return (
    ((label !== "country" &&
      RESIDENCE_COUNTRY_LABELS.includes(label) &&
      applicantContactGroup(control)) ||
      (control.answerTags?.kind === "residence_country" &&
        control.answerTags.sourceId === "profile.currentCountry")) &&
    !fieldNamesAnotherPerson(control) &&
    !requiresSavedNationalityAnswer(control.label) &&
    control.asksHiringCountry !== true
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
 * Every saved answer the person confirmed, with this application's own
 * answers and exact visible questions first. Nothing is dropped for length:
 * a missing saved answer is a question asked again.
 */
export function relevantSavedAnswers(
  answers: readonly CandidateReusableAnswer[],
  questions: readonly string[] = [],
): CandidateReusableAnswer[] {
  const normalized = questions.map(normalizeFormQuestionPrompt);
  const words = new Set(
    normalized.flatMap((question) =>
      question.split(" ").filter((word) => word.length > 3),
    ),
  );
  const score = (answer: CandidateReusableAnswer) => {
    const question = normalizeFormQuestionPrompt(answer.question);
    return (
      (answer.id.startsWith("application_") ? 10000 : 0) +
      (normalized.includes(question) ? 1000 : 0) +
      question.split(" ").filter((word) => words.has(word)).length
    );
  };
  return [...answers].sort((left, right) => score(right) - score(left));
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
  const { baseResume, ...profileFacts } = profile;
  return {
    ...profileFacts,
    baseResumeText: baseResume.textContent,
    payDisclosure: options.payDisclosed,
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
    taskGuidance: sources.taskInstructions,
    preferences: sources.preferences,
    yearsExperience: profile.yearsExperience,
    workEligibility: profile.workEligibility,
    ...(profile.workEligibility.limitedWorkPermissions?.length
      ? {
          eligibilityInterpretation:
            "Limited permissions establish present authorization only within their country and stated conditions. requiresFutureSponsorship describes future work, not a blanket answer for this application. Compare the job type, hours and dates; leave unresolved authorization and sponsorship questions for the person. Reusable answers cannot override permit conditions.",
        }
      : {}),
    savedAnswers: relevantSavedAnswers(sources.reusableAnswers).map(
      (saved) => ({
        id: saved.id,
        kind: saved.kind,
        label: saved.label,
        question: saved.question,
        answer: saved.answer,
        needsConfirmation: saved.needsConfirmation,
        // Native execution binding is host metadata, not a new applicant fact.
        // Fill and Send see the same scope even when only Fill has that marker.
        applicationScope: saved.applicationScope
          ? {
              resultId: saved.applicationScope.resultId,
              applicationRecordId: saved.applicationScope.applicationRecordId,
              location: saved.applicationScope.location,
              ...(saved.applicationScope.hiringCountry
                ? { hiringCountry: saved.applicationScope.hiringCountry }
                : {}),
            }
          : undefined,
        optionFallback: saved.optionFallback,
      }),
    ),
    spokenLanguages: profile.spokenLanguages,
    skills: profile.skills,
    skillGroups: profile.skillGroups,
    proofBank: profile.proofBank,
    experiences: profile.experiences,
    education: profile.education,
    certifications: profile.certifications,
    projects: profile.projects,
  };
}

interface StoredFact {
  value: string;
  sourceKind: ApplyAnswer["sourceKind"];
  sourceId: string;
  provenanceLabel: string;
}

export function storedFacts(
  sources: ApplyAnswerSources,
  options: { payDisclosed: boolean },
): StoredFact[] {
  void options;
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
  const currentTimezone = currentCountryTimezone(profile);
  if (currentTimezone)
    add(
      currentTimezone.zone,
      currentTimezone.sourceId,
      "the timezone of your current country",
    );
  add(profile.fullName, "profile.fullName", "your name");
  add(profile.headline, "profile.headline", "your headline");
  add(profile.summary, "profile.summary", "your summary");
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
  add(
    phoneCallingCode(
      profile.applicationIdentity.preferredPhone ?? profile.phone ?? "",
    ),
    "profile.phone#callingCode",
    "the calling code in your saved international phone number",
  );
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
      link.kind === "github"
        ? githubUsername(link.url, { profileOnly: true })
        : null,
      `profile.links.${link.id}#username`,
      "the username from your code profile",
    );
  }
  for (const saved of sources.reusableAnswers.filter(
    (entry) =>
      !entry.needsConfirmation &&
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
 * The answer the person saved for this exact question, when there is one.
 * A radio or checkbox group asks its question in the group label.
 */
export function savedAnswerForQuestion(
  control: ApplyFormControl,
  reusableAnswers: readonly CandidateReusableAnswer[],
  controls?: readonly ApplyFormControl[],
): CandidateReusableAnswer | null {
  if (control.credentialRole) return null;
  const prompt = questionPrompt;
  const key = (value: string) =>
    normalizeFormQuestionPrompt(preserveTechnologyTokens(value));
  const rawPrompt = prompt(control);
  const context = `${control.placeholder} ${control.hint ?? ""}`;
  const target = key(rawPrompt);
  const usable = reusableAnswers.filter((saved) => !saved.needsConfirmation);
  const unique = (matches: CandidateReusableAnswer[]) => {
    const local = matches.filter((saved) =>
      saved.id.startsWith("application_"),
    );
    const answers = local.length ? local : matches;
    return new Set(answers.map((saved) => saved.answer.trim())).size === 1
      ? (answers[0] ?? null)
      : null;
  };
  const group = (candidate: ApplyFormControl) =>
    (candidate.kind === "radio" ||
      candidate.answerControlType === "multi_choice") &&
    candidate.choiceGroupKey
      ? `choice:${candidate.choiceGroupKey}`
      : candidate.ref;
  const phonePicker = phoneCountryPicker(control, controls ?? []);
  const visible = (controls ?? []).filter(
    (candidate) =>
      candidate.visible && !candidate.disabled && candidate !== phonePicker,
  );
  if (
    controls &&
    new Set(
      visible
        .filter((candidate) => key(prompt(candidate)) === target)
        .map(group),
    ).size !== 1
  )
    return null;
  const exact = usable.filter(
    (saved) =>
      key(saved.question) === target &&
      savedQuestionMatches(saved.question, rawPrompt, saved.answer, context),
  );
  if (exact.length || control.repeatedQuestion) return unique(exact);
  // Extra instructions and outer subjects are part of the saved question.
  // A shorter legacy label can still be proposed through the independent
  // whole-question checker; it cannot grant literal reuse here.
  if (key(rawPrompt) !== key(questionLabel(control))) return null;
  const semantic = usable.filter((saved) => {
    if (!savedQuestionMatches(saved.question, rawPrompt, saved.answer, context))
      return false;
    if (!controls) return !control.groupLabel.trim();
    const direct = visible.filter(
      (candidate) => key(prompt(candidate)) === key(saved.question),
    );
    const targets = direct.length
      ? direct
      : visible.filter(
          (candidate) =>
            !candidate.repeatedQuestion &&
            savedQuestionMatches(
              saved.question,
              prompt(candidate),
              saved.answer,
              `${candidate.placeholder} ${candidate.hint ?? ""}`,
            ),
        );
    const groups = new Set(targets.map(group));
    return groups.size === 1 && groups.has(group(control));
  });
  if (semantic.length) return unique(semantic);
  // Layout ancestors do not change an unambiguous leaf question. Reference
  // sections and repeated questions never acquire this fallback.
  if (
    !control.repeatedQuestion &&
    !fieldNamesAnotherPerson(control) &&
    controls
  )
    return unique(
      usable.filter((saved) => {
        if (
          !savedQuestionMatches(
            saved.question,
            control.label,
            saved.answer,
            context,
          )
        )
          return false;
        const targets = visible.filter((candidate) =>
          savedQuestionMatches(
            saved.question,
            candidate.label,
            saved.answer,
            `${candidate.placeholder} ${candidate.hint ?? ""}`,
          ),
        );
        const groups = new Set(targets.map(group));
        return groups.size === 1 && groups.has(group(control));
      }),
    );
  return null;
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
